// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Manager, Emitter, Runtime, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
use std::sync::{Arc, Mutex};

mod state;
mod engine;
mod shortcuts;
mod startup;
mod downloader;
mod python_setup;

use state::{AppState, EngineSettings};
use shortcuts::HotkeyConfig;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(shortcuts::handle_shortcut).build())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                engine::stop_audio_engine(&state);
            }
        })
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
                capture_shortcut: Arc::new(Mutex::new(None)),
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

            let app_handle_clone = app_handle.clone();
            let child_arc_clone = child_arc.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = engine::spawn_audio_engine(&app_handle_clone, child_arc_clone.clone()).await {
                    println!("[RUST] Startup spawn failed: {}", error);
                    println!("[RUST] Attempting auto-recovery/setup...");
                    let _ = app_handle_clone.emit("status-update", "Iniciando configuración automática...");
                    
                    match engine::install_engine(&app_handle_clone).await {
                        Ok(_) => {
                            println!("[RUST] Setup complete. Retrying spawn...");
                            if let Err(e2) = engine::spawn_audio_engine(&app_handle_clone, child_arc_clone).await {
                                    let _ = app_handle_clone.emit("engine-error", format!("Error al iniciar tras configuración: {}", e2));
                            }
                        },
                        Err(e_install) => {
                                let _ = app_handle_clone.emit("engine-error", format!("Fallo en configuración: {}", e_install));
                        }
                    }
                }
            });
            
            // Register Shortcuts
            let shortcut_focus = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyV);

            if let Err(error) = shortcuts::register_capture_shortcut(
                &app_handle,
                &app_handle.state::<AppState>(),
                HotkeyConfig {
                    key: " ".to_string(),
                    ctrl_key: true,
                    shift_key: false,
                    alt_key: false,
                    meta_key: false,
                },
            ) {
                eprintln!("Failed to register capture shortcut: {error}");
            }
            if let Err(error) = app.global_shortcut().register(shortcut_focus) {
                eprintln!("Failed to register focus shortcut: {error}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_clipboard_settings,
            set_clipboard,
            type_text,
            press_paste_shortcut,
            toggle_recording,
            set_capture_mode,
            set_capture_hotkey,
            set_engine_settings,
            refresh_hardware,
            download_model,
            delete_model,
            get_startup_enabled,
            set_startup_enabled,
            install_audio_engine
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn install_audio_engine(app: AppHandle) -> Result<(), String> {
    engine::install_engine(&app).await
}

#[tauri::command]
fn set_clipboard_settings(state: tauri::State<AppState>, enabled: bool, auto_paste: bool) {
    let mut clipboard = state.clipboard_mode.lock().unwrap();
    *clipboard = enabled;

    let mut clipboard_auto_paste = state.clipboard_auto_paste.lock().unwrap();
    *clipboard_auto_paste = auto_paste;
}

#[tauri::command]
fn set_clipboard(text: String) -> Result<(), String> {
    if let Ok(mut clipboard) = arboard::Clipboard::new() {
        if clipboard.set_text(text).is_ok() {
            return Ok(());
        }
    }
    Err("Failed to copy to clipboard".to_string())
}

#[tauri::command]
fn type_text(text: String) -> Result<(), String> {
    use enigo::{Enigo, Keyboard, Settings};
    let mut enigo = match Enigo::new(&Settings::default()) {
        Ok(instance) => instance,
        Err(_) => return Err("Failed to init enigo".to_string()),
    };
    let _ = enigo.text(&text);
    Ok(())
}

#[tauri::command]
fn press_paste_shortcut() -> Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut enigo = match Enigo::new(&Settings::default()) {
        Ok(instance) => instance,
        Err(_) => return Err("Failed to init enigo".to_string()),
    };
    let _ = enigo.key(Key::Control, Direction::Press);
    let _ = enigo.key(Key::Unicode('v'), Direction::Click);
    let _ = enigo.key(Key::Control, Direction::Release);
    Ok(())
}

#[tauri::command]
async fn toggle_recording<R: Runtime>(app: AppHandle<R>, state: tauri::State<'_, AppState>) -> Result<bool, String> {
    if state.sidecar_child.lock().map_err(|e| e.to_string())?.is_none() {
        if let Err(error) = engine::spawn_audio_engine(&app, state.sidecar_child.clone()).await {
            let _ = app.emit("engine-error", error);
            return Ok(false);
        }
    }

    let mut recording = state.recording.lock().map_err(|e| e.to_string())?;
    *recording = !*recording;

    let cmd = if *recording { "START\n" } else { "STOP\n" };
    if let Err(error) = engine::write_engine_command(&state, cmd) {
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
fn set_capture_hotkey(app: AppHandle, state: tauri::State<AppState>, hotkey: HotkeyConfig) -> Result<(), String> {
    shortcuts::register_capture_shortcut(&app, &state, hotkey)
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
    if let Err(error) = engine::write_engine_command(&state, &cmd) {
        let _ = app.emit("engine-error", format!("No se pudo actualizar configuración del motor: {error}"));
    }

    Ok(())
}

#[tauri::command]
async fn refresh_hardware(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    if state.sidecar_child.lock().map_err(|e| e.to_string())?.is_none() {
        if let Err(error) = engine::spawn_audio_engine(&app, state.sidecar_child.clone()).await {
            let _ = app.emit("engine-error", error);
            return Ok(());
        }
    }

    if let Err(error) = engine::write_engine_command(&state, "HARDWARE\n") {
        let _ = app.emit("engine-error", format!("No se pudo consultar hardware: {error}"));
    }
    Ok(())
}

#[tauri::command]
fn get_startup_enabled() -> bool {
    startup::get_startup_enabled()
}

#[tauri::command]
fn set_startup_enabled(enabled: bool) -> Result<(), String> {
    startup::set_startup_enabled(enabled)
}

#[tauri::command]
async fn download_model(app: AppHandle, state: tauri::State<'_, AppState>, model: String, download_dir: Option<String>) -> Result<(), String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("Model name is required".to_string());
    }

    if state.sidecar_child.lock().map_err(|e| e.to_string())?.is_none() {
        if let Err(error) = engine::spawn_audio_engine(&app, state.sidecar_child.clone()).await {
            let _ = app.emit("engine-error", error.clone());
            return Err(error);
        }
    }

    let payload = serde_json::json!({
        "model": model,
        "dir": download_dir
    });
    
    let cmd = format!("DOWNLOAD {}\n", payload.to_string());
    if let Err(error) = engine::write_engine_command(&state, &cmd) {
        let message = format!("No se pudo descargar el modelo {model}: {error}");
        let _ = app.emit("engine-error", message.clone());
        return Err(message);
    } else {
        let _ = app.emit("engine-log", format!("Iniciando descarga de modelo: {model}"));
    }
    Ok(())
}

#[tauri::command]
async fn delete_model(app: AppHandle, state: tauri::State<'_, AppState>, model: String, path: Option<String>) -> Result<(), String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("Model name is required".to_string());
    }

    if state.sidecar_child.lock().map_err(|e| e.to_string())?.is_none() {
        if let Err(error) = engine::spawn_audio_engine(&app, state.sidecar_child.clone()).await {
            let _ = app.emit("engine-error", error.clone());
            return Err(error);
        }
    }

    let payload = serde_json::json!({
        "model": model,
        "path": path
    });
    
    let cmd = format!("DELETE_MODEL {}\n", payload.to_string());
    if let Err(error) = engine::write_engine_command(&state, &cmd) {
        let message = format!("No se pudo eliminar el modelo {model}: {error}");
        let _ = app.emit("engine-error", message.clone());
        return Err(message);
    } else {
        let _ = app.emit("engine-log", format!("Solicitando eliminación de modelo: {model}"));
    }
    Ok(())
}
