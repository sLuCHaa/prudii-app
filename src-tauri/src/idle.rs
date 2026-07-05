use crate::cleanup_guard::SetGuard;
use crate::db::Database;
use crate::imap;
use crate::imap::client::IdleEvent;
use crate::models::{Folder, SyncProgress};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Track which accounts have a running IDLE task
pub static IDLE_ACCOUNTS: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

/// Start an IDLE watcher for an account's INBOX.
/// Creates a dedicated IMAP connection that sits in IDLE mode and triggers
/// quick incremental syncs when new mail arrives.
/// Only one IDLE task per account — duplicates are silently ignored.
///
/// The watcher is registered with `task_registry` so it can be cancelled
/// when the account is deleted (see `delete_account`). The `IDLE_ACCOUNTS`
/// membership is released via `SetGuard` on every exit path including
/// cancellation, preventing a stale entry from blocking re-creation of the
/// watcher if the same account_id is re-used.
pub fn start_idle(
    app: AppHandle,
    account_id: String,
    imap_host: String,
    imap_port: u16,
    email: String,
    credential: String,
    auth_type: String,
) {
    // Check-and-claim atomically. If another IDLE is already running we
    // bail out without constructing a guard (no claim made).
    {
        let mut idle = IDLE_ACCOUNTS.lock().unwrap_or_else(|e| e.into_inner());
        if idle.contains(&account_id) {
            log::info!("IDLE: Already running for account {}", account_id);
            return;
        }
        idle.insert(account_id.clone());
    }

    log::info!("IDLE: Spawning watcher for account {}", account_id);

    // Construct the guard outside the future so even if the future is
    // dropped before its first poll (e.g. immediate abort) the IDLE_ACCOUNTS
    // entry is still released.
    let idle_guard = SetGuard::new(&IDLE_ACCOUNTS, account_id.clone());
    let aid_for_registry = account_id.clone();
    crate::task_registry::spawn_for_account(&aid_for_registry, async move {
        let _idle_guard = idle_guard;
        idle_loop(&app, &account_id, &imap_host, imap_port, &email, &credential, &auth_type).await;
    });
}

async fn idle_loop(
    app: &AppHandle,
    account_id: &str,
    imap_host: &str,
    imap_port: u16,
    email: &str,
    credential: &str,
    auth_type: &str,
) {
    let mut retry_count = 0u32;

    loop {
        // Connect (dedicated connection, separate from pool)
        let session = match imap::connect_with_auth(imap_host, imap_port, email, auth_type, credential).await {
            Ok(s) => {
                retry_count = 0;
                s
            }
            Err(e) => {
                log::warn!("IDLE: Connect failed for {}: {}", account_id, e);
                let delay = std::cmp::min(30 * (retry_count + 1), 300); // max 5min backoff
                retry_count += 1;
                tokio::time::sleep(std::time::Duration::from_secs(delay as u64)).await;
                continue;
            }
        };

        match run_idle_session(app, account_id, session).await {
            Ok(()) => {
                log::info!("IDLE: Session ended cleanly for {}", account_id);
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            Err(e) => {
                log::warn!("IDLE: Session error for {}: {}", account_id, e);
                let delay = std::cmp::min(30 * (retry_count + 1), 300);
                retry_count += 1;
                tokio::time::sleep(std::time::Duration::from_secs(delay as u64)).await;
            }
        }
    }
}

async fn run_idle_session(
    app: &AppHandle,
    account_id: &str,
    mut session: imap::ImapSession,
) -> anyhow::Result<()> {
    use anyhow::Context;

    let db = app.state::<Database>();
    let inbox_info: Option<(String, String)> = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT id, path FROM folders WHERE account_id = ?1 AND folder_type = 'inbox'",
            rusqlite::params![account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()
    };

    let (inbox_id, inbox_path) = inbox_info
        .ok_or_else(|| anyhow::anyhow!("No INBOX folder found for {}", account_id))?;

    session
        .select(&inbox_path)
        .await
        .context("Failed to select INBOX for IDLE")?;

    log::info!("IDLE: Entering IDLE on '{}' for account {}", inbox_path, account_id);

    loop {
        // Enter IDLE mode — our client handles init/wait/done in one call
        let event = session
            .idle(std::time::Duration::from_secs(25 * 60)) // 25 min (< 29 min RFC limit)
            .await
            .context("IDLE failed")?;

        match event {
            IdleEvent::NewData => {
                // Atomic check-and-claim: if another sync (full or quick) holds the
                // slot, skip; otherwise claim it. The MutexGuard is dropped before
                // any await so the future stays Send.
                let claimed = {
                    let mut syncing = crate::commands::sync::SYNCING_ACCOUNTS.lock().unwrap_or_else(|e| e.into_inner());
                    if syncing.contains(account_id) {
                        false
                    } else {
                        syncing.insert(account_id.to_string());
                        true
                    }
                };
                if !claimed {
                    log::debug!("IDLE: Skipping quick-sync for {} — full sync in progress", account_id);
                    session
                        .select(&inbox_path)
                        .await
                        .context("Failed to re-select INBOX after skipped sync")?;
                    continue;
                }
                // Drop guard releases the slot on every exit path (success, ?-propagation, abort).
                let _sync_slot_guard = SetGuard::new(
                    &crate::commands::sync::SYNCING_ACCOUNTS,
                    account_id.to_string(),
                );

                log::info!("IDLE: New data for account {}, quick-syncing INBOX", account_id);

                let inbox_folder = Folder {
                    id: inbox_id.clone(),
                    account_id: account_id.to_string(),
                    name: "INBOX".to_string(),
                    folder_type: "inbox".to_string(),
                    path: inbox_path.clone(),
                    unread_count: 0,
                    total_count: 0,
                    is_local: false,
                    color: String::new(),
                };

                match imap::sync_mails(&mut session, &inbox_folder, account_id, &db, None).await {
                    Ok(stats) => {
                        if stats.new_mails > 0 {
                            log::info!("IDLE: Found {} new mails in INBOX", stats.new_mails);

                            // Prefetch bodies for new mails
                            let mails_to_prefetch: Vec<(String, u32)> = {
                                let conn = db.lock_db();
                                conn.prepare(
                                    "SELECT id, uid FROM mails WHERE folder_id = ?1 AND body_text = '' AND uid IS NOT NULL ORDER BY date DESC LIMIT 30",
                                )
                                .ok()
                                .and_then(|mut stmt| {
                                    stmt.query_map(rusqlite::params![inbox_id], |row| {
                                        Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
                                    })
                                    .ok()
                                    .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
                                })
                                .unwrap_or_default()
                            };

                            if !mails_to_prefetch.is_empty() {
                                let _ = imap::backfill_folder_bodies(
                                    &mut session,
                                    &inbox_path,
                                    &mails_to_prefetch,
                                    &db,
                                    app,
                                    None,
                                )
                                .await;
                            }

                            // Emit event so frontend refreshes mail list
                            let _ = app.emit(
                                "sync-progress",
                                &SyncProgress {
                                    account_id: account_id.to_string(),
                                    status: "done".into(),
                                    folder_name: Some("INBOX".into()),
                                    folder_index: 1,
                                    folder_count: 1,
                                    new_mails: stats.new_mails,
                                    message: format!("{} new mails", stats.new_mails),
                                },
                            );
                        }
                    }
                    Err(e) => {
                        log::warn!("IDLE: Quick-sync failed: {}", e);
                        // Connection may be broken — return error to trigger reconnect
                        return Err(anyhow::anyhow!("Quick-sync failed: {}", e));
                    }
                }

                // Re-select INBOX for next IDLE round
                session
                    .select(&inbox_path)
                    .await
                    .context("Failed to re-select INBOX after sync")?;
            }
            IdleEvent::Timeout => {
                log::debug!("IDLE: Timeout for {}, re-entering IDLE", account_id);
                // Re-select to refresh state
                session
                    .select(&inbox_path)
                    .await
                    .context("Failed to re-select INBOX after timeout")?;
            }
        }
    }
}
