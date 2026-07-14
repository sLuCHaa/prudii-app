//! Attachment MIME parts.
//!
//! lettre's `Attachment::new` writes a non-ASCII filename as an RFC 2231
//! continuation parameter (`filename*0*=utf-8''...`). Several widely used clients
//! do not parse that form and show the raw value, so `Donauwörth.xlsx` arrives as
//! `utf-8''Donauw%C3%B6rth.xlsx`. Build the part here instead and emit the RFC 6266
//! form every client understands: a quoted ASCII `filename` plus an extended
//! `filename*`.

use lettre::message::{
    header::{ContentTransferEncoding, ContentType, Header, HeaderName, HeaderValue},
    SinglePart,
};

/// Content-Disposition carrying a pre-formatted value. lettre's own
/// `ContentDisposition` re-encodes the filename, which is what this module exists
/// to avoid.
#[derive(Debug, Clone)]
struct RawContentDisposition(String);

impl Header for RawContentDisposition {
    fn name() -> HeaderName {
        HeaderName::new_from_ascii_str("Content-Disposition")
    }

    fn parse(s: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self(s.to_string()))
    }

    fn display(&self) -> HeaderValue {
        HeaderValue::new(Self::name(), self.0.clone())
    }
}

/// Percent-encode per RFC 5987: everything outside `attr-char` is escaped.
fn pct_encode(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for byte in name.as_bytes() {
        let c = *byte as char;
        let is_attr_char = c.is_ascii_alphanumeric()
            || matches!(c, '!' | '#' | '$' | '&' | '+' | '-' | '.' | '^' | '_' | '`' | '|' | '~');
        if is_attr_char {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

fn pct_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = value.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Undo a filename that was stored with its RFC 2231 encoding intact, e.g.
/// `utf-8''Donauw%C3%B6rth.xlsx` — such names reach us from mails whose sender (or
/// an earlier version of this app) leaked the encoding into the value itself.
/// Re-sending them as-is would propagate the damage.
pub fn repair_encoded_name(name: &str) -> String {
    let Some((charset, rest)) = name.split_once("''") else {
        return name.to_string();
    };
    // Only charsets we can actually decode; anything else is left untouched.
    if !charset.eq_ignore_ascii_case("utf-8") && !charset.eq_ignore_ascii_case("us-ascii") {
        return name.to_string();
    }
    pct_decode(rest).unwrap_or_else(|| name.to_string())
}

/// An ASCII-only rendition for the legacy `filename` parameter. Clients that
/// understand `filename*` ignore it; the rest need something readable, and above
/// all they need the extension to survive.
fn ascii_fallback(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        match c {
            'ä' => out.push_str("ae"),
            'ö' => out.push_str("oe"),
            'ü' => out.push_str("ue"),
            'Ä' => out.push_str("Ae"),
            'Ö' => out.push_str("Oe"),
            'Ü' => out.push_str("Ue"),
            'ß' => out.push_str("ss"),
            // Backslash and quote would break out of the quoted-string.
            '"' | '\\' => out.push('_'),
            c if c.is_ascii_graphic() || c == ' ' => out.push(c),
            _ => out.push('_'),
        }
    }
    let trimmed = out.trim().to_string();
    if trimmed.is_empty() {
        "attachment".to_string()
    } else {
        trimmed
    }
}

/// Build the MIME part for one attachment.
///
/// The declared MIME type is preserved (an `.xml` stays `text/xml`) and base64 is
/// forced, so text-ish types are transferred byte-exact instead of being mangled by
/// quoted-printable line folding.
pub fn attachment_part(name: &str, mime_type: &str, data: Vec<u8>) -> SinglePart {
    let name = repair_encoded_name(name);
    let content_type: ContentType = mime_type
        .parse()
        .unwrap_or_else(|_| "application/octet-stream".parse().expect("static mime type"));

    let ascii = ascii_fallback(&name);
    let disposition = if name.is_ascii() {
        format!("attachment; filename=\"{}\"", ascii)
    } else {
        format!(
            "attachment; filename=\"{}\"; filename*=UTF-8''{}",
            ascii,
            pct_encode(&name)
        )
    };

    SinglePart::builder()
        .header(content_type)
        .header(ContentTransferEncoding::Base64)
        .header(RawContentDisposition(disposition))
        .body(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Content-Disposition value, with lettre's RFC 5322 line folding undone —
    /// a folded header is still one logical value, so the tests assert on that.
    fn disposition_of(name: &str, mime: &str) -> String {
        let part = attachment_part(name, mime, b"payload".to_vec());
        let raw = String::from_utf8_lossy(&part.formatted()).to_string();

        let mut value = String::new();
        let mut in_header = false;
        for line in raw.lines() {
            if line.starts_with("Content-Disposition:") {
                in_header = true;
                value.push_str(line);
            } else if in_header && line.starts_with([' ', '\t']) {
                value.push_str(line.trim_start());
            } else if in_header {
                break;
            }
        }
        value
    }

    fn headers_of(name: &str, mime: &str) -> String {
        let part = attachment_part(name, mime, b"payload".to_vec());
        String::from_utf8_lossy(&part.formatted()).to_string()
    }

    #[test]
    fn ascii_name_uses_a_plain_quoted_filename() {
        assert_eq!(
            disposition_of("report.pdf", "application/pdf"),
            "Content-Disposition: attachment; filename=\"report.pdf\""
        );
    }

    #[test]
    fn non_ascii_name_emits_both_forms_and_never_a_continuation() {
        let cd = disposition_of("importdonauwörth.xlsx", "application/octet-stream");
        assert!(
            cd.contains("filename=\"importdonauwoerth.xlsx\""),
            "missing ASCII fallback: {cd}"
        );
        assert!(
            cd.contains("filename*=UTF-8''importdonauw%C3%B6rth.xlsx"),
            "missing extended filename: {cd}"
        );
        // The bug this module exists to prevent.
        assert!(!cd.contains("filename*0"), "regressed to RFC 2231 continuation: {cd}");
    }

    #[test]
    fn the_extension_survives_in_the_ascii_fallback() {
        let cd = disposition_of("AKDB-Export-Donauwörth.xml", "text/xml");
        assert!(cd.contains("filename=\"AKDB-Export-Donauwoerth.xml\""), "{cd}");
    }

    #[test]
    fn an_already_encoded_name_is_repaired_rather_than_re_encoded() {
        let cd = disposition_of("utf-8''importdonauw%C3%B6rth.xlsx", "application/octet-stream");
        assert!(cd.contains("filename=\"importdonauwoerth.xlsx\""), "{cd}");
        assert!(cd.contains("filename*=UTF-8''importdonauw%C3%B6rth.xlsx"), "{cd}");
        assert!(!cd.contains("utf-8''utf-8"), "double-encoded: {cd}");
    }

    #[test]
    fn text_types_keep_their_mime_type_and_are_base64_encoded() {
        let headers = headers_of("data.xml", "text/xml");
        assert!(headers.contains("Content-Type: text/xml"), "{headers}");
        assert!(headers.contains("Content-Transfer-Encoding: base64"), "{headers}");
    }

    #[test]
    fn a_quote_in_the_name_cannot_break_out_of_the_header() {
        let cd = disposition_of("in\"voice.pdf", "application/pdf");
        assert_eq!(cd.matches('"').count(), 2, "unbalanced quoting: {cd}");
    }
}
