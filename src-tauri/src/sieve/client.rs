//! ManageSieve (RFC 5804) client: STARTTLS, SASL PLAIN, and the handful of
//! script commands the vacation feature needs. Passwords never travel
//! without TLS — a server without STARTTLS is reported as unsupported.

use base64::Engine;
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

pub const SIEVE_PORT: u16 = 4190;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);
const IO_TIMEOUT: Duration = Duration::from_secs(10);
/// Scripts are small; anything beyond this is not a script but a misbehaving peer.
const MAX_RESPONSE: usize = 4 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum SieveError {
    #[error("Server not reachable: {0}")]
    Unreachable(String),
    #[error("Not supported: {reason}")]
    Unsupported { reason: String },
    #[error("Authentication failed")]
    AuthFailed,
    #[error("Protocol error: {0}")]
    Protocol(String),
    #[error("Server refused: {0}")]
    ServerRefused(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ok,
    No,
    Bye,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    Line(String),
    Literal(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: Status,
    pub code: Option<String>,
    pub text: Option<String>,
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, Default)]
pub struct Capabilities {
    pub implementation: String,
    pub sieve: Vec<String>,
    pub sasl: Vec<String>,
    pub starttls: bool,
}

impl Capabilities {
    pub fn from_response(r: &Response) -> Self {
        let mut caps = Self::default();
        for item in &r.items {
            let Item::Line(line) = item else { continue };
            let words = parse_quoted_strings(line);
            let Some(name) = words.first() else { continue };
            let value = words.get(1).map(String::as_str).unwrap_or("");
            match name.to_ascii_uppercase().as_str() {
                "IMPLEMENTATION" => caps.implementation = value.to_string(),
                "SIEVE" => caps.sieve = value.split_whitespace().map(str::to_string).collect(),
                "SASL" => caps.sasl = value.split_whitespace().map(str::to_string).collect(),
                "STARTTLS" => caps.starttls = true,
                _ => {}
            }
        }
        caps
    }

    pub fn has(&self, ext: &str) -> bool {
        self.sieve.iter().any(|e| e.eq_ignore_ascii_case(ext))
    }
}

/// Sieve quoted string: only `"` and `\` need escaping (RFC 5228 §2.4.2).
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// Every quoted string on a response line, unescaped, in order.
pub fn parse_quoted_strings(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c != '"' {
            continue;
        }
        let mut cur = String::new();
        loop {
            match chars.next() {
                Some('\\') => {
                    if let Some(n) = chars.next() {
                        cur.push(n);
                    }
                }
                Some('"') | None => break,
                Some(n) => cur.push(n),
            }
        }
        out.push(cur);
    }
    out
}

/// Non-synchronizing literal (RFC 5804 §4): the server does not ask before
/// the bytes follow.
pub fn literal(bytes: &[u8]) -> Vec<u8> {
    let mut out = format!("{{{}+}}\r\n", bytes.len()).into_bytes();
    out.extend_from_slice(bytes);
    out
}

fn literal_len(s: &str) -> Option<usize> {
    let inner = s.trim().strip_prefix('{')?.strip_suffix('}')?;
    inner.trim_end_matches('+').parse().ok()
}

async fn read_line_bounded<S: AsyncBufRead + Unpin>(s: &mut S, total: &mut usize) -> Result<String, SieveError> {
    let mut line = String::new();
    let n = tokio::time::timeout(IO_TIMEOUT, s.read_line(&mut line))
        .await
        .map_err(|_| SieveError::Unreachable("timeout".into()))?
        .map_err(|e| SieveError::Protocol(e.to_string()))?;
    if n == 0 {
        return Err(SieveError::Protocol("connection closed".into()));
    }
    *total += n;
    if *total > MAX_RESPONSE {
        return Err(SieveError::Protocol("response too large".into()));
    }
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

async fn read_literal<S: AsyncBufRead + Unpin>(s: &mut S, len: usize, total: &mut usize) -> Result<Vec<u8>, SieveError> {
    *total += len;
    if *total > MAX_RESPONSE {
        return Err(SieveError::Protocol("response too large".into()));
    }
    let mut buf = vec![0u8; len];
    tokio::time::timeout(IO_TIMEOUT, s.read_exact(&mut buf))
        .await
        .map_err(|_| SieveError::Unreachable("timeout".into()))?
        .map_err(|e| SieveError::Protocol(e.to_string()))?;
    // The CRLF after a literal belongs to the protocol line, not the data.
    let mut crlf = String::new();
    tokio::time::timeout(IO_TIMEOUT, s.read_line(&mut crlf))
        .await
        .map_err(|_| SieveError::Unreachable("timeout".into()))?
        .map_err(|e| SieveError::Protocol(e.to_string()))?;
    Ok(buf)
}

/// Reads one complete response: any number of data lines / literals, then
/// the `OK` / `NO` / `BYE` line with optional `(code)` and text.
pub async fn read_response<S: AsyncBufRead + Unpin>(s: &mut S) -> Result<Response, SieveError> {
    let mut items = Vec::new();
    let mut total = 0usize;
    loop {
        let line = read_line_bounded(s, &mut total).await?;
        if line.starts_with('{') {
            let len = literal_len(&line).ok_or_else(|| SieveError::Protocol(format!("bad literal: {}", line)))?;
            items.push(Item::Literal(read_literal(s, len, &mut total).await?));
            continue;
        }
        let (status, rest) = match split_status(&line) {
            Some(x) => x,
            None => {
                items.push(Item::Line(line));
                continue;
            }
        };
        let mut rest = rest.trim_start();
        let mut code = None;
        if let Some(after) = rest.strip_prefix('(') {
            if let Some(close) = after.find(')') {
                code = Some(after[..close].to_string());
                rest = after[close + 1..].trim_start();
            }
        }
        let text = if rest.starts_with('{') {
            let len = literal_len(rest).ok_or_else(|| SieveError::Protocol(format!("bad literal: {}", rest)))?;
            let bytes = read_literal(s, len, &mut total).await?;
            Some(String::from_utf8_lossy(&bytes).into_owned())
        } else {
            parse_quoted_strings(rest).into_iter().next()
        };
        return Ok(Response { status, code, text, items });
    }
}

fn split_status(line: &str) -> Option<(Status, &str)> {
    for (word, status) in [("OK", Status::Ok), ("NO", Status::No), ("BYE", Status::Bye)] {
        if let Some(rest) = line.strip_prefix(word) {
            if rest.is_empty() || rest.starts_with(' ') {
                return Some((status, rest));
            }
        }
    }
    None
}

/// `LISTSCRIPTS` lines: `"name"` optionally followed by ` ACTIVE`.
pub fn parse_scripts(r: &Response) -> Vec<(String, bool)> {
    r.items
        .iter()
        .filter_map(|item| match item {
            Item::Line(line) => {
                let name = parse_quoted_strings(line).into_iter().next()?;
                let active = line.trim_end().ends_with(" ACTIVE");
                Some((name, active))
            }
            Item::Literal(_) => None,
        })
        .collect()
}

type TlsStream = tokio_rustls::client::TlsStream<tokio::net::TcpStream>;

pub struct SieveClient {
    stream: BufReader<TlsStream>,
    pub capabilities: Capabilities,
}

async fn tcp_connect(host: &str) -> Result<tokio::net::TcpStream, SieveError> {
    let host = host.trim();
    if host.is_empty() {
        return Err(SieveError::Unreachable("empty host".into()));
    }
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect((host, SIEVE_PORT)))
        .await
        .map_err(|_| SieveError::Unreachable("connect timeout".into()))?
        .map_err(|e| SieveError::Unreachable(e.to_string()))?;
    tcp.set_nodelay(true).ok();
    Ok(tcp)
}

/// Greeting only — no TLS, no credentials. Enough to learn whether the
/// server speaks ManageSieve with STARTTLS and the `vacation` extension.
pub async fn probe(host: &str) -> Result<Capabilities, SieveError> {
    let tcp = tcp_connect(host).await?;
    let mut reader = BufReader::new(tcp);
    let greeting = read_response(&mut reader).await?;
    if greeting.status != Status::Ok {
        return Err(SieveError::Protocol(format!("greeting: {}", greeting.text.unwrap_or_default())));
    }
    let caps = Capabilities::from_response(&greeting);
    let _ = tokio::time::timeout(IO_TIMEOUT, reader.get_mut().write_all(b"LOGOUT\r\n")).await;
    Ok(caps)
}

pub async fn connect(host: &str, user: &str, password: &str) -> Result<SieveClient, SieveError> {
    let tcp = tcp_connect(host).await?;
    let mut plain = BufReader::new(tcp);
    let greeting = read_response(&mut plain).await?;
    if greeting.status != Status::Ok {
        return Err(SieveError::Protocol(format!("greeting: {}", greeting.text.unwrap_or_default())));
    }
    if !Capabilities::from_response(&greeting).starttls {
        return Err(SieveError::Unsupported { reason: "no STARTTLS".into() });
    }
    write_all(plain.get_mut(), b"STARTTLS\r\n").await?;
    let resp = read_response(&mut plain).await?;
    if resp.status != Status::Ok {
        return Err(SieveError::Unsupported { reason: format!("STARTTLS refused: {}", resp.text.unwrap_or_default()) });
    }
    let tcp = plain.into_inner();
    let server_name = rustls::pki_types::ServerName::try_from(host.trim().to_string())
        .map_err(|_| SieveError::Unreachable("invalid server name".into()))?;
    let tls = tokio::time::timeout(IO_TIMEOUT, crate::imap::client::tls_connector().connect(server_name, tcp))
        .await
        .map_err(|_| SieveError::Unreachable("TLS handshake timeout".into()))?
        .map_err(|e| SieveError::Unreachable(format!("TLS handshake failed: {}", e)))?;
    let mut stream = BufReader::new(tls);

    // The server repeats its capabilities after the handshake; that set is
    // the authoritative one (SASL mechanisms may only appear over TLS).
    let greeting = read_response(&mut stream).await?;
    if greeting.status != Status::Ok {
        return Err(SieveError::Protocol("no greeting after STARTTLS".into()));
    }
    let capabilities = Capabilities::from_response(&greeting);

    let token = base64::engine::general_purpose::STANDARD.encode(format!("\0{}\0{}", user, password));
    write_all(stream.get_mut(), format!("AUTHENTICATE \"PLAIN\" {}\r\n", quote(&token)).as_bytes()).await?;
    let resp = read_response(&mut stream).await?;
    match resp.status {
        Status::Ok => {}
        Status::No => return Err(SieveError::AuthFailed),
        Status::Bye => return Err(SieveError::Protocol(format!("server closed: {}", resp.text.unwrap_or_default()))),
    }
    log::debug!("[sieve] authenticated at {}", host);
    Ok(SieveClient { stream, capabilities })
}

async fn write_all<W: AsyncWriteExt + Unpin>(w: &mut W, bytes: &[u8]) -> Result<(), SieveError> {
    tokio::time::timeout(IO_TIMEOUT, async {
        w.write_all(bytes).await?;
        w.flush().await
    })
    .await
    .map_err(|_| SieveError::Unreachable("write timeout".into()))?
    .map_err(|e| SieveError::Protocol(e.to_string()))
}

impl SieveClient {
    async fn command(&mut self, bytes: &[u8]) -> Result<Response, SieveError> {
        write_all(self.stream.get_mut(), bytes).await?;
        let resp = read_response(&mut self.stream).await?;
        match resp.status {
            Status::Ok => Ok(resp),
            Status::No => Err(SieveError::ServerRefused(resp.text.unwrap_or_else(|| "NO".into()))),
            Status::Bye => Err(SieveError::Protocol(format!("server closed: {}", resp.text.unwrap_or_default()))),
        }
    }

    pub async fn list_scripts(&mut self) -> Result<Vec<(String, bool)>, SieveError> {
        let resp = self.command(b"LISTSCRIPTS\r\n").await?;
        Ok(parse_scripts(&resp))
    }

    pub async fn get_script(&mut self, name: &str) -> Result<String, SieveError> {
        let resp = self.command(format!("GETSCRIPT {}\r\n", quote(name)).as_bytes()).await?;
        let body = resp.items.into_iter().find_map(|item| match item {
            Item::Literal(bytes) => Some(bytes),
            Item::Line(_) => None,
        });
        Ok(body.map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default())
    }

    pub async fn check_script(&mut self, body: &str) -> Result<(), SieveError> {
        let mut cmd = b"CHECKSCRIPT ".to_vec();
        cmd.extend(literal(body.as_bytes()));
        cmd.extend_from_slice(b"\r\n");
        self.command(&cmd).await.map(|_| ())
    }

    pub async fn put_script(&mut self, name: &str, body: &str) -> Result<(), SieveError> {
        let mut cmd = format!("PUTSCRIPT {} ", quote(name)).into_bytes();
        cmd.extend(literal(body.as_bytes()));
        cmd.extend_from_slice(b"\r\n");
        self.command(&cmd).await.map(|_| ())
    }

    pub async fn set_active(&mut self, name: &str) -> Result<(), SieveError> {
        self.command(format!("SETACTIVE {}\r\n", quote(name)).as_bytes()).await.map(|_| ())
    }

    pub async fn logout(mut self) {
        let _ = self.command(b"LOGOUT\r\n").await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GREETING: &[u8] = b"\"IMPLEMENTATION\" \"Dovecot Pigeonhole\"\r\n\
\"SIEVE\" \"fileinto reject envelope encoded-character vacation subaddress comparator-i;ascii-numeric relational regex imap4flags copy include variables body enotify environment mailbox date index ihave duplicate mime foreverypart extracttext\"\r\n\
\"NOTIFY\" \"mailto\"\r\n\
\"SASL\" \"PLAIN LOGIN\"\r\n\
\"STARTTLS\"\r\n\
\"VERSION\" \"1.0\"\r\n\
OK \"Dovecot ready.\"\r\n";

    fn read(bytes: &[u8]) -> Result<Response, SieveError> {
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        rt.block_on(async {
            let mut reader = tokio::io::BufReader::new(bytes);
            read_response(&mut reader).await
        })
    }

    #[test]
    fn greeting_yields_capabilities() {
        let resp = read(GREETING).unwrap();
        assert_eq!(resp.status, Status::Ok);
        assert_eq!(resp.text.as_deref(), Some("Dovecot ready."));
        let caps = Capabilities::from_response(&resp);
        assert_eq!(caps.implementation, "Dovecot Pigeonhole");
        assert!(caps.has("vacation"));
        assert!(caps.has("date"));
        assert!(caps.has("relational"));
        assert!(!caps.has("vacation-seconds"));
        assert!(caps.starttls);
        assert_eq!(caps.sasl, vec!["PLAIN".to_string(), "LOGIN".to_string()]);
    }

    #[test]
    fn status_lines_with_and_without_code_and_text() {
        let r = read(b"OK \"Logged in.\"\r\n").unwrap();
        assert_eq!((r.status, r.code, r.text), (Status::Ok, None, Some("Logged in.".into())));

        let r = read(b"OK (WARNINGS) \"line 3: something\"\r\n").unwrap();
        assert_eq!((r.status, r.code.as_deref()), (Status::Ok, Some("WARNINGS")));
        assert_eq!(r.text.as_deref(), Some("line 3: something"));

        let r = read(b"NO (QUOTA/MAXSIZE) \"Too big\"\r\n").unwrap();
        assert_eq!((r.status, r.code.as_deref(), r.text.as_deref()), (Status::No, Some("QUOTA/MAXSIZE"), Some("Too big")));

        let r = read(b"BYE \"Too many\"\r\n").unwrap();
        assert_eq!((r.status, r.text.as_deref()), (Status::Bye, Some("Too many")));

        let r = read(b"NO\r\n").unwrap();
        assert_eq!((r.status, r.code, r.text), (Status::No, None, None));
    }

    #[test]
    fn literal_is_read_by_exact_byte_count() {
        let r = read(b"{18}\r\n/* empty script */\r\nOK \"Getscript completed.\"\r\n").unwrap();
        assert_eq!(r.items, vec![Item::Literal(b"/* empty script */".to_vec())]);
        assert_eq!(r.status, Status::Ok);
    }

    #[test]
    fn literal_content_never_terminates_the_response() {
        // A script whose body contains a status word at line start and a
        // brace literal marker must not be mistaken for protocol lines.
        let body = b"OK\r\n{5}\r\nNO x\r\n}";
        let mut wire = format!("{{{}}}\r\n", body.len()).into_bytes();
        wire.extend_from_slice(body);
        wire.extend_from_slice(b"\r\nOK \"done\"\r\n");
        let r = read(&wire).unwrap();
        assert_eq!(r.items, vec![Item::Literal(body.to_vec())]);
        assert_eq!(r.text.as_deref(), Some("done"));
    }

    #[test]
    fn status_text_may_be_a_literal() {
        let r = read(b"NO {11}\r\nline 1: err\r\n").unwrap();
        assert_eq!(r.status, Status::No);
        assert_eq!(r.text.as_deref(), Some("line 1: err"));
    }

    #[test]
    fn listscripts_lines_are_kept_verbatim() {
        let r = read(b"\"managesieve\" ACTIVE\r\n\"other\"\r\nOK \"Listscripts completed.\"\r\n").unwrap();
        assert_eq!(
            r.items,
            vec![Item::Line("\"managesieve\" ACTIVE".into()), Item::Line("\"other\"".into())]
        );
        assert_eq!(parse_scripts(&r), vec![("managesieve".to_string(), true), ("other".to_string(), false)]);
    }

    #[test]
    fn quoted_strings_unescape() {
        assert_eq!(
            parse_quoted_strings("\"a\\\"b\" \"c\\\\d\""),
            vec!["a\"b".to_string(), "c\\d".to_string()]
        );
        assert_eq!(quote("a\"b\\c"), "\"a\\\"b\\\\c\"");
    }

    #[test]
    fn literal_encoding_is_non_synchronizing() {
        assert_eq!(literal(b"abc"), b"{3+}\r\nabc".to_vec());
    }

    #[test]
    fn closed_connection_without_status_is_a_protocol_error() {
        match read(b"\"SIEVE\" \"vacation\"\r\n") {
            Err(SieveError::Protocol(_)) => {}
            other => panic!("unexpected: {:?}", other),
        }
    }
}
