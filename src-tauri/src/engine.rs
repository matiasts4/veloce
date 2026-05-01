use tauri::{AppHandle, Manager, Emitter, Runtime};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandEvent, CommandChild};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use std::fs;
use enigo::{Enigo, Key, Keyboard, Settings, Direction};

use crate::state::AppState;

pub const EMBEDDED_AUDIO_ENGINE: &str = include_str!("../../python/audio_engine.py");

#[derive(serde::Deserialize, Clone)]
struct SidecarMessage {
    status: Option<String>,
    transcription: Option<String>,
    #[serde(default)]
    response_ms: Option<f64>,
    #[serde(default)]
    recording_id: Option<u64>,
    #[serde(default)]
    is_final: Option<bool>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    log: Option<String>,
    // New fields for hardware info
    #[serde(rename = "type")]
    msg_type: Option<String>,
    #[serde(default)]
    microphones: Option<serde_json::Value>,
    #[serde(default)]
    models: Option<serde_json::Value>,
    #[serde(default)]
    gpu: Option<serde_json::Value>,
    #[serde(default)]
    backends: Option<serde_json::Value>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    progress: Option<u8>,
    #[serde(default)]
    vu_meter: Option<serde_json::Value>,
}

pub fn ensure_embedded_audio_engine_script<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let app_data_dir = app.path().app_data_dir().ok()?;
    let engine_dir = app_data_dir.join("engine");
    if fs::create_dir_all(&engine_dir).is_err() {
        return None;
    }

    let script_path = engine_dir.join("audio_engine_embedded.py");
    let should_write = match fs::read_to_string(&script_path) {
        Ok(existing) => existing != EMBEDDED_AUDIO_ENGINE,
        Err(_) => true,
    };

    if should_write && fs::write(&script_path, EMBEDDED_AUDIO_ENGINE).is_err() {
        return None;
    }

    Some(script_path)
}

fn get_app_data_engine_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|p| p.join("engine"))
}

fn ensure_engine_unzipped<R: Runtime>(app: &AppHandle<R>) {
    let Some(engine_dir) = get_app_data_engine_dir(app) else {
        println!("[RUST] Could not resolve engine dir");
        return;
    };
    
    let marker_file = engine_dir.join(".installed_v3");
    if marker_file.exists() {
        println!("[RUST] Engine already installed at {:?}", engine_dir);
        return;
    }

    println!("[RUST] Engine not found or outdated. Checking for bundle...");

    // Find the zip bundle in resources
    let mut zip_path: Option<PathBuf> = None;
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidates = [
            resource_dir.join("audio-engine.zip"),
            resource_dir.join("resources/audio-engine.zip"),
        ];
        for c in candidates {
             if c.exists() {
                 zip_path = Some(c);
                 break;
             }
        }
    }

    if let Some(zip) = zip_path {
        println!("[RUST] Found zip bundle at {:?}. Extracting to {:?}", zip, engine_dir);
        let _ = app.emit("status-update", "Extracting audio engine...");
        
        // Ensure dir exists
        let _ = fs::create_dir_all(&engine_dir);

        // Use powershell to unzip (simple, built-in) on Windows
        // Use unzip on Linux
        #[cfg(target_os = "windows")]
        {
            let script = format!(
                "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                zip.to_string_lossy(),
                engine_dir.to_string_lossy()
            );

            match std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command", &script])
                .output() {
                    Ok(out) => {
                         if out.status.success() {
                             println!("[RUST] Extraction complete.");
                             let _ = fs::write(&marker_file, "v3");
                         } else {
                             println!("[RUST] Extraction failed: {:?}", String::from_utf8_lossy(&out.stderr));
                         }
                    }
                    Err(e) => println!("[RUST] Failed to run powershell: {}", e),
                }
        }
        
        #[cfg(target_os = "linux")]
        {
            match std::process::Command::new("unzip")
                .args(["-o", &zip.to_string_lossy().to_string(), "-d", &engine_dir.to_string_lossy().to_string()])
                .output() {
                    Ok(out) => {
                         if out.status.success() {
                             println!("[RUST] Extraction complete.");
                             let _ = fs::write(&marker_file, "v3");
                         } else {
                             println!("[RUST] Extraction failed: {:?}", String::from_utf8_lossy(&out.stderr));
                         }
                    }
                    Err(e) => println!("[RUST] Failed to run unzip: {}", e),
                }
        }
    } else {
        println!("[RUST] Audio engine zip not found in resources.");
    }
}

use crate::downloader; // Ensure main.rs has mod downloader;

// ... existing code ...

use crate::python_setup;

pub async fn install_engine<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    // 0. Ensure embedded script exists (as fallback or reference)
    ensure_embedded_audio_engine_script(app);

    // 1. Setup Python Environment (Download/Extract/Pip Install)
    let _ = app.emit("status-update", "Setting up Python environment...");
    match python_setup::setup_python_environment(app).await {
        Ok(_) => {
            let _ = app.emit("status-update", "Python Setup Complete.");
            Ok(())
        },
        Err(e) => Err(format!("Python Setup Failed: {}", e))
    }
}


pub async fn spawn_audio_engine<R: Runtime>(
    app_handle: &AppHandle<R>,
    child_arc: Arc<Mutex<Option<CommandChild>>>,
) -> Result<(), String> {
    // Always validate/repair the embedded Python environment before spawning.
    // This prevents stale partial installs from crashing with missing modules.
    python_setup::setup_python_environment(app_handle)
        .await
        .map_err(|e| format!("Failed to setup Python environment: {}", e))?;
    
    // 0. ALL WE NEED TO DO: Ensure the latest script from the binary is extracted to disk 
    // every time the engine is spawned. If not, Dev builds will run stale code from AppData.
    ensure_embedded_audio_engine_script(app_handle);

    // 1. Resolve Python Interpreter (Portable)
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    // This path must match usage in python_setup.rs
    #[cfg(target_os = "windows")]
    let python_exe = app_data_dir.join("python-embed").join("python.exe");
    #[cfg(target_os = "linux")]
    let python_exe = app_data_dir.join("python-embed").join("bin").join("python");

    // 2. Resolve Script
    // We ensured proper script existence above
    let engine_dir = app_data_dir.join("engine");
    let script_path = engine_dir.join("audio_engine_embedded.py");
    
    if !script_path.exists() {
         return Err(format!("Audio engine script not found at {:?}", script_path));
    }

    // 3. Determine Command
    // If portable python exists, use it.
    // If not (e.g. dev mode without setup run), fall back to system python or venv?
    // For now, let's enforce portable or fail, OR allow system python in debug.
    
    let python_command = if python_exe.exists() {
        println!("[RUST]: Using Portable Python: {:?}", python_exe);
        python_exe.to_string_lossy().to_string()
    } else {
        println!("[RUST]: Python environment not found. Triggering auto-setup...");
        match install_engine(app_handle).await {
            Ok(_) => {
                println!("[RUST]: Setup successful. Proceeding with spawn.");
                python_exe.to_string_lossy().to_string()
            },
            Err(e) => return Err(format!("Failed to setup Python environment: {}", e))
        }
    };

    let mut command_builder = app_handle
        .shell()
        .command(python_command)
        .args([script_path.to_string_lossy().to_string()]);

    #[cfg(debug_assertions)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        #[cfg(target_os = "windows")]
        let whisper_path = manifest_dir.join("resources").join("whispercpp").join("whisper-cli.exe");
        #[cfg(target_os = "linux")]
        let whisper_path = manifest_dir.join("resources").join("whispercpp").join("whisper-cli");
        
        println!("[RUST] Dev Mode: Force setting WHISPERCPP_EXE to {:?}", whisper_path);
        command_builder = command_builder.env("WHISPERCPP_EXE", whisper_path.to_string_lossy().to_string());
        
        let model_dir = manifest_dir.join("resources").join("models");
        println!("[RUST] Dev Mode: Force setting WHISPERCPP_MODEL_DIR to {:?}", model_dir);
        command_builder = command_builder.env("WHISPERCPP_MODEL_DIR", model_dir.to_string_lossy().to_string());
    }

    println!("[RUST]: Spawning sidecar process...");
    let (mut rx, child) = command_builder
        .spawn()
        .map_err(|error| {
            let err_msg = format!("No se pudo iniciar el motor de audio. Detalle: {error}");
            println!("[RUST] Spawn Error: {}", err_msg);
            err_msg
        })?;

    println!("[RUST]: Sidecar process spawned successfully.");

    if let Ok(mut lock) = child_arc.lock() {
        *lock = Some(child);
    }

    let app_handle_clone = app_handle.clone();
    let child_arc_for_events = child_arc.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes);
                    println!("[PYTHON]: {}", line);
                    
                    if let Ok(msg) = serde_json::from_str::<SidecarMessage>(&line) {
                        if let Some(text) = msg.transcription {
                            let response_ms = msg.response_ms;
                            let recording_id = msg.recording_id;
                            let is_final = msg.is_final.unwrap_or(false);
                            let _ = app_handle_clone.emit("transcription-update", serde_json::json!({
                                "text": text.clone(),
                                "response_ms": response_ms,
                                "recording_id": recording_id,
                                "is_final": is_final,
                            }));

                        }

                        if let Some(error) = msg.error {
                            let _ = app_handle_clone.emit("engine-error", error);
                        }
                        if let Some(log) = msg.log {
                            let _ = app_handle_clone.emit("engine-log", log);
                        }
                        if let Some(status) = msg.status {
                            let _ = app_handle_clone.emit("status-update", status);
                        }
                        if let Some(vu) = msg.vu_meter {
                            let _ = app_handle_clone.emit("vu-update", vu);
                        }
                        // Pass through hardware/model info
                        if let Some(msg_type) = msg.msg_type {
                            if msg_type == "hardware-info" {
                                let _ = app_handle_clone.emit("hardware-info", serde_json::json!({
                                    "microphones": msg.microphones,
                                    "models": msg.models,
                                    "gpu": msg.gpu,
                                    "backends": msg.backends
                                }));
                            } else if msg_type == "model-download-progress" {
                                let _ = app_handle_clone.emit("model-download-progress", serde_json::json!({
                                    "model": msg.model,
                                    "progress": msg.progress
                                }));
                            }
                        }
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
                    println!("[PYTHON STDERR]: {}", line);
                    let ignored_patterns = [
                        "warnings.warn(message)",
                        "UserWarning:",
                        "huggingface_hub",
                    ];
                    let should_ignore = ignored_patterns.iter().any(|pattern| line.contains(pattern));

                    if !line.is_empty() && !should_ignore {
                        let _ = app_handle_clone.emit("engine-error", line);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    println!("[RUST]: Engine process terminated: {:?}", payload);
                    if let Ok(mut lock) = child_arc_for_events.lock() {
                        *lock = None;
                    }
                    let _ = app_handle_clone.emit("status-update", "stopped");
                }
                _ => {}
            }
        }
    });

    Ok(())
}


pub fn stop_audio_engine(state: &tauri::State<AppState>) {
    // Attempt graceful shutdown first via EXIT command
    let _ = write_engine_command(state, "EXIT\n");
    // Give the engine time to gracefully tear down
    std::thread::sleep(std::time::Duration::from_millis(800));

    if let Ok(mut lock) = state.sidecar_child.lock() {
        if let Some(child) = lock.take() {
            let pid = child.pid();
            let _ = child.kill();
            // On Linux: also kill descendant processes (e.g. whisper-cli subprocess,
            // multiprocessing workers) so nothing is left orphaned.
            #[cfg(target_os = "linux")]
            kill_process_tree(pid);
        }
    }
}

/// Kills all descendant processes of `pid` on Linux to prevent orphans.
#[cfg(target_os = "linux")]
fn kill_process_tree(pid: u32) {
    // Kill children first, then the parent (belt-and-suspenders with child.kill() above)
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-P", &pid.to_string()])
        .output();
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output();
}

pub fn write_engine_command(state: &tauri::State<AppState>, command: &str) -> Result<(), String> {
    let mut lock = state.sidecar_child.lock().map_err(|e| e.to_string())?;
    let Some(child) = lock.as_mut() else {
        return Err("Audio engine is not running".to_string());
    };

    if let Err(error) = child.write(command.as_bytes()) {
        *lock = None;
        return Err(error.to_string());
    }

    Ok(())
}
