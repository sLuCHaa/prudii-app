use crate::db::Database;
use crate::pool::ImapPool;
use crate::trackers::store::{self, StoredBody, TrackerRecord, TrackerReport, BODY_LIMIT_PER_ACCOUNT, DEFAULT_DAYS};
use chrono::{Duration, Utc};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, State};

static FETCHING: AtomicBool = AtomicBool::new(false);

struct FetchClaim;

impl Drop for FetchClaim {
    fn drop(&mut self) {
        FETCHING.store(false, Ordering::SeqCst);
    }
}

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

/// IMAP bodies arrive through the search backfill after every sync; Gmail and Outlook load them only when opened.
#[tauri::command]
pub async fn fetch_bulk_bodies(app: tauri::AppHandle) -> Result<u32, String> {
    if FETCHING.swap(true, Ordering::SeqCst) {
        return Ok(0);
    }
    let _claim = FetchClaim;
    let db = app.state::<Database>();
    let cutoff = cutoff(DEFAULT_DAYS);
    let plan: Vec<Vec<String>> = {
        let conn = db.read_db();
        let accounts: Vec<String> = conn
            .prepare("SELECT id FROM accounts WHERE provider IN ('google', 'microsoft') AND auth_type = 'oauth'")
            .and_then(|mut stmt| stmt.query_map([], |r| r.get(0))?.collect())
            .map_err(|e| e.to_string())?;
        accounts
            .iter()
            .map(|account| store::bulk_mails_missing_body(&conn, account, &cutoff, BODY_LIMIT_PER_ACCOUNT).unwrap_or_default())
            .collect()
    };
    let mut loaded = 0;
    for ids in plan {
        for (i, id) in ids.iter().enumerate() {
            match crate::commands::mails::fetch_mail_body(app.state::<Database>(), app.state::<ImapPool>(), id.clone()).await {
                Ok(_) => loaded += 1,
                // A first failure usually means offline or a lapsed token; the rest of the account would fail the same way.
                Err(e) if i == 0 => {
                    log::warn!("tracker body fetch stopped for an account: {e}");
                    break;
                }
                Err(e) => log::warn!("tracker body fetch failed for one mail: {e}"),
            }
        }
    }
    Ok(loaded)
}
