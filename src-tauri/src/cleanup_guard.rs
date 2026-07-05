//! Drop-guards that release tracking-HashSet entries on every exit path.
//!
//! Used inside spawned futures whose lifecycle is governed by
//! `task_registry::abort_account`. When a future is aborted mid-await, any
//! manually paired `set.insert` / `set.remove` calls leak the entry. Wrapping
//! membership in a `SetGuard` ensures cleanup runs via Drop regardless of
//! whether the future returns normally, errors, or is cancelled.

use std::collections::HashSet;
use std::sync::Mutex;

/// Removes `key` from `set` when dropped. Owned `String` so the guard is
/// `Send` and `'static`-friendly across spawned futures.
#[must_use = "SetGuard must be held for the duration of the tracked work"]
pub struct SetGuard {
    set: &'static Mutex<HashSet<String>>,
    key: String,
}

impl SetGuard {
    pub fn new(set: &'static Mutex<HashSet<String>>, key: String) -> Self {
        Self { set, key }
    }
}

impl Drop for SetGuard {
    fn drop(&mut self) {
        let mut s = self.set.lock().unwrap_or_else(|e| e.into_inner());
        s.remove(&self.key);
    }
}
