//! Per-target mutual exclusion table (`TargetLocks`) with volume-aware case
//! folding (ADR 0023, contracts §11).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

static NEXT_CASE_PROBE_ID: AtomicU64 = AtomicU64::new(0);

/// Per-target mutual exclusion table (ADR 0023, contracts §11).
///
/// Serializes precondition checks and publishes for the same target path. On
/// case-insensitive volumes, keys are case-folded so `Garden.canopi` and
/// `garden.canopi` take the same lock.
#[derive(Debug)]
pub struct TargetLocks {
    registry: Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>,
    case_fold_override: Option<bool>,
    volume_probe: fn(&Path) -> bool,
    volume_case_cache: Mutex<HashMap<PathBuf, bool>>,
}

impl Default for TargetLocks {
    fn default() -> Self {
        Self::new()
    }
}

impl TargetLocks {
    /// Create a new owned lock table that auto-detects volume case-sensitivity
    /// by probing each target directory once.
    pub fn new() -> Self {
        Self {
            registry: Mutex::new(HashMap::new()),
            case_fold_override: None,
            volume_probe: detect_case_insensitive_volume,
            volume_case_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Create an owned lock table with an explicit case-folding mode (used by
    /// tests and [`crate::fault_fs::FaultFs`] to exercise case-insensitive
    /// locking deterministically on any OS).
    pub fn with_case_folding(case_insensitive: bool) -> Self {
        Self {
            registry: Mutex::new(HashMap::new()),
            case_fold_override: Some(case_insensitive),
            volume_probe: detect_case_insensitive_volume,
            volume_case_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Create an owned lock table using a custom volume case-sensitivity probe
    /// (used by tests to verify caching and probe-driven folding without
    /// mounting a FAT32/exFAT volume).
    pub fn with_volume_probe(probe: fn(&Path) -> bool) -> Self {
        Self {
            registry: Mutex::new(HashMap::new()),
            case_fold_override: None,
            volume_probe: probe,
            volume_case_cache: Mutex::new(HashMap::new()),
        }
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
        let detected = (self.volume_probe)(canonical_parent);
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

/// Probe whether `dir` resides on a case-insensitive volume by creating a
/// lowercase probe file and stating its uppercase sibling.
///
/// If the probe cannot run (for example, a read-only or not-yet-created
/// folder), defaults to `true` (case folding): folding on a case-sensitive
/// volume only serializes more writes than necessary, which is safe, whereas
/// missing a case-insensitive volume risks lost updates.
#[cfg(windows)]
pub fn detect_case_insensitive_volume(_dir: &Path) -> bool {
    true
}

/// Probe whether `dir` resides on a case-insensitive volume by creating a
/// lowercase probe file and stating its uppercase sibling.
///
/// If the probe cannot run (for example, a read-only or not-yet-created
/// folder), defaults to `true` (case folding): folding on a case-sensitive
/// volume only serializes more writes than necessary, which is safe, whereas
/// missing a case-insensitive volume risks lost updates.
#[cfg(not(windows))]
pub fn detect_case_insensitive_volume(dir: &Path) -> bool {
    let pid = std::process::id();
    let id = NEXT_CASE_PROBE_ID.fetch_add(1, Ordering::Relaxed);
    let lower_name = format!(".canopi-case-probe-{pid:x}-{id:x}-a");
    let upper_name = lower_name.to_ascii_uppercase();
    let lower_path = dir.join(&lower_name);
    let upper_path = dir.join(&upper_name);

    let Ok(file) = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lower_path)
    else {
        return true;
    };
    drop(file);

    let result = match (
        std::fs::symlink_metadata(&lower_path),
        std::fs::symlink_metadata(&upper_path),
    ) {
        (Ok(a), Ok(b)) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt as _;
                a.dev() == b.dev() && a.ino() == b.ino()
            }
            #[cfg(not(unix))]
            {
                let _ = (a, b);
                true
            }
        }
        (Ok(_), Err(err)) if err.kind() == std::io::ErrorKind::NotFound => false,
        _ => true,
    };
    let _ = std::fs::remove_file(&lower_path);
    result
}
