//! Wire types for the Desktop `home_read` / `home_write` port and the last-open-home record
//! (contracts §4, ADR 0027, 2.1-M523, 2.1-Q35r, 2.1-Q127).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{
    failure::Failure,
    ids::{DraftId, FileGrantId, HomeVersion},
};

/// Host-issued identity for a granted Design file: ephemeral grant handle for `home_read`/`home_write`,
/// human-readable file name for UI display, and stable opaque `recent_id` for `last_open_home`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FileHomeGrant {
    /// Ephemeral process-local file grant id (`grant:N`) accepted by `home_read` / `home_write`.
    pub grant: FileGrantId,
    /// Human-readable file name (never a full path or grant id) for title/UI display.
    pub display_name: String,
    /// Stable opaque Recent Designs identifier (SHA-256 hex of the resolved path) for `last_open_home`.
    pub recent_id: String,
}

/// Result of reading a Design home (file grant or Draft id) through `home_read`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HomeRead {
    /// The home exists and its exact bytes were read alongside its SHA-256 `version`.
    Present {
        /// Exact `.canopi` bytes on disk.
        bytes: Vec<u8>,
        /// Lowercase hex SHA-256 digest of `bytes`.
        version: HomeVersion,
    },
    /// No file exists yet for this home.
    Absent,
    /// The home could not be read (invalid key, over size cap, or I/O failure).
    Unreadable {
        /// Redacted reason suitable for diagnostics; never a raw user path.
        reason: String,
    },
}

/// Result of durably writing a Design home through `home_write`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HomeWrite {
    /// Bytes were published durably; `version` is their lowercase hex SHA-256 digest.
    Written {
        /// Lowercase hex SHA-256 digest of the published bytes.
        version: HomeVersion,
    },
    /// Compare-and-swap precondition failed; nothing was overwritten.
    Conflict {
        /// Current version on disk (`None` if the file disappeared).
        current: Option<HomeVersion>,
    },
    /// The requested pre-upgrade copy (`keep_previous`) could not be created; nothing was published (2.1-Q35r).
    CopyBlocked {
        /// Display name of the unwritable folder (never full raw user path in logs).
        folder: String,
    },
    /// The write failed for a non-conflict, non-copy-blocked reason.
    Failed {
        /// Structured catalogue failure.
        failure: Failure,
    },
}

/// Persistent last-open-home record stored in the settings field table (contracts §4, 2.1-M523, A27).
///
/// Never stores a filesystem path or ephemeral `FileGrantId`: file homes are stored by their
/// Recent Designs entry id, which the Desktop host resolves into a fresh grant on launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LastOpenHome {
    /// A saved Design file identified by its Recent Designs entry id (2.1-M49).
    File {
        /// Stable Recent Designs entry identifier.
        recent_id: String,
    },
    /// An untitled Draft identified by its `DraftId`.
    Draft {
        /// Stable Draft identifier.
        id: DraftId,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_read_write_and_last_open_home_round_trip_with_kind_tags() {
        let present = HomeRead::Present {
            bytes: vec![1, 2, 3],
            version: HomeVersion::new("abc123"),
        };
        let present_json = serde_json::to_value(&present).unwrap();
        assert_eq!(present_json["kind"], "present");
        assert_eq!(
            serde_json::from_value::<HomeRead>(present_json).unwrap(),
            present
        );

        let conflict = HomeWrite::Conflict {
            current: Some(HomeVersion::new("def456")),
        };
        let conflict_json = serde_json::to_value(&conflict).unwrap();
        assert_eq!(conflict_json["kind"], "conflict");
        assert_eq!(conflict_json["current"], "def456");

        let last_file = LastOpenHome::File {
            recent_id: "recent-1".to_owned(),
        };
        let last_file_json = serde_json::to_value(&last_file).unwrap();
        assert_eq!(last_file_json["kind"], "file");
        assert_eq!(
            serde_json::from_value::<LastOpenHome>(last_file_json).unwrap(),
            last_file
        );

        let last_draft = LastOpenHome::Draft {
            id: DraftId::new("draft-1"),
        };
        let last_draft_json = serde_json::to_value(&last_draft).unwrap();
        assert_eq!(last_draft_json["kind"], "draft");
        assert_eq!(
            serde_json::from_value::<LastOpenHome>(last_draft_json).unwrap(),
            last_draft
        );
    }
}
