// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Manager, Emitter, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState};
// Note: Imports might vary based on exact plugin version. 
// Assuming tauri-plugin-global-shortcut 2.x

use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandEvent, CommandChild};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use std::fs;
use enigo::{Enigo, Key, Keyboard, Settings, Direction};
#[cfg(windows)]
use winreg::RegKey;
#[cfg(windows)]
use winreg::enums::HKEY_CURRENT_USER;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct EngineSettings {
    microphone: String,
    model: String,
    model_dir: String,
    language: String,
    gpu_enabled: bool,
    backend: String,
}

struct AppState {
    sidecar_child: Arc<Mutex<Option<CommandChild>>>,
    recording: Arc<Mutex<bool>>,
    capture_mode: Arc<Mutex<String>>,
    clipboard_mode: Arc<Mutex<bool>>,
    clipboard_auto_paste: Arc<Mutex<bool>>,
    engine_settings: Arc<Mutex<EngineSettings>>,
}

const EMBEDDED_AUDIO_ENGINE: &str = include_str!("../../python/audio_engine.py");

#[cfg(windows)]
fn set_startup_enabled_on_windows(enabled: bool) -> Result<(), String> {
    let executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => return Err(error.to_string()),
    };

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run_key, _) = hkcu
        .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .map_err(|error| error.to_string())?;

    if enabled {
        let command = format!("\"{}\"", executable.display());
        run_key
            .set_value("Veloce", &command)
            .map_err(|error| error.to_string())?;
    } else {
        let _ = run_key.delete_value("Veloce");
    }

    Ok(())
}

#[cfg(windows)]
fn get_startup_enabled_on_windows() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = match hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run") {
        Ok(key) => key,
        Err(_) => return false,
    };

    run_key.get_value::<String, _>("Veloce").is_ok()
}

#[cfg(not(windows))]
fn set_startup_enabled_on_windows(_enabled: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
fn get_startup_enabled_on_windows() -> bool {
    false
}

fn ensure_embedded_audio_engine_script<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
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

fn resolve_audio_engine_script<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let mut script_candidates: Vec<PathBuf> = Vec::new();

    if let Some(embedded_script) = ensure_embedded_audio_engine_script(app) {
        script_candidates.push(embedded_script);
    }

    if let Ok(current_dir) = std::env::current_dir() {
        script_candidates.push(current_dir.join("python/audio_engine.py"));
        script_candidates.push(current_dir.join("../python/audio_engine.py"));
    }

    if let Ok(executable) = std::env::current_exe() {
        if let Some(exe_dir) = executable.parent() {
            script_candidates.push(exe_dir.join("audio_engine.py"));
            script_candidates.push(exe_dir.join("python/audio_engine.py"));
            script_candidates.push(exe_dir.join("resources/audio_engine.py"));
            script_candidates.push(exe_dir.join("resources/python/audio_engine.py"));
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        script_candidates.push(resource_dir.join("audio_engine.py"));
        script_candidates.push(resource_dir.join("python/audio_engine.py"));
        script_candidates.push(resource_dir.join("resources/audio_engine.py"));
        script_candidates.push(resource_dir.join("resources/python/audio_engine.py"));
    }

    script_candidates.into_iter().find(|path| path.exists())
}

fn spawn_audio_engine<R: Runtime>(app_handle: &AppHandle<R>, child_arc: Arc<Mutex<Option<CommandChild>>>) -> Result<(), String> {
    if let Ok(lock) = child_arc.lock() {
        if lock.is_some() {
            return Ok(());
        }
    }

    let script_path = resolve_audio_engine_script(app_handle)
        .ok_or_else(|| "Audio engine script not found in dev/bundle paths".to_string())?;

    let sidecar_command = app_handle
        .shell()
        .command("python")
        .args([script_path.to_string_lossy().to_string()]);

    let (mut rx, child) = sidecar_command
        .spawn()
        .map_err(|error| format!("No se pudo iniciar el motor de audio. Verifica Python instalado. Detalle: {error}"))?;

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
                    if let Ok(msg) = serde_json::from_str::<SidecarMessage>(&line) {
                        if let Some(text) = msg.transcription {
                            let response_ms = msg.response_ms;
                            let recording_id = msg.recording_id;
                            let _ = app_handle_clone.emit("transcription-update", serde_json::json!({
                                "text": text.clone(),
                                "response_ms": response_ms,
                                "recording_id": recording_id,
                            }));

                            let mut enigo = match Enigo::new(&Settings::default()) {
                                Ok(instance) => instance,
                                Err(_) => continue,
                            };

                            let state = app_handle_clone.state::<AppState>();
                            let use_clipboard = *state.clipboard_mode.lock().unwrap();
                            let auto_paste = *state.clipboard_auto_paste.lock().unwrap();

                            if use_clipboard {
                                let mut clipboard_updated = false;
                                if let Ok(mut clipboard) = arboard::Clipboard::new() {
                                    if clipboard.set_text(&text).is_ok() {
                                        clipboard_updated = true;
                                    }
                                }

                                if clipboard_updated && auto_paste {
                                    let _ = enigo.key(Key::Control, Direction::Press);
                                    let _ = enigo.key(Key::Unicode('v'), Direction::Click);
                                    let _ = enigo.key(Key::Control, Direction::Release);
                                } else if !clipboard_updated {
                                    let _ = app_handle_clone.emit("engine-error", "No se pudo actualizar el portapapeles; se evitó pegar texto anterior.");
                                }
                            } else {
                                let _ = enigo.text(&text);
                            }
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
    backends: Option<serde_json::Value>,
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
            // Store child in state
            let child_arc = Arc::new(Mutex::new(None));
            let clipboard_mode = Arc::new(Mutex::new(false));
            let clipboard_auto_paste = Arc::new(Mutex::new(false));
            
            app.manage(AppState {
                sidecar_child: child_arc.clone(),
                recording: Arc::new(Mutex::new(false)),
                capture_mode: Arc::new(Mutex::new("toggle".to_string())),
                clipboard_mode: clipboard_mode.clone(),
                clipboard_auto_paste: clipboard_auto_paste.clone(),
                engine_settings: Arc::new(Mutex::new(EngineSettings {
                    microphone: "default".to_string(),
                    model: "large-v3-turbo".to_string(),
                    model_dir: String::new(),
                    language: "es".to_string(),
                    gpu_enabled: true,
                    backend: "auto".to_string(),
                })),
            });

            if let Err(error) = spawn_audio_engine(&app_handle, child_arc.clone()) {
                let _ = app_handle.emit("engine-error", error);
            }
            
            // Register Shortcuts
            let shortcut_record = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);
            let shortcut_record_home = Shortcut::new(None, Code::Home);
            let shortcut_focus = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyV);

            if let Err(error) = app.global_shortcut().register(shortcut_record) {
                eprintln!("Failed to register capture shortcut: {error}");
            }
            if let Err(error) = app.global_shortcut().register(shortcut_record_home) {
                eprintln!("Failed to register Home capture shortcut: {error}");
            }
            if let Err(error) = app.global_shortcut().register(shortcut_focus) {
                eprintln!("Failed to register focus shortcut: {error}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![set_clipboard_settings, toggle_recording, set_capture_mode, set_engine_settings, refresh_hardware, download_model, get_startup_enabled, set_startup_enabled])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn set_clipboard_settings(state: tauri::State<AppState>, enabled: bool, auto_paste: bool) {
    let mut clipboard = state.clipboard_mode.lock().unwrap();
    *clipboard = enabled;

    let mut clipboard_auto_paste = state.clipboard_auto_paste.lock().unwrap();
    *clipboard_auto_paste = auto_paste;
}

#[tauri::command]
fn toggle_recording<R: Runtime>(app: AppHandle<R>, state: tauri::State<AppState>) -> Result<bool, String> {
    if state.sidecar_child.lock().map_err(|e| e.to_string())?.is_none() {
        if let Err(error) = spawn_audio_engine(&app, state.sidecar_child.clone()) {
            let _ = app.emit("engine-error", error);
            return Ok(false);
        }
    }

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
fn set_capture_mode(state: tauri::State<AppState>, mode: String) -> Result<(), String> {
    let normalized = mode.trim().to_lowercase();
    let effective = if normalized == "hold" { "hold" } else { "toggle" };
    let mut lock = state.capture_mode.lock().map_err(|e| e.to_string())?;
    *lock = effective.to_string();
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
fn set_engine_settings(
    app: AppHandle,
    state: tauri::State<AppState>,
    microphone: String,
    model: String,
    modelDir: String,
    language: String,
    gpuEnabled: bool,
    backend: String,
) -> Result<(), String> {
    {
        let mut settings = state.engine_settings.lock().map_err(|e| e.to_string())?;
        settings.microphone = microphone.clone();
        settings.model = model.clone();
        settings.model_dir = modelDir.clone();
        settings.language = language.clone();
        settings.gpu_enabled = gpuEnabled;
        settings.backend = backend.clone();
    }

    let payload = serde_json::json!({
        "microphone": microphone,
        "model": model,
        "model_dir": modelDir,
        "language": language,
        "gpu_enabled": gpuEnabled,
        "backend": backend
    });

    let cmd = format!("CONFIG {}\n", payload);
    if let Err(error) = write_engine_command(&state, &cmd) {
        let _ = app.emit("engine-error", format!("No se pudo actualizar configuración del motor: {error}"));
    }

    Ok(())
}

#[tauri::command]
fn refresh_hardware(app: AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    if state.sidecar_child.lock().map_err(|e| e.to_string())?.is_none() {
        if let Err(error) = spawn_audio_engine(&app, state.sidecar_child.clone()) {
            let _ = app.emit("engine-error", error);
            return Ok(());
        }
    }

    if let Err(error) = write_engine_command(&state, "HARDWARE\n") {
        let _ = app.emit("engine-error", format!("No se pudo consultar hardware: {error}"));
    }
    Ok(())
}

#[tauri::command]
fn get_startup_enabled() -> bool {
    get_startup_enabled_on_windows()
}

#[tauri::command]
fn set_startup_enabled(enabled: bool) -> Result<(), String> {
    set_startup_enabled_on_windows(enabled)
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

fn handle_shortcut<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut, event: ShortcutEvent) {
    if shortcut.matches(Modifiers::CONTROL, Code::Space) || shortcut.matches(Modifiers::empty(), Code::Home) {
        let state = app.state::<AppState>();
        let capture_mode = state
            .capture_mode
            .lock()
            .map(|mode| mode.clone())
            .unwrap_or_else(|_| "toggle".to_string());

        if capture_mode == "hold" {
            let target_recording = match event.state() {
                ShortcutState::Pressed => true,
                ShortcutState::Released => false,
            };

            let mut recording = match state.recording.lock() {
                Ok(lock) => lock,
                Err(_) => return,
            };

            if *recording == target_recording {
                return;
            }

            *recording = target_recording;
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
            return;
        }

        if event.state() == ShortcutState::Released {
            return;
        }

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
