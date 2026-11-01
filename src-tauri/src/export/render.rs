use super::parse::{Addr, ExportPart, ParsedMail};
use super::ExportLabels;
use serde::Serialize;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const STYLE_CSS: &str = include_str!("assets/style.css");
pub const APP_JS: &str = include_str!("assets/app.js");

// A file: source would also match file://host/…, a UNC path on Windows.
pub const CSP: &str = "default-src 'none'; style-src file: 'unsafe-inline'; script-src file:; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'self' file:; form-action 'none'; base-uri 'none'";
const FRAME_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
pub const PALETTE: [&str; 8] = ["#e5684f", "#3aa86b", "#5a73d6", "#9b5bd1", "#d99a2b", "#2b97ab", "#c2557a", "#6b7a8f"];

const MAX_RECIPIENTS: usize = 20;

const FRAME_STYLE: &str = "html{color-scheme:light}body{margin:0;background:#fff;color:#18181b;font:14px/1.55 system-ui,\"Segoe UI\",Roboto,sans-serif;word-wrap:break-word}img{max-width:100%;height:auto}table{max-width:100%}a{color:#b45f06}blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid #e4e4e7;color:#52525b}pre{white-space:pre-wrap}@media (prefers-color-scheme:dark){body{padding:16px}}";

pub struct PageContext {
    pub index_href: String,
    pub folder_anchor: String,
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

fn css_unescape(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut chars = css.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        let mut hex = String::new();
        while let Some(h) = chars.peek().copied().filter(|h| h.is_ascii_hexdigit() && hex.len() < 6) {
            hex.push(h);
            chars.next();
        }
        if hex.is_empty() {
            match chars.next() {
                Some('\n' | '\r' | '\u{c}') | None => {}
                Some(other) => out.push(other),
            }
            continue;
        }
        match chars.peek() {
            Some('\r') => {
                chars.next();
                chars.next_if_eq(&'\n');
            }
            Some(' ' | '\t' | '\n' | '\u{c}') => {
                chars.next();
            }
            _ => {}
        }
        let decoded = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32).filter(|c| *c != '\0');
        out.push(decoded.unwrap_or('\u{FFFD}'));
    }
    out
}

// Matched after decoding escapes, so `u\72l(` or `@\69mport` cannot slip through.
fn css_can_fetch(css: &str) -> bool {
    let decoded = css_unescape(css).to_ascii_lowercase();
    ["url(", "image(", "image-set(", "cross-fade(", "src(", "@import"].iter().any(|f| decoded.contains(f))
}

fn strip_remote_css(css: &str) -> (String, bool) {
    let mut out = String::with_capacity(css.len());
    let mut removed = false;
    for piece in css.split_inclusive([';', '{', '}']) {
        let (body, delimiter) = match piece.char_indices().last() {
            Some((i, ';' | '{' | '}')) => piece.split_at(i),
            _ => (piece, ""),
        };
        if css_can_fetch(body) {
            removed = true;
            // A stray top-level `;` would make the browser drop the next rule.
            if delimiter == ";" {
                continue;
            }
        } else {
            out.push_str(body);
        }
        out.push_str(delimiter);
    }
    (out, removed)
}

fn strip_remote_css_in_style_tags(html: &str) -> (String, bool) {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut removed = false;
    let mut i = 0;
    while let Some(open) = lower[i..].find("<style") {
        let open = i + open;
        let Some(gt) = lower[open..].find('>') else { break };
        let content_start = open + gt + 1;
        let content_end = lower[content_start..].find("</style").map_or(html.len(), |e| content_start + e);
        let (css, r) = strip_remote_css(&html[content_start..content_end]);
        removed |= r;
        out.push_str(&html[i..content_start]);
        out.push_str(&css);
        i = content_end;
    }
    out.push_str(&html[i..]);
    (out, removed)
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &s[prefix.len()..])
}

fn keeps_link(href: &str) -> bool {
    let v = href.trim();
    v.starts_with('#') || ["http:", "https:", "mailto:", "tel:"].iter().any(|s| strip_prefix_ci(v, s).is_some())
}

fn image_mime(part: &ExportPart) -> Option<String> {
    let mime = part.mime_type.trim().to_ascii_lowercase();
    if mime.starts_with("image/") && mime.bytes().all(|b| b.is_ascii_alphanumeric() || b"/+-.".contains(&b)) {
        return Some(mime);
    }
    let ext = part.filename.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    let guessed = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => return None,
    };
    Some(guessed.to_string())
}

fn data_uri(part: &ExportPart, mime: &str) -> String {
    use base64::Engine;
    format!("data:{};base64,{}", mime, base64::engine::general_purpose::STANDARD.encode(&part.bytes))
}

fn cid_key(raw: &str) -> String {
    percent_decode(raw).trim().trim_matches(|c| c == '<' || c == '>').to_lowercase()
}

struct CleanBody {
    html: String,
    removed: bool,
    used_cids: HashSet<String>,
}

fn sanitize_body(html: &str, parts: &[ExportPart]) -> CleanBody {
    let cids: HashMap<String, String> = parts
        .iter()
        .filter(|p| p.is_body_part)
        .filter_map(|p| Some((cid_key(p.content_id.as_deref()?), data_uri(p, &image_mime(p)?))))
        .collect();
    let removed = Arc::new(AtomicBool::new(false));
    let removed_in = Arc::clone(&removed);
    let used = Arc::new(Mutex::new(HashSet::new()));
    let used_in = Arc::clone(&used);

    let mut builder = ammonia::Builder::default();
    builder
        .add_tags(["style"])
        .rm_clean_content_tags(["style"])
        .add_generic_attributes(["style", "class", "dir", "align", "valign", "bgcolor", "width", "height"])
        // file and ftp only pass so the filter below can drop them and show the note.
        .url_schemes(HashSet::from(["http", "https", "mailto", "tel", "data", "cid", "file", "ftp"]))
        .link_rel(Some("noopener noreferrer"))
        .set_tag_attribute_value("a", "target", "_blank")
        .attribute_filter(move |element, attr, value| match (element, attr) {
            ("img", "src") => {
                let v = value.trim();
                if let Some(rest) = strip_prefix_ci(v, "cid:") {
                    let key = cid_key(rest);
                    let uri = cids.get(&key)?.clone();
                    used_in.lock().unwrap_or_else(|e| e.into_inner()).insert(key);
                    return Some(Cow::Owned(uri));
                }
                if strip_prefix_ci(v, "data:image/").is_some() {
                    return Some(Cow::Borrowed(value));
                }
                removed_in.store(true, Ordering::Relaxed);
                None
            }
            (_, "src") => None,
            (_, "href") => keeps_link(value).then_some(Cow::Borrowed(value)),
            (_, "style") => {
                let (css, r) = strip_remote_css(value);
                if r {
                    removed_in.store(true, Ordering::Relaxed);
                }
                Some(Cow::Owned(css))
            }
            _ => Some(Cow::Borrowed(value)),
        });
    let clean = builder.clean(html).to_string();
    let (html, css_removed) = strip_remote_css_in_style_tags(&clean);
    let used_cids = std::mem::take(&mut *used.lock().unwrap_or_else(|e| e.into_inner()));
    CleanBody { html, removed: css_removed || removed.load(Ordering::Relaxed), used_cids }
}

fn unreferenced_images(parts: &[ExportPart], used_cids: &HashSet<String>) -> String {
    let mut out = String::new();
    for p in parts.iter().filter(|p| p.is_body_part) {
        if p.content_id.as_deref().is_some_and(|c| used_cids.contains(&cid_key(c))) {
            continue;
        }
        if let Some(mime) = image_mime(p) {
            out.push_str(&format!("<p><img src=\"{}\" alt=\"{}\"></p>", data_uri(p, &mime), esc(&p.filename)));
        }
    }
    out
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

    let body = mail.html.as_deref().filter(|h| !h.trim().is_empty()).map(|h| sanitize_body(h, &mail.parts));
    let removed_remote = body.as_ref().is_some_and(|b| b.removed);
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

    match (body, mail.text.as_deref().filter(|t| !t.trim().is_empty())) {
        (Some(clean), _) => {
            let doc = format!(
                "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"{}\"><style>{}</style></head><body>{}{}</body></html>",
                FRAME_CSP,
                FRAME_STYLE,
                clean.html,
                unreferenced_images(&mail.parts, &clean.used_cids)
            );
            out.push_str(&format!(
                "<iframe class=\"mail-body\" sandbox=\"allow-same-origin allow-popups allow-popups-to-escape-sandbox\" srcdoc=\"{}\"></iframe>",
                esc(&doc)
            ));
        }
        (None, text) => {
            if let Some(text) = text {
                out.push_str(&format!("<div class=\"text\" style=\"white-space:pre-wrap\">{}</div>", linkify(text)));
            }
            let images = unreferenced_images(&mail.parts, &HashSet::new());
            if !images.is_empty() {
                out.push_str(&format!("<div class=\"inline-images\">{images}</div>"));
            }
        }
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
        PageContext {
            index_href: "../../index.html".into(),
            folder_anchor: "f1".into(),
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
            bcc: vec![],
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
            bytes: PNG.to_vec(),
            is_body_part: true,
        });
        m
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";
    const PNG_DATA_URI: &str = "data:image/png;base64,iVBORw0KGgo=";
    const FRAME_CSP_META: &str = r#"<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">"#;

    fn inline_image(filename: &str, content_id: Option<&str>) -> ExportPart {
        ExportPart {
            filename: filename.into(),
            mime_type: "image/png".into(),
            content_id: content_id.map(Into::into),
            bytes: PNG.to_vec(),
            is_body_part: true,
        }
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
            .replace("&#39;", "'")
            .replace("&amp;", "&")
    }

    fn frame_body(page: &str) -> String {
        let doc = srcdoc(page);
        doc[doc.find("<body>").unwrap()..].to_string()
    }

    #[test]
    fn page_strips_scripts_handlers_and_remote_images() {
        let html = r#"<p onclick="x()">Hallo</p><script>alert(1)</script><a href="javascript:x()">a</a><img src="https://tracker.example/p.gif"><base href="https://x.example/"><meta http-equiv="refresh" content="0;url=https://x.example">"#;
        let out = render_mail_page(&mail_with_html(html), &ctx(), &labels());
        let doc = after_head(&out);
        let start = doc.find("srcdoc=\"").unwrap();
        let body = format!("{}{}", &doc[..start], &doc[start + 8 + doc[start + 8..].find('"').unwrap()..]);
        let inner = frame_body(&out);
        for bad in ["<script", "onclick", "javascript:", "tracker.example", "<base", "http-equiv", "alert(1)"] {
            assert!(!body.contains(bad), "{bad}");
            assert!(!inner.contains(bad), "{bad}");
        }
        assert!(out.contains(&labels().external_images_note));
        assert_eq!(out.matches("http-equiv=\"Content-Security-Policy\"").count(), 1);
        assert_eq!(srcdoc(&out).matches("http-equiv").count(), 1);
    }

    #[test]
    fn mail_body_frame_carries_its_own_strict_csp() {
        let out = render_mail_page(&mail_with_html("<p>Hallo</p>"), &ctx(), &labels());
        assert!(srcdoc(&out).starts_with(FRAME_CSP_META), "{}", srcdoc(&out));
    }

    #[test]
    fn page_csp_allows_only_data_images() {
        let out = render_mail_page(&text_mail("Hallo"), &ctx(), &labels());
        assert!(out.contains("img-src data:;") && !out.contains("img-src file:"));
        assert!(out.contains("style-src file: 'unsafe-inline'") && out.contains("script-src file:"));
    }

    #[test]
    fn cid_images_are_embedded_as_data_uris() {
        let out = render_mail_page(&mail_with_cid_logo(), &ctx(), &labels());
        let inner = frame_body(&out);
        assert!(inner.contains(&format!(r#"<img src="{PNG_DATA_URI}">"#)), "{inner}");
        assert!(!out.contains("cid:") && !out.contains("logo.png"));
        assert!(!out.contains(&labels().external_images_note));
    }

    #[test]
    fn probe_inputs_never_reach_a_host() {
        let images = [
            r#"<img src="\\tracker.example\share\p.gif">"#,
            r#"<img src="/\tracker.example/p.gif">"#,
            r#"<img src="//tracker.example/p.gif">"#,
            r#"<img src="file://tracker.example/p.gif">"#,
            r#"<img src="Plan.png">"#,
            r#"<img src="data:text/html,tracker.example">"#,
            r#"<p style="background-image:image-set('//tracker.example/p.gif' 1x)">x</p>"#,
            r#"<style>p{background:url(\\tracker.example\s\p.gif)}</style>"#,
            r#"<style>@\69mport '\\\\tracker.example\\s\\a.css';</style>"#,
        ];
        for probe in images {
            let out = render_mail_page(&mail_with_html(&format!("<p>Hallo</p>{probe}")), &ctx(), &labels());
            let inner = frame_body(&out);
            assert!(!inner.contains("tracker.example") && !inner.contains("Plan.png"), "{probe} -> {inner}");
            assert!(inner.contains("Hallo"), "{probe}");
            assert!(out.contains(&labels().external_images_note), "{probe}");
        }
        let links = [
            r#"<a href="\\tracker.example\s">a</a>"#,
            r#"<a href="/\tracker.example/s">a</a>"#,
            r#"<a href="//tracker.example/s">a</a>"#,
            r#"<area href="//tracker.example/s">"#,
            r#"<a href="Plan.pdf">a</a>"#,
        ];
        for probe in links {
            let inner = frame_body(&render_mail_page(&mail_with_html(&format!("<p>Hallo</p>{probe}")), &ctx(), &labels()));
            assert!(!inner.contains("tracker.example") && !inner.contains("Plan.pdf"), "{probe} -> {inner}");
        }
    }

    #[test]
    fn css_escapes_and_case_cannot_hide_remote_loads() {
        let probes = [
            r#"<style>p{background:u\72l(//tracker.example/a)}</style>"#,
            r#"<style>p{background:\75 rl(//tracker.example/a)}</style>"#,
            r#"<style>p{background:\000075rl(//tracker.example/a)}</style>"#,
            r#"<style>p{background:URL("//tracker.example/a")}</style>"#,
            r#"<style>p{background:-webkit-image-set("//tracker.example/a" 1x)}</style>"#,
            r#"<style>@IMPORT "//tracker.example/a.css";</style>"#,
            r#"<style>@import url(//tracker.example/a.css)</style>"#,
            r#"<style>p::after{content:"/*" url(//tracker.example/a) "*/"}</style>"#,
            r#"<style>p{background:url("//tracker.example/a;b{c}")}</style>"#,
            r#"<p style="background:\75rl(//tracker.example/a)">x</p>"#,
            r#"<p style="list-style:url(//tracker.example/a);color:red">x</p>"#,
        ];
        for probe in probes {
            let inner = frame_body(&render_mail_page(&mail_with_html(&format!("{probe}<p>Hallo</p>")), &ctx(), &labels()));
            assert!(!inner.contains("tracker.example"), "{probe} -> {inner}");
            assert!(inner.contains("Hallo"), "{probe}");
        }
    }

    #[test]
    fn harmless_css_and_links_are_kept() {
        let html = r##"<style>p{color:#b45f06}h1{font-family:"\5FAE\8F6F\96C5\9ED1"}</style><p style="color:red;margin:0">Hallo</p><a href="https://studio-halde.example/plan">Plan</a><a href="mailto:anna@studio-halde.example">Anna</a><a href="#oben">oben</a><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">"##;
        let out = render_mail_page(&mail_with_html(html), &ctx(), &labels());
        let inner = frame_body(&out);
        for kept in [
            "p{color:#b45f06}",
            r#"font-family:"\5FAE\8F6F\96C5\9ED1""#,
            "color:red;margin:0",
            r#"href="https://studio-halde.example/plan""#,
            r#"href="mailto:anna@studio-halde.example""#,
            r##"href="#oben""##,
            r#"src="data:image/gif;base64,R0lGODlhAQABAAAAACw=""#,
        ] {
            assert!(inner.contains(kept), "{kept} -> {inner}");
        }
        assert!(!out.contains(&labels().external_images_note));
    }

    #[test]
    fn a_removed_import_does_not_swallow_the_next_rule() {
        let html = "<style>@import url(//tracker.example/a.css); body{background:#f3efe8}</style><p>Hallo</p>";
        let inner = frame_body(&render_mail_page(&mail_with_html(html), &ctx(), &labels()));
        assert!(inner.contains("<style> body{background:#f3efe8}</style>"), "{inner}");
    }

    #[test]
    fn style_text_inside_an_attribute_is_not_treated_as_css() {
        let html = r#"<p title="<style>">siehe url(https://studio-halde.example/plan)</p>"#;
        let inner = frame_body(&render_mail_page(&mail_with_html(html), &ctx(), &labels()));
        assert!(inner.contains("siehe url(https://studio-halde.example/plan)"), "{inner}");
    }

    #[test]
    fn inline_images_without_a_reference_are_shown_below_the_body() {
        let mut html = mail_with_html("<p>Hallo</p>");
        html.parts = vec![inline_image("foto.png", None), inline_image("logo.png", Some("unbenutzt@halde"))];
        let inner = frame_body(&render_mail_page(&html, &ctx(), &labels()));
        assert_eq!(inner.matches(PNG_DATA_URI).count(), 2, "{inner}");

        let mut text = text_mail("Hallo");
        text.parts = vec![inline_image("foto.png", None)];
        let out = render_mail_page(&text, &ctx(), &labels());
        assert!(after_head(&out).contains(&format!(r#"src="{PNG_DATA_URI}""#)), "{out}");
    }

    #[test]
    fn apple_style_inline_image_without_content_id_is_kept() {
        let raw = "From: Jonas Brandt <jonas.brandt@studio-halde.example>\r\n\
To: Anna Weber <anna@studio-halde.example>\r\n\
Subject: Foto vom Waldweg\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"b\"\r\n\
\r\n\
--b\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Hallo Anna\r\n\
--b\r\n\
Content-Type: image/png; name=\"foto.png\"\r\n\
Content-Transfer-Encoding: base64\r\n\
Content-Disposition: inline; filename=\"foto.png\"\r\n\
\r\n\
iVBORw0KGgo=\r\n\
--b--\r\n";
        let mail = super::super::parse::parse_raw(raw.as_bytes()).unwrap();
        let out = render_mail_page(&mail, &ctx(), &labels());
        assert!(out.contains(PNG_DATA_URI), "{out}");
    }

    #[test]
    fn non_ascii_image_paths_do_not_panic() {
        for src in ["附件.png", "abcä.png", "Schöne-Grüße.jpg"] {
            let out = render_mail_page(&mail_with_html(&format!(r#"<p>Hallo</p><img src="{src}">"#)), &ctx(), &labels());
            assert!(srcdoc(&out).contains("Hallo"), "{src}");
        }
        let out = render_mail_page(&text_mail("Grüße https://studio-halde.example/ä?x=ü. 附件 https://"), &ctx(), &labels());
        assert!(out.contains(r#"href="https://studio-halde.example/ä?x=ü""#) && out.contains("附件 https://"));
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
