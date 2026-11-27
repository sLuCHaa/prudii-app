use crate::credentials;
use crate::db::Database;
use crate::gmail;
use crate::outlook;
use crate::pop3::{self, Pop3Client, Pop3Error, Pop3Security};
use crate::commands::mails::{pop3_delete_rows, pop3_remove_files, POP3_NOT_SUPPORTED};
use crate::models::{
    Account, CreateAccountRequest, Folder, UpdateAccountSettings, DEFAULT_INCOMING_PROTOCOL,
    DEFAULT_INCOMING_SECURITY, DEFAULT_POP3_DELETE_AFTER_DAYS, DEFAULT_POP3_DELETE_MODE,
    DEFAULT_POP3_DELETE_WITH_LOCAL,
};
use std::future::Future;
use std::time::Duration;
use tauri::State;
use tokio::io::{AsyncRead, AsyncWrite};

/// API type for an account — determines which backend to use for folder operations.
enum FolderApiType { Gmail, Outlook, Imap, Pop3 }

fn get_folder_api_type(db: &Database, account_id: &str) -> (FolderApiType, String, String) {
    let conn = db.lock_db();
    let result: Result<(String, String, String), _> = conn.query_row(
        "SELECT provider, auth_type, incoming_protocol FROM accounts WHERE id = ?1",
        rusqlite::params![account_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    );
    match result {
        Ok((provider, auth_type, incoming_protocol)) => {
            let api = if incoming_protocol == "pop3" {
                FolderApiType::Pop3
            } else if provider == "google" && auth_type == "oauth" {
                FolderApiType::Gmail
            } else if provider == "microsoft" && auth_type == "oauth" {
                FolderApiType::Outlook
            } else {
                FolderApiType::Imap
            };
            (api, provider, auth_type)
        }
        Err(_) => (FolderApiType::Imap, String::new(), String::new()),
    }
}

#[tauri::command(async)]
pub fn list_accounts(db: State<'_, Database>) -> Result<Vec<Account>, String> {
    let conn = db.read_db();
    list_accounts_inner(&conn)
}

/// Command body, separated so integration tests can run it against a fixture DB.
pub fn list_accounts_inner(conn: &rusqlite::Connection) -> Result<Vec<Account>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT a.id, a.email, a.display_name, a.provider, a.color, a.imap_host, a.imap_port, a.smtp_host, a.smtp_port, COALESCE(a.smtp_security, 'ssl') as smtp_security, a.auth_type, COALESCE(s.html, '') as signature_html, COALESCE(s.text, '') as signature_text, COALESCE(a.signature_on_compose, 1) as signature_on_compose, COALESCE(a.signature_on_reply, 1) as signature_on_reply, COALESCE(a.sync_interval_minutes, 0) as sync_interval_minutes, COALESCE(a.load_external_images, 'always') as load_external_images, a.created_at, a.updated_at, s.id as signature_id, a.incoming_protocol, a.incoming_security, a.pop3_delete_mode, a.pop3_delete_after_days, a.pop3_delete_with_local FROM accounts a LEFT JOIN signatures s ON s.id = a.signature_id ORDER BY a.created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let accounts = stmt
        .query_map([], |row| {
            Ok(Account {
                id: row.get(0)?,
                email: row.get(1)?,
                display_name: row.get(2)?,
                provider: row.get(3)?,
                color: row.get(4)?,
                imap_host: row.get(5)?,
                imap_port: row.get(6)?,
                smtp_host: row.get(7)?,
                smtp_port: row.get(8)?,
                smtp_security: row.get(9)?,
                auth_type: row.get(10)?,
                signature_id: row.get(19)?,
                signature_html: row.get(11)?,
                signature_text: row.get(12)?,
                signature_on_compose: row.get::<_, i32>(13)? != 0,
                signature_on_reply: row.get::<_, i32>(14)? != 0,
                sync_interval_minutes: row.get(15)?,
                load_external_images: row.get(16)?,
                created_at: row.get(17)?,
                updated_at: row.get(18)?,
                incoming_protocol: row.get(20)?,
                incoming_security: row.get(21)?,
                pop3_delete_mode: row.get(22)?,
                pop3_delete_after_days: row.get(23)?,
                pop3_delete_with_local: row.get(24)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(accounts)
}

/// The account a new one with this address takes the place of.
/// - Same provider, auth_type and protocol → re-add after failed attempt: clean up and replace.
/// - Any of them different → reject with a clear error so users notice that
///   their OAuth provider returned an email belonging to an existing account
///   (e.g. Outlook configured with a Gmail address as primary).
fn replaceable_id(conn: &rusqlite::Connection, email: &str, provider: &str, auth_type: &str, incoming_protocol: &str) -> Result<Option<String>, String> {
    let existing: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT id, provider, auth_type, incoming_protocol FROM accounts WHERE email = ?1",
            rusqlite::params![email],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok();
    let Some((old_id, old_provider, old_auth_type, old_protocol)) = existing else {
        return Ok(None);
    };
    if old_provider != provider || old_auth_type != auth_type || old_protocol != incoming_protocol {
        return Err(format!(
            "EMAIL_PROVIDER_CONFLICT|{}|{}|{}",
            email, old_provider, old_auth_type
        ));
    }
    if old_protocol == "pop3" {
        return Err(pop3_account_exists(email));
    }
    Ok(Some(old_id))
}

/// Replacing a POP3 account would delete mail that may exist nowhere else.
pub(crate) fn pop3_account_exists(email: &str) -> String {
    format!("POP3_ACCOUNT_EXISTS|{}", email)
}

const POP3_LOCAL_FOLDERS: [(&str, &str); 5] = [
    ("inbox", "INBOX"),
    ("sent", "Sent"),
    ("drafts", "Drafts"),
    ("trash", "Trash"),
    ("archive", "Archive"),
];

fn check_incoming(update: &UpdateAccountSettings) -> Result<(), String> {
    if let Some(protocol) = update.incoming_protocol.as_deref() {
        if !["imap", "pop3"].contains(&protocol) {
            return Err(format!("Invalid incoming protocol: '{}'. Must be 'imap' or 'pop3'.", protocol));
        }
    }
    if let Some(security) = update.incoming_security.as_deref() {
        if !["ssl", "starttls"].contains(&security) {
            return Err(format!("Invalid incoming security mode: '{}'. Must be 'ssl' or 'starttls'.", security));
        }
    }
    if let Some(mode) = update.pop3_delete_mode.as_deref() {
        if !["keep", "after_fetch", "after_days"].contains(&mode) {
            return Err(format!("Invalid POP3 delete mode: '{}'.", mode));
        }
    }
    if let Some(days) = update.pop3_delete_after_days {
        if !(1..=365).contains(&days) {
            return Err(format!("Invalid POP3 delete delay: {}. Must be 1-365 days.", days));
        }
    }
    Ok(())
}

fn check_new_account(request: &CreateAccountRequest) -> Result<(), String> {
    check_incoming(&UpdateAccountSettings {
        incoming_protocol: request.incoming_protocol.clone(),
        incoming_security: request.incoming_security.clone(),
        pop3_delete_mode: request.pop3_delete_mode.clone(),
        pop3_delete_after_days: request.pop3_delete_after_days,
        pop3_delete_with_local: request.pop3_delete_with_local,
    })?;
    if request.incoming_protocol.as_deref() == Some("pop3") && request.auth_type != "password" {
        return Err("POP3 accounts support password sign-in only.".to_string());
    }
    Ok(())
}

/// A pasted space would break the login and slip past the duplicate-address check.
fn trim_pop3_request(mut request: CreateAccountRequest) -> CreateAccountRequest {
    if request.incoming_protocol.as_deref() == Some("pop3") {
        for field in [&mut request.email, &mut request.imap_host, &mut request.smtp_host] {
            *field = field.trim().to_string();
        }
    }
    request
}

fn trim_pop3_hosts(conn: &rusqlite::Connection, account_id: &str, imap_host: String, smtp_host: String) -> (String, String) {
    let is_pop3 = conn
        .query_row(
            "SELECT incoming_protocol = 'pop3' FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if is_pop3 {
        (imap_host.trim().to_string(), smtp_host.trim().to_string())
    } else {
        (imap_host, smtp_host)
    }
}

fn insert_account(conn: &rusqlite::Connection, request: &CreateAccountRequest) -> Result<Account, String> {
    check_new_account(request)?;
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let request = request.clone();
    let account = Account {
        id: uuid::Uuid::new_v4().to_string(),
        email: request.email,
        display_name: request.display_name,
        provider: request.provider,
        color: request.color,
        imap_host: request.imap_host,
        imap_port: request.imap_port,
        smtp_host: request.smtp_host,
        smtp_port: request.smtp_port,
        smtp_security: request.smtp_security,
        auth_type: request.auth_type,
        signature_id: None,
        signature_html: String::new(),
        signature_text: String::new(),
        signature_on_compose: true,
        signature_on_reply: true,
        sync_interval_minutes: 5,
        load_external_images: "always".to_string(),
        created_at: now.clone(),
        updated_at: now,
        incoming_protocol: request.incoming_protocol.unwrap_or_else(|| DEFAULT_INCOMING_PROTOCOL.to_string()),
        incoming_security: request.incoming_security.unwrap_or_else(|| DEFAULT_INCOMING_SECURITY.to_string()),
        pop3_delete_mode: request.pop3_delete_mode.unwrap_or_else(|| DEFAULT_POP3_DELETE_MODE.to_string()),
        pop3_delete_after_days: request.pop3_delete_after_days.unwrap_or(DEFAULT_POP3_DELETE_AFTER_DAYS),
        pop3_delete_with_local: request.pop3_delete_with_local.unwrap_or(DEFAULT_POP3_DELETE_WITH_LOCAL),
    };

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO accounts (id, email, display_name, provider, color, imap_host, imap_port, smtp_host, smtp_port, smtp_security, auth_type, created_at, updated_at, incoming_protocol, incoming_security, pop3_delete_mode, pop3_delete_after_days, pop3_delete_with_local) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        rusqlite::params![account.id, account.email, account.display_name, account.provider, account.color, account.imap_host, account.imap_port, account.smtp_host, account.smtp_port, account.smtp_security, account.auth_type, account.created_at, account.updated_at, account.incoming_protocol, account.incoming_security, account.pop3_delete_mode, account.pop3_delete_after_days, account.pop3_delete_with_local],
    )
    .map_err(|e| e.to_string())?;
    if account.incoming_protocol == "pop3" {
        for (folder_type, path) in POP3_LOCAL_FOLDERS {
            tx.execute(
                "INSERT INTO folders (id, account_id, name, folder_type, path, is_local) VALUES (?1, ?2, ?3, ?4, ?3, 0)",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), account.id, path, folder_type],
            )
            .map_err(|e| format!("Failed to create folder: {}", e))?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(account)
}

fn apply_incoming_settings(conn: &rusqlite::Connection, account_id: &str, update: &UpdateAccountSettings) -> Result<(), String> {
    check_incoming(update)?;
    if let Some(wanted) = update.incoming_protocol.as_deref() {
        let current: String = conn
            .query_row(
                "SELECT incoming_protocol FROM accounts WHERE id = ?1",
                rusqlite::params![account_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Account not found: {}", e))?;
        if current != wanted {
            return Err("PROTOCOL_CHANGE_UNSUPPORTED".to_string());
        }
    }
    conn.execute(
        "UPDATE accounts SET incoming_security = COALESCE(?1, incoming_security), pop3_delete_mode = COALESCE(?2, pop3_delete_mode), pop3_delete_after_days = COALESCE(?3, pop3_delete_after_days), pop3_delete_with_local = COALESCE(?4, pop3_delete_with_local) WHERE id = ?5",
        rusqlite::params![update.incoming_security, update.pop3_delete_mode, update.pop3_delete_after_days, update.pop3_delete_with_local, account_id],
    )
    .map_err(|e| format!("Failed to update account settings: {}", e))?;
    Ok(())
}

#[tauri::command(async)]
pub fn create_account(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    request: CreateAccountRequest,
) -> Result<Account, String> {
    check_new_account(&request)?;
    let request = trim_pop3_request(request);
    let incoming_protocol = request.incoming_protocol.as_deref().unwrap_or(DEFAULT_INCOMING_PROTOCOL);

    let conn = db.lock_db();

    if let Some(old_id) = replaceable_id(&conn, &request.email, &request.provider, &request.auth_type, incoming_protocol)? {
        log::info!("Cleaning up existing account {} before re-add (same provider)", old_id);
        // Mirror delete_account's teardown — an orphaned IDLE watcher would
        // reconnect to the mailbox forever.
        crate::task_registry::abort_account(&old_id);
        {
            use tauri::Manager;
            let app = app.clone();
            let old_id = old_id.clone();
            tauri::async_runtime::spawn(async move {
                let pool = app.state::<crate::pool::ImapPool>();
                pool.drop_session(&old_id).await;
            });
        }
        if let Err(e) = credentials::delete_password(&old_id) {
            log::warn!("Failed to delete credentials for {}: {}", old_id, e);
        }
        conn.execute_batch("BEGIN").map_err(|e| format!("Failed to start cleanup transaction: {}", e))?;
        for (table, query) in [
            ("attachments", "DELETE FROM attachments WHERE mail_id IN (SELECT id FROM mails WHERE account_id = ?1)"),
            ("mails", "DELETE FROM mails WHERE account_id = ?1"),
            ("folders", "DELETE FROM folders WHERE account_id = ?1"),
            ("drafts", "DELETE FROM drafts WHERE account_id = ?1"),
            ("accounts", "DELETE FROM accounts WHERE id = ?1"),
        ] {
            if let Err(e) = conn.execute(query, rusqlite::params![old_id]) {
                log::warn!("Failed to clean up {} for account {}: {}", table, old_id, e);
            }
        }
        conn.execute_batch("COMMIT").map_err(|e| format!("Failed to commit cleanup: {}", e))?;
    }

    let account = insert_account(&conn, &request)?;

    drop(conn);

    // Stored in the system credential manager (never as plaintext in the DB). A failed
    // persist keeps the account usable this session via the in-memory cache, so the row stays.
    if credentials::store_password(&account.id, &request.password).is_err() {
        log::warn!("[accounts] Password for the new account not persisted, session cache only");
    }

    Ok(account)
}

/// Re-store a password in the system credential manager for an existing account.
/// Used when the keyring entry is missing (e.g., after migration from plaintext storage).
#[tauri::command(async)]
pub fn store_account_password(
    db: State<'_, Database>,
    account_id: String,
    password: String,
) -> Result<(), String> {
    let conn = db.lock_db();
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM accounts WHERE id = ?1)",
            rusqlite::params![account_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    drop(conn);

    if !exists {
        return Err("Account not found".to_string());
    }

    // Called mid-save from the settings panel: a failed persist must not abort the rest of
    // that save. The session cache still holds the secret, so the account keeps working.
    if let Err(e) = credentials::store_password(&account_id, &password) {
        log::warn!("[accounts] Password for {} not persisted, session cache only: {}", account_id, e);
    }
    crate::idle::retry_now();

    Ok(())
}

#[tauri::command(async)]
pub fn update_account_signature(
    db: State<'_, Database>,
    account_id: String,
    signature_id: Option<String>,
    signature_on_compose: bool,
    signature_on_reply: bool,
) -> Result<(), String> {
    super::catch_panic(|| {
        super::signatures::set_account_signature_inner(
            &db.lock_db(),
            &account_id,
            signature_id.as_deref(),
            signature_on_compose,
            signature_on_reply,
        )
    })
}

#[tauri::command(async)]
pub fn update_account_sync_interval(
    db: State<'_, Database>,
    account_id: String,
    sync_interval_minutes: i32,
) -> Result<(), String> {
    super::catch_panic(|| {
        if !(0..=1440).contains(&sync_interval_minutes) {
            return Err(format!("Invalid sync interval: {}. Must be 0 (manual) or 1-1440 minutes.", sync_interval_minutes));
        }
        let conn = db.lock_db();
        let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

        conn.execute(
            "UPDATE accounts SET sync_interval_minutes = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![sync_interval_minutes, now, account_id],
        )
        .map_err(|e| format!("Failed to update sync interval: {}", e))?;

        Ok(())
    })
}

#[tauri::command(async)]
pub fn update_account_settings(
    db: State<'_, Database>,
    account_id: String,
    display_name: String,
    color: String,
    imap_host: String,
    imap_port: i32,
    smtp_host: String,
    smtp_port: i32,
    smtp_security: String,
    load_external_images: String,
    incoming: Option<UpdateAccountSettings>,
) -> Result<(), String> {
    super::catch_panic(|| {
        if smtp_security != "ssl" && smtp_security != "starttls" {
            return Err(format!("Invalid SMTP security mode: '{}'. Must be 'ssl' or 'starttls'.", smtp_security));
        }
        if smtp_port <= 0 || smtp_port > 65535 {
            return Err(format!("Invalid SMTP port: {}", smtp_port));
        }
        if imap_port <= 0 || imap_port > 65535 {
            return Err(format!("Invalid IMAP port: {}", imap_port));
        }
        if load_external_images != "always" && load_external_images != "never" {
            return Err(format!("Invalid load_external_images: '{}'. Must be 'always' or 'never'.", load_external_images));
        }
        let conn = db.lock_db();
        let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        if let Some(incoming) = &incoming {
            apply_incoming_settings(&tx, &account_id, incoming)?;
        }
        let (imap_host, smtp_host) = trim_pop3_hosts(&tx, &account_id, imap_host, smtp_host);
        tx.execute(
            "UPDATE accounts SET display_name = ?1, color = ?2, imap_host = ?3, imap_port = ?4, smtp_host = ?5, smtp_port = ?6, smtp_security = ?7, load_external_images = ?8, updated_at = ?9 WHERE id = ?10",
            rusqlite::params![display_name, color, imap_host, imap_port, smtp_host, smtp_port, smtp_security, load_external_images, now, account_id],
        )
        .map_err(|e| format!("Failed to update account settings: {}", e))?;
        tx.commit().map_err(|e| e.to_string())?;

        Ok(())
    })
}

#[tauri::command]
pub async fn delete_account(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    account_id: String,
) -> Result<(), String> {
    use tauri::Manager;
    // Cancel any in-flight background tasks for this account before tearing it down,
    // so they don't try to use deleted credentials or write to a missing account_id.
    crate::task_registry::abort_account(&account_id);

    // Evict any pooled IMAP session for this account so it doesn't keep
    // holding the (now-deleted) credentials open against the server.
    let pool = app.state::<crate::pool::ImapPool>();
    pool.drop_session(&account_id).await;

    let _ = credentials::delete_password(&account_id);

    let attach_dir = db.data_dir.join("attachments");
    if attach_dir.exists() {
        let conn = db.lock_db();
        let mut stmt = conn
            .prepare("SELECT id FROM mails WHERE account_id = ?1")
            .map_err(|e| e.to_string())?;
        let mail_ids: Vec<String> = stmt
            .query_map(rusqlite::params![account_id], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        drop(conn);

        for mail_id in &mail_ids {
            let dir = attach_dir.join(mail_id);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    // Explicitly delete all child records in a transaction, then the account
    let conn = db.lock_db();
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let tx_result = (|| -> Result<(), rusqlite::Error> {
        conn.execute(
            "DELETE FROM attachments WHERE mail_id IN (SELECT id FROM mails WHERE account_id = ?1)",
            rusqlite::params![account_id],
        )?;
        conn.execute("DELETE FROM mails WHERE account_id = ?1", rusqlite::params![account_id])?;
        conn.execute("DELETE FROM folders WHERE account_id = ?1", rusqlite::params![account_id])?;
        conn.execute("DELETE FROM drafts WHERE account_id = ?1", rusqlite::params![account_id])?;
        conn.execute("DELETE FROM accounts WHERE id = ?1", rusqlite::params![account_id])?;
        Ok(())
    })();
    match tx_result {
        Ok(_) => { let _ = conn.execute_batch("COMMIT"); }
        Err(e) => {
            log::error!("Failed to delete account: {}", e);
            let _ = conn.execute_batch("ROLLBACK");
            return Err(format!("Failed to delete account: {}", e));
        }
    }

    // Reclaim disk space after bulk delete
    let _ = conn.execute_batch("VACUUM;");

    Ok(())
}

#[tauri::command(async)]
pub fn list_folders(
    db: State<'_, Database>,
    account_id: String,
) -> Result<Vec<Folder>, String> {
    let conn = db.read_db();
    list_folders_inner(&conn, &account_id)
}

/// Command body, separated so integration tests can run it against a fixture DB.
pub fn list_folders_inner(conn: &rusqlite::Connection, account_id: &str) -> Result<Vec<Folder>, String> {
    // The inbox counter follows what the inbox lists: without the starred mails it leaves to the Starred view.
    let unread = if crate::inbox_view::hides_starred(conn) {
        "CASE WHEN folder_type = 'inbox' THEN MAX(0, unread_count - (SELECT COUNT(*) FROM mails WHERE mails.folder_id = folders.id AND mails.is_read = 0 AND mails.is_starred = 1)) ELSE unread_count END"
    } else {
        "unread_count"
    };
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, account_id, name, folder_type, path, {unread}, total_count, COALESCE(is_local, 0) as is_local, COALESCE(color, '') as color FROM folders WHERE account_id = ?1 ORDER BY is_local ASC, CASE folder_type WHEN 'inbox' THEN 1 WHEN 'sent' THEN 2 WHEN 'drafts' THEN 3 WHEN 'archive' THEN 4 WHEN 'spam' THEN 5 WHEN 'trash' THEN 6 ELSE 7 END, name ASC",
        ))
        .map_err(|e| e.to_string())?;

    let folders = stmt
        .query_map(rusqlite::params![account_id], |row| {
            Ok(Folder {
                id: row.get(0)?,
                account_id: row.get(1)?,
                name: row.get(2)?,
                folder_type: row.get(3)?,
                path: row.get(4)?,
                unread_count: row.get(5)?,
                total_count: row.get(6)?,
                is_local: row.get::<_, i32>(7)? != 0,
                color: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(folders)
}

#[tauri::command(async)]
pub fn update_folder_color(
    db: State<'_, Database>,
    folder_id: String,
    color: String,
) -> Result<(), String> {
    let conn = db.lock_db();
    conn.execute(
        "UPDATE folders SET color = ?1 WHERE id = ?2",
        rusqlite::params![color, folder_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn test_imap_connection(
    host: String,
    port: i32,
    email: String,
    password: String,
    auth_type: Option<String>,
) -> Result<String, String> {
    let host = host.trim().to_string();
    let email = email.trim().to_string();
    let at = auth_type.as_deref().unwrap_or("password");
    crate::imap::test_connection_with_auth(&host, port as u16, &email, at, &password)
        .await
        .map_err(|e| {
            let msg = format!("{:#}", e);
            log::warn!("IMAP connection test to {}:{} failed: {}", host, port, msg);
            msg
        })
}

// The client only limits single reads, so a trickling server needs an overall deadline.
const POP3_TEST_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(serde::Serialize)]
pub struct Pop3TestResult {
    pub message_count: u32,
    pub supports_uidl: bool,
}

#[tauri::command]
pub async fn test_pop3_connection(
    host: String,
    port: u16,
    security: String,
    email: String,
    password: String,
) -> Result<Pop3TestResult, String> {
    let host = host.trim();
    let security: Pop3Security = security.parse().map_err(|e: Pop3Error| e.to_string())?;
    let connect = pop3::connect(host, port, security);
    pop3_test_within(POP3_TEST_TIMEOUT, connect, email.trim(), &password).await
}

async fn pop3_test_within<S: AsyncRead + AsyncWrite + Unpin>(
    limit: Duration,
    connect: impl Future<Output = Result<Pop3Client<S>, Pop3Error>>,
    email: &str,
    password: &str,
) -> Result<Pop3TestResult, String> {
    let test = async {
        let client = connect.await.map_err(pop3_test_error)?;
        test_pop3_connection_with_client(client, email, password).await
    };
    tokio::time::timeout(limit, test)
        .await
        .map_err(|_| pop3_test_error(Pop3Error::Timeout))?
}

async fn test_pop3_connection_with_client<S: AsyncRead + AsyncWrite + Unpin>(
    mut client: Pop3Client<S>,
    email: &str,
    password: &str,
) -> Result<Pop3TestResult, String> {
    client.capa().await.map_err(pop3_test_error)?;
    client.login(email, password).await.map_err(pop3_test_error)?;
    let uidls = client.uidl_all().await;
    // QUIT releases the maildrop lock; its outcome does not change the verdict.
    let _ = client.quit().await;
    Ok(Pop3TestResult {
        message_count: uidls.map_err(pop3_test_error)?.len() as u32,
        supports_uidl: true,
    })
}

fn pop3_error_kind(error: &Pop3Error) -> &'static str {
    match error {
        Pop3Error::Io(_) => "io",
        Pop3Error::Timeout => "timeout",
        Pop3Error::Tls(_) => "tls",
        Pop3Error::Auth(_) => "auth",
        Pop3Error::Protocol(_) => "protocol",
        Pop3Error::NoUidl => "no-uidl",
        Pop3Error::Locked(_) => "locked",
        Pop3Error::TooLarge(_) => "too-large",
        Pop3Error::Database(_) => "database",
        Pop3Error::Storage(_) => "storage",
        Pop3Error::NoInbox => "no-inbox",
    }
}

fn pop3_test_error(error: Pop3Error) -> String {
    log::warn!("POP3 connection test failed: {}", pop3_error_kind(&error));
    match error {
        Pop3Error::NoUidl => "POP3_NO_UIDL".into(),
        Pop3Error::Locked(_) => "POP3_LOCKED".into(),
        Pop3Error::Auth(text) => {
            let text = text.to_ascii_uppercase();
            if text.contains("[LOGIN-DELAY]") || text.contains("[SYS/TEMP]") {
                "the server refused the login for now, try again later".into()
            } else {
                "POP3_AUTH".into()
            }
        }
        other => other.to_string(),
    }
}

fn pop3_create_folder(db: &Database, account_id: &str, name: &str) -> Result<Folder, String> {
    insert_folder(&db.lock_db(), account_id, name, name, true)
}

/// Account of a folder the user made; the built-in ones stay as they are.
fn pop3_custom_folder(conn: &rusqlite::Connection, folder_id: &str) -> Result<String, String> {
    let (account_id, folder_type): (String, String) = conn
        .query_row(
            "SELECT account_id, folder_type FROM folders WHERE id = ?1",
            rusqlite::params![folder_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("Folder not found: {}", e))?;
    if folder_type != "custom" {
        return Err("System folders cannot be renamed or deleted.".into());
    }
    Ok(account_id)
}

fn pop3_rename_folder(db: &Database, folder_id: &str, new_name: &str) -> Result<(), String> {
    let conn = db.lock_db();
    pop3_custom_folder(&conn, folder_id)?;
    conn.execute(
        "UPDATE folders SET name = ?1, path = ?1 WHERE id = ?2",
        rusqlite::params![new_name, folder_id],
    )
    .map_err(|e| format!("Failed to rename folder: {}", e))?;
    Ok(())
}

/// Deletes the folder's mail for good.
fn pop3_delete_folder(db: &Database, folder_id: &str) -> Result<(), String> {
    let mail_ids: Vec<String> = {
        let conn = db.lock_db();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let account_id = pop3_custom_folder(&tx, folder_id)?;
        let mail_ids = tx
            .prepare("SELECT id FROM mails WHERE folder_id = ?1")
            .and_then(|mut stmt| {
                stmt.query_map(rusqlite::params![folder_id], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()
            })
            .map_err(|e| e.to_string())?;
        pop3_delete_rows(&tx, &account_id, &mail_ids)
            .and_then(|()| tx.execute("DELETE FROM folders WHERE id = ?1", rusqlite::params![folder_id]))
            .map_err(|e| format!("Failed to delete folder: {}", e))?;
        tx.commit().map_err(|e| e.to_string())?;
        mail_ids
    };
    pop3_remove_files(db, &mail_ids);
    Ok(())
}

fn insert_folder(
    conn: &rusqlite::Connection,
    account_id: &str,
    name: &str,
    path: &str,
    is_local: bool,
) -> Result<Folder, String> {
    let folder_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO folders (id, account_id, name, folder_type, path, is_local) VALUES (?1, ?2, ?3, 'custom', ?4, ?5)",
        rusqlite::params![folder_id, account_id, name, path, is_local as i32],
    )
    .map_err(|e| format!("Failed to create folder: {}", e))?;

    Ok(Folder {
        id: folder_id,
        account_id: account_id.to_string(),
        name: name.to_string(),
        folder_type: "custom".to_string(),
        path: path.to_string(),
        unread_count: 0,
        total_count: 0,
        is_local,
        color: String::new(),
    })
}

#[tauri::command]
pub async fn create_folder(
    db: State<'_, Database>,
    account_id: String,
    name: String,
    is_local: bool,
) -> Result<Folder, String> {
    if matches!(get_folder_api_type(&db, &account_id).0, FolderApiType::Pop3) {
        return pop3_create_folder(&db, &account_id, &name);
    }

    let path = if !is_local {
        let (api_type, provider, auth_type) = get_folder_api_type(&db, &account_id);
        let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
            .await
            .map_err(|e| format!("Failed to retrieve credentials: {}", e))?;

        match api_type {
            FolderApiType::Gmail => {
                let client = gmail::api::GmailClient::new(&credential);
                let label = client.create_label(&name).await
                    .map_err(|e| format!("Failed to create label: {}", e))?;
                label.id
            }
            FolderApiType::Outlook => {
                let client = outlook::api::OutlookClient::new(&credential);
                let folder = client.create_folder(&name).await
                    .map_err(|e| format!("Failed to create folder: {}", e))?;
                folder.id
            }
            FolderApiType::Imap => {
                let (imap_host, imap_port, email): (String, i32, String) = {
                    let conn = db.lock_db();
                    conn.query_row(
                        "SELECT imap_host, imap_port, email FROM accounts WHERE id = ?1",
                        rusqlite::params![account_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .map_err(|e| format!("Account not found: {}", e))?
                };
                let mut session = crate::imap::connect_with_auth(&imap_host, imap_port as u16, &email, &auth_type, &credential)
                    .await
                    .map_err(|e| format!("IMAP connection failed: {}", e))?;
                let result = crate::imap::create_folder(&mut session, &name).await;
                let _ = session.logout().await;
                result.map_err(|e| format!("Failed to create folder on server: {}", e))?
            }
            FolderApiType::Pop3 => return Err(POP3_NOT_SUPPORTED.into()),
        }
    } else {
        name.clone()
    };

    insert_folder(&db.lock_db(), &account_id, &name, &path, is_local)
}

#[tauri::command]
pub async fn delete_folder(
    db: State<'_, Database>,
    folder_id: String,
) -> Result<(), String> {
    let (account_id, path, is_local): (String, String, bool) = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT account_id, path, COALESCE(is_local, 0) FROM folders WHERE id = ?1",
            rusqlite::params![folder_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i32>(2)? != 0)),
        )
        .map_err(|e| format!("Folder not found: {}", e))?
    };

    if matches!(get_folder_api_type(&db, &account_id).0, FolderApiType::Pop3) {
        return pop3_delete_folder(&db, &folder_id);
    }

    if !is_local {
        let (api_type, provider, auth_type) = get_folder_api_type(&db, &account_id);
        let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
            .await
            .map_err(|e| format!("Failed to retrieve credentials: {}", e))?;

        match api_type {
            FolderApiType::Gmail => {
                // path = Gmail label ID
                let client = gmail::api::GmailClient::new(&credential);
                if let Err(e) = client.delete_label(&path).await {
                    log::warn!("Gmail delete label '{}' failed (may already be gone): {}", path, e);
                }
            }
            FolderApiType::Outlook => {
                // path = Graph folder ID
                let client = outlook::api::OutlookClient::new(&credential);
                if let Err(e) = client.delete_folder(&path).await {
                    log::warn!("Outlook delete folder '{}' failed (may already be gone): {}", path, e);
                }
            }
            FolderApiType::Imap => {
                let (imap_host, imap_port, email): (String, i32, String) = {
                    let conn = db.lock_db();
                    conn.query_row(
                        "SELECT imap_host, imap_port, email FROM accounts WHERE id = ?1",
                        rusqlite::params![account_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .map_err(|e| format!("Account not found: {}", e))?
                };
                let mut session = crate::imap::connect_with_auth(&imap_host, imap_port as u16, &email, &auth_type, &credential)
                    .await
                    .map_err(|e| format!("IMAP connection failed: {}", e))?;
                let result = crate::imap::delete_folder(&mut session, &path).await;
                let _ = session.logout().await;
                if let Err(e) = result {
                    log::warn!("IMAP delete folder '{}' failed (may already be gone): {}", path, e);
                }
            }
            FolderApiType::Pop3 => return Err(POP3_NOT_SUPPORTED.into()),
        }
    }

    let conn = db.lock_db();
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let tx_result = (|| -> Result<(), rusqlite::Error> {
        conn.execute(
            "DELETE FROM attachments WHERE mail_id IN (SELECT id FROM mails WHERE folder_id = ?1)",
            rusqlite::params![folder_id],
        )?;
        conn.execute("DELETE FROM mails WHERE folder_id = ?1", rusqlite::params![folder_id])?;
        conn.execute("DELETE FROM folders WHERE id = ?1", rusqlite::params![folder_id])?;
        Ok(())
    })();
    match tx_result {
        Ok(_) => { let _ = conn.execute_batch("COMMIT"); }
        Err(e) => {
            log::error!("Failed to delete folder: {}", e);
            let _ = conn.execute_batch("ROLLBACK");
            return Err(format!("Failed to delete folder: {}", e));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn rename_folder(
    db: State<'_, Database>,
    folder_id: String,
    new_name: String,
) -> Result<(), String> {
    let (account_id, old_path, is_local): (String, String, bool) = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT account_id, path, COALESCE(is_local, 0) FROM folders WHERE id = ?1",
            rusqlite::params![folder_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i32>(2)? != 0)),
        )
        .map_err(|e| format!("Folder not found: {}", e))?
    };

    if matches!(get_folder_api_type(&db, &account_id).0, FolderApiType::Pop3) {
        return pop3_rename_folder(&db, &folder_id, &new_name);
    }

    if !is_local {
        let (api_type, provider, auth_type) = get_folder_api_type(&db, &account_id);
        let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
            .await
            .map_err(|e| format!("Failed to retrieve credentials: {}", e))?;

        match api_type {
            FolderApiType::Gmail => {
                // path = Gmail label ID
                let client = gmail::api::GmailClient::new(&credential);
                client.rename_label(&old_path, &new_name).await
                    .map_err(|e| format!("Failed to rename label: {}", e))?;
            }
            FolderApiType::Outlook => {
                // path = Graph folder ID
                let client = outlook::api::OutlookClient::new(&credential);
                client.rename_folder(&old_path, &new_name).await
                    .map_err(|e| format!("Failed to rename folder: {}", e))?;
            }
            FolderApiType::Imap => {
                let (imap_host, imap_port, email): (String, i32, String) = {
                    let conn = db.lock_db();
                    conn.query_row(
                        "SELECT imap_host, imap_port, email FROM accounts WHERE id = ?1",
                        rusqlite::params![account_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .map_err(|e| format!("Account not found: {}", e))?
                };
                let mut session = crate::imap::connect_with_auth(&imap_host, imap_port as u16, &email, &auth_type, &credential)
                    .await
                    .map_err(|e| format!("IMAP connection failed: {}", e))?;
                let new_imap_path = if let Some(sep_pos) = old_path.rfind('.').or_else(|| old_path.rfind('/')) {
                    format!("{}{}", &old_path[..=sep_pos], new_name)
                } else {
                    new_name.clone()
                };
                let result = crate::imap::rename_folder(&mut session, &old_path, &new_imap_path).await;
                let _ = session.logout().await;
                result.map_err(|e| format!("Failed to rename folder on server: {}", e))?;
            }
            FolderApiType::Pop3 => return Err(POP3_NOT_SUPPORTED.into()),
        }
    }

    // For Gmail/Outlook the path (API ID) doesn't change on rename — only the display name changes.
    // For IMAP the path changes with the name.
    let (api_type, _, _) = get_folder_api_type(&db, &account_id);
    let new_path = match api_type {
        FolderApiType::Gmail | FolderApiType::Outlook => old_path,
        FolderApiType::Imap | FolderApiType::Pop3 => {
            if let Some(sep_pos) = old_path.rfind('.').or_else(|| old_path.rfind('/')) {
                format!("{}{}", &old_path[..=sep_pos], new_name)
            } else {
                new_name.clone()
            }
        }
    };

    let conn = db.lock_db();
    conn.execute(
        "UPDATE folders SET name = ?1, path = ?2 WHERE id = ?3",
        rusqlite::params![new_name, new_path, folder_id],
    )
    .map_err(|e| format!("Failed to rename folder: {}", e))?;

    Ok(())
}

#[derive(serde::Serialize)]
pub struct OAuthResult {
    pub email: String,
    pub access_token: String,
    pub refresh_token: String,
}

#[tauri::command]
pub async fn start_oauth(provider: String) -> Result<OAuthResult, String> {
    let tokens = crate::oauth::start_oauth_flow(&provider)
        .await
        .map_err(|e| e.to_string())?;
    Ok(OAuthResult {
        email: tokens.email,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
    })
}

#[cfg(test)]
mod replace_tests {
    use super::replaceable_id;
    use crate::test_support::{seed_account, temp_db};

    #[test]
    fn a_pop3_account_is_never_replaced() {
        let db = temp_db();
        let conn = db.lock_db();
        let id = seed_account(&conn, "anna@studio-halde.example");
        let replace = |protocol| replaceable_id(&conn, "anna@studio-halde.example", "imap", "password", protocol);
        assert_eq!(replace("imap"), Ok(Some(id)));
        conn.execute("UPDATE accounts SET incoming_protocol = 'pop3'", []).unwrap();
        assert_eq!(replace("pop3"), Err("POP3_ACCOUNT_EXISTS|anna@studio-halde.example".to_string()));
        assert_eq!(replaceable_id(&conn, "info@studio-halde.example", "imap", "password", "imap"), Ok(None));
    }

    #[test]
    fn same_email_with_another_protocol_conflicts() {
        let db = temp_db();
        let conn = db.lock_db();
        seed_account(&conn, "anna@studio-halde.example");
        let conflict = Err("EMAIL_PROVIDER_CONFLICT|anna@studio-halde.example|imap|password".to_string());
        let replace = |protocol| replaceable_id(&conn, "anna@studio-halde.example", "imap", "password", protocol);
        assert_eq!(replace("pop3"), conflict);
        conn.execute("UPDATE accounts SET incoming_protocol = 'pop3'", []).unwrap();
        assert_eq!(replace("imap"), conflict);
    }
}

#[cfg(test)]
mod pop3_account_tests {
    use super::{
        apply_incoming_settings, insert_account, list_accounts_inner, list_folders_inner,
        replaceable_id, trim_pop3_hosts, trim_pop3_request,
    };
    use crate::models::{CreateAccountRequest, UpdateAccountSettings};
    use crate::test_support::temp_db;

    fn request(protocol: Option<&str>) -> CreateAccountRequest {
        CreateAccountRequest {
            email: "anna@studio-halde.example".into(),
            display_name: "Anna Weber".into(),
            provider: "custom".into(),
            color: "#336699".into(),
            imap_host: "pop.studio-halde.example".into(),
            imap_port: 995,
            smtp_host: "smtp.studio-halde.example".into(),
            smtp_port: 465,
            smtp_security: "ssl".into(),
            password: "fictional".into(),
            auth_type: "password".into(),
            incoming_protocol: protocol.map(Into::into),
            incoming_security: None,
            pop3_delete_mode: None,
            pop3_delete_after_days: None,
            pop3_delete_with_local: None,
        }
    }

    fn padded(protocol: Option<&str>) -> CreateAccountRequest {
        let mut r = request(protocol);
        r.email = " anna@studio-halde.example ".into();
        r.imap_host = " pop.studio-halde.example	".into();
        r.smtp_host = "smtp.studio-halde.example ".into();
        r.password = " fictional ".into();
        r
    }

    #[test]
    fn pop3_request_is_trimmed_except_the_password() {
        let r = trim_pop3_request(padded(Some("pop3")));
        assert_eq!(r.email, "anna@studio-halde.example");
        assert_eq!(r.imap_host, "pop.studio-halde.example");
        assert_eq!(r.smtp_host, "smtp.studio-halde.example");
        assert_eq!(r.password, " fictional ");
    }

    #[test]
    fn imap_request_is_left_as_typed() {
        for protocol in [None, Some("imap")] {
            let r = trim_pop3_request(padded(protocol));
            assert_eq!(r.email, " anna@studio-halde.example ");
            assert_eq!(r.imap_host, " pop.studio-halde.example	");
            assert_eq!(r.smtp_host, "smtp.studio-halde.example ");
        }
    }

    #[test]
    fn padded_pop3_email_still_conflicts() {
        let db = temp_db();
        let conn = db.lock_db();
        insert_account(&conn, &request(None)).unwrap();
        let r = trim_pop3_request(padded(Some("pop3")));
        let error = replaceable_id(&conn, &r.email, &r.provider, &r.auth_type, "pop3").unwrap_err();
        assert!(error.starts_with("EMAIL_PROVIDER_CONFLICT|anna@studio-halde.example|"));
    }

    #[test]
    fn updated_hosts_are_trimmed_for_pop3_only() {
        let db = temp_db();
        let conn = db.lock_db();
        for (protocol, imap, smtp) in [
            ("pop3", "pop.studio-halde.example", "smtp.studio-halde.example"),
            ("imap", " pop.studio-halde.example ", " smtp.studio-halde.example "),
        ] {
            let mut r = request(Some(protocol));
            r.email = format!("{protocol}@studio-halde.example");
            let account = insert_account(&conn, &r).unwrap();
            let hosts = trim_pop3_hosts(
                &conn,
                &account.id,
                " pop.studio-halde.example ".into(),
                " smtp.studio-halde.example ".into(),
            );
            assert_eq!(hosts, (imap.to_string(), smtp.to_string()));
        }
    }

    #[test]
    fn create_pop3_account_creates_local_folders() {
        let db = temp_db();
        let conn = db.lock_db();
        let account = insert_account(&conn, &request(Some("pop3"))).unwrap();
        let folders = list_folders_inner(&conn, &account.id).unwrap();
        let rows: Vec<_> = folders.iter().map(|f| (f.folder_type.as_str(), f.path.as_str(), f.is_local)).collect();
        assert_eq!(
            rows,
            [
                ("inbox", "INBOX", false),
                ("sent", "Sent", false),
                ("drafts", "Drafts", false),
                ("archive", "Archive", false),
                ("trash", "Trash", false),
            ]
        );
        assert_eq!(list_accounts_inner(&conn).unwrap()[0].incoming_protocol, "pop3");
    }

    #[test]
    fn create_imap_account_creates_no_folders() {
        let db = temp_db();
        let conn = db.lock_db();
        let account = insert_account(&conn, &request(None)).unwrap();
        assert_eq!(account.incoming_protocol, "imap");
        assert!(list_folders_inner(&conn, &account.id).unwrap().is_empty());
    }

    #[test]
    fn new_pop3_account_deletes_after_14_days_and_with_local() {
        let db = temp_db();
        let conn = db.lock_db();
        insert_account(&conn, &request(Some("pop3"))).unwrap();
        let stored = list_accounts_inner(&conn).unwrap().remove(0);
        assert_eq!(stored.incoming_security, "ssl");
        assert_eq!(stored.pop3_delete_mode, "after_days");
        assert_eq!(stored.pop3_delete_after_days, 14);
        assert!(stored.pop3_delete_with_local);
    }

    #[test]
    fn create_pop3_rejects_invalid_delete_days() {
        let db = temp_db();
        let conn = db.lock_db();
        for days in [0, 366] {
            let mut r = request(Some("pop3"));
            r.pop3_delete_after_days = Some(days);
            assert!(insert_account(&conn, &r).is_err(), "{days}");
        }
        assert!(list_accounts_inner(&conn).unwrap().is_empty());
        for days in [1, 365] {
            let mut r = request(Some("pop3"));
            r.email = format!("anna{days}@studio-halde.example");
            r.pop3_delete_after_days = Some(days);
            assert!(insert_account(&conn, &r).is_ok(), "{days}");
        }
    }

    #[test]
    fn create_rejects_unknown_values() {
        let db = temp_db();
        let conn = db.lock_db();
        let mut protocol = request(Some("exchange"));
        protocol.auth_type = "password".into();
        let mut security = request(Some("pop3"));
        security.incoming_security = Some("none".into());
        let mut mode = request(Some("pop3"));
        mode.pop3_delete_mode = Some("never".into());
        for r in [protocol, security, mode] {
            assert!(insert_account(&conn, &r).is_err());
        }
        assert!(list_accounts_inner(&conn).unwrap().is_empty());
    }

    #[test]
    fn create_pop3_rejects_oauth() {
        let db = temp_db();
        let conn = db.lock_db();
        let mut r = request(Some("pop3"));
        r.auth_type = "oauth".into();
        assert!(insert_account(&conn, &r).is_err());
        assert!(list_accounts_inner(&conn).unwrap().is_empty());
    }

    #[test]
    fn update_rejects_protocol_change() {
        let db = temp_db();
        let conn = db.lock_db();
        for (stored, wanted) in [("imap", "pop3"), ("pop3", "imap")] {
            let mut r = request(Some(stored));
            r.email = format!("{stored}@studio-halde.example");
            let account = insert_account(&conn, &r).unwrap();
            let update = UpdateAccountSettings {
                incoming_protocol: Some(wanted.into()),
                pop3_delete_mode: Some("keep".into()),
                ..Default::default()
            };
            assert_eq!(
                apply_incoming_settings(&conn, &account.id, &update),
                Err("PROTOCOL_CHANGE_UNSUPPORTED".to_string())
            );
            let after = list_accounts_inner(&conn).unwrap().into_iter().find(|a| a.id == account.id).unwrap();
            assert_eq!((after.incoming_protocol.as_str(), after.pop3_delete_mode.as_str()), (stored, "after_days"));
        }
    }

    #[test]
    fn update_changes_pop3_delete_mode() {
        let db = temp_db();
        let conn = db.lock_db();
        let mut r = request(Some("pop3"));
        r.incoming_security = Some("starttls".into());
        r.pop3_delete_after_days = Some(30);
        let account = insert_account(&conn, &r).unwrap();
        let update = UpdateAccountSettings {
            incoming_protocol: Some("pop3".into()),
            pop3_delete_mode: Some("after_fetch".into()),
            ..Default::default()
        };
        apply_incoming_settings(&conn, &account.id, &update).unwrap();
        let after = list_accounts_inner(&conn).unwrap().remove(0);
        assert_eq!(after.pop3_delete_mode, "after_fetch");
        assert_eq!(after.incoming_security, "starttls");
        assert_eq!(after.pop3_delete_after_days, 30);
        assert!(after.pop3_delete_with_local);

        let update = UpdateAccountSettings {
            incoming_security: Some("ssl".into()),
            pop3_delete_after_days: Some(7),
            pop3_delete_with_local: Some(false),
            ..Default::default()
        };
        apply_incoming_settings(&conn, &account.id, &update).unwrap();
        let after = list_accounts_inner(&conn).unwrap().remove(0);
        assert_eq!(after.pop3_delete_mode, "after_fetch");
        assert_eq!(after.incoming_security, "ssl");
        assert_eq!(after.pop3_delete_after_days, 7);
        assert!(!after.pop3_delete_with_local);
    }

    #[test]
    fn update_rejects_invalid_pop3_values() {
        let db = temp_db();
        let conn = db.lock_db();
        let account = insert_account(&conn, &request(Some("pop3"))).unwrap();
        for update in [
            UpdateAccountSettings { pop3_delete_after_days: Some(0), ..Default::default() },
            UpdateAccountSettings { pop3_delete_after_days: Some(366), ..Default::default() },
            UpdateAccountSettings { pop3_delete_mode: Some("never".into()), ..Default::default() },
            UpdateAccountSettings { incoming_security: Some("none".into()), ..Default::default() },
        ] {
            assert!(apply_incoming_settings(&conn, &account.id, &update).is_err());
        }
        let after = list_accounts_inner(&conn).unwrap().remove(0);
        assert_eq!((after.pop3_delete_mode.as_str(), after.pop3_delete_after_days), ("after_days", 14));
        assert_eq!(after.incoming_security, "ssl");
    }
}

#[cfg(test)]
mod pop3_connection_tests {
    use std::sync::OnceLock;
    use std::time::Duration;

    use super::{
        pop3_error_kind, pop3_test_within, test_pop3_connection, test_pop3_connection_with_client,
        Pop3TestResult,
    };
    use crate::pop3::test_server::scripted;
    use crate::pop3::{Pop3Client, Pop3Error};

    const GREETING: (&str, &str) = ("", "+OK pop.studio-halde.example ready\r\n");
    const CAPA: (&str, &str) = ("CAPA", "+OK\r\nUIDL\r\n.\r\n");
    const EMAIL: &str = "anna@studio-halde.example";
    const USER: (&str, &str) = ("USER anna@studio-halde.example", "+OK\r\n");

    fn password() -> &'static str {
        static VALUE: OnceLock<String> = OnceLock::new();
        VALUE.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
    }

    fn pass_line() -> &'static str {
        static LINE: OnceLock<String> = OnceLock::new();
        LINE.get_or_init(|| format!("PASS {}", password()))
    }

    fn pass_ok() -> (&'static str, &'static str) {
        (pass_line(), "+OK logged in\r\n")
    }

    async fn run(steps: Vec<(&'static str, &'static str)>) -> Result<Pop3TestResult, String> {
        let mut script = vec![GREETING, CAPA];
        script.extend(steps);
        let (stream, server) = scripted(script);
        let client = Pop3Client::from_stream(stream).await.expect("greeting");
        let result = test_pop3_connection_with_client(client, EMAIL, password()).await;
        server.await.expect("server script");
        result
    }

    #[test]
    fn logged_error_kind_carries_no_server_text() {
        let reply = || "anna@studio-halde.example".to_string();
        for (error, kind) in [
            (Pop3Error::Io(reply()), "io"),
            (Pop3Error::Tls(reply()), "tls"),
            (Pop3Error::Auth(reply()), "auth"),
            (Pop3Error::Protocol(reply()), "protocol"),
            (Pop3Error::Locked(reply()), "locked"),
        ] {
            assert_eq!(pop3_error_kind(&error), kind);
        }
    }

    #[tokio::test]
    async fn pop3_test_reports_message_count() {
        let result = run(vec![
            USER,
            pass_ok(),
            ("UIDL", "+OK\r\n1 a1\r\n2 b2\r\n.\r\n"),
            ("QUIT", "+OK bye\r\n"),
        ])
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({ "message_count": 2, "supports_uidl": true })
        );
    }

    #[tokio::test]
    async fn pop3_test_reports_no_uidl() {
        let result = run(vec![
            USER,
            pass_ok(),
            ("UIDL", "-ERR unknown command\r\n"),
            ("QUIT", "+OK bye\r\n"),
        ])
        .await;
        assert_eq!(result.err().as_deref(), Some("POP3_NO_UIDL"));
    }

    #[tokio::test]
    async fn pop3_test_reports_auth_error() {
        let result = run(vec![USER, (pass_line(), "-ERR [AUTH] invalid\r\n")]).await;
        assert_eq!(result.err().as_deref(), Some("POP3_AUTH"));
    }

    #[tokio::test]
    async fn pop3_test_reports_locked_maildrop() {
        let result = run(vec![USER, (pass_line(), "-ERR [IN-USE] maildrop locked\r\n")]).await;
        assert_eq!(result.err().as_deref(), Some("POP3_LOCKED"));
    }

    #[tokio::test]
    async fn pop3_test_does_not_blame_the_password_for_a_temporary_refusal() {
        for reply in [
            "-ERR [LOGIN-DELAY] wait a few minutes\r\n",
            "-ERR [SYS/TEMP] try again later\r\n",
        ] {
            let error = run(vec![USER, (pass_line(), reply)]).await.err().unwrap();
            assert_eq!(error, "the server refused the login for now, try again later");
        }
    }

    #[tokio::test]
    async fn pop3_test_reports_other_failures_readably() {
        let error = run(vec![USER, (pass_line(), "<DROP>")]).await.err().unwrap();
        assert_eq!(error, "connection error: connection closed by the server");
    }

    #[tokio::test]
    async fn pop3_test_gives_up_on_a_silent_server() {
        let (stream, server) = scripted(vec![GREETING, ("CAPA", "")]);
        let result = pop3_test_within(
            Duration::from_millis(50),
            Pop3Client::from_stream(stream),
            EMAIL,
            password(),
        )
        .await;
        assert_eq!(result.err().as_deref(), Some("the server did not respond in time"));
        server.await.expect("server script");
    }

    #[tokio::test]
    async fn pop3_test_rejects_plaintext() {
        let result = test_pop3_connection(
            "pop.studio-halde.example".into(),
            110,
            "none".into(),
            EMAIL.into(),
            password().into(),
        )
        .await;
        assert_eq!(
            result.err().as_deref(),
            Some("unexpected server response: unknown security mode: none")
        );
    }
}

#[cfg(test)]
mod pop3_folder_tests {
    use super::{
        insert_account, list_folders_inner, pop3_create_folder, pop3_delete_folder, pop3_rename_folder,
    };
    use crate::db::Database;
    use crate::models::{CreateAccountRequest, Folder};
    use crate::pop3::store::source_path;
    use crate::test_support::{seed_mail, temp_db, SeedMail};

    fn pop3_account(db: &Database) -> String {
        let request = CreateAccountRequest {
            email: "anna@studio-halde.example".into(),
            display_name: "Anna Weber".into(),
            provider: "custom".into(),
            color: "#336699".into(),
            imap_host: "pop.studio-halde.example".into(),
            imap_port: 995,
            smtp_host: "smtp.studio-halde.example".into(),
            smtp_port: 465,
            smtp_security: "ssl".into(),
            password: uuid::Uuid::new_v4().to_string(),
            auth_type: "password".into(),
            incoming_protocol: Some("pop3".into()),
            incoming_security: None,
            pop3_delete_mode: None,
            pop3_delete_after_days: None,
            pop3_delete_with_local: None,
        };
        insert_account(&db.lock_db(), &request).unwrap().id
    }

    fn folders(db: &Database, account_id: &str) -> Vec<Folder> {
        list_folders_inner(&db.lock_db(), account_id).unwrap()
    }

    fn count(db: &Database, sql: &str) -> i64 {
        db.lock_db().query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn stored_mail(db: &Database, account_id: &str, folder_id: &str, uidl: Option<&str>) -> String {
        let id = seed_mail(&db.lock_db(), &SeedMail { account_id, folder_id, ..Default::default() });
        if let Some(uidl) = uidl {
            db.lock_db()
                .execute(
                    "INSERT INTO pop3_uidls (account_id, uidl, mail_id, state) VALUES (?1, ?2, ?3, 'stored')",
                    [account_id, uidl, id.as_str()],
                )
                .unwrap();
        }
        let source = source_path(&db.data_dir, &id);
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(source, b"Subject: Angebot\r\n\r\nHallo Anna").unwrap();
        std::fs::create_dir_all(db.data_dir.join("attachments").join(&id)).unwrap();
        id
    }

    #[test]
    fn pop3_create_folder_is_local() {
        let db = temp_db();
        let account = pop3_account(&db);
        let created = pop3_create_folder(&db, &account, "Studio Halde").unwrap();
        assert!(created.is_local);
        let stored = folders(&db, &account).into_iter().find(|f| f.id == created.id).unwrap();
        assert_eq!(
            (stored.path.as_str(), stored.folder_type.as_str(), stored.is_local),
            ("Studio Halde", "custom", true)
        );
        assert!(pop3_create_folder(&db, &account, "Studio Halde").is_err());
        assert_eq!(count(&db, "SELECT COUNT(*) FROM pending_ops"), 0);
    }

    #[test]
    fn pop3_rename_folder_is_local() {
        let db = temp_db();
        let account = pop3_account(&db);
        let created = pop3_create_folder(&db, &account, "Projekt v1.0").unwrap();
        pop3_rename_folder(&db, &created.id, "Angebote").unwrap();
        let stored = folders(&db, &account).into_iter().find(|f| f.id == created.id).unwrap();
        assert_eq!(
            (stored.name.as_str(), stored.path.as_str(), stored.is_local),
            ("Angebote", "Angebote", true)
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM pending_ops"), 0);
    }

    #[test]
    fn pop3_system_folders_are_protected() {
        let db = temp_db();
        let account = pop3_account(&db);
        for folder in folders(&db, &account) {
            let mail = stored_mail(&db, &account, &folder.id, Some(&folder.id));
            assert!(pop3_delete_folder(&db, &folder.id).is_err());
            assert!(pop3_rename_folder(&db, &folder.id, "Angebote").is_err());
            assert!(source_path(&db.data_dir, &mail).exists());
        }
        assert_eq!(folders(&db, &account).len(), 5);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM mails"), 5);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM pop3_uidls WHERE local_deleted_at IS NOT NULL"), 0);
    }

    #[test]
    fn pop3_delete_folder_marks_uidls() {
        let db = temp_db();
        let account = pop3_account(&db);
        let doomed = pop3_create_folder(&db, &account, "Angebote").unwrap().id;
        let inbox = folders(&db, &account).into_iter().find(|f| f.folder_type == "inbox").unwrap().id;
        let first = stored_mail(&db, &account, &doomed, Some("u1"));
        let second = stored_mail(&db, &account, &doomed, Some("u2"));
        let kept = stored_mail(&db, &account, &inbox, Some("u3"));
        let copy = stored_mail(&db, &account, &doomed, None);

        pop3_delete_folder(&db, &doomed).unwrap();

        assert!(folders(&db, &account).iter().all(|f| f.id != doomed));
        assert_eq!(count(&db, "SELECT COUNT(*) FROM mails"), 1);
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM pop3_uidls WHERE local_deleted_at IS NOT NULL AND uidl IN ('u1', 'u2')"),
            2
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM pop3_uidls WHERE local_deleted_at IS NULL AND uidl = 'u3'"),
            1
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM pending_ops"), 0);
        for id in [&first, &second, &copy] {
            assert!(!db.data_dir.join("attachments").join(id).exists());
        }
        for id in [&first, &second, &kept] {
            assert!(source_path(&db.data_dir, id).exists());
        }
        assert!(!source_path(&db.data_dir, &copy).exists());
        assert!(db.data_dir.join("attachments").join(&kept).exists());
    }
}
