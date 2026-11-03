use percent_encoding::percent_decode_str;

#[derive(Debug, Clone, PartialEq)]
pub struct MailtoTarget {
    pub to: Vec<String>,
    pub subject: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Targets {
    pub https: Vec<String>,
    pub http: Vec<String>,
    pub mailto: Vec<MailtoTarget>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Method {
    OneClick(String),
    Mailto(MailtoTarget),
    Web(String),
}

impl Method {
    pub fn kind(&self) -> &'static str {
        match self {
            Method::OneClick(_) => "one_click",
            Method::Mailto(_) => "mailto",
            Method::Web(_) => "web",
        }
    }
}

const DEFAULT_TEXT: &str = "unsubscribe";

pub fn parse_targets(header: &str) -> Targets {
    let mut targets = Targets::default();
    for entry in header.split('<').skip(1).filter_map(|rest| rest.split_once('>').map(|(inner, _)| inner)) {
        let entry: String = entry.split_whitespace().collect();
        let Ok(url) = reqwest::Url::parse(&entry) else { continue };
        match url.scheme() {
            "https" if url.host_str().is_some() => targets.https.push(entry),
            "http" if url.host_str().is_some() => targets.http.push(entry),
            "mailto" => {
                if let Some(target) = mailto_target(&url) {
                    targets.mailto.push(target);
                }
            }
            _ => {}
        }
    }
    targets
}

// RFC 6068 percent-encodes mailto parts; '+' is literal, so form decoding would corrupt it.
fn decode(part: &str) -> String {
    percent_decode_str(part).decode_utf8_lossy().into_owned()
}

fn mailto_target(url: &reqwest::Url) -> Option<MailtoTarget> {
    let to: Vec<String> = url
        .path()
        .split(',')
        .map(|a| decode(a).trim().to_string())
        .filter(|a| a.contains('@'))
        .collect();
    if to.is_empty() {
        return None;
    }
    let mut subject = None;
    let mut body = None;
    for pair in url.query().unwrap_or("").split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key.to_ascii_lowercase().as_str() {
            "subject" => subject = Some(decode(value)),
            "body" => body = Some(decode(value)),
            _ => {}
        }
    }
    let or_default = |v: Option<String>| v.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| DEFAULT_TEXT.to_string());
    Some(MailtoTarget { to, subject: or_default(subject), body: or_default(body) })
}

/// The ways to try, in order: one-click only when the sender announced it over https.
pub fn plan_methods(targets: &Targets, one_click_offered: bool) -> Vec<Method> {
    let mut methods = Vec::new();
    if one_click_offered {
        if let Some(url) = targets.https.first() {
            methods.push(Method::OneClick(url.clone()));
        }
    }
    if let Some(target) = targets.mailto.first() {
        methods.push(Method::Mailto(target.clone()));
    }
    if let Some(url) = targets.https.first().or(targets.http.first()) {
        methods.push(Method::Web(url.clone()));
    }
    methods
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(methods: Vec<Method>) -> Vec<&'static str> {
        methods.iter().map(Method::kind).collect()
    }

    #[test]
    fn parses_https_http_and_mailto_targets() {
        let t = parse_targets("<http://news.halde-shop.example/u?id=1>, <https://news.halde-shop.example/u?id=1>,\r\n <mailto:unsub@halde-shop.example?subject=Abmelden%20bitte>");
        assert_eq!(t.https, vec!["https://news.halde-shop.example/u?id=1"]);
        assert_eq!(t.http, vec!["http://news.halde-shop.example/u?id=1"]);
        assert_eq!(t.mailto[0].to, vec!["unsub@halde-shop.example"]);
        assert_eq!(t.mailto[0].subject, "Abmelden bitte");
    }

    #[test]
    fn mailto_defaults_and_decoding() {
        let t = parse_targets("<mailto:list%2Bunsub@halde-shop.example>");
        assert_eq!(t.mailto[0].to, vec!["list+unsub@halde-shop.example"]);
        assert_eq!((t.mailto[0].subject.as_str(), t.mailto[0].body.as_str()), ("unsubscribe", "unsubscribe"));
        let t = parse_targets("<mailto:a@halde-shop.example,b@halde-shop.example?body=stop+now>");
        assert_eq!(t.mailto[0].to.len(), 2);
        assert_eq!(t.mailto[0].body, "stop+now");
    }

    #[test]
    fn one_click_only_with_post_header_and_https() {
        let t = parse_targets("<https://h.example/u>, <mailto:u@h.example>");
        assert_eq!(kinds(plan_methods(&t, true)), ["one_click", "mailto", "web"]);
        assert_eq!(kinds(plan_methods(&t, false)), ["mailto", "web"]);
        assert_eq!(kinds(plan_methods(&parse_targets("<http://h.example/u>"), true)), ["web"]);
    }

    #[test]
    fn garbage_yields_no_methods() {
        for h in ["", "no brackets", "<javascript:alert(1)>", "<>"] {
            assert!(plan_methods(&parse_targets(h), true).is_empty(), "{h}");
        }
    }
}
