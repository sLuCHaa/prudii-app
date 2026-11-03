use crate::db::Database;
use crate::trackers::store::{self, StoredBody, TrackerRecord, TrackerReport, DEFAULT_DAYS};
use chrono::{Duration, Utc};
use tauri::State;

fn cutoff(days: u32) -> String {
    store::stamp(Utc::now() - Duration::days(days as i64))
}

#[tauri::command(async)]
pub fn record_mail_trackers(db: State<'_, Database>, records: Vec<TrackerRecord>) -> Result<u32, String> {
    let conn = db.lock_db();
    let now = Utc::now();
    let mut counted = 0;
    for rec in &records {
        if store::record(&conn, rec, now).map_err(|e| e.to_string())? {
            counted += 1;
        }
    }
    Ok(counted)
}

#[tauri::command(async)]
pub fn list_unscanned_bodies(db: State<'_, Database>, limit: u32) -> Result<Vec<StoredBody>, String> {
    store::unscanned_bodies(&db.read_db(), &cutoff(DEFAULT_DAYS), limit.min(200)).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_tracker_report(db: State<'_, Database>, account_id: Option<String>, days: Option<u32>) -> Result<TrackerReport, String> {
    let days = days.unwrap_or(DEFAULT_DAYS);
    store::report(&db.read_db(), &cutoff(days), account_id.as_deref(), days).map_err(|e| e.to_string())
}
