use crate::engine;
use crate::state::AppState;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyConfig {
    pub key: String,
    pub ctrl_key: bool,
    pub shift_key: bool,
    pub alt_key: bool,
    pub meta_key: bool,
}

fn key_to_code(key: &str) -> Option<Code> {
    // Check for literal space BEFORE trimming (trim would erase it)
    if key == " " || key.trim().eq_ignore_ascii_case("space") {
        return Some(Code::Space);
    }
    let normalized = key.trim().to_lowercase();
    match normalized.as_str() {
        "home" => Some(Code::Home),
        "end" => Some(Code::End),
        "insert" => Some(Code::Insert),
        "delete" => Some(Code::Delete),
        "enter" => Some(Code::Enter),
        "tab" => Some(Code::Tab),
        "backspace" => Some(Code::Backspace),
        "escape" | "esc" => Some(Code::Escape),
        "arrowup" | "up" => Some(Code::ArrowUp),
        "arrowdown" | "down" => Some(Code::ArrowDown),
        "arrowleft" | "left" => Some(Code::ArrowLeft),
        "arrowright" | "right" => Some(Code::ArrowRight),
        "f1" => Some(Code::F1),
        "f2" => Some(Code::F2),
        "f3" => Some(Code::F3),
        "f4" => Some(Code::F4),
        "f5" => Some(Code::F5),
        "f6" => Some(Code::F6),
        "f7" => Some(Code::F7),
        "f8" => Some(Code::F8),
        "f9" => Some(Code::F9),
        "f10" => Some(Code::F10),
        "f11" => Some(Code::F11),
        "f12" => Some(Code::F12),
        "0" => Some(Code::Digit0),
        "1" => Some(Code::Digit1),
        "2" => Some(Code::Digit2),
        "3" => Some(Code::Digit3),
        "4" => Some(Code::Digit4),
        "5" => Some(Code::Digit5),
        "6" => Some(Code::Digit6),
        "7" => Some(Code::Digit7),
        "8" => Some(Code::Digit8),
        "9" => Some(Code::Digit9),
        "a" => Some(Code::KeyA),
        "b" => Some(Code::KeyB),
        "c" => Some(Code::KeyC),
        "d" => Some(Code::KeyD),
        "e" => Some(Code::KeyE),
        "f" => Some(Code::KeyF),
        "g" => Some(Code::KeyG),
        "h" => Some(Code::KeyH),
        "i" => Some(Code::KeyI),
        "j" => Some(Code::KeyJ),
        "k" => Some(Code::KeyK),
        "l" => Some(Code::KeyL),
        "m" => Some(Code::KeyM),
        "n" => Some(Code::KeyN),
        "o" => Some(Code::KeyO),
        "p" => Some(Code::KeyP),
        "q" => Some(Code::KeyQ),
        "r" => Some(Code::KeyR),
        "s" => Some(Code::KeyS),
        "t" => Some(Code::KeyT),
        "u" => Some(Code::KeyU),
        "v" => Some(Code::KeyV),
        "w" => Some(Code::KeyW),
        "x" => Some(Code::KeyX),
        "y" => Some(Code::KeyY),
        "z" => Some(Code::KeyZ),
        _ => None,
    }
}

pub fn shortcut_from_config(config: &HotkeyConfig) -> Result<Shortcut, String> {
    let code =
        key_to_code(&config.key).ok_or_else(|| format!("Hotkey no soportada: {}", config.key))?;

    let mut modifiers = Modifiers::empty();
    if config.ctrl_key {
        modifiers |= Modifiers::CONTROL;
    }
    if config.shift_key {
        modifiers |= Modifiers::SHIFT;
    }
    if config.alt_key {
        modifiers |= Modifiers::ALT;
    }
    if config.meta_key {
        modifiers |= Modifiers::SUPER;
    }

    if modifiers.is_empty() {
        Ok(Shortcut::new(None, code))
    } else {
        Ok(Shortcut::new(Some(modifiers), code))
    }
}

pub fn register_capture_shortcut<R: Runtime>(
    app: &AppHandle<R>,
    state: &tauri::State<AppState>,
    config: HotkeyConfig,
) -> Result<(), String> {
    let new_shortcut = shortcut_from_config(&config)?;

    let mut lock = state.capture_shortcut.lock().map_err(|e| e.to_string())?;
    if let Some(previous_shortcut) = lock.take() {
        let _ = app.global_shortcut().unregister(previous_shortcut);
    }

    app.global_shortcut()
        .register(new_shortcut)
        .map_err(|error| format!("No se pudo registrar el atajo global: {error}"))?;

    *lock = Some(new_shortcut);
    Ok(())
}

fn send_shortcut_command<R: Runtime>(app: AppHandle<R>, recording: bool) {
    let state = app.state::<AppState>();
    let cmd = if recording { "START\n" } else { "STOP\n" };
    let child_arc = state.sidecar_child.clone();
    let recording_arc = state.recording.clone();

    tauri::async_runtime::spawn(async move {
        {
            let lock = child_arc.lock().await;
            if lock.is_none() {
                drop(lock);
                if let Err(error) = engine::spawn_audio_engine(&app, child_arc.clone()).await {
                    let _ = app.emit("engine-error", error);
                    let _ = app.emit("recording-state", false);
                    if let Ok(mut r) = recording_arc.lock() {
                        *r = false;
                    }
                    return;
                }
            }
        }

        if let Err(error) = engine::write_engine_command(&app.state::<AppState>(), cmd).await {
            let _ = app.emit(
                "engine-error",
                format!("No se pudo enviar comando al motor de audio: {error}"),
            );
            let _ = app.emit("recording-state", false);
            if let Ok(mut r) = recording_arc.lock() {
                *r = false;
            }
        }
    });
}

pub fn handle_shortcut<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut, event: ShortcutEvent) {
    let state = app.state::<AppState>();
    let capture_shortcut = state
        .capture_shortcut
        .lock()
        .map(|value| value.clone())
        .unwrap_or(None);

    if let Some(active_capture_shortcut) = capture_shortcut {
        if *shortcut != active_capture_shortcut {
            if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyV) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                    let _ = window.unminimize();
                }
            }
            return;
        }

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

            {
                let mut recording = match state.recording.lock() {
                    Ok(lock) => lock,
                    Err(_) => return,
                };

                if *recording == target_recording {
                    return;
                }
                *recording = target_recording;
            }

            let _ = app.emit("recording-state", target_recording);
            send_shortcut_command(app.clone(), target_recording);
            return;
        }

        if event.state() == ShortcutState::Released {
            return;
        }

        let new_recording = {
            let mut recording = match state.recording.lock() {
                Ok(lock) => lock,
                Err(_) => return,
            };
            *recording = !*recording;
            *recording
        };

        let _ = app.emit("recording-state", new_recording);
        send_shortcut_command(app.clone(), new_recording);
        return;
    }

    if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyV) {
        // Focus Window
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
            let _ = window.unminimize();
        }
    }
}
