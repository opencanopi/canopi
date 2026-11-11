// .canopi Design files: admission, durable writes, fingerprints, drafts
pub mod drafts;
pub mod format;
mod new_design_defaults;
pub(crate) mod preview;
mod schema_admission;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicU64, Ordering},
    },
};

type WriteAdmissionRegistry = Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>;

static WRITE_ADMISSIONS: OnceLock<WriteAdmissionRegistry> = OnceLock::new();
static NEXT_SIDECAR_ID: AtomicU64 = AtomicU64::new(0);

/// Publish derived output with the same target admission and replacement safety
/// as Design writes, without a Design backup or persistence acknowledgement.
pub(crate) fn write_derived_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    with_write_admission(path, || write_file_durably(path, bytes, "export"))
}

/// Durably replace `path` with `bytes`.
///
/// Writes an operation-owned temporary created with `create_new`, flushes it
/// to stable storage, atomically replaces the target and, on Unix, flushes the
/// parent directory so the rename itself survives a crash. On failure before
/// the replace, the temporary is removed and the previous target is left in
/// place; once the replace succeeds the write has succeeded, and a failed
/// directory flush is only logged. Callers own write admission for the target.
pub(crate) fn write_file_durably(path: &Path, bytes: &[u8], role: &str) -> std::io::Result<()> {
    use std::io::Write;
    let temporary = operation_sidecar_path(path, role);
    let result: std::io::Result<()> = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_replace(&temporary, path)?;
        // The new bytes are already in place under the target name. A failed
        // directory flush only weakens crash durability of the rename; it is
        // not a failed write, and reporting one would leave the caller with a
        // stale fingerprint and false conflicts on the next save.
        if let Err(error) = sync_parent_directory(path) {
            tracing::warn!(
                "Could not sync the folder after replacing a file ({:?})",
                error.kind()
            );
        }
        Ok(())
    })();
    if let Err(ref original) = result {
        match std::fs::remove_file(&temporary) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(std::io::Error::new(
                    original.kind(),
                    format!("{original}; temporary cleanup also failed: {error}"),
                ));
            }
        }
    }
    result
}

/// Flush an existing file's contents to stable storage. Windows flushes only
/// through a handle opened for writing (FlushFileBuffers needs write access),
/// so a read-only handle fails there with "Access is denied"; the handle is
/// opened for writing without truncating or changing the file.
pub(crate) fn sync_file(path: &Path) -> std::io::Result<()> {
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)?
        .sync_all()
}

#[cfg(unix)]
pub(crate) fn sync_parent_directory(path: &Path) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    match std::fs::File::open(parent).and_then(|directory| directory.sync_all()) {
        Ok(()) => Ok(()),
        // Some filesystems cannot sync a directory handle; the file itself is
        // already on stable storage, so that is not a failed write.
        Err(error)
            if error.kind() == std::io::ErrorKind::InvalidInput
                || error.kind() == std::io::ErrorKind::Unsupported =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[cfg(not(unix))]
pub(crate) fn sync_parent_directory(_path: &Path) -> std::io::Result<()> {
    // Windows commits the rename with the file's metadata; there is no
    // directory handle to flush.
    Ok(())
}

fn operation_sidecar_path(dest: &Path, role: &str) -> PathBuf {
    let parent = dest
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    loop {
        let id = NEXT_SIDECAR_ID.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".canopi-{:x}-{id:x}.{role}", std::process::id()));
        if !path.exists() {
            return path;
        }
    }
}

/// Run one write operation at a time for a process-local storage resource.
///
/// The permit deliberately spans blocking file I/O: its invariant is that the
/// complete check/write/replace sequence for one target is indivisible, so a
/// fingerprint check and the write it admits cannot interleave with another
/// write to the same file.
fn with_write_admission<T>(resource: &Path, operation: impl FnOnce() -> T) -> T {
    let key = write_admission_key(resource);
    let registry = WRITE_ADMISSIONS.get_or_init(|| Mutex::new(HashMap::new()));
    let admission = {
        let mut admissions = registry.lock().unwrap_or_else(|poisoned| {
            tracing::warn!("Recovering poisoned Design write admission registry");
            poisoned.into_inner()
        });
        admissions.retain(|_, admission| admission.strong_count() > 0);
        admissions
            .get(&key)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                let admission = Arc::new(Mutex::new(()));
                admissions.insert(key.clone(), Arc::downgrade(&admission));
                admission
            })
    };
    let _permit = admission.lock().unwrap_or_else(|poisoned| {
        tracing::warn!("Recovering poisoned Design write admission");
        poisoned.into_inner()
    });
    operation()
}

fn write_admission_key(resource: &Path) -> PathBuf {
    let parent = resource
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = parent
        .canonicalize()
        .unwrap_or_else(|_| absolute_path(parent));
    resource
        .file_name()
        .map_or(parent.clone(), |name| parent.join(name))
}

/// Fingerprint of a Design file's exact bytes: lowercase hex SHA-256.
///
/// A save that expects a fingerprint writes only while the file on disk still
/// has it, so a change made outside Canopi is detected instead of overwritten.
pub(crate) fn fingerprint(bytes: &[u8]) -> String {
    crate::services::lidar::grid::sha256_hex(bytes)
}

/// [`fingerprint`] of the file at `path`, streamed so an unexpectedly large
/// replacement is never buffered whole. `None` when no file is there.
pub(crate) fn fingerprint_file(path: &Path) -> std::io::Result<Option<String>> {
    use sha2::{Digest, Sha256};
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(Some(format!("{:x}", hasher.finalize())))
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

/// Atomic replace: rename `src` to `dest`, cross-platform safe.
///
/// On Unix, `rename` replaces an existing destination atomically.
/// On Windows, `rename` can fail if the destination is held by another process.
///
/// Fallback strategy (preserves the original on failure):
/// 1. Try direct rename (works on Unix, works on Windows if dest is unlocked).
/// 2. If that fails and dest is a regular file, rename dest to an operation-owned
///    rollback sidecar first, then rename src to dest. If that also fails, restore
///    the destination from the sidecar. Only remove the rollback sidecar after
///    success. Non-regular destinations are rejected without being moved.
pub fn atomic_replace(src: &Path, dest: &Path) -> std::io::Result<()> {
    match std::fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(first_err) if dest.exists() => atomic_replace_fallback(src, dest, first_err),
        Err(first_err) => Err(first_err),
    }
}

fn atomic_replace_fallback(
    src: &Path,
    dest: &Path,
    first_err: std::io::Error,
) -> std::io::Result<()> {
    let destination_type = std::fs::symlink_metadata(dest).map_err(|metadata_error| {
        std::io::Error::new(
            metadata_error.kind(),
            format!(
                "atomic_replace: failed to inspect destination after direct rename failed: {metadata_error} (original: {first_err})"
            ),
        )
    })?;
    if !destination_type.file_type().is_file() {
        return Err(std::io::Error::new(
            first_err.kind(),
            format!(
                "atomic_replace: refusing to move non-regular destination {} after direct rename failed: {first_err}",
                dest.display()
            ),
        ));
    }

    // Fallback: direct rename failed (common on Windows with file locks).
    // The destination is a Design path (user content): log the kind only.
    tracing::warn!(
        "atomic_replace: direct rename failed ({:?}), entering fallback",
        first_err.kind()
    );
    let old = operation_sidecar_path(dest, "old");
    std::fs::rename(dest, &old).map_err(|e| {
        std::io::Error::new(
            e.kind(),
            format!("atomic_replace: failed to move dest aside: {e} (original: {first_err})"),
        )
    })?;

    match std::fs::rename(src, dest) {
        Ok(()) => {
            if let Err(e) = std::fs::remove_file(&old) {
                // This sidecar still owns the only copy of the predecessor, so
                // preserving it is safer than treating cleanup as destructive.
                tracing::warn!(
                    "atomic_replace: could not remove the rollback sidecar ({:?})",
                    e.kind()
                );
            }
            Ok(())
        }
        Err(e) => match std::fs::rename(&old, dest) {
            Ok(()) => Err(std::io::Error::new(
                e.kind(),
                format!("atomic_replace: rename failed, original restored: {e}"),
            )),
            Err(restore_error) => Err(std::io::Error::new(
                e.kind(),
                format!(
                    "atomic_replace: rename failed: {e}; failed to restore original from {}: {restore_error}",
                    old.display()
                ),
            )),
        },
    }
}

/// Format a Unix timestamp (seconds since epoch) as an ISO 8601 UTC string.
///
/// Uses a Gregorian calendar algorithm so there is no chrono dependency.
pub fn unix_to_iso8601(secs: u64) -> String {
    let secs_per_day = 86_400u64;
    let days = secs / secs_per_day;
    let tod = secs % secs_per_day;
    let hh = tod / 3600;
    let mm = (tod % 3600) / 60;
    let ss = tod % 60;

    // Gregorian calendar conversion from Julian Day Number.
    let jd = days + 2_440_588; // JDN of Unix epoch (1970-01-01)
    let a = jd + 32_044;
    let b = (4 * a + 3) / 146_097;
    let c = a - (b * 146_097) / 4;
    let d = (4 * c + 3) / 1_461;
    let e = c - (1_461 * d) / 4;
    let m = (5 * e + 2) / 153;

    let day = e - (153 * m + 2) / 5 + 1;
    let month = m + 3 - 12 * (m / 10);
    let year = b * 100 + d - 4_800 + m / 10;

    format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_scratch::TestScratch;
    use std::fs;
    use std::sync::mpsc;
    use std::time::Duration;

    fn unique_root(name: &str) -> TestScratch {
        TestScratch::new(&format!("design-{name}"))
    }

    fn operation_sidecars(root: &Path, role: &str) -> Vec<PathBuf> {
        let suffix = format!(".{role}");
        fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    return false;
                };
                name.starts_with(".canopi-") && name.ends_with(&suffix)
            })
            .collect()
    }

    #[test]
    fn durable_write_round_trips_content_without_leaving_a_temporary() {
        let root = unique_root("durable_write");
        let target = root.join("garden.canopi");
        fs::write(&target, "previous").unwrap();

        write_file_durably(&target, b"replacement", "tmp").unwrap();

        assert_eq!(fs::read_to_string(&target).unwrap(), "replacement");
        assert!(operation_sidecars(&root, "tmp").is_empty());
        assert!(operation_sidecars(&root, "old").is_empty());
    }

    #[test]
    fn failed_durable_write_keeps_the_target_and_removes_its_temporary() {
        let root = unique_root("durable_write_failure");
        // A directory cannot be replaced by a file, so the replace step fails
        // after the temporary has been written.
        let target = root.join("garden.canopi");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("marker.txt"), "kept").unwrap();

        assert!(write_file_durably(&target, b"replacement", "tmp").is_err());

        assert_eq!(
            fs::read_to_string(target.join("marker.txt")).unwrap(),
            "kept"
        );
        assert!(
            operation_sidecars(&root, "tmp").is_empty(),
            "a failed durable write must not leave its temporary behind"
        );
    }

    #[test]
    fn derived_file_write_is_durable_and_leaves_no_temporary() {
        let root = unique_root("derived_write");
        let target = root.join("export.geojson");

        write_derived_file(&target, b"{}").unwrap();

        assert_eq!(fs::read_to_string(&target).unwrap(), "{}");
        assert!(operation_sidecars(&root, "export").is_empty());
    }

    #[test]
    fn test_atomic_replace_new_dest() {
        let scratch = unique_root("atomic_replace_new");
        let src = scratch.join("canopi_ar_src_new.txt");
        let dest = scratch.join("canopi_ar_dest_new.txt");
        let _ = fs::remove_file(&src);
        let _ = fs::remove_file(&dest);

        fs::write(&src, "new content").unwrap();
        atomic_replace(&src, &dest).unwrap();

        assert!(!src.exists(), "src should be gone after rename");
        assert_eq!(fs::read_to_string(&dest).unwrap(), "new content");

        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn test_atomic_replace_overwrites_existing() {
        let root = unique_root("atomic_replace_overwrite");
        let src = root.join("replacement.tmp");
        let dest = root.join("garden.canopi");

        fs::write(&dest, "old content").unwrap();
        fs::write(&src, "new content").unwrap();
        atomic_replace(&src, &dest).unwrap();

        assert_eq!(fs::read_to_string(&dest).unwrap(), "new content");
        assert!(
            operation_sidecars(&root, "old").is_empty(),
            "successful replacement must not leak an owned rollback sidecar"
        );
    }

    #[test]
    fn test_atomic_replace_with_stale_old_succeeds() {
        // The stable legacy .old name is outside this operation's ownership.
        // Its presence must neither block the save nor be claimed as rollback
        // state, regardless of whether the platform needs the fallback path.
        let scratch = unique_root("atomic_replace_stale");
        let src = scratch.join("canopi_ar_src_stale.txt");
        let dest = scratch.join("canopi_ar_dest_stale.txt");
        let old = dest.with_extension("canopi.old");

        fs::write(&dest, "original").unwrap();
        fs::write(&old, "stale old").unwrap();
        fs::write(&src, "replacement").unwrap();

        // Must succeed regardless of stale .old
        atomic_replace(&src, &dest).unwrap();

        assert_eq!(fs::read_to_string(&dest).unwrap(), "replacement");
        assert_eq!(fs::read_to_string(&old).unwrap(), "stale old");

        let _ = fs::remove_file(&dest);
        let _ = fs::remove_file(&old);
    }

    #[test]
    fn syncing_a_published_file_leaves_its_bytes_and_length_unchanged() {
        let root = unique_root("sync_file");
        let path = root.join("asset.tif");
        std::fs::write(&path, b"published bytes").unwrap();
        super::sync_file(&path).expect("a written file can be synced");
        assert_eq!(std::fs::read(&path).unwrap(), b"published bytes");
        assert!(super::sync_file(&root.join("missing.tif")).is_err());
    }

    #[test]
    fn atomic_replace_fallback_does_not_claim_legacy_rollback_sidecar() {
        let root = unique_root("atomic_owned_rollback");
        let src = root.join("replacement.tmp");
        let dest = root.join("garden.canopi");
        let legacy_old = dest.with_extension("canopi.old");
        fs::write(&src, "replacement").unwrap();
        fs::write(&dest, "original").unwrap();
        fs::write(&legacy_old, "another operation owns this").unwrap();

        let ((), logs) = crate::services::design_files::capture_logs(|| {
            atomic_replace_fallback(
                &src,
                &dest,
                std::io::Error::other("forced fallback for test"),
            )
            .unwrap()
        });

        assert_eq!(fs::read_to_string(&dest).unwrap(), "replacement");
        assert_eq!(
            fs::read_to_string(&legacy_old).unwrap(),
            "another operation owns this"
        );
        assert!(logs.contains("entering fallback"), "{logs}");
        assert!(
            !logs.contains(&*root.to_string_lossy()),
            "the Design path is user content and stays out of the log: {logs}"
        );
        assert!(
            operation_sidecars(&root, "old").is_empty(),
            "successful fallback must clean its owned rollback sidecar"
        );
    }

    #[test]
    fn atomic_replace_rejects_directory_destination_without_moving_it() {
        let root = unique_root("atomic_directory_destination");
        let src = root.join("replacement.tmp");
        let dest = root.join("garden.canopi");
        let marker = dest.join("marker.txt");
        fs::write(&src, "replacement").unwrap();
        fs::create_dir(&dest).unwrap();
        fs::write(&marker, "directory content").unwrap();

        let result = atomic_replace(&src, &dest);

        assert!(result.is_err(), "a directory destination must be rejected");
        assert!(
            dest.is_dir(),
            "the destination directory must remain in place"
        );
        assert_eq!(fs::read_to_string(&marker).unwrap(), "directory content");
        assert_eq!(
            fs::read_to_string(&src).unwrap(),
            "replacement",
            "the uncommitted source must remain available to the caller"
        );
        assert!(
            operation_sidecars(&root, "old").is_empty(),
            "rejecting a directory must not create an owned rollback sidecar"
        );
    }

    #[test]
    fn test_atomic_replace_fails_if_src_missing() {
        let root = unique_root("atomic_missing_source");
        let src = root.join("missing.tmp");
        let dest = root.join("garden.canopi");
        fs::write(&dest, "original").unwrap();

        let result = atomic_replace(&src, &dest);
        assert!(result.is_err(), "should fail when src doesn't exist");
        assert_eq!(
            fs::read_to_string(&dest).unwrap(),
            "original",
            "fallback should restore the original destination"
        );
        assert!(
            operation_sidecars(&root, "old").is_empty(),
            "a successfully restored fallback must not leak its rollback sidecar"
        );
    }

    #[test]
    fn file_fingerprint_is_the_lowercase_sha256_of_its_bytes() {
        let root = unique_root("fingerprint_file");
        let target = root.join("garden.canopi");
        fs::write(&target, b"abc").unwrap();

        let expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(fingerprint(b"abc"), expected);
        assert_eq!(
            fingerprint_file(&target).unwrap().as_deref(),
            Some(expected)
        );
        assert_eq!(
            fingerprint_file(&root.join("missing.canopi")).unwrap(),
            None
        );
    }

    #[test]
    fn same_resource_write_admission_serializes_operations() {
        let scratch = unique_root("write_admission");
        let resource = scratch.join("resource");
        let (first_entered_tx, first_entered_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let first_resource = resource.clone();
        let first = std::thread::spawn(move || {
            with_write_admission(&first_resource, || {
                first_entered_tx.send(()).unwrap();
                release_first_rx.recv().unwrap();
            });
        });
        first_entered_rx.recv().unwrap();

        let (second_started_tx, second_started_rx) = mpsc::channel();
        let (second_entered_tx, second_entered_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            second_started_tx.send(()).unwrap();
            with_write_admission(&resource, || second_entered_tx.send(()).unwrap());
        });
        second_started_rx.recv().unwrap();

        assert!(
            second_entered_rx
                .recv_timeout(Duration::from_millis(200))
                .is_err(),
            "a second operation entered while the same resource was admitted"
        );

        release_first_tx.send(()).unwrap();
        second_entered_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("second operation should enter after the first releases admission");
        first.join().unwrap();
        second.join().unwrap();
    }

    #[test]
    fn different_resource_write_admissions_proceed_concurrently() {
        let root = unique_root("independent_write_admission");
        let first_resource = root.join("first.canopi");
        let second_resource = root.join("second.canopi");
        let (first_entered_tx, first_entered_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let first = std::thread::spawn(move || {
            with_write_admission(&first_resource, || {
                first_entered_tx.send(()).unwrap();
                release_first_rx.recv().unwrap();
            });
        });
        first_entered_rx.recv().unwrap();

        let (second_entered_tx, second_entered_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            with_write_admission(&second_resource, || second_entered_tx.send(()).unwrap());
        });

        let second_entered = second_entered_rx.recv_timeout(Duration::from_secs(2));
        release_first_tx.send(()).unwrap();
        first.join().unwrap();
        second.join().unwrap();
        second_entered.expect("a different resource must not wait for the first admission");
    }
}
