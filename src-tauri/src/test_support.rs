use crate::db::Database;
use rusqlite::Connection;

pub fn temp_db() -> Database {
    Database::new(std::env::temp_dir().join(format!("prudii-test-{}", uuid::Uuid::new_v4()))).unwrap()
}

pub fn seed_account(conn: &Connection, email: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO accounts (id, email, display_name, provider, imap_host, smtp_host) VALUES (?1, ?2, ?2, 'imap', 'imap.studio-halde.example', 'smtp.studio-halde.example')",
        rusqlite::params![id, email],
    )
    .unwrap();
    id
}

pub fn seed_folder(conn: &Connection, account_id: &str, folder_type: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO folders (id, account_id, name, folder_type, path) VALUES (?1, ?2, ?3, ?3, ?3)",
        rusqlite::params![id, account_id, folder_type],
    )
    .unwrap();
    id
}

#[derive(Default)]
pub struct SeedMail<'a> {
    pub account_id: &'a str,
    pub folder_id: &'a str,
    pub from_email: &'a str,
    pub subject: &'a str,
    pub to_json: &'a str,
    pub list_unsubscribe: &'a str,
    pub signal_headers: &'a str,
    pub thread_id: Option<&'a str>,
    pub date: &'a str,
    pub category: Option<&'a str>,
    pub category_source: Option<&'a str>,
}

pub fn seed_mail(conn: &Connection, m: &SeedMail) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let to_json = if m.to_json.is_empty() { "[]" } else { m.to_json };
    let date = if m.date.is_empty() { "2026-01-01 00:00:00" } else { m.date };
    conn.execute(
        "INSERT INTO mails (id, account_id, folder_id, from_email, subject, to_json, list_unsubscribe, signal_headers, thread_id, date, category, category_source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULLIF(?7, ''), NULLIF(?8, ''), ?9, ?10, ?11, ?12)",
        rusqlite::params![
            id, m.account_id, m.folder_id, m.from_email, m.subject, to_json,
            m.list_unsubscribe, m.signal_headers, m.thread_id, date, m.category, m.category_source
        ],
    )
    .unwrap();
    id
}
