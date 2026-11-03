use crate::categorize::signals::HeaderSignals;
use crate::categorize::store::load_correspondents;
use crate::db::Database;
use crate::unsubscribe::header::{parse_targets, plan_methods, Method};
use crate::unsubscribe::key::{list_id_name, list_id_value, list_key, sender_key, KeyKind, ListKey, MailFacts};
use crate::unsubscribe::send::{http_client, mailto_message, AppTransport, Failure, Transport};
use crate::unsubscribe::store::{self, Unsubscription, UnsubscriptionView};
use crate::unsubscribe::sweep::trash_existing;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

const ERR_FAILED: &str = "unsubscribe.errors.failed";
const ERR_NO_TARGET: &str = "unsubscribe.errors.noTarget";
const ERR_SPAM: &str = "unsubscribe.errors.spam";

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Offer {
    Unsubscribe,
    Block,
    None,
}

#[derive(Serialize)]
pub struct ListStatus {
    pub offer: Offer,
    pub name: String,
    pub subscription: Option<UnsubscriptionView>,
}

#[derive(Debug, Serialize)]
pub struct UnsubscribeOutcome {
    pub subscription: UnsubscriptionView,
    pub web_url: Option<String>,
    pub trashed: u32,
}

struct MailRow {
    account_id: String,
    from_name: String,
    from_email: String,
    signal_headers: String,
    list_unsubscribe: String,
    folder_type: String,
    category: Option<String>,
}

impl MailRow {
    fn facts(&self) -> MailFacts<'_> {
        MailFacts { from_email: &self.from_email, signal_headers: &self.signal_headers, list_unsubscribe: &self.list_unsubscribe }
    }

    fn sender_name(&self) -> &str {
        if self.from_name.trim().is_empty() { &self.from_email } else { &self.from_name }
    }

    fn list_name(&self) -> String {
        list_id_name(&self.signal_headers).unwrap_or_else(|| self.sender_name().to_string())
    }

    fn offer(&self, conn: &Connection) -> (Offer, Option<ListKey>) {
        let has_header = !self.list_unsubscribe.trim().is_empty();
        if has_header && may_contact(conn, self) && !plan_methods(&parse_targets(&self.list_unsubscribe), true).is_empty() {
            if let Some(key) = list_key(&self.facts()) {
                return (Offer::Unsubscribe, Some(key));
            }
        }
        let blockable = has_header || self.folder_type == "spam" || matches!(self.category.as_deref(), Some("newsletters" | "promotions"));
        match sender_key(&self.from_email) {
            Some(key) if blockable => (Offer::Block, Some(key)),
            _ => (Offer::None, None),
        }
    }
}

/// Trash hides where a mail came from; only a copy kept outside spam and trash shows the list is real.
fn may_contact(conn: &Connection, mail: &MailRow) -> bool {
    match mail.folder_type.as_str() {
        "spam" => false,
        "trash" => conn
            .query_row(
                "SELECT 1 FROM mails m JOIN folders f ON m.folder_id = f.id
                 WHERE m.account_id = ?1 AND m.list_unsubscribe = ?2 AND f.folder_type NOT IN ('spam', 'trash') LIMIT 1",
                params![mail.account_id, mail.list_unsubscribe],
                |_| Ok(()),
            )
            .is_ok(),
        _ => true,
    }
}

fn load_mail(conn: &Connection, mail_id: &str) -> Result<MailRow, String> {
    conn.query_row(
        "SELECT m.account_id, COALESCE(m.from_name, ''), COALESCE(m.from_email, ''), COALESCE(m.signal_headers, ''),
                COALESCE(m.list_unsubscribe, ''), COALESCE(f.folder_type, ''), m.category
         FROM mails m LEFT JOIN folders f ON m.folder_id = f.id WHERE m.id = ?1",
        params![mail_id],
        |r| {
            Ok(MailRow {
                account_id: r.get(0)?,
                from_name: r.get(1)?,
                from_email: r.get(2)?,
                signal_headers: r.get(3)?,
                list_unsubscribe: r.get(4)?,
                folder_type: r.get(5)?,
                category: r.get(6)?,
            })
        },
    )
    .map_err(|e| format!("Mail not found: {e}"))
}

fn one_click_offered(signal_headers: &str, list_unsubscribe: &str) -> bool {
    HeaderSignals::parse(signal_headers, list_unsubscribe).one_click
}

/// Older mail predates storing List-Unsubscribe-Post, so a newer copy of the very same header may vouch for one-click.
fn plan_for_mail(conn: &Connection, mail: &MailRow) -> Vec<Method> {
    let offered = one_click_offered(&mail.signal_headers, &mail.list_unsubscribe)
        || conn
            .prepare(
                "SELECT COALESCE(m.signal_headers, '') FROM mails m JOIN folders f ON m.folder_id = f.id
                 WHERE m.account_id = ?1 AND m.list_unsubscribe = ?2 AND f.folder_type != 'spam'",
            )
            .and_then(|mut stmt| {
                stmt.query_map(params![mail.account_id, mail.list_unsubscribe], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap_or_default()
            .iter()
            .any(|headers| one_click_offered(headers, &mail.list_unsubscribe));
    plan_methods(&parse_targets(&mail.list_unsubscribe), offered)
}

/// A retry has no clicked mail; spam is skipped because a spoofed copy could carry a stranger's target.
fn plan_for(conn: &Connection, account_id: &str, key: &ListKey) -> Vec<Method> {
    let (narrow, value) = match key.kind {
        KeyKind::ListId => ("instr(lower(COALESCE(m.signal_headers, '')), ?2) > 0", key.value.as_str()),
        KeyKind::Sender => ("lower(m.from_email) = ?2", key.value.as_str()),
    };
    let sql = format!(
        "SELECT COALESCE(m.signal_headers, ''), m.list_unsubscribe FROM mails m JOIN folders f ON m.folder_id = f.id
         WHERE m.account_id = ?1 AND {narrow} AND COALESCE(m.list_unsubscribe, '') != '' AND f.folder_type != 'spam'
         ORDER BY m.date DESC LIMIT 50"
    );
    let rows: Vec<(String, String)> = conn
        .prepare(&sql)
        .and_then(|mut stmt| stmt.query_map(params![account_id, value], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
        .unwrap_or_default();
    rows.into_iter()
        .find(|(headers, _)| key.kind != KeyKind::ListId || list_id_value(headers).as_deref() == Some(key.value.as_str()))
        .map(|(headers, unsub)| plan_methods(&parse_targets(&unsub), one_click_offered(&headers, &unsub)))
        .unwrap_or_default()
}

fn untried(plan: Vec<Method>, tried: &[String]) -> Vec<Method> {
    plan.into_iter().filter(|m| !tried.iter().any(|t| t == m.kind())).collect()
}

/// The overview already holds each list's newest mail, so it skips the account-wide search in `can_retry`.
pub(crate) fn retry_left(sub: &Unsubscription, signal_headers: &str, list_unsubscribe: &str, now: DateTime<Utc>) -> bool {
    store::status(sub, now) == "still_sending"
        && !untried(plan_methods(&parse_targets(list_unsubscribe), one_click_offered(signal_headers, list_unsubscribe)), &sub.methods_tried).is_empty()
}

pub(crate) fn can_retry(conn: &Connection, sub: &Unsubscription, now: DateTime<Utc>) -> bool {
    store::status(sub, now) == "still_sending" && !untried(plan_for(conn, &sub.account_id, &sub.key), &sub.methods_tried).is_empty()
}

pub(crate) fn list_status(conn: &Connection, mail_id: &str, now: DateTime<Utc>) -> Result<ListStatus, String> {
    let mail = load_mail(conn, mail_id)?;
    let (offer, key) = mail.offer(conn);
    let name = if offer == Offer::Unsubscribe { mail.list_name() } else { mail.sender_name().to_string() };
    let subscription = match key {
        Some(key) => store::find(conn, &mail.account_id, &key)
            .map_err(|e| e.to_string())?
            .map(|sub| store::view(&sub, now, can_retry(conn, &sub, now))),
        None => None,
    };
    Ok(ListStatus { offer, name, subscription })
}

/// The first way that goes out wins; a web page counts because the user finishes it there.
async fn run_plan<T: Transport>(transport: &T, account_id: &str, plan: &[Method]) -> Result<(&'static str, Option<String>), String> {
    let mut attempted = false;
    let mut unreachable = false;
    for method in plan {
        let sent = match method {
            Method::OneClick(url) => transport.one_click(url).await,
            Method::Mailto(target) => transport.send_mail(account_id, mailto_message(target)).await,
            // Without a network the page would not load, and a waiting status would claim a request went out.
            Method::Web(_) if unreachable => break,
            Method::Web(url) => return Ok(("web", Some(url.clone()))),
        };
        attempted = true;
        match sent {
            Ok(()) => return Ok((method.kind(), None)),
            Err(e) => {
                unreachable |= matches!(e, Failure::Unreachable(_));
                log::warn!("unsubscribe via {} failed: {}", method.kind(), e);
            }
        }
    }
    Err(if attempted { ERR_FAILED } else { ERR_NO_TARGET }.to_string())
}

fn finish(conn: &Connection, sub: Unsubscription, web_url: Option<String>, trash: bool, now: DateTime<Utc>) -> UnsubscribeOutcome {
    let trashed = if trash { trash_existing(conn, &sub, &load_correspondents(conn)) } else { 0 };
    UnsubscribeOutcome { subscription: store::view(&sub, now, false), web_url, trashed }
}

pub(crate) async fn perform_unsubscribe<T: Transport>(
    db: &Database,
    transport: &T,
    mail_id: &str,
    trash: bool,
    now: DateTime<Utc>,
) -> Result<UnsubscribeOutcome, String> {
    let (mail, key, plan) = {
        let conn = db.lock_db();
        let mail = load_mail(&conn, mail_id)?;
        if !may_contact(&conn, &mail) {
            return Err(ERR_SPAM.into());
        }
        let key = list_key(&mail.facts()).filter(|_| !mail.list_unsubscribe.trim().is_empty()).ok_or(ERR_NO_TARGET)?;
        if let Some(existing) = store::find(&conn, &mail.account_id, &key).map_err(|e| e.to_string())? {
            let ready = can_retry(&conn, &existing, now);
            return Ok(UnsubscribeOutcome { subscription: store::view(&existing, now, ready), web_url: None, trashed: 0 });
        }
        let plan = plan_for_mail(&conn, &mail);
        (mail, key, plan)
    };
    if plan.is_empty() {
        return Err(ERR_NO_TARGET.into());
    }
    let (method, web_url) = run_plan(transport, &mail.account_id, &plan).await?;
    let conn = db.lock_db();
    let sub = match store::insert_request(&conn, &mail.account_id, &key, &mail.list_name(), method, web_url.is_some(), now) {
        Ok(sub) => sub,
        // A parallel click already stored the list.
        Err(_) => store::find(&conn, &mail.account_id, &key).ok().flatten().ok_or(ERR_FAILED)?,
    };
    Ok(finish(&conn, sub, web_url, trash, now))
}

pub(crate) fn perform_block(db: &Database, mail_id: &str, trash: bool, now: DateTime<Utc>) -> Result<UnsubscribeOutcome, String> {
    let conn = db.lock_db();
    let mail = load_mail(&conn, mail_id)?;
    let key = sender_key(&mail.from_email).ok_or(ERR_NO_TARGET)?;
    if let Some(existing) = store::find(&conn, &mail.account_id, &key).map_err(|e| e.to_string())? {
        return Ok(UnsubscribeOutcome { subscription: store::view(&existing, now, false), web_url: None, trashed: 0 });
    }
    let sub = store::insert_block(&conn, &mail.account_id, &key, mail.sender_name(), now).map_err(|e| e.to_string())?;
    Ok(finish(&conn, sub, None, trash, now))
}

pub(crate) async fn perform_retry<T: Transport>(db: &Database, transport: &T, id: &str, now: DateTime<Utc>) -> Result<UnsubscribeOutcome, String> {
    let (sub, plan) = {
        let conn = db.lock_db();
        let sub = store::get(&conn, id).map_err(|e| e.to_string())?.ok_or(ERR_FAILED)?;
        if store::status(&sub, now) != "still_sending" {
            return Err(ERR_FAILED.into());
        }
        let plan = untried(plan_for(&conn, &sub.account_id, &sub.key), &sub.methods_tried);
        (sub, plan)
    };
    if plan.is_empty() {
        return Err(ERR_NO_TARGET.into());
    }
    let (method, web_url) = run_plan(transport, &sub.account_id, &plan).await?;
    let conn = db.lock_db();
    store::record_retry(&conn, &sub.id, method, web_url.is_some(), now).map_err(|e| e.to_string())?;
    let sub = store::get(&conn, &sub.id).map_err(|e| e.to_string())?.ok_or(ERR_FAILED)?;
    Ok(UnsubscribeOutcome { subscription: store::view(&sub, now, false), web_url, trashed: 0 })
}

fn transport(app: tauri::AppHandle) -> Result<AppTransport, String> {
    let client = http_client().map_err(|e| {
        log::error!("unsubscribe http client: {e}");
        ERR_FAILED.to_string()
    })?;
    Ok(AppTransport { app, client })
}

#[tauri::command]
pub async fn unsubscribe_mail(app: tauri::AppHandle, db: State<'_, Database>, mail_id: String, trash_existing: bool) -> Result<UnsubscribeOutcome, String> {
    perform_unsubscribe(&db, &transport(app)?, &mail_id, trash_existing, Utc::now()).await
}

#[tauri::command(async)]
pub fn block_sender(db: State<'_, Database>, mail_id: String, trash_existing: bool) -> Result<UnsubscribeOutcome, String> {
    perform_block(&db, &mail_id, trash_existing, Utc::now())
}

#[tauri::command(async)]
pub fn get_list_status(db: State<'_, Database>, mail_id: String) -> Result<ListStatus, String> {
    list_status(&db.read_db(), &mail_id, Utc::now())
}

#[tauri::command(async)]
pub fn allow_list_again(db: State<'_, Database>, id: String) -> Result<(), String> {
    store::delete(&db.lock_db(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn retry_unsubscribe(app: tauri::AppHandle, db: State<'_, Database>, id: String) -> Result<UnsubscribeOutcome, String> {
    perform_retry(&db, &transport(app)?, &id, Utc::now()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smtp::EmailMessage;
    use crate::test_support::{seed_account, seed_folder, seed_mail, temp_db, SeedMail};
    use std::future::Future;
    use std::sync::Mutex;

    const LIST: &str = r#"{"list-id":"<wr.halde-shop.example>"}"#;
    const ONE_CLICK: &str = r#"{"list-id":"<wr.halde-shop.example>","list-unsubscribe-post":"List-Unsubscribe=One-Click"}"#;
    const FULL: &str = "<https://news.halde-shop.example/u>, <mailto:unsub@halde-shop.example>";
    const WEB_ONLY: &str = "<https://news.halde-shop.example/u>";

    struct Fake {
        one_click: Result<(), Failure>,
        mail: Result<(), Failure>,
        calls: Mutex<Vec<&'static str>>,
    }

    fn fake(one_click: Result<(), Failure>, mail: Result<(), Failure>) -> Fake {
        Fake { one_click, mail, calls: Mutex::new(Vec::new()) }
    }

    fn down() -> Result<(), Failure> {
        Err(Failure::Unreachable("offline".into()))
    }

    fn refused() -> Result<(), Failure> {
        Err(Failure::Rejected("410 Gone".into()))
    }

    impl Transport for Fake {
        fn one_click(&self, _url: &str) -> impl Future<Output = Result<(), Failure>> + Send {
            self.calls.lock().unwrap().push("one_click");
            std::future::ready(self.one_click.clone())
        }
        fn send_mail(&self, _account_id: &str, _message: EmailMessage) -> impl Future<Output = Result<(), Failure>> + Send {
            self.calls.lock().unwrap().push("mailto");
            std::future::ready(self.mail.clone())
        }
    }

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn t0() -> DateTime<Utc> {
        at("2026-10-01T08:00:00Z")
    }

    struct Fx {
        db: Database,
        account: String,
        inbox: String,
    }

    fn fx() -> Fx {
        let db = temp_db();
        let (account, inbox) = {
            let conn = db.lock_db();
            let account = seed_account(&conn, "me@studio-halde.example");
            let inbox = seed_folder(&conn, &account, "inbox");
            seed_folder(&conn, &account, "trash");
            (account, inbox)
        };
        Fx { db, account, inbox }
    }

    fn mail(f: &Fx, headers: &str, unsub: &str, date: &str) -> String {
        seed_mail(
            &f.db.lock_db(),
            &SeedMail {
                account_id: &f.account,
                folder_id: &f.inbox,
                from_email: "news@halde-shop.example",
                subject: "Wochenrückblick",
                signal_headers: headers,
                list_unsubscribe: unsub,
                date,
                ..Default::default()
            },
        )
    }

    fn rows(f: &Fx) -> u32 {
        f.db.lock_db().query_row("SELECT COUNT(*) FROM unsubscriptions", [], |r| r.get(0)).unwrap()
    }

    fn methods(f: &Fx) -> Vec<String> {
        let raw: String = f.db.lock_db().query_row("SELECT methods_tried FROM unsubscriptions", [], |r| r.get(0)).unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    #[test]
    fn offer_follows_folder_and_headers() {
        let f = fx();
        let list = mail(&f, LIST, FULL, "2026-09-01T09:00:00Z");
        let conn = f.db.lock_db();
        let spam = seed_folder(&conn, &f.account, "spam");
        let in_spam = seed_mail(&conn, &SeedMail { account_id: &f.account, folder_id: &spam, from_email: "news@halde-shop.example", list_unsubscribe: FULL, ..Default::default() });
        let promo = seed_mail(&conn, &SeedMail { account_id: &f.account, folder_id: &f.inbox, from_email: "deals@halde-shop.example", category: Some("newsletters"), ..Default::default() });
        let personal = seed_mail(&conn, &SeedMail { account_id: &f.account, folder_id: &f.inbox, from_email: "anna.weber@studio-halde.example", ..Default::default() });
        let offer = |id: &str| list_status(&conn, id, t0()).unwrap().offer;
        assert_eq!(offer(&list), Offer::Unsubscribe);
        assert_eq!(offer(&in_spam), Offer::Block);
        assert_eq!(offer(&promo), Offer::Block);
        assert_eq!(offer(&personal), Offer::None);
    }

    #[tokio::test]
    async fn one_click_stops_the_chain() {
        let f = fx();
        let id = mail(&f, ONE_CLICK, FULL, "2026-09-01T09:00:00Z");
        let t = fake(Ok(()), Ok(()));
        let out = perform_unsubscribe(&f.db, &t, &id, false, t0()).await.unwrap();
        assert_eq!(*t.calls.lock().unwrap(), ["one_click"]);
        assert_eq!(methods(&f), ["one_click"]);
        assert_eq!(out.subscription.status, "waiting");
        assert_eq!(out.web_url, None);
    }

    #[tokio::test]
    async fn failed_one_click_falls_through_to_mailto() {
        let f = fx();
        let id = mail(&f, ONE_CLICK, FULL, "2026-09-01T09:00:00Z");
        let t = fake(refused(), Ok(()));
        perform_unsubscribe(&f.db, &t, &id, false, t0()).await.unwrap();
        assert_eq!(*t.calls.lock().unwrap(), ["one_click", "mailto"]);
        assert_eq!(methods(&f), ["mailto"]);
    }

    #[tokio::test]
    async fn web_only_returns_url_and_marks_pending() {
        let f = fx();
        let id = mail(&f, LIST, WEB_ONLY, "2026-09-01T09:00:00Z");
        let t = fake(Ok(()), Ok(()));
        let out = perform_unsubscribe(&f.db, &t, &id, false, t0()).await.unwrap();
        assert_eq!(out.web_url.as_deref(), Some("https://news.halde-shop.example/u"));
        assert!(out.subscription.web_pending);
        assert!(t.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn nothing_sent_creates_no_entry() {
        let f = fx();
        let id = mail(&f, LIST, "<mailto:unsub@halde-shop.example>", "2026-09-01T09:00:00Z");
        let t = fake(down(), down());
        assert_eq!(perform_unsubscribe(&f.db, &t, &id, false, t0()).await.unwrap_err(), "unsubscribe.errors.failed");
        assert_eq!(*t.calls.lock().unwrap(), ["mailto"]);
        assert_eq!(rows(&f), 0);
    }

    fn set_from_name(f: &Fx, id: &str, name: &str) {
        f.db.lock_db().execute("UPDATE mails SET from_name = ?1 WHERE id = ?2", [name, id]).unwrap();
    }

    #[tokio::test]
    async fn mailing_list_is_named_after_the_list() {
        let f = fx();
        let id = mail(&f, r#"{"list-id":"Studio-Halde-Forum <forum.studio-halde.example>"}"#, FULL, "2026-09-01T09:00:00Z");
        set_from_name(&f, &id, "Anna Weber");
        assert_eq!(list_status(&f.db.lock_db(), &id, t0()).unwrap().name, "Studio-Halde-Forum");
        let out = perform_unsubscribe(&f.db, &fake(Ok(()), Ok(())), &id, false, t0()).await.unwrap();
        assert_eq!(out.subscription.display_name, "Studio-Halde-Forum");
    }

    #[test]
    fn garbage_header_offers_block() {
        let f = fx();
        let id = mail(&f, "{}", "<javascript:alert(1)>", "2026-09-01T09:00:00Z");
        let status = list_status(&f.db.lock_db(), &id, t0()).unwrap();
        assert_eq!(status.offer, Offer::Block);
        assert_eq!(status.name, "news@halde-shop.example");
    }

    fn in_trash(f: &Fx) -> String {
        let trash: String = f
            .db
            .lock_db()
            .query_row("SELECT id FROM folders WHERE account_id = ?1 AND folder_type = 'trash'", [&f.account], |r| r.get(0))
            .unwrap();
        seed_mail(
            &f.db.lock_db(),
            &SeedMail { account_id: &f.account, folder_id: &trash, from_email: "news@halde-shop.example", signal_headers: ONE_CLICK, list_unsubscribe: FULL, ..Default::default() },
        )
    }

    #[tokio::test]
    async fn trash_mail_without_a_kept_copy_only_offers_block() {
        let f = fx();
        let id = in_trash(&f);
        assert_eq!(list_status(&f.db.lock_db(), &id, t0()).unwrap().offer, Offer::Block);
        let t = fake(Ok(()), Ok(()));
        assert_eq!(perform_unsubscribe(&f.db, &t, &id, false, t0()).await.unwrap_err(), "unsubscribe.errors.spam");
        assert!(t.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn trash_mail_with_a_kept_copy_offers_unsubscribe() {
        let f = fx();
        let id = in_trash(&f);
        mail(&f, ONE_CLICK, FULL, "2026-09-01T09:00:00Z");
        assert_eq!(list_status(&f.db.lock_db(), &id, t0()).unwrap().offer, Offer::Unsubscribe);
    }

    #[tokio::test]
    async fn offline_one_click_does_not_open_the_web_page() {
        let f = fx();
        let id = mail(&f, ONE_CLICK, FULL, "2026-09-01T09:00:00Z");
        let t = fake(down(), down());
        assert_eq!(perform_unsubscribe(&f.db, &t, &id, false, t0()).await.unwrap_err(), "unsubscribe.errors.failed");
        assert_eq!(rows(&f), 0);
    }

    #[tokio::test]
    async fn spam_copy_never_supplies_the_target() {
        let f = fx();
        let real = mail(&f, "{}", FULL, "2026-09-01T09:00:00Z");
        let spam = seed_folder(&f.db.lock_db(), &f.account, "spam");
        seed_mail(
            &f.db.lock_db(),
            &SeedMail {
                account_id: &f.account,
                folder_id: &spam,
                from_email: "news@halde-shop.example",
                signal_headers: r#"{"list-unsubscribe-post":"List-Unsubscribe=One-Click"}"#,
                list_unsubscribe: "<https://phish.example/u>",
                date: "2026-12-31T09:00:00Z",
                ..Default::default()
            },
        );
        let t = fake(Ok(()), Ok(()));
        perform_unsubscribe(&f.db, &t, &real, false, t0()).await.unwrap();
        assert_eq!(*t.calls.lock().unwrap(), ["mailto"]);
    }

    #[tokio::test]
    async fn spam_folder_mail_is_never_contacted() {
        let f = fx();
        let spam = seed_folder(&f.db.lock_db(), &f.account, "spam");
        let id = seed_mail(
            &f.db.lock_db(),
            &SeedMail { account_id: &f.account, folder_id: &spam, from_email: "news@halde-shop.example", signal_headers: ONE_CLICK, list_unsubscribe: FULL, ..Default::default() },
        );
        let t = fake(Ok(()), Ok(()));
        assert_eq!(perform_unsubscribe(&f.db, &t, &id, false, t0()).await.unwrap_err(), "unsubscribe.errors.spam");
        assert!(t.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn second_click_does_not_send_again() {
        let f = fx();
        let id = mail(&f, ONE_CLICK, FULL, "2026-09-01T09:00:00Z");
        let t = fake(Ok(()), Ok(()));
        perform_unsubscribe(&f.db, &t, &id, false, t0()).await.unwrap();
        perform_unsubscribe(&f.db, &t, &id, false, t0()).await.unwrap();
        assert_eq!(t.calls.lock().unwrap().len(), 1);
        assert_eq!(rows(&f), 1);
    }

    #[tokio::test]
    async fn newest_list_mail_supplies_the_headers() {
        let f = fx();
        let old = mail(&f, LIST, FULL, "2026-09-01T09:00:00Z");
        mail(&f, ONE_CLICK, FULL, "2026-09-20T09:00:00Z");
        let t = fake(Ok(()), Ok(()));
        perform_unsubscribe(&f.db, &t, &old, false, t0()).await.unwrap();
        assert_eq!(*t.calls.lock().unwrap(), ["one_click"]);
    }

    #[tokio::test]
    async fn trash_existing_reports_count() {
        let f = fx();
        let id = mail(&f, ONE_CLICK, FULL, "2026-09-01T09:00:00Z");
        mail(&f, ONE_CLICK, FULL, "2026-09-08T09:00:00Z");
        let out = perform_unsubscribe(&f.db, &fake(Ok(()), Ok(())), &id, true, t0()).await.unwrap();
        assert_eq!(out.trashed, 2);
    }

    #[tokio::test]
    async fn retry_uses_the_next_method() {
        let f = fx();
        let id = mail(&f, ONE_CLICK, FULL, "2026-09-01T09:00:00Z");
        let sub = perform_unsubscribe(&f.db, &fake(Ok(()), Ok(())), &id, false, t0()).await.unwrap().subscription;
        store::record_sorted(&f.db.lock_db(), &sub.id, at("2026-10-05T08:00:00Z")).unwrap();
        assert!(list_status(&f.db.lock_db(), &id, at("2026-10-06T08:00:00Z")).unwrap().subscription.unwrap().can_retry);
        let t = fake(Ok(()), Ok(()));
        let out = perform_retry(&f.db, &t, &sub.id, at("2026-10-06T08:00:00Z")).await.unwrap();
        assert_eq!(*t.calls.lock().unwrap(), ["mailto"]);
        assert_eq!(methods(&f), ["one_click", "mailto"]);
        assert_eq!(out.subscription.status, "waiting");
    }

    #[tokio::test]
    async fn allow_again_removes_entry() {
        let f = fx();
        let id = mail(&f, ONE_CLICK, FULL, "2026-09-01T09:00:00Z");
        let sub = perform_unsubscribe(&f.db, &fake(Ok(()), Ok(())), &id, false, t0()).await.unwrap().subscription;
        store::delete(&f.db.lock_db(), &sub.id).unwrap();
        assert!(list_status(&f.db.lock_db(), &id, t0()).unwrap().subscription.is_none());
    }

    #[test]
    fn block_keys_on_the_exact_address() {
        let f = fx();
        let id = seed_mail(
            &f.db.lock_db(),
            &SeedMail { account_id: &f.account, folder_id: &f.inbox, from_email: "Gewinn@Spam-Halde.example", category: Some("promotions"), ..Default::default() },
        );
        let out = perform_block(&f.db, &id, false, t0()).unwrap();
        assert_eq!(out.subscription.status, "blocked");
        let value: String = f.db.lock_db().query_row("SELECT key_value FROM unsubscriptions", [], |r| r.get(0)).unwrap();
        assert_eq!(value, "gewinn@spam-halde.example");
    }
}
