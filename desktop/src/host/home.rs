//! Desktop Design home store and file grant registry (2b-4; contracts §4, ADR 0027, 2.1-M155).
//!
//! One `home_read` / `home_write` port resolves both host-issued [`FileGrantId`]s and
//! validated [`DraftId`]s (`{app_data}/drafts/<id>.canopi`) behind `canopi-support`'s
//! [`DurableFs`] and case-folded [`TargetLocks`]. No Draft path or raw user path crosses
//! `home_read` / `home_write`; legacy Recent/Notebook display metadata stays on its own read-only commands.

use std::collections::HashMap;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use canopi_support::durable::{
    DurableError, DurableFs, OsDurableFs, Precondition, PublishOptions, PublishSource, TargetLocks,
    publish_durably_unlocked,
};
use canopi_support::hash;
use canopi_types::design_home::{FileHomeGrant, HomeRead, HomeWrite};
use canopi_types::failure::{Failure, FailureCode, IoFailureKind, ops};
use canopi_types::ids::{FileGrantId, HomeVersion};

use crate::design::drafts::is_valid_draft_id;
use crate::design::format::MAX_CANOPI_FILE_BYTES;

const GRANT_PREFIX: &str = "grant:";
const DRAFTS_DIR: &str = "drafts";
const BEFORE_V10_DIR: &str = "before-v10";
const DRAFT_EXTENSION: &str = "canopi";
const MAX_PRE_UPGRADE_COPY_ATTEMPTS: u32 = 1000;

/// Typed refusal when a path cannot be minted into a [`FileGrantId`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantError {
    /// The target path has no parent directory component.
    MissingParent,
    /// The target path has no final file name component.
    MissingFileName,
}

impl fmt::Display for GrantError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingParent => f.write_str("file grant target has no parent directory"),
            Self::MissingFileName => f.write_str("file grant target has no file name"),
        }
    }
}

impl std::error::Error for GrantError {}

/// Canonical identity of a granted Design file: canonical parent directory + exact file name
/// (never the inode; contracts §4, ADR 0027).
///
/// When `std::fs::canonicalize` fails (for instance, a Save target whose parent folder does not
/// exist yet), the key falls back to the uncanonicalised parent path. A later pick after that
/// folder exists and canonicalises cleanly will mint a second grant id for the canonical parent,
/// which is safe because both grants still lock the same target via `TargetLocks`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct GrantTargetKey {
    parent: PathBuf,
    file_name: std::ffi::OsString,
}

#[derive(Default)]
struct GrantTable {
    by_id: HashMap<FileGrantId, PathBuf>,
    by_target: HashMap<GrantTargetKey, FileGrantId>,
}

/// Process-local registry of host-issued [`FileGrantId`]s (contracts §4, ADR 0027).
///
/// Two grants to the same canonical parent directory and file name resolve to the same
/// [`FileGrantId`], so two picks of the same file always share one home identity.
#[derive(Default)]
pub struct FileGrantRegistry {
    next_id: AtomicU64,
    table: Mutex<GrantTable>,
}

impl FileGrantRegistry {
    /// Returns true iff `key` has the host grant prefix (`grant:`), disjoint from `DraftId`.
    #[must_use]
    pub fn is_grant(key: &str) -> bool {
        key.starts_with(GRANT_PREFIX)
    }

    /// Mints or reuses the [`FileGrantId`] for `path`.
    pub fn grant(&self, path: &Path) -> Result<FileGrantId, GrantError> {
        let parent = path
            .parent()
            .filter(|dir| !dir.as_os_str().is_empty())
            .ok_or(GrantError::MissingParent)?;
        let file_name = path
            .file_name()
            .ok_or(GrantError::MissingFileName)?
            .to_os_string();
        let canonical_parent =
            std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
        // Preserve the caller's path form (no Windows `\\?\` or symlink rewrite) while
        // deduplicating grants by canonical target so Recents never gets duplicate rows (N1).
        let stored_path = path.to_path_buf();
        let key = GrantTargetKey {
            parent: canonical_parent,
            file_name,
        };
        let mut table = self.table.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(existing) = table.by_target.get(&key) {
            return Ok(existing.clone());
        }
        let seq = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let id = FileGrantId::new(format!("{GRANT_PREFIX}{seq}"));
        table.by_target.insert(key, id.clone());
        table.by_id.insert(id.clone(), stored_path);
        Ok(id)
    }

    /// Mints or reuses the full [`FileHomeGrant`] (`{ grant, display_name, recent_id }`) for `path`.
    pub fn grant_info(&self, path: &Path) -> Result<FileHomeGrant, GrantError> {
        let grant = self.grant(path)?;
        let resolved = self.resolve(&grant).unwrap_or_else(|| path.to_path_buf());
        let display_name = resolved
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Untitled.canopi")
            .to_owned();
        let recent_id = recent_id_for_path(&resolved.to_string_lossy());
        Ok(FileHomeGrant {
            grant,
            display_name,
            recent_id,
        })
    }

    /// Resolves a host-issued grant id to its filesystem path.
    #[must_use]
    pub fn resolve(&self, id: &FileGrantId) -> Option<PathBuf> {
        self.table
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .by_id
            .get(id)
            .cloned()
    }
}

/// Stable opaque Recent Designs identifier for `path` (SHA-256 hex), shared across `FileHomeGrant`
/// and `grant_for_recent` so `last_open_home` never stores raw paths or ephemeral grant ids.
#[must_use]
pub fn recent_id_for_path(path: &str) -> String {
    hash::sha256_hex(path.as_bytes())
}

enum ResolvedHome {
    File(PathBuf),
    Draft { id: String, path: PathBuf },
}

/// Unified Desktop `home_read` / `home_write` store over [`DurableFs`] (contracts §4, 2b-4).
pub struct DesktopHomeStore<F: DurableFs = OsDurableFs> {
    drafts_dir: PathBuf,
    grants: Arc<FileGrantRegistry>,
    locks: Arc<TargetLocks>,
    fs: F,
    user_db: Option<crate::db::UserDb>,
}

impl DesktopHomeStore<OsDurableFs> {
    /// Production Desktop home store under `{app_data_dir}/drafts` backed by [`OsDurableFs`].
    ///
    /// Shares [`crate::target_locks::temporary_target_locks`] with the legacy Design and Draft
    /// writers so concurrent writes to the same target serialize (contracts §11; removed in I5
    /// bead `canopi-f47t.52.189.1` once owned stores replace every legacy writer).
    #[must_use]
    pub fn production(app_data_dir: &Path, grants: Arc<FileGrantRegistry>) -> Self {
        Self::with_fs(
            app_data_dir.join(DRAFTS_DIR),
            grants,
            Arc::clone(crate::target_locks::temporary_target_locks()),
            OsDurableFs,
        )
    }
}

impl<F: DurableFs> DesktopHomeStore<F> {
    /// Builds a home store over an explicit [`DurableFs`] (such as `FaultFs` in tests).
    #[must_use]
    pub fn with_fs(
        drafts_dir: PathBuf,
        grants: Arc<FileGrantRegistry>,
        locks: Arc<TargetLocks>,
        fs: F,
    ) -> Self {
        Self {
            drafts_dir,
            grants,
            locks,
            fs,
            user_db: None,
        }
    }

    /// Attaches a [`crate::db::UserDb`] so file-grant reads and writes record Desktop Recents (M3).
    #[must_use]
    pub fn with_user_db(mut self, user_db: crate::db::UserDb) -> Self {
        self.user_db = Some(user_db);
        self
    }

    fn record_recent_from_bytes(&self, resolved: &ResolvedHome, bytes: &[u8]) {
        let ResolvedHome::File(path) = resolved else {
            return;
        };
        let Some(user_db) = &self.user_db else {
            return;
        };
        let Some(path_str) = path.to_str() else {
            return;
        };
        let fallback_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("Untitled");
        // Admit once through the canonical Format Core (v9 or v10).
        let admitted_name = match canopi_format::core::decode_design(bytes) {
            Ok(opened) => opened
                .design
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            Err(_) => return,
        };
        let name = if admitted_name.is_empty() {
            fallback_name.to_owned()
        } else {
            admitted_name
        };
        if let Some(conn) = user_db.acquire_writable()
            && let Err(error) = crate::db::recent_files::record_recent_file(&conn, path_str, &name)
        {
            tracing::debug!(%error, "Failed to record recent file from home store");
        }
    }

    /// Shared handle to the host's [`FileGrantRegistry`].
    #[must_use]
    pub fn grants(&self) -> &Arc<FileGrantRegistry> {
        &self.grants
    }

    fn resolve(&self, key: &str) -> Result<ResolvedHome, String> {
        if FileGrantRegistry::is_grant(key) {
            let grant = FileGrantId::new(key);
            let path = self
                .grants
                .resolve(&grant)
                .ok_or_else(|| "unknown file grant".to_owned())?;
            return Ok(ResolvedHome::File(path));
        }
        if is_valid_draft_id(key) {
            let path = self.drafts_dir.join(format!("{key}.{DRAFT_EXTENSION}"));
            return Ok(ResolvedHome::Draft {
                id: key.to_owned(),
                path,
            });
        }
        Err("invalid design home key".to_owned())
    }

    /// Reads the exact bytes and SHA-256 [`HomeVersion`] for `key` (grant or Draft id).
    #[must_use]
    pub fn read(&self, key: &str) -> HomeRead {
        let resolved = match self.resolve(key) {
            Ok(resolved) => resolved,
            Err(reason) => return HomeRead::Unreadable { reason },
        };
        let path = match &resolved {
            ResolvedHome::File(path) | ResolvedHome::Draft { path, .. } => path.as_path(),
        };
        // Check metadata length before loading bytes so an oversized file is never buffered whole.
        match self.fs.file_len(path) {
            Ok(None) => return HomeRead::Absent,
            Ok(Some(len)) if len > MAX_CANOPI_FILE_BYTES => {
                return HomeRead::Unreadable {
                    reason: "design exceeds the maximum readable size".to_owned(),
                };
            }
            Ok(Some(_)) => {}
            Err(error) => {
                return HomeRead::Unreadable {
                    reason: format!("failed to read design home: {}", error.kind()),
                };
            }
        }
        match self.fs.read_bytes(path) {
            Ok(bytes) => {
                if bytes.len() as u64 > MAX_CANOPI_FILE_BYTES {
                    return HomeRead::Unreadable {
                        reason: "design exceeds the maximum readable size".to_owned(),
                    };
                }
                let version = HomeVersion::new(hash::sha256_hex(&bytes));
                self.record_recent_from_bytes(&resolved, &bytes);
                HomeRead::Present { bytes, version }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => HomeRead::Absent,
            Err(error) => HomeRead::Unreadable {
                reason: format!("failed to read design home: {}", error.kind()),
            },
        }
    }

    /// Durably writes `bytes` to `key` under its target lock with compare-and-swap `expected`.
    ///
    /// When `keep_previous` is true and a file already exists, conflict is checked first
    /// (conflict wins over the pre-upgrade copy; contracts §4, 2.1-Q35r), then the existing
    /// bytes are preserved without overwriting any earlier copy; an unwritable folder settles
    /// [`HomeWrite::CopyBlocked`] with nothing published.
    #[must_use]
    pub fn write(
        &self,
        key: &str,
        bytes: &[u8],
        expected: Option<&HomeVersion>,
        keep_previous: bool,
    ) -> HomeWrite {
        if bytes.len() as u64 > MAX_CANOPI_FILE_BYTES {
            return HomeWrite::Failed {
                failure: Failure::new(
                    FailureCode::Io {
                        io: IoFailureKind::TooLarge,
                    },
                    ops::HOME_WRITE,
                ),
            };
        }
        let resolved = match self.resolve(key) {
            Ok(resolved) => resolved,
            Err(_) => {
                return HomeWrite::Failed {
                    failure: Failure::new(FailureCode::Invalid, ops::HOME_WRITE),
                };
            }
        };
        let path = match &resolved {
            ResolvedHome::File(path) | ResolvedHome::Draft { path, .. } => path.clone(),
        };

        let outcome = self.locks.with_lock(&path, || {
            self.write_locked(&resolved, &path, bytes, expected, keep_previous)
        });
        if matches!(outcome, HomeWrite::Written { .. }) {
            // Record Recents outside the target lock so saves refresh Recents order (F6/N2).
            self.record_recent_from_bytes(&resolved, bytes);
        }
        outcome
    }

    fn write_locked(
        &self,
        resolved: &ResolvedHome,
        path: &Path,
        bytes: &[u8],
        expected: Option<&HomeVersion>,
        keep_previous: bool,
    ) -> HomeWrite {
        let precondition = match expected {
            None => Precondition::NotExists,
            Some(version) => Precondition::MatchesFingerprint(version.as_str().to_owned()),
        };

        // Check precondition BEFORE any pre-upgrade copy so conflict wins (contracts §4).
        let existing = match self.fs.fingerprint_file(path) {
            Ok(fingerprint) => fingerprint,
            Err(error) => {
                return HomeWrite::Failed {
                    failure: failure_from_io(&error),
                };
            }
        };
        match &precondition {
            Precondition::NotExists if existing.is_some() => {
                return HomeWrite::Conflict {
                    current: existing.map(HomeVersion::new),
                };
            }
            Precondition::MatchesFingerprint(want) if existing.as_deref() != Some(want) => {
                return HomeWrite::Conflict {
                    current: existing.map(HomeVersion::new),
                };
            }
            _ => {}
        }

        // Optional pre-upgrade copy (2.1-Q35r for files, 2.1-Q348 for Desktop 2.0 Drafts).
        if keep_previous
            && existing.is_some()
            && let Err(folder) = self.write_pre_upgrade_copy(resolved)
        {
            return HomeWrite::CopyBlocked { folder };
        }

        if matches!(resolved, ResolvedHome::Draft { .. })
            && let Err(error) = self.fs.create_dir_all(&self.drafts_dir)
        {
            return HomeWrite::Failed {
                failure: failure_from_io(&error),
            };
        }

        let publish_options = PublishOptions {
            sweep_stale_sidecars: true,
            ..PublishOptions::default()
        };
        match publish_durably_unlocked(
            &self.fs,
            PublishSource::Bytes(bytes),
            path,
            "home",
            precondition,
            &publish_options,
        ) {
            Ok(outcome) => {
                let version = outcome
                    .fingerprint
                    .unwrap_or_else(|| hash::sha256_hex(bytes));
                HomeWrite::Written {
                    version: HomeVersion::new(version),
                }
            }
            Err(DurableError::Conflict {
                current_fingerprint,
            }) => HomeWrite::Conflict {
                current: current_fingerprint.map(HomeVersion::new),
            },
            Err(DurableError::AlreadyExists) => {
                let current = self
                    .fs
                    .fingerprint_file(path)
                    .ok()
                    .flatten()
                    .map(HomeVersion::new);
                HomeWrite::Conflict { current }
            }
            Err(DurableError::TargetBusy { source, .. } | DurableError::Io(source)) => {
                HomeWrite::Failed {
                    failure: failure_from_io(&source),
                }
            }
            Err(DurableError::NotRegularFile) => HomeWrite::Failed {
                failure: Failure::new(
                    FailureCode::Io {
                        io: IoFailureKind::Other,
                    },
                    ops::HOME_WRITE,
                ),
            },
        }
    }

    fn write_pre_upgrade_copy(&self, resolved: &ResolvedHome) -> Result<(), String> {
        match resolved {
            ResolvedHome::File(path) => {
                let parent = path.parent().unwrap_or_else(|| Path::new("."));
                let folder_name = parent
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("folder")
                    .to_owned();
                let previous_bytes = self.fs.read_bytes(path).map_err(|_| folder_name.clone())?;
                let from_version = detect_previous_format_version(&previous_bytes);
                let stem = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("design");
                for attempt in 0..MAX_PRE_UPGRADE_COPY_ATTEMPTS {
                    let Some(candidate_name) =
                        canopi_format::chain::pre_upgrade_copy_name(stem, from_version, attempt)
                    else {
                        return Err(folder_name);
                    };
                    let candidate = parent.join(candidate_name);
                    // Publishing to `candidate` without taking `candidate`'s own target lock is
                    // safe: `Precondition::NotExists` (`persist_noclobber`) atomically refuses
                    // to overwrite if a concurrent writer claims the same name, and the loop
                    // advances to the next numbered suffix.
                    match publish_durably_unlocked(
                        &self.fs,
                        PublishSource::Bytes(&previous_bytes),
                        &candidate,
                        "copy",
                        Precondition::NotExists,
                        &PublishOptions::default(),
                    ) {
                        Ok(_) => return Ok(()),
                        Err(DurableError::AlreadyExists) => continue,
                        Err(_) => return Err(folder_name),
                    }
                }
                Err(folder_name)
            }
            ResolvedHome::Draft { id, path } => {
                let backup_dir = self.drafts_dir.join(BEFORE_V10_DIR);
                let backup_path = backup_dir.join(format!("{id}.{DRAFT_EXTENSION}"));
                if self.fs.path_exists(&backup_path) {
                    return Ok(());
                }
                let previous_bytes = self
                    .fs
                    .read_bytes(path)
                    .map_err(|_| BEFORE_V10_DIR.to_owned())?;
                self.fs
                    .create_dir_all(&backup_dir)
                    .map_err(|_| BEFORE_V10_DIR.to_owned())?;
                match publish_durably_unlocked(
                    &self.fs,
                    PublishSource::Bytes(&previous_bytes),
                    &backup_path,
                    "copy",
                    Precondition::NotExists,
                    &PublishOptions::default(),
                ) {
                    Ok(_) | Err(DurableError::AlreadyExists) => Ok(()),
                    Err(_) => Err(BEFORE_V10_DIR.to_owned()),
                }
            }
        }
    }
}

/// Reads the integer `"version"` field from a prior `.canopi` payload so the pre-upgrade copy
/// name uses `canopi-format`'s frozen [`canopi_format::chain::release_label`] table (contracts §10).
///
/// Unparseable bytes or missing/unrecognised versions intentionally fall back to
/// [`canopi_format::chain::CANOPI_FLOOR`] (`(Canopi 2.0)`): today every pre-v10 Design home is v9.
fn detect_previous_format_version(bytes: &[u8]) -> u32 {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|v| v.get("version").and_then(serde_json::Value::as_u64))
        .and_then(|v| u32::try_from(v).ok())
        .filter(|&v| canopi_format::chain::release_label(v).is_some())
        .unwrap_or(canopi_format::chain::CANOPI_FLOOR)
}

fn failure_from_io(error: &io::Error) -> Failure {
    Failure::new(
        FailureCode::Io {
            io: IoFailureKind::from(error.kind()),
        },
        ops::HOME_WRITE,
    )
}

#[cfg(test)]
mod tests;
