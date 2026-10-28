//! The Desktop updater's wire types (contracts §2 and §3, 2.1-M242): what a
//! check offers, how a download reports progress, and the typed failure every
//! update command settles with. The codes are named as the failure catalogue
//! will name them, so 1a absorbs `UpdateFailure` without a rename (2.1-Q239).

use serde::{Deserialize, Serialize};
use specta::Type;

/// An update the channel offers this installer (contracts §3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct UpdateOffer {
    /// The offered version, as semver (`2.1.0`, `2.1.0-beta.2`).
    pub version: String,
    /// The release date the channel file states, RFC 3339, when it states one.
    pub date: Option<String>,
    /// The release's GitHub page, opened by About's "What's new" link (2.1-Q236).
    pub notes_url: String,
}

/// How much of the update payload has arrived; sent on `update_download`'s
/// channel, the updater's only stream (2.1-M208).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct UpdateProgress {
    /// Bytes received so far.
    pub received: u32,
    /// The payload's size when the server announced one.
    pub total: Option<u32>,
}

/// What a finished download leaves: a verified payload ready to install, or
/// only a link, when this installer cannot replace itself (no `pkexec` for a
/// `.deb`, an AppImage in a folder Canopi cannot write, the macOS app).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateDownload {
    /// The payload is in memory, its signature verified.
    Verified,
    /// Nothing was downloaded; About shows the link (2.1-Q232).
    LinkOnly {
        /// The page the update is downloaded from by hand.
        url: String,
    },
}

/// The update operation a failure belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum UpdateOp {
    /// Reading the channel file.
    #[serde(rename = "updater.check")]
    Check,
    /// Fetching and verifying the payload.
    #[serde(rename = "updater.download")]
    Download,
    /// Installing the verified payload.
    #[serde(rename = "updater.install")]
    Install,
}

/// The installer kind Canopi was installed from: the last part of the
/// channel file's `{os}-{arch}-{bundle}` key (2.1-M210).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UpdateBundle {
    /// The Debian package.
    Deb,
    /// The Linux AppImage.
    Appimage,
    /// The Windows NSIS installer.
    Nsis,
    /// The Windows MSI installer.
    Msi,
    /// The macOS app (from the dmg).
    App,
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

/// The executor lane a busy update operation waited on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UpdateLane {
    /// HTTP: the check and the download.
    Network,
    /// User files: the install's verify, temp write and replace.
    Local,
}

/// The updater's codes (contracts §2 updater row, 2.1-M210), with the shared
/// `network`, `io`, `cancelled`, `invalid`, `busy` and `internal` codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateFailureCode {
    /// The payload's signature failed, or a validly signed payload is not the
    /// announced newer version (2.1-M64).
    UpdateSignatureRefused,
    /// A newer release has no entry for this installer.
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
    /// A request failed.
    Network {
        /// Why it failed.
        network: NetworkFailureKind,
    },
    /// A file operation failed.
    Io {
        /// Why it failed.
        io: IoFailureKind,
    },
    /// The user cancelled; settled silently.
    Cancelled,
    /// The channel file or the request is malformed.
    Invalid,
    /// The lane was full.
    Busy {
        /// The lane that was full.
        lane: UpdateLane,
    },
    /// A fault in Canopi itself.
    Internal,
}

/// The operating system part of a channel key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UpdateOs {
    /// Linux.
    Linux,
    /// Windows.
    Windows,
    /// macOS, named `darwin` in the key as the updater names it.
    Darwin,
}

/// The architecture part of a channel key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UpdateArch {
    /// 64-bit x86.
    X86_64,
    /// 64-bit Arm.
    Aarch64,
}

/// A failed update command (contracts §2 wire shape): `code` is what the
/// interface maps to a message; `detail` is English for logs and Problem
/// Reports, never shown, and never holds a path or a URL with credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct UpdateFailure {
    /// The code the interface maps to a message.
    pub code: UpdateFailureCode,
    /// Whether the screen may offer Retry.
    pub user_may_retry: bool,
    /// The operation that failed.
    pub op: UpdateOp,
    /// English for logs and reports.
    pub detail: String,
}

impl UpdateFailure {
    /// A failure of `op` with `code`; whether Retry is offered follows the code.
    pub fn new(op: UpdateOp, code: UpdateFailureCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            user_may_retry: code.user_may_retry(),
            op,
            detail: detail.into(),
        }
    }
}

impl UpdateFailureCode {
    /// Retry helps a transient failure only: a network fault, a busy lane, a
    /// closed password prompt, an installer error.
    pub const fn user_may_retry(self) -> bool {
        matches!(
            self,
            Self::Network { .. }
                | Self::Busy { .. }
                | Self::UpdateAdminPromptDismissed
                | Self::UpdateInstallFailed { .. }
                | Self::Io { .. }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_update_failure_crosses_the_wire_in_the_contract_shape() {
        let offline = UpdateFailure::new(
            UpdateOp::Check,
            UpdateFailureCode::Network {
                network: NetworkFailureKind::Offline,
            },
            "connection refused",
        );
        assert_eq!(
            serde_json::to_value(&offline).unwrap(),
            serde_json::json!({
                "code": { "kind": "network", "network": "offline" },
                "user_may_retry": true,
                "op": "updater.check",
                "detail": "connection refused",
            })
        );
        let no_entry = UpdateFailure::new(
            UpdateOp::Check,
            UpdateFailureCode::UpdateNoChannelEntry {
                os: UpdateOs::Linux,
                arch: UpdateArch::X86_64,
                bundle: UpdateBundle::Appimage,
            },
            "no entry",
        );
        assert_eq!(
            serde_json::to_value(&no_entry).unwrap()["code"],
            serde_json::json!({
                "kind": "update_no_channel_entry", "os": "linux", "arch": "x86_64", "bundle": "appimage",
            })
        );
        assert_eq!(
            serde_json::to_value(UpdateFailureCode::UpdateInstallFailed {
                bundle: UpdateBundle::Deb
            })
            .unwrap(),
            serde_json::json!({ "kind": "update_install_failed", "bundle": "deb" })
        );
    }

    #[test]
    fn every_update_code_has_the_contract_name() {
        let names: Vec<String> = [
            UpdateFailureCode::UpdateSignatureRefused,
            UpdateFailureCode::UpdateAdminPromptUnavailable,
            UpdateFailureCode::UpdateAdminPromptDismissed,
            UpdateFailureCode::UpdateAdminPromptRefused,
            UpdateFailureCode::UpdateLocationNotWritable,
            UpdateFailureCode::Cancelled,
            UpdateFailureCode::Invalid,
            UpdateFailureCode::Internal,
            UpdateFailureCode::Io {
                io: IoFailureKind::NoSpace,
            },
            UpdateFailureCode::Busy {
                lane: UpdateLane::Network,
            },
        ]
        .into_iter()
        .map(|code| serde_json::to_value(code).unwrap()["kind"].as_str().unwrap().to_owned())
        .collect();
        assert_eq!(
            names,
            [
                "update_signature_refused",
                "update_admin_prompt_unavailable",
                "update_admin_prompt_dismissed",
                "update_admin_prompt_refused",
                "update_location_not_writable",
                "cancelled",
                "invalid",
                "internal",
                "io",
                "busy",
            ]
        );
    }

    #[test]
    fn a_cancelled_or_refused_update_offers_no_retry() {
        for code in [
            UpdateFailureCode::Cancelled,
            UpdateFailureCode::UpdateSignatureRefused,
            UpdateFailureCode::UpdateAdminPromptRefused,
            UpdateFailureCode::Invalid,
        ] {
            assert!(!code.user_may_retry(), "{code:?}");
        }
        assert!(
            UpdateFailureCode::Network {
                network: NetworkFailureKind::Timeout
            }
            .user_may_retry()
        );
    }

    #[test]
    fn a_download_outcome_is_tagged_by_kind() {
        assert_eq!(
            serde_json::to_value(UpdateDownload::LinkOnly {
                url: "https://projectcanopi.com".to_owned()
            })
            .unwrap(),
            serde_json::json!({ "kind": "link_only", "url": "https://projectcanopi.com" })
        );
        assert_eq!(
            serde_json::to_value(UpdateDownload::Verified).unwrap(),
            serde_json::json!({ "kind": "verified" })
        );
        assert_eq!(
            serde_json::to_value(UpdateOp::Install).unwrap(),
            serde_json::json!("updater.install")
        );
    }
}
