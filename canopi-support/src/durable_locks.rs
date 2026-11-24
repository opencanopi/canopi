//! Per-target mutual exclusion table (`TargetLocks`) with volume-aware case
//! folding (ADR 0023, contracts §11).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

static GLOBAL_TARGET_LOCKS: OnceLock<TargetLocks> = OnceLock::new();

/// Per-target mutual exclusion table (ADR 0023, contracts §11).
///
/// Serializes precondition checks and publishes for the same target path. On
/// case-insensitive volumes, keys are case-folded so `Garden.canopi` and
/// `garden.canopi` take the same lock.
#[derive(Debug, Default)]
pub struct TargetLocks {
    registry: Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>,
    case_fold_override: Option<bool>,
    volume_case_cache: Mutex<HashMap<PathBuf, bool>>,
}

impl TargetLocks {
    /// Create a new owned lock table that auto-detects volume case-sensitivity.
    pub fn new() -> Self {
        Self::default()
    }

    /// Create an owned lock table with an explicit case-folding mode (used by
    /// tests and [`crate::fault_fs::FaultFs`] to exercise case-insensitive
    /// locking deterministically on any OS).
    pub fn with_case_folding(case_insensitive: bool) -> Self {
        Self {
            registry: Mutex::new(HashMap::new()),
            case_fold_override: Some(case_insensitive),
            volume_case_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Process-wide default lock table for call sites not yet wired with an
    /// owned store instance.
    pub fn global() -> &'static Self {
        GLOBAL_TARGET_LOCKS.get_or_init(Self::new)
    }

    /// Compute the normalized lock key for `target` (case-folded when its
    /// volume is case-insensitive).
    pub fn lock_key(&self, target: &Path) -> PathBuf {
        let parent = parent_dir(target);
        let canonical_parent = parent
            .canonicalize()
            .unwrap_or_else(|_| absolute_path(parent));
        let case_insensitive = self.is_volume_case_insensitive(&canonical_parent);
        let key_parent = if case_insensitive {
            fold_path(&canonical_parent)
        } else {
            canonical_parent
        };
        match target.file_name() {
            Some(name) if case_insensitive => {
                key_parent.join(name.to_string_lossy().to_lowercase())
            }
            Some(name) => key_parent.join(name),
            None => key_parent,
        }
    }

    /// Run `operation` exclusively for `target`.
    pub fn with_lock<T>(&self, target: &Path, operation: impl FnOnce() -> T) -> T {
        let key = self.lock_key(target);
        let admission = {
            let mut map = self.registry.lock().unwrap_or_else(|poisoned| {
                tracing::warn!("Recovering poisoned TargetLocks registry");
                poisoned.into_inner()
            });
            map.retain(|_, entry| entry.strong_count() > 0);
            map.get(&key).and_then(Weak::upgrade).unwrap_or_else(|| {
                let lock = Arc::new(Mutex::new(()));
                map.insert(key.clone(), Arc::downgrade(&lock));
                lock
            })
        };
        let _guard = admission.lock().unwrap_or_else(|poisoned| {
            tracing::warn!("Recovering poisoned TargetLocks entry");
            poisoned.into_inner()
        });
        operation()
    }

    fn is_volume_case_insensitive(&self, canonical_parent: &Path) -> bool {
        if let Some(forced) = self.case_fold_override {
            return forced;
        }
        let mut cache = self.volume_case_cache.lock().unwrap_or_else(|poisoned| {
            tracing::warn!("Recovering poisoned TargetLocks volume cache");
            poisoned.into_inner()
        });
        if let Some(&cached) = cache.get(canonical_parent) {
            return cached;
        }
        let detected = detect_case_insensitive_volume(canonical_parent);
        cache.insert(canonical_parent.to_path_buf(), detected);
        detected
    }
}

pub(crate) fn parent_dir(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
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

fn fold_path(path: &Path) -> PathBuf {
    PathBuf::from(path.to_string_lossy().to_lowercase())
}

#[cfg(windows)]
fn detect_case_insensitive_volume(_dir: &Path) -> bool {
    true
}

#[cfg(not(windows))]
fn detect_case_insensitive_volume(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return cfg!(target_os = "macos");
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(text) = name.to_str() else {
            continue;
        };
        let flipped: String = text
            .chars()
            .map(|c| {
                if c.is_ascii_lowercase() {
                    c.to_ascii_uppercase()
                } else if c.is_ascii_uppercase() {
                    c.to_ascii_lowercase()
                } else {
                    c
                }
            })
            .collect();
        if flipped == text {
            continue;
        }
        let other = dir.join(&flipped);
        if let (Ok(a), Ok(b)) = (
            std::fs::symlink_metadata(entry.path()),
            std::fs::symlink_metadata(&other),
        ) {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt as _;
                return a.dev() == b.dev() && a.ino() == b.ino();
            }
            #[cfg(not(unix))]
            {
                let _ = (a, b);
                return true;
            }
        }
        return false;
    }
    cfg!(target_os = "macos")
}
