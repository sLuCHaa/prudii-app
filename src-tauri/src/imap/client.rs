//! Thin native-tokio IMAP client.
//! No async-imap, no compat layers — direct tokio I/O for maximum performance.
//! Each command completes in ~20ms instead of ~9.3s with async-imap.

use anyhow::{bail, Context, Result};
use base64::Engine;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

type TlsStream = tokio_rustls::client::TlsStream<tokio::net::TcpStream>;

// Outlook/Office365 throttles IMAP aggressively; on a throttle or transient
// drop, back off exponentially with jitter instead of failing the whole sync.
const IMAP_MAX_RETRIES: u32 = 3;

fn is_throttle_error(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("throttl") || m.contains("too many") || m.contains("try again") || m.contains("temporarily")
}

fn backoff_delay(attempt: u32, account_id: &str) -> Duration {
    // Deterministic jitter (no RNG in this path): derive from account_id length.
    let base_ms = 500u64 << attempt; // 500ms, 1s, 2s
    let jitter = (account_id.len() as u64 % 250) + 1;
    Duration::from_millis(base_ms + jitter)
}

/// Result of SELECT or EXAMINE
pub struct Mailbox {
    pub exists: u32,
    pub uid_next: Option<u32>,
    pub uid_validity: Option<u32>,
}

/// Result of LIST
pub struct ListEntry {
    pub name: String,
    pub delimiter: Option<char>,
    pub attributes: Vec<String>,
}

/// Single item from a FETCH response
pub struct FetchItem {
    pub uid: Option<u32>,
    pub flags: Vec<String>,
    pub data: Option<Vec<u8>>,
    pub size: Option<u32>,
}

/// Result of STATUS
pub struct StatusResponse {
    pub messages: Option<u32>,
    pub uid_next: Option<u32>,
    pub uid_validity: Option<u32>,
    pub exists: u32,
}

pub enum IdleEvent {
    NewData,
    Timeout,
}

/// Raw command response (untagged lines + final status)
struct Response {
    untagged: Vec<String>,
    status: String,
}

pub struct ImapClient {
    stream: BufReader<TlsStream>,
    tag_counter: u32,
    /// The mailbox currently SELECTed/EXAMINEd on this physical connection, if any.
    /// This is ground truth (set only by successful SELECT/EXAMINE) and is used to
    /// decide whether a re-EXAMINE can be skipped. Relying on a pool-side guess here
    /// caused UID FETCHes to hit the wrong folder (UIDs are per-folder), returning a
    /// different mail's body.
    selected_folder: Option<String>,
    /// Account identifier (the login email), used only to derive deterministic
    /// jitter for throttle-retry backoff. Not used for anything else.
    account_id: String,
}

impl ImapClient {
    /// Establish TLS connection and read server greeting (shared by connect + connect_oauth).
    async fn establish_tls(host: &str, port: u16) -> Result<Self> {
        let host = host.trim();
        if host.is_empty() {
            bail!("IMAP host is empty");
        }
        if port == 0 {
            bail!("Invalid port: 0");
        }

        let t0 = std::time::Instant::now();

        let tcp = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::net::TcpStream::connect((host, port)),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Connection timed out"))?
        .context("TCP connect failed")?;

        tcp.set_nodelay(true).ok();
        log::debug!("IMAP connect {}: TCP {:?}", host, t0.elapsed());

        let t1 = std::time::Instant::now();

        let mut root_store = rustls::RootCertStore::empty();
        root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let tls_config = rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();
        let connector =
            tokio_rustls::TlsConnector::from(std::sync::Arc::new(tls_config));
        let server_name = rustls::pki_types::ServerName::try_from(host.to_string())
            .context("Invalid server name")?;
        let tls_stream = connector
            .connect(server_name, tcp)
            .await
            .context(format!("TLS handshake failed for {}:{}", host, port))?;

        log::debug!("IMAP connect {}: TLS {:?}", host, t1.elapsed());

        let mut client = Self {
            stream: BufReader::new(tls_stream),
            tag_counter: 1,
            selected_folder: None,
            account_id: String::new(),
        };

        let greeting = client.read_line().await?;
        if !greeting.starts_with("* OK") && !greeting.starts_with("* ok") {
            bail!("Unexpected IMAP greeting: {}", greeting.trim());
        }

        Ok(client)
    }

    /// Connect to an IMAP server with TLS and login.
    pub async fn connect(
        host: &str,
        port: u16,
        email: &str,
        password: &str,
    ) -> Result<Self> {
        let t0 = std::time::Instant::now();
        let mut client = Self::establish_tls(host, port).await?;
        client.account_id = email.to_string();

        let t2 = std::time::Instant::now();
        let resp = client
            .command(&format!("LOGIN {} {}", quote(email), quote(password)))
            .await?;
        if !resp.status.starts_with("OK") {
            bail!("Login failed: {}", resp.status);
        }
        log::debug!("IMAP connect {}: LOGIN {:?}", host, t2.elapsed());
        log::debug!("IMAP connect {}: total {:?}", host, t0.elapsed());

        Ok(client)
    }

    /// Connect to an IMAP server with TLS and XOAUTH2 authentication.
    pub async fn connect_oauth(
        host: &str,
        port: u16,
        email: &str,
        access_token: &str,
    ) -> Result<Self> {
        let t0 = std::time::Instant::now();
        let mut client = Self::establish_tls(host, port).await?;
        client.account_id = email.to_string();

        // XOAUTH2 SASL: user=<email>\x01auth=Bearer <token>\x01\x01
        let t2 = std::time::Instant::now();
        let sasl = base64::engine::general_purpose::STANDARD.encode(
            format!("user={}\x01auth=Bearer {}\x01\x01", email, access_token)
        );
        let resp = client
            .command(&format!("AUTHENTICATE XOAUTH2 {}", sasl))
            .await?;
        if !resp.status.starts_with("OK") {
            bail!("XOAUTH2 auth failed: {}", resp.status);
        }
        log::debug!("IMAP connect {}: XOAUTH2 {:?}", host, t2.elapsed());
        log::debug!("IMAP connect {}: total {:?}", host, t0.elapsed());

        Ok(client)
    }

    async fn send_raw(&mut self, data: &[u8]) -> Result<()> {
        let t0 = std::time::Instant::now();
        self.stream.get_mut().write_all(data).await?;
        let t_write = t0.elapsed();
        self.stream.get_mut().flush().await?;
        let t_flush = t0.elapsed();
        if t_flush > std::time::Duration::from_millis(100) {
            log::warn!(
                "IMAP send_raw slow: write_all={:?}, flush={:?} (total {:?})",
                t_write, t_flush - t_write, t_flush
            );
        }
        Ok(())
    }

    async fn read_line(&mut self) -> Result<String> {
        let mut line = String::new();
        let n = self.stream.read_line(&mut line).await?;
        if n == 0 {
            bail!("IMAP connection closed");
        }
        Ok(line)
    }

    fn next_tag(&mut self) -> String {
        let tag = format!("T{}", self.tag_counter);
        self.tag_counter += 1;
        tag
    }

    /// Send a tagged command and read all response lines until the tagged response.
    /// Handles literal {N} in response lines (e.g. folder names with special chars).
    async fn command(&mut self, cmd: &str) -> Result<Response> {
        let tag = self.next_tag();
        let cmd_name = cmd.split_whitespace().next().unwrap_or(cmd);

        let t0 = std::time::Instant::now();
        self.send_raw(format!("{} {}\r\n", tag, cmd).as_bytes())
            .await?;
        let t_sent = t0.elapsed();

        let mut untagged = Vec::new();
        let tag_prefix = format!("{} ", tag);
        let mut first_line = true;

        loop {
            let t_read = std::time::Instant::now();
            let mut line = self.read_line().await?;
            if first_line {
                log::debug!(
                    "IMAP cmd '{}': send={:?}, first_read={:?}",
                    cmd_name, t_sent, t_read.elapsed()
                );
                first_line = false;
            }

            // Handle literals in response (rare, e.g. non-ASCII folder names)
            while let Some(literal_size) = parse_literal_size(&line) {
                if let Some(pos) = line.rfind('{') {
                    line.truncate(pos);
                }
                let mut buf = vec![0u8; literal_size];
                self.stream
                    .read_exact(&mut buf)
                    .await
                    .context("Failed to read literal")?;
                line.push_str(&String::from_utf8_lossy(&buf));
                let cont = self.read_line().await?;
                line.push_str(&cont);
            }

            if line.starts_with(&tag_prefix) {
                let status = line[tag_prefix.len()..].trim_end().to_string();
                log::debug!("IMAP cmd '{}': total={:?} (status={})", cmd_name, t0.elapsed(), status);
                return Ok(Response { untagged, status });
            }

            if line.starts_with("* ") {
                untagged.push(line[2..].trim_end().to_string());
            }
            // Ignore continuation (+) and unknown lines
        }
    }

    pub async fn logout(&mut self) -> Result<()> {
        let tag = self.next_tag();
        // Don't fail on logout errors — connection may already be dead
        let _ = self.send_raw(format!("{} LOGOUT\r\n", tag).as_bytes()).await;
        Ok(())
    }

    pub async fn noop(&mut self) -> Result<()> {
        let resp = self.command("NOOP").await?;
        if !resp.status.starts_with("OK") {
            bail!("NOOP failed: {}", resp.status);
        }
        Ok(())
    }

    pub async fn close(&mut self) -> Result<()> {
        let resp = self.command("CLOSE").await?;
        if !resp.status.starts_with("OK") {
            bail!("CLOSE failed: {}", resp.status);
        }
        Ok(())
    }

    /// The mailbox currently SELECTed/EXAMINEd on this connection, or `None` if
    /// no mailbox is selected (e.g. freshly connected). Ground truth for deciding
    /// whether a re-EXAMINE is needed before a per-folder UID operation.
    pub fn selected_folder(&self) -> Option<&str> {
        self.selected_folder.as_deref()
    }

    pub async fn select(&mut self, mailbox: &str) -> Result<Mailbox> {
        let resp = self.command(&format!("SELECT {}", quote(mailbox))).await?;
        if !resp.status.starts_with("OK") {
            bail!("SELECT failed: {}", resp.status);
        }
        self.selected_folder = Some(mailbox.to_string());
        Ok(parse_mailbox_response(&resp.untagged))
    }

    pub async fn examine(&mut self, mailbox: &str) -> Result<Mailbox> {
        let resp = self.command(&format!("EXAMINE {}", quote(mailbox))).await?;
        if !resp.status.starts_with("OK") {
            bail!("EXAMINE failed: {}", resp.status);
        }
        self.selected_folder = Some(mailbox.to_string());
        Ok(parse_mailbox_response(&resp.untagged))
    }

    pub async fn status(&mut self, mailbox: &str, items: &str) -> Result<StatusResponse> {
        let resp = self
            .command(&format!("STATUS {} {}", quote(mailbox), items))
            .await?;
        if !resp.status.starts_with("OK") {
            bail!("STATUS failed: {}", resp.status);
        }
        Ok(parse_status_response(&resp.untagged))
    }

    pub async fn list(
        &mut self,
        reference: Option<&str>,
        pattern: Option<&str>,
    ) -> Result<Vec<ListEntry>> {
        let reference = reference.unwrap_or("");
        let pattern = pattern.unwrap_or("*");
        let resp = self
            .command(&format!("LIST {} {}", quote(reference), quote(pattern)))
            .await?;
        if !resp.status.starts_with("OK") {
            bail!("LIST failed: {}", resp.status);
        }

        let mut entries = Vec::new();
        for line in &resp.untagged {
            if let Some(entry) = parse_list_entry(line) {
                entries.push(entry);
            }
        }
        Ok(entries)
    }

    /// UID FETCH, retrying with backoff if Outlook/Office365 throttles the request.
    /// Outlook is by far the most aggressive here (transient "try again" / "too many
    /// connections" NO responses under sync load); this is the hot path that needs it.
    pub async fn uid_fetch(&mut self, set: &str, items: &str) -> Result<Vec<FetchItem>> {
        let mut attempt = 0;
        loop {
            match self.uid_fetch_once(set, items).await {
                Ok(v) => return Ok(v),
                Err(e) if attempt < IMAP_MAX_RETRIES && is_throttle_error(&e.to_string()) => {
                    let delay = backoff_delay(attempt, &self.account_id);
                    log::warn!(
                        "IMAP UID FETCH throttled (attempt {}), backing off {:?}: {}",
                        attempt + 1,
                        delay,
                        e
                    );
                    tokio::time::sleep(delay).await;
                    attempt += 1;
                }
                Err(e) => return Err(e),
            }
        }
    }

    async fn uid_fetch_once(&mut self, set: &str, items: &str) -> Result<Vec<FetchItem>> {
        let tag = self.next_tag();
        let t0 = std::time::Instant::now();
        self.send_raw(format!("{} UID FETCH {} {}\r\n", tag, set, items).as_bytes())
            .await?;
        let t_sent = t0.elapsed();

        let mut results = Vec::new();
        let tag_prefix = format!("{} ", tag);
        let mut first_line = true;

        loop {
            let t_read = std::time::Instant::now();
            let line = self.read_line().await?;
            if first_line {
                log::debug!(
                    "IMAP UID FETCH {}: send={:?}, first_read={:?}",
                    set, t_sent, t_read.elapsed()
                );
                first_line = false;
            }

            if line.starts_with(&tag_prefix) {
                if !line[tag_prefix.len()..].starts_with("OK") {
                    bail!("UID FETCH failed: {}", line.trim());
                }
                break;
            }

            if line.starts_with("* ") && line.to_uppercase().contains(" FETCH ") {
                let item = self.parse_fetch_response(&line).await?;
                results.push(item);
            }
        }

        Ok(results)
    }

    /// Parse a single `* N FETCH (...)` response, handling literals.
    async fn parse_fetch_response(&mut self, first_line: &str) -> Result<FetchItem> {
        let mut text = first_line.to_string();
        let mut data: Option<Vec<u8>> = None;

        // Handle literal(s) — typically one for HEADER or BODY data
        while let Some(literal_size) = parse_literal_size(&text) {
            if let Some(pos) = text.rfind('{') {
                text.truncate(pos);
            }
            let mut buf = vec![0u8; literal_size];
            self.stream.read_exact(&mut buf).await?;
            data = Some(buf);
            // Read continuation (closing paren, more items, etc.)
            let cont = self.read_line().await?;
            text.push_str(&cont);
        }

        let uid = extract_uid(&text);
        let flags = extract_flags(&text);
        let size = extract_size(&text);

        Ok(FetchItem {
            uid,
            flags,
            data,
            size,
        })
    }

    pub async fn uid_store(&mut self, set: &str, action: &str) -> Result<()> {
        let tag = self.next_tag();
        self.send_raw(
            format!("{} UID STORE {} {}\r\n", tag, set, action).as_bytes(),
        )
        .await?;

        // Read until tagged response (ignore untagged FETCH responses)
        let tag_prefix = format!("{} ", tag);
        loop {
            let line = self.read_line().await?;
            if line.starts_with(&tag_prefix) {
                if !line[tag_prefix.len()..].starts_with("OK") {
                    bail!("UID STORE failed: {}", line.trim());
                }
                return Ok(());
            }
        }
    }

    pub async fn store(&mut self, set: &str, action: &str) -> Result<()> {
        let tag = self.next_tag();
        self.send_raw(
            format!("{} STORE {} {}\r\n", tag, set, action).as_bytes(),
        )
        .await?;

        let tag_prefix = format!("{} ", tag);
        loop {
            let line = self.read_line().await?;
            if line.starts_with(&tag_prefix) {
                if !line[tag_prefix.len()..].starts_with("OK") {
                    bail!("STORE failed: {}", line.trim());
                }
                return Ok(());
            }
        }
    }

    pub async fn uid_copy(&mut self, set: &str, mailbox: &str) -> Result<()> {
        let resp = self
            .command(&format!("UID COPY {} {}", set, quote(mailbox)))
            .await?;
        if !resp.status.starts_with("OK") {
            bail!("UID COPY failed: {}", resp.status);
        }
        Ok(())
    }

    pub async fn uid_search(&mut self, query: &str) -> Result<Vec<u32>> {
        let resp = self
            .command(&format!("UID SEARCH {}", query))
            .await?;
        if !resp.status.starts_with("OK") {
            bail!("UID SEARCH failed: {}", resp.status);
        }

        let mut uids = Vec::new();
        for line in &resp.untagged {
            let upper = line.to_uppercase();
            if upper.starts_with("SEARCH") {
                for part in line.split_whitespace().skip(1) {
                    if let Ok(uid) = part.parse::<u32>() {
                        uids.push(uid);
                    }
                }
            }
        }
        Ok(uids)
    }

    pub async fn create(&mut self, mailbox: &str) -> Result<()> {
        let resp = self
            .command(&format!("CREATE {}", quote(mailbox)))
            .await?;
        if !resp.status.starts_with("OK") {
            bail!("CREATE failed: {}", resp.status);
        }
        Ok(())
    }

    pub async fn delete(&mut self, mailbox: &str) -> Result<()> {
        let resp = self
            .command(&format!("DELETE {}", quote(mailbox)))
            .await?;
        if !resp.status.starts_with("OK") {
            bail!("DELETE failed: {}", resp.status);
        }
        Ok(())
    }

    pub async fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        let resp = self
            .command(&format!("RENAME {} {}", quote(from), quote(to)))
            .await?;
        if !resp.status.starts_with("OK") {
            bail!("RENAME failed: {}", resp.status);
        }
        Ok(())
    }

    pub async fn subscribe(&mut self, mailbox: &str) -> Result<()> {
        let resp = self
            .command(&format!("SUBSCRIBE {}", quote(mailbox)))
            .await?;
        if !resp.status.starts_with("OK") {
            bail!("SUBSCRIBE failed: {}", resp.status);
        }
        Ok(())
    }

    pub async fn unsubscribe(&mut self, mailbox: &str) -> Result<()> {
        let resp = self
            .command(&format!("UNSUBSCRIBE {}", quote(mailbox)))
            .await?;
        if !resp.status.starts_with("OK") {
            bail!("UNSUBSCRIBE failed: {}", resp.status);
        }
        Ok(())
    }

    pub async fn expunge(&mut self) -> Result<()> {
        let resp = self.command("EXPUNGE").await?;
        if !resp.status.starts_with("OK") {
            bail!("EXPUNGE failed: {}", resp.status);
        }
        Ok(())
    }

    pub async fn append(
        &mut self,
        mailbox: &str,
        flags: Option<&str>,
        _date: Option<&str>,
        data: &[u8],
    ) -> Result<()> {
        let tag = self.next_tag();
        let flags_part = flags.map(|f| format!(" {}", f)).unwrap_or_default();
        let cmd = format!(
            "{} APPEND {}{} {{{}}}\r\n",
            tag,
            quote(mailbox),
            flags_part,
            data.len()
        );
        self.send_raw(cmd.as_bytes()).await?;

        // Wait for continuation
        let line = self.read_line().await?;
        if !line.starts_with("+") {
            bail!("APPEND rejected: {}", line.trim());
        }

        let mut full = Vec::with_capacity(data.len() + 2);
        full.extend_from_slice(data);
        full.extend_from_slice(b"\r\n");
        self.send_raw(&full).await?;

        let tag_prefix = format!("{} ", tag);
        loop {
            let line = self.read_line().await?;
            if line.starts_with(&tag_prefix) {
                if !line[tag_prefix.len()..].starts_with("OK") {
                    bail!("APPEND failed: {}", line.trim());
                }
                return Ok(());
            }
        }
    }

    pub async fn idle(&mut self, timeout: Duration) -> Result<IdleEvent> {
        let tag = self.next_tag();
        self.send_raw(format!("{} IDLE\r\n", tag).as_bytes())
            .await?;

        // Read continuation (+)
        let line = self.read_line().await?;
        if !line.starts_with("+") {
            bail!("Server doesn't support IDLE: {}", line.trim());
        }

        let event = match tokio::time::timeout(timeout, self.read_line()).await {
            Ok(Ok(_)) => IdleEvent::NewData,
            Ok(Err(e)) => return Err(e.context("Error during IDLE")),
            Err(_) => IdleEvent::Timeout,
        };

        self.send_raw(b"DONE\r\n").await?;

        let tag_prefix = format!("{} ", tag);
        loop {
            match tokio::time::timeout(Duration::from_secs(10), self.read_line()).await {
                Ok(Ok(line)) => {
                    if line.starts_with(&tag_prefix) {
                        break;
                    }
                }
                Ok(Err(e)) => return Err(e.context("Error ending IDLE")),
                Err(_) => bail!("Timeout waiting for IDLE done"),
            }
        }

        Ok(event)
    }
}

/// Quote a string for IMAP (escapes \ and ")
fn quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

/// Detect {N} literal size at the end of a line
fn parse_literal_size(line: &str) -> Option<usize> {
    let trimmed = line.trim_end();
    if trimmed.ends_with('}') {
        if let Some(start) = trimmed.rfind('{') {
            let size_str = &trimmed[start + 1..trimmed.len() - 1];
            // Handle non-synchronizing literal {N+}
            let size_str = size_str.trim_end_matches('+');
            return size_str.parse().ok();
        }
    }
    None
}

/// Parse SELECT/EXAMINE untagged responses into Mailbox
fn parse_mailbox_response(lines: &[String]) -> Mailbox {
    let mut exists = 0u32;
    let mut uid_next = None;
    let mut uid_validity = None;

    for line in lines {
        // "15 EXISTS"
        if line.ends_with("EXISTS") || line.ends_with("exists") {
            if let Some(n) = line.split_whitespace().next().and_then(|s| s.parse().ok()) {
                exists = n;
            }
        }
        // "OK [UIDNEXT 35092]" or "OK [UIDNEXT 35092] ..."
        let upper = line.to_uppercase();
        if upper.contains("UIDNEXT") {
            uid_next = extract_bracket_value(&upper, "UIDNEXT");
        }
        if upper.contains("UIDVALIDITY") {
            uid_validity = extract_bracket_value(&upper, "UIDVALIDITY");
        }
    }

    Mailbox {
        exists,
        uid_next,
        uid_validity,
    }
}

/// Extract a numeric value from "[KEY VALUE]" in a line
fn extract_bracket_value(line: &str, key: &str) -> Option<u32> {
    if let Some(pos) = line.find(key) {
        let after = &line[pos + key.len()..];
        let after = after.trim_start();
        let num_str: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        num_str.parse().ok()
    } else {
        None
    }
}

/// Parse STATUS untagged response
fn parse_status_response(lines: &[String]) -> StatusResponse {
    let mut messages = None;
    let mut uid_next = None;
    let mut uid_validity = None;

    for line in lines {
        let upper = line.to_uppercase();
        if !upper.contains("STATUS") {
            continue;
        }
        // Find the parenthesized data: (MESSAGES 15 UIDNEXT 35092 UIDVALIDITY 655323432)
        if let Some(paren_start) = line.find('(') {
            if let Some(paren_end) = line.rfind(')') {
                let inner = &line[paren_start + 1..paren_end];
                let parts: Vec<&str> = inner.split_whitespace().collect();
                let mut i = 0;
                while i + 1 < parts.len() {
                    let key = parts[i].to_uppercase();
                    let val: Option<u32> = parts[i + 1].parse().ok();
                    match key.as_str() {
                        "MESSAGES" => messages = val,
                        "UIDNEXT" => uid_next = val,
                        "UIDVALIDITY" => uid_validity = val,
                        _ => {}
                    }
                    i += 2;
                }
            }
        }
    }

    StatusResponse {
        exists: messages.unwrap_or(0),
        messages,
        uid_next,
        uid_validity,
    }
}

/// Parse a single LIST response line: LIST (\attrs) "delimiter" "name"
fn parse_list_entry(line: &str) -> Option<ListEntry> {
    let upper = line.to_uppercase();
    if !upper.starts_with("LIST ") {
        return None;
    }
    let rest = &line[5..]; // skip "LIST "

    // Parse attributes: (\HasNoChildren \Sent)
    let attr_start = rest.find('(')?;
    let attr_end = rest.find(')')?;
    let attrs_str = &rest[attr_start + 1..attr_end];
    let attributes: Vec<String> = attrs_str
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();

    let after_attrs = &rest[attr_end + 1..].trim_start();

    // Parse delimiter: "/" or NIL
    let (delimiter, rest_after_delim) = if after_attrs.starts_with("NIL") {
        (None, after_attrs[3..].trim_start())
    } else if after_attrs.starts_with('"') {
        let delim_end = after_attrs[1..].find('"').map(|i| i + 1)?;
        let delim = after_attrs[1..delim_end].chars().next();
        (delim, after_attrs[delim_end + 1..].trim_start())
    } else {
        (None, *after_attrs)
    };

    // Parse folder name: "name" or literal (already resolved by command())
    let name = if rest_after_delim.starts_with('"') {
        let name_end = rest_after_delim[1..].find('"').map(|i| i + 1)?;
        rest_after_delim[1..name_end].to_string()
    } else {
        rest_after_delim.trim().to_string()
    };

    if name.is_empty() {
        return None;
    }

    Some(ListEntry {
        name,
        delimiter,
        attributes,
    })
}

/// Extract UID from FETCH response text
fn extract_uid(text: &str) -> Option<u32> {
    let upper = text.to_uppercase();
    if let Some(pos) = upper.find("UID ") {
        let after = &text[pos + 4..];
        let num: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        num.parse().ok()
    } else {
        None
    }
}

/// Extract FLAGS from FETCH response text: FLAGS (\Seen \Flagged)
fn extract_flags(text: &str) -> Vec<String> {
    let upper = text.to_uppercase();
    if let Some(pos) = upper.find("FLAGS (") {
        let after = &text[pos + 7..]; // skip "FLAGS ("
        if let Some(end) = after.find(')') {
            let flags_str = &after[..end];
            return flags_str
                .split_whitespace()
                .map(|f| {
                    // Strip leading \ for standard flags: \Seen → Seen
                    if f.starts_with('\\') {
                        f[1..].to_string()
                    } else {
                        f.to_string()
                    }
                })
                .collect();
        }
    }
    Vec::new()
}

/// Extract RFC822.SIZE from FETCH response text
fn extract_size(text: &str) -> Option<u32> {
    let upper = text.to_uppercase();
    if let Some(pos) = upper.find("RFC822.SIZE ") {
        let after = &text[pos + 12..];
        let num: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        num.parse().ok()
    } else {
        None
    }
}
