//! Connection-reset command used by the frontend when the network returns,
//! so half-open IMAP sessions from the offline period are discarded.

use crate::pool::ImapPool;
use tauri::State;

/// Drop all pooled IMAP sessions and cached OAuth access tokens.
/// Best-effort: never fails the caller.
#[tauri::command]
pub async fn invalidate_connections(pool: State<'_, ImapPool>) -> Result<(), String> {
    pool.clear_all().await;
    crate::oauth::clear_token_cache();
    Ok(())
}
