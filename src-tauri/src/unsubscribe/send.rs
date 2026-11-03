use super::header::MailtoTarget;
use crate::smtp::EmailMessage;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    Unreachable(String),
    Rejected(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Unreachable(e) => write!(f, "unreachable: {e}"),
            Failure::Rejected(e) => write!(f, "rejected: {e}"),
        }
    }
}

/// RFC 8058: no cookies, no auth, no referer, and a redirect is not an answer.
pub fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Prudii")
        .build()
        .map_err(|e| e.to_string())
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || ip.is_broadcast() || a == 0 || (a == 100 && (64..128).contains(&b)))
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_public_v4(v4),
            None => !(v6.is_loopback() || v6.is_unspecified() || is_local_v6(v6)),
        },
    }
}

fn is_local_v6(ip: Ipv6Addr) -> bool {
    let first = ip.segments()[0];
    (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
}

/// A mail's header must not make Prudii post into the user's own network (router, NAS, localhost).
pub async fn is_public_target(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else { return false };
    let port = url.port_or_known_default().unwrap_or(443);
    let Some(host) = url.host_str() else { return false };
    if let Ok(ip) = host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
        return is_public_ip(ip);
    }
    let domain = host.trim_end_matches('.').to_ascii_lowercase();
    if domain == "localhost" || domain.ends_with(".localhost") {
        return false;
    }
    // An unresolvable host fails on its own as unreachable.
    match tokio::net::lookup_host(format!("{domain}:{port}")).await {
        Ok(addrs) => addrs.into_iter().all(|a| is_public_ip(a.ip())),
        Err(_) => true,
    }
}

pub async fn one_click(client: &reqwest::Client, url: &str) -> Result<(), Failure> {
    let response = client
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("List-Unsubscribe=One-Click")
        .send()
        .await
        .map_err(|e| Failure::Unreachable(e.to_string()))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(Failure::Rejected(format!("answered {}", response.status())))
    }
}

pub fn mailto_message(target: &MailtoTarget) -> EmailMessage {
    EmailMessage {
        to: target.to.clone(),
        cc: Vec::new(),
        bcc: Vec::new(),
        subject: target.subject.clone(),
        body_text: target.body.clone(),
        body_html: None,
        in_reply_to: None,
        references: None,
        attachments: Vec::new(),
        calendar_part: None,
    }
}

pub trait Transport {
    fn one_click(&self, url: &str) -> impl Future<Output = Result<(), Failure>> + Send;
    fn send_mail(&self, account_id: &str, message: EmailMessage) -> impl Future<Output = Result<(), Failure>> + Send;
}

pub struct AppTransport {
    pub app: tauri::AppHandle,
    pub client: reqwest::Client,
}

impl Transport for AppTransport {
    fn one_click(&self, url: &str) -> impl Future<Output = Result<(), Failure>> + Send {
        let client = self.client.clone();
        let url = url.to_string();
        async move {
            if !is_public_target(&url).await {
                return Err(Failure::Rejected("refused a non-public address".into()));
            }
            one_click(&client, &url).await
        }
    }

    // A send error does not say whether the network is down, so it never blocks the web fallback.
    fn send_mail(&self, account_id: &str, message: EmailMessage) -> impl Future<Output = Result<(), Failure>> + Send {
        let sent = crate::commands::send::send_prepared_mail(&self.app, account_id, message);
        async move { sent.await.map_err(Failure::Rejected) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::serve_http;

    const OK: &str = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

    #[tokio::test]
    async fn one_click_posts_the_rfc_body() {
        let (base, seen) = serve_http(vec![OK.to_string()]);
        one_click(&http_client().unwrap(), &format!("{base}/u?id=1")).await.unwrap();
        let request = seen.lock().unwrap()[0].clone();
        assert!(request.starts_with("post /u?id=1 "), "{request}");
        assert!(request.contains("list-unsubscribe=one-click"), "{request}");
        assert!(request.contains("content-type: application/x-www-form-urlencoded"), "{request}");
        assert!(!request.contains("cookie:") && !request.contains("referer:"), "{request}");
    }

    #[tokio::test]
    async fn redirect_is_not_success() {
        let (base, seen) = serve_http(vec![
            "HTTP/1.1 302 Found\r\nLocation: /done\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
            OK.to_string(),
        ]);
        assert!(one_click(&http_client().unwrap(), &format!("{base}/u")).await.is_err());
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn server_error_is_failure() {
        let (base, _) = serve_http(vec!["HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()]);
        assert!(one_click(&http_client().unwrap(), &format!("{base}/u")).await.is_err());
    }

    #[tokio::test]
    async fn dead_host_is_unreachable_and_refusal_is_rejected() {
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let dead = one_click(&http_client().unwrap(), &format!("http://127.0.0.1:{port}/u")).await;
        assert!(matches!(dead, Err(Failure::Unreachable(_))), "{dead:?}");
        let (base, _) = serve_http(vec!["HTTP/1.1 410 Gone\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()]);
        let gone = one_click(&http_client().unwrap(), &format!("{base}/u")).await;
        assert!(matches!(gone, Err(Failure::Rejected(_))), "{gone:?}");
    }

    #[tokio::test]
    async fn private_targets_are_refused() {
        for url in [
            "http://127.0.0.1/u",
            "https://10.0.0.5/u",
            "https://172.16.0.1/u",
            "https://192.168.1.2/u",
            "https://169.254.1.1/u",
            "https://100.64.0.1/u",
            "https://0.0.0.0/u",
            "https://localhost/u",
            "https://[::1]/u",
            "https://[fd00::1]/u",
            "https://[fe80::1]/u",
            "https://[::ffff:192.168.1.2]/u",
        ] {
            assert!(!is_public_target(url).await, "{url}");
        }
        assert!(is_public_target("https://93.184.216.34/u").await);
        assert!(is_public_target("https://[2606:4700::1111]/u").await);
    }

    #[test]
    fn mailto_message_carries_subject_and_body() {
        let target = MailtoTarget { to: vec!["unsub@halde-shop.example".into()], subject: "Abmelden".into(), body: "bitte".into() };
        let message = mailto_message(&target);
        assert_eq!(message.to, vec!["unsub@halde-shop.example"]);
        assert_eq!((message.subject.as_str(), message.body_text.as_str()), ("Abmelden", "bitte"));
        assert!(message.cc.is_empty() && message.attachments.is_empty() && message.calendar_part.is_none());
    }
}
