//! The failure catalogue (contracts §2; ADR 0025): one `Failure` per settlement, its
//! `code` tagged by `kind` with a code's own sub-kind under the code's name, generated to
//! TypeScript with the rows.
//!
//! Each code has one row in the `catalogue!` table: its source, `user_may_retry`,
//! `silent` and log level, plus an example value whose hand-written fixture
//! (`fixtures/failures/<kind>.json`) both languages read. The message is the frontend's
//! (2.1-M413). Each other code joins with its producer (2.1-M418).

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

/// The part of Canopi that produces a code (contracts §2's Source column).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FailureSource {
    /// The native executor's admission and settlement.
    Executor,
    /// The Desktop host: its windows and file dialogs.
    Host,
    /// A native service: a store, a file, a request.
    NativeService,
    /// The map and its sources.
    Map,
}

/// The level a settlement with a code is logged at (ADR 0025 Logs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FailureLogLevel {
    /// Expected and uneventful, such as a cancel.
    Debug,
    /// Expected under load or by the user's own action.
    Info,
    /// A failure Canopi recovers from.
    Warn,
    /// A fault in Canopi itself.
    Error,
}

/// One catalogue row: what Canopi does with every settlement of its code. The message
/// lives in the frontend's one map, keyed by the code's kind (2.1-M413).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CatalogueRow {
    /// The code's wire `kind`.
    #[serde(skip)]
    pub kind: &'static str,
    /// Who produces it.
    pub source: FailureSource,
    /// Whether the screen may offer Retry.
    pub user_may_retry: bool,
    /// Recorded but never shown: no notice and no message.
    pub silent: bool,
    /// The level its settlement is logged at.
    pub level: FailureLogLevel,
}

/// The catalogue table: one row per code with an example value for its fixture. A code
/// added to [`FailureCode`] without a row here does not compile ([`FailureCode::row`]).
macro_rules! catalogue {
    (@row $kind:literal, $source:ident, $retry:literal, $silent:literal, $level:ident) => {
        CatalogueRow {
            kind: $kind,
            source: FailureSource::$source,
            user_may_retry: $retry,
            silent: $silent,
            level: FailureLogLevel::$level,
        }
    };
    ($(
        $variant:ident $({ $($field:ident: $example:expr),+ $(,)? })? => $kind:literal,
            $source:ident, retry: $retry:literal, silent: $silent:literal, $level:ident;
    )+) => {
        impl FailureCode {
            /// Every row, in declaration order.
            pub const ROWS: &'static [CatalogueRow] = &[$(catalogue!(@row $kind, $source, $retry, $silent, $level),)+];

            /// This code's catalogue row.
            pub fn row(&self) -> &'static CatalogueRow {
                match self {
                    $(Self::$variant { .. } => &catalogue!(@row $kind, $source, $retry, $silent, $level),)+
                }
            }

            /// One value of each code, in row order: the fixtures' codes.
            pub fn examples() -> Vec<FailureCode> {
                vec![$(Self::$variant $({ $($field: $example),+ })?,)+]
            }
        }
    };
}

catalogue! {
    Busy { lane: Lane::Library } => "busy", Executor, retry: true, silent: false, Info;
    Cancelled => "cancelled", Executor, retry: false, silent: true, Debug;
    Unavailable => "unavailable", Executor, retry: false, silent: false, Warn;
    Panicked => "panicked", Executor, retry: false, silent: false, Error;
    JoinFailed => "join_failed", Executor, retry: false, silent: false, Error;
    DialogAlreadyOpen => "dialog_already_open", Host, retry: false, silent: true, Info;
    PlantDbUnavailable { cause: PlantCatalogCause::Missing } => "plant_db_unavailable",
        NativeService, retry: false, silent: false, Warn;
    LibraryReadOnly { reason: LibraryReadOnlyReason::RefusedNewer } => "library_read_only",
        NativeService, retry: false, silent: false, Warn;
    Io { io: IoFailureKind::NoSpace } => "io", NativeService, retry: true, silent: false, Warn;
    Network { network: NetworkFailureKind::Offline } => "network",
        NativeService, retry: true, silent: false, Warn;
    Invalid => "invalid", NativeService, retry: false, silent: false, Warn;
    Internal => "internal", NativeService, retry: false, silent: false, Error;
    StyleFailed => "style_failed", Map, retry: true, silent: true, Warn;
    TileSourceFailed { layer: "satellite".to_owned() } => "tile_source_failed",
        Map, retry: true, silent: true, Warn;
}

impl Failure {
    /// A failure of `op` with `code`, its Retry offer from the code's row; no operation id
    /// and no detail until the caller adds them.
    pub fn new(code: FailureCode, op: &'static str) -> Self {
        let user_may_retry = code.row().user_may_retry;
        Self {
            code,
            user_may_retry,
            op,
            operation: None,
            detail: None,
        }
    }

    /// The same failure, belonging to `operation`.
    pub fn with_operation(self, operation: OperationId) -> Self {
        Self {
            operation: Some(operation),
            ..self
        }
    }

    /// The same failure, with redacted English for logs and reports.
    pub fn with_detail(self, detail: RedactedText) -> Self {
        Self {
            detail: Some(detail),
            ..self
        }
    }
}

/// The dotted op of each typed command, beside which its failures are named (2.1-M420):
/// `<area>.<action>` in lower snake case, each unique.
pub mod ops {
    /// `pick_open`: the host's Open dialog.
    pub const DIALOG_PICK_OPEN: &str = "dialog.pick_open";
    /// `pick_save`: the host's Save dialog.
    pub const DIALOG_PICK_SAVE: &str = "dialog.pick_save";

    /// Every op constant.
    pub const ALL: &[&str] = &[DIALOG_PICK_OPEN, DIALOG_PICK_SAVE];
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
impl From<std::io::ErrorKind> for IoFailureKind {
    fn from(kind: std::io::ErrorKind) -> Self {
        use std::io::ErrorKind;
        match kind {
            ErrorKind::NotFound => Self::NotFound,
            ErrorKind::PermissionDenied => Self::PermissionDenied,
            ErrorKind::ReadOnlyFilesystem => Self::ReadOnly,
            ErrorKind::StorageFull | ErrorKind::QuotaExceeded => Self::NoSpace,
            ErrorKind::FileTooLarge => Self::TooLarge,
            _ => Self::Other,
        }
    }
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

    /// The op every fixture's failure names.
    const FIXTURE_OP: &str = "fixtures.example";

    fn fixture_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/failures")
    }

    fn wire_kind(code: &FailureCode) -> String {
        serde_json::to_value(code).unwrap()["kind"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn every_row_names_its_codes_wire_kind_once() {
        let examples = FailureCode::examples();
        assert_eq!(examples.len(), FailureCode::ROWS.len());
        for (example, row) in examples.iter().zip(FailureCode::ROWS) {
            assert_eq!(wire_kind(example), row.kind);
            assert_eq!(example.row(), row, "{}", row.kind);
        }
        let mut kinds: Vec<_> = FailureCode::ROWS.iter().map(|row| row.kind).collect();
        kinds.sort_unstable();
        kinds.dedup();
        assert_eq!(kinds.len(), FailureCode::ROWS.len(), "a kind has two rows");
    }

    #[test]
    fn a_silent_row_is_recorded_and_never_shown() {
        let silent: Vec<_> = FailureCode::ROWS
            .iter()
            .filter(|row| row.silent)
            .map(|row| row.kind)
            .collect();
        assert_eq!(
            silent,
            [
                "cancelled",
                "dialog_already_open",
                "style_failed",
                "tile_source_failed"
            ]
        );
        assert_eq!(
            FailureCode::DialogAlreadyOpen.row().level,
            FailureLogLevel::Info
        );
    }

    #[test]
    fn a_failure_takes_its_retry_offer_from_its_row() {
        let busy = Failure::new(
            FailureCode::Busy {
                lane: Lane::Network,
            },
            "dialog.pick_open",
        );
        let panicked = Failure::new(FailureCode::Panicked, "dialog.pick_open");
        assert!(busy.user_may_retry);
        assert!(!panicked.user_may_retry);
        assert_eq!((busy.operation, busy.detail), (None, None));
    }

    #[test]
    fn an_io_error_kind_maps_onto_the_catalogues_io_kinds() {
        use std::io::ErrorKind;
        let cases = [
            (ErrorKind::NotFound, IoFailureKind::NotFound),
            (ErrorKind::PermissionDenied, IoFailureKind::PermissionDenied),
            (ErrorKind::ReadOnlyFilesystem, IoFailureKind::ReadOnly),
            (ErrorKind::StorageFull, IoFailureKind::NoSpace),
            (ErrorKind::QuotaExceeded, IoFailureKind::NoSpace),
            (ErrorKind::FileTooLarge, IoFailureKind::TooLarge),
            (ErrorKind::InvalidData, IoFailureKind::Other),
            (ErrorKind::Interrupted, IoFailureKind::Other),
        ];
        for (kind, expected) in cases {
            assert_eq!(IoFailureKind::from(kind), expected, "{kind:?}");
        }
    }

    /// Fixtures are hand-written, read by Rust here and by the frontend (contracts §2): a
    /// code with no fixture, a fixture for no code, or a fixture that drifted from its
    /// code's wire shape and row fails naming the code.
    #[test]
    fn every_code_has_a_fixture() {
        let dir = fixture_dir();
        let mut stale: Vec<String> = std::fs::read_dir(&dir)
            .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        for code in FailureCode::examples() {
            let kind = code.row().kind;
            let file = format!("{kind}.json");
            stale.retain(|name| name != &file);
            let text = std::fs::read_to_string(dir.join(&file))
                .unwrap_or_else(|_| panic!("{kind} has no fixture {file}"));
            let fixture: serde_json::Value = serde_json::from_str(&text)
                .unwrap_or_else(|error| panic!("{kind}: its fixture is not JSON: {error}"));
            let expected = serde_json::to_value(Failure::new(code, FIXTURE_OP)).unwrap();
            assert_eq!(fixture, expected, "{kind}: its fixture drifted");
        }
        assert!(stale.is_empty(), "fixtures for no code: {stale:?}");
    }

    #[test]
    fn every_op_is_a_unique_dotted_lower_snake_case_name() {
        let part = |text: &str| {
            !text.is_empty() && text.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        };
        for op in ops::ALL {
            let shaped = op
                .split_once('.')
                .is_some_and(|(area, action)| part(area) && part(action));
            assert!(shaped, "{op} is not <area>.<action>");
        }
        let mut sorted = ops::ALL.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ops::ALL.len(), "an op is named twice");
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
