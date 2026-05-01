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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoPasteMode {
    CtrlV,
    CtrlShiftV,
    TypeText,
}

impl AutoPasteMode {
    pub fn from_value(value: &str) -> Self {
        match value.trim().to_lowercase().as_str() {
            "ctrl_shift_v" => Self::CtrlShiftV,
            "type_text" => Self::TypeText,
            _ => Self::CtrlV,
        }
    }

    pub fn as_value(&self) -> &'static str {
        match self {
            Self::CtrlV => "ctrl_v",
            Self::CtrlShiftV => "ctrl_shift_v",
            Self::TypeText => "type_text",
        }
    }

    pub fn default_for_current_os() -> Self {
        Self::CtrlV
    }
}

pub struct AppState {
    pub sidecar_child: Arc<Mutex<Option<CommandChild>>>,
    pub recording: Arc<Mutex<bool>>,
    pub capture_mode: Arc<Mutex<String>>,
    pub capture_shortcut: Arc<Mutex<Option<Shortcut>>>,
    pub clipboard_mode: Arc<Mutex<bool>>,
    pub clipboard_auto_paste: Arc<Mutex<bool>>,
    pub auto_paste_mode: Arc<Mutex<AutoPasteMode>>,
    pub engine_settings: Arc<Mutex<EngineSettings>>,
}
