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

/// Dock/taskbar badge with the unread count. None clears the badge.
/// macOS only — on other platforms Tauri returns Unsupported, which we swallow.
#[tauri::command]
pub fn set_dock_badge(app: tauri::AppHandle, count: Option<i64>) -> Result<(), String> {
    use tauri::Manager;
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
