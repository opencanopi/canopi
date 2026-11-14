//! Putting a rebuilt catalogue in the catalogue's place (canopi-uidt).
//!
//! Before anything is written, `sources/` is surveyed: an original's meta a newer Canopi wrote, or an entry that
//! cannot be read, withholds recovery altogether (`CatalogueState::Withheld`), so newer data is never written over
//! (2.1-M480) and an unreadable folder is never taken for an empty library. A rebuild then writes a catalogue in a
//! staging folder beside the catalogue and commits and closes it with no sidecar left; only then is the old
//! catalogue set aside with its sidecars and the rebuilt file moved into its place. A move that fails puts the old
//! catalogue back. Each step a start can stop after leaves the old catalogue in place (recovered again) or none
//! beside the originals (rebuilt again, as `CatalogueState::Missing`), never an empty current catalogue standing in
//! for an unrebuilt one. Moves go through `db::move_aside`, which checks its target is free before it renames: a
//! check a second process could race, which the single-instance lock rules out.

use super::super::import::remove_dir_if_present;
use super::{RebuildReport, catalogue, now_stamp, rebuild, source_meta};
use crate::services::lidar::paths::LidarPaths;
use std::path::{Path, PathBuf};

/// Folder under the library root a rebuild writes its catalogue in before it takes the catalogue's place.
pub const REBUILD_STAGING_DIR: &str = "lidar-library.rebuilding";

#[cfg(test)]
thread_local! {
    /// Fails the move of the rebuilt catalogue into place on this thread: a scanner holding the fresh file.
    pub(super) static FAIL_MOVE_INTO_PLACE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The files SQLite may keep beside a database, by suffix.
const SIDECARS: [&str; 3] = ["-wal", "-shm", "-journal"];

/// What `sources/` holds, as a rebuild would read it.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(super) struct Survey {
    /// An original nothing marked released: what a missing catalogue would lose track of.
    pub unreleased: bool,
    /// A `meta.json` declaring a version newer than this Canopi reads.
    pub newer: bool,
}

/// Survey `sources/`. Any entry, original or meta that cannot be read is an error: no proof of an empty library.
pub(super) fn survey(paths: &LidarPaths) -> Result<Survey, String> {
    let unread = |error: std::io::Error| format!("Failed to read the library's originals: {error}");
    let entries = match std::fs::read_dir(paths.root().join("sources")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Survey::default()),
        Err(error) => return Err(unread(error)),
    };
    let mut survey = Survey::default();
    for entry in entries {
        let entry = entry.map_err(unread)?;
        if !std::fs::metadata(entry.path()).map_err(unread)?.is_dir() {
            continue;
        }
        let sha256 = entry.file_name().to_string_lossy().into_owned();
        let original = match std::fs::metadata(paths.source_original(&sha256)) {
            Ok(metadata) => metadata.is_file(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(unread(error)),
        };
        let version = source_meta::stored_version(&paths.source_meta(&sha256))?;
        survey.newer |= version.is_some_and(|v| v > u64::from(source_meta::META_VERSION));
        survey.unreleased |= original && !source_meta::is_released(paths, &sha256);
    }
    Ok(survey)
}

/// What a stop part way through an earlier recovery left beside a missing catalogue: the staging folder goes (best
/// effort), and a sidecar whose catalogue is gone follows it under the set-aside folder, so SQLite never reads an old
/// log as a new catalogue's. (A zero-length catalogue's log is SQLite's to read: a WAL catalogue never checkpointed is
/// exactly that, and inspection reads it so.)
pub(super) fn clear_interrupted_rebuild(paths: &LidarPaths) -> Result<(), String> {
    discard_staging(paths);
    if present(&paths.catalogue_path())? {
        return Ok(());
    }
    set_aside_stray_sidecars(paths)
}

/// Best effort: a staging folder that cannot be removed now is removed by a later start, and never blocks one (a
/// rebuild stages under a free name beside what stays).
pub(super) fn discard_staging(paths: &LidarPaths) {
    let _ = remove_dir_if_present(&paths.root().join(REBUILD_STAGING_DIR));
}

/// Rebuild into the staging folder, commit, then set the old catalogue aside and move the rebuilt file into its
/// place; returns where the old file went and what was rebuilt. Until the move the old catalogue stays where it was;
/// a failure before it fails with the old catalogue untouched, and a failing move puts it back, so the next start
/// recovers again. A stop between the set-aside and the move leaves no catalogue beside the originals, which the
/// next start rebuilds again. Nothing here touches an original.
pub(super) fn rebuild_in_place(
    paths: &LidarPaths,
) -> Result<(Option<PathBuf>, RebuildReport), String> {
    discard_staging(paths);
    let rebuilt = (|| {
        let rebuilt = free_staging_file(paths)?;
        let report = build(&rebuilt, paths)?;
        Ok((install(paths, &rebuilt)?, report))
    })();
    discard_staging(paths);
    rebuilt
}

/// A name in the staging folder with no file and no sidecar at it.
fn free_staging_file(paths: &LidarPaths) -> Result<PathBuf, String> {
    let staging = paths.root().join(REBUILD_STAGING_DIR);
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("Failed to create the catalogue rebuild folder: {e}"))?;
    for n in 0u32..=10_000 {
        let candidate = staging.join(format!("{n}.sqlite"));
        let mut taken = present(&candidate)?;
        for suffix in SIDECARS {
            taken |= present(&sidecar(&candidate, suffix))?;
        }
        if !taken {
            return Ok(candidate);
        }
    }
    Err("No free name to rebuild the catalogue under".to_string())
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

/// Set the old catalogue aside and move `rebuilt` into its place; a failure after the set-aside moves the old
/// catalogue back. Returns where the old file went.
fn install(paths: &LidarPaths, rebuilt: &Path) -> Result<Option<PathBuf>, String> {
    let catalogue_path = paths.catalogue_path();
    let set_aside = if present(&catalogue_path)? {
        Some(set_aside(paths)?)
    } else {
        None
    };
    // A sidecar left without its catalogue would be read as the rebuilt one's log.
    let placed =
        set_aside_stray_sidecars(paths).and_then(|()| move_into_place(rebuilt, &catalogue_path));
    match (placed, &set_aside) {
        (Ok(()), _) => Ok(set_aside),
        (Err(error), None) => Err(error),
        (Err(error), Some(aside)) => {
            match crate::db::move_aside(aside, std::iter::once(catalogue_path), &["-wal", "-shm"]) {
                Ok(_) => Err(error),
                // No catalogue at its place: the next start rebuilds from the originals again.
                Err(back) => Err(format!(
                    "{error}; the old catalogue stays set aside: {back}"
                )),
            }
        }
    }
}

fn move_into_place(rebuilt: &Path, catalogue_path: &Path) -> Result<(), String> {
    #[cfg(test)]
    if FAIL_MOVE_INTO_PLACE.with(std::cell::Cell::get) {
        return Err("Failed to put the rebuilt catalogue in place: a test fault".to_string());
    }
    crate::db::move_aside(rebuilt, std::iter::once(catalogue_path.to_path_buf()), &[])
        .map(|_| ())
        .map_err(|e| format!("Failed to put the rebuilt catalogue in place: {e}"))
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

/// Move each sidecar at the catalogue path whose catalogue is gone under the set-aside folder, byte for byte. One
/// that a stop separated from its set-aside catalogue lands under its own name: a forensic copy, never read.
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
