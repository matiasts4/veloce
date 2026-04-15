use crate::downloader::download_file;
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;
use tauri::Emitter;
use tauri::Runtime;

const PYTHON_ZIP_NAME: &str = "python-3.11.9-embed-amd64.zip";
const PYTHON_DIR_NAME: &str = "python-embed";
// Initial dummy requirements
const REQUIREMENTS_FILE_NAME: &str = "requirements.txt";

#[cfg(target_os = "windows")]
fn locate_resource_candidate<R: Runtime>(app: &AppHandle<R>, relative_name: &str) -> Option<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(resources_dir) = app.path().resource_dir() {
        paths.push(resources_dir.join(relative_name));
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            paths.push(exe_dir.join(relative_name));
            paths.push(exe_dir.join("resources").join(relative_name));
        }
    }
    paths.into_iter().find(|p| p.exists())
}

#[cfg(target_os = "windows")]
fn ensure_pip_available<R: Runtime>(app: &AppHandle<R>, python_exe: &Path, python_dir: &Path) -> Result<(), String> {
    let pip_status = Command::new(python_exe)
        .args(["-m", "pip", "--version"])
        .status()
        .map_err(|e| format!("Failed to check pip: {}", e))?;

    if pip_status.success() {
        return Ok(());
    }

    emit_log(app, "pip not found. Installing pip...");
    let bundled_pip = locate_resource_candidate(app, "get-pip.py")
        .ok_or_else(|| "Bundled get-pip.py not found.".to_string())?;

    let get_pip_path = python_dir.join("get-pip.py");
    fs::copy(&bundled_pip, &get_pip_path)
        .map_err(|e| format!("Failed to copy get-pip.py: {}", e))?;

    let output = Command::new(python_exe)
        .arg(&get_pip_path)
        .output()
        .map_err(|e| format!("Failed to execute get-pip.py: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to install pip. Output: {}", stderr));
    }

    emit_log(app, "Pip installed successfully.");
    Ok(())
}

#[cfg(target_os = "windows")]
fn ensure_python_dependencies<R: Runtime>(app: &AppHandle<R>, python_exe: &Path, python_dir: &Path) -> Result<(), String> {
    let missing_check = Command::new(python_exe)
        .args([
            "-c",
            "import importlib.util as u; mods=['numpy','sounddevice','faster_whisper','huggingface_hub','tqdm','yaml','torch','torchaudio']; print(','.join([m for m in mods if u.find_spec(m) is None]))",
        ])
        .output()
        .map_err(|e| format!("Failed to validate python dependencies: {}", e))?;

    let missing_modules = String::from_utf8_lossy(&missing_check.stdout)
        .trim()
        .split(',')
        .filter(|m| !m.trim().is_empty())
        .map(|m| m.trim().to_string())
        .collect::<Vec<String>>();

    if missing_modules.is_empty() {
        return Ok(());
    }

    emit_log(app, "Python dependencies missing or incomplete. Repairing environment...");
    ensure_pip_available(app, python_exe, python_dir)?;

    let mut packages: Vec<&str> = Vec::new();
    for module in &missing_modules {
        match module.as_str() {
            "numpy" => packages.push("numpy==2.2.3"),
            "sounddevice" => packages.push("sounddevice==0.5.1"),
            "faster_whisper" => packages.push("faster-whisper==1.1.1"),
            "huggingface_hub" => packages.push("huggingface-hub==0.28.1"),
            "tqdm" => packages.push("tqdm==4.67.1"),
            "yaml" => packages.push("pyyaml"),
            // Use CPU defaults for repair path; GPU-specific wheels can still be installed manually.
            "torch" => packages.push("torch==2.6.0"),
            "torchaudio" => packages.push("torchaudio==2.6.0"),
            _ => {}
        }
    }

    if packages.is_empty() {
        return Ok(());
    }

    emit_log(app, &format!("Installing missing python packages: {:?}", missing_modules));
    for attempt in 1..=3 {
        let mut install_args: Vec<&str> = vec!["-m", "pip", "install"];
        install_args.extend(packages.iter().copied());

        let output = Command::new(python_exe)
            .args(install_args)
            .output()
            .map_err(|e| format!("Failed to install requirements: {}", e))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let is_lock_error = stderr.contains("WinError 32") || stderr.contains("being used by another process");
        if is_lock_error && attempt < 3 {
            emit_log(app, &format!("Dependency install hit file lock (attempt {}/3). Retrying...", attempt));
            thread::sleep(Duration::from_secs(2));
            continue;
        }

        return Err(format!("Failed to install missing python packages: {}", stderr));
    }

    Err("Failed to install missing python packages after retries".to_string())
}

#[cfg(target_os = "windows")]
pub async fn setup_python_environment<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let resources_dir = app.path().resource_dir().map_err(|e| e.to_string())?;

    let python_dir = app_dir.join(PYTHON_DIR_NAME);
    let python_exe = python_dir.join("python.exe");

    // 1. Check if Python is already setup
    if python_exe.exists() {
            ensure_python_dependencies(app, &python_exe, &python_dir)?;
         // Setup WhisperCPP even if Python is ready (to handle upgrades or missing resources)
         if let Err(e) = setup_whisper_cpp(app).await {
              emit_log(app, &format!("Warning: Failed to setup WhisperCPP: {}", e));
         }
        // Then return existing Python
        return Ok(python_exe);
    }

    emit_log(app, "Configuring Python environment...");

    // 2. Extract Python Embed
    let resources_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    
    // Attempt to locate the zip in multiple potential locations
    let mut potential_paths = vec![
        resources_dir.join(PYTHON_ZIP_NAME),
    ];
    
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            potential_paths.push(exe_dir.join(PYTHON_ZIP_NAME));
            potential_paths.push(exe_dir.join("resources").join(PYTHON_ZIP_NAME));
        }
    }

    let zip_path = potential_paths.into_iter().find(|p| p.exists())
        .ok_or_else(|| format!("Python zip not found. Searched in: {:?}", resources_dir))?;

    emit_log(app, &format!("Extracting Python from: {:?}", zip_path));
    if !python_dir.exists() {
        fs::create_dir_all(&python_dir).map_err(|e| e.to_string())?;
    }
    
    // Unzip using zip crate or powershell? zip crate is better if available, 
    // but user might not have it in Cargo.toml. 
    // Let's use powershell for zero-dependency extraction to be safe and simple.
    let status = Command::new("powershell")
        .args(&[
            "-Command",
            &format!(
                "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                zip_path.display(),
                python_dir.display()
            ),
        ])
        .status()
        .map_err(|e| format!("Failed to run unzip: {}", e))?;

    if !status.success() {
        return Err("Failed to extract Python zip".to_string());
    }

    // 3. Enable site-packages (Modify ._pth file)
    // python311._pth needs "import site" to be uncommented or added
    let pth_file = python_dir.join("python311._pth");
    if pth_file.exists() {
        let content = fs::read_to_string(&pth_file).map_err(|e| e.to_string())?;
        // Replace "#import site" with "import site"
        let new_content = content.replace("#import site", "import site");
        fs::write(&pth_file, new_content).map_err(|e| e.to_string())?;
    } else {
        emit_log(app, "Warning: python311._pth not found, pip might fail.");
    }

    // 4. Ensure pip and requirements
    ensure_python_dependencies(app, &python_exe, &python_dir)?;

    emit_log(app, "Python environment ready.");
    
    // 6. Setup WhisperCPP (Copy from resources to AppData)
    if let Err(e) = setup_whisper_cpp(app).await {
         emit_log(app, &format!("Warning: Failed to setup WhisperCPP: {}", e));
    }
    
    Ok(python_exe)
}

#[cfg(target_os = "windows")]
async fn setup_whisper_cpp<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    emit_log(app, "Setting up WhisperCPP...");
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let resources_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    
    // 1. Locate whispercpp folder
    let mut whisper_paths = vec![
        resources_dir.join("whispercpp"),
    ];
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            whisper_paths.push(exe_dir.join("whispercpp"));
            whisper_paths.push(exe_dir.join("resources").join("whispercpp"));
        }
    }
    
    let whisper_src = whisper_paths.into_iter().find(|p| p.exists());
    
    // 2. Locate models folder
    let mut models_paths = vec![
        resources_dir.join("models"),
    ];
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            models_paths.push(exe_dir.join("models"));
            models_paths.push(exe_dir.join("resources").join("models"));
        }
    }
    let models_src = models_paths.into_iter().find(|p| p.exists());

    // Helper to copy directory using PowerShell (recursive)
    let copy_dir = |src: &Path, dst: &Path| -> Result<(), String> {
         let status = Command::new("powershell")
            .args(&[
                "-Command",
                &format!("Copy-Item -Path '{}' -Destination '{}' -Recurse -Force", src.display(), dst.display())
            ])
            .status()
            .map_err(|e| format!("Failed to run copy: {}", e))?;
            
         if !status.success() {
             return Err(format!("Failed to copy {:?} to {:?}", src, dst));
         }
         Ok(())
    };

    if let Some(src) = whisper_src {
        let dst = app_dir.join("whispercpp");
        if !dst.exists() || dst.read_dir().map(|mut i| i.next().is_none()).unwrap_or(true) {
            emit_log(app, &format!("Copying WhisperCPP from {:?}...", src));
            copy_dir(&src, &app_dir)?; 
        } else {
            emit_log(app, "WhisperCPP already exists, skipping copy.");
        }
    } else {
        emit_log(app, "Warning: WhisperCPP resources not found.");
    }
    
    if let Some(src) = models_src {
         let dst = app_dir.join("models");
         if !dst.exists() || dst.read_dir().map(|mut i| i.next().is_none()).unwrap_or(true) {
             emit_log(app, &format!("Copying Models from {:?}...", src));
             copy_dir(&src, &app_dir)?;
         } else {
             emit_log(app, "Models already exist, skipping copy.");
         }
    } else {
         emit_log(app, "Warning: Model resources not found.");
    }

    Ok(())
}

fn emit_log<R: Runtime>(app: &AppHandle<R>, msg: &str) {
    let _ = app.emit("log-message", msg);
    println!("[SETUP] {}", msg);
}

#[cfg(target_os = "linux")]
pub async fn setup_python_environment<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let resources_dir = app.path().resource_dir().map_err(|e| e.to_string())?;

    let python_dir = app_dir.join(PYTHON_DIR_NAME);
    let python_exe = python_dir.join("bin").join("python");

    if python_exe.exists() {
         if let Err(e) = setup_whisper_cpp(app).await {
              emit_log(app, &format!("Warning: Failed to setup WhisperCPP: {}", e));
         }
        return Ok(python_exe);
    }

    emit_log(app, "Configuring Python virtual environment on Linux...");

    if !python_dir.exists() {
        fs::create_dir_all(&python_dir).map_err(|e| e.to_string())?;
    }

    let status = Command::new("python3")
        .args(&["-m", "venv", &python_dir.to_string_lossy().into_owned()])
        .status()
        .map_err(|e| format!("Failed to run python3 -m venv: {}", e))?;

    if !status.success() {
        return Err("Failed to create python3 virtual environment. Please ensure python3-venv is installed.".to_string());
    }
    
    emit_log(app, "Python venv created.");

    let mut req_paths = vec![
        resources_dir.join(REQUIREMENTS_FILE_NAME),
    ];
    
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            req_paths.push(exe_dir.join(REQUIREMENTS_FILE_NAME));
            req_paths.push(exe_dir.join("resources").join(REQUIREMENTS_FILE_NAME));
        }
    }

    if let Some(req_path) = req_paths.into_iter().find(|p| p.exists()) {
        emit_log(app, &format!("Installing dependencies from: {:?}", req_path));
        
        let _ = Command::new(&python_exe)
            .args(&["-m", "pip", "install", "--upgrade", "pip"])
            .status();

        let status = Command::new(&python_exe)
            .args(&["-m", "pip", "install", "-r", &req_path.to_string_lossy().into_owned()])
            .status()
            .map_err(|e| format!("Failed to install requirements: {}", e))?;
            
        if !status.success() {
            return Err("Failed to pip install requirements".to_string());
        }
    } else {
        emit_log(app, "Warning: requirements.txt not found. Skipping dependency installation.");
    }

    emit_log(app, "Python environment ready.");
    
    if let Err(e) = setup_whisper_cpp(app).await {
         emit_log(app, &format!("Warning: Failed to setup WhisperCPP: {}", e));
    }
    
    Ok(python_exe)
}

#[cfg(target_os = "linux")]
async fn setup_whisper_cpp<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    emit_log(app, "Setting up WhisperCPP...");
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let resources_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    
    let mut whisper_paths = vec![resources_dir.join("whispercpp")];
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            whisper_paths.push(exe_dir.join("whispercpp"));
            whisper_paths.push(exe_dir.join("resources").join("whispercpp"));
        }
    }
    let whisper_src = whisper_paths.into_iter().find(|p| p.exists());
    
    let mut models_paths = vec![resources_dir.join("models")];
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            models_paths.push(exe_dir.join("models"));
            models_paths.push(exe_dir.join("resources").join("models"));
        }
    }
    let models_src = models_paths.into_iter().find(|p| p.exists());

    let copy_dir = |src: &Path, dst: &Path| -> Result<(), String> {
         let status = Command::new("cp")
            .args(&["-r", &src.to_string_lossy().into_owned(), &dst.to_string_lossy().into_owned()])
            .status()
            .map_err(|e| format!("Failed to run copy: {}", e))?;
            
         if !status.success() {
             return Err(format!("Failed to copy {:?} to {:?}", src, dst));
         }
         Ok(())
    };

    if let Some(src) = whisper_src {
        let dst = app_dir.join("whispercpp");
        if !dst.exists() || dst.read_dir().map(|mut i| i.next().is_none()).unwrap_or(true) {
            emit_log(app, &format!("Copying WhisperCPP from {:?}...", src));
            copy_dir(&src, &app_dir)?; 
        } else {
            emit_log(app, "WhisperCPP already exists, skipping copy.");
        }
    }
    
    if let Some(src) = models_src {
         let dst = app_dir.join("models");
         if !dst.exists() || dst.read_dir().map(|mut i| i.next().is_none()).unwrap_or(true) {
             emit_log(app, &format!("Copying Models from {:?}...", src));
             copy_dir(&src, &app_dir)?;
         } else {
             emit_log(app, "Models already exist, skipping copy.");
         }
    }

    Ok(())
}
