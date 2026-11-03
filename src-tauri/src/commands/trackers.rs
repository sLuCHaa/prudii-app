use crate::db::Database;
use crate::trackers::store::{self, StoredBody, TrackerRecord, TrackerReport, BODY_LIMIT_PER_ACCOUNT, DEFAULT_DAYS};
use chrono::{Duration, Utc};
use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use tauri::{Manager, State};

static FETCHING: AtomicBool = AtomicBool::new(false);
// Mails that failed or came back without HTML; asking again every time the check opens would only cost bandwidth.
static SKIP_THIS_SESSION: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

pub(crate) const MAX_DAYS: u32 = 365;
// Several failures in a row mean offline or a lapsed token; one failure is just that mail.
const GIVE_UP_AFTER: u32 = 3;

struct FetchClaim;

impl Drop for FetchClaim {
    fn drop(&mut self) {
        FETCHING.store(false, Ordering::SeqCst);
    }
}

fn cutoff(days: u32) -> String {
    store::stamp(Utc::now() - Duration::days(days.clamp(1, MAX_DAYS) as i64))
}

#[derive(Debug, Default)]
pub(crate) struct FetchOutcome {
    pub loaded: u32,
    pub skip_next_time: Vec<String>,
}

pub(crate) async fn fetch_each<F, Fut>(ids: &[String], mut fetch: F) -> FetchOutcome
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<bool, String>>,
{
    let mut outcome = FetchOutcome::default();
    let mut failures_in_a_row = 0;
    for id in ids {
        match fetch(id.clone()).await {
            Ok(true) => {
                outcome.loaded += 1;
                failures_in_a_row = 0;
            }
            Ok(false) => {
                outcome.skip_next_time.push(id.clone());
                failures_in_a_row = 0;
            }
            Err(e) => {
                log::warn!("tracker body fetch failed for one mail: {e}");
                outcome.skip_next_time.push(id.clone());
                failures_in_a_row += 1;
                if failures_in_a_row >= GIVE_UP_AFTER {
                    break;
                }
            }
        }
    }
    outcome
}

#[tauri::command(async)]
pub fn record_mail_trackers(db: State<'_, Database>, records: Vec<TrackerRecord>) -> Result<u32, String> {
    store::record_batch(&db.lock_db(), &records, Utc::now()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_unscanned_bodies(db: State<'_, Database>, limit: u32) -> Result<Vec<StoredBody>, String> {
    store::unscanned_bodies(&db.read_db(), &cutoff(DEFAULT_DAYS), limit.min(200)).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_tracker_report(db: State<'_, Database>, account_id: Option<String>, days: Option<u32>) -> Result<TrackerReport, String> {
    let days = days.unwrap_or(DEFAULT_DAYS).clamp(1, MAX_DAYS);
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
    let skip = SKIP_THIS_SESSION.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let plan: Vec<Vec<String>> = {
        let conn = db.read_db();
        let accounts: Vec<String> = conn
            .prepare("SELECT id FROM accounts WHERE provider IN ('google', 'microsoft') AND auth_type = 'oauth'")
            .and_then(|mut stmt| stmt.query_map([], |r| r.get(0))?.collect())
            .map_err(|e| e.to_string())?;
        accounts
            .iter()
            .map(|account| store::bulk_mails_missing_body(&conn, account, &cutoff, BODY_LIMIT_PER_ACCOUNT, &skip).unwrap_or_default())
            .collect()
    };
    let mut loaded = 0;
    for ids in plan {
        let db: &Database = &db;
        let outcome = fetch_each(&ids, |id| async move { crate::commands::mails::fetch_body_for_scan(db, &id).await }).await;
        loaded += outcome.loaded;
        SKIP_THIS_SESSION.lock().unwrap_or_else(|e| e.into_inner()).extend(outcome.skip_next_time);
    }
    Ok(loaded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn report_window_is_bounded() {
        assert_eq!(cutoff(u32::MAX), cutoff(MAX_DAYS));
        assert_eq!(cutoff(0), cutoff(1));
    }

    #[tokio::test]
    async fn gives_up_after_three_failures_in_a_row() {
        let ids: Vec<String> = (0..10).map(|i| format!("m{i}")).collect();
        let calls = Mutex::new(0);
        let outcome = fetch_each(&ids, |_| {
            *calls.lock().unwrap() += 1;
            async { Err::<bool, String>("offline".into()) }
        })
        .await;
        assert_eq!(*calls.lock().unwrap(), 3);
        assert_eq!(outcome.loaded, 0);
    }

    #[tokio::test]
    async fn one_bad_mail_does_not_stop_the_account() {
        let ids: Vec<String> = ["ok1", "gone", "ok2", "empty"].iter().map(|s| s.to_string()).collect();
        let outcome = fetch_each(&ids, |id| async move {
            match id.as_str() {
                "gone" => Err("404".to_string()),
                "empty" => Ok(false),
                _ => Ok(true),
            }
        })
        .await;
        assert_eq!(outcome.loaded, 2);
        assert_eq!(outcome.skip_next_time, vec!["gone".to_string(), "empty".to_string()]);
    }
}
