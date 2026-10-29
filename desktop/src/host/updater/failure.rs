//! The updater plugin's errors as contracts §2's codes (2.1-M210). Each `detail` is a fixed English
//! line, so it never carries a path, an announced URL or anything else the plugin's own message
//! might hold.

use common_types::update::{
    IoFailureKind, NetworkFailureKind, UpdateBundle, UpdateFailure, UpdateFailureCode, UpdateLane,
    UpdateOp,
};
use tauri_plugin_updater::Error;

use super::channel::Installation;

/// A failure of `op`.
pub fn failure(op: UpdateOp, code: UpdateFailureCode, detail: &str) -> UpdateFailure {
    UpdateFailure::new(op, code, detail)
}

/// A network failure of `op`.
pub fn network(op: UpdateOp, kind: NetworkFailureKind, detail: &str) -> UpdateFailure {
    failure(op, UpdateFailureCode::Network { network: kind }, detail)
}

/// The cancelled settlement, silent on screen.
pub fn cancelled(op: UpdateOp) -> UpdateFailure {
    failure(op, UpdateFailureCode::Cancelled, "cancelled by the user")
}

/// An executor refusal as a failure: a full lane is `busy`, anything else `internal`. Until N0's
/// `OpSpec` the executor answers with text; its busy line is the one it shares with every class.
pub fn executor(op: UpdateOp, lane: UpdateLane, message: &str) -> UpdateFailure {
    if message.ends_with("operations are busy; try again") {
        failure(op, UpdateFailureCode::Busy { lane }, "the lane was full")
    } else {
        failure(op, UpdateFailureCode::Internal, "the executor failed")
    }
}

/// The `io.kind` of a file error.
pub fn io_kind(kind: std::io::ErrorKind) -> IoFailureKind {
    match kind {
        std::io::ErrorKind::NotFound => IoFailureKind::NotFound,
        std::io::ErrorKind::PermissionDenied => IoFailureKind::PermissionDenied,
        std::io::ErrorKind::ReadOnlyFilesystem => IoFailureKind::ReadOnly,
        std::io::ErrorKind::StorageFull => IoFailureKind::NoSpace,
        std::io::ErrorKind::FileTooLarge => IoFailureKind::TooLarge,
        _ => IoFailureKind::Other,
    }
}

/// A file error of `op`.
pub fn io(op: UpdateOp, error: &std::io::Error, detail: &str) -> UpdateFailure {
    failure(
        op,
        UpdateFailureCode::Io {
            io: io_kind(error.kind()),
        },
        detail,
    )
}

/// The plugin's `error` while `op` ran for `installation`.
pub fn from_plugin(op: UpdateOp, installation: Installation, error: &Error) -> UpdateFailure {
    use NetworkFailureKind as Net;
    match error {
        Error::Reqwest(request) => {
            let (kind, detail) = if request.is_timeout() {
                (Net::Timeout, "the request timed out")
            } else if request.is_redirect() {
                (Net::HostNotAllowed, "a redirect left the allowed hosts")
            } else if request.is_status() {
                (Net::Status, "the server answered with an error status")
            } else if request.is_decode() {
                return failure(op, UpdateFailureCode::Invalid, "the answer is malformed");
            } else {
                (Net::Offline, "the host could not be reached")
            };
            network(op, kind, detail)
        }
        // The plugin keeps no status for a channel file it could not fetch, nor for a payload.
        Error::ReleaseNotFound | Error::Network(_) => {
            network(op, Net::Status, "the server answered with an error status")
        }
        Error::Serialization(_) | Error::Semver(_) | Error::UrlParse(_) => failure(
            op,
            UpdateFailureCode::Invalid,
            "the channel file is malformed",
        ),
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => failure(
            op,
            UpdateFailureCode::UpdateNoChannelEntry {
                os: installation.os,
                arch: installation.arch,
                bundle: installation.bundle,
            },
            "the newer release has no entry for this installer",
        ),
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => failure(
            op,
            UpdateFailureCode::UpdateSignatureRefused,
            "the payload's signature was refused",
        ),
        Error::Io(io_error) if op == UpdateOp::Install => install_io(installation, io_error),
        Error::Io(io_error) => io(op, io_error, "a file operation failed"),
        Error::InvalidUpdaterFormat
        | Error::BinaryNotFoundInArchive
        | Error::PreviousAppNotRestored(_)
        | Error::TempDirNotOnSameMountPoint
        | Error::TempDirNotFound
        | Error::DebInstallFailed
        | Error::PackageInstallFailed
        | Error::AuthenticationFailed => install_failed(installation.bundle),
        _ => failure(op, UpdateFailureCode::Internal, "the updater failed"),
    }
}

/// An install's file error: a location Canopi may not write is `update_location_not_writable`,
/// anything else the installer's failure.
fn install_io(installation: Installation, error: &std::io::Error) -> UpdateFailure {
    match io_kind(error.kind()) {
        IoFailureKind::PermissionDenied | IoFailureKind::ReadOnly => failure(
            UpdateOp::Install,
            UpdateFailureCode::UpdateLocationNotWritable,
            "Canopi's location cannot be written",
        ),
        _ => install_failed(installation.bundle),
    }
}

/// The installer's failure.
pub fn install_failed(bundle: UpdateBundle) -> UpdateFailure {
    failure(
        UpdateOp::Install,
        UpdateFailureCode::UpdateInstallFailed { bundle },
        "the installer reported an error",
    )
}

#[cfg(test)]
mod tests {
    use super::{Installation, executor, from_plugin};
    use common_types::update::{
        IoFailureKind, UpdateArch, UpdateBundle, UpdateFailureCode, UpdateLane, UpdateOp, UpdateOs,
    };
    use tauri_plugin_updater::Error;

    const APPIMAGE: Installation = Installation {
        os: UpdateOs::Linux,
        arch: UpdateArch::X86_64,
        bundle: UpdateBundle::Appimage,
    };

    #[test]
    fn plugin_errors_settle_as_the_contract_codes() {
        let denied = || std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        for (op, error, code) in [
            (
                UpdateOp::Check,
                Error::TargetsNotFound(vec!["linux-x86_64-appimage".to_owned()]),
                UpdateFailureCode::UpdateNoChannelEntry {
                    os: UpdateOs::Linux,
                    arch: UpdateArch::X86_64,
                    bundle: UpdateBundle::Appimage,
                },
            ),
            (
                UpdateOp::Download,
                Error::MissingSignedVersion,
                UpdateFailureCode::UpdateSignatureRefused,
            ),
            (
                UpdateOp::Install,
                Error::Io(denied()),
                UpdateFailureCode::UpdateLocationNotWritable,
            ),
            (
                UpdateOp::Download,
                Error::Io(denied()),
                UpdateFailureCode::Io {
                    io: IoFailureKind::PermissionDenied,
                },
            ),
            (
                UpdateOp::Install,
                Error::PreviousAppNotRestored("/home/someone/Canopi.AppImage".into()),
                UpdateFailureCode::UpdateInstallFailed {
                    bundle: UpdateBundle::Appimage,
                },
            ),
            (
                UpdateOp::Check,
                Error::EmptyEndpoints,
                UpdateFailureCode::Internal,
            ),
        ] {
            let failure = from_plugin(op, APPIMAGE, &error);
            assert_eq!(failure.code, code, "{error}");
            assert_eq!(failure.op, op);
            assert!(!failure.detail.contains("/home"), "{}", failure.detail);
        }
    }

    #[test]
    fn a_full_lane_is_busy_and_any_other_executor_refusal_internal() {
        assert_eq!(
            executor(
                UpdateOp::Check,
                UpdateLane::Network,
                "Native network operations are busy; try again"
            )
            .code,
            UpdateFailureCode::Busy {
                lane: UpdateLane::Network
            }
        );
        assert_eq!(
            executor(UpdateOp::Install, UpdateLane::Local, "task failed").code,
            UpdateFailureCode::Internal
        );
    }
}
