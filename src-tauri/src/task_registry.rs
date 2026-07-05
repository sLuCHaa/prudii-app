//! Per-account background-task registry.
//!
//! Background tasks (`tokio::spawn` / `tauri::async_runtime::spawn`) for
//! account-specific work (Gmail/Outlook/IMAP API calls, sync helpers) are
//! registered here so they can be cancelled when the account is deleted or
//! the app shuts down.
//!
//! Without this, spawned tasks outlive the account: they'd attempt to use
//! deleted credentials, write to a deleted account_id, or hold the
//! credentials-keyring lock against another flow's rotation.
//!
//! Use `spawn_for_account(&account_id, future)` instead of raw `tokio::spawn`
//! for any work that should be cancelled on logout. Call `abort_account` from
//! the delete-account command.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use tauri::async_runtime::JoinHandle;

static REGISTRY: std::sync::LazyLock<Mutex<HashMap<String, Vec<JoinHandle<()>>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Spawn a future tied to an account. The handle is stored in the registry
/// and aborted when `abort_account(account_id)` is called.
///
/// Finished handles for the same account are pruned opportunistically on each
/// new spawn so the registry doesn't grow unbounded.
pub fn spawn_for_account<F>(account_id: &str, fut: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    let handle = tauri::async_runtime::spawn(fut);
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    let entry = reg.entry(account_id.to_string()).or_default();
    entry.retain(|h| !h.inner().is_finished());
    entry.push(handle);
}

/// Abort all tasks registered against `account_id`. Idempotent — safe to call
/// even if the account has no registered tasks.
pub fn abort_account(account_id: &str) {
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(handles) = reg.remove(account_id) {
        let count = handles.len();
        for handle in handles {
            handle.abort();
        }
        if count > 0 {
            log::info!("task_registry: aborted {} background task(s) for account {}", count, account_id);
        }
    }
}
