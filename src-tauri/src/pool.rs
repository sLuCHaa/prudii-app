use std::collections::{HashMap, HashSet};
use std::time::Instant;
use tokio::sync::Mutex;

use crate::imap::{self, ImapSession};

/// RAII guard for the pool's `in_use` slot. Released automatically when the
/// owning future is cancelled (e.g. via `task_registry::abort_account`),
/// preventing a permanent stuck slot that would hang every subsequent
/// `take_session` for the same account on `notify_waiters()`.
///
/// On the success path the caller calls `return_session{,_in_folder}`
/// (which removes the slot itself); when the guard is then dropped it sees
/// the slot is already gone and does nothing.
#[must_use = "InUseGuard must be held while the session is in use"]
pub struct InUseGuard<'a> {
    pool: &'a ImapPool,
    account_id: String,
}

impl Drop for InUseGuard<'_> {
    fn drop(&mut self) {
        let still_held = {
            let in_use = self.pool.in_use.lock().unwrap_or_else(|e| e.into_inner());
            in_use.contains(&self.account_id)
        };
        if still_held {
            log::warn!(
                "ImapPool: in_use slot for {} released via guard drop (likely task cancellation)",
                self.account_id
            );
            self.pool.release(&self.account_id);
        }
    }
}

struct PoolEntry {
    session: ImapSession,
    current_folder: Option<String>,
    last_used: Instant,
}

/// Persistent IMAP connection pool. Keeps one session per account alive
/// so that body fetches, trash, mark-as-read etc. don't pay the TLS+login
/// cost (~1-2s) on every single operation.
///
/// **Wait-on-busy**: When a session is in use by another operation, callers
/// wait for it to be returned instead of creating a new connection.
/// This keeps concurrent connections to 1 per account (+ 1 for IDLE),
/// avoiding Gmail's IMAP throttling ([THROTTLED] 10s penalty per command).
pub struct ImapPool {
    sessions: Mutex<HashMap<String, PoolEntry>>,
    /// Tracks which accounts have a session currently taken (in use).
    in_use: std::sync::Mutex<HashSet<String>>,
    /// Signaled when a session is returned to the pool.
    returned: tokio::sync::Notify,
}

impl ImapPool {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            in_use: std::sync::Mutex::new(HashSet::new()),
            returned: tokio::sync::Notify::new(),
        }
    }

    /// Internal: take a session from the pool, waiting if one is in use.
    /// Returns (session, folder_it_was_in).
    async fn take_session(
        &self,
        account_id: &str,
        host: &str,
        port: u16,
        email: &str,
        credential: &str,
        auth_type: &str,
    ) -> anyhow::Result<(ImapSession, Option<String>)> {
        let deadline = Instant::now() + std::time::Duration::from_secs(60);

        loop {
            // 1. Try to take an available session from the pool
            let existing = {
                let mut sessions = self.sessions.lock().await;
                sessions.remove(account_id)
            };

            if let Some(entry) = existing {
                {
                    let mut in_use = self.in_use.lock().unwrap_or_else(|e| e.into_inner());
                    in_use.insert(account_id.to_string());
                }

                // Skip NOOP for recently used sessions (< 2 minutes)
                if entry.last_used.elapsed() < std::time::Duration::from_secs(120) {
                    log::debug!(
                        "IMAP pool: reusing session for {} (age {:?}, folder={:?})",
                        account_id,
                        entry.last_used.elapsed(),
                        entry.current_folder
                    );
                    return Ok((entry.session, entry.current_folder));
                }

                // Older session — validate with NOOP (10s timeout for slow servers)
                let mut session = entry.session;
                match tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    session.noop(),
                )
                .await
                {
                    Ok(Ok(_)) => return Ok((session, entry.current_folder)),
                    _ => {
                        log::info!(
                            "IMAP pool: cached session for {} expired (age {:?}), reconnecting",
                            account_id,
                            entry.last_used.elapsed()
                        );
                        let _ = session.logout().await;
                        // Fall through to create a new connection
                    }
                }
            }

            // 2. Check if another operation has the session
            let is_in_use = {
                let in_use = self.in_use.lock().unwrap_or_else(|e| e.into_inner());
                in_use.contains(account_id)
            };

            if is_in_use {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    log::warn!(
                        "IMAP pool: timeout waiting for session for {}, creating new connection",
                        account_id
                    );
                    break;
                }

                log::debug!(
                    "IMAP pool: session for {} is in use, waiting ({:.0}s remaining)...",
                    account_id,
                    remaining.as_secs_f32()
                );

                tokio::select! {
                    _ = self.returned.notified() => {
                        // A session was returned — loop back and try to take it.
                        // (Might be for a different account, so we re-check.)
                        continue;
                    }
                    _ = tokio::time::sleep(remaining) => {
                        log::warn!(
                            "IMAP pool: timeout waiting for session for {}, creating new connection",
                            account_id
                        );
                        break;
                    }
                }
            } else {
                // 3. No session exists and none in use — create a new one
                break;
            }
        }

        {
            let mut in_use = self.in_use.lock().unwrap_or_else(|e| e.into_inner());
            in_use.insert(account_id.to_string());
        }
        match imap::connect_with_auth(host, port, email, auth_type, credential).await {
            Ok(session) => Ok((session, None)),
            Err(e) => {
                // Connection failed — release the in-use flag and wake waiters,
                // otherwise concurrent callers for the same account hang on returned-notify
                // until the 60s timeout in this loop.
                self.release(account_id);
                Err(e)
            }
        }
    }

    /// Get a session for the given account.
    /// Waits for a busy session instead of creating a new connection.
    pub async fn get_session(
        &self,
        account_id: &str,
        host: &str,
        port: u16,
        email: &str,
        credential: &str,
        auth_type: &str,
    ) -> anyhow::Result<ImapSession> {
        let (session, _folder) = self.take_session(account_id, host, port, email, credential, auth_type).await?;
        Ok(session)
    }

    /// Like `get_session`, but additionally returns an `InUseGuard` that
    /// auto-releases the in-use slot if the caller is dropped before
    /// returning/releasing the session (e.g. on `abort_account` cancellation).
    /// Use this from any spawned background task.
    pub async fn get_session_guarded<'a>(
        &'a self,
        account_id: &str,
        host: &str,
        port: u16,
        email: &str,
        credential: &str,
        auth_type: &str,
    ) -> anyhow::Result<(ImapSession, InUseGuard<'a>)> {
        let (session, _folder) = self.take_session(account_id, host, port, email, credential, auth_type).await?;
        Ok((session, InUseGuard { pool: self, account_id: account_id.to_string() }))
    }

    /// Get a session AND the folder it was in when last returned to the pool.
    /// Use this when you want to skip EXAMINE if the session is already in the right folder.
    pub async fn get_session_with_folder(
        &self,
        account_id: &str,
        host: &str,
        port: u16,
        email: &str,
        credential: &str,
        auth_type: &str,
    ) -> anyhow::Result<(ImapSession, Option<String>)> {
        self.take_session(account_id, host, port, email, credential, auth_type).await
    }

    /// Like `get_session_with_folder`, but additionally returns an `InUseGuard`.
    /// See `get_session_guarded` for rationale.
    pub async fn get_session_with_folder_guarded<'a>(
        &'a self,
        account_id: &str,
        host: &str,
        port: u16,
        email: &str,
        credential: &str,
        auth_type: &str,
    ) -> anyhow::Result<(ImapSession, Option<String>, InUseGuard<'a>)> {
        let (session, folder) = self.take_session(account_id, host, port, email, credential, auth_type).await?;
        Ok((session, folder, InUseGuard { pool: self, account_id: account_id.to_string() }))
    }

    /// Return a session to the pool for reuse.
    pub async fn return_session(&self, account_id: &str, session: ImapSession) {
        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            account_id.to_string(),
            PoolEntry {
                session,
                current_folder: None,
                last_used: Instant::now(),
            },
        );
        drop(sessions);
        {
            let mut in_use = self.in_use.lock().unwrap_or_else(|e| e.into_inner());
            in_use.remove(account_id);
        }
        self.returned.notify_waiters();
    }

    /// Return a session to the pool, recording which folder it's currently in.
    /// This allows the next caller to skip EXAMINE if they need the same folder.
    pub async fn return_session_in_folder(
        &self,
        account_id: &str,
        session: ImapSession,
        folder: String,
    ) {
        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            account_id.to_string(),
            PoolEntry {
                session,
                current_folder: Some(folder),
                last_used: Instant::now(),
            },
        );
        drop(sessions);
        {
            let mut in_use = self.in_use.lock().unwrap_or_else(|e| e.into_inner());
            in_use.remove(account_id);
        }
        self.returned.notify_waiters();
    }

    /// Release the in-use flag without returning a session.
    /// Call this when a session errors out and you've already logged it out.
    pub fn release(&self, account_id: &str) {
        {
            let mut in_use = self.in_use.lock().unwrap_or_else(|e| e.into_inner());
            in_use.remove(account_id);
        }
        self.returned.notify_waiters();
    }

    /// Remove and logout a session (e.g. on account delete or error).
    pub async fn drop_session(&self, account_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(mut entry) = sessions.remove(account_id) {
            let _ = entry.session.logout().await;
        }
        drop(sessions);
        {
            let mut in_use = self.in_use.lock().unwrap_or_else(|e| e.into_inner());
            in_use.remove(account_id);
        }
        self.returned.notify_waiters();
    }

    /// Drop all sessions (e.g. after backup restore).
    pub async fn clear_all(&self) {
        let mut sessions = self.sessions.lock().await;
        for (_, mut entry) in sessions.drain() {
            let _ = entry.session.logout().await;
        }
        drop(sessions);
        {
            let mut in_use = self.in_use.lock().unwrap_or_else(|e| e.into_inner());
            in_use.clear();
        }
        self.returned.notify_waiters();
    }
}
