use crate::db::Database;
use tauri::AppHandle;

#[cfg(windows)]
pub fn send_new_mail_notification(app: &AppHandle, account_id: &str, new_mails: u32, db: &Database) {
    use tauri::{Emitter, Manager};
    use tauri_winrt_notification::{Sound, Toast};

    let (enabled, sound) = {
        let conn = db.lock_db();
        let enabled = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'notifications_enabled'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|v| v == "true" || v == "1")
            .unwrap_or(true);
        let sound = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'notification_sound'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|v| v == "true" || v == "1")
            .unwrap_or(true);
        (enabled, sound)
    };

    if !enabled {
        return;
    }

    // Query the most recently synced unread inbox mail (highest ROWID = just inserted)
    let mail_info: Option<(String, String, String, String)> = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT m.id, COALESCE(m.subject, ''), COALESCE(m.from_name, m.from_email), m.folder_id \
             FROM mails m JOIN folders f ON m.folder_id = f.id \
             WHERE m.account_id = ?1 AND f.folder_type = 'inbox' AND m.is_read = 0 \
             ORDER BY m.ROWID DESC LIMIT 1",
            rusqlite::params![account_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok()
    };

    let (mail_id, subject, from_name, folder_id) = match mail_info {
        Some(info) => info,
        None => return, // No unread inbox mail to show
    };

    let mut toast = Toast::new("com.prudii.mail")
        .title(&from_name)
        .text1(&subject);

    if new_mails > 1 {
        toast = toast.text2(&format!("+ {} more", new_mails - 1));
    }

    toast = if sound {
        toast.sound(Some(Sound::Default))
    } else {
        toast.sound(None)
    };

    // on_activated: show window + emit event so frontend navigates to the mail
    let app_clone = app.clone();
    let aid = account_id.to_string();
    let mid = mail_id.clone();
    let fid = folder_id.clone();
    toast = toast.on_activated(move |_| {
        if let Some(window) = app_clone.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        let _ = app_clone.emit(
            "notification-clicked",
            serde_json::json!({
                "account_id": aid,
                "mail_id": mid,
                "folder_id": fid,
            }),
        );
        Ok(())
    });

    if let Err(e) = toast.show() {
        log::warn!("Failed to show notification: {:?}", e);
    }
}

#[cfg(not(windows))]
pub fn send_new_mail_notification(
    _app: &AppHandle,
    _account_id: &str,
    _new_mails: u32,
    _db: &Database,
) {
    // Non-Windows: no-op (tauri-plugin-notification handles other platforms)
}
