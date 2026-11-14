//! Putting a rebuilt catalogue in the catalogue's place (canopi-uidt).
//!
//! The rebuild is committed and closed in a staging file with no sidecar beside it. The old catalogue then gets a
//! forensic copy under the set-aside folder and stays at its path; its sidecars move under the same folder, since a
//! log left at the catalogue path would be replayed against the rebuilt file. One rename then replaces the old
//! catalogue with the rebuilt one atomically (`design::atomic_replace`: rename(2) on Unix, `MoveFileExW` replacing
//! the target on Windows). Any failure before that rename leaves the old main file at its path, which the next start
//! inspects and recovers again; a stop at any point leaves the old main file (with or without its sidecars) or the
//! complete rebuild. (Only if Windows refuses the replacing rename, `atomic_replace` moves the old file aside first;
//! a stop inside that fallback leaves no catalogue, which the next start rebuilds as `Missing`.)
//!
//! This module names only std and the crate's file helpers (`design`, `db`), so it stays out of the `services::lidar`
//! module cycle (`rust-scc`): its caller passes in every path.

use std::path::{Path, PathBuf};

/// Folder under the library root a rebuild writes its catalogue in before it takes the catalogue's place.
pub const REBUILD_STAGING_DIR: &str = "lidar-library.rebuilding";

/// The files SQLite may keep beside a database, by suffix.
const SIDECARS: [&str; 3] = ["-wal", "-shm", "-journal"];

/// A name in `staging` with no file and no sidecar at it (an earlier staging folder may not have been removed).
pub(super) fn free_staging_file(staging: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(staging)
        .map_err(|e| format!("Failed to create the catalogue rebuild folder: {e}"))?;
    for n in 0u32..=10_000 {
        let candidate = staging.join(format!("{n}.sqlite"));
        if !present_with_sidecars(&candidate)? {
            return Ok(candidate);
        }
    }
    Err("No free name to rebuild the catalogue under".to_string())
}

/// Replace the catalogue at `catalogue` with the committed and closed rebuild at `rebuilt`, keeping a copy of the
/// old one under `set_aside_dir` named after `stamp`. Returns where the old main file's copy went (none when there
/// was no main file). On failure the old main file is still at its path.
pub(super) fn install(
    rebuilt: &Path,
    catalogue: &Path,
    set_aside_dir: &Path,
    stamp: &str,
) -> Result<Option<PathBuf>, String> {
    // The rename takes only the main file: a log left beside it would be lost.
    if let Some(suffix) = SIDECARS
        .iter()
        .find(|suffix| sidecar(rebuilt, suffix).exists())
    {
        return Err(format!("The rebuilt catalogue kept its {suffix} file"));
    }
    let aside = set_aside(catalogue, set_aside_dir, stamp)?;
    crate::design::atomic_replace(rebuilt, catalogue)
        .map_err(|e| format!("Failed to put the rebuilt catalogue in place: {e}"))?;
    Ok(aside)
}

/// Copy the old main file under `directory` and move its sidecars beside the copy, under the first free
/// `<stamp>[-n].sqlite`. The main file stays at its path; a stop part way leaves at worst a duplicate copy.
fn set_aside(catalogue: &Path, directory: &Path, stamp: &str) -> Result<Option<PathBuf>, String> {
    let main = present(catalogue)?;
    let mut sidecars = Vec::new();
    for suffix in SIDECARS {
        if present(&sidecar(catalogue, suffix))? {
            sidecars.push(suffix);
        }
    }
    if !main && sidecars.is_empty() {
        return Ok(None);
    }
    std::fs::create_dir_all(directory)
        .map_err(|e| format!("Failed to create the set-aside folder: {e}"))?;
    let mut base = None;
    for n in 0u32..=10_000 {
        let candidate = match n {
            0 => directory.join(format!("{stamp}.sqlite")),
            n => directory.join(format!("{stamp}-{n}.sqlite")),
        };
        if !present_with_sidecars(&candidate)? {
            base = Some(candidate);
            break;
        }
    }
    let base = base.ok_or("No free name to set the catalogue aside under")?;
    if main {
        // A catalogue holds metadata only (no blobs), so reading it whole is small.
        let bytes = std::fs::read(catalogue)
            .map_err(|e| format!("Failed to read the catalogue to set it aside: {e}"))?;
        crate::design::write_file_durably(&base, &bytes, "set-aside")
            .map_err(|e| format!("Failed to set the catalogue aside: {e}"))?;
    }
    for suffix in sidecars {
        crate::db::move_aside(
            &sidecar(catalogue, suffix),
            std::iter::once(sidecar(&base, suffix)),
            &[],
        )
        .map_err(|e| format!("Failed to set aside the catalogue's {suffix} file: {e}"))?;
    }
    Ok(main.then_some(base))
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Whether anything is at `path` or at one of its sidecars.
fn present_with_sidecars(path: &Path) -> Result<bool, String> {
    let mut taken = present(path)?;
    for suffix in SIDECARS {
        taken |= present(&sidecar(path, suffix))?;
    }
    Ok(taken)
}

/// Whether anything is at `path`; a failing look is no answer.
fn present(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Failed to look for a catalogue file: {error}")),
    }
}
