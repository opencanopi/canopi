//! The Rust redactor (ADR 0023, ADR 0025 Redaction; contracts §13): each
//! language redacts the text it produces, once, and [`RedactedText`] marks
//! redacted text across the seam.
//!
//! Commit 0 of Phase 1 lands the skeleton: the type the wire shapes carry, the
//! credential table generated from `canopi-types/redaction.json` and a total
//! [`Redactor`] that replaces any input with the redaction token whole, so no
//! text can leave unredacted before the real redactor lands. Phase 1's 1a-c3
//! builds `Redactor::generic()` and `with_roots(..)` over the shared corpus
//! (`canopi-types/fixtures/redaction/`) and the re-redacting `Deserialize`.
#![deny(missing_docs)]

mod table_generated;

pub use table_generated::{CREDENTIAL_NAMES, PATH_TOKEN, REDACTED_TOKEN};

/// Text a redactor has passed: logs, failure details and report inputs take
/// only this type. Its field is private and its one constructor is
/// [`Redactor::redact`]; it serialises as a plain string and is a branded
/// string in TypeScript (2.1-M424).
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

/// The redactor. A commit-0 skeleton: total, and it redacts every input
/// whole until 1a-c3 builds the corpus redactor.
#[derive(Debug, Clone, Default)]
pub struct Redactor {
    _private: (),
}

impl Redactor {
    /// The redactor that knows no named folder of this machine.
    pub fn generic() -> Self {
        Self::default()
    }

    /// `text` redacted. Never panics.
    pub fn redact(&self, text: &str) -> RedactedText {
        let _ = text;
        RedactedText(REDACTED_TOKEN.to_owned())
    }
}

#[cfg(test)]
mod tests;
