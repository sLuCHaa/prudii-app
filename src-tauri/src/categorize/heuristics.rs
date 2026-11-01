use super::signals::HeaderSignals;
use super::{Decision, Reason, THRESHOLD};

pub struct MailInput<'a> {
    pub from_email: &'a str,
    pub subject: &'a str,
    pub signals: &'a HeaderSignals,
    pub sent_count: u32,
}

pub const NOTIFICATION_DOMAINS: &[&str] = &[
    "github.com", "gitlab.com", "bitbucket.org",
    "atlassian.net", "jira.atlassian.com", "trello.com",
    "slack.com", "asana.com", "notion.so", "linear.app",
    "vercel.com", "netlify.com", "heroku.com",
    "circleci.com", "travis-ci.org", "sentry.io",
    "docker.com", "npmjs.com", "crates.io",
    "stackoverflow.com", "stackexchange.com",
    "medium.com", "dev.to", "hashnode.dev",
    "figma.com", "canva.com",
    "dropbox.com", "drive.google.com",
    "zoom.us", "calendly.com",
];

pub const SOCIAL_DOMAINS: &[&str] = &[
    "facebook.com", "facebookmail.com",
    "twitter.com", "x.com",
    "linkedin.com", "linkedinmail.com",
    "instagram.com",
    "reddit.com", "redditmail.com",
    "tiktok.com",
    "pinterest.com",
    "youtube.com",
    "tumblr.com",
    "mastodon.social",
    "discord.com",
    "twitch.tv",
    "whatsapp.com",
    "telegram.org",
];

pub const SHOP_DOMAINS: &[&str] = &[
    "paypal.com", "stripe.com",
    "amazon.com", "amazon.de", "amazon.co.uk",
    "ebay.com", "etsy.com",
    "ups.com", "fedex.com", "dhl.com", "usps.com",
    "shopify.com",
    "apple.com",
    "google.com",
    "uber.com", "lyft.com",
    "airbnb.com", "booking.com",
    "doordash.com", "grubhub.com",
];

pub const PURCHASE_KEYWORDS: &[&str] = &[
    "order confirmation", "order confirmed", "your order",
    "invoice", "receipt", "payment",
    "shipping", "shipped", "delivery", "delivered", "tracking",
    "rechnung", "bestellung", "versand", "lieferung",
    "facture", "commande", "livraison",
    "factura", "pedido", "envío",
];

pub const PROMO_KEYWORDS: &[&str] = &[
    "% off", "sale", "deal", "offer", "discount",
    "coupon", "promo", "limited time", "flash sale",
    "free shipping", "buy now", "shop now",
    "exclusive", "clearance", "save up to",
    "rabatt", "angebot", "aktion",
    "soldes", "réduction", "offre",
    "descuento", "oferta", "rebajas",
];

const AUTOMATED_LOCAL_PARTS: &[&str] = &[
    "noreply", "no-reply", "donotreply", "do-not-reply", "notifications", "notification",
    "alert", "alerts", "mailer-daemon", "postmaster", "bounce", "automated", "system", "notify",
];

const AUTOMATED_LOCAL_PREFIXES: &[&str] = &["noreply", "no-reply", "bounce"];

const ROLE_LOCAL_PARTS: &[&str] = &[
    "info", "support", "service", "hello", "team", "news", "newsletter", "marketing", "billing",
    "invoice", "rechnung", "kundenservice", "kontakt", "contact", "office", "sales", "shop",
    "store", "order", "orders", "mail",
];

struct Candidate {
    category: &'static str,
    source: &'static str,
    confidence: f32,
    reasons: Vec<Reason>,
}

fn split_sender(from_email: &str) -> Option<(String, String)> {
    let lower = from_email.trim().to_lowercase();
    let (local, domain) = lower.rsplit_once('@')?;
    if local.is_empty() || domain.is_empty() {
        return None;
    }
    Some((local.to_string(), domain.to_string()))
}

fn is_listed(domain: &str, list: &[&str]) -> bool {
    list.iter()
        .any(|d| domain == *d || domain.strip_suffix(*d).is_some_and(|rest| rest.ends_with('.')))
}

fn find_keyword<'a>(subject_lower: &str, list: &[&'a str]) -> Option<&'a str> {
    list.iter().copied().find(|kw| {
        subject_lower.match_indices(*kw).any(|(start, _)| {
            let end = start + kw.len();
            let left_ok = !kw.chars().next().is_some_and(char::is_alphanumeric)
                || !subject_lower[..start].chars().next_back().is_some_and(char::is_alphanumeric);
            let right_ok = !kw.chars().next_back().is_some_and(char::is_alphanumeric)
                || !subject_lower[end..].chars().next().is_some_and(char::is_alphanumeric);
            left_ok && right_ok
        })
    })
}

fn bulk_reasons(signals: &HeaderSignals) -> Vec<Reason> {
    let mut reasons = Vec::new();
    if signals.list_id || signals.precedence_bulk {
        reasons.push(Reason::new("mailing_list"));
    }
    if let Some(esp) = signals.esp {
        reasons.push(Reason::new("bulk_sender").with("esp", esp));
    }
    if signals.unsubscribe {
        reasons.push(Reason::new("unsubscribe_link"));
    }
    reasons
}

fn is_automated_local(local: &str) -> bool {
    AUTOMATED_LOCAL_PARTS.contains(&local) || AUTOMATED_LOCAL_PREFIXES.iter().any(|p| local.starts_with(p))
}

pub fn classify(input: &MailInput) -> Decision {
    let signals = input.signals;
    let sender = split_sender(input.from_email);
    let subject_lower = input.subject.to_lowercase();
    let gmail = signals.gmail_category.as_deref();
    let bulk = signals.is_bulk();
    let purchase_keyword = find_keyword(&subject_lower, PURCHASE_KEYWORDS);
    let promo_keyword = find_keyword(&subject_lower, PROMO_KEYWORDS);

    let mut candidates: Vec<Candidate> = Vec::new();
    let mut add = |category: &'static str, source: &'static str, confidence: f32, reasons: Vec<Reason>| {
        candidates.push(Candidate { category, source, confidence, reasons });
    };

    let (social_domain, notification_domain, shop_domain, automated_local) = match &sender {
        Some((local, domain)) => (
            is_listed(domain, SOCIAL_DOMAINS).then_some(domain.as_str()),
            is_listed(domain, NOTIFICATION_DOMAINS).then_some(domain.as_str()),
            is_listed(domain, SHOP_DOMAINS).then_some(domain.as_str()),
            is_automated_local(local),
        ),
        None => (None, None, None, false),
    };
    let automated = automated_local || signals.auto_submitted;
    let sender_address = sender.as_ref().map(|(l, d)| format!("{l}@{d}"));

    if let Some(d) = social_domain {
        add("social", "heuristic", 0.90, vec![Reason::new("social_domain").with("domain", d)]);
    }
    if gmail == Some("social") {
        add("social", "heuristic", 0.85, vec![Reason::new("gmail_social")]);
    }

    if let (Some(d), Some(kw)) = (shop_domain, purchase_keyword) {
        add(
            "purchases",
            "heuristic",
            0.90,
            vec![Reason::new("shop_domain").with("domain", d), Reason::new("purchase_keyword").with("keyword", kw)],
        );
    }
    if let Some(kw) = purchase_keyword {
        if automated || bulk {
            add("purchases", "heuristic", 0.80, vec![Reason::new("purchase_keyword").with("keyword", kw)]);
        }
    }

    if automated_local {
        let reason = Reason::new("noreply_sender").with("sender", sender_address.as_deref().unwrap_or_default());
        add("notifications", "heuristic", 0.75, vec![reason]);
    } else if signals.auto_submitted {
        add("notifications", "heuristic", 0.75, vec![Reason::new("automated_header")]);
    }
    if let Some(d) = notification_domain {
        add("notifications", "heuristic", 0.75, vec![Reason::new("notification_domain").with("domain", d)]);
    }
    if gmail == Some("updates") {
        add("notifications", "heuristic", 0.70, vec![Reason::new("gmail_updates")]);
    }

    if gmail == Some("promotions") {
        add("promotions", "heuristic", 0.85, vec![Reason::new("gmail_promotions")]);
    }
    if bulk {
        match promo_keyword {
            Some(kw) => {
                let mut reasons = vec![Reason::new("promo_keyword").with("keyword", kw)];
                reasons.extend(bulk_reasons(signals));
                add("promotions", "heuristic", 0.80, reasons);
            }
            None => add("newsletters", "heuristic", 0.75, bulk_reasons(signals)),
        }
    }
    if gmail == Some("forums") {
        add("newsletters", "heuristic", 0.70, vec![Reason::new("gmail_forums")]);
    }

    if let Some((local, _)) = &sender {
        if !bulk && !automated {
            if input.sent_count > 0 {
                add(
                    "important",
                    "relation",
                    0.95,
                    vec![Reason::new("sent_to_sender")
                        .with("sender", sender_address.as_deref().unwrap_or_default())
                        .with("count", input.sent_count)],
                );
            }
            if !ROLE_LOCAL_PARTS.contains(&local.as_str())
                && social_domain.is_none()
                && notification_domain.is_none()
                && gmail.is_none()
            {
                add("important", "heuristic", 0.65, vec![Reason::new("personal_mail")]);
            }
        }
    }

    let mut best: Option<Candidate> = None;
    for c in candidates {
        if best.as_ref().is_none_or(|b| c.confidence > b.confidence) {
            best = Some(c);
        }
    }

    match best {
        Some(c) if c.confidence >= THRESHOLD => Decision {
            category: Some(c.category.to_string()),
            source: c.source,
            confidence: c.confidence,
            reasons: c.reasons,
        },
        _ => Decision { category: None, source: "heuristic", confidence: 0.0, reasons: vec![Reason::new("low_confidence")] },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(from: &str, subject: &str, headers: &str, unsub: &str, sent: u32) -> Decision {
        let signals = HeaderSignals::parse(headers, unsub);
        classify(&MailInput { from_email: from, subject, signals: &signals, sent_count: sent })
    }

    fn codes(d: &Decision) -> Vec<&str> {
        d.reasons.iter().map(|r| r.code.as_str()).collect()
    }

    fn param<'a>(d: &'a Decision, code: &str, key: &str) -> &'a str {
        d.reasons.iter().find(|r| r.code == code).unwrap().params[key].as_str()
    }

    #[test]
    fn correspondent_is_important() {
        let d = run("anna.weber@studio-halde.example", "Kurze Frage zum Angebot", "{}", "", 14);
        assert_eq!(d.category.as_deref(), Some("important"));
        assert_eq!(d.confidence, 0.95);
        assert_eq!(d.source, "relation");
        assert_eq!(param(&d, "sent_to_sender", "sender"), "anna.weber@studio-halde.example");
        assert_eq!(param(&d, "sent_to_sender", "count"), "14");
    }

    #[test]
    fn personal_first_contact_is_important() {
        let d = run("anna.weber@studio-halde.example", "Kurze Frage zum Angebot", "{}", "", 0);
        assert_eq!(d.category.as_deref(), Some("important"));
        assert_eq!(d.confidence, 0.65);
        assert_eq!(codes(&d), ["personal_mail"]);
    }

    #[test]
    fn role_address_without_signals_is_unsure() {
        let d = run("info@studio-halde.example", "Ihre Anfrage", "{}", "", 0);
        assert_eq!(d.category, None);
        assert_eq!(codes(&d), ["low_confidence"]);
    }

    #[test]
    fn list_mail_is_newsletter() {
        let d = run("news@designweekly.example", "Wochenrückblick Design", r#"{"list-id":"<wr.designweekly.example>"}"#, "<mailto:x@designweekly.example>", 0);
        assert_eq!(d.category.as_deref(), Some("newsletters"));
        assert!(codes(&d).contains(&"mailing_list"));
        assert!(codes(&d).contains(&"unsubscribe_link"));
    }

    #[test]
    fn bulk_with_promo_word_is_promotion() {
        let d = run("angebote@modehaus-lind.example", "Nur heute: 30% Rabatt", "{}", "<https://modehaus-lind.example/abmelden>", 0);
        assert_eq!(d.category.as_deref(), Some("promotions"));
        assert_eq!(param(&d, "promo_keyword", "keyword"), "rabatt");
    }

    #[test]
    fn shop_domain_with_purchase_word() {
        let from = format!("versand@{}", SHOP_DOMAINS[0]);
        let d = run(&from, "Deine Bestellung wurde versandt", "{}", "", 0);
        assert_eq!(d.category.as_deref(), Some("purchases"));
        assert_eq!(d.confidence, 0.90);
    }

    #[test]
    fn automated_invoice_beats_notification() {
        let d = run("noreply@stadtwerke-nord.example", "Ihre Rechnung Oktober", "{}", "", 0);
        assert_eq!(d.category.as_deref(), Some("purchases"));
        assert_eq!(d.confidence, 0.80);
    }

    #[test]
    fn notification_domain_with_list_headers() {
        let from = format!("notifications@{}", NOTIFICATION_DOMAINS[0]);
        let d = run(&from, "New issue opened", r#"{"list-id":"<x>"}"#, "<mailto:u@x.example>", 0);
        assert_eq!(d.category.as_deref(), Some("notifications"));
    }

    #[test]
    fn social_domain_wins() {
        let from = format!("messages@{}", SOCIAL_DOMAINS[0]);
        let d = run(&from, "3 neue Kontaktanfragen", "{}", "<mailto:u@x.example>", 0);
        assert_eq!(d.category.as_deref(), Some("social"));
        assert_eq!(d.confidence, 0.90);
    }

    #[test]
    fn subdomain_matches_listed_domain() {
        let from = format!("messages@mail.{}", SOCIAL_DOMAINS[0]);
        let d = run(&from, "Neue Nachricht", "{}", "", 0);
        assert_eq!(d.category.as_deref(), Some("social"));
    }

    #[test]
    fn auto_submitted_no_stays_personal() {
        let d = run("anna.weber@studio-halde.example", "Rückfrage", r#"{"auto-submitted":"no"}"#, "", 0);
        assert_eq!(d.category.as_deref(), Some("important"));
    }

    #[test]
    fn bulk_correspondent_is_not_important() {
        let d = run("team@studio-halde.example", "Studio-News November", "{}", "<mailto:u@studio-halde.example>", 3);
        assert_eq!(d.category.as_deref(), Some("newsletters"));
    }

    #[test]
    fn empty_or_broken_sender() {
        for from in ["", "anna", "@", "anna@"] {
            let d = run(from, "Hallo", "{}", "", 5);
            assert_eq!(d.category, None, "{from}");
            assert_eq!(codes(&d), ["low_confidence"], "{from}");
        }
    }

    #[test]
    fn keyword_needs_word_boundary() {
        let d = run("news@wetterpost.example", "Ideales Wetter am Wochenende", "{}", "<mailto:u@wetterpost.example>", 0);
        assert_eq!(d.category.as_deref(), Some("newsletters"));
    }

    #[test]
    fn symbol_keyword_matches_after_digits() {
        let d = run("angebote@modehaus-lind.example", "Heute 30% off", "{}", "<mailto:u@modehaus-lind.example>", 0);
        assert_eq!(d.category.as_deref(), Some("promotions"));
        assert_eq!(param(&d, "promo_keyword", "keyword"), "% off");
    }

    #[test]
    fn gmail_promotions_label() {
        let d = run("shop@modehaus-lind.example", "Neue Kollektion", r#"{"x-gmail-category":"promotions"}"#, "", 0);
        assert_eq!(d.category.as_deref(), Some("promotions"));
        assert_eq!(d.confidence, 0.85);
    }
}
