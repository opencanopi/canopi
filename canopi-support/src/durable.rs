//! Durable file publishing, removal, and target locking behind [`DurableFs`]
//! (ADR 0023, ADR 0026, contracts §11, 2.1-M541).

use std::path::{Path, PathBuf};
use std::time::Duration;
use std::{fmt, io};

use crate::durable_locks::parent_dir;
pub use crate::durable_locks::{TargetLocks, detect_case_insensitive_volume};
pub use crate::durable_os::{OsDurableFs, probe_noclobber_support};
use crate::hash;

/// Filesystem entry classification returned by [`DurableFs::entry_kind`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
    Other,
}

/// Precondition checked atomically inside [`TargetLocks`] before publishing or removing a target.
/// Variant names refine 2.1-M111's `None` / `Fingerprint` / `Absent` to avoid shadowing `Option::None` (ADR 0023, 2.1-M545).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Precondition {
    /// Unconditional overwrite (or create if absent).
    Any,
    /// Refuse to clobber an existing target; settles as [`DurableError::AlreadyExists`].
    NotExists,
    /// Target must exist and have this lowercase SHA-256 hex fingerprint; otherwise
    /// settles as [`DurableError::Conflict`].
    MatchesFingerprint(String),
}

/// Source payload for [`publish_durably`].
#[derive(Debug, Clone, Copy)]
pub enum PublishSource<'a> {
    /// In-memory bytes to stage, sync, and publish.
    Bytes(&'a [u8]),
    /// An already-staged sibling file to publish into `target`.
    StagedFile(&'a Path),
}

/// Retry budget for transient busy/sharing-violation renames (primarily Windows
/// antivirus/indexer holds on the destination file).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenameRetryPolicy {
    /// Maximum retry attempts after the initial rename fails as busy.
    pub max_retries: u32,
    /// Initial backoff duration; doubles per attempt up to 160 ms.
    pub base_delay: Duration,
}

impl RenameRetryPolicy {
    /// Zero-delay retry policy for fast deterministic tests.
    pub const fn immediate(max_retries: u32) -> Self {
        Self {
            max_retries,
            base_delay: Duration::ZERO,
        }
    }
}

impl Default for RenameRetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 5,
            base_delay: Duration::from_millis(10),
        }
    }
}

/// Optional tuning for [`publish_durably_with_options`].
#[derive(Debug, Clone, Copy, Default)]
pub struct PublishOptions {
    /// Unix file mode applied to newly created files (e.g. `0o600` for private
    /// update packages). Ignored on non-Unix targets.
    pub unix_mode: Option<u32>,
    /// Copy permissions from the existing target onto the replacement before
    /// renaming (used by AppImage in-place replacement).
    pub preserve_target_permissions: bool,
    /// Remove leftover `.canopi-*.<role>` sidecars in the target's folder under
    /// the target lock before staging (used by AppImage in-place replacement so
    /// a crashed update does not leave ~100 MB behind).
    pub sweep_stale_sidecars: bool,
    /// Retry policy for busy/sharing-violation renames.
    pub retry_policy: RenameRetryPolicy,
}

/// Outcome of a successful [`publish_durably`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishOutcome {
    /// Lowercase hex SHA-256 of the published bytes when known (`PublishSource::Bytes`).
    pub fingerprint: Option<String>,
}

/// Result of probing whether a directory's filesystem supports
/// `tempfile::NamedTempFile::persist_noclobber` natively (2.1-M541).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoclobberSupport {
    /// OS no-replace rename / link-based `persist_noclobber` works natively.
    Supported,
    /// Filesystem (e.g. FAT32/exFAT on Unix) refuses `persist_noclobber`; falls
    /// back to `create_new` + fingerprint-verified copy.
    FallbackVerifiedCopy,
}

/// Typed error settled by [`publish_durably`] and [`remove_durably`].
#[derive(Debug)]
pub enum DurableError {
    /// [`Precondition::MatchesFingerprint`] did not match the target on disk.
    Conflict {
        /// Current SHA-256 hex fingerprint on disk, or `None` if absent.
        current_fingerprint: Option<String>,
    },
    /// [`Precondition::NotExists`] found an existing target.
    AlreadyExists,
    /// Rename remained blocked by another process after exhausting retries.
    TargetBusy {
        /// Total attempts performed (initial + retries).
        attempts: u32,
        /// Underlying OS I/O error from the final attempt.
        source: io::Error,
    },
    /// Destination is a directory or non-regular file and cannot be replaced.
    NotRegularFile,
    /// Any other I/O error (disk full, read-only, permission denied, etc.).
    Io(io::Error),
}

impl DurableError {
    /// Convert into an [`io::Error`] for callers whose boundary still returns
    /// `io::Result`.
    pub fn into_io_error(self) -> io::Error {
        match self {
            Self::Conflict { .. } => io::Error::new(
                io::ErrorKind::InvalidData,
                "precondition fingerprint mismatch",
            ),
            Self::AlreadyExists => {
                io::Error::new(io::ErrorKind::AlreadyExists, "target already exists")
            }
            Self::TargetBusy { attempts, source } => io::Error::new(
                io::ErrorKind::ResourceBusy,
                format!("target busy after {attempts} attempts: {source}"),
            ),
            Self::NotRegularFile => io::Error::new(
                io::ErrorKind::InvalidInput,
                "destination is not a regular file",
            ),
            Self::Io(error) => error,
        }
    }
}

impl fmt::Display for DurableError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict { .. } => f.write_str("target file changed before publish"),
            Self::AlreadyExists => f.write_str("target file already exists"),
            Self::TargetBusy { attempts, source } => {
                write!(f, "target file is busy after {attempts} attempts: {source}")
            }
            Self::NotRegularFile => f.write_str("destination is not a regular file"),
            Self::Io(error) => fmt::Display::fmt(error, f),
        }
    }
}

impl std::error::Error for DurableError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::TargetBusy { source, .. } | Self::Io(source) => Some(source),
            Self::Conflict { .. } | Self::AlreadyExists | Self::NotRegularFile => None,
        }
    }
}

impl From<io::Error> for DurableError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// Filesystem fault seam behind [`publish_durably`], [`remove_durably`], and
/// [`move_aside_durably`] (ADR 0023, ADR 0028).
pub trait DurableFs: Send + Sync {
    /// Read the complete bytes of `path`.
    fn read_bytes(&self, path: &Path) -> io::Result<Vec<u8>>;

    /// Byte length of `path` from metadata without reading its contents, or `Ok(None)` if absent.
    fn file_len(&self, path: &Path) -> io::Result<Option<u64>>;

    /// Streamed lowercase hex SHA-256 of `path`, or `Ok(None)` if absent.
    fn fingerprint_file(&self, path: &Path) -> io::Result<Option<String>>;

    /// Classify `path` without following symlinks, or `Ok(None)` if absent.
    fn entry_kind(&self, path: &Path) -> io::Result<Option<EntryKind>>;

    /// Whether `path` resolves to an existing entry (following symlinks on OS
    /// filesystems, matching `Path::exists`).
    fn path_exists(&self, path: &Path) -> bool {
        matches!(self.entry_kind(path), Ok(Some(_)))
    }

    /// Ensure directory `path` and its ancestors exist.
    fn create_dir_all(&self, path: &Path) -> io::Result<()>;

    /// Write `bytes` to a fresh operation-owned sibling temporary file in
    /// `parent` without syncing it yet; returns the temporary file's path.
    fn stage_bytes(
        &self,
        parent: &Path,
        role: &str,
        bytes: &[u8],
        options: &PublishOptions,
        preserve_from: Option<&Path>,
    ) -> io::Result<PathBuf>;

    /// Flush a file's contents and metadata to stable storage.
    fn sync_file(&self, path: &Path) -> io::Result<()>;

    /// Flush a newly staged temporary file before publishing.
    ///
    /// [`OsDurableFs`] syncs on the open writing handle inside `stage_bytes`
    /// before applying preserved (possibly read-only) target permissions, so
    /// its override is a no-op; [`crate::fault_fs::FaultFs`] uses the default
    /// so `FaultOp::SyncFile` remains an injectable hook point.
    fn sync_staged(&self, path: &Path) -> io::Result<()> {
        self.sync_file(path)
    }

    /// Best-effort cleanup of leftover `.canopi-*.<role>` temporary files in
    /// `parent` before staging a new file for `role`.
    fn sweep_role_sidecars(&self, _parent: &Path, _role: &str) {}

    /// Atomically replace `dest` with `src` (same directory).
    fn rename_replace(&self, src: &Path, dest: &Path) -> io::Result<()>;

    /// Atomically publish `src` to `dest` without clobbering an existing `dest`.
    fn persist_noclobber(
        &self,
        src: &Path,
        dest: &Path,
        expected_fingerprint: Option<&str>,
        unix_mode: Option<u32>,
    ) -> Result<(), DurableError>;

    /// Flush `dir`'s directory entries to stable storage (no-op on Windows).
    fn sync_dir(&self, dir: &Path) -> io::Result<()>;

    /// Remove a file at `path`.
    fn remove_file(&self, path: &Path) -> io::Result<()>;

    /// Available bytes on the filesystem holding `dir`.
    fn available_space(&self, dir: &Path) -> io::Result<u64>;
}

/// Publish `source` durably to `target` with default [`PublishOptions`].
pub fn publish_durably(
    fs: &dyn DurableFs,
    locks: &TargetLocks,
    source: PublishSource<'_>,
    target: &Path,
    role: &str,
    precondition: Precondition,
) -> Result<PublishOutcome, DurableError> {
    publish_durably_with_options(
        fs,
        locks,
        source,
        target,
        role,
        precondition,
        &PublishOptions::default(),
    )
}

/// Publish `source` durably to `target` under `locks` with explicit
/// [`PublishOptions`].
pub fn publish_durably_with_options(
    fs: &dyn DurableFs,
    locks: &TargetLocks,
    source: PublishSource<'_>,
    target: &Path,
    role: &str,
    precondition: Precondition,
    options: &PublishOptions,
) -> Result<PublishOutcome, DurableError> {
    locks.with_lock(target, || {
        publish_durably_unlocked(fs, source, target, role, precondition, options)
    })
}

/// Publish `source` durably to `target` when the caller already holds
/// `locks.with_lock(target, ...)`.
pub fn publish_durably_unlocked(
    fs: &dyn DurableFs,
    source: PublishSource<'_>,
    target: &Path,
    role: &str,
    precondition: Precondition,
    options: &PublishOptions,
) -> Result<PublishOutcome, DurableError> {
    check_precondition(fs, target, &precondition)?;
    let parent = parent_dir(target);
    if options.sweep_stale_sidecars {
        fs.sweep_role_sidecars(parent, role);
    }
    let (staged_path, owns_staged, fingerprint) = match source {
        PublishSource::Bytes(bytes) => {
            let preserve_from = options.preserve_target_permissions.then_some(target);
            let temp = fs.stage_bytes(parent, role, bytes, options, preserve_from)?;
            if let Err(error) = fs.sync_staged(&temp) {
                cleanup_temp(fs, &temp);
                return Err(DurableError::Io(error));
            }
            (temp, true, Some(hash::sha256_hex(bytes)))
        }
        PublishSource::StagedFile(path) => (path.to_path_buf(), false, None),
    };

    let publish_result = match precondition {
        Precondition::NotExists => fs.persist_noclobber(
            &staged_path,
            target,
            fingerprint.as_deref(),
            options.unix_mode,
        ),
        Precondition::Any | Precondition::MatchesFingerprint(_) => {
            replace_with_retry(fs, &staged_path, target, options.retry_policy)
        }
    };

    if let Err(error) = publish_result {
        if owns_staged {
            cleanup_temp(fs, &staged_path);
        }
        return Err(error);
    }

    // Deliberate exception: once the rename/persist has succeeded, failing the
    // publish because the parent directory fsync failed would leave the caller
    // holding a stale fingerprint and trigger false conflicts on the next save.
    // Log the warning and settle Ok (tested in `interleaved_publish.rs`).
    if let Err(error) = fs.sync_dir(parent) {
        tracing::warn!(
            "Could not sync the folder after publishing a file ({:?})",
            error.kind()
        );
    }
    Ok(PublishOutcome { fingerprint })
}

/// Durably remove `target` under `locks` when `precondition` holds.
pub fn remove_durably(
    fs: &dyn DurableFs,
    locks: &TargetLocks,
    target: &Path,
    precondition: Precondition,
) -> Result<(), DurableError> {
    locks.with_lock(target, || {
        check_precondition(fs, target, &precondition)?;
        match fs.remove_file(target) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(DurableError::Io(error)),
        }
        if let Err(error) = fs.sync_dir(parent_dir(target)) {
            tracing::warn!(
                "Could not sync the folder after removing a file ({:?})",
                error.kind()
            );
        }
        Ok(())
    })
}

/// Publish a new private file (`0o600` on Unix) at `target` without clobbering
/// any existing file or symlink.
pub fn write_private_new(
    fs: &dyn DurableFs,
    locks: &TargetLocks,
    target: &Path,
    bytes: &[u8],
) -> Result<PublishOutcome, DurableError> {
    let options = PublishOptions {
        unix_mode: Some(0o600),
        preserve_target_permissions: false,
        sweep_stale_sidecars: false,
        retry_policy: RenameRetryPolicy::default(),
    };
    publish_durably_with_options(
        fs,
        locks,
        PublishSource::Bytes(bytes),
        target,
        "private",
        Precondition::NotExists,
        &options,
    )
}

/// Move `path` and each of its `companions` to the first free candidate name,
/// rolling back any moved files on companion failure.
pub fn move_aside_durably(
    fs: &dyn DurableFs,
    locks: &TargetLocks,
    path: &Path,
    mut candidates: impl Iterator<Item = PathBuf>,
    companions: &[&str],
) -> io::Result<PathBuf> {
    locks.with_lock(path, || {
        let aside = candidates
            .find(|candidate| is_candidate_free(fs, candidate, companions))
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "no free name to move file aside",
                )
            })?;

        fs.rename_replace(path, &aside)?;
        let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
        for suffix in companions {
            let from = with_suffix(path, suffix);
            if !matches!(fs.entry_kind(&from), Ok(Some(_))) {
                continue;
            }
            let to = with_suffix(&aside, suffix);
            if let Err(error) = fs.rename_replace(&from, &to) {
                let rollback_errors = rollback_moved(fs, &moved, &aside, path);
                return Err(format_move_aside_error(suffix, error, &rollback_errors));
            }
            moved.push((from, to));
        }
        let _ = fs.sync_dir(parent_dir(path));
        Ok(aside)
    })
}

/// Sync an existing file's bytes to stable storage through `fs`.
pub fn sync_existing_file(fs: &dyn DurableFs, path: &Path) -> io::Result<()> {
    fs.sync_file(path)
}

/// Sync `path`'s parent directory through `fs`.
pub fn sync_parent_directory(fs: &dyn DurableFs, path: &Path) -> io::Result<()> {
    fs.sync_dir(parent_dir(path))
}

fn check_precondition(
    fs: &dyn DurableFs,
    target: &Path,
    precondition: &Precondition,
) -> Result<(), DurableError> {
    match precondition {
        Precondition::Any => Ok(()),
        Precondition::NotExists => {
            if fs.entry_kind(target)?.is_some() {
                return Err(DurableError::AlreadyExists);
            }
            Ok(())
        }
        Precondition::MatchesFingerprint(expected) => {
            let current = fs.fingerprint_file(target)?;
            if current.as_deref() != Some(expected.as_str()) {
                return Err(DurableError::Conflict {
                    current_fingerprint: current,
                });
            }
            Ok(())
        }
    }
}

fn replace_with_retry(
    fs: &dyn DurableFs,
    src: &Path,
    dest: &Path,
    policy: RenameRetryPolicy,
) -> Result<(), DurableError> {
    if matches!(
        fs.entry_kind(dest)?,
        Some(EntryKind::Dir | EntryKind::Other)
    ) {
        return Err(DurableError::NotRegularFile);
    }

    let mut attempts = 0u32;
    loop {
        attempts += 1;
        match fs.rename_replace(src, dest) {
            Ok(()) => return Ok(()),
            Err(error) if is_busy_rename_error(&error) => {
                if attempts > policy.max_retries {
                    return Err(DurableError::TargetBusy {
                        attempts,
                        source: error,
                    });
                }
                let shift = (attempts - 1).min(4);
                let delay = policy.base_delay.saturating_mul(1u32 << shift);
                if !delay.is_zero() {
                    std::thread::sleep(delay);
                }
            }
            Err(error) => {
                if matches!(
                    fs.entry_kind(dest),
                    Ok(Some(EntryKind::Dir | EntryKind::Other))
                ) {
                    return Err(DurableError::NotRegularFile);
                }
                return Err(DurableError::Io(error));
            }
        }
    }
}

fn is_busy_rename_error(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::ResourceBusy {
        return true;
    }
    #[cfg(windows)]
    {
        if matches!(error.raw_os_error(), Some(5 | 32 | 33)) {
            return true;
        }
    }
    false
}

fn cleanup_temp(fs: &dyn DurableFs, temp: &Path) {
    match fs.remove_file(temp) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            tracing::warn!(
                "Could not remove temporary file after failed publish ({:?})",
                error.kind()
            );
        }
    }
}

fn is_candidate_free(fs: &dyn DurableFs, candidate: &Path, companions: &[&str]) -> bool {
    !fs.path_exists(candidate)
        && companions
            .iter()
            .all(|suffix| !fs.path_exists(&with_suffix(candidate, suffix)))
}

fn with_suffix(target: &Path, suffix: &str) -> PathBuf {
    let mut name = target.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn rollback_moved(
    fs: &dyn DurableFs,
    moved: &[(PathBuf, PathBuf)],
    aside: &Path,
    original_main: &Path,
) -> Vec<String> {
    let mut errors = Vec::new();
    for (original, renamed) in moved.iter().rev() {
        if let Err(rollback) = fs.rename_replace(renamed, original) {
            errors.push(rollback.to_string());
        }
    }
    if let Err(rollback) = fs.rename_replace(aside, original_main) {
        errors.push(rollback.to_string());
    }
    errors
}

fn format_move_aside_error(
    suffix: &str,
    error: io::Error,
    rollback_errors: &[String],
) -> io::Error {
    if rollback_errors.is_empty() {
        io::Error::new(
            error.kind(),
            format!("could not move the {suffix} companion file: {error}"),
        )
    } else {
        io::Error::new(
            error.kind(),
            format!(
                "could not move the {suffix} companion file: {error}; restoring the original files also failed: {}",
                rollback_errors.join("; ")
            ),
        )
    }
}
