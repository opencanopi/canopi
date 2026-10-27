//! Managed filesystem layout for the LiDAR library.
//!
//! The library owns immutable originals, prepared numeric rasters, analysis
//! outputs and the bounded display cache under the app data directory. The
//! `.canopi` document never references these paths.
//!
//! Capacity is checked here rather than guessed: preparing a bounded raster
//! derivative and writing new numeric outputs both need measurable free space,
//! and a platform that cannot report it fails with a named reason instead of
//! risking a half-written result.

use std::path::{Path, PathBuf};

/// Catalogue file name inside the library root.
pub const CATALOGUE_FILE: &str = "lidar-library.sqlite";

/// Name prefix of an analysis job's scratch directory; the rest is its job id.
pub const ANALYSIS_SCRATCH_PREFIX: &str = "scratch-analysis-";

/// Managed library root under the app data directory.
pub fn library_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("lidar")
}

#[derive(Debug, Clone)]
pub struct LidarPaths {
    root: PathBuf,
}

impl LidarPaths {
    pub fn open(app_data_dir: &Path) -> Result<Self, String> {
        let root = library_root(app_data_dir);
        for dir in [
            root.clone(),
            self_sources_dir(&root),
            self_prepared_dir(&root),
            root.join("display-cog"),
            root.join("display-cog-staging"),
            root.join("assets"),
            root.join("jobs"),
            root.join("engine-logs"),
        ] {
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("Failed to create LiDAR dir {}: {e}", dir.display()))?;
        }
        Ok(Self { root })
    }

    pub fn catalogue_path(&self) -> PathBuf {
        self.root.join(CATALOGUE_FILE)
    }

    /// Library root. Catalogue asset references stay relative to it, so a
    /// moved library stays readable.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn display_cache_path(&self) -> PathBuf {
        self.root.join("lidar-display-cache.sqlite")
    }

    /// Content-addressed immutable resolved/quality COG assets.
    pub fn asset_dir(&self, sha256: &str) -> PathBuf {
        self.root.join("assets").join(sha256)
    }

    /// One immutable COG asset by digest: a retained source, a resolved
    /// generation chunk or an analysis quality chunk.
    pub fn asset_cog(&self, sha256: &str) -> PathBuf {
        self.asset_dir(sha256).join("cog.tif")
    }

    /// Immutable imported originals: `sources/<sha256>/original`.
    ///
    /// A retained source COG is not stored here: it is content-addressed under
    /// `assets/<sha256>/cog.tif`, so identical content is shared rather than
    /// copied beside the original.
    pub fn source_dir(&self, sha256: &str) -> PathBuf {
        self.root.join("sources").join(sha256)
    }

    pub fn source_original(&self, sha256: &str) -> PathBuf {
        self.source_dir(sha256).join("original")
    }

    /// The derived record beside an original that a catalogue rebuild reads
    /// (`source_meta.rs`).
    pub fn source_meta(&self, sha256: &str) -> PathBuf {
        self.source_dir(sha256).join(super::source_meta::META_FILE)
    }

    /// Catalogues an older or corrupt library left behind, kept byte for byte.
    pub fn set_aside_dir(&self) -> PathBuf {
        self.root.join(super::recovery::SET_ASIDE_DIR)
    }

    /// Holds only per-job analysis scratch directories.
    pub fn prepared_dir(&self) -> PathBuf {
        self.root.join("prepared")
    }

    /// One analysis job's scratch; removed when the job settles and swept at
    /// startup if a crash left it.
    pub fn analysis_scratch_dir(&self, job_id: &str) -> PathBuf {
        self.prepared_dir()
            .join(format!("{ANALYSIS_SCRATCH_PREFIX}{job_id}"))
    }

    /// Captured stdout and stderr of running engine children; swept at startup.
    pub fn engine_log_dir(&self) -> PathBuf {
        self.root.join("engine-logs")
    }

    /// Published display derivatives: immutable, content-keyed tiled COGs the
    /// WebView reads through the scoped asset protocol. Regenerable, never
    /// numeric authority.
    pub fn display_cog_dir(&self) -> PathBuf {
        self.root.join("display-cog")
    }

    /// Derivatives being written; outside the asset scope so a partial file is
    /// never readable. A file is renamed into `display_cog_dir` only once complete.
    pub fn display_cog_staging_dir(&self) -> PathBuf {
        self.root.join("display-cog-staging")
    }

    pub fn jobs_dir(&self) -> PathBuf {
        self.root.join("jobs")
    }

    /// Per-job scratch directory; removed when the job settles.
    pub fn job_dir(&self, job_id: &str) -> PathBuf {
        self.jobs_dir().join(job_id)
    }
}

/// Fail unless `directory` can hold `required_bytes` more data.
///
/// `what` names the work the requirement belongs to so a failed job reports
/// which output could not be safely written; the folder is never named, since
/// its path can spell out the user's name. An unreadable capacity is an
/// error, never a silent pass: guessing here is what produces truncated
/// numeric outputs.
pub(crate) fn require_free_space(
    directory: &Path,
    required_bytes: u64,
    what: &str,
) -> Result<(), String> {
    let available = available_bytes(directory)?;
    if available < required_bytes {
        return Err(format!(
            "{what} needs at least {} MiB ({required_bytes} bytes) free on the data library's disk, but only {} MiB ({available} bytes) is available",
            required_bytes / (1024 * 1024),
            available / (1024 * 1024),
        ));
    }
    Ok(())
}

/// Free bytes available to this process on the filesystem holding `directory`.
///
/// This is a measurement, not a reservation: another process can consume the
/// space immediately afterwards, so every caller still propagates ordinary
/// write errors and rechecks between bounded writes.
pub(crate) fn available_bytes(directory: &Path) -> Result<u64, String> {
    #[cfg(test)]
    {
        if let Some(available) = capacity_probe::observed() {
            return Ok(available);
        }
    }
    platform_available_bytes(directory)
        .map_err(|error| format!("Cannot verify free space on the data library's disk: {error}"))
}

/// `statvfs` fields differ in width across unix targets (`u32` on some, `u64`
/// on others), so each one is widened losslessly through `Into` rather than
/// cast: a cast could truncate, and `u64::from` is a useless conversion where
/// the field is already `u64`.
#[cfg(unix)]
fn widen(value: impl Into<u64>) -> u64 {
    value.into()
}

#[cfg(unix)]
fn platform_available_bytes(directory: &Path) -> Result<u64, std::io::Error> {
    use std::os::unix::ffi::OsStrExt as _;
    let mut path = directory.as_os_str().as_bytes().to_vec();
    path.push(0);
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is a NUL-terminated byte string and `stats` is valid
    // writable memory for one `statvfs`; the call is checked before use.
    let status = unsafe { libc::statvfs(path.as_ptr().cast(), stats.as_mut_ptr()) };
    if status != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: a zero return from `statvfs` initializes the whole struct.
    let stats = unsafe { stats.assume_init() };
    Ok(widen(stats.f_bavail).saturating_mul(widen(stats.f_frsize)))
}

#[cfg(windows)]
fn platform_available_bytes(directory: &Path) -> Result<u64, std::io::Error> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut path: Vec<u16> = directory.as_os_str().encode_wide().collect();
    path.push(0);
    let mut available = 0u64;
    // SAFETY: `path` is NUL-terminated and `available` is valid writable
    // memory; the returned status is checked before the value is used.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(available)
}

#[cfg(not(any(unix, windows)))]
fn platform_available_bytes(_directory: &Path) -> Result<u64, std::io::Error> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "this platform has no free-space facility",
    ))
}

fn self_sources_dir(root: &Path) -> PathBuf {
    root.join("sources")
}

fn self_prepared_dir(root: &Path) -> PathBuf {
    root.join("prepared")
}

/// Test-only seam for the capacity observation.
///
/// Tests that must exercise a specific budget override the observation for
/// their own thread instead of filling a real filesystem. Only the
/// observation is replaced; the budget decision under test stays production
/// code, and nothing in a production build reads this.
#[cfg(test)]
pub(crate) mod capacity_probe {
    use std::cell::Cell;

    thread_local! {
        static OBSERVED: Cell<Option<u64>> = const { Cell::new(None) };
    }

    pub(crate) fn observed() -> Option<u64> {
        OBSERVED.with(Cell::get)
    }

    pub(crate) fn set(available: Option<u64>) {
        OBSERVED.with(|slot| slot.set(available));
    }

    /// Override the observed capacity until the guard is dropped.
    pub(crate) fn override_available(available: u64) -> Guard {
        set(Some(available));
        Guard
    }

    pub(crate) struct Guard;

    impl Drop for Guard {
        fn drop(&mut self) {
            set(None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// canopi-bkbh: a free-space refusal names the work and the sizes, never
    /// the folder, whose path can spell out the user's name.
    #[test]
    fn a_free_space_refusal_names_no_directory() {
        let _full = capacity_probe::override_available(1024);
        let directory = Path::new("/home/someone/.local/share/canopi/lidar/display-cog");
        let error = require_free_space(directory, 1 << 30, "The display derivative").unwrap_err();
        assert!(error.contains("The display derivative"), "{error}");
        assert!(!error.contains("/home/someone"), "{error}");
    }
}
