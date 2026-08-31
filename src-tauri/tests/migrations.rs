// Exercises the v38 schema work end-to-end against a real SQLite file:
// external-content FTS with trigger sync, the upgrade path from the old
// standalone FTS table, and the bracket-normalized thread-lookup columns.

use prudii_lib::db::Database;

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("prudii-test-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn insert_mail(conn: &rusqlite::Connection, id: &str, subject: &str, body: &str, message_id: &str) {
    // Tests exercise FTS/contacts plumbing, not account/folder integrity.
    conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
    conn.execute(
        "INSERT INTO mails (id, account_id, folder_id, message_id, uid, subject, from_name, from_email, to_json, cc_json, bcc_json, date, snippet, body_text, body_html, is_read, is_starred, is_flagged, is_replied, is_forwarded, has_attachments, size_bytes)
         VALUES (?1, 'acc1', 'f1', ?4, NULL, ?2, 'Alice', 'alice@example.com', '[]', '[]', '[]', '2026-01-01T00:00:00Z', '', ?3, '', 0, 0, 0, 0, 0, 0, 0)",
        rusqlite::params![id, subject, body, message_id],
    )
    .unwrap();
}

fn fts_hits(conn: &rusqlite::Connection, query: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT m.id FROM mails_fts JOIN mails m ON m.rowid = mails_fts.rowid WHERE mails_fts MATCH ?1")
        .unwrap();
    stmt.query_map([query], |r| r.get::<_, String>(0))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
}

#[test]
fn fresh_db_fts_triggers_keep_index_in_sync() {
    let dir = temp_dir("fresh");
    let db = Database::new(dir.clone()).unwrap();
    let conn = db.lock_db();

    insert_mail(&conn, "m1", "Quarterly report", "", "<msg-1@example.com>");
    assert_eq!(fts_hits(&conn, "quarterly"), vec!["m1".to_string()], "insert trigger indexes subject");

    conn.execute("UPDATE mails SET body_text = 'zanzibar contents' WHERE id = 'm1'", [])
        .unwrap();
    assert_eq!(fts_hits(&conn, "zanzibar"), vec!["m1".to_string()], "update trigger indexes body");

    // Updating a non-indexed column must not desync the index
    conn.execute("UPDATE mails SET is_read = 1 WHERE id = 'm1'", []).unwrap();
    assert_eq!(fts_hits(&conn, "zanzibar"), vec!["m1".to_string()]);

    conn.execute("DELETE FROM mails WHERE id = 'm1'", []).unwrap();
    assert!(fts_hits(&conn, "zanzibar").is_empty(), "delete trigger removes the row");

    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn upgrade_from_standalone_fts_rebuilds_index() {
    let dir = temp_dir("upgrade");

    // Start from a current database, then forge the pre-v38 world: standalone
    // FTS table, no triggers, user_version 37, one mail indexed the old way.
    {
        let db = Database::new(dir.clone()).unwrap();
        let conn = db.lock_db();
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS mails_fts_ai;
             DROP TRIGGER IF EXISTS mails_fts_ad;
             DROP TRIGGER IF EXISTS mails_fts_au;
             DROP TABLE IF EXISTS mails_fts;
             CREATE VIRTUAL TABLE mails_fts USING fts5(
                mail_id UNINDEXED, subject, from_email, from_name, body_text,
                tokenize='unicode61'
             );",
        )
        .unwrap();
        insert_mail(&conn, "m1", "Old world mail", "legacy body", "<old-1@example.com>");
        conn.execute(
            "INSERT INTO mails_fts (mail_id, subject, from_email, from_name, body_text) VALUES ('m1', 'Old world mail', 'alice@example.com', 'Alice', 'legacy body')",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 37u32).unwrap();
    }

    // Reopen: run_migrations must swap the table and rebuild from content.
    let db = Database::new(dir.clone()).unwrap();
    let conn = db.lock_db();

    assert_eq!(fts_hits(&conn, "legacy"), vec!["m1".to_string()], "rebuild indexed existing mail");

    // Triggers must be back and functional after the swap
    insert_mail(&conn, "m2", "Post upgrade mail", "fresh body", "new-2@example.com");
    assert_eq!(fts_hits(&conn, "fresh"), vec!["m2".to_string()]);

    // Bracket-normalized generated columns serve thread lookup for both formats
    let norm: String = conn
        .query_row("SELECT message_id_norm FROM mails WHERE id = 'm1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(norm, "old-1@example.com");
    let found: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mails WHERE account_id = 'acc1' AND message_id_norm IN ('old-1@example.com', 'new-2@example.com')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(found, 2);

    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cid_referenced_image_is_inline_even_when_declared_attachment() {
    // Outlook-style signature image: declared Content-Disposition: attachment
    // with a filename, but referenced via cid: in the HTML — it renders inside
    // the body and must not show up as a real attachment.
    let dir = temp_dir("cid-inline");
    let db = Database::new(dir.clone()).unwrap();
    {
        let conn = db.lock_db();
        insert_mail(&conn, "m1", "Signed mail", "", "<sig@example.com>");
    }

    let raw = concat!(
        "From: a@x.de\r\n",
        "To: b@x.de\r\n",
        "Subject: Signed mail\r\n",
        "MIME-Version: 1.0\r\n",
        "Content-Type: multipart/related; boundary=\"BOUND\"\r\n",
        "\r\n",
        "--BOUND\r\n",
        "Content-Type: text/html; charset=utf-8\r\n",
        "\r\n",
        "<p>Hello</p><img src=\"cid:logo123\">\r\n",
        "--BOUND\r\n",
        "Content-Type: image/png; name=\"image001.png\"\r\n",
        "Content-Disposition: attachment; filename=\"image001.png\"\r\n",
        "Content-ID: <logo123>\r\n",
        "Content-Transfer-Encoding: base64\r\n",
        "\r\n",
        "iVBORw0KGgoAAAANSUhEUg==\r\n",
        "--BOUND--\r\n",
    );

    tauri::async_runtime::block_on(prudii_lib::imap::store_body_and_attachments(
        &db, "m1", raw.as_bytes(),
    ))
    .unwrap();

    let conn = db.lock_db();
    let (is_inline, has_attachments): (i64, i64) = conn
        .query_row(
            "SELECT a.is_inline, m.has_attachments FROM attachments a JOIN mails m ON m.id = a.mail_id WHERE a.mail_id = 'm1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(is_inline, 1, "cid-referenced image is inline despite attachment disposition");
    assert_eq!(has_attachments, 0, "mail must not advertise attachments for embedded images");

    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn contacts_fold_populates_from_mails() {
    let dir = temp_dir("contacts");
    let db = Database::new(dir.clone()).unwrap();
    let conn = db.lock_db();

    insert_mail(&conn, "m1", "Hello", "", "<c-1@example.com>");
    conn.execute(
        "UPDATE mails SET to_json = '[{\"name\":\"Bob\",\"email\":\"Bob@Example.com\"}]' WHERE id = 'm1'",
        [],
    )
    .unwrap();

    prudii_lib::contacts::update_contacts_incremental(&conn);

    let (name, freq): (String, i64) = conn
        .query_row(
            "SELECT name, frequency FROM contacts WHERE account_id = 'acc1' AND email = 'bob@example.com'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(name, "Bob");
    assert_eq!(freq, 1);

    // Second run without new rows is a no-op (high-water mark)
    prudii_lib::contacts::update_contacts_incremental(&conn);
    let freq2: i64 = conn
        .query_row(
            "SELECT frequency FROM contacts WHERE account_id = 'acc1' AND email = 'alice@example.com'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(freq2, 1);

    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}
