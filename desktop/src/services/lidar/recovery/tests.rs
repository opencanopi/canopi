//! `recovery.rs`'s own tests: what health shows, the set-aside stamp, which catalogue states inspection names, and
//! which of them are set aside and rebuilt.

use super::*;

/// Health carries the state and counts only: never the set-aside path,
/// the version numbers or the failure reason.
#[test]
fn health_keeps_the_state_and_counts_but_no_paths_or_reasons() {
    let (items, generated, found) = (4, 2, 26);
    let recovered = LibraryOpenStatus::Recovered {
        reason: RecoveryReason::Corrupt("garbage".into()),
        set_aside: Some(PathBuf::from("/private/set-aside")),
        items: 4,
        generated: 2,
    };
    let unavailable = LibraryOpenStatus::Unavailable {
        reason: "/private/path unreadable".into(),
    };
    let code = FailureCode::LibraryReadOnly {
        reason: LibraryReadOnlyReason::Unavailable,
    };
    let newer = LibraryOpenStatus::NewerReadOnly {
        found,
        items: Default::default(),
    };
    let counts = StoreOpenStatus::Recovered { items, generated };
    for (open, health) in [
        (&recovered, counts),
        (&LibraryOpenStatus::Ready, StoreOpenStatus::Ready),
        (&newer, StoreOpenStatus::NewerReadOnly),
        (&unavailable, StoreOpenStatus::Unavailable { code }),
    ] {
        assert_eq!(open.health(), health);
    }
    let json = serde_json::to_string(&recovered.health()).unwrap();
    assert!(
        !json.contains("private") && !json.contains("garbage"),
        "{json}"
    );
}

#[test]
fn the_set_aside_stamp_is_utc_civil_time() {
    assert_eq!(utc_stamp(0), "19700101T000000Z");
    assert_eq!(utc_stamp(1_700_000_000), "20231114T221320Z");
    assert_eq!(utc_stamp(951_782_400), "20000229T000000Z");
}

/// A v21 catalogue still stores the CRS in `crs_wkt` columns, which v22
/// renamed to `crs_ref`; opening it as is would fail on the first read, so
/// it is set aside and rebuilt from the originals with every id kept.
#[test]
fn a_v21_catalogue_is_set_aside_and_rebuilt_with_its_ids_kept() {
    let root = crate::test_scratch::TestScratch::new("lidar-v21-library");
    let paths = LidarPaths::open(&root).unwrap();
    let connection = catalogue::open(&paths.catalogue_path()).unwrap();
    source_meta::test_support::seed_published_item(
        &connection,
        "lyr-delft",
        "Delft",
        DEFAULT_QUANTITY_KEY,
        "m",
        &[("sha-delft", "delft.tif")],
    );
    std::fs::create_dir_all(paths.source_dir("sha-delft")).unwrap();
    std::fs::write(paths.source_original("sha-delft"), b"tile").unwrap();
    source_meta::refresh(&connection, &paths).unwrap();
    // The v21 shape: every CRS column named `crs_wkt`, version 21.
    for rename in [
        "ALTER TABLE lidar_interpretations RENAME COLUMN crs_ref TO crs_wkt",
        "ALTER TABLE lidar_layer_lattices RENAME COLUMN crs_ref TO crs_wkt",
        "ALTER TABLE lidar_raster_assets RENAME COLUMN crs_ref TO crs_wkt",
    ] {
        let table = rename.split_whitespace().nth(2).unwrap();
        if has_column(&connection, table, "crs_ref") {
            connection.execute_batch(rename).unwrap();
        }
    }
    connection
        .execute(
            "UPDATE lidar_catalogue_meta SET value = '21' WHERE key = 'schema_version'",
            [],
        )
        .unwrap();
    drop(connection);

    let opened = open_catalogue(&paths, inspect(&paths.catalogue_path())).unwrap();
    assert!(
        matches!(
            opened.status,
            LibraryOpenStatus::Recovered {
                reason: RecoveryReason::OlderVersion(21),
                items: 1,
                generated: 0,
                ..
            }
        ),
        "{:?}",
        opened.status
    );
    let kept: Vec<PathBuf> = std::fs::read_dir(paths.set_aside_dir())
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "sqlite"))
        .collect();
    assert_eq!(kept.len(), 1, "the v21 file is kept aside: {kept:?}");
    assert_eq!(
        catalogue::stored_version(&kept[0]).unwrap(),
        Some(21),
        "set aside as it was"
    );
    let ids: Vec<String> = opened
        .connection
        .prepare("SELECT id FROM lidar_source_layers")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(ids, vec!["lyr-delft".to_string()]);
    assert!(has_column(
        &opened.connection,
        "lidar_interpretations",
        "crs_ref"
    ));
    assert!(!has_column(
        &opened.connection,
        "lidar_interpretations",
        "crs_wkt"
    ));
    drop(opened);
    std::fs::remove_dir_all(root).unwrap();
}

/// A `-wal` SQLite cannot read (here a directory) makes the catalogue
/// Unreadable, not Corrupt: nothing is set aside or rebuilt, the catalogue
/// stays in place and the library opens Unavailable. (A sidecar that cannot be
/// set aside during an install is `install_tests.rs`'s.)
#[cfg(unix)]
#[test]
fn a_wal_that_cannot_move_leaves_the_catalogue_in_place_and_unavailable() {
    let root = crate::test_scratch::TestScratch::new("lidar-stuck-wal");
    let paths = LidarPaths::open(&root).unwrap();
    let catalogue_path = paths.catalogue_path();
    let damaged: &[u8] = b"not a database at all, just bytes";
    std::fs::write(&catalogue_path, damaged).unwrap();
    // A log no read can open; the set-aside folder lies inside it, so any
    // set-aside would show there.
    let mut wal = catalogue_path.clone().into_os_string();
    wal.push("-wal");
    let wal = PathBuf::from(wal);
    std::fs::create_dir(&wal).unwrap();
    std::os::unix::fs::symlink(&wal, paths.set_aside_dir()).unwrap();

    let opened = open_catalogue(&paths, inspect(&paths.catalogue_path())).unwrap();

    assert!(
        matches!(opened.status, LibraryOpenStatus::Unavailable { .. }),
        "{:?}",
        opened.status
    );
    assert_eq!(
        std::fs::read(&catalogue_path).unwrap(),
        damaged,
        "the catalogue stays where it was, byte for byte"
    );
    assert_eq!(
        std::fs::read_dir(&wal).unwrap().count(),
        0,
        "nothing stays in the set-aside folder"
    );
}

fn has_column(connection: &Connection, table: &str, column: &str) -> bool {
    connection
        .prepare("SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2")
        .unwrap()
        .exists([table, column])
        .unwrap()
}

#[test]
fn inspection_names_each_catalogue_state() {
    let root = crate::test_scratch::TestScratch::new("canopi-inspect");
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("c.sqlite");
    assert_eq!(inspect(&path), CatalogueState::Missing);
    std::fs::write(&path, b"").unwrap();
    assert_eq!(inspect(&path), CatalogueState::Missing);
    std::fs::write(&path, b"not a database at all, just bytes").unwrap();
    assert!(matches!(inspect(&path), CatalogueState::Corrupt(_)));
    std::fs::remove_file(&path).unwrap();
    drop(catalogue::open(&path).unwrap());
    assert_eq!(inspect(&path), CatalogueState::Current);
    for (version, expected) in [
        (
            catalogue::CATALOGUE_VERSION - 1,
            CatalogueState::Older(catalogue::CATALOGUE_VERSION - 1),
        ),
        (
            catalogue::CATALOGUE_VERSION + 1,
            CatalogueState::Newer(catalogue::CATALOGUE_VERSION + 1),
        ),
    ] {
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE lidar_catalogue_meta SET value = ?1 WHERE key = 'schema_version'",
                [version.to_string()],
            )
            .unwrap();
        drop(connection);
        assert_eq!(inspect(&path), expected);
    }
    std::fs::remove_dir_all(root).unwrap();
}

/// Only a file SQLite reaches through a write is unreadable rather than corrupt: bytes that are no database, a
/// database without the version table and an unparsable version stay corrupt, set aside and rebuilt (ADR 0021),
/// while another connection's lock leaves the version unknown and the file untouched (canopi-tavc).
#[test]
fn canopi_tavc_inspection_keeps_a_corrupt_file_corrupt_and_a_locked_one_unreadable() {
    let root = crate::test_scratch::TestScratch::new("canopi-inspect-tavc");
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("c.sqlite");
    std::fs::write(
        &path,
        b"SQLite format 3\0 and then nothing a database holds",
    )
    .unwrap();
    assert!(matches!(inspect(&path), CatalogueState::Corrupt(_)));
    std::fs::remove_file(&path).unwrap();
    for sql in [
        "CREATE TABLE other (x)",
        "CREATE TABLE lidar_catalogue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO lidar_catalogue_meta VALUES ('schema_version', 'twenty-six');",
        "CREATE TABLE lidar_catalogue_meta (key, value);
         INSERT INTO lidar_catalogue_meta VALUES ('schema_version', X'1A');",
    ] {
        let _ = std::fs::remove_file(&path);
        Connection::open(&path).unwrap().execute_batch(sql).unwrap();
        assert!(
            matches!(inspect(&path), CatalogueState::Corrupt(_)),
            "{sql}: {:?}",
            inspect(&path)
        );
    }
    let holder = Connection::open(&path).unwrap();
    holder
        .execute_batch("BEGIN EXCLUSIVE; CREATE TABLE held (x);")
        .unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(
        matches!(inspect(&path), CatalogueState::Unreadable(_)),
        "{:?}",
        inspect(&path)
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    holder.execute_batch("ROLLBACK").unwrap();
}

/// A directory where the catalogue file belongs is no catalogue SQLite names damaged, and moving it aside would
/// set aside whatever it holds: the library is unavailable and the directory stays (canopi-tavc).
#[test]
fn canopi_tavc_a_directory_at_the_catalogue_path_is_unreadable_and_left_in_place() {
    let root = crate::test_scratch::TestScratch::new("canopi-catalogue-directory");
    let paths = LidarPaths::open(&root).unwrap();
    std::fs::create_dir(paths.catalogue_path()).unwrap();
    std::fs::write(paths.catalogue_path().join("kept"), b"kept").unwrap();

    let state = inspect(&paths.catalogue_path());
    assert!(matches!(state, CatalogueState::Unreadable(_)), "{state:?}");
    let opened = open_catalogue(&paths, state).unwrap();

    assert!(
        matches!(opened.status, LibraryOpenStatus::Unavailable { .. }),
        "{:?}",
        opened.status
    );
    assert_eq!(
        std::fs::read(paths.catalogue_path().join("kept")).unwrap(),
        b"kept"
    );
    assert!(!paths.set_aside_dir().exists(), "nothing is set aside");
}

/// A current catalogue whose integrity check cannot run, or whose read-write open fails, is no catalogue SQLite
/// names damaged: under another connection's lock both fail, and the file stays where it is, unrebuilt, while the
/// library is unavailable (canopi-tavc).
#[test]
fn canopi_tavc_a_current_catalogue_whose_check_or_open_meets_a_lock_is_left_in_place() {
    let root = crate::test_scratch::TestScratch::new("canopi-catalogue-current-locked");
    let paths = LidarPaths::open(&root).unwrap();
    let path = paths.catalogue_path();
    drop(catalogue::open(&path).unwrap());
    // Rollback-journal mode, where an exclusive lock keeps every reader out.
    Connection::open(&path)
        .unwrap()
        .pragma_update(None, "journal_mode", "DELETE")
        .unwrap();
    let holder = Connection::open(&path).unwrap();
    holder
        .execute_batch("BEGIN EXCLUSIVE; CREATE TABLE held (x);")
        .unwrap();
    let before = std::fs::read(&path).unwrap();

    assert!(
        matches!(
            catalogue::quick_check(&path),
            Err(catalogue::UnreadCatalogue::Unavailable(_))
        ),
        "{:?}",
        catalogue::quick_check(&path)
    );
    let opened = open_catalogue(&paths, CatalogueState::Current).unwrap();

    assert!(
        matches!(opened.status, LibraryOpenStatus::Unavailable { .. }),
        "{:?}",
        opened.status
    );
    assert_eq!(
        std::fs::read(&path).unwrap(),
        before,
        "the catalogue stays in place"
    );
    assert!(!paths.set_aside_dir().exists(), "nothing is set aside");
    holder.execute_batch("ROLLBACK").unwrap();
}

/// Every day from 1970 to 2400 stamps as the day after the one before: across month ends, leap days, the
/// non-leap centuries 2100, 2200 and 2300, and the 400-year leap day 2400-02-29.
#[test]
fn the_set_aside_stamp_names_each_consecutive_civil_day() {
    fn days_in(year: i64, month: i64) -> i64 {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        match month {
            2 if leap => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        }
    }
    let (mut year, mut month, mut day) = (1970_i64, 1_i64, 1_i64);
    let mut unix_days = 0_u64;
    while year <= 2400 {
        let expected = format!("{year:04}{month:02}{day:02}T235959Z");
        assert_eq!(utc_stamp(unix_days * 86_400 + 86_399), expected);
        day += 1;
        if day > days_in(year, month) {
            day = 1;
            month += 1;
            if month > 12 {
                month = 1;
                year += 1;
            }
        }
        unix_days += 1;
    }
}

/// An original with its `meta.json`, both under `sources/<sha256>/`.
pub(super) fn seed_original(paths: &LidarPaths, sha256: &str, meta: Option<&SourceMeta>) {
    std::fs::create_dir_all(paths.source_dir(sha256)).unwrap();
    std::fs::write(paths.source_original(sha256), b"tile").unwrap();
    if let Some(meta) = meta {
        source_meta::write(&paths.source_meta(sha256), meta).unwrap();
    }
}

/// A meta naming one item over `members`, as an import writes it.
fn item_meta(sha256: &str, id: &str, quantity: &str, units: &str, members: &[&str]) -> SourceMeta {
    SourceMeta {
        version: source_meta::META_VERSION,
        sha256: sha256.to_string(),
        original_filename: format!("{id}.tif"),
        size_bytes: 4,
        imported_at: "1".to_string(),
        items: vec![source_meta::ItemMeta {
            id: id.to_string(),
            name: format!("Item {id}"),
            quantity: quantity.to_string(),
            units: units.to_string(),
            created_at: "1".to_string(),
            members: members.iter().map(|member| member.to_string()).collect(),
            analyses: Vec::new(),
        }],
    }
}

/// (id, name, quantity, units) of every rebuilt item, by name.
pub(super) fn rebuilt_items(connection: &Connection) -> Vec<(String, String, String, String)> {
    connection
        .prepare("SELECT id, name, quantity, units FROM lidar_source_layers ORDER BY name")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// A library that never imported anything has no `sources/` folder: an older or corrupt catalogue there is set
/// aside and rebuilt empty, not left unavailable.
#[test]
fn a_catalogue_beside_no_sources_folder_is_rebuilt_empty() {
    let root = crate::test_scratch::TestScratch::new("lidar-recover-no-sources");
    let paths = LidarPaths::open(&root).unwrap();
    std::fs::remove_dir_all(paths.root().join("sources")).unwrap();
    std::fs::write(paths.catalogue_path(), b"not a database at all, just bytes").unwrap();

    let opened = open_catalogue(&paths, inspect(&paths.catalogue_path())).unwrap();

    assert!(
        matches!(
            opened.status,
            LibraryOpenStatus::Recovered {
                reason: RecoveryReason::Corrupt(_),
                items: 0,
                generated: 0,
                ..
            }
        ),
        "{:?}",
        opened.status
    );
}

/// A `sources/` folder that cannot be listed is no empty library: the rebuild fails rather than report every
/// original gone.
#[test]
fn a_sources_folder_that_cannot_be_listed_fails_the_rebuild() {
    let root = crate::test_scratch::TestScratch::new("lidar-recover-unlistable-sources");
    let paths = LidarPaths::open(&root).unwrap();
    let sources = paths.root().join("sources");
    std::fs::remove_dir_all(&sources).unwrap();
    std::fs::write(&sources, b"a file where the folder belongs").unwrap();
    let connection = catalogue::open(&paths.catalogue_path()).unwrap();

    let rebuilt = rebuild(&connection, &paths);

    assert!(rebuilt.is_err(), "{rebuilt:?}");
    assert!(rebuilt_items(&connection).is_empty());
}

/// A `meta.json` that names another original (copied or misplaced) does not describe this one: the original is
/// listed under a generated name instead of vanishing behind an item whose member is absent.
#[test]
fn an_original_whose_meta_names_another_digest_is_listed_under_a_generated_name() {
    let root = crate::test_scratch::TestScratch::new("lidar-recover-foreign-meta");
    let paths = LidarPaths::open(&root).unwrap();
    let (here, elsewhere) = ("aaaaaaaa0001", "bbbbbbbb0002");
    seed_original(
        &paths,
        here,
        Some(&item_meta(
            elsewhere,
            "lyr-elsewhere",
            DEFAULT_QUANTITY_KEY,
            "m",
            &[elsewhere],
        )),
    );
    let connection = catalogue::open(&paths.catalogue_path()).unwrap();

    let report = rebuild(&connection, &paths).unwrap();

    assert_eq!(
        report,
        RebuildReport {
            items: 0,
            generated: 1
        }
    );
    let items = rebuilt_items(&connection);
    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(items[0].1, "Recovered raster aaaaaaaa");
    let sources: Vec<String> = connection
        .prepare("SELECT sha256 FROM lidar_sources")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(sources, vec![here.to_string()]);
}

/// A rebuilt item keeps its declared quantity and units only while they are importable and named; a derived
/// quantity or blank units come back as ground elevation in metres.
#[test]
fn a_rebuilt_item_keeps_only_an_importable_quantity_with_units() {
    let root = crate::test_scratch::TestScratch::new("lidar-recover-quantities");
    let paths = LidarPaths::open(&root).unwrap();
    for (sha256, id, quantity, units) in [
        ("aaaaaaaa0001", "lyr-surface", "surface-elevation", "ft"),
        ("bbbbbbbb0002", "lyr-slope", "slope", "degrees"),
        ("cccccccc0003", "lyr-blank", "above-ground-height", "  "),
    ] {
        seed_original(
            &paths,
            sha256,
            Some(&item_meta(sha256, id, quantity, units, &[sha256])),
        );
    }
    let connection = catalogue::open(&paths.catalogue_path()).unwrap();

    let report = rebuild(&connection, &paths).unwrap();

    assert_eq!(
        report,
        RebuildReport {
            items: 3,
            generated: 0
        }
    );
    let kept: Vec<(String, String, String)> = rebuilt_items(&connection)
        .into_iter()
        .map(|(id, _, quantity, units)| (id, quantity, units))
        .collect();
    let owned = |id: &str, quantity: &str, units: &str| {
        (id.to_string(), quantity.to_string(), units.to_string())
    };
    assert_eq!(
        kept,
        vec![
            owned("lyr-blank", DEFAULT_QUANTITY_KEY, "m"),
            owned("lyr-slope", DEFAULT_QUANTITY_KEY, "m"),
            owned("lyr-surface", "surface-elevation", "ft"),
        ]
    );
}
