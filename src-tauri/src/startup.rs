#[cfg(windows)]
use winreg::enums::HKEY_CURRENT_USER;
#[cfg(windows)]
use winreg::RegKey;

#[cfg(windows)]
pub fn set_startup_enabled(enabled: bool) -> Result<(), String> {
    let executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => return Err(error.to_string()),
    };

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    // Use raw string literal for registry path to avoid escape issues
    let (run_key, _) = hkcu
        .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .map_err(|error| error.to_string())?;

    if enabled {
        // Correctly escape quotes for the command string
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
pub fn get_startup_enabled() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    // Use raw string literal here too
    let run_key = match hkcu.open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run") {
        Ok(key) => key,
        Err(_) => return false,
    };

    run_key.get_value::<String, _>("Veloce").is_ok()
}

#[cfg(not(windows))]
pub fn set_startup_enabled(_enabled: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub fn get_startup_enabled() -> bool {
    false
}
