//! The reader release's user-DB user paths on Desktop (Step 2.0.4 R2, canopi-f47t.52.271): settings record 2 (plan
//! "reader release: settings record 2 applies its known fields and is never written", 2.1-M480, A16) and a saved
//! stamp with a v3 payload (plan "a saved stamp with a v3 payload lists as needing a newer Canopi and its row is
//! unchanged", 2.1-M88), and the user DB 10 open below them (R2-2: read-only, byte-identical, its failure states).
//!
//! Written failing in commit 0 and marked expected-fail: R2-6 removes the settings marker, R2-5 the stamp marker (the
//! main agent flips the stamp case at R2-5's merge, since R2-6 owns this file). R2-6 may swap the inline record for
//! the frozen `test_fixtures/frozen/settings-record-2.json` once it lands.

use crate::db::UserDb;
use crate::services::{saved_object_stamps, settings};
use canopi_types::settings::{BasemapStyle, Locale, Theme};
#[cfg(test)]
use rusqlite::Connection;

fn user_db() -> UserDb {
    UserDb::initialize(Connection::open_in_memory().unwrap()).unwrap()
}

/// Every settings-table row, key and value, in key order: what "never written" compares.
#[cfg(test)]
fn settings_rows(user_db: &UserDb) -> Vec<(String, String)> {
    let conn = user_db.acquire();
    let mut statement = conn
        .prepare("SELECT key, value FROM settings ORDER BY key")
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// A record 2.1 writes: a top-level integer `version`, a basemap literal this build does not know, a field it never
/// heard of and known fields it reads (contracts §11 Read projections: per-field tolerant decode, unknown keys ignored).
const SETTINGS_RECORD_2: &str = r#"{"version":2,"locale":"de","theme":"dark","snap_to_grid":true,"basemap_style":"terrain-2-1","unit_system":"us_customary"}"#;

#[test]
#[ignore = "expected-fail: R2 canopi-f47t.52.271"]
fn r2_canopi_f47t_52_271_settings_record_2_applies_its_known_fields_and_is_never_written() {
    let user_db = user_db();
    {
        let conn = user_db.acquire();
        crate::db::user_db::set_setting(&conn, "settings", SETTINGS_RECORD_2).unwrap();
    }
    let before = settings_rows(&user_db);

    // Today the unknown basemap literal sets the whole record aside and defaults replace it.
    let read = settings::get_settings(&user_db).expect("settings record 2 is read");
    assert_eq!(read.locale, Locale::De, "a known field applies");
    assert_eq!(read.theme, Theme::Dark, "a known field applies");
    assert!(read.snap_to_grid, "a known field applies");
    assert_eq!(
        read.basemap_style,
        BasemapStyle::Liberty,
        "an unknown literal takes that field's default"
    );
    assert_eq!(settings_rows(&user_db), before, "reading writes no row");

    let mut changed = read.clone();
    changed.theme = Theme::Light;
    assert!(
        settings::set_settings(&user_db, changed).is_err(),
        "a settings change is refused, applied for the session only (2.1-Q320)"
    );
    assert_eq!(
        settings_rows(&user_db),
        before,
        "the record is never written"
    );
}

#[test]
fn r2_canopi_f47t_52_271_a_v3_saved_stamp_needs_a_newer_canopi_and_its_row_is_unchanged() {
    let user_db = user_db();
    let older = saved_object_stamps::create_saved_object_stamp(
        &user_db,
        "Hedge".to_string(),
        r#"{"version":2,"plants":[],"zones":[],"annotations":[],"groups":[]}"#.to_string(),
    )
    .unwrap();
    // The v3 row goes in as 2.1 leaves it, not through this build's writer, which a reader may refuse for a newer
    // payload (contracts §11: a reader never writes a newer payload).
    let newer_id = "stamp-apple-guild-v3";
    {
        let conn = user_db.acquire();
        conn.execute(
            "INSERT INTO saved_object_stamps (id, name, payload_json, sort_order, created_at, updated_at)
             VALUES (?1, 'Apple guild', ?2, 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')",
            rusqlite::params![
                newer_id,
                r#"{"version":3,"plants":[],"zones":[],"annotations":[],"groups":[],"guides":[],"notes":[]}"#
            ],
        )
        .unwrap();
    }
    let before = saved_object_stamps::get_saved_object_stamps(&user_db).unwrap();

    // Today needs_newer is never set and the v3 row renames, reorders and deletes like any other.
    let listed = before.iter().find(|stamp| stamp.id == newer_id).unwrap();
    assert!(
        listed.needs_newer,
        "the v3 stamp lists as needing a newer Canopi"
    );
    assert!(
        !before
            .iter()
            .find(|stamp| stamp.id == older.id)
            .unwrap()
            .needs_newer
    );
    assert!(
        saved_object_stamps::rename_saved_object_stamp(&user_db, newer_id.to_string(), "x".into())
            .is_err(),
        "a v3 row is never renamed"
    );
    assert!(
        saved_object_stamps::reorder_saved_object_stamps(
            &user_db,
            vec![newer_id.to_string(), older.id.clone()]
        )
        .is_err(),
        "a reorder naming a v3 row is refused"
    );
    assert!(
        saved_object_stamps::delete_saved_object_stamp(&user_db, newer_id.to_string()).is_err(),
        "a v3 row is never deleted"
    );
    let after = saved_object_stamps::get_saved_object_stamps(&user_db).unwrap();
    let row = |stamps: &[canopi_types::saved_object_stamps::SavedObjectStamp]| {
        stamps
            .iter()
            .find(|stamp| stamp.id == newer_id)
            .map(|stamp| {
                (
                    stamp.name.clone(),
                    stamp.payload_json.clone(),
                    stamp.sort_order,
                    stamp.updated_at.clone(),
                )
            })
    };
    assert_eq!(row(&after), row(&before), "the v3 row is unchanged");
}

// User DB 10 (R2-2, canopi-f47t.52.271; contracts §11 Degraded stores): a newer user DB opens SQLITE_OPEN_READ_ONLY,
// never `immutable=1`, and the open keeps the main file, a pre-existing -wal and `user_version` byte-identical. Linux
// runs here; Windows runs in CI's `build.yml platform-tests`.

const USER_DB_10: &str = include_str!("../test_fixtures/frozen/user-db-10.sql");

/// `path` with `suffix` appended to its file name (`-wal`, `-shm`, `-journal`).
fn companion(path: &std::path::Path, suffix: &str) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}

/// The frozen user DB 10 at `<dir>/user.db` in WAL mode, as 2.1 leaves it on a crash: `user_version` 10 in the main
/// file, a favourite only in an uncheckpointed -wal, and no -shm.
fn user_db_10_with_a_wal(dir: &std::path::Path) -> std::path::PathBuf {
    user_db_10_with_a_wal_and(dir, "")
}

/// [`user_db_10_with_a_wal`], with `more` SQL in the -wal too.
fn user_db_10_with_a_wal_and(dir: &std::path::Path, more: &str) -> std::path::PathBuf {
    let path = dir.join("user.db");
    let writer = Connection::open(&path).unwrap();
    writer.execute_batch(USER_DB_10).unwrap();
    writer
        .set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
            true,
        )
        .unwrap();
    writer
        .execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
             INSERT INTO favorites (added_at, canonical_name) VALUES ('2026-11-04T09:00:00Z', 'Allium ursinum');",
        )
        .unwrap();
    writer.execute_batch(more).unwrap();
    drop(writer);
    std::fs::remove_file(companion(&path, "-shm")).unwrap();
    path
}

/// `user_version` as the main file's header holds it (bytes 60..64), read without SQLite.
fn header_user_version(path: &std::path::Path) -> i32 {
    let bytes = std::fs::read(path).unwrap();
    i32::from_be_bytes(bytes[60..64].try_into().unwrap())
}

fn read_only(path: &std::path::Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
}

/// Probe (design check §5b R2 2nd): the engine itself keeps a WAL user DB 10 unchanged under a read-only open.
#[test]
fn r2_canopi_f47t_52_271_a_read_only_open_of_a_wal_user_db_10_keeps_the_main_file_the_wal_and_user_version()
 {
    let scratch = crate::test_scratch::TestScratch::new("reader-release-user-db-10-wal-probe");
    let path = user_db_10_with_a_wal(&scratch);
    let (main, wal) = (
        std::fs::read(&path).unwrap(),
        std::fs::read(companion(&path, "-wal")).unwrap(),
    );
    assert!(!wal.is_empty(), "the probe needs frames in the -wal");
    assert_eq!(header_user_version(&path), 10);
    {
        let conn = read_only(&path).unwrap();
        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 10);
        let favourites: i64 = conn
            .query_row("SELECT COUNT(*) FROM favorites", [], |row| row.get(0))
            .unwrap();
        assert_eq!(favourites, 3, "the -wal's favourite is read");
        let write = conn.execute("DELETE FROM favorites", []);
        assert!(
            matches!(&write, Err(rusqlite::Error::SqliteFailure(error, _)) if error.code == rusqlite::ErrorCode::ReadOnly),
            "{write:?}"
        );
    }
    assert_eq!(
        std::fs::read(&path).unwrap(),
        main,
        "the main file is byte-identical"
    );
    assert_eq!(
        std::fs::read(companion(&path, "-wal")).unwrap(),
        wal,
        "the -wal is byte-identical"
    );
    assert_eq!(header_user_version(&path), 10);
}

/// The user DB's files at `path` that exist (main, -wal, -journal) with their bytes: what "no byte written" compares.
fn user_db_files(path: &std::path::Path) -> Vec<(&'static str, Vec<u8>)> {
    ["", "-wal", "-journal"]
        .into_iter()
        .filter_map(|suffix| Some((suffix, std::fs::read(companion(path, suffix)).ok()?)))
        .collect()
}

/// The text a String command rejects with when the read-only user DB refused its write (2.1-M487).
const REFUSED: &str = "store_read_only";

#[test]
fn r2_canopi_f47t_52_271_a_user_db_10_opens_newer_read_only_reads_its_v9_tables_by_name_and_refuses_every_write()
 {
    use crate::services::{design_files, design_notebook, plant_browser};
    let scratch = crate::test_scratch::TestScratch::new("reader-release-user-db-10-writes");
    let path = user_db_10_with_a_wal(&scratch);
    let before = user_db_files(&path);

    let (user_db, health) = UserDb::open(&path).expect("a newer user DB starts the app");
    assert_eq!(
        (health.status, health.notice),
        (canopi_types::health::StoreOpenStatus::NewerReadOnly, None)
    );
    let mut favourites = plant_browser::get_favorite_names(&user_db).unwrap();
    favourites.sort();
    assert_eq!(
        favourites,
        ["Allium ursinum", "Malus domestica", "Symphytum officinale"]
    );
    let stamps = saved_object_stamps::get_saved_object_stamps(&user_db).unwrap();
    assert_eq!(
        stamps
            .iter()
            .map(|stamp| stamp.name.as_str())
            .collect::<Vec<_>>(),
        ["Hedge"]
    );
    let notebook = design_notebook::get_design_notebook(&user_db).unwrap();
    assert_eq!(
        notebook
            .sections
            .iter()
            .map(|section| section.name.as_str())
            .collect::<Vec<_>>(),
        ["Fruit"]
    );

    let writes: [(&str, Result<(), String>); 6] = [
        (
            "star",
            plant_browser::toggle_favorite(&user_db, "Malus domestica".into()).map(drop),
        ),
        (
            "section",
            design_notebook::create_notebook_section(&user_db, "Herbs").map(drop),
        ),
        (
            "section delete",
            design_notebook::delete_notebook_section(&user_db, "section-fruit"),
        ),
        (
            "recent remove",
            design_files::remove_recent_design(&user_db, "/designs/orchard.canopi"),
        ),
        (
            "stamp",
            saved_object_stamps::create_saved_object_stamp(&user_db, "Pond".into(), "{}".into())
                .map(drop),
        ),
        (
            "stamp delete",
            saved_object_stamps::delete_saved_object_stamp(&user_db, "stamp-hedge".into())
                .map(drop),
        ),
    ];
    for (write, result) in writes {
        assert_eq!(
            result,
            Err(REFUSED.to_owned()),
            "{write} settles store_read_only"
        );
    }
    drop(user_db);
    assert_eq!(
        user_db_files(&path),
        before,
        "no byte of the main file or the -wal changed"
    );
    assert_eq!(header_user_version(&path), 10);
}

#[test]
fn r2_canopi_f47t_52_271_a_v9_design_saves_beside_a_user_db_10_and_its_recent_entry_is_skipped_silently()
 {
    use crate::services::design_files;
    let scratch = crate::test_scratch::TestScratch::new("reader-release-user-db-10-save");
    let path = user_db_10_with_a_wal(&scratch);
    let before = user_db_files(&path);
    let (user_db, _) = UserDb::open(&path).unwrap();
    let design = scratch.join("plan.canopi");
    let content = crate::design::format::create_new_design("Plan", "2026-11-13T00:00:00Z");

    let (saved, logs) = design_files::capture_logs(|| {
        design_files::save_design(
            &user_db,
            design.to_string_lossy().into_owned(),
            content,
            None,
        )
    });

    assert!(
        matches!(
            saved,
            Ok(canopi_types::design::DesignSaveOutcome::Saved { .. })
        ),
        "the Design saves: {saved:?}"
    );
    assert!(design.exists());
    assert!(!logs.contains("WARN"), "skipped silently: {logs}");
    drop(user_db);
    assert_eq!(
        user_db_files(&path),
        before,
        "no Recent Designs entry was written"
    );
}

#[test]
fn r2_canopi_f47t_52_271_recent_and_notebook_prunes_and_recently_viewed_are_skipped_silently_on_a_user_db_10()
 {
    use crate::services::{design_files, design_notebook, plant_browser};
    let scratch = crate::test_scratch::TestScratch::new("reader-release-user-db-10-prunes");
    // Both lists name a Design whose folder is present and whose file is gone: a writable user DB prunes it.
    let gone = scratch
        .join("gone.canopi")
        .to_string_lossy()
        .replace('\'', "''");
    let path = user_db_10_with_a_wal_and(
        &scratch,
        &format!(
            "PRAGMA foreign_keys = OFF;
             UPDATE design_notebook_section_memberships SET path = '{gone}';
             UPDATE design_notebook_entries SET path = '{gone}';
             UPDATE recent_files SET path = '{gone}';"
        ),
    );
    let before = user_db_files(&path);
    let (user_db, _) = UserDb::open(&path).unwrap();

    let ((recent, notebook), logs) = design_files::capture_logs(|| {
        plant_browser::record_recently_viewed(&user_db, "Malus domestica");
        (
            design_files::get_recent_files(&user_db).unwrap(),
            design_notebook::get_design_notebook(&user_db).unwrap(),
        )
    });

    assert!(
        recent.is_empty() && notebook.entries.is_empty(),
        "the missing Design is hidden"
    );
    assert!(!logs.contains("WARN"), "skipped silently: {logs}");
    drop(user_db);
    assert_eq!(
        user_db_files(&path),
        before,
        "nothing pruned, no view recorded"
    );
}

/// The read-write initialization keeps refusing a newer user DB, so only the read-only admission ever reads one.
#[test]
fn initialization_refuses_a_newer_schema_version() {
    use crate::db::user_db::CURRENT_USER_DB_VERSION;
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "user_version", CURRENT_USER_DB_VERSION + 1)
        .unwrap();

    assert!(matches!(
        UserDb::initialize(conn),
        Err(crate::db::UserDbInitError::NewerSchemaVersion { found, supported })
            if found == CURRENT_USER_DB_VERSION + 1 && supported == CURRENT_USER_DB_VERSION
    ));
}

/// A star toggled through a full user-data lane: the executor's settlement text.
fn busy_settlement(user_db: UserDb) -> String {
    use crate::native_operation::{
        NativeOperationClass, NativeOperationClassLimits, NativeOperationExecutor,
        NativeOperationLimits,
    };
    let one = NativeOperationClassLimits::new(1, 1);
    let executor =
        NativeOperationExecutor::new(NativeOperationLimits::new(one, one, one, one, one)).unwrap();
    let (started_tx, started) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release) = std::sync::mpsc::sync_channel::<()>(1);
    let holder = executor.clone();
    let held = tauri::async_runtime::spawn(async move {
        holder
            .run(NativeOperationClass::UserData, "held write", move || {
                started_tx.send(()).unwrap();
                release.recv().unwrap();
                Ok(())
            })
            .await
    });
    started
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    let toggle = executor.run(
        NativeOperationClass::UserData,
        "favorite toggle",
        move || crate::services::plant_browser::toggle_favorite(&user_db, "Malus domestica".into()),
    );
    let settled = tauri::async_runtime::block_on(toggle).unwrap_err();
    release_tx.send(()).unwrap();
    tauri::async_runtime::block_on(held).unwrap().unwrap();
    settled
}

#[test]
fn r2_canopi_f47t_52_271_a_full_user_data_lane_settles_busy_the_same_on_a_user_db_10_and_never_retries_read_write()
 {
    let scratch = crate::test_scratch::TestScratch::new("reader-release-user-db-10-busy");
    let path = user_db_10_with_a_wal(&scratch);
    let before = user_db_files(&path);
    let writable = UserDb::initialize(Connection::open_in_memory().unwrap()).unwrap();

    let newer = busy_settlement(UserDb::open(&path).unwrap().0);

    assert_eq!(newer, busy_settlement(writable), "the same busy{{lane}}");
    assert_eq!(
        user_db_files(&path),
        before,
        "no read-write retry wrote a byte"
    );
}

/// The frozen user DB 10 at `<dir>/user.db` with a hot rollback journal, as a 2.1 crash in mid-write leaves it: the
/// files are copied while the writer's transaction is open.
fn user_db_10_with_a_hot_journal(dir: &std::path::Path) -> std::path::PathBuf {
    let writing = dir.join("writing");
    std::fs::create_dir(&writing).unwrap();
    let source = writing.join("user.db");
    let writer = Connection::open(&source).unwrap();
    writer.execute_batch(USER_DB_10).unwrap();
    // With synchronous off the journal header is whole before the commit's sync, so the copy is hot at once.
    writer
        .execute_batch(
            "PRAGMA synchronous = OFF;
             BEGIN; DELETE FROM favorites; INSERT INTO session_last_home VALUES ('crash', 'mid-write');",
        )
        .unwrap();
    let path = dir.join("user.db");
    std::fs::copy(&source, &path).unwrap();
    std::fs::copy(companion(&source, "-journal"), companion(&path, "-journal")).unwrap();
    drop(writer);
    path
}

/// What an unavailable user DB reports: it cannot be read without a write (contracts §11).
fn unavailable() -> canopi_types::health::StoreOpenStatus {
    use canopi_types::failure::{FailureCode, IoFailureKind};
    let code = FailureCode::Io {
        io: IoFailureKind::ReadOnly,
    };
    canopi_types::health::StoreOpenStatus::Unavailable { code }
}

#[test]
fn r2_canopi_f47t_52_271_a_user_db_10_with_a_hot_rollback_journal_is_unavailable_never_rolled_back_and_the_app_starts()
 {
    use crate::services::plant_browser;
    let scratch = crate::test_scratch::TestScratch::new("reader-release-user-db-10-hot-journal");
    let path = user_db_10_with_a_hot_journal(&scratch);
    let before = user_db_files(&path);
    assert!(
        before
            .iter()
            .any(|(suffix, journal)| *suffix == "-journal" && journal[0] != 0),
        "a hot journal"
    );

    let (user_db, health) = UserDb::open(&path).expect("the app starts");

    assert_eq!((health.status, health.notice), (unavailable(), None));
    assert!(
        plant_browser::get_favorite_names(&user_db)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        plant_browser::toggle_favorite(&user_db, "Malus domestica".into()),
        Err(REFUSED.to_owned())
    );
    drop(user_db);
    assert_eq!(
        user_db_files(&path),
        before,
        "never rolled back: every file byte-identical"
    );
}

#[cfg(unix)]
#[test]
fn r2_canopi_f47t_52_271_a_user_db_10_with_a_wal_and_no_shm_in_a_folder_canopi_cannot_write_is_unavailable()
 {
    use std::os::unix::fs::PermissionsExt;
    let scratch = crate::test_scratch::TestScratch::new("reader-release-user-db-10-locked-folder");
    let folder = scratch.join("locked");
    std::fs::create_dir(&folder).unwrap();
    let path = user_db_10_with_a_wal(&folder);
    let before = user_db_files(&path);
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();
    if std::fs::write(folder.join("probe"), b"").is_ok() {
        // A user who writes anywhere (root) has no unwritable folder to test.
        return;
    }

    let opened = UserDb::open(&path).map(|(user_db, health)| (drop(user_db), health).1);
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(opened.expect("the app starts").status, unavailable());
    assert_eq!(user_db_files(&path), before, "every file byte-identical");
    assert!(!companion(&path, "-shm").exists());
}
