//! The reader release's Data library user path (Step 2.0.4 R2, canopi-f47t.52.271; plan "reader release: catalogue 26
//! lists its items read-only and prunes no file", 2.1-M88, 2.1-Q318).
//!
//! Written failing in commit 0 and marked expected-fail: R2-4 (the catalogue's newer-read-only open) removes the marker.
//! The catalogue is a real library built by this binary, then stamped schema version 26 with the frozen read
//! projection's `library_items` table beside its v25 tables, as 2.1 leaves it after its step; R2-4 may swap in the
//! frozen `catalogue-26.sql` fixture once R2-3 lands it.

use super::*;
use canopi_types::health::StoreOpenStatus;
use canopi_types::library::RasterQuantity;
use std::collections::BTreeMap;
use std::path::Path;

/// Every file under `root` with its bytes, except what SQLite may create on a read-only open: a `-shm` file or an
/// empty `-wal` (contracts §11 Degraded stores: engine metadata, not a write).
fn files(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, root, out);
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let bytes = std::fs::read(&path).unwrap();
            if name.ends_with("-shm") || (name.ends_with("-wal") && bytes.is_empty()) {
                continue;
            }
            out.insert(path.strip_prefix(root).unwrap().to_path_buf(), bytes);
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

/// Stamps the catalogue at `path` as 2.1's catalogue 26 would leave it: schema version 26 and the read projection's
/// `library_items(id, kind, lineage_tag, name, name_key)` listing every item (contracts §11 Read projections).
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
