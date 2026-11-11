//! The Rust redactor (ADR 0023, ADR 0025 Redaction; contracts §13): each
//! language redacts the text it produces, once, and [`RedactedText`] marks
//! redacted text across the seam.
//!
//! [`Redactor::generic()`] replaces every path shape of the shared corpus
//! (`canopi-types/fixtures/redaction/`) with `<path>` and every credential
//! value named by `canopi-types/redaction.json` with `<redacted>`;
//! [`Redactor::with_roots`] also names this machine's folders (`<home-dir>`
//! and the rest). [`Redactor::redact`] is total: it never panics, and the
//! crate denies indexing and unchecked arithmetic outside its tests (2.1-M423).
//!
//! [`RedactedText`] has no constructor but [`Redactor::redact`] (and its
//! re-redacting decode):
//!
//! ```compile_fail
//! let text = canopi_redact::RedactedText(String::from("/home/ana/plan.canopi"));
//! ```
//!
//! ```compile_fail
//! let text: canopi_redact::RedactedText = String::from("/home/ana/plan.canopi").into();
//! ```
//!
//! ```
//! let text = canopi_redact::Redactor::generic().redact("/home/ana/plan.canopi");
//! assert_eq!(text.as_str(), canopi_redact::PATH_TOKEN);
//! ```
#![deny(missing_docs)]
#![cfg_attr(
    not(test),
    deny(clippy::indexing_slicing, clippy::arithmetic_side_effects)
)]

mod roots;
mod scan;
mod table_generated;

pub use roots::NamedFolder;
pub use table_generated::{CREDENTIAL_NAMES, PATH_TOKEN, REDACTED_TOKEN};

/// The longest input scanned, in bytes. Longer text is cut at a character
/// boundary before scanning, so a secret cut by the cap is still redacted,
/// and the cut is marked with [`TRUNCATION_MARK`].
pub const MAX_INPUT_BYTES: usize = 1 << 20;

/// What follows text cut at [`MAX_INPUT_BYTES`].
pub const TRUNCATION_MARK: &str = "…";

/// Text a redactor has passed: logs, failure details and report inputs take
/// only this type. Its field is private and its one constructor is
/// [`Redactor::redact`]; it serialises as a plain string, a decoded string is
/// redacted again, and it is a branded string in TypeScript (2.1-M424).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(transparent)]
pub struct RedactedText(String);

impl RedactedText {
    /// The redacted text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> serde::Deserialize<'de> for RedactedText {
    /// A string from the wire may come from anywhere (a stored job failure, an
    /// older build), so it is redacted again by the generic redactor.
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Ok(Redactor::generic().redact(&text))
    }
}

/// The redactor: the generic one, or one that also names this machine's
/// folders.
#[derive(Debug, Clone, Default)]
pub struct Redactor {
    roots: roots::Roots,
}

impl Redactor {
    /// The redactor that knows no named folder of this machine: every path
    /// becomes [`PATH_TOKEN`].
    pub fn generic() -> Self {
        Self::default()
    }

    /// The redactor that also names `roots`: a path inside one becomes its
    /// folder's token (the most specific folder wins), and any other path
    /// stays [`PATH_TOKEN`]. An empty root or a filesystem root is ignored.
    pub fn with_roots<P: AsRef<std::path::Path>>(
        roots: impl IntoIterator<Item = (NamedFolder, P)>,
    ) -> Self {
        Self {
            roots: roots::Roots::new(roots),
        }
    }

    /// `text` redacted: paths become their folder's token or [`PATH_TOKEN`],
    /// credential values [`REDACTED_TOKEN`]. Text over [`MAX_INPUT_BYTES`] is
    /// cut before scanning and marked. Never panics.
    pub fn redact(&self, text: &str) -> RedactedText {
        let (scanned, cut) = capped(text);
        let mut redacted = scan::redact(scanned, &|span| self.roots.token_for(span));
        if cut {
            redacted.push_str(TRUNCATION_MARK);
        }
        RedactedText(redacted)
    }
}

/// `text` cut to at most [`MAX_INPUT_BYTES`] at a character boundary, and
/// whether it was cut.
fn capped(text: &str) -> (&str, bool) {
    if text.len() <= MAX_INPUT_BYTES {
        return (text, false);
    }
    let end = (0..=MAX_INPUT_BYTES)
        .rev()
        .find(|&index| text.is_char_boundary(index))
        .unwrap_or(0);
    (text.get(..end).unwrap_or_default(), true)
}

#[cfg(test)]
mod tests;
