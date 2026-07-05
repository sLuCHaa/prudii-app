/// Rule-based mail classification using header heuristics.
/// No AI/Ollama dependency — instant, deterministic, works on any hardware.

const NOTIFICATION_FROM: &[&str] = &[
    "noreply@", "no-reply@", "notifications@", "notification@",
    "alert@", "alerts@", "mailer-daemon@", "postmaster@",
    "donotreply@", "do-not-reply@", "bounce@", "automated@",
    "system@", "notify@",
];

const NOTIFICATION_DOMAINS: &[&str] = &[
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

const SOCIAL_DOMAINS: &[&str] = &[
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

const TRANSACTIONAL_DOMAINS: &[&str] = &[
    "paypal.com", "stripe.com",
    "amazon.com", "amazon.de", "amazon.co.uk",
    "ebay.com", "etsy.com",
    "ups.com", "fedex.com", "dhl.com", "usps.com",
    "shopify.com",
    "apple.com",
    "google.com", // for Google Pay receipts etc.
    "uber.com", "lyft.com",
    "airbnb.com", "booking.com",
    "doordash.com", "grubhub.com",
];

const TRANSACTIONAL_KEYWORDS: &[&str] = &[
    "order confirmation", "order confirmed", "your order",
    "invoice", "receipt", "payment",
    "shipping", "shipped", "delivery", "delivered", "tracking",
    "rechnung", "bestellung", "versand", "lieferung", // German
    "facture", "commande", "livraison", // French
    "factura", "pedido", "envío", // Spanish
];

const PROMOTION_KEYWORDS: &[&str] = &[
    "% off", "sale", "deal", "offer", "discount",
    "coupon", "promo", "limited time", "flash sale",
    "free shipping", "buy now", "shop now",
    "exclusive", "clearance", "save up to",
    "rabatt", "angebot", "aktion", // German
    "soldes", "réduction", "offre", // French
    "descuento", "oferta", "rebajas", // Spanish
];

/// Classify a mail into zero or more labels based on header heuristics.
/// Returns a JSON array string like `["newsletter","notification"]`.
pub fn classify_mail(
    from_email: &str,
    subject: &str,
    list_unsubscribe: &str,
    gmail_labels: &str,
) -> String {
    let from_lower = from_email.to_lowercase();
    let subject_lower = subject.to_lowercase();
    let has_unsubscribe = !list_unsubscribe.is_empty();
    let mut labels: Vec<&str> = Vec::new();

    let from_domain = from_lower.split('@').nth(1).unwrap_or("");

    // 1. Social (check first — social notifications should be "social" not "notification")
    if SOCIAL_DOMAINS.iter().any(|d| from_domain == *d || from_domain.ends_with(&format!(".{}", d))) {
        labels.push("social");
    } else if gmail_labels.contains("CATEGORY_SOCIAL") {
        labels.push("social");
    }

    // 2. Notification
    if !labels.contains(&"social") {
        let is_notification_sender = NOTIFICATION_FROM.iter().any(|p| from_lower.starts_with(p) || from_lower.contains(p));
        let is_notification_domain = NOTIFICATION_DOMAINS.iter().any(|d| from_domain == *d || from_domain.ends_with(&format!(".{}", d)));

        if is_notification_sender || is_notification_domain {
            labels.push("notification");
        }
    }

    // 3. Newsletter (has List-Unsubscribe AND not already classified as notification/social)
    if has_unsubscribe && !labels.contains(&"notification") && !labels.contains(&"social") {
        // Additional check: not a transactional email with unsubscribe
        let is_transactional = TRANSACTIONAL_DOMAINS.iter().any(|d| from_domain == *d || from_domain.ends_with(&format!(".{}", d)))
            || TRANSACTIONAL_KEYWORDS.iter().any(|k| subject_lower.contains(k));

        if !is_transactional {
            labels.push("newsletter");
        }
    }

    // 4. Promotion
    if gmail_labels.contains("CATEGORY_PROMOTIONS") {
        if !labels.contains(&"newsletter") {
            labels.push("promotion");
        }
    } else if has_unsubscribe && PROMOTION_KEYWORDS.iter().any(|k| subject_lower.contains(k)) {
        if !labels.contains(&"newsletter") {
            labels.push("promotion");
        }
    }

    // 5. Transactional
    let is_transactional_domain = TRANSACTIONAL_DOMAINS.iter().any(|d| from_domain == *d || from_domain.ends_with(&format!(".{}", d)));
    let is_transactional_subject = TRANSACTIONAL_KEYWORDS.iter().any(|k| subject_lower.contains(k));

    if is_transactional_domain && is_transactional_subject {
        labels.push("transactional");
    }

    if labels.is_empty() {
        String::new()
    } else {
        serde_json::to_string(&labels).unwrap_or_default()
    }
}

/// Classify all unclassified mails in the database.
/// Returns the number of mails that were classified.
pub fn classify_unclassified(conn: &rusqlite::Connection) -> i32 {
    let mut stmt = match conn.prepare(
        "SELECT id, from_email, subject, COALESCE(list_unsubscribe, ''), COALESCE(labels, '')
         FROM mails WHERE auto_labels = '' OR auto_labels IS NULL
         LIMIT 1000"
    ) {
        Ok(s) => s,
        Err(_) => return 0,
    };

    let rows: Vec<(String, String, String, String, String)> = match stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        }) {
            Ok(mapped) => mapped.filter_map(|r| r.ok()).collect(),
            Err(e) => {
                log::error!("classify_unclassified query failed: {}", e);
                return 0;
            }
        };

    let mut count = 0;
    let tx = conn.unchecked_transaction();
    for (id, from_email, subject, list_unsubscribe, gmail_labels) in &rows {
        let labels = classify_mail(from_email, subject, list_unsubscribe, gmail_labels);
        // Always update — set to classified labels or empty string to mark as processed
        let label_value = if labels.is_empty() { "[]" } else { &labels };
        let _ = conn.execute(
            "UPDATE mails SET auto_labels = ?1 WHERE id = ?2",
            rusqlite::params![label_value, id],
        );
        if !labels.is_empty() {
            count += 1;
        }
    }
    if let Ok(tx) = tx { let _ = tx.commit(); }

    count
}
