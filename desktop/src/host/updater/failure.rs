//! The updater plugin's errors as catalogue codes (contracts §2 updater row, 2.1-M210). Each
//! `detail` is a fixed English line, so it never carries a path, an announced URL or anything else
//! the plugin's own message might hold. An executor settlement reaches the updater's commands
//! through the catalogue's own `From<ExecutorError>`, its op the run's.

use canopi_types::{
    failure::{Failure, FailureCode, IoFailureKind, NetworkFailureKind},
    update::{UpdateBundle, UpdateOp},
};
use tauri_plugin_updater::Error;

use super::channel::Installation;

/// A failure of `op`.
pub fn failure(op: UpdateOp, code: FailureCode, detail: &str) -> Failure {
    Failure::new(code, op.op()).with_english(detail)
}

/// A network failure of `op`.
pub fn network(op: UpdateOp, kind: NetworkFailureKind, detail: &str) -> Failure {
    failure(op, FailureCode::Network { network: kind }, detail)
}

/// The cancelled settlement, silent on screen.
pub fn cancelled(op: UpdateOp) -> Failure {
    failure(op, FailureCode::Cancelled, "cancelled by the user")
}

/// A file error of `op`.
pub fn io(op: UpdateOp, error: &std::io::Error, detail: &str) -> Failure {
    failure(
        op,
        FailureCode::Io {
            io: error.kind().into(),
        },
        detail,
    )
}

/// The plugin's `error` while `op` ran for `installation`.
pub fn from_plugin(op: UpdateOp, installation: Installation, error: &Error) -> Failure {
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
                return failure(op, FailureCode::Invalid, "the answer is malformed");
            } else {
                (Net::Offline, "the host could not be reached")
            };
            network(op, kind, detail)
        }
        // The plugin keeps no status for a channel file it could not fetch, nor for a payload.
        Error::ReleaseNotFound | Error::Network(_) => {
            network(op, Net::Status, "the server answered with an error status")
        }
        Error::Serialization(_) | Error::Semver(_) | Error::UrlParse(_) => {
            failure(op, FailureCode::Invalid, "the channel file is malformed")
        }
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => failure(
            op,
            FailureCode::UpdateNoChannelEntry {
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
            FailureCode::UpdateSignatureRefused,
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
        _ => failure(op, FailureCode::Internal, "the updater failed"),
    }
}

/// An install's file error: a location Canopi may not write is `update_location_not_writable`,
/// anything else the installer's failure.
pub(super) fn install_io(installation: Installation, error: &std::io::Error) -> Failure {
    match IoFailureKind::from(error.kind()) {
        IoFailureKind::PermissionDenied | IoFailureKind::ReadOnly => failure(
            UpdateOp::Install,
            FailureCode::UpdateLocationNotWritable,
            "Canopi's location cannot be written",
        ),
        _ => install_failed(installation.bundle),
    }
}

/// The installer's failure.
pub fn install_failed(bundle: UpdateBundle) -> Failure {
    failure(
        UpdateOp::Install,
        FailureCode::UpdateInstallFailed { bundle },
        "the installer reported an error",
    )
}

#[cfg(test)]
mod tests {
    use super::{Installation, from_plugin};
    use canopi_types::{
        failure::{FailureCode, IoFailureKind},
        update::{UpdateArch, UpdateBundle, UpdateOp, UpdateOs},
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
                FailureCode::UpdateNoChannelEntry {
                    os: UpdateOs::Linux,
                    arch: UpdateArch::X86_64,
                    bundle: UpdateBundle::Appimage,
                },
            ),
            (
                UpdateOp::Download,
                Error::MissingSignedVersion,
                FailureCode::UpdateSignatureRefused,
            ),
            (
                UpdateOp::Install,
                Error::Io(denied()),
                FailureCode::UpdateLocationNotWritable,
            ),
            (
                UpdateOp::Download,
                Error::Io(denied()),
                FailureCode::Io {
                    io: IoFailureKind::PermissionDenied,
                },
            ),
            (
                UpdateOp::Install,
                Error::PreviousAppNotRestored("/home/someone/Canopi.AppImage".into()),
                FailureCode::UpdateInstallFailed {
                    bundle: UpdateBundle::Appimage,
                },
            ),
            (
                UpdateOp::Check,
                Error::EmptyEndpoints,
                FailureCode::Internal,
            ),
        ] {
            let failure = from_plugin(op, APPIMAGE, &error);
            assert_eq!(failure.code, code, "{error}");
            assert_eq!(failure.op, op.op());
            let detail = failure.detail.expect("a fixed line for logs and reports");
            assert!(!detail.as_str().contains("/home"), "{}", detail.as_str());
        }
    }
}
