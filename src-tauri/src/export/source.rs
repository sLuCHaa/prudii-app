use crate::commands::mails::{get_api_message_id, get_api_type, ApiType};
use crate::credentials;
use crate::db::Database;
use crate::gmail;
use crate::imap;
use crate::outlook;
use crate::pool::ImapPool;

const AUTH_MARKERS: [&str; 5] = ["401 Unauthorized", "Login failed", "XOAUTH2 auth failed", "AUTHENTICATIONFAILED", "invalid_grant"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchError {
    pub message: String,
    pub auth: bool,
}

impl FetchError {
    fn credentials(err: &anyhow::Error) -> Self {
        Self { message: format!("Credentials: {err:#}"), auth: true }
    }

    fn from_error(context: &str, err: &anyhow::Error) -> Self {
        let message = format!("{context}: {err:#}");
        let auth = AUTH_MARKERS.iter().any(|m| message.contains(m));
        Self { message, auth }
    }
}

impl From<String> for FetchError {
    fn from(message: String) -> Self {
        Self { message, auth: false }
    }
}

impl From<&str> for FetchError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub fn display_source(raw: Vec<u8>) -> String {
    match String::from_utf8(raw) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    }
}

pub async fn fetch_raw_message(db: &Database, pool: &ImapPool, mail_id: &str) -> Result<Vec<u8>, FetchError> {
    if let Some((api_msg_id, account_id)) = get_api_message_id(db, mail_id) {
        let (api_type, provider, auth_type) = get_api_type(db, &account_id);
        match api_type {
            ApiType::Gmail => {
                let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
                    .await
                    .map_err(|e| FetchError::credentials(&e))?;
                let client = gmail::api::GmailClient::new(&credential);
                let msg = client
                    .get_message(&api_msg_id, "raw")
                    .await
                    .map_err(|e| FetchError::from_error("Gmail source fetch", &e))?;
                let raw = msg.raw.ok_or_else(|| FetchError::from("Gmail returned no source"))?;
                return gmail::api::decode_base64url(&raw).map_err(|e| FetchError::from_error("Gmail source decode", &e));
            }
            ApiType::Outlook => {
                let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
                    .await
                    .map_err(|e| FetchError::credentials(&e))?;
                let client = outlook::api::OutlookClient::new(&credential);
                return client
                    .get_message_raw(&api_msg_id)
                    .await
                    .map_err(|e| FetchError::from_error("Outlook source fetch", &e));
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
        .map_err(|e| FetchError::from(format!("Mail not found: {}", e)))?
    };

    let (imap_host, imap_port, email, auth_type, provider): (String, i32, String, String, String) = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT imap_host, imap_port, email, auth_type, provider FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(|e| FetchError::from(format!("Account not found: {}", e)))?
    };

    let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
        .await
        .map_err(|e| FetchError::credentials(&e))?;

    let (mut session, _pool_folder) = pool
        .get_session_with_folder(&account_id, &imap_host, imap_port as u16, &email, &credential, &auth_type)
        .await
        .map_err(|e| FetchError::from_error("IMAP connection failed", &e))?;

    let skip_examine = session.selected_folder() == Some(folder_path.as_str());
    let result = imap::fetch_mail_source(&mut session, &folder_path, uid, skip_examine).await;

    match &result {
        Ok(_) => pool.return_session_in_folder(&account_id, session, folder_path.clone()).await,
        Err(_) => {
            let _ = session.logout().await;
            pool.release(&account_id);
        }
    }

    result.map_err(|e| FetchError::from_error("Failed to fetch mail source", &e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_source_keeps_bytes_lossless_until_display() {
        let raw = b"Subject: Gr\xfc\xdfe\r\n\r\nHallo".to_vec();
        assert_eq!(display_source(raw.clone()), String::from_utf8_lossy(&raw));
    }

    #[test]
    fn auth_failures_are_told_apart_from_other_errors() {
        let auth = [
            anyhow::anyhow!("get_message 18f2 failed (401 Unauthorized): {{}}"),
            anyhow::anyhow!("Login failed: a1 NO [AUTHENTICATIONFAILED] Invalid credentials"),
            anyhow::anyhow!("XOAUTH2 auth failed: a1 NO"),
            anyhow::anyhow!("token refresh failed").context("{\"error\":\"invalid_grant\"}"),
        ];
        for e in &auth {
            assert!(FetchError::from_error("fetch", e).auth, "{e:#}");
        }
        let other = [
            anyhow::anyhow!("get_message 18f2 failed (404 Not Found): {{}}"),
            anyhow::anyhow!("get_message 18f2 failed (403 Forbidden): rateLimitExceeded"),
            anyhow::anyhow!("IMAP read timed out"),
        ];
        for e in &other {
            assert!(!FetchError::from_error("fetch", e).auth, "{e:#}");
        }
        assert!(FetchError::credentials(&anyhow::anyhow!("no keyring entry")).auth);
        assert!(!FetchError::from("offline").auth);
        assert_eq!(FetchError::from_error("Gmail source fetch", &anyhow::anyhow!("boom")).to_string(), "Gmail source fetch: boom");
    }
}
