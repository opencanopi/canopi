//! Desktop Design home store and file grant registry (2b-4; contracts §4, ADR 0027, 2.1-M155).
//!
//! One `home_read` / `home_write` port resolves both host-issued [`FileGrantId`]s and
//! validated [`DraftId`]s (`{app_data}/drafts/<id>.canopi`) behind `canopi-support`'s
//! [`DurableFs`] and case-folded [`TargetLocks`]. No Draft path or raw user path crosses
//! to the frontend.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use canopi_support::durable::{
    DurableError, DurableFs, OsDurableFs, Precondition, PublishOptions, PublishSource, TargetLocks,
    publish_durably_unlocked,
};
use canopi_support::hash;
use canopi_types::design_home::{HomeRead, HomeWrite};
use canopi_types::failure::{Failure, FailureCode, IoFailureKind, ops};
use canopi_types::ids::{FileGrantId, HomeVersion};

use crate::design::format::MAX_CANOPI_FILE_BYTES;

const GRANT_PREFIX: &str = "grant:";
const DRAFTS_DIR: &str = "drafts";
const BEFORE_V10_DIR: &str = "before-v10";
const DRAFT_EXTENSION: &str = "canopi";
const MAX_DRAFT_ID_LEN: usize = 64;
const PRE_UPGRADE_TAG: &str = " (before 2.1)";
const MAX_PRE_UPGRADE_COPY_ATTEMPTS: u32 = 1000;

/// Canonical identity of a granted Design file: canonical parent directory + exact file name
/// (never the inode; contracts §4, ADR 0027).
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
    pub fn grant(&self, path: &Path) -> Result<FileGrantId, String> {
        let parent = path
            .parent()
            .filter(|dir| !dir.as_os_str().is_empty())
            .ok_or_else(|| "file grant target has no parent directory".to_owned())?;
        let file_name = path
            .file_name()
            .ok_or_else(|| "file grant target has no file name".to_owned())?
            .to_os_string();
        let canonical_parent =
            std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
        let resolved_path = canonical_parent.join(&file_name);
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
        table.by_id.insert(id.clone(), resolved_path);
        Ok(id)
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

/// Validates a `DraftId`: `[a-z0-9-]{1,64}` so it can only name a direct child of `drafts/`.
#[must_use]
pub fn is_valid_draft_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_DRAFT_ID_LEN
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
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
}

impl DesktopHomeStore<OsDurableFs> {
    /// Production Desktop home store under `{app_data_dir}/drafts` backed by [`OsDurableFs`].
    #[must_use]
    pub fn production(app_data_dir: &Path, grants: Arc<FileGrantRegistry>) -> Self {
        Self::with_fs(
            app_data_dir.join(DRAFTS_DIR),
            grants,
            Arc::new(TargetLocks::new()),
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
        match self.fs.read_bytes(path) {
            Ok(bytes) => {
                if bytes.len() as u64 > MAX_CANOPI_FILE_BYTES {
                    return HomeRead::Unreadable {
                        reason: "design exceeds the maximum readable size".to_owned(),
                    };
                }
                let version = HomeVersion::new(hash::sha256_hex(&bytes));
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

        self.locks.with_lock(&path, || {
            self.write_locked(&resolved, &path, bytes, expected, keep_previous)
        })
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

        match publish_durably_unlocked(
            &self.fs,
            PublishSource::Bytes(bytes),
            path,
            "home",
            precondition,
            &PublishOptions::default(),
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
                let stem = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("design");
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or(DRAFT_EXTENSION);
                for attempt in 1..=MAX_PRE_UPGRADE_COPY_ATTEMPTS {
                    let candidate_name = if attempt == 1 {
                        format!("{stem}{PRE_UPGRADE_TAG}.{ext}")
                    } else {
                        format!("{stem}{PRE_UPGRADE_TAG} {attempt}.{ext}")
                    };
                    let candidate = parent.join(candidate_name);
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
