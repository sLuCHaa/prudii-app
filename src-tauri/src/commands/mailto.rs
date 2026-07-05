use super::catch_panic;

#[cfg(windows)]
fn write_registry() -> Result<(), String> {
    use windows::Win32::System::Registry::*;
    use windows::core::{HSTRING, PCWSTR};

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Failed to get exe path: {}", e))?
        .to_string_lossy()
        .to_string();

    let command_value = format!("\"{}\" \"%1\"", exe_path);

    fn set_reg_value(key: HKEY, subkey: &str, name: Option<&str>, value: &str) -> Result<(), String> {
        let subkey_h = HSTRING::from(subkey);
        let mut hkey = HKEY::default();
        unsafe {
            let result = RegCreateKeyExW(
                key,
                &subkey_h,
                Some(0),
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                None,
                &mut hkey,
                None,
            );
            if result.is_err() {
                return Err(format!("Failed to create registry key '{}': {:?}", subkey, result));
            }

            let name_pcwstr = name.map(|n| HSTRING::from(n));
            let value_h = HSTRING::from(value);
            let value_bytes = std::slice::from_raw_parts(
                value_h.as_ptr() as *const u8,
                (value_h.len() + 1) * 2,
            );

            let lpvaluename = match &name_pcwstr {
                Some(h) => PCWSTR(h.as_ptr()),
                None => PCWSTR::null(),
            };

            let result = RegSetValueExW(
                hkey,
                lpvaluename,
                Some(0),
                REG_SZ,
                Some(value_bytes),
            );
            let _ = RegCloseKey(hkey);
            if result.is_err() {
                return Err(format!("Failed to set registry value in '{}': {:?}", subkey, result));
            }
        }
        Ok(())
    }

    set_reg_value(
        HKEY_CURRENT_USER,
        "Software\\Classes\\PrudiiMail.Url.mailto",
        None,
        "Prudii Mail URL",
    )?;
    set_reg_value(
        HKEY_CURRENT_USER,
        "Software\\Classes\\PrudiiMail.Url.mailto",
        Some("URL Protocol"),
        "",
    )?;
    set_reg_value(
        HKEY_CURRENT_USER,
        "Software\\Classes\\PrudiiMail.Url.mailto\\shell\\open\\command",
        None,
        &command_value,
    )?;

    set_reg_value(
        HKEY_CURRENT_USER,
        "Software\\Clients\\Mail\\Prudii Mail",
        None,
        "Prudii Mail",
    )?;
    set_reg_value(
        HKEY_CURRENT_USER,
        "Software\\Clients\\Mail\\Prudii Mail\\Capabilities",
        Some("ApplicationName"),
        "Prudii Mail",
    )?;
    set_reg_value(
        HKEY_CURRENT_USER,
        "Software\\Clients\\Mail\\Prudii Mail\\Capabilities",
        Some("ApplicationDescription"),
        "Privacy-first email client",
    )?;
    set_reg_value(
        HKEY_CURRENT_USER,
        "Software\\Clients\\Mail\\Prudii Mail\\Capabilities\\URLAssociations",
        Some("mailto"),
        "PrudiiMail.Url.mailto",
    )?;

    set_reg_value(
        HKEY_CURRENT_USER,
        "Software\\RegisteredApplications",
        Some("Prudii Mail"),
        "Software\\Clients\\Mail\\Prudii Mail\\Capabilities",
    )?;

    Ok(())
}

#[cfg(windows)]
fn delete_registry() -> Result<(), String> {
    use windows::Win32::System::Registry::*;
    use windows::core::HSTRING;

    fn delete_tree(key: HKEY, subkey: &str) {
        let subkey_h = HSTRING::from(subkey);
        unsafe {
            let _ = RegDeleteTreeW(key, &subkey_h);
        }
    }

    fn delete_value(key: HKEY, subkey: &str, value_name: &str) {
        let subkey_h = HSTRING::from(subkey);
        let value_h = HSTRING::from(value_name);
        unsafe {
            let mut hkey = HKEY::default();
            let result = RegOpenKeyExW(key, &subkey_h, Some(0), KEY_WRITE, &mut hkey);
            if result.is_ok() {
                let _ = RegDeleteValueW(hkey, &value_h);
                let _ = RegCloseKey(hkey);
            }
        }
    }

    delete_tree(HKEY_CURRENT_USER, "Software\\Classes\\PrudiiMail.Url.mailto");
    delete_tree(HKEY_CURRENT_USER, "Software\\Clients\\Mail\\Prudii Mail");
    delete_value(HKEY_CURRENT_USER, "Software\\RegisteredApplications", "Prudii Mail");

    Ok(())
}

#[cfg(windows)]
fn check_registry() -> bool {
    use windows::Win32::System::Registry::*;
    use windows::core::HSTRING;

    let subkey = HSTRING::from("Software\\Classes\\PrudiiMail.Url.mailto\\shell\\open\\command");
    unsafe {
        let mut hkey = HKEY::default();
        let result = RegOpenKeyExW(HKEY_CURRENT_USER, &subkey, Some(0), KEY_READ, &mut hkey);
        if result.is_ok() {
            let _ = RegCloseKey(hkey);
            true
        } else {
            false
        }
    }
}

#[cfg(target_os = "macos")]
fn register_macos_mailto() -> Result<(), String> {
    // Use LSSetDefaultHandlerForURLScheme via the `open` command workaround:
    // The proper way is calling CoreFoundation's LSSetDefaultHandlerForURLScheme,
    // but we can achieve the same via a helper command.
    // First, the app's Info.plist must declare CFBundleURLTypes with "mailto" scheme
    // (Tauri does this when deep-link plugin or protocol is configured).
    // As a runtime fallback, we use `open` to point the OS at our bundle.

    let exe = std::env::current_exe().map_err(|e| format!("Failed to get exe path: {}", e))?;
    // Navigate from .app/Contents/MacOS/binary → .app
    let app_bundle = exe
        .parent() // MacOS/
        .and_then(|p| p.parent()) // Contents/
        .and_then(|p| p.parent()) // .app/
        .ok_or_else(|| "Not running from an app bundle".to_string())?;

    let bundle_id = "com.prudii.mail";

    let lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
    let app_path = app_bundle.to_string_lossy();

    let _ = std::process::Command::new(lsregister)
        .args(["-f", &app_path])
        .output();

    // Set as default mailto handler using python3 + pyobjc (available on macOS)
    let py_script = format!(
        "import LaunchServices; LaunchServices.LSSetDefaultHandlerForURLScheme('mailto', '{}')",
        bundle_id
    );
    let result = std::process::Command::new("python3")
        .args(["-c", &py_script])
        .output();

    match result {
        Ok(output) if output.status.success() => Ok(()),
        _ => {
            // Fallback: open System Preferences to let user set manually
            let _ = std::process::Command::new("open")
                .args(["x-apple.systempreferences:com.apple.preference.general"])
                .spawn();
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
fn unregister_macos_mailto() -> Result<(), String> {
    // Reset mailto handler to Apple Mail (com.apple.mail)
    let py_script = "import LaunchServices; LaunchServices.LSSetDefaultHandlerForURLScheme('mailto', 'com.apple.mail')";
    let _ = std::process::Command::new("python3")
        .args(["-c", py_script])
        .output();
    Ok(())
}

#[cfg(target_os = "macos")]
fn check_macos_mailto() -> bool {
    let py_script = "import LaunchServices; h = LaunchServices.LSCopyDefaultHandlerForURLScheme('mailto'); print(h if h else '')";
    match std::process::Command::new("python3")
        .args(["-c", py_script])
        .output()
    {
        Ok(output) => {
            let handler = String::from_utf8_lossy(&output.stdout).trim().to_lowercase();
            handler.contains("com.prudii.mail")
        }
        Err(_) => false,
    }
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn register_linux_mailto() -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Failed to get exe path: {}", e))?
        .to_string_lossy()
        .to_string();

    let desktop_entry = format!(
        "[Desktop Entry]\n\
        Name=Prudii Mail\n\
        Comment=Privacy-first email client\n\
        Exec=\"{}\" %u\n\
        Icon=prudii-mail\n\
        Terminal=false\n\
        Type=Application\n\
        Categories=Network;Email;\n\
        MimeType=x-scheme-handler/mailto;\n\
        StartupWMClass=prudii-mail\n",
        exe
    );

    let desktop_dir = dirs_desktop_path();
    let _ = std::fs::create_dir_all(&desktop_dir);
    let desktop_file = desktop_dir.join("prudii-mail.desktop");
    std::fs::write(&desktop_file, desktop_entry)
        .map_err(|e| format!("Failed to write .desktop file: {}", e))?;

    let _ = std::process::Command::new("update-desktop-database")
        .arg(&desktop_dir)
        .output();

    let result = std::process::Command::new("xdg-settings")
        .args(["set", "default-url-scheme-handler", "mailto", "prudii-mail.desktop"])
        .output();

    match result {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // xdg-settings might fail but xdg-mime can work as fallback
            let _ = std::process::Command::new("xdg-mime")
                .args(["default", "prudii-mail.desktop", "x-scheme-handler/mailto"])
                .output();
            log::info!("[mailto] xdg-settings fallback to xdg-mime (stderr: {})", stderr);
            Ok(())
        }
        Err(e) => Err(format!("Failed to set mailto handler: {}", e)),
    }
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn unregister_linux_mailto() -> Result<(), String> {
    let desktop_file = dirs_desktop_path().join("prudii-mail.desktop");
    let _ = std::fs::remove_file(&desktop_file);

    let _ = std::process::Command::new("update-desktop-database")
        .arg(dirs_desktop_path())
        .output();

    Ok(())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn check_linux_mailto() -> bool {
    match std::process::Command::new("xdg-settings")
        .args(["get", "default-url-scheme-handler", "mailto"])
        .output()
    {
        Ok(output) => {
            let handler = String::from_utf8_lossy(&output.stdout).trim().to_lowercase();
            handler.contains("prudii")
        }
        Err(_) => false,
    }
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn dirs_desktop_path() -> std::path::PathBuf {
    if let Ok(data_home) = std::env::var("XDG_DATA_HOME") {
        std::path::PathBuf::from(data_home).join("applications")
    } else if let Ok(home) = std::env::var("HOME") {
        std::path::PathBuf::from(home).join(".local/share/applications")
    } else {
        std::path::PathBuf::from("/tmp/prudii-desktop")
    }
}

#[tauri::command]
pub fn register_mailto_handler() -> Result<(), String> {
    catch_panic(|| {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            write_registry()?;
            // Open Windows default apps settings so user can select Prudii
            let _ = std::process::Command::new("cmd")
                .args(["/C", "start", "ms-settings:defaultapps"])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .spawn();
            Ok(())
        }
        #[cfg(target_os = "macos")]
        {
            register_macos_mailto()
        }
        #[cfg(all(not(windows), not(target_os = "macos")))]
        {
            register_linux_mailto()
        }
    })
}

#[tauri::command]
pub fn unregister_mailto_handler() -> Result<(), String> {
    catch_panic(|| {
        #[cfg(windows)]
        {
            delete_registry()
        }
        #[cfg(target_os = "macos")]
        {
            unregister_macos_mailto()
        }
        #[cfg(all(not(windows), not(target_os = "macos")))]
        {
            unregister_linux_mailto()
        }
    })
}

#[tauri::command]
pub fn is_mailto_handler() -> Result<bool, String> {
    catch_panic(|| {
        #[cfg(windows)]
        {
            Ok(check_registry())
        }
        #[cfg(target_os = "macos")]
        {
            Ok(check_macos_mailto())
        }
        #[cfg(all(not(windows), not(target_os = "macos")))]
        {
            Ok(check_linux_mailto())
        }
    })
}
