/// Truncate text to approximately max_chars characters at a word boundary
fn truncate(text: &str, max_chars: usize) -> &str {
    if text.len() <= max_chars {
        return text;
    }
    // Find a safe byte boundary at or before max_chars
    let safe_end = text.char_indices()
        .map(|(i, _)| i)
        .take_while(|&i| i <= max_chars)
        .last()
        .unwrap_or(0);
    match text[..safe_end].rfind(' ') {
        Some(pos) => &text[..pos],
        None => &text[..safe_end],
    }
}

/// Build a prompt for summarizing a single email
pub fn summarize_mail(subject: &str, body_text: &str) -> String {
    let body = truncate(body_text, 4000);
    format!(
        "You are a helpful email assistant. Summarize the following email in 2-3 concise sentences. \
         Focus on the key points, any action items, and important details. \
         IMPORTANT: Always respond in the same language as the email.\n\n\
         Subject: {}\n\n\
         Body:\n{}\n\n\
         Summary:",
        subject, body
    )
}

/// Build a prompt for summarizing an email thread
pub fn summarize_thread(thread_texts: &[(String, String)]) -> String {
    let mut combined = String::new();
    let mut total_len = 0;
    for (sender, body) in thread_texts {
        if total_len > 4000 {
            break;
        }
        let entry = format!("From: {}\n{}\n---\n", sender, truncate(body, 1000));
        total_len += entry.len();
        combined.push_str(&entry);
    }

    format!(
        "You are a helpful email assistant. Summarize the following email thread in 3-5 concise sentences. \
         Highlight key points, decisions made, and any action items. \
         IMPORTANT: Always respond in the same language as the emails.\n\n\
         Thread:\n{}\n\
         Summary:",
        combined
    )
}

fn lang_instruction(language: &str) -> &'static str {
    match language {
        "de" => "Write all replies in German.",
        "es" => "Write all replies in Spanish.",
        "fr" => "Write all replies in French.",
        "pt" => "Write all replies in Portuguese.",
        "zh" => "Write all replies in Chinese.",
        "ru" => "Write all replies in Russian.",
        "en" => "Write all replies in English.",
        _ => "Write all replies in the same language as the email.",
    }
}

/// Build a prompt for suggesting 3 reply tones
pub fn suggest_replies(subject: &str, body_text: &str, language: &str) -> String {
    let body = truncate(body_text, 4000);

    format!(
        "You are a helpful email assistant. Based on the email below, generate exactly 3 reply suggestions \
         with different tones. {}\n\n\
         Return ONLY a valid JSON array with exactly 3 objects. Each object must have:\n\
         - \"tone\": one of \"professional\", \"friendly\", \"concise\"\n\
         - \"text\": the reply text (plain text, no HTML, no greeting/signature)\n\n\
         Subject: {}\n\n\
         Body:\n{}\n\n\
         JSON:",
        lang_instruction(language), subject, body
    )
}

/// Build a prompt for parsing a natural language attachment search query into structured search parameters
pub fn parse_attachment_query(query: &str) -> String {
    format!(
        "You are an email attachment search assistant. Parse the user's natural language query into structured search parameters.\n\n\
         Return ONLY a valid JSON object with these fields:\n\
         - \"keywords\": search terms for mail subject/body FTS (string, can be empty)\n\
         - \"file_extensions\": array of file extensions to filter by (e.g. [\"pdf\", \"xlsx\"]), empty array for all\n\
         - \"exclude_extensions\": array of extensions to exclude, empty array for none\n\n\
         Examples:\n\
         - \"all invoice PDFs\" -> {{\"keywords\": \"invoice\", \"file_extensions\": [\"pdf\"], \"exclude_extensions\": []}}\n\
         - \"photos from last month\" -> {{\"keywords\": \"\", \"file_extensions\": [\"png\",\"jpg\",\"jpeg\",\"gif\",\"webp\"], \"exclude_extensions\": []}}\n\
         - \"spreadsheets about budget\" -> {{\"keywords\": \"budget\", \"file_extensions\": [\"xlsx\",\"xls\",\"csv\"], \"exclude_extensions\": []}}\n\
         - \"documents without images\" -> {{\"keywords\": \"\", \"file_extensions\": [\"doc\",\"docx\",\"pdf\",\"txt\"], \"exclude_extensions\": [\"png\",\"jpg\",\"jpeg\",\"gif\"]}}\n\n\
         User query: {}\n\
         JSON:",
        query
    )
}

/// Build a prompt for suggesting 3 reply tones based on a full thread
pub fn suggest_thread_replies(subject: &str, thread_texts: &[(String, String)], language: &str) -> String {
    let mut combined = String::new();
    let mut total_len = 0;
    for (sender, body) in thread_texts {
        if total_len > 4000 {
            break;
        }
        let entry = format!("From: {}\n{}\n---\n", sender, truncate(body, 1000));
        total_len += entry.len();
        combined.push_str(&entry);
    }

    format!(
        "You are a helpful email assistant. Based on the email conversation below, generate exactly 3 reply suggestions \
         with different tones. Consider the full conversation context when crafting replies. {}\n\n\
         Return ONLY a valid JSON array with exactly 3 objects. Each object must have:\n\
         - \"tone\": one of \"professional\", \"friendly\", \"concise\"\n\
         - \"text\": the reply text (plain text, no HTML, no greeting/signature)\n\n\
         Subject: {}\n\n\
         Conversation:\n{}\n\
         JSON:",
        lang_instruction(language), subject, combined
    )
}
