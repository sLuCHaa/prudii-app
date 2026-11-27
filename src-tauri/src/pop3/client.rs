use std::time::Duration;

use base64::Engine;
use futures_util::FutureExt;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;

use super::{Pop3Error, Pop3Security};

pub const MAX_MESSAGE_BYTES: u64 = 100 * 1024 * 1024;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const DISCARD_TIMEOUT: Duration = Duration::from_secs(120);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

// RFC 5034, CRLF included.
const MAX_AUTH_COMMAND_BYTES: usize = 255;
const MAX_STATUS_LINE_BYTES: u64 = 8 * 1024;
const MAX_CAPA_BYTES: u64 = 64 * 1024;
const MAX_LISTING_BYTES: u64 = 16 * 1024 * 1024;

pub type Pop3Session = Pop3Client<TlsStream<TcpStream>>;

type Reply = Result<String, String>;

pub struct Pop3Client<S> {
    stream: BufReader<S>,
    // Stays set until a response is fully read: stale data must never answer a later command.
    broken: bool,
}

pub async fn connect(
    host: &str,
    port: u16,
    security: Pop3Security,
) -> Result<Pop3Session, Pop3Error> {
    let host = host.trim();
    if host.is_empty() || port == 0 {
        return Err(Pop3Error::Io("missing host or port".into()));
    }
    let tcp = tcp_connect(host, port).await?;
    match security {
        Pop3Security::Ssl => Pop3Client::from_stream(tls_handshake(host, tcp).await?).await,
        Pop3Security::StartTls => {
            let tcp = Pop3Client::from_stream(tcp)
                .await?
                .into_starttls_stream()
                .await?;
            Ok(Pop3Client::new(tls_handshake(host, tcp).await?))
        }
    }
}

async fn tcp_connect(host: &str, port: u16) -> Result<TcpStream, Pop3Error> {
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| Pop3Error::Timeout)?
        .map_err(io_error)?;
    tcp.set_nodelay(true).ok();
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(Duration::from_secs(30))
        .with_interval(Duration::from_secs(15));
    if let Err(e) = socket2::SockRef::from(&tcp).set_tcp_keepalive(&keepalive) {
        log::warn!("POP3 connect {}: failed to set TCP keepalive: {}", host, e);
    }
    Ok(tcp)
}

async fn tls_handshake(host: &str, tcp: TcpStream) -> Result<TlsStream<TcpStream>, Pop3Error> {
    let server_name = rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|_| Pop3Error::Tls("invalid server name".into()))?;
    let connector = crate::imap::client::tls_connector();
    tokio::time::timeout(HANDSHAKE_TIMEOUT, connector.connect(server_name, tcp))
        .await
        .map_err(|_| Pop3Error::Timeout)?
        .map_err(|e| Pop3Error::Tls(e.to_string()))
}

impl<S: AsyncRead + AsyncWrite + Unpin> Pop3Client<S> {
    pub async fn from_stream(stream: S) -> Result<Self, Pop3Error> {
        let mut client = Self::new(stream);
        match client.read_status().await? {
            Ok(_) => Ok(client),
            Err(text) => Err(refused(text)),
        }
    }

    pub async fn capa(&mut self) -> Result<Vec<String>, Pop3Error> {
        let reply = self
            .listing("CAPA", MAX_CAPA_BYTES, |line| Some(line.to_string()))
            .await?;
        Ok(reply.unwrap_or_default())
    }

    pub async fn login(&mut self, user: &str, pass: &str) -> Result<(), Pop3Error> {
        if [user, pass]
            .iter()
            .any(|value| value.contains(['\r', '\n', '\0']))
        {
            return Err(Pop3Error::Auth(
                "user name or password contains control characters".into(),
            ));
        }
        let token = base64::engine::general_purpose::STANDARD.encode(format!("\0{user}\0{pass}"));
        // Some servers echo the rejected command back.
        let rejected = |text: String| {
            let locked = is_locked(&text) && !has_auth_code(&text);
            let echoed = (!pass.is_empty() && text.contains(pass)) || text.contains(&token);
            let shown = if echoed {
                "[redacted]".to_string()
            } else {
                text
            };
            if locked {
                Pop3Error::Locked(shown)
            } else {
                Pop3Error::Auth(shown)
            }
        };

        if let Err(text) = self.simple(&format!("USER {user}")).await? {
            let plain =
                !is_locked(&text) && self.capa().await?.iter().any(|line| offers_plain(line));
            if !plain {
                return Err(rejected(text));
            }
            let reply = self.auth_plain(&token).await?;
            return reply.map(drop).map_err(rejected);
        }
        let reply = self.simple(&format!("PASS {pass}")).await?;
        reply.map(drop).map_err(rejected)
    }

    pub async fn stat(&mut self) -> Result<(u32, u64), Pop3Error> {
        let text = self.expect_ok("STAT").await?;
        parse_sizes(&text).ok_or_else(|| self.poison("unreadable STAT response"))
    }

    pub async fn uidl_all(&mut self) -> Result<Vec<(u32, String)>, Pop3Error> {
        let reply = self.listing("UIDL", MAX_LISTING_BYTES, parse_uidl).await?;
        reply.map_err(|_| Pop3Error::NoUidl)
    }

    pub async fn list_all(&mut self) -> Result<Vec<(u32, u64)>, Pop3Error> {
        let reply = self.listing("LIST", MAX_LISTING_BYTES, parse_sizes).await?;
        reply.map_err(refused)
    }

    pub async fn retr(&mut self, msg: u32, max_bytes: u64) -> Result<Vec<u8>, Pop3Error> {
        self.send(&format!("RETR {msg}")).await?;
        if let Err(text) = self.read_status().await? {
            self.broken = false;
            return Err(refused(text));
        }
        let body = self.read_multiline(max_bytes, Overflow::Discard).await?;
        self.broken = false;
        if body.total > max_bytes {
            return Err(Pop3Error::TooLarge(body.total));
        }
        Ok(body.data)
    }

    pub async fn dele(&mut self, msg: u32) -> Result<(), Pop3Error> {
        self.expect_ok(&format!("DELE {msg}")).await.map(drop)
    }

    pub async fn rset(&mut self) -> Result<(), Pop3Error> {
        self.expect_ok("RSET").await.map(drop)
    }

    pub async fn noop(&mut self) -> Result<(), Pop3Error> {
        self.expect_ok("NOOP").await.map(drop)
    }

    pub async fn quit(mut self) -> Result<(), Pop3Error> {
        self.expect_ok("QUIT").await.map(drop)
    }

    fn new(stream: S) -> Self {
        Self {
            stream: BufReader::new(stream),
            broken: false,
        }
    }

    async fn into_starttls_stream(mut self) -> Result<S, Pop3Error> {
        if !self.capa().await?.iter().any(|line| offers_stls(line)) {
            return Err(Pop3Error::Tls("server offers no STLS".into()));
        }
        if let Err(text) = self.simple("STLS").await? {
            return Err(Pop3Error::Tls(format!("STLS refused: {text}")));
        }
        if !self.stream.buffer().is_empty() {
            return Err(Pop3Error::Tls("unexpected data after STLS".into()));
        }
        Ok(self.stream.into_inner())
    }

    fn poison(&mut self, reason: &str) -> Pop3Error {
        self.broken = true;
        Pop3Error::Protocol(reason.to_string())
    }

    async fn send(&mut self, command: &str) -> Result<(), Pop3Error> {
        if self.broken {
            return Err(Pop3Error::Io(
                "session unusable after an earlier failure".into(),
            ));
        }
        self.broken = true;
        self.write_line(command).await
    }

    async fn write_line(&mut self, line: &str) -> Result<(), Pop3Error> {
        self.ensure_nothing_pending()?;
        let line = format!("{line}\r\n");
        let stream = self.stream.get_mut();
        let write = async {
            stream.write_all(line.as_bytes()).await?;
            stream.flush().await
        };
        tokio::time::timeout(WRITE_TIMEOUT, write)
            .await
            .map_err(|_| Pop3Error::Timeout)?
            .map_err(io_error)
    }

    // One poll without waiting: sees buffered bytes and whatever the socket already reports.
    fn ensure_nothing_pending(&mut self) -> Result<(), Pop3Error> {
        match self.stream.fill_buf().now_or_never() {
            None => Ok(()),
            Some(Ok([])) => Err(connection_closed()),
            Some(Ok(_)) => Err(Pop3Error::Protocol(
                "unsolicited data from the server".into(),
            )),
            Some(Err(error)) => Err(io_error(error)),
        }
    }

    async fn read_line(&mut self) -> Result<String, Pop3Error> {
        let mut line = Vec::new();
        let mut limited = (&mut self.stream).take(MAX_STATUS_LINE_BYTES);
        tokio::time::timeout(READ_TIMEOUT, limited.read_until(b'\n', &mut line))
            .await
            .map_err(|_| Pop3Error::Timeout)?
            .map_err(io_error)?;
        if !line.ends_with(b"\n") && (line.len() as u64) < MAX_STATUS_LINE_BYTES {
            self.broken = true;
            return Err(connection_closed());
        }
        line.strip_suffix(b"\n")
            .map(|line| {
                String::from_utf8_lossy(line)
                    .trim_end_matches('\r')
                    .to_string()
            })
            .ok_or_else(|| self.poison("status line too long"))
    }

    async fn read_status(&mut self) -> Result<Reply, Pop3Error> {
        let line = self.read_line().await?;
        parse_status(&line).ok_or_else(|| self.poison("unreadable status line"))
    }

    async fn auth_plain(&mut self, token: &str) -> Result<Reply, Pop3Error> {
        let mut command = format!("AUTH PLAIN {token}");
        if command.len() + 2 > MAX_AUTH_COMMAND_BYTES {
            command.truncate("AUTH PLAIN".len());
        }
        self.send(&command).await?;
        let mut line = self.read_line().await?;
        if line == "+" || line.starts_with("+ ") {
            self.write_line(token).await?;
            line = self.read_line().await?;
        }
        let reply = parse_status(&line).ok_or_else(|| self.poison("unreadable AUTH response"))?;
        self.broken = false;
        Ok(reply)
    }

    async fn simple(&mut self, command: &str) -> Result<Reply, Pop3Error> {
        self.send(command).await?;
        let reply = self.read_status().await?;
        self.broken = false;
        Ok(reply)
    }

    async fn expect_ok(&mut self, command: &str) -> Result<String, Pop3Error> {
        self.simple(command).await?.map_err(refused)
    }

    async fn listing<T>(
        &mut self,
        command: &str,
        max_bytes: u64,
        parse: impl Fn(&str) -> Option<T>,
    ) -> Result<Result<Vec<T>, String>, Pop3Error> {
        self.send(command).await?;
        if let Err(text) = self.read_status().await? {
            self.broken = false;
            return Ok(Err(text));
        }
        let body = self.read_multiline(max_bytes, Overflow::Abort).await?;
        let items = String::from_utf8_lossy(&body.data)
            .split_terminator("\r\n")
            .map(parse)
            .collect::<Option<Vec<T>>>()
            .ok_or_else(|| self.poison("unreadable listing"))?;
        self.broken = false;
        Ok(Ok(items))
    }

    async fn read_multiline(
        &mut self,
        max_bytes: u64,
        overflow: Overflow,
    ) -> Result<Body, Pop3Error> {
        let mut body = Body {
            data: Vec::new(),
            total: 0,
            max: max_bytes,
        };
        let mut state = LineState::Start;
        let mut discard_until: Option<tokio::time::Instant> = None;
        loop {
            let wait = match discard_until {
                // Without a total bound a trickling server keeps the discard alive forever.
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                    if left.is_zero() {
                        return Err(Pop3Error::Timeout);
                    }
                    left.min(READ_TIMEOUT)
                }
                None => READ_TIMEOUT,
            };
            let chunk = tokio::time::timeout(wait, self.stream.fill_buf())
                .await
                .map_err(|_| Pop3Error::Timeout)?
                .map_err(io_error)?;
            if chunk.is_empty() {
                return Err(connection_closed());
            }
            let mut used = 0;
            let mut done = false;
            for &byte in chunk {
                used += 1;
                match (state, byte) {
                    (LineState::Start, b'.') => {
                        state = LineState::Dot;
                        continue;
                    }
                    (LineState::Dot, b'\r') => {
                        state = LineState::DotCr;
                        continue;
                    }
                    (LineState::DotCr, b'\n') => {
                        done = true;
                        break;
                    }
                    (LineState::DotCr, _) => {
                        body.push(b'\r');
                        state = LineState::Cr;
                    }
                    _ => {}
                }
                body.push(byte);
                state = match (state, byte) {
                    (_, b'\r') => LineState::Cr,
                    (LineState::Cr, b'\n') => LineState::Start,
                    _ => LineState::Middle,
                };
            }
            self.stream.consume(used);
            if overflow == Overflow::Abort && body.total > body.max {
                return Err(Pop3Error::Protocol("response too long".into()));
            }
            if discard_until.is_none() && !done && body.total > body.max {
                discard_until = Some(tokio::time::Instant::now() + DISCARD_TIMEOUT);
            }
            if done {
                return Ok(body);
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Overflow {
    Abort,
    Discard,
}

#[derive(Clone, Copy)]
enum LineState {
    Start,
    Dot,
    DotCr,
    Cr,
    Middle,
}

struct Body {
    data: Vec<u8>,
    total: u64,
    max: u64,
}

impl Body {
    fn push(&mut self, byte: u8) {
        self.total += 1;
        if self.total > self.max {
            self.data = Vec::new();
            return;
        }
        if self.data.len() == self.data.capacity() {
            // Plain doubling could allocate far past the limit.
            let room = self.max - self.data.len() as u64;
            let grow = (self.data.len().max(8 * 1024) as u64).min(room);
            self.data.reserve_exact(grow as usize);
        }
        self.data.push(byte);
    }
}

fn parse_status(line: &str) -> Option<Reply> {
    let after = |marker: &str| {
        line.strip_prefix(marker)
            .filter(|rest| rest.is_empty() || rest.starts_with([' ', '\t']))
            .map(|rest| rest.trim().to_string())
    };
    after("+OK").map(Ok).or_else(|| after("-ERR").map(Err))
}

fn parse_sizes(line: &str) -> Option<(u32, u64)> {
    if line.contains(['\r', '\n']) {
        return None;
    }
    let mut words = line.split_whitespace();
    Some((words.next()?.parse().ok()?, words.next()?.parse().ok()?))
}

fn parse_uidl(line: &str) -> Option<(u32, String)> {
    let mut words = line.split(' ').filter(|word| !word.is_empty());
    let number = words.next()?.parse().ok()?;
    let uid = words.next()?;
    let valid = words.next().is_none() && uid.bytes().all(|b| b.is_ascii_graphic());
    valid.then(|| (number, uid.to_string()))
}

fn offers_plain(capability: &str) -> bool {
    let mut words = capability.split_whitespace();
    words
        .next()
        .is_some_and(|word| word.eq_ignore_ascii_case("SASL"))
        && words.any(|word| word.eq_ignore_ascii_case("PLAIN"))
}

fn offers_stls(capability: &str) -> bool {
    capability
        .split_whitespace()
        .next()
        .is_some_and(|word| word.eq_ignore_ascii_case("STLS"))
}

fn has_auth_code(text: &str) -> bool {
    text.to_ascii_uppercase().contains("[AUTH]")
}

fn is_locked(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    if text.contains("[in-use]") {
        return true;
    }
    let words: Vec<&str> = text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    let names_maildrop = words
        .iter()
        .any(|word| matches!(*word, "maildrop" | "mailbox"))
        || words
            .windows(2)
            .any(|pair| pair[0] == "mail" && matches!(pair[1], "drop" | "box"));
    names_maildrop && words.iter().any(|word| word.starts_with("lock"))
}

fn refused(text: String) -> Pop3Error {
    if is_locked(&text) {
        Pop3Error::Locked(text)
    } else {
        Pop3Error::Protocol(text)
    }
}

fn io_error(error: std::io::Error) -> Pop3Error {
    Pop3Error::Io(error.to_string())
}

fn connection_closed() -> Pop3Error {
    Pop3Error::Io("connection closed by the server".into())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use base64::Engine;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
    use tokio::task::JoinHandle;

    use super::*;
    use crate::pop3::test_server::scripted;

    const GREETING: (&str, &str) = ("", "+OK pop.studio-halde.example ready\r\n");
    const USER: &str = "anna@studio-halde.example";
    const USER_LINE: &str = "USER anna@studio-halde.example";
    const AUTH_LINE: &str = "AUTH PLAIN AGFubmFAc3R1ZGlvLWhhbGRlLmV4YW1wbGUAc2VjcmV0";

    async fn open(
        mut script: Vec<(&'static str, &'static str)>,
    ) -> (Pop3Client<DuplexStream>, JoinHandle<()>) {
        script.insert(0, GREETING);
        let (stream, server) = scripted(script);
        let client = Pop3Client::from_stream(stream).await.expect("greeting");
        (client, server)
    }

    async fn close(client: Pop3Client<DuplexStream>, server: JoinHandle<()>) {
        drop(client);
        server.await.expect("server script");
    }

    #[tokio::test]
    async fn greeting_ok_and_quit() {
        let (client, server) = open(vec![("QUIT", "+OK bye\r\n")]).await;
        client.quit().await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn login_user_pass_ok() {
        let (mut client, server) = open(vec![
            (USER_LINE, "+OK\r\n"),
            ("PASS secret", "+OK logged in\r\n"),
        ])
        .await;
        client.login(USER, "secret").await.unwrap();
        close(client, server).await;
    }

    #[tokio::test]
    async fn login_wrong_password_is_auth_error() {
        let (mut client, server) = open(vec![
            (USER_LINE, "+OK\r\n"),
            ("PASS secret", "-ERR [AUTH] invalid\r\n"),
        ])
        .await;
        let err = client.login(USER, "secret").await.unwrap_err();
        assert!(matches!(err, Pop3Error::Auth(_)), "{err:?}");
        close(client, server).await;
    }

    #[tokio::test]
    async fn login_falls_back_to_auth_plain() {
        let (mut client, server) = open(vec![
            (USER_LINE, "-ERR USER not supported\r\n"),
            ("CAPA", "+OK\r\nTOP\r\nSASL PLAIN LOGIN\r\n.\r\n"),
            (AUTH_LINE, "+OK\r\n"),
        ])
        .await;
        client.login(USER, "secret").await.unwrap();
        close(client, server).await;
    }

    #[tokio::test]
    async fn uidl_parses_multiline() {
        let (mut client, server) = open(vec![("UIDL", "+OK\r\n1 a1\r\n2 b2\r\n.\r\n")]).await;
        let list = client.uidl_all().await.unwrap();
        assert_eq!(list, vec![(1, "a1".to_string()), (2, "b2".to_string())]);
        close(client, server).await;
    }

    #[tokio::test]
    async fn uidl_unsupported_is_no_uidl() {
        let (mut client, server) = open(vec![
            ("UIDL", "-ERR unknown command\r\n"),
            ("NOOP", "+OK\r\n"),
        ])
        .await;
        assert!(matches!(client.uidl_all().await, Err(Pop3Error::NoUidl)));
        client.noop().await.unwrap();
        close(client, server).await;
    }

    #[tokio::test]
    async fn list_parses_sizes() {
        let (mut client, server) = open(vec![
            ("STAT", "+OK 2 4000\r\n"),
            ("LIST", "+OK 2 messages\r\n1 1500\r\n2 2500\r\n.\r\n"),
        ])
        .await;
        assert_eq!(client.stat().await.unwrap(), (2, 4000));
        assert_eq!(client.list_all().await.unwrap(), vec![(1, 1500), (2, 2500)]);
        close(client, server).await;
    }

    #[tokio::test]
    async fn retr_unstuffs_dots() {
        let (mut client, server) = open(vec![(
            "RETR 1",
            "+OK\r\nSubject: Hallo\r\n\r\n..hidden\r\n...\r\nbye\r\n.\r\n",
        )])
        .await;
        let raw = client.retr(1, MAX_MESSAGE_BYTES).await.unwrap();
        assert_eq!(raw, b"Subject: Hallo\r\n\r\n.hidden\r\n..\r\nbye\r\n");
        close(client, server).await;
    }

    #[tokio::test]
    async fn retr_over_max_bytes_is_too_large() {
        let (mut client, server) = open(vec![
            (
                "RETR 1",
                "+OK\r\n0123456789012345678901234567890123456789\r\n.\r\n",
            ),
            ("RETR 2", "+OK\r\n12345678\r\n.\r\n"),
            ("QUIT", "+OK\r\n"),
        ])
        .await;
        assert!(matches!(
            client.retr(1, 10).await,
            Err(Pop3Error::TooLarge(42))
        ));
        assert_eq!(client.retr(2, 10).await.unwrap(), b"12345678\r\n");
        client.quit().await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn trickling_oversize_reply_times_out_and_breaks_session() {
        let (stream, mut server) = tokio::io::duplex(64 * 1024);
        let feeder = tokio::spawn(async move {
            server.write_all(b"+OK ready\r\n").await.unwrap();
            let mut command = [0u8; 64];
            let _ = server.read(&mut command).await.unwrap();
            server.write_all(b"+OK\r\n").await.unwrap();
            server.write_all(&[b'x'; 64]).await.unwrap();
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                if server.write_all(b"y").await.is_err() {
                    break;
                }
            }
        });
        let mut client = Pop3Client::from_stream(stream).await.unwrap();
        let started = tokio::time::Instant::now();
        let result = client.retr(1, 10).await;
        assert!(matches!(result, Err(Pop3Error::Timeout)));
        assert!(started.elapsed() <= DISCARD_TIMEOUT + READ_TIMEOUT);
        assert!(matches!(client.noop().await, Err(Pop3Error::Io(_))));
        feeder.abort();
    }

    #[tokio::test]
    async fn maildrop_locked_maps_to_locked() {
        let (mut client, server) = open(vec![
            (USER_LINE, "+OK\r\n"),
            ("PASS secret", "-ERR [IN-USE] maildrop locked\r\n"),
        ])
        .await;
        let err = client.login(USER, "secret").await.unwrap_err();
        assert!(matches!(err, Pop3Error::Locked(_)), "{err:?}");
        close(client, server).await;
    }

    #[tokio::test]
    async fn quit_without_ok_is_error() {
        let (client, server) = open(vec![("QUIT", "<DROP>")]).await;
        assert!(client.quit().await.is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn capa_err_returns_empty() {
        let (mut client, server) = open(vec![("CAPA", "-ERR unknown command\r\n")]).await;
        assert!(client.capa().await.unwrap().is_empty());
        close(client, server).await;
    }

    #[tokio::test]
    async fn dele_rset_noop_succeed_and_report_errors() {
        let (mut client, server) = open(vec![
            ("DELE 1", "+OK\r\n"),
            ("RSET", "+OK\r\n"),
            ("NOOP", "+OK\r\n"),
            ("DELE 9", "-ERR no such message\r\n"),
            ("QUIT", "-ERR some messages not removed\r\n"),
        ])
        .await;
        client.dele(1).await.unwrap();
        client.rset().await.unwrap();
        client.noop().await.unwrap();
        assert!(matches!(client.dele(9).await, Err(Pop3Error::Protocol(_))));
        assert!(client.quit().await.is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn bad_status_line_poisons_session() {
        let (mut client, server) = open(vec![("NOOP", "garbage\r\n+OK stale\r\n")]).await;
        assert!(matches!(client.noop().await, Err(Pop3Error::Protocol(_))));
        assert!(client.dele(1).await.is_err());
        assert!(client.quit().await.is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn unparseable_listing_poisons_session() {
        let (mut client, server) = open(vec![("UIDL", "+OK\r\n1 a b\r\n.\r\n+OK stale\r\n")]).await;
        assert!(matches!(
            client.uidl_all().await,
            Err(Pop3Error::Protocol(_))
        ));
        assert!(client.quit().await.is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn unterminated_response_poisons_session() {
        let (mut client, server) =
            open(vec![("RETR 1", "+OK\r\npartial\r\n"), ("", "<DROP>")]).await;
        assert!(matches!(
            client.retr(1, MAX_MESSAGE_BYTES).await,
            Err(Pop3Error::Io(_))
        ));
        assert!(client.quit().await.is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn dropped_command_poisons_session() {
        let (mut client, server) =
            open(vec![("UIDL", "+OK\r\n1 a1\r\n"), ("", "+OK stale\r\n")]).await;
        let pending = tokio::time::timeout(Duration::from_millis(50), client.uidl_all()).await;
        assert!(pending.is_err());
        assert!(client.noop().await.is_err());
        assert!(client.quit().await.is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn bare_lf_dot_does_not_terminate() {
        let (mut client, server) =
            open(vec![("RETR 1", "+OK\r\na\n.\r\nb\r\n.\nc\r\n.\r\n")]).await;
        let raw = client.retr(1, MAX_MESSAGE_BYTES).await.unwrap();
        assert_eq!(raw, b"a\n.\r\nb\r\n\nc\r\n");
        close(client, server).await;
    }

    #[tokio::test]
    async fn empty_multiline_response_is_empty() {
        let (mut client, server) = open(vec![("UIDL", "+OK\r\n.\r\n")]).await;
        assert!(client.uidl_all().await.unwrap().is_empty());
        close(client, server).await;
    }

    #[tokio::test]
    async fn oversized_status_line_is_rejected() {
        let long: &'static str =
            Box::leak(format!("+OK {}\r\n", "x".repeat(20_000)).into_boxed_str());
        let (mut client, server) = open(vec![("NOOP", long)]).await;
        assert!(matches!(client.noop().await, Err(Pop3Error::Protocol(_))));
        assert!(client.quit().await.is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn oversized_capability_list_is_rejected() {
        let long: &'static str =
            Box::leak(format!("+OK\r\n{}\r\n.\r\n", "x".repeat(100_000)).into_boxed_str());
        let (mut client, server) = open(vec![("CAPA", long)]).await;
        assert!(matches!(client.capa().await, Err(Pop3Error::Protocol(_))));
        assert!(client.quit().await.is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn control_characters_in_credentials_are_not_sent() {
        let (mut client, server) = open(vec![]).await;
        for (user, pass) in [
            (USER, "secret\r\nDELE 1"),
            ("anna\n", "secret"),
            (USER, "se\0cret"),
        ] {
            let err = client.login(user, pass).await.unwrap_err();
            assert!(matches!(err, Pop3Error::Auth(_)), "{err:?}");
            assert!(!format!("{err:?} {err}").contains("DELE"));
        }
        close(client, server).await;
    }

    #[tokio::test]
    async fn echoed_password_is_not_in_error() {
        let (mut client, server) = open(vec![
            (USER_LINE, "+OK\r\n"),
            ("PASS secret", "-ERR bad command PASS secret\r\n"),
            (USER_LINE, "-ERR USER not supported\r\n"),
            ("CAPA", "+OK\r\nSASL PLAIN\r\n.\r\n"),
            (
                AUTH_LINE,
                "-ERR bad AGFubmFAc3R1ZGlvLWhhbGRlLmV4YW1wbGUAc2VjcmV0\r\n",
            ),
        ])
        .await;
        for _ in 0..2 {
            let err = client.login(USER, "secret").await.unwrap_err();
            let shown = format!("{err:?} {err}");
            assert!(
                !shown.contains("secret") && !shown.contains("AGFubmF"),
                "{shown}"
            );
        }
        close(client, server).await;
    }

    #[tokio::test]
    async fn rejected_greeting_is_error() {
        let (stream, server) = scripted(vec![("", "-ERR [IN-USE] try later\r\n")]);
        assert!(matches!(
            Pop3Client::from_stream(stream).await,
            Err(Pop3Error::Locked(_))
        ));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn starttls_hands_back_the_stream() {
        let (client, server) = open(vec![
            ("CAPA", "+OK\r\nSTLS\r\n.\r\n"),
            ("STLS", "+OK begin TLS\r\n"),
        ])
        .await;
        let stream = client.into_starttls_stream().await.unwrap();
        drop(stream);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn starttls_without_stls_is_tls_error() {
        let (client, server) = open(vec![("CAPA", "+OK\r\nUIDL\r\n.\r\n")]).await;
        let err = client.into_starttls_stream().await.map(|_| ()).unwrap_err();
        assert!(
            matches!(&err, Pop3Error::Tls(text) if text == "server offers no STLS"),
            "{err:?}"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn starttls_rejects_buffered_plaintext() {
        let (client, server) = open(vec![
            ("CAPA", "+OK\r\nSTLS\r\n.\r\n"),
            ("STLS", "+OK begin TLS\r\n+OK injected\r\n"),
        ])
        .await;
        let result = client.into_starttls_stream().await.map(|_| ());
        assert!(matches!(result, Err(Pop3Error::Tls(_))));
        server.await.unwrap();
    }

    fn leak(text: String) -> &'static str {
        Box::leak(text.into_boxed_str())
    }

    fn plain_token(pass: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(format!("\0{USER}\0{pass}"))
    }

    #[tokio::test]
    async fn buffered_stale_reply_is_not_taken_for_quit() {
        let (mut client, server) = open(vec![("NOOP", "+OK\r\n+OK stale\r\n")]).await;
        client.noop().await.unwrap();
        assert!(matches!(client.quit().await, Err(Pop3Error::Protocol(_))));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn stale_reply_still_in_stream_is_not_taken_for_quit() {
        let (stream, mut server) = tokio::io::duplex(1024);
        server.write_all(b"+OK ready\r\n").await.unwrap();
        let mut client = Pop3Client::from_stream(stream).await.unwrap();
        server.write_all(b"+OK stale\r\n").await.unwrap();
        assert!(matches!(client.noop().await, Err(Pop3Error::Protocol(_))));
        assert!(client.quit().await.is_err());
        let mut sent = Vec::new();
        server.read_to_end(&mut sent).await.unwrap();
        assert_eq!(sent, b"");
    }

    #[tokio::test]
    async fn closed_connection_is_noticed_before_writing() {
        let (stream, mut server) = tokio::io::duplex(1024);
        server.write_all(b"+OK ready\r\n").await.unwrap();
        let mut client = Pop3Client::from_stream(stream).await.unwrap();
        server.shutdown().await.unwrap();
        assert!(matches!(client.noop().await, Err(Pop3Error::Io(_))));
        drop(client);
        let mut sent = Vec::new();
        server.read_to_end(&mut sent).await.unwrap();
        assert_eq!(sent, b"");
    }

    #[test]
    fn only_maildrop_locks_count_as_locked() {
        for text in [
            "[IN-USE] try later",
            "[in-use]",
            "maildrop locked",
            "unable to lock maildrop",
            "Mailbox is locked by another session",
            "mail drop already locked",
            "could not lock mail box",
        ] {
            assert!(is_locked(text), "{text}");
        }
        for text in [
            "login blocked",
            "account locked",
            "mailbox blocked",
            "mailbox unavailable",
            "your clock is wrong",
        ] {
            assert!(!is_locked(text), "{text}");
        }
    }

    #[tokio::test]
    async fn blocked_or_locked_account_after_pass_is_auth_error() {
        for reply in ["-ERR login blocked\r\n", "-ERR account locked\r\n"] {
            let (mut client, server) =
                open(vec![(USER_LINE, "+OK\r\n"), ("PASS secret", reply)]).await;
            let err = client.login(USER, "secret").await.unwrap_err();
            assert!(matches!(err, Pop3Error::Auth(_)), "{err:?}");
            close(client, server).await;
        }
    }

    #[tokio::test]
    async fn blocked_user_command_still_falls_back_to_auth_plain() {
        let (mut client, server) = open(vec![
            (USER_LINE, "-ERR plaintext login blocked\r\n"),
            ("CAPA", "+OK\r\nSASL PLAIN\r\n.\r\n"),
            (AUTH_LINE, "+OK\r\n"),
        ])
        .await;
        client.login(USER, "secret").await.unwrap();
        close(client, server).await;
    }

    #[tokio::test]
    async fn auth_plain_answers_a_continuation() {
        let (mut client, server) = open(vec![
            (USER_LINE, "-ERR USER not supported\r\n"),
            ("CAPA", "+OK\r\nSASL PLAIN\r\n.\r\n"),
            (AUTH_LINE, "+ \r\n"),
            ("AGFubmFAc3R1ZGlvLWhhbGRlLmV4YW1wbGUAc2VjcmV0", "+OK\r\n"),
            ("NOOP", "+OK\r\n"),
        ])
        .await;
        client.login(USER, "secret").await.unwrap();
        client.noop().await.unwrap();
        close(client, server).await;
    }

    #[tokio::test]
    async fn auth_plain_keeps_one_line_up_to_the_command_limit() {
        let pass = "p".repeat(153);
        let line = format!("AUTH PLAIN {}", plain_token(&pass));
        assert_eq!(line.len() + 2, 253);
        let (mut client, server) = open(vec![
            (USER_LINE, "-ERR USER not supported\r\n"),
            ("CAPA", "+OK\r\nSASL PLAIN\r\n.\r\n"),
            (leak(line), "+OK\r\n"),
        ])
        .await;
        client.login(USER, &pass).await.unwrap();
        close(client, server).await;
    }

    #[tokio::test]
    async fn long_auth_plain_waits_for_continuation() {
        let pass = "p".repeat(154);
        let token = leak(plain_token(&pass));
        let (mut client, server) = open(vec![
            (USER_LINE, "-ERR USER not supported\r\n"),
            ("CAPA", "+OK\r\nSASL PLAIN\r\n.\r\n"),
            ("AUTH PLAIN", "+\r\n"),
            (token, leak(format!("-ERR bad {token}\r\n"))),
            ("NOOP", "+OK\r\n"),
        ])
        .await;
        let err = client.login(USER, &pass).await.unwrap_err();
        assert!(
            matches!(&err, Pop3Error::Auth(text) if text == "[redacted]"),
            "{err:?}"
        );
        client.noop().await.unwrap();
        close(client, server).await;
    }

    #[tokio::test]
    async fn repeated_continuation_poisons_session_without_leaking() {
        let (mut client, server) = open(vec![
            (USER_LINE, "-ERR USER not supported\r\n"),
            ("CAPA", "+OK\r\nSASL PLAIN\r\n.\r\n"),
            (AUTH_LINE, "+ \r\n"),
            (
                "AGFubmFAc3R1ZGlvLWhhbGRlLmV4YW1wbGUAc2VjcmV0",
                "+ secret\r\n",
            ),
        ])
        .await;
        let err = client.login(USER, "secret").await.unwrap_err();
        assert!(matches!(err, Pop3Error::Protocol(_)), "{err:?}");
        assert!(!format!("{err:?} {err}").contains("secret"));
        assert!(client.quit().await.is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn bare_line_breaks_in_list_poison_session() {
        for reply in [
            "+OK\r\n1 100\n2 200\r\n.\r\n",
            "+OK\r\n1 100\r2 200\r\n.\r\n",
        ] {
            let (mut client, server) = open(vec![("LIST", reply)]).await;
            assert!(matches!(
                client.list_all().await,
                Err(Pop3Error::Protocol(_))
            ));
            assert!(client.quit().await.is_err());
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn bare_line_breaks_in_uidl_poison_session() {
        for reply in ["+OK\r\n1 a1\n2 b2\r\n.\r\n", "+OK\r\n1 a1\r2 b2\r\n.\r\n"] {
            let (mut client, server) = open(vec![("UIDL", reply)]).await;
            assert!(matches!(
                client.uidl_all().await,
                Err(Pop3Error::Protocol(_))
            ));
            assert!(client.quit().await.is_err());
            server.await.unwrap();
        }
    }

    #[test]
    fn security_parses_from_str() {
        assert_eq!("ssl".parse::<Pop3Security>().unwrap(), Pop3Security::Ssl);
        assert_eq!(
            "starttls".parse::<Pop3Security>().unwrap(),
            Pop3Security::StartTls
        );
        assert!("none".parse::<Pop3Security>().is_err());
    }
}
