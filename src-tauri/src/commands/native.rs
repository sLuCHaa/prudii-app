/// Report the maximize button's client rect (logical px) so the Windows
/// subclass can answer WM_NCHITTEST with HTMAXBUTTON — that is what makes
/// Windows 11 show the Snap Layouts flyout. Deliberately a SYNC command: it
/// must run on the window's thread (SetWindowSubclass requirement), and sync
/// commands execute inside the WebView callback on exactly that thread.
#[tauri::command]
pub fn set_caption_max_rect(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        crate::win_caption::set_max_button_rect(&app, window.label(), hwnd, x, y, w, h);
    }
    #[cfg(not(windows))]
    {
        let _ = (app, window, x, y, w, h);
    }
    Ok(())
}

/// Open the native window menu at logical client coordinates (right-click on
/// the custom title bar). SYNC on purpose — TrackPopupMenu needs the window's
/// thread and blocks until the menu closes.
#[tauri::command]
pub fn show_system_menu(window: tauri::WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        crate::win_caption::show_system_menu(hwnd, x, y);
    }
    #[cfg(not(windows))]
    {
        let _ = (window, x, y);
    }
    Ok(())
}

/// Parse a `#rrggbb` hex colour into its RGB bytes; anything else (missing
/// `#`, wrong length, short forms like `#fff`) is rejected rather than guessed at.
fn parse_hex_rgb(s: &str) -> Option<[u8; 3]> {
    let hex = s.strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
    Some([r, g, b])
}

/// Dock/taskbar badge with the unread count. None clears the badge.
/// Tauri's own badge is macOS only — on other platforms it returns Unsupported,
/// which we swallow; Windows gets a drawn taskbar overlay icon instead. SYNC on
/// purpose: the Windows overlay path needs the window's thread, which is where
/// sync commands run.
#[tauri::command]
pub fn set_dock_badge(app: tauri::AppHandle, count: Option<i64>, accent: Option<String>) -> Result<(), String> {
    use tauri::Manager;

    #[cfg(windows)]
    {
        let rgb = accent.as_deref().and_then(parse_hex_rgb).unwrap_or([0x3b, 0x82, 0xf6]);
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(hwnd) = window.hwnd() {
                crate::win_badge::set_taskbar_badge(hwnd.0 as isize, count.filter(|n| *n > 0), rgb);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = &accent;
    }

    if let Some(tray) = app.tray_by_id("main") {
        let tooltip = match count.filter(|n| *n > 0) {
            Some(n) => format!("Prudii Mail ({n})"),
            None => "Prudii Mail".to_string(),
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }

    if let Some(window) = app.get_webview_window("main") {
        let badge = match count {
            Some(n) if n > 0 => Some(n),
            _ => None,
        };
        if let Err(e) = window.set_badge_count(badge) {
            log::debug!("set_badge_count unsupported/failed: {}", e);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_hex_rgb;
    #[test]
    fn parses_rrggbb() {
        assert_eq!(parse_hex_rgb("#3b82f6"), Some([0x3b, 0x82, 0xf6]));
        assert_eq!(parse_hex_rgb("#3B82F6"), Some([0x3b, 0x82, 0xf6]));
        assert_eq!(parse_hex_rgb("3b82f6"), None);
        assert_eq!(parse_hex_rgb("#fff"), None);
    }
}
