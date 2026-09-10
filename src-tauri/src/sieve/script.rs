//! Tokenizer and mini-parser for the Sieve subset the vacation feature
//! needs: comments, strings (quoted and `text:`), `require`, commands with
//! tag/string/list arguments, and `if` tests. Every token carries byte
//! offsets so callers can splice the original script instead of
//! re-serialising it.

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Tok {
    Ident(String),
    Tag(String),
    Str(String),
    Num(String),
    Punct(char),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Token {
    pub tok: Tok,
    pub start: usize,
    pub end: usize,
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}

fn is_ident_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Multi-line string body (RFC 5228 §2.4.2): starts after the `text:` line,
/// ends at a line holding a single `.`; leading `..` loses one dot. Returns
/// the decoded text (lines joined with `\n`) and the offset after the
/// terminator line.
fn read_multiline(bytes: &[u8], mut i: usize) -> (String, usize) {
    // Skip the rest of the `text:` line (whitespace or a comment).
    while i < bytes.len() && bytes[i] != b'\n' {
        i += 1;
    }
    if i < bytes.len() {
        i += 1;
    }
    let mut lines: Vec<String> = Vec::new();
    while i < bytes.len() {
        let line_end = bytes[i..].iter().position(|&b| b == b'\n').map(|p| i + p).unwrap_or(bytes.len());
        let mut line = &bytes[i..line_end];
        if line.last() == Some(&b'\r') {
            line = &line[..line.len() - 1];
        }
        let next = if line_end < bytes.len() { line_end + 1 } else { bytes.len() };
        if line == b"." {
            return (lines.join("\n"), next);
        }
        let unstuffed = line.strip_prefix(b".").filter(|_| line.starts_with(b"..")).unwrap_or(line);
        lines.push(String::from_utf8_lossy(unstuffed).into_owned());
        i = next;
    }
    (lines.join("\n"), bytes.len())
}

pub(crate) fn tokenize(script: &str) -> Vec<Token> {
    let bytes = script.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
        } else if b == b'#' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if b == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
        } else if b == b'"' {
            let start = i;
            i += 1;
            let mut s = Vec::new();
            while i < bytes.len() && bytes[i] != b'"' {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 1;
                }
                s.push(bytes[i]);
                i += 1;
            }
            i = (i + 1).min(bytes.len());
            tokens.push(Token { tok: Tok::Str(String::from_utf8_lossy(&s).into_owned()), start, end: i });
        } else if is_ident_start(b) {
            let start = i;
            while i < bytes.len() && is_ident_char(bytes[i]) {
                i += 1;
            }
            let ident = &script[start..i];
            if ident.eq_ignore_ascii_case("text") && bytes.get(i) == Some(&b':') {
                let (text, end) = read_multiline(bytes, i + 1);
                tokens.push(Token { tok: Tok::Str(text), start, end });
                i = end;
            } else {
                tokens.push(Token { tok: Tok::Ident(ident.to_ascii_lowercase()), start, end: i });
            }
        } else if b == b':' && bytes.get(i + 1).is_some_and(|&n| is_ident_start(n)) {
            let start = i;
            i += 1;
            while i < bytes.len() && is_ident_char(bytes[i]) {
                i += 1;
            }
            tokens.push(Token { tok: Tok::Tag(script[start + 1..i].to_ascii_lowercase()), start, end: i });
        } else if b.is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i < bytes.len() && matches!(bytes[i].to_ascii_uppercase(), b'K' | b'M' | b'G') {
                i += 1;
            }
            tokens.push(Token { tok: Tok::Num(script[start..i].to_string()), start, end: i });
        } else {
            tokens.push(Token { tok: Tok::Punct(b as char), start: i, end: i + 1 });
            i += 1;
        }
    }
    tokens
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Arg {
    Tag(String),
    Str(String),
    List(Vec<String>),
    Num(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Test {
    pub name: String,
    pub args: Vec<Arg>,
    pub sub: Vec<Test>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Command {
    pub name: String,
    pub args: Vec<Arg>,
    pub tests: Vec<Test>,
    pub block: Option<Vec<Command>>,
    pub start: usize,
    pub end: usize,
}

struct Parser<'a> {
    tokens: &'a [Token],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&'a Tok> {
        self.tokens.get(self.pos).map(|t| &t.tok)
    }

    fn unexpected(&self) -> String {
        match self.tokens.get(self.pos) {
            Some(t) => format!("unexpected token at byte {}", t.start),
            None => "unexpected end of script".to_string(),
        }
    }

    fn expect_punct(&mut self, c: char) -> Result<&'a Token, String> {
        match self.tokens.get(self.pos) {
            Some(t) if t.tok == Tok::Punct(c) => {
                self.pos += 1;
                Ok(t)
            }
            _ => Err(self.unexpected()),
        }
    }

    fn parse_args(&mut self) -> Result<Vec<Arg>, String> {
        let mut args = Vec::new();
        loop {
            match self.peek() {
                Some(Tok::Tag(t)) => args.push(Arg::Tag(t.clone())),
                Some(Tok::Str(s)) => args.push(Arg::Str(s.clone())),
                Some(Tok::Num(n)) => args.push(Arg::Num(n.clone())),
                Some(Tok::Punct('[')) => {
                    self.pos += 1;
                    let mut items = Vec::new();
                    loop {
                        match self.peek() {
                            Some(Tok::Str(s)) => {
                                items.push(s.clone());
                                self.pos += 1;
                            }
                            _ => return Err(self.unexpected()),
                        }
                        match self.peek() {
                            Some(Tok::Punct(',')) => self.pos += 1,
                            Some(Tok::Punct(']')) => break,
                            _ => return Err(self.unexpected()),
                        }
                    }
                    args.push(Arg::List(items));
                }
                _ => return Ok(args),
            }
            self.pos += 1;
        }
    }

    fn parse_test(&mut self) -> Result<Test, String> {
        let name = match self.peek() {
            Some(Tok::Ident(n)) => n.clone(),
            _ => return Err(self.unexpected()),
        };
        self.pos += 1;
        let args = self.parse_args()?;
        let sub = match self.peek() {
            Some(Tok::Punct('(')) => self.parse_test_list()?,
            Some(Tok::Ident(_)) => vec![self.parse_test()?],
            _ => Vec::new(),
        };
        Ok(Test { name, args, sub })
    }

    fn parse_test_list(&mut self) -> Result<Vec<Test>, String> {
        self.expect_punct('(')?;
        let mut tests = Vec::new();
        loop {
            tests.push(self.parse_test()?);
            match self.peek() {
                Some(Tok::Punct(',')) => self.pos += 1,
                Some(Tok::Punct(')')) => {
                    self.pos += 1;
                    return Ok(tests);
                }
                _ => return Err(self.unexpected()),
            }
        }
    }

    fn parse_command(&mut self) -> Result<Command, String> {
        let head = self.tokens.get(self.pos).ok_or_else(|| self.unexpected())?;
        let name = match &head.tok {
            Tok::Ident(n) => n.clone(),
            _ => return Err(self.unexpected()),
        };
        self.pos += 1;
        let args = self.parse_args()?;
        let tests = if name == "if" || name == "elsif" {
            match self.peek() {
                Some(Tok::Punct('(')) => self.parse_test_list()?,
                Some(Tok::Ident(_)) => vec![self.parse_test()?],
                _ => return Err(self.unexpected()),
            }
        } else {
            Vec::new()
        };
        match self.peek() {
            Some(Tok::Punct(';')) => {
                let end = self.tokens[self.pos].end;
                self.pos += 1;
                Ok(Command { name, args, tests, block: None, start: head.start, end })
            }
            Some(Tok::Punct('{')) => {
                self.pos += 1;
                let block = self.parse_body(true)?;
                let close = self.expect_punct('}')?;
                Ok(Command { name, args, tests, block: Some(block), start: head.start, end: close.end })
            }
            _ => Err(self.unexpected()),
        }
    }

    fn parse_body(&mut self, inside_block: bool) -> Result<Vec<Command>, String> {
        let mut cmds = Vec::new();
        loop {
            match self.peek() {
                None if inside_block => return Err(self.unexpected()),
                None => return Ok(cmds),
                Some(Tok::Punct('}')) if inside_block => return Ok(cmds),
                Some(Tok::Ident(_)) => cmds.push(self.parse_command()?),
                _ => return Err(self.unexpected()),
            }
        }
    }
}

pub(crate) fn parse_commands(tokens: &[Token]) -> Result<Vec<Command>, String> {
    Parser { tokens, pos: 0 }.parse_body(false)
}

#[cfg(test)]
mod parser_tests {
    use super::*;

    const FIXTURE: &str = "require [\"fileinto\"];\n# rule:[Test]\nif allof (header :contains \"subject\" \"test\")\n{\n\tfileinto \"INBOX\";\n}\n";

    fn toks(script: &str) -> Vec<Tok> {
        tokenize(script).into_iter().map(|t| t.tok).collect()
    }

    #[test]
    fn comments_produce_no_tokens() {
        assert_eq!(
            toks("# vacation\n/* vacation */ vacation \"x\";"),
            vec![Tok::Ident("vacation".into()), Tok::Str("x".into()), Tok::Punct(';')]
        );
    }

    #[test]
    fn quoted_strings_are_unescaped() {
        assert_eq!(toks("\"a\\\"b\\\\c\""), vec![Tok::Str("a\"b\\c".into())]);
    }

    #[test]
    fn multiline_string_is_unstuffed_and_spans_to_the_terminator() {
        let script = "text:\r\nab\r\n..\r\n.\r\n;";
        let tokens = tokenize(script);
        assert_eq!(tokens[0].tok, Tok::Str("ab\r\n.".replace("\r\n", "\n")));
        assert_eq!(tokens[0].end, script.len() - 1);
        assert_eq!(tokens[1].tok, Tok::Punct(';'));
    }

    #[test]
    fn require_list_parses() {
        let tokens = tokenize("require [\"fileinto\",\"vacation\"];");
        let cmds = parse_commands(&tokens).unwrap();
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].name, "require");
        assert_eq!(cmds[0].args, vec![Arg::List(vec!["fileinto".into(), "vacation".into()])]);
        assert_eq!((cmds[0].start, cmds[0].end), (0, "require [\"fileinto\",\"vacation\"];".len()));
    }

    #[test]
    fn fixture_parses_into_require_and_if() {
        let tokens = tokenize(FIXTURE);
        let cmds = parse_commands(&tokens).unwrap();
        assert_eq!(cmds.len(), 2);
        let rule = &cmds[1];
        assert_eq!(rule.name, "if");
        assert_eq!(rule.tests[0].name, "allof");
        assert_eq!(rule.tests[0].sub[0].name, "header");
        assert_eq!(
            rule.tests[0].sub[0].args,
            vec![Arg::Tag("contains".into()), Arg::Str("subject".into()), Arg::Str("test".into())]
        );
        let block = rule.block.as_ref().unwrap();
        assert_eq!(block.len(), 1);
        assert_eq!(block[0].name, "fileinto");
        assert_eq!(&FIXTURE[rule.start..rule.end], "if allof (header :contains \"subject\" \"test\")\n{\n\tfileinto \"INBOX\";\n}");
    }

    #[test]
    fn bare_currentdate_test_without_allof() {
        let tokens = tokenize("if currentdate :value \"ge\" \"date\" \"2026-01-01\" { vacation \"x\"; }");
        let cmds = parse_commands(&tokens).unwrap();
        let test = &cmds[0].tests[0];
        assert_eq!(test.name, "currentdate");
        assert_eq!(
            test.args,
            vec![Arg::Tag("value".into()), Arg::Str("ge".into()), Arg::Str("date".into()), Arg::Str("2026-01-01".into())]
        );
        assert!(test.sub.is_empty());
        assert_eq!(cmds[0].block.as_ref().unwrap()[0].name, "vacation");
    }

    #[test]
    fn not_test_wraps_its_operand() {
        let tokens = tokenize("if not header :is \"x\" \"y\" { stop; }");
        let cmds = parse_commands(&tokens).unwrap();
        assert_eq!(cmds[0].tests[0].name, "not");
        assert_eq!(cmds[0].tests[0].sub[0].name, "header");
    }

    #[test]
    fn truncated_script_is_an_error() {
        assert!(parse_commands(&tokenize("if allof (")).is_err());
        assert!(parse_commands(&tokenize("vacation \"x\"")).is_err());
        assert!(parse_commands(&tokenize("if true { stop;")).is_err());
    }
}
