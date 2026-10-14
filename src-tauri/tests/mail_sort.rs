use prudii_lib::commands::mails::list_mails_inner;
use prudii_lib::db::Database;

fn fixture(tag: &str) -> Database {
    let dir = std::env::temp_dir().join(format!("prudii-mail-sort-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let db = Database::new(dir).expect("temp db");
    {
        let conn = db.lock_db();
        conn.execute(
            "INSERT INTO accounts (id, email, display_name, provider, imap_host, smtp_host) \
             VALUES ('acc', 'me@x.de', 'Me', 'imap', 'imap.x.de', 'smtp.x.de')",
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
    }
    db
}

#[allow(clippy::too_many_arguments)]
fn mail(conn: &rusqlite::Connection, id: &str, folder: &str, subject: &str, from_name: &str, from_email: &str, to_json: &str, date: &str, pinned: bool) {
    conn.execute(
        "INSERT INTO mails (id, account_id, folder_id, message_id, subject, from_name, from_email, to_json, date, is_pinned)
         VALUES (?1, 'acc', ?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![id, folder, subject, from_name, from_email, to_json, date, pinned as i32],
    )
    .unwrap();
}

fn ids(conn: &rusqlite::Connection, folder: &str, sort: Option<&str>) -> Vec<String> {
    list_mails_inner(conn, folder, Some(100), Some(0), &None, sort).unwrap().into_iter().map(|m| m.id).collect()
}

#[test]
fn default_and_unknown_sort_keep_pinned_then_newest_first() {
    let db = fixture("default");
    let conn = db.lock_db();
    mail(&conn, "old", "inbox", "a", "A", "a@y.de", "[]", "2026-01-01T10:00:00Z", false);
    mail(&conn, "new", "inbox", "b", "B", "b@y.de", "[]", "2026-01-03T10:00:00Z", false);
    mail(&conn, "pinned", "inbox", "c", "C", "c@y.de", "[]", "2026-01-02T10:00:00Z", true);

    assert_eq!(ids(&conn, "inbox", None), ["pinned", "new", "old"]);
    assert_eq!(ids(&conn, "inbox", Some("nonsense")), ["pinned", "new", "old"]);
    assert_eq!(ids(&conn, "inbox", Some("date_asc")), ["pinned", "old", "new"]);
}

#[test]
fn subject_sort_ignores_reply_prefixes_and_case() {
    let db = fixture("subject");
    let conn = db.lock_db();
    mail(&conn, "gamma", "inbox", "AW: Fwd: Gamma", "A", "a@y.de", "[]", "2026-01-01T10:00:00Z", false);
    mail(&conn, "alpha", "inbox", "alpha", "A", "a@y.de", "[]", "2026-01-02T10:00:00Z", false);
    mail(&conn, "beta", "inbox", "Re: Beta", "A", "a@y.de", "[]", "2026-01-03T10:00:00Z", false);
    mail(&conn, "empty", "inbox", "Re:", "A", "a@y.de", "[]", "2026-01-04T10:00:00Z", false);

    assert_eq!(ids(&conn, "inbox", Some("subject_asc")), ["empty", "alpha", "beta", "gamma"]);
    assert_eq!(ids(&conn, "inbox", Some("subject_desc")), ["gamma", "beta", "alpha", "empty"]);
}

#[test]
fn correspondent_sort_uses_name_then_address_in_the_inbox() {
    let db = fixture("corr-inbox");
    let conn = db.lock_db();
    mail(&conn, "zoe", "inbox", "s1", "Zoe", "z@y.de", "[]", "2026-01-01T10:00:00Z", false);
    mail(&conn, "bob", "inbox", "s2", "", "bob@y.de", "[]", "2026-01-02T10:00:00Z", false);
    mail(&conn, "anna", "inbox", "s3", "anna", "a@y.de", "[]", "2026-01-03T10:00:00Z", false);

    assert_eq!(ids(&conn, "inbox", Some("correspondent_asc")), ["anna", "bob", "zoe"]);
    assert_eq!(ids(&conn, "inbox", Some("correspondent_desc")), ["zoe", "bob", "anna"]);
}

#[test]
fn correspondent_sort_uses_the_first_recipient_for_outgoing_mail() {
    let db = fixture("corr-sent");
    let conn = db.lock_db();
    mail(&conn, "to-zoe", "sent", "s1", "Me", "me@x.de", r#"[{"name":"Zoe","email":"z@y.de"}]"#, "2026-01-01T10:00:00Z", false);
    mail(&conn, "to-bob", "sent", "s2", "Me", "me@x.de", r#"[{"name":"","email":"bob@y.de"}]"#, "2026-01-02T10:00:00Z", false);
    mail(&conn, "broken", "sent", "s3", "Me", "me@x.de", "not json", "2026-01-03T10:00:00Z", false);
    mail(&conn, "self-in-inbox", "inbox", "s4", "Aaron", "ME@x.de", r#"[{"name":"Carl","email":"c@y.de"}]"#, "2026-01-04T10:00:00Z", false);
    mail(&conn, "bert", "inbox", "s5", "Bert", "bert@y.de", "[]", "2026-01-05T10:00:00Z", false);

    assert_eq!(ids(&conn, "sent", Some("correspondent_asc")), ["broken", "to-bob", "to-zoe"]);
    assert_eq!(ids(&conn, "inbox", Some("correspondent_asc")), ["bert", "self-in-inbox"]);
}

#[test]
fn correspondent_sort_ignores_quotes_around_names() {
    let db = fixture("corr-quotes");
    let conn = db.lock_db();
    mail(&conn, "heinrich", "sent", "s1", "Me", "me@x.de", r#"[{"name":"'Heinrich'","email":"h@y.de"}]"#, "2026-01-01T10:00:00Z", false);
    mail(&conn, "anna", "sent", "s2", "Me", "me@x.de", r#"[{"name":"Anna","email":"a@y.de"}]"#, "2026-01-02T10:00:00Z", false);
    mail(&conn, "zoe", "inbox", "s3", "\"Zoe\"", "z@y.de", "[]", "2026-01-03T10:00:00Z", false);
    mail(&conn, "bob", "inbox", "s4", "Bob", "b@y.de", "[]", "2026-01-04T10:00:00Z", false);

    assert_eq!(ids(&conn, "sent", Some("correspondent_asc")), ["anna", "heinrich"]);
    assert_eq!(ids(&conn, "inbox", Some("correspondent_asc")), ["bob", "zoe"]);
}

#[test]
fn equal_sort_keys_page_without_gaps_or_repeats() {
    let db = fixture("paging");
    let conn = db.lock_db();
    for i in 0..5 {
        mail(&conn, &format!("m{i}"), "inbox", "Same", "Same", "same@y.de", "[]", "2026-01-01T10:00:00Z", false);
    }
    for sort in ["date_desc", "date_asc", "subject_asc", "correspondent_desc"] {
        let mut seen = Vec::new();
        for offset in [0u32, 2, 4] {
            let page = list_mails_inner(&conn, "inbox", Some(2), Some(offset), &None, Some(sort)).unwrap();
            seen.extend(page.into_iter().map(|m| m.id));
        }
        let mut unique = seen.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(seen.len(), 5, "{sort}");
        assert_eq!(unique.len(), 5, "{sort}");
    }
}
