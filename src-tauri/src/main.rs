// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Manager, Emitter, Runtime, WindowEvent};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::menu::{Menu, MenuItem};
use tauri::image::Image;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

mod state;
mod engine;
mod shortcuts;
mod startup;
mod downloader;
mod python_setup;

use state::{AppState, AutoPasteMode, EngineSettings};
use shortcuts::HotkeyConfig;

fn main() {
    #[cfg(target_os = "linux")]
    {
        // Enforce X11 backend on Linux to bypass Wayland's strict window management restrictions,
        // which completely block frameless transparent windows from staying always on top.
        std::env::set_var("GDK_BACKEND", "x11");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(shortcuts::handle_shortcut).build())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Prevent the window from actually closing — just hide it.
                // The app stays alive in the system tray with the engine running.
                // The user must click "Salir" in the tray to fully exit.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let app_handle = app.handle();
            // Store child in state
            let child_arc = Arc::new(Mutex::new(None));
            let clipboard_mode = Arc::new(Mutex::new(false));
            let clipboard_auto_paste = Arc::new(Mutex::new(false));
            let auto_paste_mode = Arc::new(Mutex::new(AutoPasteMode::default_for_current_os()));
            
            app.manage(AppState {
                sidecar_child: child_arc.clone(),
                recording: Arc::new(Mutex::new(false)),
                capture_mode: Arc::new(Mutex::new("toggle".to_string())),
                capture_shortcut: Arc::new(Mutex::new(None)),
                clipboard_mode: clipboard_mode.clone(),
                clipboard_auto_paste: clipboard_auto_paste.clone(),
                auto_paste_mode: auto_paste_mode.clone(),
                engine_settings: Arc::new(Mutex::new(EngineSettings {
                    microphone: "default".to_string(),
                    model: "large-v3-turbo".to_string(),
                    model_dir: String::new(),
                    language: "es".to_string(),
                    gpu_enabled: true,
                    backend: "auto".to_string(),
                })),
            });

            // Create the tray icon on startup using our bars icon (not the W square logo)
            // This ensures only ONE tray icon ever exists — frontend controls visibility via set_tray_visible
            let _ = create_tray(app_handle);

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

            // Start stealth local HTTP server for Wayland global shortcut bypass
            let app_handle_server = app_handle.clone();
            std::thread::spawn(move || {
                if let Ok(listener) = std::net::TcpListener::bind("127.0.0.1:41414") {
                    for stream in listener.incoming() {
                        if let Ok(mut stream) = stream {
                            let mut buffer = [0; 512];
                            if let Ok(bytes_read) = std::io::Read::read(&mut stream, &mut buffer) {
                                if bytes_read > 0 {
                                    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
                                    if request.starts_with("GET /toggle ") || request.starts_with("POST /toggle ") {
                                        let _ = app_handle_server.emit("global-toggle-capture", ());
                                        let response = "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nOK";
                                        let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
                                    }
                                }
                            }
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
            install_audio_engine,
            update_tray_icon,
            set_tray_visible,
            reload_word_dictionary,
            write_word_dictionary
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn update_tray_icon(app: AppHandle, recording: bool, volume: Option<f32>) {
    let icon_data = if recording {
        let vol = volume.unwrap_or(0.0);
        if vol > 2000.0 {
            include_bytes!("../icons/32x32-recording-v4.png").to_vec()
        } else if vol > 1000.0 {
            include_bytes!("../icons/32x32-recording-v3.png").to_vec()
        } else if vol > 500.0 {
            include_bytes!("../icons/32x32-recording-v2.png").to_vec()
        } else if vol > 100.0 {
            include_bytes!("../icons/32x32-recording-v1.png").to_vec()
        } else {
            include_bytes!("../icons/32x32-recording.png").to_vec()
        }
    } else {
        // Use the bars-idle icon (NOT the W square app logo) to keep visual consistency
        include_bytes!("../icons/32x32.png").to_vec()
    };
    if let Ok(icon) = Image::from_bytes(&icon_data) {
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_icon(Some(icon));
        }

        #[cfg(target_os = "windows")]
        {
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(window_icon) = Image::from_bytes(&icon_data) {
                    let _ = window.set_icon(window_icon);
                }
            }
        }
    }
}

#[tauri::command]
fn set_tray_visible(app: AppHandle, visible: bool) {
    if visible {
        if app.tray_by_id("main").is_none() {
            let _ = create_tray(&app);
        }
    } else {
        let _ = app.remove_tray_by_id("main");
    }
}

fn create_tray(app: &AppHandle) -> Result<(), tauri::Error> {
    let show = MenuItem::with_id(app, "show", "Mostrar Veloce", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    // Use our custom bars icon as the tray icon — never use the square W logo
    let bars_idle = include_bytes!("../icons/32x32.png");
    let icon = Image::from_bytes(bars_idle)
        .unwrap_or_else(|_| app.default_window_icon().unwrap().clone());

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                        let _ = app.emit("show-window", ());
                    }
                }
                "quit" => {
                    // Stop the audio engine (sends EXIT + waits + kills process tree)
                    // before exiting so the Python process is not left as an orphan.
                    let state = app.state::<AppState>();
                    engine::stop_audio_engine(&state);
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let is_visible = window.is_visible().unwrap_or(false);
                    if is_visible {
                        let _ = window.hide();
                    } else {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                        let _ = app.emit("show-window", ());
                    }
                }
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}


#[tauri::command]
async fn install_audio_engine(app: AppHandle) -> Result<(), String> {
    engine::install_engine(&app).await
}

#[tauri::command]
#[allow(non_snake_case)]
fn set_clipboard_settings(
    state: tauri::State<AppState>,
    enabled: bool,
    autoPaste: bool,
    autoPasteMode: Option<String>,
) {
    let mut clipboard = state.clipboard_mode.lock().unwrap();
    *clipboard = enabled;

    let mut clipboard_auto_paste = state.clipboard_auto_paste.lock().unwrap();
    *clipboard_auto_paste = autoPaste;

    let mut mode = state.auto_paste_mode.lock().unwrap();
    *mode = autoPasteMode
        .as_deref()
        .map(AutoPasteMode::from_value)
        .unwrap_or_else(AutoPasteMode::default_for_current_os);
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

fn press_paste_shortcut_for_mode(mode: AutoPasteMode) -> Result<(), String> {
    if mode == AutoPasteMode::TypeText {
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        // On Linux, prefer xdotool because it correctly handles modifier
        // sequences (e.g. ctrl+shift+v) via the X11 keyboard layer.
        // enigo's xtest_fake_input sends raw keycodes that can produce
        // wrong keysyms when Shift is held, breaking ctrl+shift+v.
        let shortcut = match mode {
            AutoPasteMode::CtrlV => "ctrl+v",
            AutoPasteMode::CtrlShiftV => "ctrl+shift+v",
            AutoPasteMode::TypeText => return Ok(()),
        };

        match std::process::Command::new("xdotool")
            .args(["key", shortcut])
            .output()
        {
            Ok(output) if output.status.success() => return Ok(()),
            _ => {
                // xdotool not available or failed; fall through to enigo
            }
        }
    }

    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut enigo = match Enigo::new(&Settings::default()) {
        Ok(instance) => instance,
        Err(_) => return Err("Failed to init enigo".to_string()),
    };

    let _ = enigo.key(Key::Control, Direction::Press);

    if mode == AutoPasteMode::CtrlShiftV {
        let _ = enigo.key(Key::Shift, Direction::Press);
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let _ = enigo.key(Key::Unicode('v'), Direction::Click);

    if mode == AutoPasteMode::CtrlShiftV {
        let _ = enigo.key(Key::Shift, Direction::Release);
    }

    let _ = enigo.key(Key::Control, Direction::Release);
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
fn press_paste_shortcut(state: tauri::State<AppState>, autoPasteMode: Option<String>) -> Result<(), String> {
    let mode = autoPasteMode
        .as_deref()
        .map(AutoPasteMode::from_value)
        .unwrap_or_else(|| *state.auto_paste_mode.lock().unwrap());
    press_paste_shortcut_for_mode(mode)
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
fn reload_word_dictionary(state: tauri::State<AppState>) -> Result<(), String> {
    let cmd = "RELOAD_DICT\n";
    if let Err(error) = engine::write_engine_command(&state, cmd) {
        return Err(format!("No se pudo enviar comando al motor: {}", error));
    }
    Ok(())
}

fn get_dictionary_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("veloce")
        .join("word_dictionary.json")
}

#[tauri::command]
fn write_word_dictionary(state: tauri::State<AppState>, json: String) -> Result<(), String> {
    use std::fs;
    let final_path = get_dictionary_path();
    let parent = final_path
        .parent()
        .ok_or_else(|| "dictionary path has no parent".to_string())?;
    let tmp_path = final_path.with_extension("json.tmp");
    fs::create_dir_all(parent).map_err(|e| format!("create_dir_all failed: {e}"))?;
    fs::write(&tmp_path, json.as_bytes()).map_err(|e| format!("write tmp failed: {e}"))?;
    fs::rename(&tmp_path, &final_path).map_err(|e| format!("rename failed: {e}"))?;
    engine::write_engine_command(&state, "RELOAD_DICT\n")
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

#[cfg(test)]
mod tests {
    use super::press_paste_shortcut_for_mode;
    use crate::state::AutoPasteMode;

    #[test]
    fn parses_known_auto_paste_modes() {
        assert_eq!(AutoPasteMode::from_value("ctrl_v"), AutoPasteMode::CtrlV);
        assert_eq!(AutoPasteMode::from_value("ctrl_shift_v"), AutoPasteMode::CtrlShiftV);
        assert_eq!(AutoPasteMode::from_value("type_text"), AutoPasteMode::TypeText);
    }

    #[test]
    fn defaults_to_ctrl_v_when_mode_is_unknown() {
        assert_eq!(AutoPasteMode::from_value("something-else"), AutoPasteMode::CtrlV);
    }

    #[test]
    fn type_text_mode_skips_shortcut_emulation() {
        assert!(press_paste_shortcut_for_mode(AutoPasteMode::TypeText).is_ok());
    }
}
// Force rebuild after audio_engine.py fix
// Rebuild after transcription_worker global fix
