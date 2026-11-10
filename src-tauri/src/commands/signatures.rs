use crate::db::Database;
use crate::models::Signature;
use rusqlite::Connection;
use tauri::State;
use uuid::Uuid;

/// Strips scripts, event handlers, iframes and the like from signature markup.
pub(crate) fn clean_signature_html(html: &str) -> String {
    ammonia::Builder::new()
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
        .clean(html)
        .to_string()
}

const COLUMNS: &str = "id, name, html, text, created_at, updated_at";

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Signature> {
    Ok(Signature {
        id: row.get(0)?,
        name: row.get(1)?,
        html: row.get(2)?,
        text: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn find(conn: &Connection, id: &str) -> Result<Signature, String> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM signatures WHERE id = ?1"), [id], from_row)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => "Signature not found".to_string(),
            other => other.to_string(),
        })
}

pub fn list_signatures_inner(conn: &Connection) -> Result<Vec<Signature>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLUMNS} FROM signatures ORDER BY name COLLATE NOCASE ASC, created_at ASC"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], from_row).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Creates (`id` = None) or updates a signature and makes `account_ids` the accounts that use it.
pub fn save_signature_inner(
    conn: &Connection,
    id: Option<&str>,
    name: &str,
    html: &str,
    text: &str,
    account_ids: &[String],
) -> Result<Signature, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("SIGNATURE_NAME_REQUIRED".into());
    }
    let html = clean_signature_html(html);
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let id = match id {
        Some(id) => {
            let updated = tx
                .execute(
                    "UPDATE signatures SET name = ?1, html = ?2, text = ?3, updated_at = datetime('now') WHERE id = ?4",
                    rusqlite::params![name, html, text, id],
                )
                .map_err(|e| e.to_string())?;
            if updated == 0 {
                return Err("Signature not found".into());
            }
            id.to_string()
        }
        None => {
            let id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO signatures (id, name, html, text) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![id, name, html, text],
            )
            .map_err(|e| e.to_string())?;
            id
        }
    };
    tx.execute("UPDATE accounts SET signature_id = NULL WHERE signature_id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    for account_id in account_ids {
        tx.execute("UPDATE accounts SET signature_id = ?1 WHERE id = ?2", rusqlite::params![id, account_id])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    find(conn, &id)
}

/// Copies inside the database, so embedded images never pass through the editor's shortened view.
pub fn duplicate_signature_inner(conn: &Connection, id: &str, copy_name: &str) -> Result<Signature, String> {
    let copy_id = Uuid::new_v4().to_string();
    let copied = conn
        .execute(
            "INSERT INTO signatures (id, name, html, text) SELECT ?1, ?2, html, text FROM signatures WHERE id = ?3",
            rusqlite::params![copy_id, copy_name.trim(), id],
        )
        .map_err(|e| e.to_string())?;
    if copied == 0 {
        return Err("Signature not found".into());
    }
    find(conn, &copy_id)
}

pub fn delete_signature_inner(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE accounts SET signature_id = NULL WHERE signature_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM signatures WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn set_account_signature_inner(
    conn: &Connection,
    account_id: &str,
    signature_id: Option<&str>,
    on_compose: bool,
    on_reply: bool,
) -> Result<(), String> {
    if let Some(id) = signature_id {
        find(conn, id)?;
    }
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    conn.execute(
        "UPDATE accounts SET signature_id = ?1, signature_on_compose = ?2, signature_on_reply = ?3, updated_at = ?4 WHERE id = ?5",
        rusqlite::params![signature_id, on_compose as i32, on_reply as i32, now, account_id],
    )
    .map_err(|e| format!("Failed to update signature: {}", e))?;
    Ok(())
}

#[tauri::command(async)]
pub fn list_signatures(db: State<'_, Database>) -> Result<Vec<Signature>, String> {
    super::catch_panic(|| list_signatures_inner(&db.lock_db()))
}

#[tauri::command(async)]
pub fn save_signature(
    db: State<'_, Database>,
    id: Option<String>,
    name: String,
    html: String,
    text: String,
    account_ids: Vec<String>,
) -> Result<Signature, String> {
    super::catch_panic(|| save_signature_inner(&db.lock_db(), id.as_deref(), &name, &html, &text, &account_ids))
}

#[tauri::command(async)]
pub fn duplicate_signature(db: State<'_, Database>, id: String, copy_name: String) -> Result<Signature, String> {
    super::catch_panic(|| duplicate_signature_inner(&db.lock_db(), &id, &copy_name))
}

#[tauri::command(async)]
pub fn delete_signature(db: State<'_, Database>, id: String) -> Result<(), String> {
    super::catch_panic(|| delete_signature_inner(&db.lock_db(), &id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::accounts::list_accounts_inner;

    fn temp_db() -> Database {
        Database::new(std::env::temp_dir().join(format!("prudii-test-{}", uuid::Uuid::new_v4()))).unwrap()
    }

    fn account(db: &Database, name: &str) -> String {
        let id = Uuid::new_v4().to_string();
        db.lock_db()
            .execute(
                "INSERT INTO accounts (id, email, display_name, provider, imap_host, smtp_host)
                 VALUES (?1, ?2, ?3, 'custom', 'imap.studio-halde.example', 'smtp.studio-halde.example')",
                rusqlite::params![id, format!("{}@studio-halde.example", id), name],
            )
            .unwrap();
        id
    }

    fn assigned(conn: &Connection, account_id: &str) -> Option<String> {
        conn.query_row("SELECT signature_id FROM accounts WHERE id = ?1", [account_id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn saving_assigns_and_unassigns_accounts() {
        let db = temp_db();
        let (a1, a2) = (account(&db, "Anna Weber"), account(&db, "Studio Halde Info"));
        let conn = db.lock_db();
        let s1 = save_signature_inner(&conn, None, "Studio Halde", "<div>Anna Weber</div>", "Anna Weber", &[a1.clone(), a2.clone()]).unwrap();
        let s2 = save_signature_inner(&conn, None, "Privat", "<div>Anna</div>", "Anna", &[a2.clone()]).unwrap();
        assert_eq!(assigned(&conn, &a1), Some(s1.id.clone()));
        assert_eq!(assigned(&conn, &a2), Some(s2.id.clone()));
        save_signature_inner(&conn, Some(&s1.id), "Studio Halde", "<div>Anna Weber</div>", "Anna Weber", &[]).unwrap();
        assert_eq!(assigned(&conn, &a1), None);
        assert_eq!(assigned(&conn, &a2), Some(s2.id));
    }

    #[test]
    fn a_blank_name_is_refused() {
        let db = temp_db();
        assert_eq!(save_signature_inner(&db.lock_db(), None, "  ", "<div>x</div>", "x", &[]).unwrap_err(), "SIGNATURE_NAME_REQUIRED");
    }

    #[test]
    fn an_unknown_id_is_refused() {
        let db = temp_db();
        assert_eq!(save_signature_inner(&db.lock_db(), Some("gone"), "X", "", "", &[]).unwrap_err(), "Signature not found");
    }

    #[test]
    fn saved_markup_is_cleaned() {
        let db = temp_db();
        let s = save_signature_inner(&db.lock_db(), None, "X", "<div onclick=\"x()\">Hi<script>alert(1)</script></div>", "Hi", &[]).unwrap();
        assert!(!s.html.contains("script") && !s.html.contains("onclick") && s.html.contains("Hi"));
    }

    #[test]
    fn a_copy_keeps_the_embedded_image() {
        let db = temp_db();
        let a1 = account(&db, "Anna Weber");
        let conn = db.lock_db();
        let original = save_signature_inner(
            &conn,
            None,
            "Studio Halde",
            "<div><img src=\"data:image/png;base64,iVBORw0KGgo=\">Anna Weber</div>",
            "Anna Weber",
            &[a1.clone()],
        )
        .unwrap();
        let copy = duplicate_signature_inner(&conn, &original.id, "Studio Halde (Kopie)").unwrap();
        assert_eq!((copy.name.as_str(), &copy.html, &copy.text), ("Studio Halde (Kopie)", &original.html, &original.text));
        assert!(copy.html.contains("data:image/png;base64,iVBORw0KGgo="));
        assert_ne!(copy.id, original.id);
        assert_eq!(assigned(&conn, &a1), Some(original.id));
    }

    #[test]
    fn deleting_frees_its_accounts() {
        let db = temp_db();
        let a1 = account(&db, "Anna Weber");
        let conn = db.lock_db();
        let s = save_signature_inner(&conn, None, "Studio Halde", "<div>x</div>", "x", &[a1.clone()]).unwrap();
        delete_signature_inner(&conn, &s.id).unwrap();
        assert_eq!(assigned(&conn, &a1), None);
        assert!(list_signatures_inner(&conn).unwrap().is_empty());
    }

    #[test]
    fn accounts_carry_their_signature_resolved() {
        let db = temp_db();
        let a1 = account(&db, "Anna Weber");
        let conn = db.lock_db();
        let s = save_signature_inner(&conn, None, "Studio Halde", "<div>Anna Weber</div>", "Anna Weber", &[a1]).unwrap();
        let acc = &list_accounts_inner(&conn).unwrap()[0];
        assert_eq!(
            (acc.signature_id.as_deref(), acc.signature_html.as_str(), acc.signature_text.as_str()),
            (Some(s.id.as_str()), "<div>Anna Weber</div>", "Anna Weber")
        );
    }

    #[test]
    fn an_account_pointing_at_a_missing_signature_has_none() {
        let db = temp_db();
        let a1 = account(&db, "Anna Weber");
        let conn = db.lock_db();
        conn.execute("UPDATE accounts SET signature_id = 'gone', signature_html = '<div>old</div>' WHERE id = ?1", [&a1]).unwrap();
        let acc = &list_accounts_inner(&conn).unwrap()[0];
        assert_eq!((acc.signature_id.as_deref(), acc.signature_html.as_str()), (None, ""));
    }

    #[test]
    fn the_list_is_sorted_by_name_ignoring_case() {
        let db = temp_db();
        let conn = db.lock_db();
        for name in ["studio", "Privat", "Anna"] {
            save_signature_inner(&conn, None, name, "<div>x</div>", "x", &[]).unwrap();
        }
        let names: Vec<String> = list_signatures_inner(&conn).unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["Anna", "Privat", "studio"]);
    }

    #[test]
    fn an_account_takes_a_listed_signature_or_none() {
        let db = temp_db();
        let a1 = account(&db, "Anna Weber");
        let conn = db.lock_db();
        let s = save_signature_inner(&conn, None, "Studio Halde", "<div>x</div>", "x", &[]).unwrap();
        set_account_signature_inner(&conn, &a1, Some(&s.id), true, false).unwrap();
        assert_eq!(assigned(&conn, &a1), Some(s.id));
        let on_reply: bool = conn.query_row("SELECT signature_on_reply FROM accounts WHERE id = ?1", [&a1], |r| r.get(0)).unwrap();
        assert!(!on_reply);
        assert_eq!(set_account_signature_inner(&conn, &a1, Some("gone"), true, true).unwrap_err(), "Signature not found");
        set_account_signature_inner(&conn, &a1, None, true, true).unwrap();
        assert_eq!(assigned(&conn, &a1), None);
    }
}
