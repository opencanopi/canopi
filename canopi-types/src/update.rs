//! The Desktop updater's wire types (contracts §3, 2.1-M242): what a check
//! offers, how a download reports progress, and the op an update command's
//! catalogue `Failure` names. The updater's codes are catalogue rows
//! (`failure.rs`, contracts §2 updater row).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::failure::ops;

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

impl UpdateOp {
    /// The dotted op its failures name (contracts §2): the constant beside its command.
    pub const fn op(self) -> &'static str {
        match self {
            Self::Check => ops::UPDATER_CHECK,
            Self::Download => ops::UPDATER_DOWNLOAD,
            Self::Install => ops::UPDATER_INSTALL,
        }
    }
}

/// The catalogue codes an update command settles with (contracts §2 updater row, 2.1-M210):
/// its own `update_*` codes, the shared `network`, `io`, `cancelled`, `invalid` and `internal`,
/// and the executor's settlements. bindings-gen narrows the generated `UpdaterFailure` to
/// these kinds, so the updater's message map stays exhaustive over what it can receive.
pub const UPDATER_FAILURE_KINDS: &[&str] = &[
    "update_signature_refused",
    "update_no_channel_entry",
    "update_admin_prompt_unavailable",
    "update_admin_prompt_dismissed",
    "update_admin_prompt_refused",
    "update_location_not_writable",
    "update_install_failed",
    "network",
    "io",
    "cancelled",
    "invalid",
    "internal",
    "busy",
    "unavailable",
    "panicked",
    "join_failed",
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::failure::{Failure, FailureCode, FailureSource, NetworkFailureKind};
    use serde_json::json;

    #[test]
    fn every_update_code_has_the_contract_name() {
        let rows: Vec<&str> = FailureCode::ROWS.iter().map(|row| row.kind).collect();
        for kind in UPDATER_FAILURE_KINDS {
            assert!(rows.contains(kind), "{kind} is no catalogue row");
        }
        let own: Vec<&str> = FailureCode::ROWS
            .iter()
            .filter(|row| row.source == FailureSource::Updater)
            .map(|row| row.kind)
            .collect();
        assert_eq!(
            own,
            [
                "update_signature_refused",
                "update_no_channel_entry",
                "update_admin_prompt_unavailable",
                "update_admin_prompt_dismissed",
                "update_admin_prompt_refused",
                "update_location_not_writable",
                "update_install_failed",
            ]
        );
        for kind in own {
            assert!(UPDATER_FAILURE_KINDS.contains(&kind), "{kind}");
        }
        for (op, name) in [
            (UpdateOp::Check, "updater.check"),
            (UpdateOp::Download, "updater.download"),
            (UpdateOp::Install, "updater.install"),
        ] {
            assert_eq!(op.op(), name);
            assert_eq!(serde_json::to_value(op).unwrap(), serde_json::json!(name));
            assert!(ops::ALL.contains(&op.op()), "{name}");
        }
    }

    #[test]
    fn an_update_failure_crosses_the_wire_in_the_contract_shape() {
        let offline = Failure::new(
            FailureCode::Network {
                network: NetworkFailureKind::Offline,
            },
            ops::UPDATER_CHECK,
        );
        assert_eq!(
            serde_json::to_value(&offline).unwrap(),
            json!({
                "code": { "kind": "network", "network": "offline" },
                "user_may_retry": true,
                "op": "updater.check",
                "operation": null,
                "detail": null,
            })
        );
        let no_entry = FailureCode::UpdateNoChannelEntry {
            os: UpdateOs::Linux,
            arch: UpdateArch::X86_64,
            bundle: UpdateBundle::Appimage,
        };
        assert_eq!(
            serde_json::to_value(&no_entry).unwrap(),
            json!({
                "kind": "update_no_channel_entry", "os": "linux", "arch": "x86_64", "bundle": "appimage",
            })
        );
        let install_failed = FailureCode::UpdateInstallFailed {
            bundle: UpdateBundle::Deb,
        };
        assert_eq!(
            serde_json::to_value(&install_failed).unwrap(),
            json!({ "kind": "update_install_failed", "bundle": "deb" })
        );
        for code in [no_entry, install_failed] {
            let wire = serde_json::to_value(&code).unwrap();
            assert_eq!(serde_json::from_value::<FailureCode>(wire).unwrap(), code);
        }
        let detailed = offline.with_english("connection refused");
        assert!(
            detailed.detail.is_some(),
            "the line reaches logs and reports"
        );
    }

    #[test]
    fn a_cancelled_or_refused_update_offers_no_retry() {
        for code in [
            FailureCode::Cancelled,
            FailureCode::UpdateSignatureRefused,
            FailureCode::UpdateAdminPromptRefused,
            FailureCode::UpdateAdminPromptUnavailable,
            FailureCode::UpdateLocationNotWritable,
            FailureCode::Invalid,
        ] {
            assert!(!code.row().user_may_retry, "{code:?}");
        }
        for code in [
            FailureCode::Network {
                network: NetworkFailureKind::Timeout,
            },
            FailureCode::UpdateAdminPromptDismissed,
            FailureCode::UpdateInstallFailed {
                bundle: UpdateBundle::Nsis,
            },
        ] {
            assert!(code.row().user_may_retry, "{code:?}");
        }
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
