//! Cross-platform available disk space backed by `fs4` (Stage 2, ADR 0023).
//!
//! Replaces direct `libc::statvfs` and `windows_sys::GetDiskFreeSpaceExW` calls
//! with a single safe wrapper.

use std::io;
use std::path::Path;

/// Free bytes available to this process on the filesystem holding `directory`.
///
/// Fails with [`io::ErrorKind::NotFound`] when `directory` does not exist on
/// every platform (on Windows, `fs4::available_space` calls `GetVolumePathNameW`,
/// which resolves missing leaf paths up to the volume root unless existence is
/// checked first).
///
/// This is a measurement, not a reservation: another process can consume the
/// space immediately afterwards, so callers still propagate ordinary write errors.
pub fn available_space(directory: &Path) -> io::Result<u64> {
    let _ = std::fs::metadata(directory)?;
    fs4::available_space(directory)
}

#[cfg(test)]
mod tests {
    use super::available_space;
    use std::io;

    #[test]
    fn available_space_reports_positive_bytes_for_existing_dir() {
        let dir = tempfile::tempdir().ok();
        assert!(dir.is_some());
        if let Some(dir) = dir {
            let bytes = available_space(dir.path()).ok();
            assert!(bytes.is_some_and(|n| n > 0));
        }
    }

    #[test]
    fn available_space_fails_for_missing_dir() {
        let dir = tempfile::tempdir().ok();
        assert!(dir.is_some());
        if let Some(dir) = dir {
            let missing = dir.path().join("does-not-exist");
            let err = available_space(&missing).expect_err("missing dir must fail");
            assert_eq!(err.kind(), io::ErrorKind::NotFound);
        }
    }
}
