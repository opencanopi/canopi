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
        set_aside: PathBuf::from("/private/set-aside"),
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

/// A `-wal` left behind would be replayed into the rebuilt catalogue, so a
/// sidecar that cannot follow the catalogue aside moves nothing back and
/// the library opens Unavailable instead of being rebuilt over it.
#[cfg(unix)]
#[test]
fn a_wal_that_cannot_move_leaves_the_catalogue_in_place_and_unavailable() {
    let root = crate::test_scratch::TestScratch::new("lidar-stuck-wal");
    let paths = LidarPaths::open(&root).unwrap();
    let catalogue_path = paths.catalogue_path();
    let damaged: &[u8] = b"not a database at all, just bytes";
    std::fs::write(&catalogue_path, damaged).unwrap();
    // A sidecar no rename can move: the set-aside folder lies inside it,
    // and a directory cannot be moved into itself.
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
