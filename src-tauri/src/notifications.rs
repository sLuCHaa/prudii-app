use crate::db::Database;
use tauri::AppHandle;

#[cfg_attr(not(windows), allow(dead_code))]
struct NewMailToast {
    mail_id: String,
    folder_id: String,
    title: String,
    subject: String,
    sound: bool,
}

// Settings plus the freshest unread inbox mail (highest ROWID = just inserted).
// None when notifications are off or nothing unread exists to point at.
fn build_new_mail_toast(account_id: &str, db: &Database) -> Option<NewMailToast> {
    let conn = db.lock_db();
    let flag = |key: &str| -> bool {
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .map(|v| v == "true" || v == "1")
        .unwrap_or(true)
    };
    if !flag("notifications_enabled") {
        return None;
    }
    let sound = flag("notification_sound");

    let (mail_id, subject, title, folder_id): (String, String, String, String) = conn
        .query_row(
            "SELECT m.id, COALESCE(m.subject, ''), COALESCE(m.from_name, m.from_email), m.folder_id \
             FROM mails m JOIN folders f ON m.folder_id = f.id \
             WHERE m.account_id = ?1 AND f.folder_type = 'inbox' AND m.is_read = 0 \
             ORDER BY m.ROWID DESC LIMIT 1",
            rusqlite::params![account_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok()?;

    Some(NewMailToast { mail_id, folder_id, title, subject, sound })
}

#[cfg(windows)]
pub fn send_new_mail_notification(app: &AppHandle, account_id: &str, new_mails: u32, db: &Database) {
    use tauri::{Emitter, Manager};
    use tauri_winrt_notification::{Sound, Toast};

    let Some(t) = build_new_mail_toast(account_id, db) else { return };

    let mut toast = Toast::new("com.prudii.mail").title(&t.title).text1(&t.subject);
    if new_mails > 1 {
        toast = toast.text2(&format!("+ {} more", new_mails - 1));
    }
    toast = if t.sound { toast.sound(Some(Sound::Default)) } else { toast.sound(None) };

    let app_clone = app.clone();
    let aid = account_id.to_string();
    let NewMailToast { mail_id, folder_id, .. } = t;
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
                "mail_id": mail_id,
                "folder_id": folder_id,
            }),
        );
        Ok(())
    });

    if let Err(e) = toast.show() {
        log::warn!("Failed to show notification: {:?}", e);
    }
}

#[cfg(not(windows))]
pub fn send_new_mail_notification(app: &AppHandle, account_id: &str, new_mails: u32, db: &Database) {
    use tauri_plugin_notification::NotificationExt;

    let Some(t) = build_new_mail_toast(account_id, db) else { return };

    let body = if new_mails > 1 {
        format!("{}\n+ {} more", t.subject, new_mails - 1)
    } else {
        t.subject.clone()
    };

    // The desktop notification plugin offers no click callback here: the OS
    // brings the app forward, but the mail cannot be selected from the banner.
    let mut builder = app.notification().builder().title(&t.title).body(body);
    if t.sound {
        builder = builder.sound("default");
    }
    if let Err(e) = builder.show() {
        log::warn!("Failed to show notification: {:?}", e);
    }
}
