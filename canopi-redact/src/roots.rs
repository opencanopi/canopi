//! This machine's named folders and the token a path span becomes.
//!
//! A span and each root are compared in one normal form: percent-decoded,
//! `file:` and the verbatim `\\?\` (`\\?\UNC\`) prefixes dropped, both
//! separators as `/` with runs collapsed (so JSON-escaped `\\` reads as one),
//! ASCII lowercase, no trailing `/`; `~` reads as the home folder.

use crate::PATH_TOKEN;
use std::cmp::Reverse;
use std::path::Path;

/// A folder of this machine the native redactor names instead of `<path>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamedFolder {
    /// The user's home folder: `<home-dir>`.
    Home,
    /// Canopi's local data folder: `<app-data-dir>`.
    AppData,
    /// Canopi's log folder: `<log-dir>`.
    Log,
    /// The folder problem reports are written to: `<report-root>`.
    Report,
}

impl NamedFolder {
    /// The token a path inside this folder becomes.
    pub const fn token(self) -> &'static str {
        match self {
            Self::Home => "<home-dir>",
            Self::AppData => "<app-data-dir>",
            Self::Log => "<log-dir>",
            Self::Report => "<report-root>",
        }
    }
}

/// The named folders, most specific first, in normal form.
#[derive(Debug, Clone, Default)]
pub(crate) struct Roots {
    folders: Vec<(String, NamedFolder)>,
    home: Option<String>,
}

impl Roots {
    pub(crate) fn new<P: AsRef<Path>>(roots: impl IntoIterator<Item = (NamedFolder, P)>) -> Self {
        let mut folders: Vec<(String, NamedFolder)> = roots
            .into_iter()
            .map(|(folder, path)| (normal_form(&path.as_ref().to_string_lossy(), None), folder))
            .filter(|(root, _)| !root.is_empty())
            .collect();
        folders.sort_by_key(|(root, _)| Reverse(root.len()));
        let home = folders
            .iter()
            .find(|(_, folder)| *folder == NamedFolder::Home)
            .map(|(root, _)| root.clone());
        Self { folders, home }
    }

    /// The token `span` becomes: its most specific named folder's, else `<path>`.
    pub(crate) fn token_for(&self, span: &str) -> &'static str {
        if self.folders.is_empty() {
            return PATH_TOKEN;
        }
        let path = normal_form(span, self.home.as_deref());
        self.folders
            .iter()
            .find(|(root, _)| {
                path.strip_prefix(root.as_str())
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
            })
            .map_or(PATH_TOKEN, |(_, folder)| folder.token())
    }
}

/// `text` in the normal form both sides of a comparison take; `home` (in
/// normal form) stands for a leading `~`.
fn normal_form(text: &str, home: Option<&str>) -> String {
    let decoded = percent_decoded(text);
    let mut unified = String::with_capacity(decoded.len());
    for ch in decoded.chars() {
        let ch = if ch == '\\' {
            '/'
        } else {
            ch.to_ascii_lowercase()
        };
        if !(ch == '/' && unified.ends_with('/')) {
            unified.push(ch);
        }
    }
    let path = unified.strip_prefix("file:").unwrap_or(&unified);
    let path = path
        .strip_prefix("/?/unc/")
        .map(|share| format!("/{share}"))
        .or_else(|| path.strip_prefix("/?/").map(str::to_owned))
        .unwrap_or_else(|| path.to_owned());
    let path = match path.strip_prefix('/') {
        Some(rest) if is_drive(rest) => rest.to_owned(),
        _ => path,
    };
    let path = match (path.strip_prefix('~'), home) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => {
            format!("{home}{rest}")
        }
        _ => path,
    };
    path.trim_end_matches('/').to_owned()
}

/// Whether `path` starts with a drive (`c:` then `/` or the end).
fn is_drive(path: &str) -> bool {
    let mut chars = path.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(letter), Some(':'), None | Some('/')) if letter.is_ascii_alphabetic()
    )
}

/// `text` with each `%XX` escape decoded; bytes that are not UTF-8 read lossily.
fn percent_decoded(text: &str) -> String {
    if !text.contains('%') {
        return text.to_owned();
    }
    let mut bytes = Vec::with_capacity(text.len());
    let mut rest = text.bytes();
    while let Some(byte) = rest.next() {
        if byte == b'%' {
            let mut ahead = rest.clone();
            if let (Some(high), Some(low)) =
                (ahead.next().and_then(hex), ahead.next().and_then(hex))
            {
                bytes.push(high.wrapping_mul(16) | low);
                rest = ahead;
                continue;
            }
        }
        bytes.push(byte);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
    char::from(byte)
        .to_digit(16)
        .and_then(|digit| u8::try_from(digit).ok())
}
