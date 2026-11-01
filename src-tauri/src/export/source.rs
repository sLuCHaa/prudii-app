use crate::commands::mails::{get_api_message_id, get_api_type, ApiType};
use crate::credentials;
use crate::db::Database;
use crate::gmail;
use crate::imap;
use crate::outlook;
use crate::pool::ImapPool;

pub fn display_source(raw: Vec<u8>) -> String {
    match String::from_utf8(raw) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    }
}

pub async fn fetch_raw_message(db: &Database, pool: &ImapPool, mail_id: &str) -> Result<Vec<u8>, String> {
    if let Some((api_msg_id, account_id)) = get_api_message_id(db, mail_id) {
        let (api_type, provider, auth_type) = get_api_type(db, &account_id);
        match api_type {
            ApiType::Gmail => {
                let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
                    .await
                    .map_err(|e| format!("Credentials: {}", e))?;
                let client = gmail::api::GmailClient::new(&credential);
                let msg = client
                    .get_message(&api_msg_id, "raw")
                    .await
                    .map_err(|e| format!("Gmail source fetch: {}", e))?;
                let raw = msg.raw.ok_or_else(|| "Gmail returned no source".to_string())?;
                return gmail::api::decode_base64url(&raw).map_err(|e| format!("Gmail source decode: {}", e));
            }
            ApiType::Outlook => {
                let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
                    .await
                    .map_err(|e| format!("Credentials: {}", e))?;
                let client = outlook::api::OutlookClient::new(&credential);
                return client
                    .get_message_raw(&api_msg_id)
                    .await
                    .map_err(|e| format!("Outlook source fetch: {}", e));
            }
            ApiType::Imap => {}
        }
    }

    let (account_id, folder_path, uid): (String, String, u32) = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT m.account_id, f.path, m.uid FROM mails m JOIN folders f ON m.folder_id = f.id WHERE m.id = ?1",
            rusqlite::params![mail_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, u32>(2)?)),
        )
        .map_err(|e| format!("Mail not found: {}", e))?
    };

    let (imap_host, imap_port, email, auth_type, provider): (String, i32, String, String, String) = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT imap_host, imap_port, email, auth_type, provider FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(|e| format!("Account not found: {}", e))?
    };

    let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
        .await
        .map_err(|e| format!("Failed to retrieve credentials: {}", e))?;

    let (mut session, _pool_folder) = pool
        .get_session_with_folder(&account_id, &imap_host, imap_port as u16, &email, &credential, &auth_type)
        .await
        .map_err(|e| format!("IMAP connection failed: {}", e))?;

    let skip_examine = session.selected_folder() == Some(folder_path.as_str());
    let result = imap::fetch_mail_source(&mut session, &folder_path, uid, skip_examine).await;

    match &result {
        Ok(_) => pool.return_session_in_folder(&account_id, session, folder_path.clone()).await,
        Err(_) => {
            let _ = session.logout().await;
            pool.release(&account_id);
        }
    }

    result.map_err(|e| format!("Failed to fetch mail source: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_source_keeps_bytes_lossless_until_display() {
        let raw = b"Subject: Gr\xfc\xdfe\r\n\r\nHallo".to_vec();
        assert_eq!(display_source(raw.clone()), String::from_utf8_lossy(&raw));
    }
}
