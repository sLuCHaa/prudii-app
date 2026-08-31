// Fixture-DB test for the startup bootstrap command: one query composing
// list_accounts_inner + list_folders_inner + list_mails_inner under a single
// lock_db(), so startup needs one IPC round trip instead of three.

use prudii_lib::commands::bootstrap::bootstrap_state_inner;
use prudii_lib::db::Database;

fn fixture(tag: &str) -> Database {
    let dir = std::env::temp_dir().join(format!("prudii-bootstrap-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let db = Database::new(dir).expect("temp db");
    {
        let conn = db.lock_db();
        conn.execute(
            "INSERT INTO accounts (id, email, display_name, provider, imap_host, smtp_host) \
             VALUES ('acc', 'a@x.de', 'A', 'imap', 'imap.x.de', 'smtp.x.de')",
            [],
        )
        .unwrap();
        for (id, ftype) in [("inbox", "inbox"), ("sent", "sent")] {
            conn.execute(
                "INSERT INTO folders (id, account_id, name, folder_type, path, unread_count, total_count) \
                 VALUES (?1, 'acc', ?1, ?2, ?1, 0, 0)",
                rusqlite::params![id, ftype],
            )
            .unwrap();
        }
        for i in 1..=3 {
            conn.execute(
                "INSERT INTO mails (id, account_id, folder_id, message_id, uid, subject, from_name, from_email, to_json, cc_json, bcc_json, date, snippet, body_text, body_html, is_read, is_starred, is_flagged, is_replied, is_forwarded, has_attachments, thread_id, in_reply_to, size_bytes)
                 VALUES (?1, 'acc', 'inbox', ?2, NULL, ?3, 'Alice', 'alice@example.com', '[]', '[]', '[]', ?4, '', 'plain body text', '<p>html body</p>', 0, 0, 0, 0, 0, 0, NULL, NULL, 0)",
                rusqlite::params![
                    format!("m{}", i),
                    format!("<m{}@example.com>", i),
                    format!("Mail {}", i),
                    format!("2026-01-0{}T10:00:00Z", i),
                ],
            )
            .unwrap();
        }
    }
    db
}

#[test]
fn bootstrap_defaults_to_inbox_with_blank_bodied_first_page() {
    let db = fixture("default");
    let conn = db.lock_db();

    let state = bootstrap_state_inner(&conn, None).unwrap();
    assert_eq!(state.accounts.len(), 1, "one account");
    assert_eq!(state.folders.len(), 2, "both folders, across the single account, flat");
    assert_eq!(state.folder_id, Some("inbox".to_string()), "no last_folder_id -> first inbox");
    assert_eq!(state.mails.len(), 3, "all three inbox mails");
    for mail in &state.mails {
        assert_eq!(mail.body_html, "", "list query intentionally selects blank bodies");
        assert_eq!(mail.body_text, "", "list query intentionally selects blank bodies");
    }
}

#[test]
fn bootstrap_uses_last_folder_id_when_it_still_exists() {
    let db = fixture("last-folder");
    let conn = db.lock_db();

    let state = bootstrap_state_inner(&conn, Some("sent".to_string())).unwrap();
    assert_eq!(state.folder_id, Some("sent".to_string()));
    assert!(state.mails.is_empty(), "sent has no mails in the fixture");
}

#[test]
fn bootstrap_falls_back_to_inbox_when_last_folder_id_is_stale() {
    let db = fixture("stale");
    let conn = db.lock_db();

    let state = bootstrap_state_inner(&conn, Some("does-not-exist".to_string())).unwrap();
    assert_eq!(state.folder_id, Some("inbox".to_string()));
    assert_eq!(state.mails.len(), 3);
}
