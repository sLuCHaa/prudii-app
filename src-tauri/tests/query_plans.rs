// Query plans of hot background lookups, checked against the production migrations.

use prudii_lib::db::Database;

fn plan(db: &Database, sql: &str) -> String {
    let conn = db.lock_db();
    let rows: Vec<String> = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap()
        .query_map(rusqlite::params!["folder"], |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    rows.join(" | ")
}

#[test]
fn missing_body_lookups_use_the_partial_index() {
    let dir = std::env::temp_dir().join(format!("prudii-query-plans-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let db = Database::new(dir).expect("temp db");

    for sql in [
        "SELECT id, uid FROM mails WHERE folder_id = ?1 AND body_text = '' AND body_html = '' AND uid IS NOT NULL ORDER BY date DESC LIMIT 100",
        "SELECT id, uid FROM mails WHERE folder_id = ?1 AND body_text = '' AND uid IS NOT NULL ORDER BY date DESC LIMIT 30",
    ] {
        let plan = plan(&db, sql);
        assert!(plan.contains("idx_mails_folder_missing_body"), "{plan}");
    }
}
