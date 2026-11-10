use rusqlite::Connection;

/// The schema version that introduced the signature list.
pub(crate) const SINCE_SCHEMA: u32 = 48;

/// Table, column and the one-time takeover of the per-account signatures.
pub(crate) fn install(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS signatures (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            html TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )?;
    let tx = conn.unchecked_transaction()?;
    // Tied to creating the column: 1.8.3 resets user_version on every start.
    if tx.execute_batch("ALTER TABLE accounts ADD COLUMN signature_id TEXT").is_ok() {
        let ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM accounts ORDER BY created_at")?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for id in ids {
            adopt_account_signature(&tx, &id)?;
        }
    }
    tx.commit()
}

/// Turns the account's own signature columns into a list entry and assigns it.
/// `false` when the account already has an entry or its signature shows nothing.
pub(crate) fn adopt_account_signature(conn: &Connection, account_id: &str) -> rusqlite::Result<bool> {
    let (name, email, html, text, assigned): (String, String, String, String, Option<String>) = conn.query_row(
        "SELECT display_name, email, COALESCE(signature_html, ''), COALESCE(signature_text, ''), signature_id
         FROM accounts WHERE id = ?1",
        [account_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    let markup_shows = markup_shows(&html);
    if assigned.is_some() || (!markup_shows && text.trim().is_empty()) {
        return Ok(false);
    }
    let html = if markup_shows { html } else { markup_from_text(&text) };
    let name = if name.trim().is_empty() { email.as_str() } else { name.trim() };
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO signatures (id, name, html, text) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, name, html, text],
    )?;
    conn.execute("UPDATE accounts SET signature_id = ?1 WHERE id = ?2", rusqlite::params![id, account_id])?;
    Ok(true)
}

fn markup_shows(html: &str) -> bool {
    if html.to_ascii_lowercase().contains("<img") {
        return true;
    }
    let text = ammonia::Builder::empty()
        .clean_content_tags(std::collections::HashSet::from(["script", "style"]))
        .clean(html)
        .to_string();
    !text.replace("&nbsp;", " ").trim().is_empty()
}

// The list editor renders markup only; a signature kept as plain text would look empty there.
fn markup_from_text(text: &str) -> String {
    text.trim()
        .lines()
        .map(|line| {
            let line = line.trim_end();
            if line.is_empty() {
                "<div><br></div>".to_string()
            } else {
                format!("<div>{}</div>", line.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;"))
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn temp_db() -> Database {
        Database::new(std::env::temp_dir().join(format!("prudii-test-{}", uuid::Uuid::new_v4()))).unwrap()
    }

    fn account(db: &Database, name: &str, html: &str, text: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        db.lock_db()
            .execute(
                "INSERT INTO accounts (id, email, display_name, provider, imap_host, smtp_host, signature_html, signature_text)
                 VALUES (?1, ?2, ?3, 'custom', 'imap.studio-halde.example', 'smtp.studio-halde.example', ?4, ?5)",
                rusqlite::params![id, format!("{}@studio-halde.example", id), name, html, text],
            )
            .unwrap();
        id
    }

    fn entries(db: &Database) -> Vec<(String, String, String)> {
        let conn = db.lock_db();
        let mut stmt = conn.prepare("SELECT name, html, text FROM signatures ORDER BY name").unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        rows.map(Result::unwrap).collect()
    }

    #[test]
    fn an_account_signature_becomes_a_list_entry() {
        let db = temp_db();
        let id = account(&db, "Anna Weber", "<div>Anna Weber</div>", "Anna Weber");
        assert!(adopt_account_signature(&db.lock_db(), &id).unwrap());
        assert_eq!(entries(&db), [("Anna Weber".into(), "<div>Anna Weber</div>".into(), "Anna Weber".into())]);
        let (assigned, kept): (Option<String>, String) = db
            .lock_db()
            .query_row("SELECT signature_id, signature_html FROM accounts WHERE id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert!(assigned.is_some());
        assert_eq!(kept, "<div>Anna Weber</div>");
    }

    #[test]
    fn a_text_only_signature_becomes_markup_lines() {
        let db = temp_db();
        let id = account(&db, "Anna Weber", "", "Viele Grüße\n\nAnna & Team");
        assert!(adopt_account_signature(&db.lock_db(), &id).unwrap());
        assert_eq!(entries(&db)[0].1, "<div>Viele Grüße</div><div><br></div><div>Anna &amp; Team</div>");
        assert_eq!(entries(&db)[0].2, "Viele Grüße\n\nAnna & Team");
    }

    #[test]
    fn blank_markup_creates_no_entry() {
        let db = temp_db();
        for (html, text) in [("", ""), ("<div><br></div>", ""), ("  ", " \n ")] {
            let id = account(&db, "Anna Weber", html, text);
            assert!(!adopt_account_signature(&db.lock_db(), &id).unwrap());
        }
        assert!(entries(&db).is_empty());
    }

    #[test]
    fn an_image_only_signature_counts() {
        let db = temp_db();
        let id = account(&db, "Studio Halde", "<img src=\"data:image/png;base64,iVBORw0KGgo=\">", "");
        assert!(adopt_account_signature(&db.lock_db(), &id).unwrap());
    }

    #[test]
    fn an_assigned_account_is_left_alone() {
        let db = temp_db();
        let id = account(&db, "Anna Weber", "<div>Anna Weber</div>", "");
        assert!(adopt_account_signature(&db.lock_db(), &id).unwrap());
        assert!(!adopt_account_signature(&db.lock_db(), &id).unwrap());
        assert_eq!(entries(&db).len(), 1);
    }

    #[test]
    fn a_nameless_account_lends_its_address() {
        let db = temp_db();
        let id = account(&db, "  ", "<div>Hi</div>", "");
        adopt_account_signature(&db.lock_db(), &id).unwrap();
        assert_eq!(entries(&db)[0].0, format!("{}@studio-halde.example", id));
    }
}
