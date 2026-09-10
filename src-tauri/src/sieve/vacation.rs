//! Reads and rewrites the vacation notice inside a user's Sieve script.
//!
//! Prudii owns exactly one region of the script — the block between the
//! marker comments — and touches nothing else except the `require` line.
//! A notice written by webmail in a recognisable shape is taken over; any
//! shape it does not fully understand leaves the script untouched and the
//! notice `locked` for the user.

use super::client::quote;
use super::script::{parse_commands, tokenize, Arg, Command, Test, Tok, Token};
use serde::{Deserialize, Serialize};

pub const MARK_START: &str = "# prudii:vacation:start";
pub const MARK_END: &str = "# prudii:vacation:end";
/// Roundcube lists rules by this comment; without it the block would not
/// show up in the webmail filter list.
pub const RULE_COMMENT: &str = "# rule:[Abwesenheit (Prudii)]";
/// Dovecot's default: one reply per sender address within this many days.
const REPLY_DAYS: u32 = 7;
const BACKUP_NAME: &str = "prudii-backup";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VacationSettings {
    pub enabled: bool,
    pub from: Option<String>,
    pub until: Option<String>,
    pub subject: Option<String>,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VacationSource {
    Prudii,
    Foreign,
    None,
    Locked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VacationState {
    pub enabled: bool,
    pub from: Option<String>,
    pub until: Option<String>,
    pub subject: Option<String>,
    pub text: String,
    pub source: VacationSource,
    pub had_addresses: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeRefused {
    pub reason: String,
}

pub fn backup_script_name() -> &'static str {
    BACKUP_NAME
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    if !b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) {
        return false;
    }
    let month: u32 = s[5..7].parse().unwrap_or(0);
    let day: u32 = s[8..10].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

pub fn validate(s: &VacationSettings) -> Result<(), String> {
    if s.enabled && s.text.trim().is_empty() {
        return Err("text required".into());
    }
    for d in [&s.from, &s.until].into_iter().flatten() {
        if !is_date(d) {
            return Err(format!("invalid date: {}", d));
        }
    }
    if let (Some(from), Some(until)) = (&s.from, &s.until) {
        if from > until {
            return Err("from is after until".into());
        }
    }
    Ok(())
}

fn detect_nl(script: &str) -> &'static str {
    if script.contains("\r\n") {
        "\r\n"
    } else if script.contains('\n') {
        "\n"
    } else {
        "\r\n"
    }
}

fn vacation_call(s: &VacationSettings, nl: &str) -> String {
    let mut call = format!("vacation :days {}", REPLY_DAYS);
    if let Some(subject) = s.subject.as_deref().map(str::trim).filter(|x| !x.is_empty()) {
        call.push_str(" :subject ");
        call.push_str(&quote(&subject.replace(['\r', '\n'], " ")));
    }
    call.push_str(" text:");
    call.push_str(nl);
    let text = s.text.replace("\r\n", "\n");
    for line in text.trim_end_matches('\n').split('\n') {
        if line.starts_with('.') {
            call.push('.');
        }
        call.push_str(line);
        call.push_str(nl);
    }
    call.push('.');
    call.push_str(nl);
    call.push(';');
    call
}

pub fn render_block(s: &VacationSettings, nl: &str) -> String {
    let mut tests = Vec::new();
    if let Some(from) = &s.from {
        tests.push(format!("currentdate :value \"ge\" \"date\" {}", quote(from)));
    }
    if let Some(until) = &s.until {
        tests.push(format!("currentdate :value \"le\" \"date\" {}", quote(until)));
    }
    let call = vacation_call(s, nl);
    let mut out = format!("{}{}{}{}", MARK_START, nl, RULE_COMMENT, nl);
    if tests.is_empty() {
        out.push_str(&call);
        out.push_str(nl);
    } else {
        let cond = if tests.len() == 1 { tests.remove(0) } else { format!("allof ({})", tests.join(", ")) };
        out.push_str(&format!("if {}{}{{{}\t{}{}}}{}", cond, nl, nl, call, nl, nl));
    }
    out.push_str(MARK_END);
    out.push_str(nl);
    out
}

/// Byte span of the Prudii block: from the start marker's line to just past
/// the end marker's line ending.
fn find_block(script: &str) -> Option<(usize, usize)> {
    let mut offset = 0;
    let mut start = None;
    for line in script.split_inclusive('\n') {
        let content = line.trim_end_matches(['\r', '\n']);
        if start.is_none() && content == MARK_START {
            start = Some(offset);
        } else if start.is_some() && content == MARK_END {
            return Some((start.unwrap(), offset + line.len()));
        }
        offset += line.len();
    }
    None
}

fn has_ident(tokens: &[Token], name: &str) -> bool {
    tokens.iter().any(|t| matches!(&t.tok, Tok::Ident(n) if n == name))
}

fn has_tag(tokens: &[Token], names: &[&str]) -> bool {
    tokens.iter().any(|t| matches!(&t.tok, Tok::Tag(n) if names.contains(&n.as_str())))
}

fn contains_vacation(cmd: &Command) -> bool {
    cmd.name == "vacation" || cmd.block.iter().flatten().any(contains_vacation)
}

struct Notice {
    settings: VacationSettings,
    had_addresses: bool,
}

fn parse_vacation_args(args: &[Arg]) -> Result<Notice, String> {
    let mut subject = None;
    let mut text = None;
    let mut had_addresses = false;
    let mut i = 0;
    while i < args.len() {
        match &args[i] {
            Arg::Tag(t) => match t.as_str() {
                "days" | "seconds" | "from" | "handle" => i += 1,
                "subject" => {
                    if let Some(Arg::Str(s)) = args.get(i + 1) {
                        subject = Some(s.clone());
                    }
                    i += 1;
                }
                "addresses" => {
                    had_addresses = true;
                    i += 1;
                }
                "mime" => {}
                other => return Err(format!("unsupported vacation argument :{}", other)),
            },
            Arg::Str(s) => text = Some(s.clone()),
            Arg::List(_) | Arg::Num(_) => return Err("unexpected vacation argument".into()),
        }
        i += 1;
    }
    let text = text.ok_or_else(|| "vacation without text".to_string())?;
    Ok(Notice {
        settings: VacationSettings { enabled: true, from: None, until: None, subject, text },
        had_addresses,
    })
}

fn date_of(format: &str, value: &str) -> Result<String, String> {
    let date = match format {
        "date" => value.to_string(),
        "iso8601" => value.chars().take(10).collect(),
        other => return Err(format!("unsupported date format {}", other)),
    };
    if is_date(&date) {
        Ok(date)
    } else {
        Err(format!("unsupported date value {}", value))
    }
}

/// Only `currentdate` comparisons against a day, optionally inside one
/// `allof` — the shapes Prudii itself and Roundcube write.
fn dates_of(tests: &[Test]) -> Result<(Option<String>, Option<String>), String> {
    let leaves: &[Test] = match tests {
        [single] if single.name == "allof" => &single.sub,
        [single] => std::slice::from_ref(single),
        _ => return Err("unsupported test list".into()),
    };
    let mut from = None;
    let mut until = None;
    for test in leaves {
        if test.name != "currentdate" || !test.sub.is_empty() {
            return Err(format!("unsupported test {}", test.name));
        }
        let mut args = test.args.iter().peekable();
        let mut compare = None;
        while let Some(arg) = args.next() {
            match arg {
                Arg::Tag(t) if t == "zone" => {
                    args.next();
                }
                Arg::Tag(t) if t == "originalzone" => {}
                Arg::Tag(t) if t == "value" => {
                    let (Some(Arg::Str(op)), Some(Arg::Str(format)), Some(Arg::Str(value))) = (args.next(), args.next(), args.next()) else {
                        return Err("malformed currentdate test".into());
                    };
                    compare = Some((op.clone(), date_of(format, value)?));
                }
                _ => return Err("unsupported currentdate argument".into()),
            }
        }
        match compare {
            Some((op, date)) if op == "ge" && from.is_none() => from = Some(date),
            Some((op, date)) if op == "le" && until.is_none() => until = Some(date),
            _ => return Err("unsupported date comparison".into()),
        }
    }
    Ok((from, until))
}

/// `Ok(None)`: the command has nothing to do with vacation. `Err`: it does,
/// but not in a shape Prudii can take over.
fn candidate(cmd: &Command) -> Result<Option<Notice>, String> {
    match cmd.name.as_str() {
        "vacation" => parse_vacation_args(&cmd.args).map(Some),
        "if" if contains_vacation(cmd) => {
            let block = cmd.block.as_deref().unwrap_or_default();
            let [only] = block else {
                return Err("vacation rule with other actions".into());
            };
            if only.name != "vacation" {
                return Err("vacation nested too deep".into());
            }
            let (from, until) = dates_of(&cmd.tests)?;
            let mut notice = parse_vacation_args(&only.args)?;
            notice.settings.from = from;
            notice.settings.until = until;
            Ok(Some(notice))
        }
        _ if contains_vacation(cmd) => Err(format!("vacation inside {}", cmd.name)),
        _ => Ok(None),
    }
}

/// Grows a command span to whole lines, pulling in a preceding Roundcube
/// `# rule:[...]` comment and the trailing line ending.
fn widen_span(script: &str, start: usize, end: usize) -> (usize, usize) {
    let line_start = script[..start].rfind('\n').map(|p| p + 1).unwrap_or(0);
    let mut s = start;
    if script[line_start..start].trim().is_empty() {
        s = line_start;
        if line_start > 0 {
            let prev_start = script[..line_start - 1].rfind('\n').map(|p| p + 1).unwrap_or(0);
            if script[prev_start..line_start].trim_end_matches(['\r', '\n']).starts_with("# rule:[") {
                s = prev_start;
            }
        }
    }
    let rest = &script[end..];
    let e = if rest.starts_with("\r\n") {
        end + 2
    } else if rest.starts_with('\n') {
        end + 1
    } else {
        end
    };
    (s, e)
}

fn extract(cmds: &[Command], script: &str) -> Result<Option<((usize, usize), Notice)>, String> {
    let mut found = None;
    for (i, cmd) in cmds.iter().enumerate() {
        let Some(notice) = candidate(cmd)? else { continue };
        if found.is_some() {
            return Err("more than one vacation notice".into());
        }
        if cmds.get(i + 1).is_some_and(|next| next.name == "elsif" || next.name == "else") {
            return Err("vacation rule with else branch".into());
        }
        found = Some((widen_span(script, cmd.start, cmd.end), notice));
    }
    Ok(found)
}

enum Found {
    NoVacation,
    Prudii { span: (usize, usize), notice: Option<Notice> },
    Foreign { span: (usize, usize), notice: Notice },
    Refused(String),
}

fn analyze(script: &str) -> Found {
    if let Some((bs, be)) = find_block(script) {
        let outside = format!("{}{}", &script[..bs], &script[be..]);
        if has_ident(&tokenize(&outside), "vacation") {
            return Found::Refused("a second vacation notice exists outside the Prudii block".into());
        }
        let inner = &script[bs..be];
        let notice = parse_commands(&tokenize(inner))
            .ok()
            .and_then(|cmds| extract(&cmds, inner).ok().flatten())
            .map(|(_, notice)| notice);
        return Found::Prudii { span: (bs, be), notice };
    }
    let tokens = tokenize(script);
    if !has_ident(&tokens, "vacation") {
        return Found::NoVacation;
    }
    let cmds = match parse_commands(&tokens) {
        Ok(c) => c,
        Err(e) => return Found::Refused(e),
    };
    match extract(&cmds, script) {
        Ok(Some((span, notice))) => Found::Foreign { span, notice },
        Ok(None) => Found::Refused("vacation not at top level".into()),
        Err(e) => Found::Refused(e),
    }
}

pub fn read_state(script: &str) -> VacationState {
    let empty = VacationState {
        enabled: false,
        from: None,
        until: None,
        subject: None,
        text: String::new(),
        source: VacationSource::None,
        had_addresses: false,
    };
    let from_notice = |notice: Notice, source: VacationSource| VacationState {
        enabled: true,
        from: notice.settings.from,
        until: notice.settings.until,
        subject: notice.settings.subject,
        text: notice.settings.text,
        source,
        had_addresses: notice.had_addresses,
    };
    match analyze(script) {
        Found::NoVacation => empty,
        Found::Prudii { notice: Some(notice), .. } => from_notice(notice, VacationSource::Prudii),
        Found::Foreign { notice, .. } => from_notice(notice, VacationSource::Foreign),
        Found::Prudii { notice: None, .. } | Found::Refused(_) => VacationState { source: VacationSource::Locked, ..empty },
    }
}

fn require_entries(cmd: &Command) -> Vec<String> {
    cmd.args
        .iter()
        .flat_map(|a| match a {
            Arg::Str(s) => vec![s.clone()],
            Arg::List(l) => l.clone(),
            _ => Vec::new(),
        })
        .collect()
}

/// Folds the leading `require` statements into one list that matches what
/// the script now uses. The only edit Prudii makes outside its own block.
fn rewrite_requires(script: &str, settings: &VacationSettings, nl: &str, block_start: Option<usize>) -> Result<String, MergeRefused> {
    let tokens = tokenize(script);
    let cmds = parse_commands(&tokens).map_err(|reason| MergeRefused { reason })?;
    let leading: Vec<&Command> = cmds.iter().take_while(|c| c.name == "require").collect();

    let mut list: Vec<String> = Vec::new();
    for entry in leading.iter().flat_map(|c| require_entries(c)) {
        if !list.contains(&entry) {
            list.push(entry);
        }
    }
    let used_vacation = has_ident(&tokens, "vacation");
    let used_date = has_ident(&tokens, "currentdate") || has_ident(&tokens, "date");
    let used_relational = has_tag(&tokens, &["value", "count"]);
    list.retain(|e| match e.as_str() {
        "vacation" => used_vacation,
        "date" => used_date,
        "relational" => used_relational,
        _ => true,
    });
    if settings.enabled {
        let mut needed = vec!["vacation"];
        if settings.from.is_some() || settings.until.is_some() {
            needed.extend(["date", "relational"]);
        }
        for ext in needed {
            if !list.iter().any(|e| e == ext) {
                list.push(ext.to_string());
            }
        }
    }

    let line = if list.is_empty() {
        String::new()
    } else {
        format!("require [{}];{}", list.iter().map(|e| quote(e)).collect::<Vec<_>>().join(","), nl)
    };

    let mut out = String::with_capacity(script.len() + line.len());
    match (leading.first(), leading.last()) {
        (Some(first), Some(last)) => {
            let (_, end) = widen_span(script, last.end, last.end);
            out.push_str(&script[..first.start]);
            out.push_str(&line);
            out.push_str(&script[end..]);
        }
        _ => {
            if line.is_empty() {
                return Ok(script.to_string());
            }
            let first_token_line = tokens
                .first()
                .map(|t| script[..t.start].rfind('\n').map(|p| p + 1).unwrap_or(0));
            let at = match (first_token_line, block_start) {
                (Some(a), Some(b)) => a.min(b),
                (Some(a), None) => a,
                (None, Some(b)) => b,
                (None, None) => script.len(),
            };
            out.push_str(&script[..at]);
            if at == script.len() && !script.is_empty() && !script.ends_with('\n') {
                out.push_str(nl);
            }
            out.push_str(&line);
            out.push_str(&script[at..]);
        }
    }
    Ok(out)
}

pub fn merge(script: &str, settings: &VacationSettings) -> Result<String, MergeRefused> {
    let nl = detect_nl(script);
    let block = if settings.enabled { render_block(settings, nl) } else { String::new() };
    let (spliced, block_start) = match analyze(script) {
        Found::Refused(reason) => return Err(MergeRefused { reason }),
        Found::Prudii { span, .. } | Found::Foreign { span, .. } => {
            let out = format!("{}{}{}", &script[..span.0], block, &script[span.1..]);
            (out, settings.enabled.then_some(span.0))
        }
        Found::NoVacation => {
            if !settings.enabled {
                return Ok(script.to_string());
            }
            let mut out = script.to_string();
            if !out.is_empty() && !out.ends_with('\n') {
                out.push_str(nl);
            }
            let start = out.len();
            out.push_str(&block);
            (out, Some(start))
        }
    };
    rewrite_requires(&spliced, settings, nl, block_start)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = "require [\"fileinto\"];\r\n# rule:[Test]\r\nif allof (header :contains \"subject\" \"test\")\r\n{\r\n\tfileinto \"INBOX\";\r\n}\r\n";
    const EMPTY: &str = "/* empty script */\r\n";

    fn on(text: &str) -> VacationSettings {
        VacationSettings { enabled: true, from: None, until: None, subject: None, text: text.into() }
    }

    fn off() -> VacationSettings {
        VacationSettings { enabled: false, from: None, until: None, subject: None, text: String::new() }
    }

    fn dated(text: &str) -> VacationSettings {
        VacationSettings { enabled: true, from: Some("2026-09-15".into()), until: Some("2026-09-26".into()), subject: Some("Abwesend".into()), text: text.into() }
    }

    #[test]
    fn block_without_period_or_subject() {
        assert_eq!(
            render_block(&on("Hallo"), "\r\n"),
            "# prudii:vacation:start\r\n# rule:[Abwesenheit (Prudii)]\r\nvacation :days 7 text:\r\nHallo\r\n.\r\n;\r\n# prudii:vacation:end\r\n"
        );
    }

    #[test]
    fn block_with_period_subject_and_dot_stuffing() {
        let mut s = dated("Zeile 1\n.");
        s.subject = Some("A \"b\" \\c".into());
        assert_eq!(
            render_block(&s, "\r\n"),
            "# prudii:vacation:start\r\n# rule:[Abwesenheit (Prudii)]\r\nif allof (currentdate :value \"ge\" \"date\" \"2026-09-15\", currentdate :value \"le\" \"date\" \"2026-09-26\")\r\n{\r\n\tvacation :days 7 :subject \"A \\\"b\\\" \\\\c\" text:\r\nZeile 1\r\n..\r\n.\r\n;\r\n}\r\n# prudii:vacation:end\r\n"
        );
    }

    #[test]
    fn block_with_only_a_start_date_has_no_allof() {
        let mut s = on("x");
        s.from = Some("2026-09-15".into());
        let block = render_block(&s, "\n");
        assert!(block.contains("\nif currentdate :value \"ge\" \"date\" \"2026-09-15\"\n{\n"));
        assert!(!block.contains("allof"));
    }

    #[test]
    fn validate_rejects_bad_input() {
        assert!(validate(&on("  ")).is_err());
        let mut s = on("x");
        s.from = Some("2026-9-1".into());
        assert!(validate(&s).is_err());
        let mut s = dated("x");
        s.until = Some("2026-09-01".into());
        assert!(validate(&s).is_err());
        assert!(validate(&off()).is_ok());
        assert!(validate(&dated("x")).is_ok());
    }

    #[test]
    fn read_state_without_notice() {
        for script in ["", FIXTURE, EMPTY, "# vacation \"x\";\r\n/* vacation \"y\"; */\r\n"] {
            let st = read_state(script);
            assert_eq!(st.source, VacationSource::None, "{:?}", script);
            assert!(!st.enabled);
        }
    }

    #[test]
    fn enable_on_empty_script_and_back() {
        let enabled = merge(EMPTY, &on("Hallo")).unwrap();
        assert_eq!(enabled, format!("/* empty script */\r\nrequire [\"vacation\"];\r\n{}", render_block(&on("Hallo"), "\r\n")));
        let st = read_state(&enabled);
        assert_eq!((st.source, st.enabled, st.text.as_str()), (VacationSource::Prudii, true, "Hallo"));
        assert_eq!(merge(&enabled, &off()).unwrap(), EMPTY);
    }

    #[test]
    fn period_requires_date_and_relational() {
        let enabled = merge(EMPTY, &dated("x")).unwrap();
        assert!(enabled.starts_with("/* empty script */\r\nrequire [\"vacation\",\"date\",\"relational\"];\r\n"));
        let st = read_state(&enabled);
        assert_eq!(st.from.as_deref(), Some("2026-09-15"));
        assert_eq!(st.until.as_deref(), Some("2026-09-26"));
        assert_eq!(st.subject.as_deref(), Some("Abwesend"));
        assert_eq!(merge(&enabled, &off()).unwrap(), EMPTY);
    }

    #[test]
    fn fixture_rules_survive_byte_for_byte() {
        let enabled = merge(FIXTURE, &on("Hallo")).unwrap();
        let rest = &FIXTURE["require [\"fileinto\"];\r\n".len()..];
        assert_eq!(enabled, format!("require [\"fileinto\",\"vacation\"];\r\n{}{}", rest, render_block(&on("Hallo"), "\r\n")));
        assert_eq!(read_state(&enabled).source, VacationSource::Prudii);

        let changed = merge(&enabled, &on("Neu")).unwrap();
        assert_eq!(changed, format!("require [\"fileinto\",\"vacation\"];\r\n{}{}", rest, render_block(&on("Neu"), "\r\n")));

        assert_eq!(merge(&changed, &off()).unwrap(), FIXTURE);
    }

    #[test]
    fn line_endings_follow_the_script() {
        let lf = FIXTURE.replace("\r\n", "\n");
        let enabled = merge(&lf, &on("Hallo")).unwrap();
        assert!(!enabled.contains('\r'));
        assert!(enabled.starts_with("require [\"fileinto\",\"vacation\"];\n"));
        assert_eq!(merge(&enabled, &off()).unwrap(), lf);
    }

    #[test]
    fn require_string_form_and_duplicates_fold_into_one_list() {
        let script = "require \"fileinto\";\r\nrequire [\"fileinto\",\"copy\"];\r\nfileinto :copy \"x\";\r\n";
        let enabled = merge(script, &on("Hallo")).unwrap();
        assert!(enabled.starts_with("require [\"fileinto\",\"copy\",\"vacation\"];\r\nfileinto :copy \"x\";\r\n"));
    }

    #[test]
    fn script_without_trailing_newline_gets_one_before_the_block() {
        let enabled = merge("/* empty script */", &on("Hallo")).unwrap();
        assert!(enabled.starts_with("/* empty script */\r\nrequire [\"vacation\"];\r\n# prudii:vacation:start"));
    }

    #[test]
    fn takes_over_a_roundcube_notice() {
        let script = "require [\"vacation\"];\r\n# rule:[Urlaub]\r\nvacation :days 5 :addresses [\"a@b.de\"] :subject \"Weg\" \"Bin weg\";\r\n";
        let st = read_state(script);
        assert_eq!(st.source, VacationSource::Foreign);
        assert_eq!(st.subject.as_deref(), Some("Weg"));
        assert_eq!(st.text, "Bin weg");
        assert!(st.had_addresses);
        assert_eq!(st.from, None);

        let merged = merge(script, &on("Hallo")).unwrap();
        assert_eq!(merged, format!("require [\"vacation\"];\r\n{}", render_block(&on("Hallo"), "\r\n")));
    }

    #[test]
    fn takes_over_a_dated_roundcube_notice() {
        let script = "require [\"vacation\",\"date\",\"relational\"];\r\n# rule:[Urlaub]\r\nif allof (currentdate :zone \"+0200\" :value \"ge\" \"date\" \"2026-09-15\", currentdate :value \"le\" \"iso8601\" \"2026-09-26T00:00:00+02:00\")\r\n{\r\n\tvacation :days 7 text:\r\nBin weg\r\n.\r\n;\r\n}\r\n";
        let st = read_state(script);
        assert_eq!(st.source, VacationSource::Foreign);
        assert_eq!(st.from.as_deref(), Some("2026-09-15"));
        assert_eq!(st.until.as_deref(), Some("2026-09-26"));
        assert_eq!(st.text, "Bin weg");

        let merged = merge(script, &off()).unwrap();
        assert_eq!(merged, "");
    }

    #[test]
    fn unrecognised_shapes_are_locked_and_never_rewritten() {
        let cases = [
            "require [\"vacation\"];\r\nvacation \"a\";\r\nvacation \"b\";\r\n",
            "require [\"vacation\"];\r\nif header :is \"x\" \"y\" { stop; } elsif true { vacation \"a\"; }\r\n",
            "require [\"vacation\"];\r\nif header :is \"x\" \"y\" { vacation \"a\"; }\r\n",
            "require [\"vacation\",\"fileinto\"];\r\nif currentdate :value \"ge\" \"date\" \"2026-01-01\" { vacation \"a\"; fileinto \"x\"; }\r\n",
            "require [\"vacation\"];\r\nif currentdate :value \"ge\" \"date\" \"2026-01-01\" { vacation \"a\"; } else { stop; }\r\n",
            "require [\"vacation\"];\r\nif true { if true { vacation \"a\"; } }\r\n",
            "require [\"vacation\"];\r\nvacation \"a\"\r\n",
        ];
        for script in cases {
            assert_eq!(read_state(script).source, VacationSource::Locked, "{}", script);
            assert!(merge(script, &on("x")).is_err(), "{}", script);
            assert!(merge(script, &off()).is_err(), "{}", script);
        }
    }

    #[test]
    fn prudii_block_next_to_a_foreign_notice_is_locked() {
        let script = format!("require [\"vacation\"];\r\nvacation \"a\";\r\n{}", render_block(&on("x"), "\r\n"));
        assert_eq!(read_state(&script).source, VacationSource::Locked);
        assert!(merge(&script, &off()).is_err());
    }

    #[test]
    fn commented_out_vacation_next_to_the_block_is_ignored() {
        let script = format!("require [\"vacation\"];\r\n# vacation \"a\";\r\n/* vacation \"b\"; */\r\n{}", render_block(&on("x"), "\r\n"));
        assert_eq!(read_state(&script).source, VacationSource::Prudii);
        assert_eq!(merge(&script, &off()).unwrap(), "# vacation \"a\";\r\n/* vacation \"b\"; */\r\n");
    }
}
