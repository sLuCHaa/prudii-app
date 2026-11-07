//! Server-side search for Gmail and Outlook accounts. Their bodies are fetched
//! only when a mail is opened, so the local index never sees the text of
//! unopened mails — the provider's own search does. Hits are mapped onto the
//! headers that are already synced locally, so nothing new is downloaded.

use std::collections::HashSet;
use std::time::Duration;

use rusqlite::types::ToSql;
use tauri::State;

use crate::db::Database;
use crate::gmail::api::GmailClient;
use crate::models::SearchResult;
use crate::outlook::api::OutlookClient;

pub use crate::gmail::api::search_url as gmail_search_url;
pub use crate::outlook::api::search_url as graph_search_url;

const MAX_HITS: u32 = 100;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Local mails for the ids a server search returned, newest first. Outlook
/// ids change when a mail moves, so its internet Message-ID (kept in
/// `references`) is matched as well. A Gmail message filed under several
/// labels is listed once, preferring the inbox copy.
pub fn resolve_remote_hits(
    conn: &rusqlite::Connection,
    account_id: &str,
    api_ids: &[String],
    internet_ids: &[String],
) -> Result<Vec<SearchResult>, String> {
    if api_ids.is_empty() && internet_ids.is_empty() {
        return Ok(Vec::new());
    }

    fn placeholders<'a>(ids: &'a [String], params: &mut Vec<&'a dyn ToSql>) -> String {
        let start = params.len() + 1;
        for id in ids {
            params.push(id);
        }
        (start..start + ids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",")
    }

    let mut params: Vec<&dyn ToSql> = vec![&account_id];
    let mut matches = Vec::new();
    if !api_ids.is_empty() {
        matches.push(format!("m.message_id IN ({})", placeholders(api_ids, &mut params)));
    }
    if !internet_ids.is_empty() {
        matches.push(format!("m.\"references\" IN ({})", placeholders(internet_ids, &mut params)));
    }

    let sql = format!(
        "SELECT m.id, COALESCE(m.subject, ''), COALESCE(m.snippet, ''), COALESCE(m.from_name, ''),
                COALESCE(m.from_email, ''), COALESCE(m.date, ''), m.folder_id, COALESCE(f.name, ''),
                m.is_read, m.has_attachments, COALESCE(NULLIF(m.message_id, ''), m.id)
         FROM mails m
         LEFT JOIN folders f ON f.id = m.folder_id
         WHERE m.account_id = ?1 AND ({})
         ORDER BY CASE f.folder_type WHEN 'inbox' THEN 0 ELSE 1 END, m.date DESC",
        matches.join(" OR ")
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params.as_slice(), |row| {
            Ok((
                SearchResult {
                    mail_id: row.get(0)?,
                    subject: row.get(1)?,
                    snippet: row.get(2)?,
                    from_name: row.get(3)?,
                    from_email: row.get(4)?,
                    date: row.get(5)?,
                    folder_id: row.get(6)?,
                    folder_name: row.get(7)?,
                    is_read: row.get::<_, i32>(8)? != 0,
                    has_attachments: row.get::<_, i32>(9)? != 0,
                    rank: 0.0,
                },
                row.get::<_, String>(10)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut seen = HashSet::new();
    let mut hits: Vec<SearchResult> = rows
        .into_iter()
        .filter(|(_, key)| seen.insert(key.clone()))
        .map(|(hit, _)| hit)
        .collect();
    hits.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(hits)
}

/// Ask Gmail and Outlook for mails matching `query`. Accounts that cannot be
/// reached (offline, expired sign-in, throttled) are skipped, so the local
/// results always stand on their own.
#[tauri::command]
pub async fn search_mails_remote(
    db: State<'_, Database>,
    query: String,
    account_id: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    let query = query.trim().to_string();
    if query.chars().count() < 2 {
        return Ok(Vec::new());
    }

    let accounts: Vec<(String, String, String)> = {
        let conn = db.read_db();
        let mut stmt = conn
            .prepare(
                "SELECT id, provider, auth_type FROM accounts
                 WHERE auth_type = 'oauth' AND provider IN ('google', 'microsoft')
                   AND (?1 IS NULL OR id = ?1)",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![account_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    if accounts.is_empty() {
        return Ok(Vec::new());
    }

    let searches = accounts.into_iter().map(|(id, provider, auth_type)| {
        let query = query.clone();
        async move {
            let outcome = tokio::time::timeout(SEARCH_TIMEOUT, server_ids(&id, &provider, &auth_type, &query)).await;
            (id, provider, outcome)
        }
    });
    let outcomes = futures_util::future::join_all(searches).await;

    let conn = db.read_db();
    let mut hits = Vec::new();
    for (id, provider, outcome) in outcomes {
        match outcome {
            Ok(Ok((api_ids, internet_ids))) => hits.extend(resolve_remote_hits(&conn, &id, &api_ids, &internet_ids)?),
            Ok(Err(e)) => log::warn!("Server search failed for a {} account: {:#}", provider, e),
            Err(_) => log::warn!("Server search timed out for a {} account", provider),
        }
    }
    hits.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(hits)
}

async fn server_ids(
    account_id: &str,
    provider: &str,
    auth_type: &str,
    query: &str,
) -> anyhow::Result<(Vec<String>, Vec<String>)> {
    let credential = crate::credentials::resolve_credential(account_id, auth_type, provider).await?;
    if provider == "google" {
        let ids = GmailClient::new(&credential).search_message_ids(query, MAX_HITS).await?;
        Ok((ids, Vec::new()))
    } else {
        let found = OutlookClient::new(&credential).search_messages(query, MAX_HITS).await?;
        let internet_ids = found.iter().filter_map(|h| h.internet_message_id.clone()).collect();
        Ok((found.into_iter().map(|h| h.id).collect(), internet_ids))
    }
}
