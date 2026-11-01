use super::names::{attachment_name, mail_base_name, safe_segment, NameSet};
use super::parse::{build_eml, from_local, has_content, parse_local_date, parse_raw, ExportPart, LocalMail, ParsedMail};
use super::render::{
    render_index_data_js, render_index_html, render_mail_page, url_encode_segment, IndexAccount, IndexData, IndexEntry,
    IndexFolder, PageContext, APP_JS, STYLE_CSS,
};
use super::{ExportLabels, ExportOptions, ExportProgress, ExportSummary, MailOutcome};
use crate::db::Database;
use chrono::{NaiveDate, NaiveDateTime};
use futures_util::stream::{self, StreamExt};
use futures_util::FutureExt;
use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const CHUNK: i64 = 500;
const CONCURRENCY: usize = 4;
const PROGRESS_EVERY: u32 = 25;
const PREVIEW_CHARS: usize = 120;
const ACCOUNT_DIR_CHARS: usize = 30;
const FOLDER_DIR_CHARS: usize = 30;
const MAIL_BASE_CHARS: usize = 70;

struct FolderInfo {
    id: String,
    name: String,
    folder_type: String,
    is_local: bool,
    provider: String,
    account_id: String,
    account_email: String,
    account_name: String,
}

struct MailRow {
    id: String,
    subject: String,
    from_name: String,
    from_email: String,
    to_json: String,
    cc_json: String,
    date: String,
    body_html: String,
    body_text: String,
    has_attachments: bool,
}

struct MailResult {
    outcome: MailOutcome,
    entry: IndexEntry,
}

fn load_folders(db: &Database, labels: &ExportLabels, ids: &[String]) -> Vec<FolderInfo> {
    let conn = db.lock_db();
    let mut out = Vec::new();
    for id in ids {
        let found = conn.query_row(
            "SELECT f.id, f.name, f.folder_type, COALESCE(f.is_local, 0), a.id, a.email, a.display_name, a.provider
             FROM folders f JOIN accounts a ON a.id = f.account_id WHERE f.id = ?1",
            rusqlite::params![id],
            |row| {
                let folder_type: String = row.get(2)?;
                let name: String = row.get(1)?;
                Ok(FolderInfo {
                    id: row.get(0)?,
                    name: labels.folder_names.get(&folder_type).cloned().unwrap_or(name),
                    folder_type,
                    is_local: row.get::<_, i64>(3)? != 0,
                    account_id: row.get(4)?,
                    account_email: row.get(5)?,
                    account_name: row.get(6)?,
                    provider: row.get(7)?,
                })
            },
        );
        if let Ok(info) = found {
            out.push(info);
        }
    }
    out
}

fn count_mails(db: &Database, folders: &[FolderInfo]) -> u32 {
    let conn = db.lock_db();
    folders
        .iter()
        .map(|f| {
            conn.query_row("SELECT COUNT(*) FROM mails WHERE folder_id = ?1", rusqlite::params![f.id], |r| r.get::<_, i64>(0))
                .unwrap_or(0)
        })
        .sum::<i64>() as u32
}

fn read_chunk(db: &Database, folder_id: &str, after: &Option<(String, String)>) -> Vec<MailRow> {
    let conn = db.lock_db();
    let (date, id) = match after {
        Some((d, i)) => (Some(d.as_str()), Some(i.as_str())),
        None => (None, None),
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, subject, from_name, from_email, to_json, cc_json, date, body_html, body_text, has_attachments
         FROM mails
         WHERE folder_id = ?1 AND (?2 IS NULL OR date < ?2 OR (date = ?2 AND id > ?3))
         ORDER BY date DESC, id ASC LIMIT ?4",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map(rusqlite::params![folder_id, date, id, CHUNK], |row| {
        Ok(MailRow {
            id: row.get(0)?,
            subject: row.get(1)?,
            from_name: row.get(2)?,
            from_email: row.get(3)?,
            to_json: row.get(4)?,
            cc_json: row.get(5)?,
            date: row.get(6)?,
            body_html: row.get(7)?,
            body_text: row.get(8)?,
            has_attachments: row.get::<_, i64>(9)? != 0,
        })
    });
    match rows {
        Ok(iter) => iter.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

fn load_local_parts(db: &Database, mail_id: &str) -> Vec<ExportPart> {
    let rows: Vec<(String, Option<String>, Option<String>, bool, String)> = {
        let conn = db.lock_db();
        let Ok(mut stmt) = conn.prepare(
            "SELECT filename, mime_type, content_id, is_inline, local_path FROM attachments
             WHERE mail_id = ?1 AND local_path IS NOT NULL AND local_path != '' ORDER BY filename",
        ) else {
            return Vec::new();
        };
        let mapped = stmt.query_map(rusqlite::params![mail_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0, r.get(4)?))
        });
        match mapped {
            Ok(iter) => iter.flatten().collect(),
            Err(_) => return Vec::new(),
        }
    };
    rows.into_iter()
        .enumerate()
        .filter_map(|(i, (filename, mime, cid, inline, path))| {
            let bytes = std::fs::read(&path).ok()?;
            Some(ExportPart {
                filename: attachment_name(Some(&filename), i + 1),
                mime_type: mime.filter(|m| !m.is_empty()).unwrap_or_else(|| "application/octet-stream".into()),
                content_id: cid.map(|c| c.trim_matches(|ch| ch == '<' || ch == '>').to_string()).filter(|c| !c.is_empty()),
                bytes,
                is_body_part: inline,
            })
        })
        .collect()
}

fn preview(mail: &ParsedMail) -> String {
    let text = match mail.text.as_deref().filter(|t| !t.trim().is_empty()) {
        Some(t) => t.chars().take(PREVIEW_CHARS * 8).collect::<String>(),
        None => {
            let html: String = mail.html.as_deref().unwrap_or_default().chars().take(200_000).collect();
            ammonia::Builder::empty()
                .clean(&html)
                .to_string()
                .replace("&nbsp;", " ")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&amp;", "&")
        }
    };
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(PREVIEW_CHARS).collect()
}

fn local_naive(date: Option<chrono::DateTime<chrono::FixedOffset>>) -> NaiveDateTime {
    match date {
        Some(d) => d.with_timezone(&chrono::Local).naive_local(),
        None => NaiveDate::from_ymd_opt(1970, 1, 1).and_then(|d| d.and_hms_opt(0, 0, 0)).unwrap_or_default(),
    }
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| format!("{}: {}", path.display(), e))
}

fn write_mail(
    opts: &ExportOptions,
    labels: &ExportLabels,
    folder_path: &Path,
    rel_dir: &str,
    base: &str,
    anchor: &str,
    outcome: MailOutcome,
    raw: Option<&[u8]>,
    mail: &mut ParsedMail,
) -> Result<Option<String>, String> {
    std::fs::create_dir_all(folder_path).map_err(|e| e.to_string())?;
    let mut href = None;

    if opts.eml {
        let bytes = match raw {
            Some(r) => r.to_vec(),
            None => build_eml(mail),
        };
        if bytes.is_empty() {
            log::warn!("mail export: could not rebuild an .eml from the local copy");
        } else {
            let name = format!("{base}.eml");
            write_file(&folder_path.join(&name), &bytes)?;
            href = Some(format!("{}/{}", rel_dir, url_encode_segment(&name)));
        }
    }

    if opts.html {
        let mut names = NameSet::new();
        for p in mail.parts.iter_mut() {
            p.filename = names.claim(&p.filename);
        }
        let dir = folder_path.join(base);
        let mut links = Vec::new();
        for p in &mail.parts {
            let needed = if p.is_body_part { p.content_id.is_some() } else { opts.include_attachments };
            if needed {
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                write_file(&dir.join(&p.filename), &p.bytes)?;
            }
            if !p.is_body_part {
                let link = opts
                    .include_attachments
                    .then(|| format!("{}/{}", url_encode_segment(base), url_encode_segment(&p.filename)));
                links.push((p.filename.clone(), link, p.bytes.len() as u64));
            }
        }
        let page = PageContext {
            index_href: "../../index.html".into(),
            folder_anchor: anchor.into(),
            inline_dir: base.into(),
            attachment_links: links,
            from_local_copy: outcome == MailOutcome::LocalCopy,
        };
        let name = format!("{base}.html");
        write_file(&folder_path.join(&name), render_mail_page(mail, &page, labels).as_bytes())?;
        href = Some(format!("{}/{}", rel_dir, url_encode_segment(&name)));
    }
    Ok(href)
}

fn failed_entry(row: &MailRow) -> IndexEntry {
    IndexEntry {
        s: row.subject.clone(),
        f: row.from_name.clone(),
        e: row.from_email.clone(),
        d: parse_local_date(&row.date).map(|d| d.to_rfc3339()).unwrap_or_default(),
        p: String::new(),
        a: row.has_attachments,
        h: None,
    }
}

fn pick(primary: &str, fallback: &str) -> String {
    if primary.trim().is_empty() { fallback.to_string() } else { primary.to_string() }
}

async fn process_mail<F, Fut>(
    db: &Database,
    fetch: &F,
    opts: &ExportOptions,
    labels: &ExportLabels,
    cancel: &AtomicBool,
    folder: &FolderInfo,
    folder_path: &Path,
    rel_dir: &str,
    row: MailRow,
    base: String,
) -> Option<MailResult>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<Vec<u8>, String>>,
{
    if cancel.load(Ordering::SeqCst) {
        return None;
    }
    let row_date = parse_local_date(&row.date);
    let local_only = folder.is_local && !matches!(folder.provider.as_str(), "google" | "microsoft");

    let mut original: Option<(Vec<u8>, ParsedMail)> = None;
    if !local_only {
        match fetch(row.id.clone()).await {
            Ok(raw) => match parse_raw(&raw) {
                Some(parsed) => original = Some((raw, parsed)),
                None => log::warn!("mail export: server source could not be parsed, using the local copy"),
            },
            Err(e) => log::warn!("mail export: server fetch failed, using the local copy: {e}"),
        }
    }

    let (mut outcome, raw, mut mail) = match original {
        Some((raw, mail)) => (MailOutcome::Original, Some(raw), mail),
        None => {
            let parts = load_local_parts(db, &row.id);
            let mail = from_local(
                &LocalMail {
                    subject: row.subject.clone(),
                    from_name: row.from_name.clone(),
                    from_email: row.from_email.clone(),
                    to_json: row.to_json.clone(),
                    cc_json: row.cc_json.clone(),
                    date: row.date.clone(),
                    body_html: row.body_html.clone(),
                    body_text: row.body_text.clone(),
                },
                parts,
            );
            let outcome = if has_content(&mail) { MailOutcome::LocalCopy } else { MailOutcome::Failed };
            (outcome, None, mail)
        }
    };
    if mail.date.is_none() {
        mail.date = row_date;
    }

    let mut href = None;
    if outcome != MailOutcome::Failed {
        match write_mail(opts, labels, folder_path, rel_dir, &base, &folder.id, outcome, raw.as_deref(), &mut mail) {
            Ok(h) => href = h,
            Err(e) => {
                log::warn!("mail export: writing failed: {e}");
                outcome = MailOutcome::Failed;
            }
        }
    }

    let entry = IndexEntry {
        s: pick(&row.subject, &mail.subject),
        f: pick(&row.from_name, &mail.from.name),
        e: pick(&row.from_email, &mail.from.email),
        d: row_date.or(mail.date).map(|d| d.to_rfc3339()).unwrap_or_default(),
        p: preview(&mail),
        a: row.has_attachments || mail.parts.iter().any(|p| !p.is_body_part),
        h: if outcome == MailOutcome::Failed { None } else { href },
    };
    Some(MailResult { outcome, entry })
}

pub async fn run_export<F, Fut>(
    db: &Database,
    options: &ExportOptions,
    labels: &ExportLabels,
    out_dir: &Path,
    fetch: F,
    cancel: &AtomicBool,
    progress: impl Fn(ExportProgress),
) -> ExportSummary
where
    F: Fn(String) -> Fut + Send + Sync,
    Fut: Future<Output = Result<Vec<u8>, String>> + Send,
{
    let folders = load_folders(db, labels, &options.folder_ids);
    let total = count_mails(db, &folders);

    let (mut exported, mut local_copy, mut failed, mut processed) = (0u32, 0u32, 0u32, 0u32);
    let mut stopped_early = false;
    let emit = |processed: u32, local_copy: u32, failed: u32| {
        progress(ExportProgress { processed, total, local_copy, failed });
    };
    emit(0, 0, 0);

    let mut account_dirs: HashMap<String, (String, NameSet)> = HashMap::new();
    let mut root_names = NameSet::new();
    let mut accounts: Vec<IndexAccount> = Vec::new();
    let mut account_pos: HashMap<String, usize> = HashMap::new();
    let mut local_list: Vec<IndexEntry> = Vec::new();
    let mut failed_list: Vec<IndexEntry> = Vec::new();

    for folder in &folders {
        let (account_dir, folder_names) = account_dirs
            .entry(folder.account_id.clone())
            .or_insert_with(|| (root_names.claim(&safe_segment(&folder.account_email, ACCOUNT_DIR_CHARS)), NameSet::new()));
        let folder_dir = folder_names.claim(&safe_segment(&folder.name, FOLDER_DIR_CHARS));
        let folder_path: PathBuf = out_dir.join(&*account_dir).join(&folder_dir);
        let rel_dir = format!("{}/{}", url_encode_segment(account_dir), url_encode_segment(&folder_dir));

        let mut mail_names = NameSet::new();
        let mut entries: Vec<IndexEntry> = Vec::new();
        let mut after: Option<(String, String)> = None;

        loop {
            let rows = read_chunk(db, &folder.id, &after);
            let Some(last) = rows.last() else { break };
            after = Some((last.date.clone(), last.id.clone()));
            if cancel.load(Ordering::SeqCst) {
                stopped_early = true;
                break;
            }

            let jobs: Vec<(usize, MailRow, String)> = rows
                .into_iter()
                .enumerate()
                .map(|(i, row)| {
                    let stamp = local_naive(parse_local_date(&row.date));
                    let base = mail_names.claim(&safe_segment(&mail_base_name(stamp, &row.subject), MAIL_BASE_CHARS));
                    (i, row, base)
                })
                .collect();

            let fetch_ref = &fetch;
            let (folder_ref, path_ref, rel_ref) = (folder, folder_path.as_path(), rel_dir.as_str());
            let mut running = stream::iter(jobs)
                .map(move |(i, row, base)| async move {
                    let fallback = failed_entry(&row);
                    let work = process_mail(db, fetch_ref, options, labels, cancel, folder_ref, path_ref, rel_ref, row, base);
                    let result = AssertUnwindSafe(work).catch_unwind().await.unwrap_or_else(|_| {
                        log::error!("mail export: processing a mail panicked, listing it as failed");
                        Some(MailResult { outcome: MailOutcome::Failed, entry: fallback })
                    });
                    (i, result)
                })
                .buffer_unordered(CONCURRENCY);

            let mut done: Vec<(usize, MailResult)> = Vec::new();
            while let Some((i, result)) = running.next().await {
                let Some(result) = result else {
                    stopped_early = true;
                    continue;
                };
                processed += 1;
                match result.outcome {
                    MailOutcome::Original => exported += 1,
                    MailOutcome::LocalCopy => local_copy += 1,
                    MailOutcome::Failed => failed += 1,
                }
                if processed % PROGRESS_EVERY == 0 {
                    emit(processed, local_copy, failed);
                }
                done.push((i, result));
            }
            done.sort_by_key(|(i, _)| *i);
            for (_, result) in done {
                match result.outcome {
                    MailOutcome::Original => entries.push(result.entry),
                    MailOutcome::LocalCopy => {
                        local_list.push(result.entry.clone());
                        entries.push(result.entry);
                    }
                    MailOutcome::Failed => failed_list.push(result.entry),
                }
            }
            if stopped_early {
                break;
            }
        }

        let pos = *account_pos.entry(folder.account_id.clone()).or_insert_with(|| {
            accounts.push(IndexAccount { name: folder.account_name.clone(), email: folder.account_email.clone(), folders: Vec::new() });
            accounts.len() - 1
        });
        accounts[pos].folders.push(IndexFolder {
            id: folder.id.clone(),
            name: folder.name.clone(),
            folder_type: folder.folder_type.clone(),
            mails: entries,
        });
    }
    emit(processed, local_copy, failed);

    let data = IndexData {
        created_at: chrono::Local::now().to_rfc3339(),
        cancelled: stopped_early,
        accounts,
        local_copy: local_list,
        failed: failed_list,
    };
    if let Err(e) = write_assets(out_dir, labels, &data) {
        log::warn!("mail export: writing the index failed: {e}");
    }

    ExportSummary { path: out_dir.to_string_lossy().into_owned(), exported, local_copy, failed, cancelled: stopped_early }
}

fn write_assets(out_dir: &Path, labels: &ExportLabels, data: &IndexData) -> Result<(), String> {
    let assets = out_dir.join("assets");
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    write_file(&assets.join("style.css"), STYLE_CSS.as_bytes())?;
    write_file(&assets.join("app.js"), APP_JS.as_bytes())?;
    write_file(&assets.join("index-data.js"), render_index_data_js(data).as_bytes())?;
    write_file(&out_dir.join("index.html"), render_index_html(labels, data.cancelled).as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::test_support::{seed_account, seed_folder, seed_mail, temp_db, SeedMail};
    use std::collections::HashMap;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;

    const FIXTURE_SUBJECT: &str = "Angebot Neubau Waldweg";

    fn fixture() -> Vec<u8> {
        let src = "From: Jonas Brandt <jonas.brandt@studio-halde.example>\n\
To: Anna Weber <anna@studio-halde.example>\n\
Subject: Angebot Neubau Waldweg\n\
Date: Wed, 21 Oct 2026 15:28:44 +0200\n\
MIME-Version: 1.0\n\
Content-Type: multipart/mixed; boundary=\"outer\"\n\
\n\
--outer\n\
Content-Type: multipart/related; boundary=\"rel\"\n\
\n\
--rel\n\
Content-Type: text/html; charset=utf-8\n\
\n\
<p>Hallo Anna</p><img src=\"cid:logo@halde\">\n\
--rel\n\
Content-Type: image/png; name=\"logo.png\"\n\
Content-Transfer-Encoding: base64\n\
Content-ID: <logo@halde>\n\
Content-Disposition: inline; filename=\"logo.png\"\n\
\n\
iVBORw0KGgo=\n\
--rel--\n\
--outer\n\
Content-Type: application/pdf; name=\"Plaene.pdf\"\n\
Content-Transfer-Encoding: base64\n\
Content-Disposition: attachment; filename=\"Plaene.pdf\"\n\
\n\
JVBERi0xLjQ=\n\
--outer--\n";
        src.replace('\n', "\r\n").into_bytes()
    }

    struct Out(PathBuf);

    impl Out {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("prudii-export-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Out(dir)
        }
    }

    impl Drop for Out {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn labels() -> ExportLabels {
        ExportLabels {
            lang: "de".into(),
            title: "Prudii Export".into(),
            local_copy_note: "Aus lokaler Kopie, kein Original.".into(),
            folder_names: HashMap::from([("inbox".to_string(), "Posteingang".to_string())]),
            ..Default::default()
        }
    }

    fn options(folder_ids: Vec<String>) -> ExportOptions {
        ExportOptions { folder_ids, html: true, eml: true, include_attachments: true }
    }

    struct World {
        db: Database,
        account: String,
        folder: String,
    }

    fn world() -> World {
        let db = temp_db();
        let (account, folder) = {
            let conn = db.lock_db();
            let account = seed_account(&conn, "anna@studio-halde.example");
            let folder = seed_folder(&conn, &account, "inbox");
            (account, folder)
        };
        World { db, account, folder }
    }

    fn add_mail(w: &World, subject: &str, date: &str) -> String {
        let conn = w.db.lock_db();
        seed_mail(
            &conn,
            &SeedMail {
                account_id: &w.account,
                folder_id: &w.folder,
                from_email: "jonas.brandt@studio-halde.example",
                subject,
                date,
                ..Default::default()
            },
        )
    }

    fn set_body(w: &World, id: &str, html: &str, text: &str) {
        let conn = w.db.lock_db();
        conn.execute("UPDATE mails SET body_html = ?1, body_text = ?2 WHERE id = ?3", rusqlite::params![html, text, id]).unwrap();
    }

    fn files(root: &Path, ext: &str) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let p = entry.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().is_some_and(|e| e == ext) && !p.starts_with(root.join("assets")) && p != root.join("index.html") {
                    out.push(p);
                }
            }
        }
        out
    }

    fn index_data(out: &Path) -> String {
        std::fs::read_to_string(out.join("assets").join("index-data.js")).unwrap()
    }

    async fn run(
        w: &World,
        opts: &ExportOptions,
        out: &Path,
        results: HashMap<String, Result<Vec<u8>, String>>,
    ) -> ExportSummary {
        let cancel = AtomicBool::new(false);
        run_export(
            &w.db,
            opts,
            &labels(),
            out,
            move |id| {
                let r = results.get(&id).cloned().unwrap_or_else(|| Err("offline".into()));
                async move { r }
            },
            &cancel,
            |_| {},
        )
        .await
    }

    #[tokio::test]
    async fn original_mail_writes_identical_eml_and_page() {
        let w = world();
        let id = add_mail(&w, FIXTURE_SUBJECT, "2026-10-21 13:28:44");
        let out = Out::new();
        let seen = Mutex::new(Vec::new());
        let cancel = AtomicBool::new(false);
        let raw = fixture();
        let summary = run_export(
            &w.db,
            &options(vec![w.folder.clone()]),
            &labels(),
            &out.0,
            |_| {
                let raw = raw.clone();
                async move { Ok(raw) }
            },
            &cancel,
            |p| seen.lock().unwrap().push(p),
        )
        .await;
        let _ = id;
        let eml = files(&out.0, "eml");
        let html = files(&out.0, "html");
        assert_eq!(eml.len(), 1);
        assert_eq!(html.len(), 1);
        assert_eq!(std::fs::read(&eml[0]).unwrap(), raw);
        assert!(eml[0].starts_with(out.0.join("anna@studio-halde.example").join("Posteingang")));
        assert!(index_data(&out.0).contains(FIXTURE_SUBJECT));
        assert!(out.0.join("index.html").exists());
        assert_eq!((summary.exported, summary.local_copy, summary.failed, summary.cancelled), (1, 0, 0, false));
        let last = seen.lock().unwrap().last().cloned().unwrap();
        assert_eq!((last.processed, last.total), (1, 1));
    }

    #[tokio::test]
    async fn failed_fetch_uses_local_copy_when_present() {
        let w = world();
        let id = add_mail(&w, "Termin", "2026-10-21 13:28:44");
        set_body(&w, &id, "<p>Hallo Anna</p>", "");
        w.db.lock_db()
            .execute("UPDATE mails SET to_json = '[{\"email\":\"anna@studio-halde.example\",\"name\":\"Anna Weber\"}]'", [])
            .unwrap();
        let out = Out::new();
        let summary = run(&w, &options(vec![w.folder.clone()]), &out.0, HashMap::new()).await;
        let page = std::fs::read_to_string(&files(&out.0, "html")[0]).unwrap();
        assert!(page.contains("Hallo Anna") && page.contains(&labels().local_copy_note));
        assert_eq!(files(&out.0, "eml").len(), 1);
        assert_eq!((summary.exported, summary.local_copy, summary.failed), (0, 1, 0));
        assert!(index_data(&out.0).contains("\"localCopy\":[{"));
    }

    #[tokio::test]
    async fn failed_fetch_without_local_content_is_listed_not_written() {
        let w = world();
        add_mail(&w, "Leer", "2026-10-21 13:28:44");
        let out = Out::new();
        let summary = run(&w, &options(vec![w.folder.clone()]), &out.0, HashMap::new()).await;
        assert!(files(&out.0, "html").is_empty() && files(&out.0, "eml").is_empty());
        let data = index_data(&out.0);
        let failed = &data[data.find("\"failed\":").unwrap()..];
        assert!(failed.contains("Leer") && failed.contains("\"h\":null"));
        assert_eq!((summary.exported, summary.local_copy, summary.failed), (0, 0, 1));
    }

    #[tokio::test]
    async fn local_imap_folder_never_calls_fetch() {
        let w = world();
        let id = add_mail(&w, "Lokal", "2026-10-21 13:28:44");
        set_body(&w, &id, "", "Nur Text");
        w.db.lock_db().execute("UPDATE folders SET is_local = 1", []).unwrap();
        let out = Out::new();
        let cancel = AtomicBool::new(false);
        let summary = run_export(
            &w.db,
            &options(vec![w.folder.clone()]),
            &labels(),
            &out.0,
            |_| async { panic!("fetch must not be called") as Result<Vec<u8>, String> },
            &cancel,
            |_| {},
        )
        .await;
        assert_eq!(summary.local_copy, 1);
        assert_eq!(files(&out.0, "html").len(), 1);
    }

    #[tokio::test]
    async fn local_folder_of_an_api_account_still_fetches() {
        let w = world();
        add_mail(&w, FIXTURE_SUBJECT, "2026-10-21 13:28:44");
        w.db.lock_db().execute("UPDATE folders SET is_local = 1", []).unwrap();
        w.db.lock_db().execute("UPDATE accounts SET provider = 'google'", []).unwrap();
        let out = Out::new();
        let called = AtomicBool::new(false);
        let cancel = AtomicBool::new(false);
        let raw = fixture();
        let summary = run_export(
            &w.db,
            &options(vec![w.folder.clone()]),
            &labels(),
            &out.0,
            |_| {
                called.store(true, std::sync::atomic::Ordering::SeqCst);
                let raw = raw.clone();
                async move { Ok::<_, String>(raw) }
            },
            &cancel,
            |_| {},
        )
        .await;
        assert!(called.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(summary.exported, 1);
    }

    fn fetch_all(w: &World, id: &str) -> HashMap<String, Result<Vec<u8>, String>> {
        let _ = w;
        HashMap::from([(id.to_string(), Ok(fixture()))])
    }

    #[tokio::test]
    async fn attachments_toggle_keeps_inline_images() {
        let w = world();
        let id = add_mail(&w, FIXTURE_SUBJECT, "2026-10-21 13:28:44");

        let without = Out::new();
        let opts = ExportOptions { include_attachments: false, ..options(vec![w.folder.clone()]) };
        run(&w, &opts, &without.0, fetch_all(&w, &id)).await;
        let page = files(&without.0, "html").remove(0);
        let dir = page.with_extension("");
        assert!(dir.join("logo.png").exists() && !dir.join("Plaene.pdf").exists());
        let html = std::fs::read_to_string(&page).unwrap();
        assert!(html.contains("Plaene.pdf") && !html.contains("/Plaene.pdf\""));

        let with = Out::new();
        run(&w, &options(vec![w.folder.clone()]), &with.0, fetch_all(&w, &id)).await;
        let page = files(&with.0, "html").remove(0);
        let dir = page.with_extension("");
        assert!(dir.join("logo.png").exists() && dir.join("Plaene.pdf").exists());
        let html = std::fs::read_to_string(&page).unwrap();
        assert!(html.contains("/Plaene.pdf\""));
        assert!(html.contains("/logo.png"));
    }

    #[tokio::test]
    async fn cancel_stops_and_marks_index_incomplete() {
        let w = world();
        for i in 0..10 {
            add_mail(&w, &format!("Mail {i}"), &format!("2026-10-{:02} 10:00:00", i + 1));
        }
        let out = Out::new();
        let cancel = AtomicBool::new(false);
        let summary = run_export(
            &w.db,
            &options(vec![w.folder.clone()]),
            &labels(),
            &out.0,
            |_| async { Ok::<_, String>(fixture()) },
            &cancel,
            |_| cancel.store(true, std::sync::atomic::Ordering::SeqCst),
        )
        .await;
        assert!(summary.cancelled);
        assert!(index_data(&out.0).contains("\"cancelled\":true"));
        assert!(out.0.join("index.html").exists());
    }

    #[tokio::test]
    async fn a_mail_that_panics_is_listed_as_failed_and_the_rest_continues() {
        let w = world();
        let bad = add_mail(&w, "Kaputt", "2026-10-21 13:28:44");
        add_mail(&w, FIXTURE_SUBJECT, "2026-10-22 08:00:00");
        let out = Out::new();
        let cancel = AtomicBool::new(false);
        let summary = run_export(
            &w.db,
            &options(vec![w.folder.clone()]),
            &labels(),
            &out.0,
            move |id| {
                let hostile = id == bad;
                async move {
                    if hostile {
                        panic!("hostile mail");
                    }
                    Ok::<_, String>(fixture())
                }
            },
            &cancel,
            |_| {},
        )
        .await;
        assert_eq!((summary.exported, summary.failed, summary.cancelled), (1, 1, false));
        assert!(out.0.join("index.html").exists());
        let data = index_data(&out.0);
        assert!(data[data.find("\"failed\":").unwrap()..].contains("Kaputt"));
    }

    #[tokio::test]
    async fn formats_can_be_chosen_separately() {
        let w = world();
        let id = add_mail(&w, FIXTURE_SUBJECT, "2026-10-21 13:28:44");

        let eml_only = Out::new();
        let opts = ExportOptions { html: false, ..options(vec![w.folder.clone()]) };
        run(&w, &opts, &eml_only.0, fetch_all(&w, &id)).await;
        assert!(files(&eml_only.0, "html").is_empty());
        assert_eq!(files(&eml_only.0, "eml").len(), 1);
        assert!(eml_only.0.join("index.html").exists());
        assert!(files(&eml_only.0, "png").is_empty());

        let html_only = Out::new();
        let opts = ExportOptions { eml: false, ..options(vec![w.folder.clone()]) };
        run(&w, &opts, &html_only.0, fetch_all(&w, &id)).await;
        assert!(files(&html_only.0, "eml").is_empty());
        assert_eq!(files(&html_only.0, "html").len(), 1);
    }

    #[tokio::test]
    async fn same_subject_and_minute_get_distinct_files_newest_first() {
        let w = world();
        let a = add_mail(&w, "Gleich", "2026-10-21 13:28:10");
        let b = add_mail(&w, "Gleich", "2026-10-21 13:28:40");
        let c = add_mail(&w, "Neuer", "2026-10-22 08:00:00");
        for id in [&a, &b, &c] {
            set_body(&w, id, "<p>x</p>", "");
        }
        let out = Out::new();
        let summary = run(&w, &options(vec![w.folder.clone()]), &out.0, HashMap::new()).await;
        assert_eq!(summary.local_copy, 3);
        assert_eq!(files(&out.0, "html").len(), 3);
        let data = index_data(&out.0);
        assert!(data.find("Neuer").unwrap() < data.find("Gleich").unwrap());
    }

    #[test]
    fn previews_come_from_text_or_stripped_html() {
        let mut mail = ParsedMail {
            subject: String::new(),
            from: Default::default(),
            to: vec![],
            cc: vec![],
            date: None,
            html: Some("<style>p{color:red}</style><p>Hallo&nbsp;<b>Anna</b> &amp; Jonas</p>".into()),
            text: None,
            parts: vec![],
        };
        assert_eq!(preview(&mail), "Hallo Anna & Jonas");
        mail.text = Some("Zeile eins\n\n  Zeile   zwei".into());
        assert_eq!(preview(&mail), "Zeile eins Zeile zwei");
        mail.text = Some("x".repeat(500));
        assert_eq!(preview(&mail).chars().count(), 120);
    }

    #[tokio::test]
    async fn local_copy_the_eml_builder_rejects_still_gets_a_page() {
        let w = world();
        let id = add_mail(&w, "Ohne Empfaenger", "2026-10-21 13:28:44");
        set_body(&w, &id, "<p>Hallo</p>", "");
        let out = Out::new();
        let summary = run(&w, &options(vec![w.folder.clone()]), &out.0, HashMap::new()).await;
        assert_eq!(summary.local_copy, 1);
        assert_eq!(files(&out.0, "html").len(), 1);
        assert!(files(&out.0, "eml").is_empty());
    }
}
