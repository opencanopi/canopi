//! The failure catalogue's wire shape (contracts §2; ADR 0025): one `Failure`
//! per settlement, its `code` tagged by `kind` with a code's own sub-kind
//! under the code's name, generated to TypeScript.
//!
//! Commit 0 of Phase 1 lands the shell: the starting codes (2.1-M418), the
//! lanes, the operation id and the redacted detail. Phase 1's 1a fills the
//! rows (source, `user_may_retry`, `silent`, log level), the per-code
//! fixtures, the op constants and the operation id's mint and validation; each
//! other code joins with its producer.

pub use canopi_redact::RedactedText;
use serde::{Deserialize, Serialize};
use specta::Type;

/// A failed settlement as it crosses the seam: what the interface maps to a
/// message (`code`), whether the screen may offer Retry, the dotted operation
/// that failed, the user action or system work it belongs to, and redacted
/// English for logs and reports, never shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Failure {
    /// The code the interface maps to a message.
    pub code: FailureCode,
    /// Whether the screen may offer Retry.
    pub user_may_retry: bool,
    /// The dotted operation (`library.delete_item`), a constant beside its command.
    pub op: &'static str,
    /// The user action or system work this settlement belongs to; minted by
    /// Rust system work in Phase 1 and required from 2a (2.1-M411).
    pub operation: Option<OperationId>,
    /// Redacted English for logs and reports.
    pub detail: Option<RedactedText>,
}

/// The catalogue's codes produced at Phase 1's close, plus the map codes
/// WEB-06's observers report (contracts §2, 2.1-M418).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FailureCode {
    /// The lane was full.
    Busy {
        /// The lane that was full.
        lane: Lane,
    },
    /// The work was cancelled; settled silently.
    Cancelled,
    /// The executor is shutting down or closed.
    Unavailable,
    /// The work panicked.
    Panicked,
    /// The work's task could not be joined.
    JoinFailed,
    /// A file dialog is already open in this window.
    DialogAlreadyOpen,
    /// The plant catalog could not be read.
    PlantDbUnavailable {
        /// Why.
        cause: PlantCatalogCause,
    },
    /// The Data library is read-only for the session.
    LibraryReadOnly {
        /// Why.
        reason: LibraryReadOnlyReason,
    },
    /// A file operation failed.
    Io {
        /// Why it failed.
        io: IoFailureKind,
    },
    /// A request failed.
    Network {
        /// Why it failed.
        network: NetworkFailureKind,
    },
    /// The request is malformed.
    Invalid,
    /// A fault in Canopi itself.
    Internal,
    /// The map style failed to load; silent until 2d's map status (2.1-Q300).
    StyleFailed,
    /// A map tile source failed; silent until 2d's map status (2.1-Q300).
    TileSourceFailed {
        /// The map layer whose source failed.
        layer: String,
    },
}

/// The executor lanes, by their target names (2.1-M420).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Lane {
    /// The plant catalog.
    Catalog,
    /// The user database: favourites, stamps, settings, recent files.
    UserData,
    /// The Data library (today's raster lane).
    Library,
    /// User files: Designs, Drafts, exports.
    Local,
    /// HTTP.
    Network,
}

/// Why the plant catalog is unavailable (Phase 1's causes, 2.1-M429).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PlantCatalogCause {
    /// No catalog file was found.
    Missing,
    /// The file was found but could not be opened or admitted.
    OpenFailed,
}

/// Why the Data library is read-only for the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LibraryReadOnlyReason {
    /// The catalogue was written by a newer Canopi and is left untouched.
    RefusedNewer,
    /// The catalogue could be neither opened nor rebuilt.
    Unavailable,
}

/// Why a network request failed (contracts §2 `network.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum NetworkFailureKind {
    /// No answer in time, or no progress for the stall timeout.
    Timeout,
    /// The host could not be reached.
    Offline,
    /// The server answered with an error status.
    Status,
    /// A redirect or a payload URL left the allowed hosts.
    HostNotAllowed,
    /// The payload is larger than its cap.
    TooLarge,
}

/// Why a file operation failed (contracts §2 `io.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum IoFailureKind {
    /// Nothing at the path.
    NotFound,
    /// The system refused access.
    PermissionDenied,
    /// The location is read-only.
    ReadOnly,
    /// The disk is full.
    NoSpace,
    /// The content is larger than allowed.
    TooLarge,
    /// Any other file error.
    Other,
}
/// The user action or system work a settlement belongs to: `u-` or `s-`
/// (user or system origin) before a uuid v4, opaque and never logged raw
/// (2.1-M420). A branded string in TypeScript. Phase 1's 1a adds the system
/// mint and the parse that refuses anything else as `invalid`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(transparent)]
pub struct OperationId(String);

impl OperationId {
    /// The id's text, for the log layer's own redacted field only.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_code_tags_its_kind_and_nests_its_sub_kind_under_its_name() {
        let cases = [
            (
                FailureCode::Busy {
                    lane: Lane::Library,
                },
                json!({ "kind": "busy", "lane": "library" }),
            ),
            (FailureCode::Cancelled, json!({ "kind": "cancelled" })),
            (
                FailureCode::Io {
                    io: IoFailureKind::NoSpace,
                },
                json!({ "kind": "io", "io": "no_space" }),
            ),
            (
                FailureCode::Network {
                    network: NetworkFailureKind::HostNotAllowed,
                },
                json!({ "kind": "network", "network": "host_not_allowed" }),
            ),
            (
                FailureCode::PlantDbUnavailable {
                    cause: PlantCatalogCause::OpenFailed,
                },
                json!({ "kind": "plant_db_unavailable", "cause": "open_failed" }),
            ),
            (
                FailureCode::TileSourceFailed {
                    layer: "satellite".to_owned(),
                },
                json!({ "kind": "tile_source_failed", "layer": "satellite" }),
            ),
        ];
        for (code, expected) in cases {
            assert_eq!(serde_json::to_value(&code).unwrap(), expected);
            assert_eq!(
                serde_json::from_value::<FailureCode>(expected).unwrap(),
                code
            );
        }
    }

    #[test]
    fn a_failure_crosses_the_seam_with_every_wire_field() {
        let failure = Failure {
            code: FailureCode::Busy {
                lane: Lane::UserData,
            },
            user_may_retry: true,
            op: "settings.load",
            operation: None,
            detail: None,
        };
        assert_eq!(
            serde_json::to_value(&failure).unwrap(),
            json!({
                "code": { "kind": "busy", "lane": "user_data" },
                "user_may_retry": true,
                "op": "settings.load",
                "operation": null,
                "detail": null,
            })
        );
    }
}
