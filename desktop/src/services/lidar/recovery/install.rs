//! Putting a rebuilt catalogue in the catalogue's place (canopi-uidt).
//!
//! A rebuild writes a catalogue in a staging folder beside the catalogue and commits and closes it with no sidecar
//! left; only then is the old catalogue set aside with its sidecars and the rebuilt file moved into its place. Each
//! step a start can stop after leaves the old catalogue in place (recovered again) or none beside the originals
//! (rebuilt again, as `CatalogueState::Missing`), never an empty current catalogue standing in for an unrebuilt one.

use super::super::import::remove_dir_if_present;
use super::{RebuildReport, catalogue, now_stamp, rebuild, source_meta};
use crate::services::lidar::paths::{CATALOGUE_FILE, LidarPaths};
use std::path::{Path, PathBuf};

/// Folder under the library root a rebuild writes its catalogue in before it takes the catalogue's place.
pub const REBUILD_STAGING_DIR: &str = "lidar-library.rebuilding";

/// The files SQLite may keep beside a database, by suffix.
const SIDECARS: [&str; 3] = ["-wal", "-shm", "-journal"];

/// Whether `sources/` holds an original nothing marked released: what a missing catalogue would lose track of.
/// A `sources/` that cannot be listed is no proof of an empty library.
pub(super) fn holds_unreleased_originals(paths: &LidarPaths) -> Result<bool, String> {
    let entries = match std::fs::read_dir(paths.root().join("sources")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Failed to list the library's originals: {error}")),
    };
    Ok(entries.flatten().any(|entry| {
        let sha256 = entry.file_name().to_string_lossy().into_owned();
        paths.source_original(&sha256).is_file() && !source_meta::is_released(paths, &sha256)
    }))
}

/// What a stop part way through an earlier recovery left beside a missing catalogue: the staging folder goes, and a
/// sidecar of the catalogue that was set aside without it follows it under the set-aside folder.
pub(super) fn clear_interrupted_rebuild(paths: &LidarPaths) -> Result<(), String> {
    remove_dir_if_present(&staging_dir(paths))?;
    if present(&paths.catalogue_path())? {
        return Ok(());
    }
    set_aside_stray_sidecars(paths)
}

/// Rebuild into the staging folder, commit, then set the old catalogue aside and move the rebuilt file into its
/// place; returns where the old file went and what was rebuilt. Until the move the old catalogue stays where it was;
/// a failure before it removes the staging folder and fails, so the next start recovers again. A stop between the
/// set-aside and the move leaves no catalogue beside the originals, which the next start rebuilds again. Nothing
/// here touches an original.
pub(super) fn rebuild_in_place(
    paths: &LidarPaths,
) -> Result<(Option<PathBuf>, RebuildReport), String> {
    let staging = staging_dir(paths);
    remove_dir_if_present(&staging)?;
    let rebuilt = staging.join(CATALOGUE_FILE);
    let install = || -> Result<(Option<PathBuf>, RebuildReport), String> {
        std::fs::create_dir_all(&staging)
            .map_err(|e| format!("Failed to create the catalogue rebuild folder: {e}"))?;
        let report = build(&rebuilt, paths)?;
        let set_aside = if present(&paths.catalogue_path())? {
            Some(set_aside(paths)?)
        } else {
            None
        };
        // A sidecar left without its catalogue would be read as the rebuilt one's log.
        set_aside_stray_sidecars(paths)?;
        crate::db::move_aside(&rebuilt, std::iter::once(paths.catalogue_path()), &[])
            .map_err(|e| format!("Failed to put the rebuilt catalogue in place: {e}"))?;
        Ok((set_aside, report))
    };
    let installed = install();
    // Best effort: the next rebuild removes what stays.
    let _ = remove_dir_if_present(&staging);
    installed
}

/// The rebuilt catalogue at `path`, committed and closed with no sidecar beside it: a move takes only the main file.
/// The last connection to a WAL database to close checkpoints the log and removes it with the shared-memory file.
fn build(path: &Path, paths: &LidarPaths) -> Result<RebuildReport, String> {
    let connection = catalogue::open(path)?;
    let report = rebuild(&connection, paths)?;
    connection
        .close()
        .map_err(|(_, e)| format!("Failed to close the rebuilt catalogue: {e}"))?;
    match SIDECARS
        .iter()
        .find(|suffix| sidecar(path, suffix).exists())
    {
        Some(suffix) => Err(format!("The rebuilt catalogue kept its {suffix} file")),
        None => Ok(report),
    }
}

fn staging_dir(paths: &LidarPaths) -> PathBuf {
    paths.root().join(REBUILD_STAGING_DIR)
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Whether anything is at `path`; a failing look is no answer.
fn present(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Failed to look for a catalogue file: {error}")),
    }
}

/// Move each sidecar at the catalogue path whose catalogue is gone under the set-aside folder, byte for byte.
fn set_aside_stray_sidecars(paths: &LidarPaths) -> Result<(), String> {
    for suffix in SIDECARS {
        let stray = sidecar(&paths.catalogue_path(), suffix);
        if !present(&stray)? {
            continue;
        }
        let directory = set_aside_directory(paths)?;
        let stamp = now_stamp();
        let candidates =
            (0u32..=10_000).map(|n| directory.join(format!("{stamp}-stray-{n}.sqlite{suffix}")));
        crate::db::move_aside(&stray, candidates, &[])
            .map_err(|e| format!("Failed to set aside the catalogue's {suffix} file: {e}"))?;
    }
    Ok(())
}

/// Move the catalogue file and its WAL sidecars under the set-aside folder,
/// all or nothing: a sidecar that cannot follow returns the catalogue to its
/// place and fails, so no catalogue is rebuilt beside an old log.
/// Returns the new place of the main file.
fn set_aside(paths: &LidarPaths) -> Result<PathBuf, String> {
    let directory = set_aside_directory(paths)?;
    let stamp = now_stamp();
    let candidates = (0u32..=10_000).map(|attempt| match attempt {
        0 => directory.join(format!("{stamp}.sqlite")),
        n => directory.join(format!("{stamp}-{n}.sqlite")),
    });
    crate::db::move_aside(&paths.catalogue_path(), candidates, &["-wal", "-shm"])
        .map_err(|e| format!("Failed to set the catalogue aside: {e}"))
}

fn set_aside_directory(paths: &LidarPaths) -> Result<PathBuf, String> {
    let directory = paths.set_aside_dir();
    std::fs::create_dir_all(&directory)
        .map_err(|e| format!("Failed to create the set-aside folder: {e}"))?;
    Ok(directory)
}
