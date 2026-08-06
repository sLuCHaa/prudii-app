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
