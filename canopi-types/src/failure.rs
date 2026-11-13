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

use crate::health::StoreId;
use crate::update::{UpdateArch, UpdateBundle, UpdateOs};

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
/// WEB-06's observers report (contracts §2, 2.1-M418) and the reader release's
/// format core and read-only store codes (Step 2.0.4's commit 0).
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
    /// The update payload's signature failed, or a validly signed payload is not the
    /// announced newer version (2.1-M64).
    UpdateSignatureRefused,
    /// A newer release has no entry for this installer; About shows the download link.
    UpdateNoChannelEntry {
        /// The operating system part of the key (`linux`, `windows`, `darwin`).
        os: UpdateOs,
        /// The architecture part of the key (`x86_64`, `aarch64`).
        arch: UpdateArch,
        /// The installer part of the key.
        bundle: UpdateBundle,
    },
    /// No `pkexec` to ask for the administrator password (2.1-Q232).
    UpdateAdminPromptUnavailable,
    /// The password prompt was closed (pkexec exit 126).
    UpdateAdminPromptDismissed,
    /// The system refused the request (pkexec exit 127).
    UpdateAdminPromptRefused,
    /// Canopi's own location cannot be written.
    UpdateLocationNotWritable,
    /// The installer reported an error.
    UpdateInstallFailed {
        /// The installer that failed.
        bundle: UpdateBundle,
    },
    /// The format core's `.wasm` failed to load or instantiate; Retry loads it once (ADR 0025, 2.1-M477).
    FormatCoreUnavailable,
    /// The format core trapped; `detail` holds the panic message or `trapped` (ADR 0025).
    FormatCoreTrapped,
    /// A write refused by a store read as newer-read-only; silent, since the store's one notice says it
    /// (2.1-M487).
    StoreReadOnly {
        /// The store that refused the write.
        store: StoreId,
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
    /// The Desktop updater (contracts §2 updater row, 2.1-M210).
    Updater,
    /// The format core's worker adapter (Web only until 2b, 2.1-M476).
    FormatCore,
    /// A store read as newer-read-only, on both editions (2.1-M487).
    ReadOnlyStore,
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
    LibraryReadOnly { reason: LibraryReadOnlyReason::Unavailable } => "library_read_only",
        NativeService, retry: false, silent: false, Warn;
    Io { io: IoFailureKind::NoSpace } => "io", NativeService, retry: true, silent: false, Warn;
    Network { network: NetworkFailureKind::Offline } => "network",
        NativeService, retry: true, silent: false, Warn;
    Invalid => "invalid", NativeService, retry: false, silent: false, Warn;
    Internal => "internal", NativeService, retry: false, silent: false, Error;
    StyleFailed => "style_failed", Map, retry: true, silent: true, Warn;
    TileSourceFailed { layer: "satellite".to_owned() } => "tile_source_failed",
        Map, retry: true, silent: true, Warn;
    UpdateSignatureRefused => "update_signature_refused", Updater, retry: false, silent: false, Warn;
    UpdateNoChannelEntry {
        os: UpdateOs::Linux,
        arch: UpdateArch::X86_64,
        bundle: UpdateBundle::Appimage,
    } => "update_no_channel_entry", Updater, retry: false, silent: false, Info;
    UpdateAdminPromptUnavailable => "update_admin_prompt_unavailable",
        Updater, retry: false, silent: false, Info;
    UpdateAdminPromptDismissed => "update_admin_prompt_dismissed",
        Updater, retry: true, silent: false, Info;
    UpdateAdminPromptRefused => "update_admin_prompt_refused",
        Updater, retry: false, silent: false, Info;
    UpdateLocationNotWritable => "update_location_not_writable",
        Updater, retry: false, silent: false, Warn;
    UpdateInstallFailed { bundle: UpdateBundle::Deb } => "update_install_failed",
        Updater, retry: true, silent: false, Warn;
    FormatCoreUnavailable => "format_core_unavailable", FormatCore, retry: true, silent: false, Warn;
    FormatCoreTrapped => "format_core_trapped", FormatCore, retry: true, silent: false, Error;
    StoreReadOnly { store: StoreId::UserDb } => "store_read_only",
        ReadOnlyStore, retry: false, silent: true, Info;
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

    /// The same failure, with `english` for logs and reports after the generic redactor:
    /// a fixed line naming what failed, never the text a library's own error holds.
    pub fn with_english(self, english: &str) -> Self {
        self.with_detail(canopi_redact::Redactor::generic().redact(english))
    }
}

/// The dotted op of each typed command, beside which its failures are named (2.1-M420):
/// `<area>.<action>` in lower snake case, each unique.
pub mod ops {
    /// `pick_open`: the host's Open dialog.
    pub const DIALOG_PICK_OPEN: &str = "dialog.pick_open";
    /// `pick_save`: the host's Save dialog.
    pub const DIALOG_PICK_SAVE: &str = "dialog.pick_save";
    /// `pick_geojson_file` and the other host-read dialogs: a file the host reads itself.
    pub const DIALOG_PICK_HOST_READ: &str = "dialog.pick_host_read";
    /// `update_check`: reading the update channel file.
    pub const UPDATER_CHECK: &str = "updater.check";
    /// `update_download`: fetching and verifying the update payload.
    pub const UPDATER_DOWNLOAD: &str = "updater.download";
    /// `update_install`: installing the verified payload.
    pub const UPDATER_INSTALL: &str = "updater.install";
    /// `create_problem_report`: writing the report zip.
    pub const PROBLEM_REPORT_CREATE: &str = "problem_report.create";
    /// `show_problem_report`: revealing a written report in the file manager.
    pub const PROBLEM_REPORT_SHOW: &str = "problem_report.show";
    /// Reading the settings summary a report carries.
    pub const PROBLEM_REPORT_READ_SETTINGS: &str = "problem_report.read_settings";
    /// System origin: opening the daily log folder at startup.
    pub const LOGGING_OPEN: &str = "logging.open";
    /// System origin: a database handle's lock found poisoned.
    pub const DB_LOCK: &str = "db.lock";
    /// System origin: opening the plant catalog at startup.
    pub const PLANT_CATALOG_OPEN: &str = "plant_catalog.open";
    /// System origin: opening the image cache at startup.
    pub const IMAGE_CACHE_OPEN: &str = "image_cache.open";
    /// System origin: the Tauri application's run loop.
    pub const APP_RUN: &str = "app.run";

    /// Every op constant.
    pub const ALL: &[&str] = &[
        DIALOG_PICK_OPEN,
        DIALOG_PICK_SAVE,
        DIALOG_PICK_HOST_READ,
        UPDATER_CHECK,
        UPDATER_DOWNLOAD,
        UPDATER_INSTALL,
        PROBLEM_REPORT_CREATE,
        PROBLEM_REPORT_SHOW,
        PROBLEM_REPORT_READ_SETTINGS,
        LOGGING_OPEN,
        DB_LOCK,
        PLANT_CATALOG_OPEN,
        IMAGE_CACHE_OPEN,
        APP_RUN,
    ];
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
/// (user or system origin) before a lowercase hyphenated uuid v4, opaque and
/// never logged raw (2.1-M420): its `Debug` shows the origin only. A branded
/// string in TypeScript. Rust mints the system ids of its own work; user ids
/// arrive from the frontend's minters in 2a (2.1-M411), parsed on the way in.
#[derive(Clone, PartialEq, Eq, Serialize, Type)]
#[serde(transparent)]
pub struct OperationId(String);

impl OperationId {
    /// A fresh id for work Rust starts itself, not for a user action; Desktop only (`system-ids`), since minting
    /// needs a randomness source the wasm32 build has none of.
    #[cfg(any(test, feature = "system-ids"))]
    pub fn system() -> Self {
        Self(format!("s-{}", uuid::Uuid::new_v4().hyphenated()))
    }

    /// The id `text` names, or [`InvalidOperationId`] (settled as `invalid`) for
    /// anything but `u-` or `s-` before a lowercase hyphenated uuid v4.
    pub fn parse(text: &str) -> Result<Self, InvalidOperationId> {
        let id = text
            .strip_prefix("u-")
            .or_else(|| text.strip_prefix("s-"))
            .ok_or(InvalidOperationId)?;
        let uuid = uuid::Uuid::try_parse(id).map_err(|_| InvalidOperationId)?;
        let canonical = uuid.hyphenated().to_string() == id;
        let random = uuid.get_version() == Some(uuid::Version::Random)
            && uuid.get_variant() == uuid::Variant::RFC4122;
        if canonical && random {
            Ok(Self(text.to_owned()))
        } else {
            Err(InvalidOperationId)
        }
    }

    /// The id's text, for the log layer's own redacted field only.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for OperationId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let origin = self.0.get(..2).unwrap_or_default();
        write!(f, "OperationId({origin}…)")
    }
}

impl<'de> Deserialize<'de> for OperationId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::parse(&text).map_err(serde::de::Error::custom)
    }
}

/// A text that is not an [`OperationId`]; it never carries the text it refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidOperationId;

impl std::fmt::Display for InvalidOperationId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("an operation id is u- or s- before a uuid v4")
    }
}

impl std::error::Error for InvalidOperationId {}

impl From<InvalidOperationId> for FailureCode {
    fn from(_: InvalidOperationId) -> Self {
        Self::Invalid
    }
}

#[cfg(test)]
mod tests;
