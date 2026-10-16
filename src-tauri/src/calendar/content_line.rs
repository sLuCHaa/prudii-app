//! Minimal RFC 5545 reader/writer: content lines, nested components with their
//! raw text, TEXT escaping and line folding.

#[derive(Debug, Clone, PartialEq)]
pub struct Prop {
    pub name: String,
    pub params: Vec<(String, String)>,
    pub value: String,
}

impl Prop {
    pub fn param(&self, key: &str) -> Option<&str> {
        self.params.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Component {
    pub name: String,
    pub props: Vec<Prop>,
    pub children: Vec<Component>,
    /// Unfolded lines from BEGIN to END, CRLF-joined.
    pub raw: String,
}

impl Component {
    pub fn prop(&self, name: &str) -> Option<&Prop> {
        self.props.iter().find(|p| p.name == name)
    }

    pub fn props_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Prop> + 'a {
        self.props.iter().filter(move |p| p.name == name)
    }

    pub fn text(&self, name: &str) -> Option<String> {
        self.prop(name).map(|p| unescape_text(&p.value))
    }
}

pub fn unfold(input: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in input.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some(last) = lines.last_mut() {
                last.push_str(&line[1..]);
                continue;
            }
        }
        if !line.is_empty() {
            lines.push(line.to_string());
        }
    }
    lines
}

fn split_unquoted(s: &str, sep: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut in_quotes = false;
    let mut start = 0;
    for (i, c) in s.char_indices() {
        if c == '"' {
            in_quotes = !in_quotes;
        } else if c == sep && !in_quotes {
            parts.push(&s[start..i]);
            start = i + c.len_utf8();
        }
    }
    parts.push(&s[start..]);
    parts
}

pub fn parse_line(line: &str) -> Option<Prop> {
    let mut in_quotes = false;
    let mut colon = None;
    for (i, c) in line.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            ':' if !in_quotes => {
                colon = Some(i);
                break;
            }
            _ => {}
        }
    }
    let idx = colon?;
    let mut head = split_unquoted(&line[..idx], ';').into_iter();
    let name = head.next()?.trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let params = head
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            Some((k.trim().to_ascii_uppercase(), v.trim().trim_matches('"').to_string()))
        })
        .collect();
    Some(Prop { name, params, value: line[idx + 1..].to_string() })
}

pub fn parse_components(input: &str) -> Vec<Component> {
    let mut roots = Vec::new();
    let mut stack: Vec<(Component, Vec<String>)> = Vec::new();
    for line in unfold(input) {
        let Some(prop) = parse_line(&line) else { continue };
        for (_, raw) in stack.iter_mut() {
            raw.push(line.clone());
        }
        match prop.name.as_str() {
            "BEGIN" => {
                let comp = Component { name: prop.value.trim().to_ascii_uppercase(), ..Default::default() };
                stack.push((comp, vec![line.clone()]));
            }
            "END" => {
                if let Some((mut comp, raw)) = stack.pop() {
                    comp.raw = raw.join("\r\n");
                    match stack.last_mut() {
                        Some((parent, _)) => parent.children.push(comp),
                        None => roots.push(comp),
                    }
                }
            }
            _ => {
                if let Some((comp, _)) = stack.last_mut() {
                    comp.props.push(prop);
                }
            }
        }
    }
    roots
}

pub fn unescape_text(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') | Some('N') => out.push('\n'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

pub fn escape_text(v: &str) -> String {
    v.replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace("\r\n", "\\n")
        .replace('\n', "\\n")
}

/// One serialized content line, folded at 75 octets without splitting a character.
pub fn fold_line(line: &str) -> String {
    let mut out = String::with_capacity(line.len() + 8);
    let mut octets = 0;
    for c in line.chars() {
        let len = c.len_utf8();
        if octets + len > 75 {
            out.push_str("\r\n ");
            octets = 1;
        }
        out.push(c);
        octets += len;
    }
    out.push_str("\r\n");
    out
}

pub fn write_prop(name: &str, params: &[(&str, &str)], value: &str) -> String {
    let mut line = name.to_string();
    for (k, v) in params {
        line.push(';');
        line.push_str(k);
        line.push('=');
        if v.contains([':', ';', ',']) {
            line.push('"');
            line.push_str(v);
            line.push('"');
        } else {
            line.push_str(v);
        }
    }
    line.push(':');
    line.push_str(value);
    fold_line(&line)
}

/// RFC 5545 DURATION in seconds, e.g. "-PT15M" → -900. Lengths beyond a century
/// only come from broken or hostile files.
pub fn parse_duration(s: &str) -> Option<i64> {
    const MAX_SECONDS: i64 = 100 * 366 * 86_400;
    let s = s.trim();
    let (sign, rest) = match s.as_bytes().first()? {
        b'-' => (-1, &s[1..]),
        b'+' => (1, &s[1..]),
        _ => (1, s),
    };
    let rest = rest.strip_prefix('P')?;
    let mut total = 0i64;
    let mut num = String::new();
    let mut in_time = false;
    for c in rest.chars() {
        match c {
            'T' => in_time = true,
            '0'..='9' => num.push(c),
            'W' | 'D' | 'H' | 'M' | 'S' => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                let unit = match (c, in_time) {
                    ('W', false) => 604_800,
                    ('D', false) => 86_400,
                    ('H', true) => 3_600,
                    ('M', true) => 60,
                    ('S', true) => 1,
                    _ => return None,
                };
                total = total.checked_add(n.checked_mul(unit)?)?;
            }
            _ => return None,
        }
    }
    if !num.is_empty() || total > MAX_SECONDS {
        return None;
    }
    Some(sign * total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unfolds_continuation_lines_and_crlf() {
        let lines = unfold("SUMMARY:Hello\r\n  world\r\nDESCRIPTION:a\r\n\tb\r\n\r\n");
        assert_eq!(lines, vec!["SUMMARY:Hello world".to_string(), "DESCRIPTION:ab".to_string()]);
    }

    #[test]
    fn parses_quoted_params_with_colons_and_commas() {
        let p = parse_line("ATTENDEE;CN=\"Doe, Jane: CEO\";ROLE=REQ-PARTICIPANT;rsvp=TRUE:mailto:jane@example.com").unwrap();
        assert_eq!(p.name, "ATTENDEE");
        assert_eq!(p.param("CN"), Some("Doe, Jane: CEO"));
        assert_eq!(p.param("rsvp"), Some("TRUE"));
        assert_eq!(p.value, "mailto:jane@example.com");
        assert!(parse_line("no colon here").is_none());
    }

    #[test]
    fn builds_nested_components_with_raw_text() {
        let input = "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:1\nBEGIN:VALARM\nTRIGGER:-PT5M\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR\n";
        let roots = parse_components(input);
        assert_eq!(roots.len(), 1);
        let cal = &roots[0];
        assert_eq!(cal.name, "VCALENDAR");
        assert_eq!(cal.prop("VERSION").unwrap().value, "2.0");
        let event = &cal.children[0];
        assert_eq!(event.name, "VEVENT");
        assert_eq!(event.children[0].name, "VALARM");
        assert!(event.raw.starts_with("BEGIN:VEVENT\r\nUID:1"));
        assert!(event.raw.ends_with("END:VALARM\r\nEND:VEVENT"));
    }

    #[test]
    fn text_escaping_round_trips() {
        let original = "Line one, with; punctuation\\\nLine two";
        let escaped = escape_text(original);
        assert_eq!(escaped, "Line one\\, with\\; punctuation\\\\\\nLine two");
        assert_eq!(unescape_text(&escaped), original);
        assert_eq!(unescape_text("a\\Nb"), "a\nb");
    }

    #[test]
    fn folds_at_75_octets_without_splitting_characters() {
        let long = format!("SUMMARY:{}", "ä".repeat(60));
        let folded = fold_line(&long);
        for physical in folded.trim_end_matches("\r\n").split("\r\n") {
            assert!(physical.len() <= 75, "line too long: {}", physical.len());
        }
        assert_eq!(unfold(&folded), vec![long]);
    }

    #[test]
    fn writes_props_quoting_special_param_values() {
        assert_eq!(
            write_prop("ATTENDEE", &[("CN", "Doe, Jane"), ("RSVP", "TRUE")], "mailto:j@example.com"),
            "ATTENDEE;CN=\"Doe, Jane\";RSVP=TRUE:mailto:j@example.com\r\n"
        );
    }

    #[test]
    fn parses_durations() {
        assert_eq!(parse_duration("PT15M"), Some(900));
        assert_eq!(parse_duration("-PT15M"), Some(-900));
        assert_eq!(parse_duration("-P0DT0H10M0S"), Some(-600));
        assert_eq!(parse_duration("P1W"), Some(604_800));
        assert_eq!(parse_duration("P1DT2H"), Some(93_600));
        assert_eq!(parse_duration("PT1D"), None);
        assert_eq!(parse_duration("15M"), None);
    }

    #[test]
    fn durations_reject_overflow_and_absurd_lengths() {
        assert_eq!(parse_duration("P9223372036854775807W"), None);
        assert_eq!(parse_duration("PT9223372036854775807S"), None);
        assert_eq!(parse_duration("P40000D"), None);
        assert_eq!(parse_duration("P36000D"), Some(36_000 * 86_400));
        assert_eq!(parse_duration("-PT15M"), Some(-900));
    }
}
