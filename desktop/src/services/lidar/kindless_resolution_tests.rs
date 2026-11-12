//! Probe: a v10 Site data entry without `kind` resolves by id alone (Step 2.0.4 R2-1, canopi-f47t.52.271; 2.1-M475,
//! design check A6).
//!
//! The reader release reads a v10 Design whose Site data entries may carry no `kind`. It resolves each entry's id
//! against the library it finds: its own catalogue 25 (two tables: imported items in `lidar_source_layers`, minted
//! `lyr-`, and analysis results in `lidar_derived_items`, minted `item-`) or 2.1's catalogue 26 read projection
//! `library_items`. An id the library does not hold, or holds twice, lists unavailable by the entry's stored name and
//! never draws another item. These tests show the library side holds: an id names at most one item in either
//! catalogue, so `kind` is not needed to find it. R1-3 may freeze `kind` in the v10 read schema optional only together
//! with the product change below.
//!
//! The resolvers here are the probe's, not the product's. The product resolves Site data entries in TypeScript, and
//! today two functions match id and kind together, each failing its own way on an entry with no kind or the other kind:
//! - `readLidarPresentation` (`desktop/web/src/app/lidar/library-store.ts`) lists the entry unavailable although its id
//!   is in the library;
//! - `upsertLidarEntry` (`desktop/web/src/app/design-edit/lidar.ts`), called with a kind on each edit, misses the
//!   stored entry and appends a second entry with the same id.
//!
//! The contract these tests fix is that both match by id alone: the reader takes the kind from the matched library
//! item, and an edit updates the stored entry (writing the kind it was called with) instead of adding a duplicate.
//! Each change ships with a regression test through the real function for kind-less and wrong-kind entries: R2-4 owns
//! `readLidarPresentation`; `upsertLidarEntry` needs its own owner, named by the step plan. Until both land,
//! "optional and ignored" holds only for these resolvers, and R1-3 must not freeze `kind` optional.

use super::*;
use canopi_types::library::RasterQuantity;
use serde::Deserialize;

/// Frozen catalogue 25: the two item tables with one row each.
const CATALOGUE_25: &str = include_str!("../../test_fixtures/frozen/catalogue-25-probe.sql");

/// A draft of 2.1's catalogue 26 as far as the reader reads it: the version row it keeps (2.1-M474), the read
/// projection `library_items(id, kind, lineage_tag, name, name_key)` (contracts §11 Read projections, A3) and the
/// jobs table under its 2.1 name `library_jobs` (2.1-M474). Ids keep their catalogue 25 spelling across the step.
/// R2-3 freezes the whole `catalogue-26.sql`; this draft holds only what resolution reads.
const DRAFT_CATALOGUE_26: &str = "
CREATE TABLE lidar_catalogue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO lidar_catalogue_meta(key, value) VALUES ('schema_version', '26');
CREATE TABLE library_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    lineage_tag TEXT,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE
);
CREATE TABLE library_jobs (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    item_id TEXT REFERENCES library_items(id),
    state TEXT NOT NULL,
    outcome TEXT
);
INSERT INTO library_items(id, kind, lineage_tag, name, name_key)
    VALUES ('lyr-0000018f2a3b4c5d0001', 'raster', 'imported', 'Orchard terrain', 'orchard terrain');
INSERT INTO library_items(id, kind, lineage_tag, name, name_key)
    VALUES ('item-0000018f2a3b4c5d0003', 'raster', 'terrain.slope', 'Orchard slope', 'orchard slope');
INSERT INTO library_items(id, kind, lineage_tag, name, name_key)
    VALUES ('vec-0000018f2a3b4c5d0004', 'vector', 'imported', 'Hedge lines', 'hedge lines');
";

const SOURCE_ID: &str = "lyr-0000018f2a3b4c5d0001";
const DERIVED_ID: &str = "item-0000018f2a3b4c5d0003";
const MISSING_ID: &str = "lyr-0000018f2a3b4c5dffff";

/// A v10 Site data entry as the reader's read schema decodes it: `kind` optional, any value, never read by resolution.
#[derive(Debug, Deserialize)]
struct KindlessEntry {
    id: String,
    name: String,
    #[serde(default)]
    kind: Option<serde_json::Value>,
}

/// What a Site data row shows for one entry.
#[derive(Debug, PartialEq, Eq)]
enum Resolution {
    /// The library holds exactly one item with the entry's id; `table` names where it lives.
    Item { table: &'static str, name: String },
    /// The library holds no item with the id, or holds it twice: the row reads by the entry's stored name.
    Unavailable { name: String },
}

fn entry(json: serde_json::Value) -> KindlessEntry {
    serde_json::from_value(json).expect("a Site data entry without kind decodes")
}

fn open_fixture(sql: &str) -> rusqlite::Connection {
    let connection = rusqlite::Connection::open_in_memory().unwrap();
    connection.execute_batch(sql).unwrap();
    connection
}

/// Catalogue 25: the id is looked up in both item tables; only a single hit resolves.
fn resolve_25(connection: &rusqlite::Connection, entry: &KindlessEntry) -> Resolution {
    let mut statement = connection
        .prepare(
            "SELECT 'lidar_source_layers', name FROM lidar_source_layers WHERE id = ?1
             UNION ALL
             SELECT 'lidar_derived_items', name FROM lidar_derived_items WHERE id = ?1",
        )
        .unwrap();
    let hits: Vec<(String, Option<String>)> = statement
        .query_map([&entry.id], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    single(hits, entry)
}

/// Catalogue 26: the id is looked up in the read projection `library_items`.
fn resolve_26(connection: &rusqlite::Connection, entry: &KindlessEntry) -> Resolution {
    let mut statement = connection
        .prepare("SELECT 'library_items', name FROM library_items WHERE id = ?1")
        .unwrap();
    let hits: Vec<(String, Option<String>)> = statement
        .query_map([&entry.id], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    single(hits, entry)
}

fn single(mut hits: Vec<(String, Option<String>)>, entry: &KindlessEntry) -> Resolution {
    if hits.len() != 1 {
        return Resolution::Unavailable {
            name: entry.name.clone(),
        };
    }
    let (table, name) = hits.remove(0);
    let table = match table.as_str() {
        "lidar_source_layers" => "lidar_source_layers",
        "lidar_derived_items" => "lidar_derived_items",
        _ => "library_items",
    };
    Resolution::Item {
        table,
        name: name.unwrap_or_else(|| entry.name.clone()),
    }
}

fn item(table: &'static str, name: &str) -> Resolution {
    Resolution::Item {
        table,
        name: name.to_string(),
    }
}

fn unavailable(name: &str) -> Resolution {
    Resolution::Unavailable {
        name: name.to_string(),
    }
}

/// The three entries of the probe's v10 Design: an imported item, an analysis result and one the library lost.
fn design_entries() -> [KindlessEntry; 3] {
    [
        entry(
            serde_json::json!({ "id": SOURCE_ID, "name": "Orchard terrain", "visible": true, "opacity": 1.0 }),
        ),
        entry(
            serde_json::json!({ "id": DERIVED_ID, "name": "Orchard slope", "visible": true, "opacity": 0.6 }),
        ),
        entry(
            serde_json::json!({ "id": MISSING_ID, "name": "Old survey", "visible": false, "opacity": 1.0 }),
        ),
    ]
}

#[test]
fn r2_canopi_f47t_52_271_kindless_entries_resolve_by_id_against_catalogue_25s_two_tables() {
    let connection = open_fixture(CATALOGUE_25);
    let [source, derived, missing] = design_entries();

    assert_eq!(
        resolve_25(&connection, &source),
        item("lidar_source_layers", "Orchard terrain")
    );
    assert_eq!(
        resolve_25(&connection, &derived),
        item("lidar_derived_items", "Orchard slope")
    );
    assert_eq!(resolve_25(&connection, &missing), unavailable("Old survey"));
}

#[test]
fn r2_canopi_f47t_52_271_kindless_entries_resolve_by_id_against_catalogue_26s_library_items() {
    let connection = open_fixture(DRAFT_CATALOGUE_26);
    let [source, derived, missing] = design_entries();

    assert_eq!(
        resolve_26(&connection, &source),
        item("library_items", "Orchard terrain")
    );
    assert_eq!(
        resolve_26(&connection, &derived),
        item("library_items", "Orchard slope")
    );
    assert_eq!(resolve_26(&connection, &missing), unavailable("Old survey"));
}

#[test]
fn r2_canopi_f47t_52_271_a_present_kind_is_ignored_even_when_it_names_the_other_table() {
    let connection = open_fixture(CATALOGUE_25);
    let wrong_kind =
        entry(serde_json::json!({ "id": SOURCE_ID, "name": "Orchard terrain", "kind": "Derived" }));
    let unknown_kind =
        entry(serde_json::json!({ "id": DERIVED_ID, "name": "Orchard slope", "kind": "vector" }));
    assert_eq!(
        wrong_kind.kind,
        Some(serde_json::json!("Derived")),
        "a present kind decodes"
    );
    assert_eq!(design_entries()[0].kind, None, "an absent kind decodes");

    assert_eq!(
        resolve_25(&connection, &wrong_kind),
        item("lidar_source_layers", "Orchard terrain")
    );
    assert_eq!(
        resolve_25(&connection, &unknown_kind),
        item("lidar_derived_items", "Orchard slope")
    );
}

#[test]
fn r2_canopi_f47t_52_271_an_id_present_in_both_catalogue_25_tables_lists_unavailable_by_name() {
    let connection = open_fixture(CATALOGUE_25);
    connection
        .execute(
            "INSERT INTO lidar_derived_items(id, definition_id, output_key, item_kind, quantity, units, name, created_at)
             VALUES (?1, 'adef-0000018f2a3b4c5d0002', 'aspect', 'raster', 'slope', '°', 'Clash', '1790000000003')",
            [SOURCE_ID],
        )
        .unwrap();
    let both = entry(serde_json::json!({ "id": SOURCE_ID, "name": "Orchard terrain as saved" }));

    assert_eq!(
        resolve_25(&connection, &both),
        unavailable("Orchard terrain as saved"),
        "an id both tables hold names no one item, so the row never draws the wrong one"
    );
}

#[test]
fn r2_canopi_f47t_52_271_an_id_missing_from_the_library_lists_by_its_stored_name_in_both_catalogues()
 {
    let catalogue_25 = open_fixture(CATALOGUE_25);
    let catalogue_26 = open_fixture(DRAFT_CATALOGUE_26);
    let lost =
        entry(serde_json::json!({ "id": "item-0000018f2a3b4c5dfffe", "name": "Deleted slope" }));
    let empty = entry(serde_json::json!({ "id": "", "name": "Blank id" }));

    assert_eq!(
        resolve_25(&catalogue_25, &lost),
        unavailable("Deleted slope")
    );
    assert_eq!(
        resolve_26(&catalogue_26, &lost),
        unavailable("Deleted slope")
    );
    assert_eq!(resolve_25(&catalogue_25, &empty), unavailable("Blank id"));
    assert_eq!(resolve_26(&catalogue_26, &empty), unavailable("Blank id"));
}

/// The fixture is catalogue 25 as this binary builds it: every column of every fixture table matches the live schema.
#[test]
fn r2_canopi_f47t_52_271_the_catalogue_25_probe_fixture_matches_the_live_schema() {
    fn columns(connection: &rusqlite::Connection, table: &str) -> Vec<(String, String, bool, i64)> {
        let mut statement = connection
            .prepare("SELECT name, type, \"notnull\", pk FROM pragma_table_info(?1) ORDER BY cid")
            .unwrap();
        statement
            .query_map([table], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
    let fixture = open_fixture(CATALOGUE_25);
    let live = catalogue::open_in_memory().unwrap();
    for table in [
        "lidar_catalogue_meta",
        "lidar_source_layers",
        "lidar_analysis_definitions",
        "lidar_derived_items",
    ] {
        let expected = columns(&live, table);
        assert!(!expected.is_empty(), "{table} is a live catalogue 25 table");
        assert_eq!(
            columns(&fixture, table),
            expected,
            "{table} matches the live schema"
        );
    }
    let version: String = fixture
        .query_row(
            "SELECT value FROM lidar_catalogue_meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, catalogue::CATALOGUE_VERSION.to_string());
}

/// Through the real library: an item this binary imports is minted `lyr-` and resolves kind-less in its catalogue file.
#[test]
fn r2_canopi_f47t_52_271_an_item_the_real_library_imports_resolves_without_its_kind() {
    let root = crate::test_scratch::TestScratch::new("kindless-resolution");
    let library = LidarLibrary::open(&root).unwrap();
    let (layer_id, _job_id) = library
        .record_import_item(
            "Hedge terrain",
            RasterQuantity::GroundElevation,
            None,
            false,
            &[root.join("hedge.tif")],
        )
        .unwrap();
    drop(library);
    assert!(
        layer_id.starts_with("lyr-"),
        "imported items are minted lyr-: {layer_id}"
    );

    let connection = rusqlite::Connection::open_with_flags(
        paths::library_root(&root).join(paths::CATALOGUE_FILE),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let saved = entry(serde_json::json!({ "id": layer_id, "name": "Hedge terrain" }));

    assert_eq!(
        resolve_25(&connection, &saved),
        item("lidar_source_layers", "Hedge terrain")
    );
}
