// Fixture-DB tests for the two hottest read paths: thread assembly
// (get_thread_mails_inner) and full-text search (search_mails_inner).
// Both run against a real SQLite file created by the production migrations,
// so index/trigger/generated-column behavior is exercised for real.

use prudii_lib::commands::mails::get_thread_mails_inner;
use prudii_lib::commands::sync::search_mails_inner;
use prudii_lib::db::Database;

fn fixture(tag: &str) -> Database {
    let dir = std::env::temp_dir().join(format!("prudii-thread-search-{}-{}", tag, std::process::id()));
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
        for (id, ftype) in [("inbox", "inbox"), ("sent", "sent"), ("archive", "archive")] {
            conn.execute(
                "INSERT INTO folders (id, account_id, name, folder_type, path, unread_count, total_count) \
                 VALUES (?1, 'acc', ?1, ?2, ?1, 0, 0)",
                rusqlite::params![id, ftype],
            )
            .unwrap();
        }
    }
    db
}

#[allow(clippy::too_many_arguments)]
fn insert_mail(
    conn: &rusqlite::Connection,
    id: &str,
    folder: &str,
    message_id: &str,
    in_reply_to: Option<&str>,
    thread_id: Option<&str>,
    subject: &str,
    body: &str,
    date: &str,
) {
    conn.execute(
        "INSERT INTO mails (id, account_id, folder_id, message_id, uid, subject, from_name, from_email, to_json, cc_json, bcc_json, date, snippet, body_text, body_html, is_read, is_starred, is_flagged, is_replied, is_forwarded, has_attachments, thread_id, in_reply_to, size_bytes)
         VALUES (?1, 'acc', ?2, ?3, NULL, ?6, 'Alice', 'alice@example.com', '[]', '[]', '[]', ?8, '', ?7, '', 0, 0, 0, 0, 0, 0, ?5, ?4, 0)",
        rusqlite::params![id, folder, message_id, in_reply_to, thread_id, subject, body, date],
    )
    .unwrap();
}

#[test]
fn thread_assembles_reply_chain_across_bracket_formats() {
    let db = fixture("chain");
    let conn = db.lock_db();

    // Root stored WITH brackets (IMAP path), reply stored WITHOUT (API path),
    // linked via in_reply_to; a third mail is unrelated.
    insert_mail(&conn, "root", "inbox", "<t1@example.com>", None, Some("t1@example.com"), "Projekt", "start", "2026-01-01T10:00:00Z");
    insert_mail(&conn, "reply", "sent", "t2@example.com", Some("t1@example.com"), Some("t1@example.com"), "Re: Projekt", "answer", "2026-01-01T11:00:00Z");
    insert_mail(&conn, "other", "inbox", "<x@example.com>", None, Some("x@example.com"), "Unrelated", "noise", "2026-01-01T12:00:00Z");

    let thread = get_thread_mails_inner(&conn, "root").unwrap();
    let ids: Vec<&str> = thread.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec!["root", "reply"], "chain in date order, unrelated mail excluded");

    // Entering the thread from the reply finds the same conversation
    let from_reply = get_thread_mails_inner(&conn, "reply").unwrap();
    assert_eq!(from_reply.len(), 2);
}

#[test]
fn thread_collapses_cross_folder_copy_of_same_message() {
    let db = fixture("copies");
    let conn = db.lock_db();

    insert_mail(&conn, "root", "inbox", "<c1@example.com>", None, Some("c1@example.com"), "Same", "body", "2026-01-01T10:00:00Z");
    // Same message also in Archive (Gmail label situation)
    insert_mail(&conn, "copy", "archive", "<c1@example.com>", None, Some("c1@example.com"), "Same", "body", "2026-01-01T10:00:00Z");

    let thread = get_thread_mails_inner(&conn, "root").unwrap();
    assert_eq!(thread.len(), 1, "cross-folder duplicate is collapsed");
}

#[test]
fn thread_always_contains_the_clicked_mail() {
    let db = fixture("clicked");
    let conn = db.lock_db();
    insert_mail(&conn, "solo", "inbox", "", None, None, "No ids at all", "body", "2026-01-01T10:00:00Z");

    let thread = get_thread_mails_inner(&conn, "solo").unwrap();
    assert_eq!(thread.len(), 1);
    assert_eq!(thread[0].id, "solo");
}

#[test]
fn search_matches_subject_and_body_with_account_filter() {
    let db = fixture("search");
    let conn = db.lock_db();

    insert_mail(&conn, "m1", "inbox", "<s1@example.com>", None, None, "Zebra invoice", "", "2026-01-02T10:00:00Z");
    insert_mail(&conn, "m2", "inbox", "<s2@example.com>", None, None, "Hello", "the zebra runs", "2026-01-01T10:00:00Z");
    insert_mail(&conn, "m3", "inbox", "<s3@example.com>", None, None, "Nothing here", "", "2026-01-03T10:00:00Z");

    let hits = search_mails_inner(&conn, "zebra", None).unwrap();
    let ids: Vec<&str> = hits.iter().map(|h| h.mail_id.as_str()).collect();
    assert_eq!(ids, vec!["m1", "m2"], "subject and body hits, newest first");

    let scoped = search_mails_inner(&conn, "zebra", Some("acc")).unwrap();
    assert_eq!(scoped.len(), 2);
    let none = search_mails_inner(&conn, "zebra", Some("other-acc")).unwrap();
    assert!(none.is_empty(), "account filter applies");
}

#[test]
fn search_reflects_body_updates_and_deletes() {
    let db = fixture("live");
    let conn = db.lock_db();
    insert_mail(&conn, "m1", "inbox", "<l1@example.com>", None, None, "Plain", "", "2026-01-01T10:00:00Z");

    assert!(search_mails_inner(&conn, "walrus", None).unwrap().is_empty());
    conn.execute("UPDATE mails SET body_text = 'walrus sighting' WHERE id = 'm1'", []).unwrap();
    assert_eq!(search_mails_inner(&conn, "walrus", None).unwrap().len(), 1, "body fetch makes mail findable");

    conn.execute("DELETE FROM mails WHERE id = 'm1'", []).unwrap();
    assert!(search_mails_inner(&conn, "walrus", None).unwrap().is_empty(), "deleted mail leaves the index");
}

#[test]
fn search_ignores_empty_and_garbage_queries() {
    let db = fixture("garbage");
    let conn = db.lock_db();
    insert_mail(&conn, "m1", "inbox", "<g1@example.com>", None, None, "Anything", "", "2026-01-01T10:00:00Z");

    assert!(search_mails_inner(&conn, "", None).unwrap().is_empty());
    // FTS operator characters must not produce SQL errors
    assert!(search_mails_inner(&conn, "\"(*", None).is_ok());
}
