use common_types::design::{
    CanopiFile, DesignLoadFailure, DesignSaveOutcome, DesignSummary, LoadedDesign,
};
use std::path::{Path, PathBuf};

use crate::db::UserDb;
use crate::design::format;

const RECENT_DESIGNS_LIMIT: usize = 20;

pub fn new_design() -> Result<CanopiFile, String> {
    Ok(format::create_new_design("Untitled", now_iso8601()))
}

fn now_iso8601() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    crate::design::unix_to_iso8601(seconds)
}

/// Save a Design to its file. With `expected_fingerprint`, a file changed
/// outside Canopi since then is left alone and reported as a conflict.
pub fn save_design(
    user_db: &UserDb,
    path: String,
    content: CanopiFile,
    expected_fingerprint: Option<String>,
) -> Result<DesignSaveOutcome, String> {
    let dest = std::path::PathBuf::from(&path);
    match format::save_to_file(&dest, &content, expected_fingerprint.as_deref())? {
        format::SaveResult::Saved { fingerprint } => {
            try_record_recent(user_db, &path, &content.name);
            // Design names and paths are user content; logs reach Diagnostic Bundles.
            tracing::info!("Design saved");
            Ok(DesignSaveOutcome::Saved { path, fingerprint })
        }
        format::SaveResult::Conflict {
            current_fingerprint,
        } => {
            tracing::info!("Design save stopped: the file changed outside Canopi");
            Ok(DesignSaveOutcome::Conflict {
                current_fingerprint,
            })
        }
    }
}

pub fn export_design_file(path: String, content: CanopiFile) -> Result<String, String> {
    let dest = std::path::PathBuf::from(&path);
    format::export_to_file(&dest, &content)?;
    tracing::info!("Design file exported");
    Ok(path)
}

/// Open a Design file. Only the current format opens; an older one is
/// refused as `OlderVersion` (ADR 0021).
pub fn load_design(user_db: &UserDb, path: String) -> Result<LoadedDesign, DesignLoadFailure> {
    let dest = std::path::PathBuf::from(&path);
    let (file, fingerprint) = format::load_with_fingerprint(&dest).map_err(|error| {
        tracing::info!(kind = ?error.failure().kind, "Design could not be opened");
        error.failure()
    })?;
    try_record_recent(user_db, &path, &file.name);
    tracing::info!("Design loaded");
    Ok(LoadedDesign { file, fingerprint })
}

/// Read a Design file for a stamp import, without listing it as recent.
/// Failures are typed like `load_design`'s, so an older file says why.
pub fn load_design_file(path: String) -> Result<CanopiFile, DesignLoadFailure> {
    let dest = std::path::PathBuf::from(&path);
    let design = format::load_from_file(&dest).map_err(|error| {
        tracing::info!(kind = ?error.failure().kind, "Design could not be read for import");
        error.failure()
    })?;
    tracing::info!("Design file loaded for import");
    Ok(design)
}

pub fn get_recent_files(user_db: &UserDb) -> Result<Vec<DesignSummary>, String> {
    let recent = {
        let conn = user_db.acquire();
        crate::db::recent_files::get_recent_files(&conn, crate::db::recent_files::RECENT_FILES_KEPT)
            .map_err(|e| format!("Failed to get recent files: {e}"))?
    };

    let filtered = partition_by_availability(
        recent,
        |file| &file.path,
        Some(RECENT_DESIGNS_LIMIT),
        design_path_availability,
    );
    for path in &filtered.missing_paths {
        let conn = user_db.acquire();
        if let Err(error) = crate::db::recent_files::remove_recent_file(&conn, path) {
            tracing::warn!("Failed to prune a missing Recent Design: {error}");
        }
    }
    Ok(filtered.visible)
}

/// Start › Recent Designs › Remove from list. The file itself is untouched.
pub fn remove_recent_design(user_db: &UserDb, path: &str) -> Result<(), String> {
    let conn = user_db.acquire();
    crate::db::recent_files::remove_recent_file(&conn, path)
        .map_err(|error| format!("Failed to remove the Design from Recent Designs: {error}"))
}

/// The paths, among `paths`, that are on the Recent Designs list: previews
/// read only listed files, at most one list's worth, each once. The list is
/// read once; the caller's input never drives a query per entry.
pub fn listed_recent_paths(user_db: &UserDb, paths: Vec<String>) -> Result<Vec<String>, String> {
    let on_list: std::collections::HashSet<String> = {
        let conn = user_db.acquire();
        crate::db::recent_files::get_recent_files(&conn, crate::db::recent_files::RECENT_FILES_KEPT)
            .map_err(|error| format!("Failed to read Recent Designs: {error}"))?
            .into_iter()
            .map(|file| file.path)
            .collect()
    };
    let mut listed: Vec<String> = Vec::new();
    for path in paths {
        if listed.len() == RECENT_DESIGNS_LIMIT {
            break;
        }
        if on_list.contains(&path) && !listed.contains(&path) {
            listed.push(path);
        }
    }
    Ok(listed)
}

/// A Recent Design's file, for Show in folder. Only a path on the list, in a
/// folder, is accepted, so the command cannot reveal an arbitrary file.
pub fn recent_design_file(user_db: &UserDb, path: &str) -> Result<PathBuf, String> {
    let listed = {
        let conn = user_db.acquire();
        crate::db::recent_files::is_recent_file(&conn, path)
            .map_err(|error| format!("Failed to read Recent Designs: {error}"))?
    };
    if !listed {
        return Err("This Design is not in Recent Designs.".to_owned());
    }
    let file = PathBuf::from(path);
    match file.parent() {
        Some(folder) if !folder.as_os_str().is_empty() => Ok(file),
        _ => Err("This Design has no folder to show.".to_owned()),
    }
}

/// Show a Recent Design selected in its folder, once it is known to be a file.
pub(crate) fn show_design_in_folder(
    file: &Path,
    revealer: &impl crate::services::folder_reveal::FolderRevealer,
) -> Result<(), String> {
    if !file.is_file() {
        return Err("The file of this Design is not available.".to_owned());
    }
    revealer.reveal_item(file)
}

fn try_record_recent(user_db: &UserDb, path: &str, name: &str) {
    let conn = user_db.acquire();
    if let Err(error) = crate::db::recent_files::record_recent_file(&conn, path, name) {
        tracing::warn!("Failed to record a Recent Design: {error}");
    }
}

/// Whether a remembered Design path (Recent Designs, Design Notebook) can be
/// shown, must be forgotten, or is temporarily out of reach.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DesignPathAvailability {
    /// A regular file is at the path.
    Available,
    /// The parent directory is readable and the file is gone (deleted or
    /// renamed): the reference is safe to forget.
    Missing,
    /// The file cannot be checked right now, e.g. its drive is unplugged or
    /// unmounted, or permission is denied. The reference is kept and hidden.
    Unavailable,
}

pub(crate) fn design_path_availability(path: &Path) -> DesignPathAvailability {
    match path.metadata() {
        Ok(metadata) if metadata.is_file() => DesignPathAvailability::Available,
        Ok(_) => DesignPathAvailability::Missing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent_is_present = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .and_then(|parent| parent.metadata().ok())
                .is_some_and(|metadata| metadata.is_dir());
            if parent_is_present {
                DesignPathAvailability::Missing
            } else {
                DesignPathAvailability::Unavailable
            }
        }
        Err(error) => {
            tracing::warn!("A remembered Design could not be checked for availability: {error}");
            DesignPathAvailability::Unavailable
        }
    }
}

pub(crate) struct AvailabilityPartition<T> {
    pub(crate) visible: Vec<T>,
    pub(crate) missing_paths: Vec<String>,
}

/// Split remembered Design references into the ones to show (up to `limit`)
/// and the missing ones to forget. Unavailable references are neither shown
/// nor forgotten.
pub(crate) fn partition_by_availability<T>(
    entries: Vec<T>,
    path_of: impl Fn(&T) -> &str,
    limit: Option<usize>,
    mut availability: impl FnMut(&Path) -> DesignPathAvailability,
) -> AvailabilityPartition<T> {
    let mut visible = Vec::new();
    let mut missing_paths = Vec::new();
    for entry in entries {
        match availability(Path::new(path_of(&entry))) {
            DesignPathAvailability::Available => {
                if limit.is_none_or(|limit| visible.len() < limit) {
                    visible.push(entry);
                }
            }
            DesignPathAvailability::Missing => missing_paths.push(path_of(&entry).to_owned()),
            DesignPathAvailability::Unavailable => {}
        }
    }
    AvailabilityPartition {
        visible,
        missing_paths,
    }
}

/// Run `operation` and return the log lines it emitted on this thread,
/// formatted as the backend log file would receive them.
///
/// Uses one process-wide subscriber that writes into a per-thread buffer: a
/// scoped subscriber would race other test threads for the callsite interest
/// cache and could silently miss events.
#[cfg(test)]
pub(crate) fn capture_logs<R>(operation: impl FnOnce() -> R) -> (R, String) {
    use std::cell::RefCell;

    thread_local! {
        static CAPTURED: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
    }

    struct ThreadBuffer;
    impl std::io::Write for ThreadBuffer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            CAPTURED.with(|captured| {
                if let Some(buffer) = captured.borrow_mut().as_mut() {
                    buffer.extend_from_slice(bytes);
                }
            });
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .with_writer(|| ThreadBuffer)
            .finish();
        tracing::subscriber::set_global_default(subscriber)
            .expect("no other test installs a global log subscriber");
    });
    tracing::callsite::rebuild_interest_cache();

    CAPTURED.with(|captured| *captured.borrow_mut() = Some(Vec::new()));
    let result = operation();
    let logs = CAPTURED
        .with(|captured| captured.borrow_mut().take())
        .unwrap_or_default();
    (result, String::from_utf8_lossy(&logs).into_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        DesignPathAvailability, design_path_availability, export_design_file, get_recent_files,
        load_design, load_design_file, partition_by_availability, recent_design_file,
        remove_recent_design, save_design, show_design_in_folder,
    };
    use crate::db::UserDb;
    use crate::services::folder_reveal::recording::{RecordingRevealer, Shown};
    use crate::test_scratch::TestScratch;
    use common_types::design::{
        CanopiFile, DesignLoadFailure, DesignLoadFailureKind, DesignSaveOutcome, DesignSummary,
        LoadedDesign,
    };
    use rusqlite::Connection;
    use std::path::PathBuf;

    fn loaded_design(outcome: Result<LoadedDesign, DesignLoadFailure>) -> LoadedDesign {
        outcome.expect("the Design loads")
    }

    fn test_user_db() -> UserDb {
        let conn = Connection::open_in_memory().unwrap();
        UserDb::initialize(conn).unwrap()
    }

    fn test_design(name: &str) -> CanopiFile {
        crate::design::format::create_new_design(name, "2026-07-02T00:00:00Z")
    }

    fn temp_design_path(scratch: &TestScratch, name: &str) -> PathBuf {
        scratch.join(format!("{name}.canopi"))
    }

    fn design_summary(path: &str, name: &str) -> DesignSummary {
        DesignSummary {
            path: path.to_owned(),
            name: name.to_owned(),
            updated_at: "2026-07-02T00:00:00Z".to_owned(),
        }
    }

    #[test]
    fn save_and_load_design_round_trip_records_recent_file() {
        let scratch =
            TestScratch::new("design-files-save-and-load-design-round-trip-records-recent-file");
        let user_db = test_user_db();
        let design = test_design("Service Demo");
        let path = temp_design_path(&scratch, "round_trip");

        let outcome = save_design(
            &user_db,
            path.to_string_lossy().into_owned(),
            design.clone(),
            None,
        )
        .unwrap();
        let DesignSaveOutcome::Saved {
            path: saved_path,
            fingerprint,
        } = outcome
        else {
            panic!("an unconditional save is written");
        };
        let loaded = loaded_design(load_design(&user_db, saved_path.clone()));
        let recent = get_recent_files(&user_db).unwrap();

        assert_eq!(loaded.file.name, "Service Demo");
        assert_eq!(loaded.fingerprint, fingerprint);
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].path, saved_path);
        assert_eq!(recent[0].name, "Service Demo");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn save_and_load_design_do_not_record_design_notebook_entry() {
        let scratch = TestScratch::new(
            "design-files-save-and-load-design-do-not-record-design-notebook-entry",
        );
        let user_db = test_user_db();
        let design = test_design("Notebook Demo");
        let path = temp_design_path(&scratch, "notebook_round_trip");

        save_design(
            &user_db,
            path.to_string_lossy().into_owned(),
            design.clone(),
            None,
        )
        .unwrap();
        let _ = load_design(&user_db, path.to_string_lossy().into_owned()).unwrap();
        let notebook_entries = {
            let conn = user_db.acquire();
            crate::db::design_notebook::get_design_notebook_entries_with_sections(&conn).unwrap()
        };

        assert!(
            notebook_entries.is_empty(),
            "save/load should not recreate a user-removed Design Notebook reference"
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn export_design_file_round_trips_without_recording_recent_file() {
        let scratch = TestScratch::new(
            "design-files-export-design-file-round-trips-without-recording-recent-file",
        );
        let user_db = test_user_db();
        let design = test_design("Stamp Export");
        let path = temp_design_path(&scratch, "stamp_export");

        let saved_path =
            export_design_file(path.to_string_lossy().into_owned(), design.clone()).unwrap();
        let loaded = crate::design::format::load_from_file(&path).unwrap();
        let recent = get_recent_files(&user_db).unwrap();

        assert_eq!(saved_path, path.to_string_lossy());
        assert_eq!(loaded.name, "Stamp Export");
        assert!(recent.is_empty());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn load_design_file_round_trips_without_recording_recent_file() {
        let scratch = TestScratch::new(
            "design-files-load-design-file-round-trips-without-recording-recent-file",
        );
        let user_db = test_user_db();
        let design = test_design("Stamp Import");
        let path = temp_design_path(&scratch, "stamp_import");

        export_design_file(path.to_string_lossy().into_owned(), design).unwrap();
        let loaded = load_design_file(path.to_string_lossy().into_owned()).unwrap();
        let recent = get_recent_files(&user_db).unwrap();

        assert_eq!(loaded.name, "Stamp Import");
        assert!(recent.is_empty());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn load_design_file_refuses_a_file_saved_before_2_0_as_older_version() {
        let scratch = TestScratch::new("design-files-load-design-file-refuses-older-version");
        let path = temp_design_path(&scratch, "old_stamp");
        std::fs::write(&path, r#"{"version": 4, "name": "Canopi 1.1 stamp"}"#).unwrap();

        // Stamp import maps `kind` to its message, so the IPC must reject
        // with the typed failure, not a plain string.
        let failure = load_design_file(path.to_string_lossy().into_owned()).unwrap_err();

        assert_eq!(failure.kind, DesignLoadFailureKind::OlderVersion);
        assert!(
            !failure.message.contains("old_stamp"),
            "{}",
            failure.message
        );
    }

    #[test]
    fn load_missing_design_returns_error() {
        let scratch = TestScratch::new("design-files-load-missing-design-returns-error");
        let user_db = test_user_db();
        let path = temp_design_path(&scratch, "missing");

        let result = load_design(&user_db, path.to_string_lossy().into_owned());

        assert!(result.is_err());
    }

    #[test]
    fn preview_admission_keeps_listed_paths_in_call_order_once_and_bounded() {
        let user_db = test_user_db();
        {
            let conn = user_db.acquire();
            for i in 0..30 {
                crate::db::recent_files::record_recent_file(
                    &conn,
                    &format!("/designs/listed-{i}.canopi"),
                    "Listed",
                )
                .unwrap();
            }
        }
        // Far more input than the list holds, mostly unlisted, with repeats.
        let mut asked: Vec<String> = (0..10_000)
            .map(|i| format!("/elsewhere/{i}.canopi"))
            .collect();
        asked.push("/designs/listed-7.canopi".to_owned());
        asked.push("/designs/listed-3.canopi".to_owned());
        asked.push("/designs/listed-7.canopi".to_owned());
        asked.extend((0..30).map(|i| format!("/designs/listed-{i}.canopi")));

        let listed = super::listed_recent_paths(&user_db, asked).unwrap();

        assert_eq!(listed.len(), 20);
        assert_eq!(listed[0], "/designs/listed-7.canopi");
        assert_eq!(listed[1], "/designs/listed-3.canopi");
        assert_eq!(listed[2], "/designs/listed-0.canopi");
        assert_eq!(
            listed
                .iter()
                .filter(|path| path.ends_with("listed-7.canopi"))
                .count(),
            1
        );
    }

    #[test]
    fn recent_designs_prune_missing_paths() {
        let scratch = TestScratch::new("design-files-recent-designs-prune-missing-paths");
        let user_db = test_user_db();
        let existing_path = temp_design_path(&scratch, "existing_recent");
        let missing_path = temp_design_path(&scratch, "missing_recent");

        save_design(
            &user_db,
            existing_path.to_string_lossy().into_owned(),
            test_design("Existing Design"),
            None,
        )
        .unwrap();
        {
            let conn = user_db.acquire();
            crate::db::recent_files::record_recent_file(
                &conn,
                &missing_path.to_string_lossy(),
                "Missing Design",
            )
            .unwrap();
        }

        let recent = get_recent_files(&user_db).unwrap();
        let stored = {
            let conn = user_db.acquire();
            crate::db::recent_files::get_recent_files(&conn, 20).unwrap()
        };

        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].path, existing_path.to_string_lossy());
        assert!(
            stored
                .iter()
                .all(|file| file.path != missing_path.to_string_lossy()),
            "missing Recent Design should be removed from persisted recent designs"
        );

        let _ = std::fs::remove_file(existing_path);
    }

    #[test]
    fn recent_design_filter_hides_unavailable_paths_without_pruning() {
        let result = partition_by_availability(
            vec![
                design_summary("/available.canopi", "Available"),
                design_summary("/stale.canopi", "Stale"),
                design_summary("/unavailable.canopi", "Unavailable"),
            ],
            |file| &file.path,
            Some(20),
            |path| match path.to_string_lossy().as_ref() {
                "/available.canopi" => DesignPathAvailability::Available,
                "/stale.canopi" => DesignPathAvailability::Missing,
                "/unavailable.canopi" => DesignPathAvailability::Unavailable,
                other => panic!("unexpected path {other}"),
            },
        );

        assert_eq!(result.visible.len(), 1);
        assert_eq!(result.visible[0].path, "/available.canopi");
        assert_eq!(result.visible[0].name, "Available");
        assert_eq!(result.missing_paths, vec!["/stale.canopi"]);
    }

    #[test]
    fn availability_forgets_only_files_whose_folder_is_present() {
        let scratch = TestScratch::new(
            "design-files-availability-forgets-only-files-whose-folder-is-present",
        );
        let folder = temp_design_path(&scratch, "availability_folder").with_extension("");
        std::fs::create_dir_all(&folder).unwrap();
        let present = folder.join("present.canopi");
        std::fs::write(&present, "{}").unwrap();

        assert_eq!(
            design_path_availability(&present),
            DesignPathAvailability::Available
        );
        assert_eq!(
            design_path_availability(&folder.join("deleted.canopi")),
            DesignPathAvailability::Missing
        );
        assert_eq!(
            design_path_availability(&folder),
            DesignPathAvailability::Missing,
            "a folder where a Design used to be is not a Design"
        );
        // An unplugged or unmounted drive: the file's folder is gone too.
        assert_eq!(
            design_path_availability(&folder.join("unmounted-drive").join("garden.canopi")),
            DesignPathAvailability::Unavailable
        );

        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn recent_designs_keep_entries_on_an_unavailable_drive() {
        let scratch =
            TestScratch::new("design-files-recent-designs-keep-entries-on-an-unavailable-drive");
        let user_db = test_user_db();
        let unmounted = temp_design_path(&scratch, "unmounted_drive")
            .with_extension("")
            .join("garden.canopi");
        {
            let conn = user_db.acquire();
            crate::db::recent_files::record_recent_file(
                &conn,
                &unmounted.to_string_lossy(),
                "Garden on a USB drive",
            )
            .unwrap();
        }

        let recent = get_recent_files(&user_db).unwrap();
        let stored = {
            let conn = user_db.acquire();
            crate::db::recent_files::get_recent_files(&conn, 20).unwrap()
        };

        assert!(recent.is_empty(), "an unreachable Design is hidden");
        assert_eq!(stored.len(), 1, "an unreachable Design is not forgotten");
    }

    #[test]
    fn saving_and_loading_do_not_log_design_names_or_paths() {
        let scratch =
            TestScratch::new("design-files-saving-and-loading-do-not-log-design-names-or-paths");
        let user_db = test_user_db();
        let path = temp_design_path(&scratch, "private_log");
        let (_, logs) = super::capture_logs(|| {
            let loaded = match save_design(
                &user_db,
                path.to_string_lossy().into_owned(),
                test_design("Secret Orchard"),
                None,
            )
            .unwrap()
            {
                DesignSaveOutcome::Saved { .. } => {
                    loaded_design(load_design(&user_db, path.to_string_lossy().into_owned()))
                }
                DesignSaveOutcome::Conflict { .. } => panic!("an unconditional save is written"),
            };
            std::fs::write(&path, "changed by another program").unwrap();
            assert!(matches!(
                save_design(
                    &user_db,
                    path.to_string_lossy().into_owned(),
                    test_design("Secret Orchard"),
                    Some(loaded.fingerprint),
                )
                .unwrap(),
                DesignSaveOutcome::Conflict { .. }
            ));
            export_design_file(
                path.to_string_lossy().into_owned(),
                test_design("Secret Orchard"),
            )
            .unwrap();
            load_design_file(path.to_string_lossy().into_owned()).unwrap();
        });

        assert!(logs.contains("Design saved"), "{logs}");
        assert!(!logs.contains("Secret Orchard"), "{logs}");
        assert!(!logs.contains(&*path.to_string_lossy()), "{logs}");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_conflicting_save_leaves_the_file_and_recent_designs_alone() {
        let scratch = TestScratch::new(
            "design-files-a-conflicting-save-leaves-the-file-and-recent-designs-alone",
        );
        let user_db = test_user_db();
        let path = temp_design_path(&scratch, "conflict");
        let path_text = path.to_string_lossy().into_owned();
        std::fs::write(&path, "changed by another program").unwrap();

        let outcome = save_design(
            &user_db,
            path_text.clone(),
            test_design("Mine"),
            Some("0".repeat(64)),
        )
        .unwrap();

        match outcome {
            DesignSaveOutcome::Conflict {
                current_fingerprint,
            } => assert_eq!(
                current_fingerprint.as_deref(),
                Some(crate::design::fingerprint(b"changed by another program").as_str())
            ),
            DesignSaveOutcome::Saved { .. } => panic!("an outside change must not be overwritten"),
        }
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "changed by another program"
        );
        assert!(get_recent_files(&user_db).unwrap().is_empty());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn show_in_folder_reveals_the_file_of_a_listed_design_only() {
        let scratch = TestScratch::new("design-files-show-in-folder-reveals-a-listed-design");
        let user_db = test_user_db();
        let path = temp_design_path(&scratch, "reveal");
        let listed = path.to_string_lossy().into_owned();
        save_design(&user_db, listed.clone(), test_design("Reveal"), None).unwrap();

        let file = recent_design_file(&user_db, &listed).unwrap();
        let revealer = RecordingRevealer::default();
        show_design_in_folder(&file, &revealer).unwrap();
        assert_eq!(revealer.shown(), vec![Shown::Item(path.clone())]);

        let unlisted = scratch.join("not-a-recent-design.canopi");
        let error = recent_design_file(&user_db, &unlisted.to_string_lossy()).unwrap_err();
        assert!(!error.contains("not-a-recent-design"), "{error}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_listed_design_without_a_folder_has_nothing_to_show() {
        let user_db = test_user_db();
        {
            let conn = user_db.acquire();
            crate::db::recent_files::record_recent_file(&conn, "orchard.canopi", "Orchard")
                .unwrap();
        }
        let error = recent_design_file(&user_db, "orchard.canopi").unwrap_err();
        assert_eq!(error, "This Design has no folder to show.");
    }

    #[test]
    fn a_deleted_design_file_is_refused_without_its_path_before_the_opener() {
        let scratch = TestScratch::new("design-files-gone-design");
        let revealer = RecordingRevealer::default();
        let gone = scratch.join("canopi-gone-design.canopi");
        let error = show_design_in_folder(&gone, &revealer).unwrap_err();
        assert!(!error.contains("canopi-gone-design"), "{error}");
        let gone_folder = scratch.join("canopi-gone-folder").join("orchard.canopi");
        assert!(show_design_in_folder(&gone_folder, &revealer).is_err());
        assert!(revealer.shown().is_empty());
    }

    #[test]
    fn remove_from_list_forgets_the_design_and_keeps_the_file() {
        let scratch =
            TestScratch::new("design-files-remove-from-list-forgets-the-design-and-keeps-the-file");
        let user_db = test_user_db();
        let path = temp_design_path(&scratch, "forget");
        let listed = path.to_string_lossy().into_owned();
        save_design(&user_db, listed.clone(), test_design("Forget"), None).unwrap();
        assert_eq!(get_recent_files(&user_db).unwrap().len(), 1);

        remove_recent_design(&user_db, &listed).unwrap();
        assert!(get_recent_files(&user_db).unwrap().is_empty());
        assert!(path.is_file(), "the file itself is untouched");
        let _ = std::fs::remove_file(&path);
    }
}
