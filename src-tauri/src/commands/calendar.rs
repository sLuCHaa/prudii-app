use crate::calendar::store::{
    count_today_impl, create_calendar_impl, create_event_impl, delete_calendar_impl, delete_event_impl, export_ics_impl,
    get_calendar_settings_impl, get_event_impl, import_ics_impl, list_calendars_impl, list_occurrences_impl,
    move_occurrence_impl, search_events_impl, update_calendar_impl, update_calendar_settings_impl, update_event_impl,
};
use crate::calendar::{
    Calendar, CalendarPatch, CalendarSettings, EventDetail, EventInput, EventPatch, EventTimes, ImportResult, Occurrence, Scope,
};
use crate::calendar::subscription::{self, feed_client, normalize_feed_url, KeyringLinks, LinkStore};
use crate::calendar::bundle::{import_sources_impl, sources_from_path};
use crate::calendar::{BundleImportResult, SubscribeResult};
use crate::calendar::invite_store::{add_published_impl, invitation_view_impl, remove_cancelled_impl, respond_impl};
use crate::calendar::InvitationView;
use crate::smtp::{CalendarPart, EmailMessage};
use crate::db::Database;
use tauri::{AppHandle, Emitter, State};

// A multi-year export is a few MB; anything far beyond is not a calendar file.
const MAX_ICS_BYTES: u64 = 20 * 1024 * 1024;

fn changed(app: &AppHandle) {
    let _ = app.emit("calendar-changed", ());
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() { "calendar".into() } else { trimmed.to_string() }
}

#[tauri::command(async)]
pub fn list_calendars(db: State<'_, Database>, default_name: String) -> Result<Vec<Calendar>, String> {
    super::catch_panic(|| list_calendars_impl(&db, &default_name))
}

#[tauri::command(async)]
pub fn create_calendar(app: AppHandle, db: State<'_, Database>, name: String, color: String) -> Result<Calendar, String> {
    super::catch_panic(|| {
        let calendar = create_calendar_impl(&db, &name, &color)?;
        changed(&app);
        Ok(calendar)
    })
}

#[tauri::command(async)]
pub fn update_calendar(app: AppHandle, db: State<'_, Database>, id: String, patch: CalendarPatch) -> Result<Calendar, String> {
    super::catch_panic(|| {
        let calendar = update_calendar_impl(&db, &id, patch)?;
        changed(&app);
        Ok(calendar)
    })
}

#[tauri::command(async)]
pub fn delete_calendar(app: AppHandle, db: State<'_, Database>, id: String) -> Result<(), String> {
    super::catch_panic(|| {
        let deleted = delete_calendar_impl(&db, &id)?;
        if deleted.read_only {
            KeyringLinks.delete(&id);
        }
        changed(&app);
        Ok(())
    })
}

#[tauri::command(async)]
pub fn list_occurrences(db: State<'_, Database>, from: String, to: String, calendar_ids: Option<Vec<String>>) -> Result<Vec<Occurrence>, String> {
    super::catch_panic(|| list_occurrences_impl(&db, &from, &to, calendar_ids))
}

#[tauri::command(async)]
pub fn get_event(db: State<'_, Database>, id: String) -> Result<EventDetail, String> {
    super::catch_panic(|| get_event_impl(&db, &id))
}

#[tauri::command(async)]
pub fn create_event(app: AppHandle, db: State<'_, Database>, input: EventInput) -> Result<EventDetail, String> {
    super::catch_panic(|| {
        let detail = create_event_impl(&db, input)?;
        changed(&app);
        Ok(detail)
    })
}

#[tauri::command(async)]
pub fn update_event(
    app: AppHandle,
    db: State<'_, Database>,
    id: String,
    occurrence_key: Option<String>,
    scope: Scope,
    patch: EventPatch,
) -> Result<EventDetail, String> {
    super::catch_panic(|| {
        let detail = update_event_impl(&db, &id, occurrence_key, scope, patch)?;
        changed(&app);
        Ok(detail)
    })
}

#[tauri::command(async)]
pub fn delete_event(app: AppHandle, db: State<'_, Database>, id: String, occurrence_key: Option<String>, scope: Scope) -> Result<(), String> {
    super::catch_panic(|| {
        delete_event_impl(&db, &id, occurrence_key, scope)?;
        changed(&app);
        Ok(())
    })
}

#[tauri::command(async)]
pub fn move_occurrence(
    app: AppHandle,
    db: State<'_, Database>,
    id: String,
    occurrence_key: Option<String>,
    times: EventTimes,
    scope: Scope,
) -> Result<EventDetail, String> {
    super::catch_panic(|| {
        let detail = move_occurrence_impl(&db, &id, occurrence_key, times, scope)?;
        changed(&app);
        Ok(detail)
    })
}

#[tauri::command(async)]
pub fn search_events(db: State<'_, Database>, query: String, from: String) -> Result<Vec<Occurrence>, String> {
    super::catch_panic(|| search_events_impl(&db, &query, &from))
}

#[tauri::command(async)]
pub fn count_today_occurrences(db: State<'_, Database>) -> Result<i64, String> {
    super::catch_panic(|| count_today_impl(&db))
}

#[tauri::command(async)]
pub fn get_calendar_settings(db: State<'_, Database>) -> Result<CalendarSettings, String> {
    super::catch_panic(|| Ok(get_calendar_settings_impl(&db)))
}

#[tauri::command(async)]
pub fn update_calendar_settings(app: AppHandle, db: State<'_, Database>, settings: CalendarSettings) -> Result<(), String> {
    super::catch_panic(|| {
        update_calendar_settings_impl(&db, &settings)?;
        changed(&app);
        Ok(())
    })
}

#[tauri::command(async)]
pub fn import_ics(app: AppHandle, db: State<'_, Database>, calendar_id: String) -> Result<Option<ImportResult>, String> {
    use tauri_plugin_dialog::DialogExt;
    super::catch_panic(|| {
        let (tx, rx) = std::sync::mpsc::channel();
        app.dialog()
            .file()
            .add_filter("iCalendar", &["ics", "ical", "icalendar"])
            .pick_file(move |picked| {
                let _ = tx.send(picked);
            });
        let Some(picked) = rx.recv().map_err(|e| format!("Dialog error: {}", e))? else {
            return Ok(None);
        };
        let path = picked.as_path().ok_or("Invalid path")?.to_path_buf();
        if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_ICS_BYTES {
            return Err("calendar.errors.fileTooLarge".into());
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let result = import_ics_impl(&db, &calendar_id, &String::from_utf8_lossy(&bytes))?;
        changed(&app);
        Ok(Some(result))
    })
}

#[tauri::command(async)]
pub fn import_calendar_files(app: AppHandle, db: State<'_, Database>, untitled_name: String) -> Result<Option<BundleImportResult>, String> {
    use tauri_plugin_dialog::DialogExt;
    super::catch_panic(|| {
        let (tx, rx) = std::sync::mpsc::channel();
        app.dialog()
            .file()
            .add_filter("iCalendar", &["ics", "ical", "icalendar", "zip"])
            .pick_files(move |picked| {
                let _ = tx.send(picked);
            });
        let Some(picked) = rx.recv().map_err(|e| format!("Dialog error: {}", e))? else {
            return Ok(None);
        };
        let (mut sources, mut failed) = (Vec::new(), Vec::new());
        for file in picked {
            if let Some(path) = file.as_path() {
                let (s, f) = sources_from_path(path);
                sources.extend(s);
                failed.extend(f);
            }
        }
        let mut result = import_sources_impl(&db, sources, &untitled_name);
        failed.append(&mut result.failed);
        result.failed = failed;
        if !result.calendars.is_empty() {
            changed(&app);
        }
        Ok(Some(result))
    })
}

#[tauri::command(async)]
pub fn export_ics(app: AppHandle, db: State<'_, Database>, calendar_id: String) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    super::catch_panic(|| {
        let (name, ics) = export_ics_impl(&db, &calendar_id)?;
        let (tx, rx) = std::sync::mpsc::channel();
        app.dialog()
            .file()
            .set_file_name(format!("{}.ics", sanitize_file_name(&name)))
            .add_filter("iCalendar", &["ics"])
            .save_file(move |target| {
                let _ = tx.send(target);
            });
        let Some(target) = rx.recv().map_err(|e| format!("Dialog error: {}", e))? else {
            return Ok(false);
        };
        let path = target.as_path().ok_or("Invalid path")?.to_path_buf();
        std::fs::write(&path, ics).map_err(|e| e.to_string())?;
        Ok(true)
    })
}

#[tauri::command]
pub async fn subscribe_calendar(
    app: AppHandle,
    db: State<'_, Database>,
    url: String,
    color: String,
    refresh_minutes: i64,
) -> Result<SubscribeResult, String> {
    let url = normalize_feed_url(&url)?;
    let result = subscription::subscribe_impl(&db, &KeyringLinks, feed_client(), &url, &color, refresh_minutes).await?;
    changed(&app);
    Ok(result)
}

#[tauri::command]
pub async fn refresh_subscription(app: AppHandle, db: State<'_, Database>, id: String) -> Result<Calendar, String> {
    let result = subscription::refresh_impl(&db, &KeyringLinks, feed_client(), &id).await;
    // The status changed even when the fetch failed.
    changed(&app);
    result
}

#[tauri::command(async)]
pub fn get_subscription_url(db: State<'_, Database>, id: String) -> Result<String, String> {
    super::catch_panic(|| {
        subscription::ensure_subscription(&db, &id)?;
        KeyringLinks.get(&id).map_err(|_| "calendar.errors.linkMissing".to_string())
    })
}

#[tauri::command]
pub async fn update_subscription_url(app: AppHandle, db: State<'_, Database>, id: String, url: String) -> Result<Calendar, String> {
    let url = normalize_feed_url(&url)?;
    let result = subscription::update_url_impl(&db, &KeyringLinks, feed_client(), &id, &url).await?;
    changed(&app);
    Ok(result)
}

#[tauri::command(async)]
pub fn get_mail_invitation(db: State<'_, Database>, mail_id: String) -> Result<Option<InvitationView>, String> {
    super::catch_panic(|| invitation_view_impl(&db, &mail_id, chrono::Utc::now()))
}

/// The answer is saved before sending; a failed send leaves it saved and says so.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn respond_invitation(
    app: AppHandle,
    db: State<'_, Database>,
    mail_id: String,
    partstat: String,
    calendar_id: String,
    send_reply: bool,
    comment: Option<String>,
    reply_subject: String,
    reply_body: String,
) -> Result<(), String> {
    let draft = respond_impl(&db, &mail_id, &partstat, &calendar_id, comment.as_deref(), send_reply, chrono::Utc::now())?;
    changed(&app);
    let Some(draft) = draft else { return Ok(()) };
    let message = EmailMessage {
        to: vec![draft.to],
        cc: vec![],
        bcc: vec![],
        subject: reply_subject,
        body_text: reply_body,
        body_html: None,
        in_reply_to: None,
        references: None,
        attachments: vec![],
        calendar_part: Some(CalendarPart { method: "REPLY".into(), ics: draft.ics }),
    };
    crate::commands::send::send_calendar_mail(&app, &draft.account_id, message).await.map_err(|e| {
        log::warn!("invitation reply for {} not sent: {}", mail_id, e);
        "calendar.invite.errors.sendFailed".to_string()
    })
}

#[tauri::command(async)]
pub fn add_published_event(app: AppHandle, db: State<'_, Database>, mail_id: String, calendar_id: String) -> Result<ImportResult, String> {
    super::catch_panic(|| {
        let result = add_published_impl(&db, &mail_id, &calendar_id)?;
        changed(&app);
        Ok(result)
    })
}

#[tauri::command(async)]
pub fn remove_cancelled_event(app: AppHandle, db: State<'_, Database>, mail_id: String) -> Result<(), String> {
    super::catch_panic(|| {
        remove_cancelled_impl(&db, &mail_id)?;
        changed(&app);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_file_names_are_safe_on_every_platform() {
        assert_eq!(sanitize_file_name("Work: Q4/Plans?"), "Work_ Q4_Plans_");
        assert_eq!(sanitize_file_name("  ..  "), "calendar");
        assert_eq!(sanitize_file_name("Family"), "Family");
    }
}
