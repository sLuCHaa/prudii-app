use crate::credentials;
use crate::db::Database;
use crate::gmail;
use crate::outlook;
use crate::models::{Account, CreateAccountRequest, Folder};
use tauri::State;

/// API type for an account — determines which backend to use for folder operations.
enum FolderApiType { Gmail, Outlook, Imap }

fn get_folder_api_type(db: &Database, account_id: &str) -> (FolderApiType, String, String) {
    let conn = db.lock_db();
    let result: Result<(String, String), _> = conn.query_row(
        "SELECT provider, auth_type FROM accounts WHERE id = ?1",
        rusqlite::params![account_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    );
    match result {
        Ok((provider, auth_type)) => {
            let api = if provider == "google" && auth_type == "oauth" {
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

#[tauri::command]
pub fn list_accounts(db: State<'_, Database>) -> Result<Vec<Account>, String> {
    let conn = db.lock_db();
    let mut stmt = conn
        .prepare(
            "SELECT id, email, display_name, provider, color, imap_host, imap_port, smtp_host, smtp_port, COALESCE(smtp_security, 'ssl') as smtp_security, auth_type, COALESCE(signature_html, '') as signature_html, COALESCE(signature_text, '') as signature_text, COALESCE(signature_on_compose, 1) as signature_on_compose, COALESCE(signature_on_reply, 1) as signature_on_reply, COALESCE(sync_interval_minutes, 0) as sync_interval_minutes, COALESCE(load_external_images, 'always') as load_external_images, created_at, updated_at FROM accounts ORDER BY created_at ASC",
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
                signature_html: row.get(11)?,
                signature_text: row.get(12)?,
                signature_on_compose: row.get::<_, i32>(13)? != 0,
                signature_on_reply: row.get::<_, i32>(14)? != 0,
                sync_interval_minutes: row.get(15)?,
                load_external_images: row.get(16)?,
                created_at: row.get(17)?,
                updated_at: row.get(18)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(accounts)
}

#[tauri::command]
pub fn create_account(
    db: State<'_, Database>,
    request: CreateAccountRequest,
) -> Result<Account, String> {
    let conn = db.lock_db();

    // Check for existing account with the same email.
    // - Same provider + auth_type → re-add after failed attempt: clean up and replace.
    // - Different provider/auth_type → reject with a clear error so users notice that
    //   their OAuth provider returned an email belonging to an existing account
    //   (e.g. Outlook configured with a Gmail address as primary).
    let existing: Option<(String, String, String)> = conn
        .query_row(
            "SELECT id, provider, auth_type FROM accounts WHERE email = ?1",
            rusqlite::params![request.email],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok();
    if let Some((old_id, old_provider, old_auth_type)) = existing {
        if old_provider != request.provider || old_auth_type != request.auth_type {
            return Err(format!(
                "EMAIL_PROVIDER_CONFLICT|{}|{}|{}",
                request.email, old_provider, old_auth_type
            ));
        }
        log::info!("Cleaning up existing account {} before re-add (same provider)", old_id);
        if let Err(e) = credentials::delete_password(&old_id) {
            log::warn!("Failed to delete credentials for {}: {}", old_id, e);
        }
        conn.execute_batch("BEGIN").map_err(|e| format!("Failed to start cleanup transaction: {}", e))?;
        for (table, query) in [
            ("mails_fts", "DELETE FROM mails_fts WHERE mail_id IN (SELECT id FROM mails WHERE account_id = ?1)"),
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

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

    conn.execute(
        "INSERT INTO accounts (id, email, display_name, provider, color, imap_host, imap_port, smtp_host, smtp_port, smtp_security, auth_type, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![id, request.email, request.display_name, request.provider, request.color, request.imap_host, request.imap_port, request.smtp_host, request.smtp_port, request.smtp_security, request.auth_type, now, now],
    )
    .map_err(|e| e.to_string())?;

    drop(conn);

    // Store password in system credential manager (mandatory — no plaintext DB fallback)
    credentials::store_password(&id, &request.password)
        .map_err(|e| format!("Failed to store password in credential manager: {}", e))?;

    Ok(Account {
        id,
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
        signature_html: String::new(),
        signature_text: String::new(),
        signature_on_compose: true,
        signature_on_reply: true,
        sync_interval_minutes: 5,
        load_external_images: "always".to_string(),
        created_at: now.clone(),
        updated_at: now,
    })
}

/// Re-store a password in the system credential manager for an existing account.
/// Used when the keyring entry is missing (e.g., after migration from plaintext storage).
#[tauri::command]
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

    credentials::store_password(&account_id, &password)
        .map_err(|e| format!("Failed to store password: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn update_account_signature(
    db: State<'_, Database>,
    account_id: String,
    signature_html: String,
    signature_text: String,
    signature_on_compose: bool,
    signature_on_reply: bool,
) -> Result<(), String> {
    super::catch_panic(|| {
        let conn = db.lock_db();
        let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

        // Sanitize signature HTML: strip scripts, event handlers, iframes, etc.
        let clean_html = ammonia::Builder::new()
            .tags(std::collections::HashSet::from([
                "div", "span", "p", "br", "hr",
                "b", "i", "u", "s", "em", "strong", "small", "sub", "sup",
                "h1", "h2", "h3", "h4", "h5", "h6",
                "ul", "ol", "li",
                "table", "thead", "tbody", "tr", "th", "td",
                "img", "a", "font", "blockquote", "pre", "code",
            ]))
            .tag_attributes(std::collections::HashMap::from([
                ("a", std::collections::HashSet::from(["href", "target"])),
                ("img", std::collections::HashSet::from(["src", "alt", "width", "height"])),
                ("font", std::collections::HashSet::from(["color", "face", "size"])),
                ("td", std::collections::HashSet::from(["colspan", "rowspan", "align", "valign"])),
                ("th", std::collections::HashSet::from(["colspan", "rowspan", "align", "valign"])),
                ("table", std::collections::HashSet::from(["border", "cellpadding", "cellspacing"])),
            ]))
            .generic_attributes(std::collections::HashSet::from(["style", "class", "id"]))
            .url_schemes(std::collections::HashSet::from(["http", "https", "mailto", "data"]))
            .link_rel(Some("noopener noreferrer"))
            .clean(&signature_html)
            .to_string();

        conn.execute(
            "UPDATE accounts SET signature_html = ?1, signature_text = ?2, signature_on_compose = ?3, signature_on_reply = ?4, updated_at = ?5 WHERE id = ?6",
            rusqlite::params![clean_html, signature_text, signature_on_compose as i32, signature_on_reply as i32, now, account_id],
        )
        .map_err(|e| format!("Failed to update signature: {}", e))?;

        Ok(())
    })
}

#[tauri::command]
pub fn update_account_sync_interval(
    db: State<'_, Database>,
    account_id: String,
    sync_interval_minutes: i32,
) -> Result<(), String> {
    super::catch_panic(|| {
        if sync_interval_minutes < 0 || sync_interval_minutes > 1440 {
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

#[tauri::command]
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

        conn.execute(
            "UPDATE accounts SET display_name = ?1, color = ?2, imap_host = ?3, imap_port = ?4, smtp_host = ?5, smtp_port = ?6, smtp_security = ?7, load_external_images = ?8, updated_at = ?9 WHERE id = ?10",
            rusqlite::params![display_name, color, imap_host, imap_port, smtp_host, smtp_port, smtp_security, load_external_images, now, account_id],
        )
        .map_err(|e| format!("Failed to update account settings: {}", e))?;

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
            "DELETE FROM mails_fts WHERE mail_id IN (SELECT id FROM mails WHERE account_id = ?1)",
            rusqlite::params![account_id],
        )?;
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

#[tauri::command]
pub fn list_folders(
    db: State<'_, Database>,
    account_id: String,
) -> Result<Vec<Folder>, String> {
    let conn = db.lock_db();
    let mut stmt = conn
        .prepare(
            "SELECT id, account_id, name, folder_type, path, unread_count, total_count, COALESCE(is_local, 0) as is_local, COALESCE(color, '') as color FROM folders WHERE account_id = ?1 ORDER BY is_local ASC, CASE folder_type WHEN 'inbox' THEN 1 WHEN 'sent' THEN 2 WHEN 'drafts' THEN 3 WHEN 'archive' THEN 4 WHEN 'spam' THEN 5 WHEN 'trash' THEN 6 ELSE 7 END, name ASC",
        )
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

#[tauri::command]
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
        .map_err(|e| format!("{:#}", e))
}

#[tauri::command]
pub async fn create_folder(
    db: State<'_, Database>,
    account_id: String,
    name: String,
    is_local: bool,
) -> Result<Folder, String> {
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
        }
    } else {
        name.clone()
    };

    let folder_id = uuid::Uuid::new_v4().to_string();

    {
        let conn = db.lock_db();
        conn.execute(
            "INSERT INTO folders (id, account_id, name, folder_type, path, is_local) VALUES (?1, ?2, ?3, 'custom', ?4, ?5)",
            rusqlite::params![folder_id, account_id, name, path, is_local as i32],
        )
        .map_err(|e| format!("Failed to create folder: {}", e))?;
    }

    Ok(Folder {
        id: folder_id,
        account_id,
        name,
        folder_type: "custom".to_string(),
        path,
        unread_count: 0,
        total_count: 0,
        is_local,
        color: String::new(),
    })
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
        }
    }

    let conn = db.lock_db();
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let tx_result = (|| -> Result<(), rusqlite::Error> {
        conn.execute(
            "DELETE FROM mails_fts WHERE mail_id IN (SELECT id FROM mails WHERE folder_id = ?1)",
            rusqlite::params![folder_id],
        )?;
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
        }
    }

    // For Gmail/Outlook the path (API ID) doesn't change on rename — only the display name changes.
    // For IMAP the path changes with the name.
    let (api_type, _, _) = get_folder_api_type(&db, &account_id);
    let new_path = match api_type {
        FolderApiType::Gmail | FolderApiType::Outlook => old_path,
        FolderApiType::Imap => {
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
