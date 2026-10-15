//! Online-meeting links in event text, for the reminder's "Join" button.

const MEETING_HOSTS: &[&str] = &["teams.microsoft.com", "teams.live.com", "zoom.us", "meet.google.com", "webex.com", "whereby.com", "meet.jit.si"];

pub fn find_meeting_link(texts: &[&str]) -> Option<String> {
    for text in texts {
        for token in text.split(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '(' | ')' | ',')) {
            let url = token.trim_end_matches(['.', ';', ']']);
            let Some(rest) = url.strip_prefix("https://") else { continue };
            let host = rest.split(['/', '?', '#']).next().unwrap_or("").to_ascii_lowercase();
            if MEETING_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{}", h))) {
                return Some(url.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_known_meeting_hosts() {
        assert_eq!(
            find_meeting_link(&["", "Join: https://teams.microsoft.com/l/meetup-join/19%3a123 now"]).as_deref(),
            Some("https://teams.microsoft.com/l/meetup-join/19%3a123")
        );
        assert_eq!(find_meeting_link(&["https://us02web.zoom.us/j/8812345?pwd=x."]).as_deref(), Some("https://us02web.zoom.us/j/8812345?pwd=x"));
        assert_eq!(find_meeting_link(&["<https://meet.google.com/abc-defg-hij>"]).as_deref(), Some("https://meet.google.com/abc-defg-hij"));
    }

    #[test]
    fn ignores_other_links_and_plain_http() {
        assert_eq!(find_meeting_link(&["https://example.com/zoom.us"]), None);
        assert_eq!(find_meeting_link(&["http://meet.google.com/abc"]), None);
        assert_eq!(find_meeting_link(&["https://notzoom.us/j/1"]), None);
    }
}
