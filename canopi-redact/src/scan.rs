//! One left-to-right pass over the text: at each character, a path span, a
//! credential parameter (`name=value`) or a JSON credential key
//! (`"name": "value"`) is replaced; anything else is copied.
//!
//! A path starts at the start or after any character but one that joins
//! words (`starts_path_after`), with one of the corpus shapes: `/x`, a drive
//! (`C:\`, `C:/`), `\\` (UNC, `\\?\`, JSON-escaped), `file://`, `%2F` or `%5C`,
//! and `~/`. A quoted path runs to its closing quote; an unquoted one is
//! read by `unquoted_length`, so a name of any number of words stays whole
//! and the error reason after it is kept (its doc names the one shape it
//! cannot tell apart). Every step reads by `get` and
//! iterators, so no input panics.

use crate::{CREDENTIAL_NAMES, REDACTED_TOKEN};

/// `text` with each path replaced by `path_token(span)` and each credential
/// value by the redaction token.
pub(crate) fn redact(text: &str, path_token: &dyn Fn(&str) -> &'static str) -> String {
    let mut redacted = String::with_capacity(text.len());
    let mut previous: Option<char> = None;
    let mut rest = text;
    while let Some(ch) = rest.chars().next() {
        if let Some((output, tail)) = replacement_at(rest, previous, path_token) {
            redacted.push_str(&output);
            previous = output.chars().last().or(previous);
            rest = tail;
            continue;
        }
        redacted.push(ch);
        previous = Some(ch);
        rest = after(rest, ch.len_utf8());
    }
    redacted
}

/// The replacement for what starts `rest`, and the text after it.
fn replacement_at<'a>(
    rest: &'a str,
    previous: Option<char>,
    path_token: &dyn Fn(&str) -> &'static str,
) -> Option<(String, &'a str)> {
    if previous.is_none_or(starts_path_after)
        && let Some(length) = path_length(rest, previous)
    {
        let span = rest.get(..length)?;
        return Some((path_token(span).to_owned(), after(rest, length)));
    }
    if previous.is_none_or(starts_parameter_after)
        && let Some(found) = query_credential(rest)
    {
        return Some(found);
    }
    if previous.is_none_or(starts_json_key_after) {
        return json_credential(rest);
    }
    None
}

fn after(text: &str, bytes: usize) -> &str {
    text.get(bytes..).unwrap_or_default()
}

/// A path may start after anything but a character that joins words (a
/// letter, a digit, a separator or `.`, `_`, `-`, `+`, `%`, `~`), so a
/// fraction, a date, `km/h`, `+/-` or a URL's later slashes start none.
fn starts_path_after(previous: char) -> bool {
    !(previous.is_alphanumeric()
        || matches!(previous, '/' | '\\' | '.' | '_' | '-' | '+' | '%' | '~'))
}

fn starts_parameter_after(previous: char) -> bool {
    previous.is_whitespace() || matches!(previous, '?' | '&' | ';')
}

fn starts_json_key_after(previous: char) -> bool {
    previous.is_whitespace() || matches!(previous, '{' | ',')
}

/// Characters that end an unquoted path.
fn stops_path(ch: char) -> bool {
    matches!(
        ch,
        '\n' | '\r' | '"' | '\'' | '`' | ')' | ']' | '}' | ',' | ';' | '<' | '>'
    )
}

/// Characters that end a credential value.
fn stops_value(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '&' | '#' | '"' | '\'' | ')' | ']' | '}' | ',' | ';' | '<' | '>'
        )
}

fn strip_prefix_ignore_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| after(text, prefix.len()))
}

/// Whether `rest` starts with one of the corpus's path shapes.
fn starts_path(rest: &str) -> bool {
    let mut chars = rest.chars();
    let (first, second, third) = (chars.next(), chars.next(), chars.next());
    match (first, second, third) {
        (Some('/'), Some(next), _) => !(next.is_whitespace() || next == '/' || stops_path(next)),
        (Some('\\'), Some('\\'), Some(next)) => !(next.is_whitespace() || stops_path(next)),
        (Some('~'), Some('/' | '\\'), _) => true,
        (Some(drive), Some(':'), Some('/' | '\\')) => drive.is_ascii_alphabetic(),
        _ => ["file://", "%2f", "%5c"]
            .iter()
            .any(|prefix| strip_prefix_ignore_case(rest, prefix).is_some()),
    }
}

/// The byte length of the path that starts `rest`, if one does.
fn path_length(rest: &str, previous: Option<char>) -> Option<usize> {
    if !starts_path(rest) {
        return None;
    }
    let length = match previous {
        Some(quote @ ('"' | '\'')) => quoted_length(rest, quote),
        _ => trim_trailing_dots(rest, unquoted_length(rest)),
    };
    (length > 0).then_some(length)
}

/// A quoted path runs to its closing quote or the end of the line; a
/// backslash before the quote escapes it in JSON, so it stays outside.
fn quoted_length(rest: &str, quote: char) -> usize {
    let end = rest
        .char_indices()
        .find(|&(_, ch)| ch == quote || ch == '\n' || ch == '\r')
        .map_or(rest.len(), |(index, _)| index);
    let span = rest.get(..end).unwrap_or_default();
    match span.strip_suffix('\\') {
        Some(unescaped) if rest.get(end..).is_some_and(|tail| tail.starts_with(quote)) => {
            unescaped.len()
        }
        _ => end,
    }
}

/// An unquoted path's segment runs to a stop character, a `:` before
/// whitespace or the end, or a word that starts another path. A segment
/// ending at that `:` is all path (the words of a name with spaces, then the
/// error reason), unless a word ending in a file name (`a.canopi`) ended the
/// path before it; any other ends after its last word that reads as a path.
/// A last name word with neither a separator nor an extension and no `:`
/// after it reads as the reason and is kept (`/home/ana/Secret Projects
/// failed` keeps `Projects`): no rule tells such a word from the reason.
fn unquoted_length(rest: &str) -> usize {
    let mut path_end = 0;
    let mut word_start = 0;
    let mut file_name_ended = false;
    let mut chars = rest.char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        let next = chars.peek().copied();
        if ch == ':' && next.is_none_or(|(_, next)| next.is_whitespace()) {
            return if file_name_ended { path_end } else { index };
        }
        if stops_path(ch) || ch.is_whitespace() {
            let word = rest.get(word_start..index).unwrap_or_default();
            if word_start == 0 || word_reads_as_path(word) {
                path_end = index;
                file_name_ended = ends_in_file_name(word);
            }
            word_start = next.map_or(rest.len(), |(start, _)| start);
            if stops_path(ch) || starts_path(after(rest, word_start)) {
                return path_end;
            }
        }
    }
    let word = after(rest, word_start);
    if word_start == 0 || word_reads_as_path(word) {
        rest.len()
    } else {
        path_end
    }
}

/// A sentence's full stop after a path is not part of it.
fn trim_trailing_dots(rest: &str, length: usize) -> usize {
    let span = rest.get(..length).unwrap_or_default();
    let trimmed = span.trim_end_matches('.');
    if trimmed.chars().count() >= 2 {
        trimmed.len()
    } else {
        length
    }
}

/// Whether a later word of a path's segment reads as part of a path with
/// spaces in it: it holds a separator or a file extension.
fn word_reads_as_path(word: &str) -> bool {
    let has_extension = word
        .split('.')
        .skip(1)
        .any(|part| part.chars().next().is_some_and(char::is_alphanumeric));
    word.contains(['/', '\\']) || has_extension
}

/// Whether a word's last component is a file name with an extension.
fn ends_in_file_name(word: &str) -> bool {
    let name = word.rsplit(['/', '\\']).next().unwrap_or_default();
    name.rsplit_once('.').is_some_and(|(stem, extension)| {
        !stem.is_empty() && extension.starts_with(char::is_alphanumeric)
    })
}

/// `name=value` for a credential name, its value replaced.
fn query_credential(rest: &str) -> Option<(String, &str)> {
    CREDENTIAL_NAMES.iter().find_map(|name| {
        let value = strip_prefix_ignore_case(rest, name)?.strip_prefix('=')?;
        let tail = value.trim_start_matches(|ch: char| !stops_value(ch));
        if tail.len() == value.len() {
            return None;
        }
        let kept = rest.get(..rest.len().saturating_sub(value.len()))?;
        Some((format!("{kept}{REDACTED_TOKEN}"), tail))
    })
}

/// `"name": "value"` for a credential name, its string value replaced.
fn json_credential(rest: &str) -> Option<(String, &str)> {
    let key = rest.strip_prefix('"')?;
    CREDENTIAL_NAMES.iter().find_map(|name| {
        let value = strip_prefix_ignore_case(key, name)?
            .strip_prefix('"')?
            .trim_start()
            .strip_prefix(':')?
            .trim_start()
            .strip_prefix('"')?;
        let kept = rest.get(..rest.len().saturating_sub(value.len()))?;
        let tail = after(value, json_string_length(value));
        let closing = tail.strip_prefix('"');
        let output = format!(
            "{kept}{REDACTED_TOKEN}{}",
            if closing.is_some() { "\"" } else { "" }
        );
        Some((output, closing.unwrap_or(tail)))
    })
}

/// The byte length of a JSON string's contents, up to its unescaped closing
/// quote or the end.
fn json_string_length(value: &str) -> usize {
    let mut escaped = false;
    value
        .char_indices()
        .find(|&(_, ch)| {
            let closes = ch == '"' && !escaped;
            escaped = ch == '\\' && !escaped;
            closes
        })
        .map_or(value.len(), |(index, _)| index)
}
