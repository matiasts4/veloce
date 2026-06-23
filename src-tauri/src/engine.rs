use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex as TokioMutex;
use tokio::time::timeout;

use crate::state::AppState;

pub const EMBEDDED_AUDIO_ENGINE: &str = include_str!("../../python/audio_engine.py");

const HEARTBEAT_INTERVAL_SECS: u64 = 5;
const HEARTBEAT_TIMEOUT_SECS: u64 = 8;
const HEARTBEAT_MAX_MISSES: u32 = 3;
const ENGINE_WRITE_TIMEOUT_SECS: u64 = 3;
const WHISPERCPP_SERVER_PORT: u16 = 8178;

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
    #[serde(default)]
    pong: Option<bool>,
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
        println!(
            "[RUST] Found zip bundle at {:?}. Extracting to {:?}",
            zip, engine_dir
        );
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
                .output()
            {
                Ok(out) => {
                    if out.status.success() {
                        println!("[RUST] Extraction complete.");
                        let _ = fs::write(&marker_file, "v3");
                    } else {
                        println!(
                            "[RUST] Extraction failed: {:?}",
                            String::from_utf8_lossy(&out.stderr)
                        );
                    }
                }
                Err(e) => println!("[RUST] Failed to run powershell: {}", e),
            }
        }

        #[cfg(target_os = "linux")]
        {
            match std::process::Command::new("unzip")
                .args([
                    "-o",
                    &zip.to_string_lossy().to_string(),
                    "-d",
                    &engine_dir.to_string_lossy().to_string(),
                ])
                .output()
            {
                Ok(out) => {
                    if out.status.success() {
                        println!("[RUST] Extraction complete.");
                        let _ = fs::write(&marker_file, "v3");
                    } else {
                        println!(
                            "[RUST] Extraction failed: {:?}",
                            String::from_utf8_lossy(&out.stderr)
                        );
                    }
                }
                Err(e) => println!("[RUST] Failed to run unzip: {}", e),
            }
        }
    } else {
        println!("[RUST] Audio engine zip not found in resources.");
    }
}

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
        }
        Err(e) => Err(format!("Python Setup Failed: {}", e)),
    }
}

/// Kill leftover audio engine / whisper-server processes from previous sessions.
fn cleanup_orphaned_processes() {
    #[cfg(target_os = "windows")]
    {
        for name in ["whisper-server.exe", "whisper-cli.exe", "python.exe"] {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/IM", name])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        for name in ["whisper-server", "whisper-cli", "audio_engine_embedded.py"] {
            let _ = std::process::Command::new("pkill")
                .args(["-9", "-f", name])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
}

/// Try to find a process using the whisper.cpp server port and kill it.
#[cfg(target_os = "linux")]
fn free_whisper_server_port() {
    // fuser can kill processes listening on the port.
    let _ = std::process::Command::new("fuser")
        .args(["-k", "-9", &format!("{}/tcp", WHISPERCPP_SERVER_PORT)])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(target_os = "windows")]
fn free_whisper_server_port() {
    // netstat -ano | findstr :8178, then taskkill /PID <pid>
    if let Ok(output) = std::process::Command::new("cmd")
        .args([
            "/C",
            &format!("netstat -ano | findstr :{}", WHISPERCPP_SERVER_PORT),
        ])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if let Some(pid_str) = parts.last() {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/PID", &pid.to_string()])
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn free_whisper_server_port() {
    cleanup_orphaned_processes();
}

pub async fn spawn_audio_engine<R: Runtime>(
    app_handle: &AppHandle<R>,
    child_arc: Arc<TokioMutex<Option<CommandChild>>>,
) -> Result<(), String> {
    // Always validate/repair the embedded Python environment before spawning.
    // This prevents stale partial installs from crashing with missing modules.
    python_setup::setup_python_environment(app_handle)
        .await
        .map_err(|e| format!("Failed to setup Python environment: {}", e))?;

    // 0. ALL WE NEED TO DO: Ensure the latest script from the binary is extracted to disk
    // every time the engine is spawned. If not, Dev builds will run stale code from AppData.
    ensure_embedded_audio_engine_script(app_handle);

    // Clean up any orphaned sidecar / whisper-server processes from previous crashes.
    cleanup_orphaned_processes();
    free_whisper_server_port();

    // 1. Resolve Python Interpreter (Portable)
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
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
        return Err(format!(
            "Audio engine script not found at {:?}",
            script_path
        ));
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
            }
            Err(e) => return Err(format!("Failed to setup Python environment: {}", e)),
        }
    };

    let command_builder = app_handle
        .shell()
        .command(python_command)
        .args([script_path.to_string_lossy().to_string()]);

    #[cfg(debug_assertions)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        #[cfg(target_os = "windows")]
        let whisper_path = manifest_dir
            .join("resources")
            .join("whispercpp")
            .join("whisper-cli.exe");
        #[cfg(target_os = "linux")]
        let whisper_path = manifest_dir
            .join("resources")
            .join("whispercpp")
            .join("whisper-cli");

        println!(
            "[RUST] Dev Mode: Force setting WHISPERCPP_EXE to {:?}",
            whisper_path
        );
        command_builder =
            command_builder.env("WHISPERCPP_EXE", whisper_path.to_string_lossy().to_string());

        let model_dir = manifest_dir.join("resources").join("models");
        println!(
            "[RUST] Dev Mode: Force setting WHISPERCPP_MODEL_DIR to {:?}",
            model_dir
        );
        command_builder = command_builder.env(
            "WHISPERCPP_MODEL_DIR",
            model_dir.to_string_lossy().to_string(),
        );
    }

    println!("[RUST]: Spawning sidecar process...");
    let (mut rx, child) = command_builder.spawn().map_err(|error| {
        let err_msg = format!("No se pudo iniciar el motor de audio. Detalle: {error}");
        println!("[RUST] Spawn Error: {}", err_msg);
        err_msg
    })?;

    println!("[RUST]: Sidecar process spawned successfully.");

    {
        let mut lock = child_arc.lock().await;
        *lock = Some(child);
    }

    let app_handle_clone = app_handle.clone();
    let child_arc_for_events = child_arc.clone();
    let heartbeat_arc = child_arc.clone();
    let heartbeat_app_handle = app_handle.clone();

    // Channel used by the event loop to confirm the sidecar is alive.
    let (pong_tx, mut pong_rx) = tokio::sync::mpsc::channel::<()>(4);

    tauri::async_runtime::spawn(async move {
        let mut terminated_normally = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes);
                    println!("[PYTHON]: {}", line);

                    if let Ok(msg) = serde_json::from_str::<SidecarMessage>(&line) {
                        if msg.pong == Some(true) {
                            let _ = pong_tx.try_send(());
                            continue;
                        }

                        if let Some(text) = msg.transcription {
                            let response_ms = msg.response_ms;
                            let recording_id = msg.recording_id;
                            let is_final = msg.is_final.unwrap_or(false);
                            let _ = app_handle_clone.emit(
                                "transcription-update",
                                serde_json::json!({
                                    "text": text.clone(),
                                    "response_ms": response_ms,
                                    "recording_id": recording_id,
                                    "is_final": is_final,
                                }),
                            );
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
                                let _ = app_handle_clone.emit(
                                    "hardware-info",
                                    serde_json::json!({
                                        "microphones": msg.microphones,
                                        "models": msg.models,
                                        "gpu": msg.gpu,
                                        "backends": msg.backends
                                    }),
                                );
                            } else if msg_type == "model-download-progress" {
                                let _ = app_handle_clone.emit(
                                    "model-download-progress",
                                    serde_json::json!({
                                        "model": msg.model,
                                        "progress": msg.progress
                                    }),
                                );
                            }
                        }
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
                    println!("[PYTHON STDERR]: {}", line);
                    let ignored_patterns =
                        ["warnings.warn(message)", "UserWarning:", "huggingface_hub"];
                    let should_ignore = ignored_patterns
                        .iter()
                        .any(|pattern| line.contains(pattern));

                    if !line.is_empty() && !should_ignore {
                        let _ = app_handle_clone.emit("engine-error", line);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    println!("[RUST]: Engine process terminated: {:?}", payload);
                    terminated_normally = true;
                    {
                        let mut lock = child_arc_for_events.lock().await;
                        *lock = None;
                    }
                    let _ = app_handle_clone.emit("status-update", "stopped");
                    let _ = app_handle_clone.emit(
                        "engine-crashed",
                        "El motor de audio se detuvo inesperadamente",
                    );
                }
                _ => {}
            }
        }

        // If the channel closed without a Terminated event, the sidecar exited
        // unexpectedly (or the pipe broke). Clear the handle and notify the UI.
        if !terminated_normally {
            println!("[RUST]: Engine event loop ended unexpectedly");
            {
                let mut lock = child_arc_for_events.lock().await;
                *lock = None;
            }
            let _ = app_handle_clone.emit("status-update", "stopped");
            let _ = app_handle_clone.emit(
                "engine-crashed",
                "El motor de audio se cerró inesperadamente",
            );
        }
    });

    // Heartbeat watchdog: restart the engine if it stops responding.
    tauri::async_runtime::spawn(async move {
        let mut misses: u32 = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(HEARTBEAT_INTERVAL_SECS)).await;

            // If the sidecar is gone, try to respawn it once and then exit this
            // watchdog instance. The new spawn will create its own watchers, so
            // we must break here to avoid duplicate heartbeats.
            {
                let lock = heartbeat_arc.lock().await;
                if lock.is_none() {
                    drop(lock);
                    println!("[RUST] Heartbeat: sidecar missing, attempting respawn");
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    cleanup_orphaned_processes();
                    free_whisper_server_port();
                    match spawn_audio_engine(&heartbeat_app_handle, heartbeat_arc.clone()).await {
                        Ok(()) => {
                            println!("[RUST] Heartbeat: sidecar respawned successfully");
                            let _ = heartbeat_app_handle.emit("engine-restarted", ());
                        }
                        Err(error) => {
                            println!("[RUST] Heartbeat: respawn failed: {}", error);
                            let _ = heartbeat_app_handle.emit(
                                "engine-crashed",
                                format!("No se pudo reiniciar el motor: {}", error),
                            );
                        }
                    }
                    break;
                }
            }

            if write_engine_command_raw(&heartbeat_arc, "PING\n")
                .await
                .is_err()
            {
                misses += 1;
                println!(
                    "[RUST] Heartbeat write failed (miss {}/{})",
                    misses, HEARTBEAT_MAX_MISSES
                );
            } else {
                // Wait a short time for a pong response.
                match timeout(Duration::from_secs(HEARTBEAT_TIMEOUT_SECS), pong_rx.recv()).await {
                    Ok(Some(())) => misses = 0,
                    _ => {
                        misses += 1;
                        println!(
                            "[RUST] Heartbeat pong timeout (miss {}/{})",
                            misses, HEARTBEAT_MAX_MISSES
                        );
                    }
                }
            }

            if misses >= HEARTBEAT_MAX_MISSES {
                println!(
                    "[RUST] Heartbeat missed {} times. Restarting engine.",
                    misses
                );
                let _ = stop_audio_engine_raw(&heartbeat_arc).await;
                cleanup_orphaned_processes();
                free_whisper_server_port();
                // Give the OS a moment to release sockets / PIDs.
                tokio::time::sleep(Duration::from_millis(500)).await;

                match spawn_audio_engine(&heartbeat_app_handle, heartbeat_arc.clone()).await {
                    Ok(()) => {
                        println!("[RUST] Heartbeat: sidecar restarted successfully");
                        let _ = heartbeat_app_handle.emit("engine-restarted", ());
                    }
                    Err(error) => {
                        println!("[RUST] Heartbeat: restart failed: {}", error);
                        let _ = heartbeat_app_handle.emit(
                            "engine-crashed",
                            format!("No se pudo reiniciar el motor: {}", error),
                        );
                    }
                }
                // The new spawn owns the watchers now; terminate this one.
                break;
            }
        }
    });

    Ok(())
}

async fn stop_audio_engine_raw(
    child_arc: &Arc<TokioMutex<Option<CommandChild>>>,
) -> Result<(), String> {
    // Attempt graceful shutdown first via EXIT command
    let _ = write_engine_command_raw(child_arc, "EXIT\n").await;
    // Give the engine time to gracefully tear down
    tokio::time::sleep(Duration::from_millis(800)).await;

    let mut lock = child_arc.lock().await;
    if let Some(child) = lock.take() {
        let pid = child.pid();
        let _ = child.kill();
        // On Linux: also kill descendant processes (e.g. whisper-cli subprocess,
        // multiprocessing workers) so nothing is left orphaned.
        #[cfg(target_os = "linux")]
        kill_process_tree(pid);

        // Wait briefly for the process to actually die.
        for _ in 0..20 {
            if !is_process_alive(pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    Ok(())
}

pub async fn stop_audio_engine(state: &tauri::State<'_, AppState>) {
    stop_audio_engine_raw(&state.sidecar_child).await.ok();
}

pub async fn stop_audio_engine_arc(child_arc: Arc<TokioMutex<Option<CommandChild>>>) {
    stop_audio_engine_raw(&child_arc).await.ok();
}

fn is_process_alive(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {}", pid), "/NH"])
            .output();
        match output {
            Ok(out) => String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()),
            Err(_) => false,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // kill -0 signals existence without affecting the process.
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// Kills all descendant processes of `pid` on Linux to prevent orphans.
#[cfg(target_os = "linux")]
fn kill_process_tree(pid: u32) {
    // Kill children first, then the parent (belt-and-suspenders with child.kill() above)
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-P", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    // Also kill any whisper-server that may have been orphaned.
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-f", "whisper-server"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

async fn write_engine_command_raw(
    child_arc: &Arc<TokioMutex<Option<CommandChild>>>,
    command: &str,
) -> Result<(), String> {
    let mut lock = child_arc.lock().await;
    let Some(child) = lock.as_mut() else {
        return Err("Audio engine is not running".to_string());
    };

    // Wrap the synchronous write in a timeout so a blocked sidecar cannot hang the runtime.
    let write_result = timeout(Duration::from_secs(ENGINE_WRITE_TIMEOUT_SECS), async {
        child.write(command.as_bytes())
    })
    .await;

    match write_result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => {
            *lock = None;
            Err(error.to_string())
        }
        Err(_) => {
            *lock = None;
            Err("Timeout enviando comando al motor de audio".to_string())
        }
    }
}

pub async fn write_engine_command(
    state: &tauri::State<'_, AppState>,
    command: &str,
) -> Result<(), String> {
    write_engine_command_raw(&state.sidecar_child, command).await
}
