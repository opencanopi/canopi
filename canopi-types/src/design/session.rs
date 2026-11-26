use serde::{Deserialize, Serialize};
use specta::Type;

use super::field_path;
use super::v10::CanopiFileV10;

/// A Design read from a file, with the fingerprint (SHA-256 of the file's
/// bytes) its next continuous save must still find on disk.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LoadedDesign {
    /// The admitted in-memory v10 Design document.
    pub file: CanopiFileV10,
    /// SHA-256 hex digest of the on-disk bytes at load time.
    pub fingerprint: String,
    /// Source format version when migrated on open (e.g. `Some(9)`), or `None` when native v10.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub migrated_from: Option<u32>,
}

/// Why a Design file could not be opened. `kind` is what the interface maps
/// to a message; `message` is for logs and Problem Reports and never names a
/// path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DesignLoadFailure {
    /// Machine-readable refusal category mapped to user-facing copy.
    pub kind: DesignLoadFailureKind,
    /// Diagnostic detail for logs and Problem Reports (never names a path).
    pub message: String,
    /// The refused field when the file parsed and the Design was refused (`$.version` for a
    /// version this build does not open), for the failure ring and Problem Reports
    /// only: the refusal the user reads never names it (2.1-Q286, canopi-cyqd).
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub field_path: Option<field_path::FieldPath>,
}

/// Category of failure when reading or validating a `.canopi` Design.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DesignLoadFailureKind {
    /// Nothing is at the path.
    Missing,
    /// The file exists but could not be read (permissions, a folder, an I/O error).
    Unreadable,
    /// The file exceeds the maximum admitted size.
    TooLarge,
    /// The bytes are not valid JSON.
    InvalidJson,
    /// Older than the current format (written before Canopi 2.0), which
    /// Canopi 2.0 and later do not open (ADR 0021).
    OlderVersion,
    /// Newer than this build.
    NewerVersion,
    /// A frozen migration step failed on a valid earlier-version Design.
    MigrationFailed,
    /// Parsed JSON did not satisfy the Design document schema.
    InvalidDocument,
    /// The native side failed before it reached the file (an executor error).
    Internal,
}

/// The result of writing a Design to its file.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DesignSaveOutcome {
    /// Written; `fingerprint` is what the next save must expect.
    Saved {
        /// Saved file path.
        path: String,
        /// SHA-256 hex digest of the newly written bytes.
        fingerprint: String,
    },
    /// The file changed outside Canopi since `expected_fingerprint`; nothing
    /// was written. `current_fingerprint` is `None` when the file is gone.
    Conflict {
        /// SHA-256 hex digest currently on disk, or `None` if removed.
        current_fingerprint: Option<String>,
    },
}

/// A Design draft: an unsaved (Untitled) Design kept in app data until the
/// user saves it as a file or deletes it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DesignDraftSummary {
    /// Stable draft identifier.
    pub id: String,
    /// User-visible Design name.
    pub name: String,
    /// Last-modified UTC timestamp.
    pub updated_at: String,
    /// Whether opening the Draft edits it or refuses it as unreadable (2.1-Q316, 2.1-Q347). Absent
    /// on the wire for an editable Draft, the common case; an unreadable Draft carries it.
    #[serde(default, skip_serializing_if = "DesignDraftAccess::is_editable")]
    #[specta(optional)]
    pub access: DesignDraftAccess,
}

/// How a listed Draft opens (2.1-Q316, 2.1-Q347). Only an `Editable` Draft is ever opened for
/// editing or deleted; the store refuses writes to unreadable Drafts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DesignDraftAccess {
    /// A current Draft: it opens for editing.
    #[default]
    Editable,
    /// Saved by a newer Canopi or otherwise refused: listed as unreadable, never
    /// hidden, and opening it says why.
    Unreadable,
}

impl DesignDraftAccess {
    /// Whether the Draft opens for editing; the wire omits `access` then.
    #[must_use]
    pub fn is_editable(&self) -> bool {
        *self == Self::Editable
    }
}
