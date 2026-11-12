//! The reader release's Data library user path (Step 2.0.4 R2, canopi-f47t.52.271; plan "reader release: catalogue 26
//! lists its items read-only and prunes no file", 2.1-M88, 2.1-Q318).
//!
//! Written failing in commit 0 and marked expected-fail: R2-4 (the catalogue's newer-read-only open) removes the marker.
//! The catalogue is a real library built by this binary, then stamped schema version 26 with the frozen read
//! projection's `library_items` table and the jobs table under its 2.1 name `library_jobs` (2.1-M474). The other
//! tables keep their v25 names here only because R2-3 freezes their `library_*` names: R2-4 must swap in the frozen
//! `catalogue-26.sql` fixture before it removes the marker, so an R2 still reading a v25 table cannot pass.

use super::*;
use canopi_types::health::StoreOpenStatus;
use canopi_types::library::RasterQuantity;
use std::collections::BTreeMap;
use std::path::Path;

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

/// Stamps the catalogue at `path` as 2.1's catalogue 26 would leave it: schema version 26 and the read projection's
/// `library_items(id, kind, lineage_tag, name, name_key)` listing every item (contracts §11 Read projections) and the
/// jobs table renamed `library_jobs` (2.1-M474).
#[cfg(test)]
fn stamp_catalogue_26(path: &Path) {
    let connection = rusqlite::Connection::open(path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE library_items (
                 id TEXT PRIMARY KEY, kind TEXT NOT NULL, lineage_tag TEXT, name TEXT NOT NULL, name_key TEXT NOT NULL
             );
             INSERT INTO library_items(id, kind, lineage_tag, name, name_key)
                 SELECT id, 'raster', NULL, name, lower(name) FROM lidar_source_layers;
             ALTER TABLE lidar_import_jobs RENAME TO library_jobs;
             UPDATE lidar_catalogue_meta SET value = '26' WHERE key = 'schema_version';
             PRAGMA wal_checkpoint(TRUNCATE);",
        )
        .unwrap();
}

#[test]
#[ignore = "expected-fail: R2 canopi-f47t.52.271"]
fn r2_canopi_f47t_52_271_catalogue_26_lists_its_items_read_only_and_prunes_no_file() {
    let root = crate::test_scratch::TestScratch::new("reader-release-catalogue-26");
    let library = LidarLibrary::open(&root).unwrap();
    library
        .record_import_item(
            "Orchard terrain",
            RasterQuantity::GroundElevation,
            None,
            false,
            &[root.join("orchard.tif")],
        )
        .unwrap();
    let listed: Vec<String> = library
        .library_snapshot()
        .unwrap()
        .items
        .into_iter()
        .filter_map(|item| item.name)
        .collect();
    assert!(
        listed.iter().any(|name| name == "Orchard terrain"),
        "the v25 library lists the item: {listed:?}"
    );
    drop(library);
    let lidar = paths::library_root(&root);
    stamp_catalogue_26(&lidar.join(paths::CATALOGUE_FILE));
    let before = files(&root);

    let library = LidarLibrary::open(&root).expect("the app starts");

    // Today the catalogue is refused (refused_newer) and the library shows empty.
    assert_eq!(
        library.open_status().health(),
        StoreOpenStatus::NewerReadOnly,
        "catalogue 26 opens newer-read-only"
    );
    let reread: Vec<String> = library
        .library_snapshot()
        .unwrap()
        .items
        .into_iter()
        .filter_map(|item| item.name)
        .collect();
    assert!(
        reread.iter().any(|name| name == "Orchard terrain"),
        "its items are listed by name: {reread:?}"
    );
    assert!(
        library
            .rename_item(&library.library_snapshot().unwrap().items[0].id, "Renamed")
            .is_err(),
        "a read-only library refuses a rename"
    );
    drop(library);
    assert_eq!(
        files(&root),
        before,
        "no file is pruned, moved, created or written"
    );
}

// Frozen catalogue 26 (Step 2.0.4 R2-3; 2.1-M474, 2.1-M488, 2.1-M493): the literal file 2.1's catalogue
// reads as, which the reader release and the rollback lane open.
const CATALOGUE_26: &str = include_str!("../../test_fixtures/frozen/catalogue-26.sql");
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
