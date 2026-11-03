use super::header::MailtoTarget;
use crate::smtp::EmailMessage;
use std::future::Future;

/// RFC 8058: no cookies, no auth, no referer, and a redirect is not an answer.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Prudii")
        .build()
        .unwrap_or_default()
}

pub async fn one_click(client: &reqwest::Client, url: &str) -> Result<(), String> {
    let response = client
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("List-Unsubscribe=One-Click")
        .send()
        .await
        .map_err(|e| format!("one-click request failed: {e}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("one-click answered {}", response.status()))
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
    fn one_click(&self, url: &str) -> impl Future<Output = Result<(), String>> + Send;
    fn send_mail(&self, account_id: &str, message: EmailMessage) -> impl Future<Output = Result<(), String>> + Send;
}

pub struct AppTransport {
    pub app: tauri::AppHandle,
    pub client: reqwest::Client,
}

impl Transport for AppTransport {
    fn one_click(&self, url: &str) -> impl Future<Output = Result<(), String>> + Send {
        one_click(&self.client, url)
    }

    fn send_mail(&self, account_id: &str, message: EmailMessage) -> impl Future<Output = Result<(), String>> + Send {
        crate::commands::send::send_prepared_mail(&self.app, account_id, message)
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
        one_click(&http_client(), &format!("{base}/u?id=1")).await.unwrap();
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
        assert!(one_click(&http_client(), &format!("{base}/u")).await.is_err());
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn server_error_is_failure() {
        let (base, _) = serve_http(vec!["HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()]);
        assert!(one_click(&http_client(), &format!("{base}/u")).await.is_err());
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
