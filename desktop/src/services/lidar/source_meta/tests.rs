//! `source_meta.rs`'s own tests.

use super::super::analyses::test_support::seed_published_slope;
use super::super::catalogue;
use super::super::paths::META_FILE;
use super::*;
use canopi_types::library::RasterQuantity;

fn fresh_catalogue() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    catalogue::create_schema(&connection).unwrap();
    connection
}

/// The meta of a member records its item's name, quantity, units, the
/// full member order and every analysis defined over the item, including
/// one over a result of it.
#[test]
fn a_members_meta_carries_the_item_and_its_analyses() {
    let connection = fresh_catalogue();
    test_support::seed_published_item(
        &connection,
        "lyr-a",
        "Orchard ground",
        RasterQuantity::GroundElevation.key(),
        "m",
        &[("sha-1", "tile-1.tif"), ("sha-2", "tile-2.tif")],
    );
    seed_published_slope(
        &connection,
        "lyr-a",
        "gen-lyr-a",
        "adef-1",
        "item-slope",
        "dgen-1",
        Some("Slope"),
    );
    // A second analysis over the slope result (a chain), and one over an
    // unrelated item that must not appear.
    test_support::seed_published_item(
        &connection,
        "lyr-b",
        "Other",
        RasterQuantity::GroundElevation.key(),
        "m",
        &[("sha-3", "b.tif")],
    );
    seed_published_slope(
        &connection,
        "item-slope",
        "dgen-1",
        "adef-2",
        "item-chain",
        "dgen-2",
        None,
    );
    seed_published_slope(
        &connection,
        "lyr-b",
        "gen-lyr-b",
        "adef-3",
        "item-other",
        "dgen-3",
        None,
    );

    let scratch = crate::test_scratch::TestScratch::new("canopi-source-meta-derive");
    let paths = LidarPaths::open(&scratch).unwrap();
    let metas = derive_all(&connection, &paths).unwrap();
    assert_eq!(metas.len(), 3);
    let second = metas.iter().find(|meta| meta.sha256 == "sha-2").unwrap();
    assert_eq!(second.original_filename, "tile-2.tif");
    assert_eq!(second.items.len(), 1);
    let item = &second.items[0];
    assert_eq!(item.name, "Orchard ground");
    assert_eq!(item.quantity, RasterQuantity::GroundElevation.key());
    assert_eq!(item.units, "m");
    assert_eq!(item.members, vec!["sha-1", "sha-2"]);
    let definitions: Vec<&str> = item
        .analyses
        .iter()
        .map(|analysis| analysis.definition_id.as_str())
        .collect();
    assert_eq!(definitions, vec!["adef-1", "adef-2"]);
    assert_eq!(item.analyses[0].items[0].name.as_deref(), Some("Slope"));
    assert_eq!(item.analyses[0].inputs[0].item_id, "lyr-a");
    let other = metas.iter().find(|meta| meta.sha256 == "sha-3").unwrap();
    assert_eq!(other.items[0].analyses.len(), 1);
    std::fs::remove_dir_all(&scratch).unwrap();
}

/// One original whose meta cannot be written keeps only its own meta
/// stale: every other original's meta is still rewritten, and the failure
/// is still returned, naming the original it hit.
#[test]
fn an_unwritable_meta_leaves_the_other_originals_rewritten() {
    let connection = fresh_catalogue();
    for (layer, sha) in [("lyr-a", "sha-1"), ("lyr-b", "sha-2"), ("lyr-c", "sha-3")] {
        test_support::seed_published_item(
            &connection,
            layer,
            layer,
            RasterQuantity::GroundElevation.key(),
            "m",
            &[(sha, "tile.tif")],
        );
    }
    let scratch = crate::test_scratch::TestScratch::new("canopi-source-meta-unwritable");
    let paths = LidarPaths::open(&scratch).unwrap();
    for sha in ["sha-1", "sha-2", "sha-3"] {
        std::fs::create_dir_all(paths.source_dir(sha)).unwrap();
        std::fs::write(paths.source_original(sha), b"tif").unwrap();
    }
    // A directory where sha-2's meta.json belongs: publishing it fails
    // whoever runs the test, root included.
    std::fs::create_dir_all(paths.source_meta("sha-2")).unwrap();

    let error = refresh(&connection, &paths).unwrap_err();
    assert!(error.contains("sha-2"), "{error}");
    assert!(read(&paths.source_meta("sha-1")).is_some());
    assert!(
        read(&paths.source_meta("sha-3")).is_some(),
        "an original after the failing one is still rewritten"
    );
    std::fs::remove_dir_all(&scratch).unwrap();
}

/// Writing is atomic and idempotent, and a meta of another version is not
/// trusted.
#[test]
fn meta_round_trips_and_an_unknown_version_reads_as_absent() {
    let root = crate::test_scratch::TestScratch::new("canopi-source-meta");
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join(META_FILE);
    let meta = SourceMeta {
        version: META_VERSION,
        sha256: "abc".into(),
        original_filename: "a.tif".into(),
        size_bytes: 3,
        imported_at: "1".into(),
        items: Vec::new(),
    };
    assert!(write(&path, &meta).unwrap());
    assert!(
        !write(&path, &meta).unwrap(),
        "unchanged content is not rewritten"
    );
    assert_eq!(read(&path), Some(meta.clone()));
    assert!(!root.join("meta.json.tmp").exists());
    let newer = SourceMeta {
        version: META_VERSION + 1,
        ..meta
    };
    std::fs::write(&path, serde_json::to_string(&newer).unwrap()).unwrap();
    assert_eq!(read(&path), None);
    std::fs::remove_dir_all(root).unwrap();
}
