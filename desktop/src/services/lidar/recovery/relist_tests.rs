//! canopi-kc9q: a library 2.0.3 (or 2.0.4 before this fix) left with an empty current catalogue lists again, at
//! startup, each original whose own meta names an item the catalogue lacks, with its analyses; nothing else in the
//! catalogue changes and a meta-less original stays unlisted on disk. Each library is the real one
//! (`LidarLibrary::open`), started over the same folder more than once.

use super::super::LidarLibrary;
use super::tests::seed_original;
use super::*;
use canopi_types::lidar::LidarImportJobState;
use std::collections::BTreeMap;

/// Every row of every catalogue table, each rendered as text, sorted per table.
fn rows(library: &LidarLibrary) -> BTreeMap<String, Vec<String>> {
    let connection = library.catalogue().unwrap();
    let tables: Vec<String> = connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    tables
        .into_iter()
        .map(|table| {
            let mut statement = connection
                .prepare(&format!("SELECT * FROM \"{table}\""))
                .unwrap();
            let columns = statement.column_count();
            let mut rendered: Vec<String> = statement
                .query_map([], |row| {
                    (0..columns)
                        .map(|index| row.get::<_, rusqlite::types::Value>(index))
                        .collect::<Result<Vec<_>, _>>()
                        .map(|values| format!("{values:?}"))
                })
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            rendered.sort();
            (table, rendered)
        })
        .collect()
}

fn ids(library: &LidarLibrary, sql: &str) -> Vec<String> {
    let connection = library.catalogue().unwrap();
    let mut statement = connection.prepare(sql).unwrap();
    statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn source_item_ids(library: &LidarLibrary) -> Vec<String> {
    ids(library, "SELECT id FROM lidar_source_layers ORDER BY id")
}

fn source_rows(library: &LidarLibrary) -> Vec<String> {
    ids(library, "SELECT sha256 FROM lidar_sources ORDER BY sha256")
}

fn analysis(
    definition: &str,
    inputs: &[&str],
    output: &str,
    created_at: &str,
) -> source_meta::AnalysisMeta {
    source_meta::AnalysisMeta {
        definition_id: definition.to_string(),
        analysis_id: "terrain.slope".to_string(),
        parameters: serde_json::json!([{"key":"unit","value":{"Choice":"degrees"}}]),
        outputs: serde_json::json!(["slope"]),
        created_at: created_at.to_string(),
        inputs: inputs
            .iter()
            .map(|item| source_meta::AnalysisInputMeta {
                input_key: format!("dem-{item}"),
                item_id: (*item).to_string(),
            })
            .collect(),
        items: vec![source_meta::DerivedItemMeta {
            id: output.to_string(),
            output_key: "slope".to_string(),
            quantity: "slope".to_string(),
            units: "°".to_string(),
            name: Some(format!("Steepness {output}")),
            created_at: created_at.to_string(),
        }],
    }
}

/// A meta `sha256` keeps for itself (`claims` is the sha256 it names), naming item `item` over `members`.
fn meta(
    claims: &str,
    item: &str,
    members: &[&str],
    analyses: Vec<source_meta::AnalysisMeta>,
) -> SourceMeta {
    SourceMeta {
        version: source_meta::META_VERSION,
        sha256: claims.to_string(),
        original_filename: format!("{item}.tif"),
        size_bytes: 4,
        imported_at: "2026-01-01T00:00:00Z".to_string(),
        items: vec![source_meta::ItemMeta {
            id: item.to_string(),
            name: format!("Field {item}"),
            quantity: DEFAULT_QUANTITY_KEY.to_string(),
            units: "m".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            members: members.iter().map(|member| (*member).to_string()).collect(),
            analyses,
        }],
    }
}

/// A data folder whose current catalogue holds one published item, `lyr-kept` over `sha-kept`, as a 2.0.3 start
/// left it after its failed rebuild dropped every other row; the original files are added by each test.
fn hit_library(name: &str) -> (crate::test_scratch::TestScratch, LidarPaths) {
    let root = crate::test_scratch::TestScratch::new(name);
    let library = LidarLibrary::open(&root).unwrap();
    assert_eq!(*library.open_status(), LibraryOpenStatus::Ready);
    source_meta::test_support::seed_published_item(
        &library.catalogue().unwrap(),
        "lyr-kept",
        "Kept",
        DEFAULT_QUANTITY_KEY,
        "m",
        &[("sha-kept", "kept.tif")],
    );
    let paths = library.inner.paths.clone();
    drop(library);
    seed_original(
        &paths,
        "sha-kept",
        Some(&meta("sha-kept", "lyr-kept", &["sha-kept"], Vec::new())),
    );
    (root, paths)
}

/// Each row of `before` is still in `after`, unchanged.
fn assert_rows_kept(before: &BTreeMap<String, Vec<String>>, after: &BTreeMap<String, Vec<String>>) {
    for (table, rows) in before {
        for row in rows {
            assert!(after[table].contains(row), "{table}: {row} changed or went");
        }
    }
}

#[test]
fn canopi_kc9q_an_unlisted_original_with_a_good_meta_is_listed_again_with_its_analyses() {
    let (root, paths) = hit_library("lidar-kc9q-relist");
    let before = {
        let library = LidarLibrary::open(&root).unwrap();
        let kept = rows(&library);
        drop(library);
        kept
    };
    seed_original(
        &paths,
        "sha-a",
        Some(&meta(
            "sha-a",
            "lyr-a",
            &["sha-a", "sha-gone"],
            vec![
                analysis("adef-1", &["lyr-a"], "item-slope", "2026-01-02T00:00:00Z"),
                // A chain over a result comes back after the result it reads.
                analysis(
                    "adef-2",
                    &["item-slope"],
                    "item-slope-2",
                    "2026-01-03T00:00:00Z",
                ),
                // One over an item no original names any more stays out.
                analysis(
                    "adef-3",
                    &["lyr-a", "lyr-lost"],
                    "item-lost",
                    "2026-01-04T00:00:00Z",
                ),
            ],
        )),
    );

    let library = LidarLibrary::open(&root).unwrap();

    assert_eq!(
        *library.open_status(),
        LibraryOpenStatus::Ready,
        "no rebuild"
    );
    assert!(!paths.set_aside_dir().exists(), "no catalogue is set aside");
    assert_eq!(source_item_ids(&library), vec!["lyr-a", "lyr-kept"]);
    let snapshot = library.library_snapshot().unwrap();
    let listed: Vec<&str> = snapshot.items.iter().map(|item| item.id.as_str()).collect();
    for id in ["lyr-a", "item-slope", "item-slope-2", "lyr-kept"] {
        assert!(listed.contains(&id), "{id} is listed: {listed:?}");
    }
    assert!(!listed.contains(&"item-lost"), "{listed:?}");
    let relisted = snapshot
        .items
        .iter()
        .find(|item| item.id == "lyr-a")
        .unwrap();
    assert_eq!(relisted.name.as_deref(), Some("Field lyr-a"));
    let job = relisted.import_job.as_ref().expect("a retryable import");
    assert_eq!(job.state, LidarImportJobState::Failed);
    assert_eq!(
        library.delete_impact("lyr-a").unwrap().dependent_item_ids,
        vec!["item-slope"]
    );
    assert_eq!(
        library
            .delete_impact("item-slope")
            .unwrap()
            .dependent_item_ids,
        vec!["item-slope-2"],
        "the chain reads the result it was defined over"
    );
    assert_eq!(
        source_meta::read(&paths.source_meta("sha-a"))
            .unwrap()
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec!["lyr-a"],
        "the refreshed meta still names the item, so a later rebuild keeps it"
    );
    let after = rows(&library);
    assert_rows_kept(&before, &after);
    drop(library);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn canopi_kc9q_a_meta_less_or_mismatched_original_stays_unlisted_and_on_disk() {
    let (root, paths) = hit_library("lidar-kc9q-left-alone");
    seed_original(&paths, "sha-b", None);
    seed_original(
        &paths,
        "sha-c",
        Some(&meta("sha-other", "lyr-c", &["sha-c"], Vec::new())),
    );
    std::fs::create_dir_all(paths.source_dir("sha-d")).unwrap();
    std::fs::write(paths.source_original("sha-d"), b"tile").unwrap();
    std::fs::write(paths.source_meta("sha-d"), b"{ not json").unwrap();

    let library = LidarLibrary::open(&root).unwrap();

    assert_eq!(*library.open_status(), LibraryOpenStatus::Ready);
    assert_eq!(source_item_ids(&library), vec!["lyr-kept"]);
    assert_eq!(source_rows(&library), vec!["sha-kept"]);
    for sha256 in ["sha-b", "sha-c", "sha-d"] {
        assert_eq!(
            std::fs::read(paths.source_original(sha256)).ok().as_deref(),
            Some(&b"tile"[..]),
            "{sha256} is kept on disk"
        );
    }
    assert!(!paths.source_meta("sha-b").exists(), "no meta is invented");
    drop(library);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn canopi_kc9q_an_item_already_listed_is_untouched_and_two_metas_naming_one_item_list_it_once() {
    let (root, paths) = hit_library("lidar-kc9q-present");
    // An unclaimed original whose stale meta names the listed item: never a second copy of it.
    seed_original(
        &paths,
        "sha-stale",
        Some(&meta("sha-stale", "lyr-kept", &["sha-stale"], Vec::new())),
    );
    seed_original(
        &paths,
        "sha-e1",
        Some(&meta("sha-e1", "lyr-e", &["sha-e1", "sha-e2"], Vec::new())),
    );
    let mut disagreeing = meta("sha-e2", "lyr-e", &["sha-e2"], Vec::new());
    disagreeing.items[0].name = "Other name".to_string();
    seed_original(&paths, "sha-e2", Some(&disagreeing));

    let library = LidarLibrary::open(&root).unwrap();

    assert_eq!(source_item_ids(&library), vec!["lyr-e", "lyr-kept"]);
    assert_eq!(
        ids(
            &library,
            "SELECT name FROM lidar_source_layers WHERE id = 'lyr-kept'"
        ),
        vec!["Kept"]
    );
    assert_eq!(
        ids(
            &library,
            "SELECT name FROM lidar_source_layers WHERE id = 'lyr-e'"
        ),
        vec!["Field lyr-e"],
        "the first meta in folder order"
    );
    assert_eq!(source_rows(&library), vec!["sha-e1", "sha-e2", "sha-kept"]);
    let first = rows(&library);
    drop(library);

    let library = LidarLibrary::open(&root).unwrap();
    assert_eq!(
        rows(&library),
        first,
        "the metas agree now; nothing more is written"
    );
    drop(library);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn canopi_kc9q_a_second_start_writes_nothing() {
    let (root, paths) = hit_library("lidar-kc9q-second-start");
    seed_original(
        &paths,
        "sha-a",
        Some(&meta(
            "sha-a",
            "lyr-a",
            &["sha-a"],
            vec![analysis(
                "adef-1",
                &["lyr-a"],
                "item-slope",
                "2026-01-02T00:00:00Z",
            )],
        )),
    );
    seed_original(&paths, "sha-b", None);
    let library = LidarLibrary::open(&root).unwrap();
    let first = rows(&library);
    assert_eq!(source_item_ids(&library), vec!["lyr-a", "lyr-kept"]);
    drop(library);

    let library = LidarLibrary::open(&root).unwrap();

    assert_eq!(rows(&library), first);
    drop(library);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn canopi_kc9q_an_item_whose_insert_fails_is_left_out_alone_and_the_others_list() {
    let (root, paths) = hit_library("lidar-kc9q-insert-fails");
    let input = source_meta::AnalysisInputMeta {
        input_key: "elevation".to_string(),
        item_id: "lyr-f".to_string(),
    };
    let mut repeated = analysis("adef-f", &[], "item-f", "2026-01-02T00:00:00Z");
    repeated.inputs = vec![input.clone(), input];
    seed_original(
        &paths,
        "sha-f",
        Some(&meta("sha-f", "lyr-f", &["sha-f"], vec![repeated])),
    );
    seed_original(
        &paths,
        "sha-g",
        Some(&meta("sha-g", "lyr-g", &["sha-g"], Vec::new())),
    );

    let library = LidarLibrary::open(&root).unwrap();

    assert_eq!(*library.open_status(), LibraryOpenStatus::Ready);
    assert_eq!(
        source_item_ids(&library),
        vec!["lyr-g", "lyr-kept"],
        "the failed item rolls back whole, with its analysis"
    );
    assert_eq!(source_rows(&library), vec!["sha-g", "sha-kept"]);
    assert!(ids(&library, "SELECT id FROM lidar_analysis_definitions").is_empty());
    assert!(
        paths.source_original("sha-f").is_file(),
        "its original stays"
    );
    assert_eq!(
        source_meta::read(&paths.source_meta("sha-f"))
            .unwrap()
            .items[0]
            .id,
        "lyr-f",
        "its meta still names it for a later start"
    );
    drop(library);
    std::fs::remove_dir_all(root).unwrap();
}
