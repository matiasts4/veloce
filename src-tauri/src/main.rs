// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Manager, Emitter, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent};
// Note: Imports might vary based on exact plugin version. 
// Assuming tauri-plugin-global-shortcut 2.x

use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandEvent, CommandChild};
use std::sync::{Arc, Mutex};
use enigo::{Enigo, Key, Keyboard, Settings, Direction};

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct EngineSettings {
    microphone: String,
    model: String,
    language: String,
    gpu_enabled: bool,
}

struct AppState {
    sidecar_child: Arc<Mutex<Option<CommandChild>>>,
    recording: Arc<Mutex<bool>>,
    clipboard_mode: Arc<Mutex<bool>>,
    engine_settings: Arc<Mutex<EngineSettings>>,
}

fn write_engine_command(state: &tauri::State<AppState>, command: &str) -> Result<(), String> {
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

#[derive(serde::Deserialize)]
struct SidecarMessage {
    status: Option<String>,
    transcription: Option<String>,
    #[serde(default)]
    response_ms: Option<f64>,
    #[serde(default)]
    recording_id: Option<u64>,
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
    model: Option<String>,
    #[serde(default)]
    progress: Option<u8>,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(handle_shortcut).build())
        .setup(|app| {
            let app_handle = app.handle();
            
            let current_dir = std::env::current_dir().map_err(|e| e.to_string())?;
            let script_candidates = [
                current_dir.join("python/audio_engine.py"),
                current_dir.join("../python/audio_engine.py"),
            ];

            let script_path = script_candidates
                .into_iter()
                .find(|path| path.exists())
                .ok_or_else(|| {
                    format!(
                        "Audio engine script not found. Checked: {} and {}",
                        current_dir.join("python/audio_engine.py").display(),
                        current_dir.join("../python/audio_engine.py").display()
                    )
                })?;

            let sidecar_command = app.shell().command("python")
                .args([script_path.to_string_lossy().to_string()]);
            
            let (mut rx, child) = sidecar_command.spawn().map_err(|e| e.to_string())?;
            
            // Store child in state
            let child_arc = Arc::new(Mutex::new(Some(child)));
            let clipboard_mode = Arc::new(Mutex::new(false));
            
            app.manage(AppState {
                sidecar_child: child_arc.clone(),
                recording: Arc::new(Mutex::new(false)),
                clipboard_mode: clipboard_mode.clone(),
                engine_settings: Arc::new(Mutex::new(EngineSettings {
                    microphone: "default".to_string(),
                    model: "large-v3-turbo".to_string(),
                    language: "es".to_string(),
                    gpu_enabled: true,
                })),
            });

            // Handle Sidecar Output
            let app_handle_clone = app_handle.clone();
            let child_arc_for_events = child_arc.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line_bytes) => {
                            let line = String::from_utf8_lossy(&line_bytes);
                            // Detect JSON
                            if let Ok(msg) = serde_json::from_str::<SidecarMessage>(&line) {
                                // Handle Transcription
                                if let Some(text) = msg.transcription {
                                    let response_ms = msg.response_ms;
                                    let recording_id = msg.recording_id;
                                    let _ = app_handle_clone.emit("transcription-update", serde_json::json!({
                                        "text": text.clone(),
                                        "response_ms": response_ms,
                                        "recording_id": recording_id,
                                    }));

                                     // Inject Text
                                    let mut enigo = match Enigo::new(&Settings::default()) {
                                        Ok(instance) => instance,
                                        Err(_) => continue,
                                    };
                                    
                                    // Check Clipboard Mode
                                    let state = app_handle_clone.state::<AppState>();
                                    let use_clipboard = *state.clipboard_mode.lock().unwrap();

                                    if use_clipboard {
                                        // Copy to clipboard
                                        if let Ok(mut clipboard) = arboard::Clipboard::new() {
                                            let _ = clipboard.set_text(&text);
                                        }
                                        // Paste (Ctrl+V)
                                        let _ = enigo.key(Key::Control, Direction::Press);
                                        let _ = enigo.key(Key::Unicode('v'), Direction::Click);
                                        let _ = enigo.key(Key::Control, Direction::Release);
                                    } else {
                                        // Type out
                                        let _ = enigo.text(&text);
                                    }
                                }

                                if let Some(error) = msg.error {
                                    let _ = app_handle_clone.emit("engine-error", error);
                                }

                                if let Some(log) = msg.log {
                                    let _ = app_handle_clone.emit("engine-log", log);
                                }
                                
                                // Handle Status Updates
                                if let Some(status) = msg.status {
                                    let _ = app_handle_clone.emit("status-update", status);
                                }
                                
                                // Handle Hardware Info
                                if let Some(msg_type) = msg.msg_type {
                                    if msg_type == "hardware-info" {
                                        let _ = app_handle_clone.emit("hardware-info", serde_json::json!({
                                            "microphones": msg.microphones,
                                            "models": msg.models,
                                            "gpu": msg.gpu
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
                            let ignored_patterns = [
                                "warnings.warn(message)",
                                "UserWarning:",
                                "You are sending unauthenticated requests to the HF Hub",
                                "huggingface_hub",
                                "To support symlinks on Windows",
                            ];
                            let should_ignore = ignored_patterns.iter().any(|pattern| line.contains(pattern));

                            if !line.is_empty() && !should_ignore {
                                let _ = app_handle_clone.emit("engine-error", line);
                            }
                        }
                        CommandEvent::Error(error) => {
                            let _ = app_handle_clone.emit("engine-error", format!("Engine error: {error}"));
                        }
                        CommandEvent::Terminated(payload) => {
                            if let Ok(mut lock) = child_arc_for_events.lock() {
                                *lock = None;
                            }
                            let code = payload.code.map_or("unknown".to_string(), |c| c.to_string());
                            let _ = app_handle_clone.emit("engine-error", format!("Audio engine closed (code {code})"));
                            let _ = app_handle_clone.emit("status-update", "stopped");
                        }
                        _ => {}
                    }
                }
            });
            
            // Register Shortcuts
            let shortcut_record = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);
            let shortcut_focus = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyV);

            if let Err(error) = app.global_shortcut().register(shortcut_record) {
                eprintln!("Failed to register capture shortcut: {error}");
            }
            if let Err(error) = app.global_shortcut().register(shortcut_focus) {
                eprintln!("Failed to register focus shortcut: {error}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![toggle_clipboard, toggle_recording, set_engine_settings, refresh_hardware, download_model])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn toggle_clipboard(state: tauri::State<AppState>, enabled: bool) {
    let mut clipboard = state.clipboard_mode.lock().unwrap();
    *clipboard = enabled;
}

#[tauri::command]
fn toggle_recording<R: Runtime>(app: AppHandle<R>, state: tauri::State<AppState>) -> Result<bool, String> {
    let mut recording = state.recording.lock().map_err(|e| e.to_string())?;
    *recording = !*recording;

    let cmd = if *recording { "START\n" } else { "STOP\n" };
    if let Err(error) = write_engine_command(&state, cmd) {
        *recording = false;
        let _ = app.emit("recording-state", false);
        let _ = app.emit("engine-error", format!("No se pudo enviar comando al motor: {error}"));
        return Ok(false);
    }

    app.emit("recording-state", *recording).map_err(|e| e.to_string())?;
    Ok(*recording)
}

#[tauri::command]
#[allow(non_snake_case)]
fn set_engine_settings(
    app: AppHandle,
    state: tauri::State<AppState>,
    microphone: String,
    model: String,
    language: String,
    gpuEnabled: bool,
) -> Result<(), String> {
    {
        let mut settings = state.engine_settings.lock().map_err(|e| e.to_string())?;
        settings.microphone = microphone.clone();
        settings.model = model.clone();
        settings.language = language.clone();
        settings.gpu_enabled = gpuEnabled;
    }

    let payload = serde_json::json!({
        "microphone": microphone,
        "model": model,
        "language": language,
        "gpu_enabled": gpuEnabled
    });

    let cmd = format!("CONFIG {}\n", payload);
    if let Err(error) = write_engine_command(&state, &cmd) {
        let _ = app.emit("engine-error", format!("No se pudo actualizar configuración del motor: {error}"));
    }

    Ok(())
}

#[tauri::command]
fn refresh_hardware(app: AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    if let Err(error) = write_engine_command(&state, "HARDWARE\n") {
        let _ = app.emit("engine-error", format!("No se pudo consultar hardware: {error}"));
    }
    Ok(())
}

#[tauri::command]
fn download_model(app: AppHandle, state: tauri::State<AppState>, model: String) -> Result<(), String> {
    let cmd = format!("DOWNLOAD {}\n", model);
    if let Err(error) = write_engine_command(&state, &cmd) {
        let _ = app.emit("engine-error", format!("No se pudo descargar el modelo {model}: {error}"));
    } else {
        let _ = app.emit("engine-log", format!("Descargando modelo: {model}"));
    }
    Ok(())
}

fn handle_shortcut<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut, _event: ShortcutEvent) {
    if shortcut.matches(Modifiers::CONTROL, Code::Space) {
        let state = app.state::<AppState>();
        let mut recording = match state.recording.lock() {
            Ok(lock) => lock,
            Err(_) => return,
        };
        *recording = !*recording;

        let cmd = if *recording { "START\n" } else { "STOP\n" };

        if let Ok(mut lock) = state.sidecar_child.lock() {
            if let Some(child) = lock.as_mut() {
                if child.write(cmd.as_bytes()).is_err() {
                    *lock = None;
                    *recording = false;
                    let _ = app.emit("recording-state", false);
                    let _ = app.emit("engine-error", "No se pudo enviar comando al motor de audio");
                    return;
                }
            } else {
                *recording = false;
                let _ = app.emit("recording-state", false);
                let _ = app.emit("engine-error", "El motor de audio no está disponible");
                return;
            }
        }

        let _ = app.emit("recording-state", *recording);
    } else if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyV) {
        // Focus Window
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
            let _ = window.unminimize();
        }
    }
}
