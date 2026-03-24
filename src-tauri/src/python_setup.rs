use crate::downloader::download_file;
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;
use tauri::Manager;
use tauri::Emitter;
use tauri::Runtime;

const PYTHON_ZIP_NAME: &str = "python-3.11.9-embed-amd64.zip";
const PYTHON_DIR_NAME: &str = "python-embed";
// Initial dummy requirements
const REQUIREMENTS_FILE_NAME: &str = "requirements.txt";

#[cfg(target_os = "windows")]
pub async fn setup_python_environment<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let resources_dir = app.path().resource_dir().map_err(|e| e.to_string())?;

    let python_dir = app_dir.join(PYTHON_DIR_NAME);
    let python_exe = python_dir.join("python.exe");

    // 1. Check if Python is already setup
    if python_exe.exists() {
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

    // 4. Install pip
    // 4. Install pip
    let get_pip_path = python_dir.join("get-pip.py");
    emit_log(app, "Locating pip bootstrap...");

    // Find bundled get-pip.py
    let mut pip_paths = vec![
        resources_dir.join("get-pip.py"),
    ];
    
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            pip_paths.push(exe_dir.join("get-pip.py"));
            pip_paths.push(exe_dir.join("resources").join("get-pip.py"));
        }
    }

    let bundled_pip = pip_paths.into_iter().find(|p| p.exists())
        .ok_or_else(|| format!("Bundled get-pip.py not found."))?;

    fs::copy(&bundled_pip, &get_pip_path)
        .map_err(|e| format!("Failed to copy get-pip.py: {}", e))?;

    emit_log(app, "Installing pip...");
    emit_log(app, "Installing pip...");
    let output = Command::new(&python_exe)
        .arg(&get_pip_path)
        .output()
        .map_err(|e| format!("Failed to execute get-pip.py: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        println!("[PIP ERROR] Stdout: {}", stdout);
        println!("[PIP ERROR] Stderr: {}", stderr);
        return Err(format!("Failed to install pip. Output: {}", stderr));
    }
    
    emit_log(app, "Pip installed successfully.");

    // 5. Install requirements
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
        
        // We need to handle torch specifically if we want CUDA.
        // The requirements.txt I wrote has --extra-index-url so it should be fine.
        
        let status = Command::new(&python_exe)
            .args(&["-m", "pip", "install", "-r", &req_path.to_string_lossy()])
            // Hide window?
            .status()
            .map_err(|e| format!("Failed to install requirements: {}", e))?;
            
        if !status.success() {
            return Err("Failed to pip install requirements".to_string());
        }
    } else {
        emit_log(app, "Warning: requirements.txt not found. Skipping dependency installation.");
    }

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
