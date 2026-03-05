use std::sync::{Arc, Mutex};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_global_shortcut::Shortcut;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct EngineSettings {
    pub microphone: String,
    pub model: String,
    pub model_dir: String,
    pub language: String,
    pub gpu_enabled: bool,
    pub backend: String,
}

pub struct AppState {
    pub sidecar_child: Arc<Mutex<Option<CommandChild>>>,
    pub recording: Arc<Mutex<bool>>,
    pub capture_mode: Arc<Mutex<String>>,
    pub capture_shortcut: Arc<Mutex<Option<Shortcut>>>,
    pub clipboard_mode: Arc<Mutex<bool>>,
    pub clipboard_auto_paste: Arc<Mutex<bool>>,
    pub engine_settings: Arc<Mutex<EngineSettings>>,
}
