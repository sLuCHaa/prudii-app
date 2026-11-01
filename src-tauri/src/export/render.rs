use super::parse::{Addr, ExportPart, ParsedMail};
use super::ExportLabels;
use serde::Serialize;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub const STYLE_CSS: &str = include_str!("assets/style.css");
pub const APP_JS: &str = include_str!("assets/app.js");

pub const CSP: &str = "default-src 'none'; style-src file: 'unsafe-inline'; script-src file:; img-src file: data:; font-src 'none'; connect-src 'none'; frame-src 'self' file:; form-action 'none'; base-uri 'none'";
pub const PALETTE: [&str; 8] = ["#e5684f", "#3aa86b", "#5a73d6", "#9b5bd1", "#d99a2b", "#2b97ab", "#c2557a", "#6b7a8f"];

const MAX_RECIPIENTS: usize = 20;

const FRAME_STYLE: &str = "html{color-scheme:light}body{margin:0;background:#fff;color:#18181b;font:14px/1.55 system-ui,\"Segoe UI\",Roboto,sans-serif;word-wrap:break-word}img{max-width:100%;height:auto}table{max-width:100%}a{color:#b45f06}blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid #e4e4e7;color:#52525b}pre{white-space:pre-wrap}@media (prefers-color-scheme:dark){body{padding:16px}}";

pub struct PageContext {
    pub index_href: String,
    pub folder_anchor: String,
    pub inline_dir: String,
    pub attachment_links: Vec<(String, Option<String>, u64)>,
    pub from_local_copy: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexEntry {
    pub s: String,
    pub f: String,
    pub e: String,
    pub d: String,
    pub p: String,
    pub a: bool,
    pub h: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexFolder {
    pub id: String,
    pub name: String,
    pub folder_type: String,
    pub mails: Vec<IndexEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexAccount {
    pub name: String,
    pub email: String,
    pub folders: Vec<IndexFolder>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexData {
    pub created_at: String,
    pub cancelled: bool,
    pub accounts: Vec<IndexAccount>,
    pub local_copy: Vec<IndexEntry>,
    pub failed: Vec<IndexEntry>,
}

pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

pub fn url_encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = ((b[i + 1] as char).to_digit(16), (b[i + 2] as char).to_digit(16)) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn avatar_color(email: &str) -> &'static str {
    let sum: u32 = email.to_lowercase().encode_utf16().map(u32::from).sum();
    PALETTE[(sum % 8) as usize]
}

fn initials(name: &str, email: &str) -> String {
    let src = if name.trim().is_empty() { email.split('@').next().unwrap_or("") } else { name };
    let first = |w: &str| w.chars().find(|c| c.is_alphanumeric());
    let words: Vec<&str> = src
        .split(|c: char| c.is_whitespace() || matches!(c, '.' | '-' | '_'))
        .filter(|w| first(w).is_some())
        .collect();
    let letters: Vec<char> = match words.as_slice() {
        [] => vec![],
        [only] => first(only).into_iter().collect(),
        [a, .., z] => [first(a), first(z)].into_iter().flatten().collect(),
    };
    if letters.is_empty() {
        return "?".into();
    }
    letters.iter().flat_map(|c| c.to_uppercase()).collect()
}

fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b < KB {
        format!("{} B", bytes)
    } else if b < KB * KB {
        format!("{} KB", (b / KB).round() as u64)
    } else if b < KB * KB * KB {
        format!("{:.1} MB", b / (KB * KB))
    } else {
        format!("{:.1} GB", b / (KB * KB * KB))
    }
}

fn file_icon(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => "\u{1F4C4}",
        "xls" | "xlsx" | "csv" | "ods" => "\u{1F4CA}",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "svg" => "\u{1F5BC}",
        "zip" | "7z" | "rar" | "gz" | "tar" => "\u{1F5DC}",
        "doc" | "docx" | "odt" | "rtf" | "txt" => "\u{1F4DD}",
        _ => "\u{1F4CE}",
    }
}

fn strip_remote_css(css: &str) -> String {
    let lower = css.to_ascii_lowercase();
    let mut out = String::with_capacity(css.len());
    let mut i = 0;
    while i < css.len() {
        if lower[i..].starts_with("@import") {
            i = css[i..].find(';').map_or(css.len(), |e| i + e + 1);
            continue;
        }
        if lower[i..].starts_with("url(") {
            if let Some(close) = css[i..].find(')') {
                let arg = css[i + 4..i + close].trim().trim_matches(|c| c == '"' || c == '\'').trim_start().to_ascii_lowercase();
                if arg.starts_with("http:") || arg.starts_with("https:") || arg.starts_with("//") || arg.starts_with("ftp:") {
                    out.push_str("url()");
                    i += close + 1;
                    continue;
                }
            }
        }
        let ch = css[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn strip_remote_css_in_style_tags(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while let Some(open) = lower[i..].find("<style") {
        let open = i + open;
        let Some(gt) = lower[open..].find('>') else { break };
        let content_start = open + gt + 1;
        let content_end = lower[content_start..].find("</style").map_or(html.len(), |e| content_start + e);
        out.push_str(&html[i..content_start]);
        out.push_str(&strip_remote_css(&html[content_start..content_end]));
        i = content_end;
    }
    out.push_str(&html[i..]);
    out
}

fn is_remote(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    u.starts_with("http:") || u.starts_with("https:") || u.starts_with("//") || u.starts_with("ftp:")
}

fn sanitize_body(html: &str, inline_dir: &str, parts: &[ExportPart]) -> (String, bool) {
    let cids: HashMap<String, String> = parts
        .iter()
        .filter(|p| p.is_body_part)
        .filter_map(|p| {
            let cid = p.content_id.as_deref()?.trim_matches(|c| c == '<' || c == '>').to_lowercase();
            let href = format!("{}/{}", url_encode_segment(inline_dir), url_encode_segment(&p.filename));
            Some((cid, href))
        })
        .collect();
    let removed = Arc::new(AtomicBool::new(false));
    let removed_in = Arc::clone(&removed);

    let mut builder = ammonia::Builder::default();
    builder
        .add_tags(["style"])
        .rm_clean_content_tags(["style"])
        .add_generic_attributes(["style", "class", "dir", "align", "valign", "bgcolor", "width", "height"])
        .url_schemes(HashSet::from(["http", "https", "mailto", "tel", "data", "cid"]))
        .link_rel(Some("noopener noreferrer"))
        .set_tag_attribute_value("a", "target", "_blank")
        .attribute_filter(move |element, attr, value| {
            match (element, attr) {
                ("img", "src") => {
                    let v = value.trim();
                    if v.len() >= 4 && v[..4].eq_ignore_ascii_case("cid:") {
                        let key = percent_decode(&v[4..]).trim().to_lowercase();
                        return cids.get(&key).map(|h| Cow::Owned(h.clone()));
                    }
                    if is_remote(v) {
                        removed_in.store(true, Ordering::Relaxed);
                        return None;
                    }
                    Some(Cow::Borrowed(value))
                }
                (_, "style") => Some(Cow::Owned(strip_remote_css(value))),
                ("a", "href") if value.trim_start().to_ascii_lowercase().starts_with("data:") => None,
                _ => Some(Cow::Borrowed(value)),
            }
        });
    let clean = builder.clean(html).to_string();
    (strip_remote_css_in_style_tags(&clean), removed.load(Ordering::Relaxed))
}

fn linkify(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 64);
    let mut rest = text;
    loop {
        let next = ["https://", "http://"].iter().filter_map(|p| rest.find(p)).min();
        let Some(start) = next else {
            out.push_str(&esc(rest));
            return out;
        };
        out.push_str(&esc(&rest[..start]));
        let tail = &rest[start..];
        let end = tail.find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"')).unwrap_or(tail.len());
        let mut url = &tail[..end];
        while let Some(last) = url.chars().last() {
            if matches!(last, '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '\'') {
                url = &url[..url.len() - last.len_utf8()];
            } else {
                break;
            }
        }
        let scheme_len = if url.starts_with("https://") { 8 } else { 7 };
        if url.len() <= scheme_len {
            out.push_str(&esc(&tail[..scheme_len]));
            rest = &tail[scheme_len..];
            continue;
        }
        out.push_str(&format!(r#"<a href="{0}" target="_blank" rel="noopener noreferrer">{0}</a>"#, esc(url)));
        rest = &tail[url.len()..];
    }
}

fn names(list: &[Addr]) -> String {
    let mut shown: Vec<String> = list
        .iter()
        .take(MAX_RECIPIENTS)
        .map(|a| esc(if a.name.trim().is_empty() { &a.email } else { &a.name }))
        .collect();
    if list.len() > MAX_RECIPIENTS {
        shown.push(format!("+{}", list.len() - MAX_RECIPIENTS));
    }
    shown.join(", ")
}

fn rel_prefix(index_href: &str) -> &str {
    index_href.strip_suffix("index.html").unwrap_or("")
}

fn shell_head(lang: &str, title: &str, rel: &str, with_data: bool) -> String {
    format!(
        concat!(
            "<!doctype html>\n<html lang=\"{lang}\"><head><meta charset=\"utf-8\">",
            "<meta http-equiv=\"Content-Security-Policy\" content=\"{csp}\">",
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
            "<title>{title}</title>",
            "<link rel=\"stylesheet\" href=\"{rel}assets/style.css\">",
            "{extra}",
            "<script src=\"{rel}assets/app.js\" defer></script>",
            "</head>\n"
        ),
        lang = esc(lang),
        csp = CSP,
        title = esc(title),
        rel = esc(rel),
        extra = if with_data { "<script src=\"assets/index-data.js\" defer></script>" } else { "" },
    )
}

pub fn render_mail_page(mail: &ParsedMail, page: &PageContext, labels: &ExportLabels) -> String {
    let rel = rel_prefix(&page.index_href);
    let subject = if mail.subject.trim().is_empty() { labels.no_subject.as_str() } else { mail.subject.as_str() };
    let mut out = shell_head(&labels.lang, subject, rel, false);
    out.push_str("<body class=\"page-mail\"><div class=\"mail\">");
    out.push_str(&format!(
        "<a class=\"back\" href=\"{}#{}\">\u{2190} {}</a>",
        esc(&page.index_href),
        esc(&page.folder_anchor),
        esc(&labels.back)
    ));

    let html = mail.html.as_deref().filter(|h| !h.trim().is_empty());
    let (body_html, removed_remote) = match html {
        Some(h) => {
            let (clean, removed) = sanitize_body(h, &page.inline_dir, &mail.parts);
            (Some(clean), removed)
        }
        None => (None, false),
    };
    if page.from_local_copy {
        out.push_str(&format!("<div class=\"note\">{}</div>", esc(&labels.local_copy_note)));
    }
    if removed_remote {
        out.push_str(&format!("<div class=\"note\">{}</div>", esc(&labels.external_images_note)));
    }

    out.push_str(&format!("<h1>{}</h1>", esc(subject)));

    let from_name = if mail.from.name.trim().is_empty() { mail.from.email.as_str() } else { mail.from.name.as_str() };
    let mut meta: Vec<String> = Vec::new();
    if !mail.from.name.trim().is_empty() && !mail.from.email.is_empty() {
        meta.push(esc(&mail.from.email));
    }
    if !mail.to.is_empty() {
        meta.push(format!("{} {}", esc(&labels.to), names(&mail.to)));
    }
    if !mail.cc.is_empty() {
        meta.push(format!("{} {}", esc(&labels.cc), names(&mail.cc)));
    }
    out.push_str(&format!(
        "<div class=\"head\"><div class=\"av\" style=\"background:{}\">{}</div><div class=\"who\"><b>{}</b><span>{}</span></div>",
        avatar_color(&mail.from.email),
        esc(&initials(&mail.from.name, &mail.from.email)),
        esc(from_name),
        meta.join(" \u{00B7} ")
    ));
    if let Some(d) = mail.date {
        out.push_str(&format!(
            "<div class=\"when\"><time datetime=\"{}\">{}</time></div>",
            esc(&d.to_rfc3339()),
            d.format("%Y-%m-%d %H:%M")
        ));
    }
    out.push_str("</div>");

    match (body_html, mail.text.as_deref().filter(|t| !t.trim().is_empty())) {
        (Some(clean), _) => {
            let doc = format!("<!doctype html><html><head><style>{}</style></head><body>{}</body></html>", FRAME_STYLE, clean);
            out.push_str(&format!(
                "<iframe class=\"mail-body\" sandbox=\"allow-same-origin allow-popups allow-popups-to-escape-sandbox\" srcdoc=\"{}\"></iframe>",
                esc(&doc)
            ));
        }
        (None, Some(text)) => {
            out.push_str(&format!("<div class=\"text\" style=\"white-space:pre-wrap\">{}</div>", linkify(text)));
        }
        (None, None) => {}
    }

    if !page.attachment_links.is_empty() {
        out.push_str(&format!("<div class=\"att\" aria-label=\"{}\">", esc(&labels.attachments)));
        for (name, href, bytes) in &page.attachment_links {
            let inner = format!(
                "{} <b>{}</b> \u{00B7} <span data-bytes=\"{}\">{}</span>",
                file_icon(name),
                esc(name),
                bytes,
                human_size(*bytes)
            );
            match href {
                Some(h) => out.push_str(&format!("<a class=\"chip\" href=\"{}\">{}</a>", esc(h), inner)),
                None => out.push_str(&format!("<span class=\"chip\">{}</span>", inner)),
            }
        }
        out.push_str("</div>");
    }

    out.push_str("</div></body></html>\n");
    out
}

fn json_for_script<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into()).replace("</", "<\\/")
}

pub fn render_index_html(labels: &ExportLabels, cancelled: bool) -> String {
    let mut out = shell_head(&labels.lang, &labels.title, "", true);
    let logo = match labels.title.split_once(' ') {
        Some((first, rest)) => format!("{} <span>{}</span>", esc(first), esc(rest)),
        None => esc(&labels.title),
    };
    out.push_str(&format!(
        "<body class=\"page-index\"><header class=\"bar\"><div class=\"logo\">{}</div><div class=\"meta\" id=\"meta\"></div>\
<input class=\"search\" id=\"search\" type=\"search\" placeholder=\"{}\" aria-label=\"{}\" autocomplete=\"off\"></header>",
        logo,
        esc(&labels.search_placeholder),
        esc(&labels.search_placeholder)
    ));
    if cancelled {
        out.push_str(&format!("<div class=\"banner\">{}</div>", esc(&labels.incomplete_note)));
    }
    out.push_str(
        "<div class=\"layout\" id=\"app\"><nav class=\"side\" id=\"side\"></nav>\
<main class=\"list\" id=\"list\"><div id=\"hints\"></div><div id=\"rows\"></div></main></div>",
    );
    out.push_str(&format!("<script type=\"application/json\" id=\"prudii-labels\">{}</script>", json_for_script(labels)));
    out.push_str("</body></html>\n");
    out
}

pub fn render_index_data_js(data: &IndexData) -> String {
    format!("window.PRUDII_EXPORT = {};\n", json_for_script(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels() -> ExportLabels {
        ExportLabels {
            lang: "de".into(),
            title: "Prudii Export".into(),
            search_placeholder: "Suchen".into(),
            back: "Zurück".into(),
            to: "an".into(),
            cc: "cc".into(),
            no_subject: "(ohne Betreff)".into(),
            attachments: "Anhänge".into(),
            external_images_note: "Externe Bilder wurden beim Export nicht geladen.".into(),
            local_copy_note: "Aus lokaler Kopie, kein Original.".into(),
            incomplete_note: "Unvollständig (abgebrochen).".into(),
            ..Default::default()
        }
    }

    fn ctx() -> PageContext {
        ctx_with_inline_dir("mail")
    }

    fn ctx_with_inline_dir(dir: &str) -> PageContext {
        PageContext {
            index_href: "../../index.html".into(),
            folder_anchor: "f1".into(),
            inline_dir: dir.into(),
            attachment_links: vec![],
            from_local_copy: false,
        }
    }

    fn base_mail() -> ParsedMail {
        ParsedMail {
            subject: "Angebot".into(),
            from: Addr { name: "Jonas Brandt".into(), email: "jonas.brandt@studio-halde.example".into() },
            to: vec![Addr { name: "Anna Weber".into(), email: "anna@studio-halde.example".into() }],
            cc: vec![],
            date: None,
            html: None,
            text: None,
            parts: vec![],
        }
    }

    fn mail_with_html(html: &str) -> ParsedMail {
        ParsedMail { html: Some(html.into()), ..base_mail() }
    }

    fn mail_with_subject(subject: &str) -> ParsedMail {
        ParsedMail { subject: subject.into(), text: Some("Hallo".into()), ..base_mail() }
    }

    fn text_mail(text: &str) -> ParsedMail {
        ParsedMail { text: Some(text.into()), ..base_mail() }
    }

    fn mail_with_cid_logo() -> ParsedMail {
        let mut m = mail_with_html(r#"<p>Hallo</p><img src="cid:logo@halde">"#);
        m.parts.push(super::super::parse::ExportPart {
            filename: "logo.png".into(),
            mime_type: "image/png".into(),
            content_id: Some("logo@halde".into()),
            bytes: vec![],
            is_body_part: true,
        });
        m
    }

    fn after_head(page: &str) -> &str {
        page.split("</head>").nth(1).unwrap()
    }

    fn srcdoc(page: &str) -> String {
        let start = page.find("srcdoc=\"").unwrap() + 8;
        let end = start + page[start..].find('"').unwrap();
        page[start..end]
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&amp;", "&")
    }

    #[test]
    fn page_strips_scripts_handlers_and_remote_images() {
        let html = r#"<p onclick="x()">Hallo</p><script>alert(1)</script><a href="javascript:x()">a</a><img src="https://tracker.example/p.gif"><base href="https://x.example/"><meta http-equiv="refresh" content="0;url=https://x.example">"#;
        let out = render_mail_page(&mail_with_html(html), &ctx(), &labels());
        let body = after_head(&out);
        let inner = srcdoc(&out);
        for bad in ["<script", "onclick", "javascript:", "tracker.example", "<base", "http-equiv", "alert(1)"] {
            assert!(!body.contains(bad), "{bad}");
            assert!(!inner.contains(bad), "{bad}");
        }
        assert!(out.contains(&labels().external_images_note));
        assert!(out.contains("Content-Security-Policy"));
    }

    #[test]
    fn cid_images_point_to_local_files() {
        let out = render_mail_page(&mail_with_cid_logo(), &ctx_with_inline_dir("2026-10-21_1528_Angebot"), &labels());
        assert!(out.contains("2026-10-21_1528_Angebot/logo.png") && !out.contains("cid:"));
    }

    #[test]
    fn subject_and_names_are_escaped() {
        let out = render_mail_page(&mail_with_subject("<img src=x onerror=1>"), &ctx(), &labels());
        assert!(out.contains("&lt;img src=x onerror=1&gt;"));
        assert!(!out.contains("<img src=x"));
    }

    #[test]
    fn text_mail_links_urls_and_keeps_breaks() {
        let out = render_mail_page(&text_mail("Hallo\nsiehe https://studio-halde.example/plan"), &ctx(), &labels());
        assert!(out.contains(r#"href="https://studio-halde.example/plan""#) && out.contains("pre-wrap"));
        assert!(!out.contains("<iframe"));
    }

    #[test]
    fn remote_css_is_neutralised() {
        let html = r#"<style>@import url(https://x.example/a.css);p{background:url('https://tracker.example/b.png')}</style><p style="background:url(//tracker.example/c.png)">Hallo</p>"#;
        let out = render_mail_page(&mail_with_html(html), &ctx(), &labels());
        let inner = srcdoc(&out);
        assert!(!inner.contains("tracker.example") && !inner.contains("@import") && !inner.contains("x.example"));
        assert!(inner.contains("Hallo"));
    }

    #[test]
    fn links_open_outside_and_data_links_are_dropped() {
        let out = render_mail_page(
            &mail_with_html(r#"<a href="https://studio-halde.example/">a</a><a href="data:text/html,x">b</a>"#),
            &ctx(),
            &labels(),
        );
        let inner = srcdoc(&out);
        assert!(inner.contains(r#"target="_blank""#) && inner.contains("noopener noreferrer"));
        assert!(!inner.contains("data:text"));
    }

    #[test]
    fn header_shows_recipients_date_and_back_link() {
        let mut m = text_mail("Hallo");
        m.cc = vec![Addr { name: String::new(), email: "lena@studio-halde.example".into() }];
        m.date = chrono::DateTime::parse_from_rfc3339("2026-10-21T15:28:44+02:00").ok();
        let out = render_mail_page(&m, &ctx(), &labels());
        assert!(out.contains("an Anna Weber") && out.contains("cc lena@studio-halde.example"));
        assert!(out.contains(r#"<time datetime="2026-10-21T15:28:44+02:00">2026-10-21 15:28</time>"#));
        assert!(out.contains(r##"href="../../index.html#f1""##));
        assert!(out.contains(r#"href="../../assets/style.css""#) && out.contains(r#"<html lang="de">"#));
    }

    #[test]
    fn attachments_and_notes_are_listed() {
        let mut page = ctx();
        page.from_local_copy = true;
        page.attachment_links = vec![
            ("Plaene Waldweg.pdf".into(), Some("mail/Plaene%20Waldweg.pdf".into()), 2_516_582),
            ("Liste.xlsx".into(), None, 86_016),
        ];
        let out = render_mail_page(&text_mail("Hallo"), &page, &labels());
        assert!(out.contains(r#"href="mail/Plaene%20Waldweg.pdf""#) && out.contains("2.4 MB") && out.contains("84 KB"));
        assert!(out.contains("Liste.xlsx") && !out.contains(r#"href="mail/Liste"#));
        assert!(out.contains(&labels().local_copy_note));
    }

    #[test]
    fn avatar_colour_follows_the_email() {
        assert_eq!(avatar_color("A@b.example"), avatar_color("a@b.example"));
        let sum: u32 = "jonas.brandt@studio-halde.example".encode_utf16().map(u32::from).sum();
        assert_eq!(avatar_color("jonas.brandt@studio-halde.example"), PALETTE[(sum % 8) as usize]);
    }

    #[test]
    fn index_data_cannot_break_out_of_script() {
        let js = render_index_data_js(&data_with_subject("</script><script>alert(1)</script>"));
        assert!(!js.contains("</script>"));
        assert!(js.starts_with("window.PRUDII_EXPORT = "));
    }

    #[test]
    fn index_page_is_offline_and_loads_data_by_script() {
        let out = render_index_html(&labels(), true);
        assert!(out.contains(r#"src="assets/index-data.js""#) && out.contains(r#"src="assets/app.js""#));
        assert!(out.contains(&labels().incomplete_note));
        assert!(!out.contains("fetch("));
        assert!(out.contains(CSP));
    }

    fn data_with_subject(subject: &str) -> IndexData {
        IndexData {
            created_at: "2026-11-01T16:40:00+01:00".into(),
            cancelled: false,
            accounts: vec![IndexAccount {
                name: "Anna".into(),
                email: "anna@studio-halde.example".into(),
                folders: vec![IndexFolder {
                    id: "f1".into(),
                    name: "Posteingang".into(),
                    folder_type: "inbox".into(),
                    mails: vec![IndexEntry {
                        s: subject.into(),
                        f: "Jonas Brandt".into(),
                        e: "jonas.brandt@studio-halde.example".into(),
                        d: "2026-10-21T15:28:44+02:00".into(),
                        p: String::new(),
                        a: false,
                        h: Some("a/b.html".into()),
                    }],
                }],
            }],
            local_copy: vec![],
            failed: vec![],
        }
    }
}
