use anyhow::Result;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

const SERVICE_NAME: &str = "prudii-mail";

/// In-memory password cache — fallback when the OS keyring is unavailable.
/// Passwords are only held for the current app session (never written to disk).
static PASSWORD_CACHE: std::sync::LazyLock<Mutex<HashMap<String, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Path to the SQLite database — set once during app startup.
/// Used as the final fallback when both keyring and memory cache fail.
static DB_PATH: std::sync::LazyLock<Mutex<Option<PathBuf>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

/// Initialize the credentials module with the DB path.
/// Called once during app setup so `get_password` can fall back to the DB.
pub fn init(db_path: PathBuf) {
    let mut path = DB_PATH.lock().unwrap_or_else(|e| e.into_inner());
    *path = Some(db_path);
}

/// Open a connection to the credentials DB with proper settings.
/// NOTE: This creates a second SQLite connection separate from the Database mutex.
/// Must use matching PRAGMAs to avoid SQLITE_BUSY conflicts.
fn open_db() -> Option<Connection> {
    let path_guard = DB_PATH.lock().unwrap_or_else(|e| e.into_inner());
    let db_path = path_guard.as_ref()?;
    let conn = Connection::open(db_path)
        .map_err(|e| log::error!("[credentials] Failed to open DB: {}", e))
        .ok()?;
    // Match main Database connection PRAGMAs
    let _ = conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=30000;");
    Some(conn)
}

#[cfg(windows)]
pub(crate) mod dpapi {
    use base64::Engine;
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };
    use windows::Win32::Foundation::LocalFree;

    const PREFIX: &str = "dpapi:";

    pub fn is_encrypted(stored: &str) -> bool {
        stored.starts_with(PREFIX)
    }

    pub fn encrypt(plaintext: &str) -> Option<String> {
        let data = plaintext.as_bytes();
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };

        let result = unsafe {
            CryptProtectData(
                &input,
                None,               // description
                None,               // optional entropy
                None,               // reserved
                None,               // prompt struct
                0,                  // flags
                &mut output,
            )
        };

        if let Err(e) = result {
            log::warn!("[dpapi] CryptProtectData failed: {}", e);
            return None;
        }

        let encrypted = unsafe {
            std::slice::from_raw_parts(output.pbData, output.cbData as usize)
        };
        let encoded = base64::engine::general_purpose::STANDARD.encode(encrypted);

        // Free the buffer allocated by CryptProtectData
        unsafe {
            let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(output.pbData as _)));
        }

        Some(format!("{}{}", PREFIX, encoded))
    }

    pub fn decrypt(stored: &str) -> Option<String> {
        let b64 = stored.strip_prefix(PREFIX)?;
        let encrypted = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;

        let input = CRYPT_INTEGER_BLOB {
            cbData: encrypted.len() as u32,
            pbData: encrypted.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };

        let result = unsafe {
            CryptUnprotectData(
                &input,
                None,               // description out
                None,               // optional entropy
                None,               // reserved
                None,               // prompt struct
                0,                  // flags
                &mut output,
            )
        };

        if let Err(e) = result {
            log::warn!("[dpapi] CryptUnprotectData failed: {}", e);
            return None;
        }

        let decrypted = unsafe {
            std::slice::from_raw_parts(output.pbData, output.cbData as usize)
        };
        let plaintext = String::from_utf8(decrypted.to_vec()).ok();

        // Free the buffer allocated by CryptUnprotectData
        unsafe {
            let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(output.pbData as _)));
        }

        plaintext
    }
}

/// Read a password directly from the accounts.stored_password column.
/// On Windows: decrypts DPAPI-encrypted values, migrates plaintext to encrypted.
fn get_password_from_db(account_id: &str) -> Option<String> {
    let conn = open_db()?;
    let stored: String = conn.query_row(
        "SELECT stored_password FROM accounts WHERE id = ?1 AND stored_password IS NOT NULL AND stored_password != ''",
        rusqlite::params![account_id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|e| log::warn!("[credentials] DB read failed for {}: {}", account_id, e))
    .ok()?;

    #[cfg(windows)]
    {
        if dpapi::is_encrypted(&stored) {
            return dpapi::decrypt(&stored);
        }

        // Plaintext migration: encrypt and write back
        let plaintext = stored;
        if let Some(encrypted) = dpapi::encrypt(&plaintext) {
            match conn.execute(
                "UPDATE accounts SET stored_password = ?1 WHERE id = ?2",
                rusqlite::params![encrypted, account_id],
            ) {
                Ok(_) => log::info!("[credentials] Migrated plaintext password to DPAPI for account {}", account_id),
                Err(e) => log::warn!("[credentials] DPAPI migration write failed: {}", e),
            }
        }
        Some(plaintext)
    }

    #[cfg(not(windows))]
    {
        Some(stored)
    }
}

/// Write a password to the accounts.stored_password column.
/// On Windows: encrypts with DPAPI before writing.
/// Returns whether the value actually reached the column — callers need to know
/// when a secret only survives in the session cache.
fn store_password_to_db(account_id: &str, password: &str) -> bool {
    let Some(conn) = open_db() else { return false };

    let value_to_store: String;

    #[cfg(windows)]
    {
        if password.is_empty() {
            // Clearing password — store empty string as-is
            value_to_store = String::new();
        } else {
            value_to_store = match dpapi::encrypt(password) {
                Some(encrypted) => encrypted,
                None => {
                    log::error!("[credentials] DPAPI encrypt failed — refusing to store plaintext");
                    return false;
                }
            };
        }
    }

    #[cfg(not(windows))]
    {
        value_to_store = password.to_string();
    }

    match conn.execute(
        "UPDATE accounts SET stored_password = ?1 WHERE id = ?2",
        rusqlite::params![value_to_store, account_id],
    ) {
        Ok(rows) => {
            if rows == 0 {
                log::warn!("[credentials] DB store: 0 rows updated for account {} (account may not exist yet)", account_id);
                return false;
            }
            true
        }
        Err(e) => {
            log::error!("[credentials] DB store failed for {}: {}", account_id, e);
            false
        }
    }
}

/// Blank the stored_password column when an account is deleted. Kept separate
/// from `store_password_to_db` so no string literal is passed as a password.
fn clear_password_in_db(account_id: &str) {
    let Some(conn) = open_db() else { return };
    if let Err(e) = conn.execute(
        "UPDATE accounts SET stored_password = '' WHERE id = ?1",
        rusqlite::params![account_id],
    ) {
        log::warn!("[credentials] DB clear failed for {}: {}", account_id, e);
    }
}

pub fn store_password(account_id: &str, password: &str) -> Result<()> {
    {
        let mut cache = PASSWORD_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(account_id.to_string(), password.to_string());
    }

    // Try OS keyring (not fatal on its own — the DB write below is the second chance)
    let mut keyring_stored = false;
    match keyring::Entry::new(SERVICE_NAME, account_id) {
        Ok(entry) => match entry.set_password(password) {
            Ok(()) => keyring_stored = true,
            Err(e) => log::warn!("[credentials] Keyring store failed (using memory cache): {}", e),
        },
        Err(e) => {
            log::warn!("[credentials] Keyring entry creation failed (using memory cache): {}", e);
        }
    }

    // Also persist to DB so it survives restarts when keyring is unreliable
    let db_stored = store_password_to_db(account_id, password);

    if !keyring_stored && !db_stored {
        // Only the session cache holds it now — the caller has to be able to see that.
        return Err(anyhow::anyhow!(
            "Password for account {} could not be persisted (keyring and database both failed)",
            account_id
        ));
    }

    Ok(())
}

pub fn get_password(account_id: &str) -> Result<String> {
    // 1. Try memory cache first (fastest)
    {
        let cache = PASSWORD_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pw) = cache.get(account_id) {
            return Ok(pw.clone());
        }
    }

    // 2. Try OS keyring
    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, account_id) {
        if let Ok(pw) = entry.get_password() {
            let mut cache = PASSWORD_CACHE.lock().unwrap_or_else(|e| e.into_inner());
            cache.insert(account_id.to_string(), pw.clone());
            drop(cache);

            // Also persist to DB — keyring is unreliable across restarts on Windows
            store_password_to_db(account_id, &pw);

            return Ok(pw);
        }
    }

    // 3. Final fallback: read from DB stored_password column
    if let Some(pw) = get_password_from_db(account_id) {
        let mut cache = PASSWORD_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(account_id.to_string(), pw.clone());
        drop(cache);

        // Try to re-store in keyring for next time
        if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, account_id) {
            let _ = entry.set_password(&pw);
        }

        return Ok(pw);
    }

    anyhow::bail!("No password found in keyring, memory cache, or database")
}

/// Resolve the credential for an account.
/// For password accounts: returns stored password.
/// For OAuth accounts: returns valid access_token (refreshes if expired).
pub async fn resolve_credential(account_id: &str, auth_type: &str, provider: &str) -> Result<String> {
    if auth_type == "oauth" {
        if let Some(token) = crate::oauth::get_cached_token(account_id) {
            return Ok(token);
        }
        let refresh_token = get_password(account_id)?;
        let tokens = crate::oauth::refresh_access_token(provider, &refresh_token).await?;
        crate::oauth::cache_token(account_id, &tokens.access_token, tokens.expires_in);
        // A rotated refresh token that can't be persisted must not abort the running sync —
        // the session cache carries it, and the problem resurfaces on the next refresh.
        if tokens.refresh_token != refresh_token {
            if let Err(e) = store_password(account_id, &tokens.refresh_token) {
                log::warn!("[credentials] Rotated refresh token not persisted for {}: {}", account_id, e);
            }
        }
        Ok(tokens.access_token)
    } else {
        get_password(account_id)
    }
}

pub fn delete_password(account_id: &str) -> Result<()> {
    {
        let mut cache = PASSWORD_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        cache.remove(account_id);
    }

    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, account_id) {
        match entry.delete_credential() {
            Ok(()) => {}
            Err(keyring::Error::NoEntry) => {} // Already deleted
            Err(e) => log::warn!("[credentials] Keyring delete failed: {}", e),
        }
    }

    clear_password_in_db(account_id);

    Ok(())
}

fn calendar_link_key(calendar_id: &str) -> String {
    format!("calendar-subscription:{}", calendar_id)
}

fn seal(value: &str) -> Option<String> {
    #[cfg(windows)]
    {
        dpapi::encrypt(value)
    }
    #[cfg(not(windows))]
    {
        Some(value.to_string())
    }
}

fn unseal(stored: &str) -> Option<String> {
    #[cfg(windows)]
    {
        if dpapi::is_encrypted(stored) {
            return dpapi::decrypt(stored);
        }
    }
    Some(stored.to_string())
}

/// Second copy of a subscription link, sealed like `accounts.stored_password`.
pub(crate) fn link_to_db(conn: &Connection, calendar_id: &str, url: &str) -> bool {
    let Some(sealed) = seal(url) else {
        log::error!("[credentials] sealing a calendar link failed — not stored in the database");
        return false;
    };
    matches!(
        conn.execute("UPDATE calendars SET secret_link = ?1 WHERE id = ?2", rusqlite::params![sealed, calendar_id]),
        Ok(1)
    )
}

pub(crate) fn link_from_db(conn: &Connection, calendar_id: &str) -> Option<String> {
    let stored: String = conn
        .query_row(
            "SELECT secret_link FROM calendars WHERE id = ?1 AND secret_link IS NOT NULL AND secret_link != ''",
            rusqlite::params![calendar_id],
            |r| r.get(0),
        )
        .ok()?;
    unseal(&stored)
}

/// Only the database copy is certain to survive a restart.
fn require_db_copy(db_stored: bool) -> Result<()> {
    if db_stored {
        Ok(())
    } else {
        anyhow::bail!("calendar link could not be persisted (database copy failed)")
    }
}

/// Same chain as passwords, but the database copy must succeed.
pub fn store_calendar_link(calendar_id: &str, url: &str) -> Result<()> {
    let key = calendar_link_key(calendar_id);
    let keyring_stored = match keyring::Entry::new(SERVICE_NAME, &key).and_then(|e| e.set_password(url)) {
        Ok(()) => true,
        Err(e) => {
            log::warn!("[credentials] Keyring store failed for a calendar link: {}", e);
            false
        }
    };
    let db_stored = open_db().is_some_and(|conn| link_to_db(&conn, calendar_id, url));
    if !keyring_stored {
        log::warn!("[credentials] calendar link relies on the database copy alone");
    }
    require_db_copy(db_stored)?;
    PASSWORD_CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(key, url.to_string());
    Ok(())
}

pub fn get_calendar_link(calendar_id: &str) -> Result<String> {
    let key = calendar_link_key(calendar_id);
    if let Some(url) = PASSWORD_CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Ok(url.clone());
    }
    let from_keyring = keyring::Entry::new(SERVICE_NAME, &key).and_then(|e| e.get_password()).ok();
    let url = match from_keyring {
        Some(url) => url,
        None => open_db().and_then(|conn| link_from_db(&conn, calendar_id)).ok_or_else(|| anyhow::anyhow!("no stored calendar link"))?,
    };
    PASSWORD_CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(key, url.clone());
    Ok(url)
}

/// The database copy goes with the calendar row.
pub fn delete_calendar_link(calendar_id: &str) {
    let key = calendar_link_key(calendar_id);
    PASSWORD_CACHE.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, &key) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => log::warn!("[credentials] Keyring delete failed for a calendar link: {}", e),
        }
    }
}

/// Indirection over the secret storage so backup code can be tested without an OS keyring.
pub trait SecretStore {
    fn get(&self, account_id: &str) -> Result<String, String>;
    fn set(&self, account_id: &str, secret: &str) -> Result<(), String>;
}

/// Production implementation — the same keyring/cache/DB chain the app uses everywhere else.
pub struct KeyringStore;

impl SecretStore for KeyringStore {
    fn get(&self, account_id: &str) -> Result<String, String> {
        get_password(account_id).map_err(|e| e.to_string())
    }

    fn set(&self, account_id: &str, secret: &str) -> Result<(), String> {
        store_password(account_id, secret).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn calendar_db() -> (crate::db::Database, String) {
        let db = crate::db::Database::new(std::env::temp_dir().join(format!("prudii-test-{}", uuid::Uuid::new_v4()))).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        db.lock_db()
            .execute("INSERT INTO calendars (id, name, color, source) VALUES (?1, 'Feed', '#10b981', 'subscription')", rusqlite::params![id])
            .unwrap();
        (db, id)
    }

    #[test]
    fn calendar_links_round_trip_through_the_database_fallback() {
        let (db, id) = calendar_db();
        let conn = db.lock_db();
        let url = "https://calendar.example.com/private-abc/basic.ics";
        assert!(link_to_db(&conn, &id, url));
        assert_eq!(link_from_db(&conn, &id).as_deref(), Some(url));
        let stored: String = conn.query_row("SELECT secret_link FROM calendars WHERE id = ?1", rusqlite::params![id], |r| r.get(0)).unwrap();
        if cfg!(windows) {
            assert!(stored.starts_with("dpapi:"), "the fallback copy is sealed on Windows");
        }
    }

    #[test]
    fn link_storage_requires_the_database_copy() {
        assert!(require_db_copy(true).is_ok());
        assert!(require_db_copy(false).is_err());
    }

    #[test]
    fn links_for_unknown_calendars_are_not_stored() {
        let (db, _) = calendar_db();
        let conn = db.lock_db();
        assert!(!link_to_db(&conn, "missing", "https://example.com/a.ics"));
        assert_eq!(link_from_db(&conn, "missing"), None);
    }
}
