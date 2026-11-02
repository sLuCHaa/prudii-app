// The UI's read connection against a busy main connection, on the production schema.

use prudii_lib::db::Database;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn fixture(tag: &str) -> Arc<Database> {
    let dir = std::env::temp_dir().join(format!("prudii-read-conn-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let db = Database::new(dir).expect("temp db");
    {
        let conn = db.lock_db();
        conn.execute_batch(
            "INSERT INTO accounts (id, email, display_name, provider, imap_host, smtp_host)
               VALUES ('acc', 'anna.weber@studio-halde.example', 'Anna Weber', 'imap', 'imap.example', 'smtp.example');
             INSERT INTO folders (id, account_id, name, folder_type, path, unread_count, total_count)
               VALUES ('inbox', 'acc', 'Inbox', 'inbox', 'INBOX', 0, 0);
             INSERT INTO mails (id, account_id, folder_id, message_id, subject, from_name, from_email, to_json, cc_json, bcc_json, date, snippet, body_text, body_html, is_read, is_starred, is_flagged, is_replied, is_forwarded, has_attachments, size_bytes)
               VALUES ('m1', 'acc', 'inbox', '<m1@studio-halde.example>', 'Original', 'Anna', 'anna.weber@studio-halde.example', '[]', '[]', '[]', '2026-11-02T09:00:00Z', '', '', '', 0, 0, 0, 0, 0, 0, 0);",
        )
        .unwrap();
    }
    Arc::new(db)
}

fn subject(db: &Database) -> String {
    db.read_db().query_row("SELECT subject FROM mails WHERE id = 'm1'", [], |r| r.get(0)).unwrap()
}

#[test]
fn reads_do_not_wait_for_a_running_write() {
    let db = fixture("busy");
    let writer = {
        let db = db.clone();
        std::thread::spawn(move || {
            let conn = db.lock_db();
            conn.execute_batch("BEGIN IMMEDIATE; UPDATE mails SET subject = 'Changed' WHERE id = 'm1';").unwrap();
            std::thread::sleep(Duration::from_millis(800));
            conn.execute_batch("COMMIT").unwrap();
        })
    };
    std::thread::sleep(Duration::from_millis(150));

    let started = Instant::now();
    assert_eq!(subject(&db), "Original");
    assert!(started.elapsed() < Duration::from_millis(300), "read waited {:?}", started.elapsed());

    writer.join().unwrap();
    assert_eq!(subject(&db), "Changed");
}

#[test]
fn read_connection_refuses_writes() {
    let db = fixture("readonly");
    assert!(db.read_db().execute("DELETE FROM mails", []).is_err());
    assert_eq!(subject(&db), "Original");
}
