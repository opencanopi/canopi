//! The reader release's Data library user path (Step 2.0.4 R2, canopi-f47t.52.271; plan "reader release: catalogue 26
//! lists its items read-only and prunes no file", 2.1-M88, 2.1-M488, 2.1-Q318).
//!
//! Each library here is the real one over the frozen `catalogue-26.sql`, the file 2.1's catalogue reads as, beside
//! what a 2.0 library would recover, prune or recreate: an orphaned asset, scratch, an engine log and a damaged
//! display cache. The library lists the items and changes no byte and no directory under the data folder.

use super::*;
use canopi_types::health::StoreOpenStatus;
use canopi_types::library::{LibraryItemKind, LibraryItemSummary};
use canopi_types::lidar::LidarResultState;
use std::collections::BTreeMap;
use std::path::Path;

// Frozen catalogue 26 (Step 2.0.4 R2-3; 2.1-M474, 2.1-M488, 2.1-M493): the literal file 2.1's catalogue
// reads as, which the reader release and the rollback lane open.
const CATALOGUE_26: &str = include_str!("../../test_fixtures/frozen/catalogue-26.sql");

/// Every directory (as `None`) and file (with its bytes) under `root`, except what SQLite may create on a read-only
/// open: a `-shm` file or an empty `-wal` (contracts §11 Degraded stores: engine metadata, not a write). Directories
/// count, so a created empty directory shows (2.1-M488: no directory created).
fn files(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                out.insert(path.strip_prefix(root).unwrap().to_path_buf(), None);
                walk(&path, root, out);
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let bytes = std::fs::read(&path).unwrap();
            if name.ends_with("-shm") || (name.ends_with("-wal") && bytes.is_empty()) {
                continue;
            }
            out.insert(path.strip_prefix(root).unwrap().to_path_buf(), Some(bytes));
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

/// A data folder holding `catalogue` (SQL run into a WAL-mode `lidar-library.sqlite`) and what a 2.0 library would
/// touch on open: an asset no row names, analysis scratch, an engine log and a display cache it cannot open.
fn data_folder(name: &str, catalogue: &str) -> crate::test_scratch::TestScratch {
    let root = crate::test_scratch::TestScratch::new(name);
    let lidar = paths::library_root(&root);
    for (file, bytes) in [
        ("assets/unreferenced/cog.tif", &b"kept"[..]),
        ("prepared/scratch-analysis-job-1/out.tif", b"kept"),
        ("engine-logs/job-1.log", b"kept"),
        ("lidar-display-cache.sqlite", b"not a database"),
    ] {
        std::fs::create_dir_all(lidar.join(file).parent().unwrap()).unwrap();
        std::fs::write(lidar.join(file), bytes).unwrap();
    }
    let connection = Connection::open(lidar.join(paths::CATALOGUE_FILE)).unwrap();
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    connection.execute_batch(catalogue).unwrap();
    drop(connection);
    root
}

fn listed(library: &LidarLibrary) -> Vec<LibraryItemSummary> {
    library.library_snapshot().unwrap().items
}

#[test]
fn r2_canopi_f47t_52_271_catalogue_26_lists_its_items_read_only_and_prunes_no_file() {
    let root = data_folder("reader-release-catalogue-26", CATALOGUE_26);
    let before = files(&root);

    let library = LidarLibrary::open(&root).expect("the app starts");

    assert_eq!(
        library.open_status().health(),
        StoreOpenStatus::NewerReadOnly,
        "catalogue 26 opens newer-read-only"
    );
    let items = listed(&library);
    let names: Vec<_> = items
        .iter()
        .filter_map(|item| item.name.as_deref())
        .collect();
    assert_eq!(names.len(), 4, "every item is listed by name: {names:?}");
    for name in [
        "Orchard terrain",
        "Orchard slope",
        "Hedge lines",
        "Drone canopy model",
    ] {
        assert!(names.contains(&name), "{name} is listed: {names:?}");
    }
    assert!(
        items
            .iter()
            .all(|item| item.state == LidarResultState::NeedsNewer && item.generation_id.is_none()),
        "each needs a newer Canopi and draws nothing (2.1-Q318)"
    );
    let id = items[0].id.clone();
    assert_eq!(
        library.rename_item(&id, "Renamed"),
        Err("store_read_only".to_owned())
    );
    assert!(
        library.delete_item(&id).is_err(),
        "a read-only library refuses a delete"
    );
    assert!(
        library
            .record_import_item(
                "Later",
                RasterQuantity::GroundElevation,
                None,
                false,
                &[root.join("later.tif")],
            )
            .is_err(),
        "a read-only library refuses an import"
    );
    drop(library);
    assert_eq!(
        files(&root),
        before,
        "no file is pruned, moved, created or written, and no directory is made"
    );
}

#[test]
fn r2_canopi_f47t_52_271_a_vector_row_and_an_unknown_literal_row_each_list_as_needing_a_newer_canopi()
 {
    // A later catalogue step may add literals; its rows still list, one each (2.1-M488).
    let later = CATALOGUE_26
        .replace("CHECK (kind IN ('raster', 'vector'))", "")
        .replace("CHECK (lineage_tag IN ('source', 'analysis', 'external'))", "")
        + "INSERT INTO library_items(id, kind, lineage_tag, name, name_key)
               VALUES ('pc-0000018f2a3b4c5d0006', 'point-cloud', 'survey', 'Hedge scan', 'hedge scan');";
    let root = data_folder("reader-release-catalogue-literals", &later);
    let library = LidarLibrary::open(&root).expect("the app starts");

    let items = listed(&library);
    let row = |name: &str| {
        items
            .iter()
            .find(|item| item.name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} is listed: {items:?}"))
    };
    assert_eq!(items.len(), 5, "the listing is never refused whole");
    assert_eq!(row("Hedge lines").newer_kind, Some(LibraryItemKind::Vector));
    assert_eq!(
        row("Orchard terrain").newer_kind,
        Some(LibraryItemKind::Raster)
    );
    assert_eq!(row("Orchard slope").role, LibraryItemRole::Derived);
    let unknown = row("Hedge scan");
    assert_eq!(
        (unknown.state, unknown.newer_kind, unknown.role),
        (LidarResultState::NeedsNewer, None, LibraryItemRole::Source)
    );
    assert_eq!(row("Hedge lines").state, LidarResultState::NeedsNewer);
}

#[test]
fn r2_canopi_f47t_52_271_a_queued_or_running_library_job_is_never_settled_interrupted() {
    let root = data_folder("reader-release-catalogue-jobs", CATALOGUE_26);
    let catalogue = paths::library_root(&root).join(paths::CATALOGUE_FILE);
    let jobs = || -> Vec<(String, String, Option<String>)> {
        let connection =
            Connection::open_with_flags(&catalogue, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let mut statement = connection
            .prepare("SELECT id, state, outcome FROM library_jobs ORDER BY id")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    let before = jobs();

    let library = LidarLibrary::open(&root).expect("the app starts");

    let running = listed(&library)
        .into_iter()
        .find(|item| item.name.as_deref() == Some("Hedge lines"))
        .unwrap();
    assert_eq!(
        running.state,
        LidarResultState::NeedsNewer,
        "its item lists as needing a newer Canopi"
    );
    drop(library);
    assert_eq!(jobs(), before, "no job is recovered, settled or failed");
    assert!(before.iter().any(|(_, state, _)| state == "running"));
    assert!(before.iter().any(|(_, state, _)| state == "queued"));
}

#[test]
fn r2_canopi_f47t_52_271_a_newer_catalogue_it_cannot_read_is_unavailable_and_never_set_aside() {
    // Version 99 without the read projection: the catalogue is newer but its items cannot be read.
    let root = data_folder(
        "reader-release-catalogue-unreadable",
        "CREATE TABLE lidar_catalogue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO lidar_catalogue_meta VALUES ('schema_version', '99');",
    );
    let lidar = paths::library_root(&root);
    std::fs::create_dir_all(lidar.join("sources/sha-n")).unwrap();
    std::fs::write(lidar.join("sources/sha-n/original"), b"tile").unwrap();
    let before = files(&root);

    let library = LidarLibrary::open(&root).expect("the app starts");

    assert!(
        matches!(
            library.open_status().health(),
            StoreOpenStatus::Unavailable { .. }
        ),
        "{:?}",
        library.open_status()
    );
    assert!(listed(&library).is_empty());
    assert!(library.rename_item("lyr-n", "x").is_err());
    drop(library);
    assert_eq!(files(&root), before, "never set aside, rebuilt or swept");
    assert!(!lidar.join(recovery::SET_ASIDE_DIR).exists());
}

/// Moved from `catalogue.rs`, which holds the library's SQL: `catalogue::open` refuses an older or a newer catalogue
/// before it writes, so only `recovery` decides between a rebuild and the read-only listing.
#[test]
fn any_other_catalogue_version_is_refused_before_writes() {
    for version in ["20", "99"] {
        let root = crate::test_scratch::TestScratch::new("canopi-catalogue-other");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("lidar-library.sqlite");
        {
            let connection = catalogue::open(&path).unwrap();
            connection
                .execute(
                    "UPDATE lidar_catalogue_meta SET value = ?1 WHERE key = 'schema_version'",
                    [version],
                )
                .unwrap();
        }
        let error = catalogue::open(&path).expect_err("another schema must be refused");
        assert!(error.contains("is not supported"), "{error}");
        assert_eq!(
            catalogue::stored_version(&path).unwrap(),
            Some(version.parse().unwrap()),
            "a refused catalogue is left untouched"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}

const CATALOGUE_25: &str = include_str!("../../test_fixtures/frozen/catalogue-25-probe.sql");

/// Each stored-enum column of catalogue 26: its name, the query reading its stored values and its enum's
/// literals.
fn stored_enum_columns() -> [(&'static str, &'static str, Vec<&'static str>); 4] {
    use canopi_types::library::{LibraryItemKind, LibraryJobOutcome, LibraryJobState, Lineage};
    [
        (
            "kind",
            "SELECT DISTINCT kind FROM library_items",
            LibraryItemKind::ALL.map(LibraryItemKind::literal).to_vec(),
        ),
        (
            "lineage_tag",
            "SELECT DISTINCT lineage_tag FROM library_items",
            Lineage::ALL.map(Lineage::literal).to_vec(),
        ),
        (
            "state",
            "SELECT DISTINCT state FROM library_jobs",
            LibraryJobState::ALL.map(LibraryJobState::literal).to_vec(),
        ),
        (
            "outcome",
            "SELECT DISTINCT outcome FROM library_jobs WHERE outcome IS NOT NULL",
            LibraryJobOutcome::ALL
                .map(LibraryJobOutcome::literal)
                .to_vec(),
        ),
    ]
}

/// Every literal a frozen catalogue lists in a stored-enum column's CHECK or stores in a row, as
/// `(column, literal, in ALL)`.
fn frozen_literals(sql: &str) -> Vec<(&'static str, String, bool)> {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch(sql).unwrap();
    let mut found = Vec::new();
    for (column, query, all) in stored_enum_columns() {
        let check = sql
            .split(&format!("CHECK ({column} IN ("))
            .nth(1)
            .and_then(|rest| rest.split("))").next())
            .unwrap_or_else(|| panic!("{column} has no CHECK list"));
        let mut statement = connection.prepare(query).unwrap();
        let stored: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for literal in check
            .split(',')
            .map(|l| l.trim().trim_matches('\'').to_owned())
            .chain(stored)
        {
            found.push((column, literal.clone(), all.contains(&literal.as_str())));
        }
    }
    found
}

#[test]
fn r2_canopi_f47t_52_271_every_frozen_catalogue_26_literal_stays_in_its_enums_all() {
    let found = frozen_literals(CATALOGUE_26);
    let missing: Vec<_> = found.iter().filter(|(_, _, known)| !known).collect();
    assert!(
        missing.is_empty(),
        "frozen literals missing from ALL: {missing:?}"
    );
    for (column, _, all) in stored_enum_columns() {
        for literal in all {
            assert!(
                found.iter().any(|(c, l, _)| *c == column && l == literal),
                "{column} {literal} unfrozen"
            );
        }
    }
    // A literal the frozen file keeps but the enum lost is named, in its CHECK and in its row.
    let planted = CATALOGUE_26.replace("'vector'", "'mesh'");
    let missing: Vec<_> = frozen_literals(&planted)
        .into_iter()
        .filter(|(_, _, known)| !known)
        .collect();
    assert_eq!(
        missing,
        [
            ("kind", "mesh".to_owned(), false),
            ("kind", "mesh".to_owned(), false)
        ]
    );
}

#[test]
fn r2_canopi_f47t_52_271_v2_0_3_inspect_reads_frozen_catalogue_26_as_newer_never_corrupt() {
    use crate::services::lidar::recovery::{CatalogueState, inspect};
    let root = crate::test_scratch::TestScratch::new("canopi-catalogue-26-inspect");
    let path = root.join("lidar-library.sqlite");
    Connection::open(&path)
        .unwrap()
        .execute_batch(CATALOGUE_26)
        .unwrap();
    let before = std::fs::read(&path).unwrap();
    // recovery::inspect and catalogue::stored_version are v2.0.3's, unchanged since the tag but for the
    // crate rename; R4's rollback lane runs this fixture through the tag's own binary.
    assert_eq!(inspect(&path), CatalogueState::Newer(26));
    assert_eq!(
        std::fs::read(&path).unwrap(),
        before,
        "inspect leaves the catalogue byte-identical"
    );
}

#[test]
fn r2_canopi_f47t_52_271_frozen_catalogue_26_keeps_catalogue_25_ids_and_the_job_checks() {
    let ids = |sql: &str, query: &str| -> Vec<String> {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(sql).unwrap();
        let mut statement = connection.prepare(query).unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    let items = ids(CATALOGUE_26, "SELECT id FROM library_items");
    for id in ids(
        CATALOGUE_25,
        "SELECT id FROM lidar_source_layers UNION SELECT id FROM lidar_derived_items",
    ) {
        assert!(items.contains(&id), "{id} lost its catalogue 25 spelling");
    }
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch(CATALOGUE_26).unwrap();
    for (state, outcome, failure) in [
        ("settled", None, None),
        ("running", Some("succeeded"), None),
        ("settled", Some("failed"), None),
        ("settled", Some("succeeded"), Some("{}")),
        ("settled", Some("failed"), Some("not json")),
        ("paused", None, None),
    ] {
        let refused = connection.execute(
            "INSERT INTO library_jobs(id, state, outcome, failure, operation_id) VALUES ('x', ?1, ?2, ?3, 'u-x')",
            rusqlite::params![state, outcome, failure],
        );
        assert!(
            refused.is_err(),
            "{state} {outcome:?} {failure:?} passed the contracts §8 CHECKs"
        );
    }
}
