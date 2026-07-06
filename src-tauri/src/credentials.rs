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
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };

        let result = unsafe {
            CryptProtectData(
                &mut input,
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

        let mut input = CRYPT_INTEGER_BLOB {
            cbData: encrypted.len() as u32,
            pbData: encrypted.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };

        let result = unsafe {
            CryptUnprotectData(
                &mut input,
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
        return Some(plaintext);
    }

    #[cfg(not(windows))]
    {
        Some(stored)
    }
}

/// Write a password to the accounts.stored_password column.
/// On Windows: encrypts with DPAPI before writing.
fn store_password_to_db(account_id: &str, password: &str) {
    let Some(conn) = open_db() else { return };

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
                    return;
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
            }
        }
        Err(e) => log::error!("[credentials] DB store failed for {}: {}", account_id, e),
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

    // Try OS keyring (best-effort — not fatal if it fails)
    match keyring::Entry::new(SERVICE_NAME, account_id) {
        Ok(entry) => {
            if let Err(e) = entry.set_password(password) {
                log::warn!("[credentials] Keyring store failed (using memory cache): {}", e);
            }
        }
        Err(e) => {
            log::warn!("[credentials] Keyring entry creation failed (using memory cache): {}", e);
        }
    }

    // Also persist to DB so it survives restarts when keyring is unreliable
    store_password_to_db(account_id, password);

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
        // Update refresh_token if rotated
        if tokens.refresh_token != refresh_token {
            store_password(account_id, &tokens.refresh_token)?;
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
