use crate::db::Database;
use crate::models::Task;
use tauri::AppHandle;

// Re-read on every call: notifications fire from background loops, not menu
// setup, so the tray's already-resolved language isn't in scope here.
fn read_language(db: &Database) -> String {
    let conn = db.lock_db();
    conn.query_row("SELECT value FROM app_settings WHERE key = 'language'", [], |row| row.get::<_, String>(0))
        .unwrap_or_else(|_| "en".to_string())
}

// Same on/off switch `build_new_mail_toast` checks — task reminders must not
// pop up when the user has notifications disabled either.
fn notifications_enabled(db: &Database) -> bool {
    let conn = db.lock_db();
    conn.query_row("SELECT value FROM app_settings WHERE key = 'notifications_enabled'", [], |row| row.get::<_, String>(0))
        .map(|v| v == "true" || v == "1")
        .unwrap_or(true)
}

// `due_at` is stored as UTC RFC3339; a reminder should show the time the user
// set it in, not UTC.
fn format_due_time(due_at: Option<&str>) -> Option<String> {
    due_at
        .and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok())
        .map(|dt| dt.with_timezone(&chrono::Local).format("%H:%M").to_string())
}

fn task_reminder_body(task: &Task) -> String {
    match format_due_time(task.due_at.as_deref()) {
        Some(time) => format!("{} · {}", task.title, time),
        None => task.title.clone(),
    }
}

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
    let labels = crate::menu_labels::for_lang(&read_language(db));

    let mut toast = Toast::new("com.prudii.mail").title(&t.title).text1(&t.subject);
    if new_mails > 1 {
        toast = toast.text2(&format!("+ {} more", new_mails - 1));
    }
    toast = if t.sound { toast.sound(Some(Sound::Default)) } else { toast.sound(None) };
    toast = toast
        .add_button(labels.archive, &format!("archive:{}", t.mail_id))
        .add_button(labels.mark_read, &format!("read:{}", t.mail_id));

    let app_clone = app.clone();
    let aid = account_id.to_string();
    let NewMailToast { mail_id, folder_id, .. } = t;
    toast = toast.on_activated(move |action| {
        match action.as_deref() {
            Some(a) if a.starts_with("archive:") || a.starts_with("read:") => {
                let (kind, id) = a.split_once(':').unwrap_or(("", ""));
                let (kind, id) = (kind.to_string(), id.to_string());
                let app = app_clone.clone();
                let aid = aid.clone();
                tauri::async_runtime::spawn(async move {
                    let result = if kind == "archive" {
                        crate::commands::mails::archive_mail(app.clone(), app.state(), id).await
                    } else {
                        crate::commands::mails::mark_as_read(app.state(), app.state(), id).await
                    };
                    if let Err(e) = result { log::warn!("toast action {kind} failed: {e}"); }
                    // Rust-side changes bypass the frontend's optimistic updates.
                    let _ = app.emit("mails-changed", serde_json::json!({ "account_id": aid }));
                });
            }
            _ => {
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
            }
        }
        Ok(())
    });

    if let Err(e) = toast.show() {
        log::warn!("Failed to show notification: {:?}", e);
    }
}

#[cfg(windows)]
pub fn send_task_reminder(app: &AppHandle, task: &Task) {
    use tauri::{Emitter, Manager};
    use tauri_winrt_notification::Toast;

    let db = app.state::<Database>();
    if !notifications_enabled(&db) {
        return;
    }
    let labels = crate::menu_labels::for_lang(&read_language(&db));

    let mut toast = Toast::new("com.prudii.mail").title(labels.task_due).text1(&task_reminder_body(task));
    toast = toast.add_button(labels.task_mark_done, &format!("task-done:{}", task.id));

    let app_clone = app.clone();
    let task_id = task.id.clone();
    toast = toast.on_activated(move |action| {
        match action.as_deref() {
            Some(a) if a.starts_with("task-done:") => {
                let id = a.trim_start_matches("task-done:").to_string();
                let db = app_clone.state::<Database>();
                let patch = crate::models::UpdateTaskPatch {
                    title: None,
                    description_html: None,
                    status: Some("done".into()),
                    priority: None,
                    due_at: None,
                    clear_due_at: None,
                };
                match crate::commands::tasks::update_task_impl(&db, &id, patch) {
                    Ok(_) => { let _ = app_clone.emit("tasks-changed", ()); }
                    Err(e) => log::warn!("failed to mark task {id} done from toast: {e}"),
                }
            }
            _ => {
                if let Some(window) = app_clone.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                let _ = app_clone.emit("task-open", serde_json::json!({ "task_id": task_id }));
            }
        }
        Ok(())
    });

    if let Err(e) = toast.show() {
        log::warn!("Failed to show task reminder notification: {:?}", e);
    }
}

#[cfg(not(windows))]
pub fn send_task_reminder(app: &AppHandle, task: &Task) {
    use tauri::Manager;
    use tauri_plugin_notification::NotificationExt;

    let db = app.state::<Database>();
    if !notifications_enabled(&db) {
        return;
    }
    let labels = crate::menu_labels::for_lang(&read_language(&db));

    // No click/button callback on this platform's plugin — same limitation as
    // the new-mail notification above.
    if let Err(e) = app.notification().builder().title(labels.task_due).body(task_reminder_body(task)).show() {
        log::warn!("Failed to show task reminder notification: {:?}", e);
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
        // freedesktop sound theme id; macOS understands "default"
        #[cfg(target_os = "linux")]
        let name = "message-new-email";
        #[cfg(not(target_os = "linux"))]
        let name = "default";
        builder = builder.sound(name);
    }
    if let Err(e) = builder.show() {
        log::warn!("Failed to show notification: {:?}", e);
    }
}
