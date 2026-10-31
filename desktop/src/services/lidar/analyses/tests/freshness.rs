//! Freshness and the read model: stale reasons, unpublished runs and the
//! processing history. No engine.

use super::*;

/// Stale reasons name what changed: an input's head, the recipe, the tool, or
/// an input that is itself stale.
#[test]
fn stale_reasons_name_what_changed() {
    let root = scratch_root("stale");
    let library = LidarLibrary::open(&root).unwrap();
    let (source, generation) = source_with_head(
        &library,
        "Ground",
        RasterQuantity::GroundElevation,
        CRS_PROJECTED_METRE,
    );
    let connection = library.catalogue().unwrap();
    seed_published_slope(
        &connection,
        &source,
        &generation,
        "adef-c",
        "item-c",
        "dgen-c",
        None,
    );
    seed_published_slope(
        &connection,
        &source,
        "gen-before",
        "adef-i",
        "item-i",
        "dgen-i",
        None,
    );
    seed_published_slope(
        &connection,
        &source,
        &generation,
        "adef-r",
        "item-r",
        "dgen-r",
        None,
    );
    connection
        .execute(
            "UPDATE lidar_analysis_jobs SET recipe_version = 0 WHERE definition_id = 'adef-r'",
            [],
        )
        .unwrap();
    // A result calculated from a stale result (a chain), pinned to its
    // current head.
    seed_published_slope(
        &connection,
        "item-i",
        "dgen-i",
        "adef-t",
        "item-t",
        "dgen-t",
        None,
    );

    let same_tool = installed("geolibre-cli 1.5.3");
    let mut check = FreshnessCheck::new(&connection, &same_tool);
    assert_eq!(check.of("item-c").unwrap(), Freshness::Current);
    assert_eq!(check.of(&source).unwrap(), Freshness::Current);
    assert_eq!(
        check.of("item-i").unwrap(),
        Freshness::Stale {
            reasons: vec![StaleReason::InputUpdated {
                input_key: "dem".to_string(),
                item_id: source.clone(),
            }]
        }
    );
    assert_eq!(
        check.of("item-r").unwrap(),
        Freshness::Stale {
            reasons: vec![StaleReason::RecipeUpdated { from: 0, to: 1 }]
        }
    );
    assert_eq!(
        check.of("item-t").unwrap(),
        Freshness::Stale {
            reasons: vec![StaleReason::InputStale {
                input_key: "dem".to_string(),
                item_id: "item-i".to_string(),
            }]
        }
    );

    let newer = installed("geolibre-cli 1.6.0");
    let mut check = FreshnessCheck::new(&connection, &newer);
    assert_eq!(
        check.of("item-c").unwrap(),
        Freshness::Stale {
            reasons: vec![StaleReason::ToolUpdated {
                from: "geolibre-cli 1.5.3 (aac2b743978)".to_string(),
                to: "geolibre-cli 1.6.0 (aac2b743978)".to_string(),
            }]
        }
    );
    // Without an engine nothing claims the tool changed.
    let mut check = FreshnessCheck::new(&connection, &Err("missing".to_string()));
    assert_eq!(check.of("item-c").unwrap(), Freshness::Current);
    drop(connection);
    drop(library);
    let _ = std::fs::remove_dir_all(root);
}

/// A run without a result is its operation: preparing while it runs, failed
/// with its reason otherwise, described by the inputs it was pinned to.
#[test]
fn the_snapshot_describes_an_unpublished_run_by_its_pinned_inputs() {
    let root = scratch_root("read-model");
    let library = LidarLibrary::open(&root).unwrap();
    let (source, generation) = source_with_head(
        &library,
        "Ground",
        RasterQuantity::GroundElevation,
        CRS_PROJECTED_METRE,
    );
    let receipt = record(&library, &slope_request(&source, "percent", None));
    let snapshot = library.library_snapshot().unwrap();
    let pending = summary(&snapshot.items, &receipt.item_ids[0]);
    assert_eq!(pending.state, LidarResultState::Preparing);
    assert_eq!(pending.generation_id, None);
    assert_eq!(
        pending.name, None,
        "an unnamed result is never given a name"
    );
    let provenance = pending.provenance.as_ref().unwrap();
    assert_eq!(provenance.inputs[0].generation_id, generation);
    assert_eq!(provenance.tool, None);
    assert_eq!(pending.freshness, Freshness::Current);
    assert!(pending.offers.iter().all(|offer| matches!(
        offer.unavailable,
        Some(AnalysisUnavailable::WrongInput { .. })
    )));

    settle_unpublished(
        &library.catalogue().unwrap(),
        &receipt.job_id,
        "engine stopped",
    );
    let snapshot = library.library_snapshot().unwrap();
    let failed = summary(&snapshot.items, &receipt.item_ids[0]);
    assert_eq!(failed.state, LidarResultState::Failed);
    let run = failed.run.as_ref().unwrap();
    assert_eq!(run.state, AnalysisJobState::Failed);
    assert_eq!(run.message.as_deref(), Some("engine stopped"));

    // Retry is a rerun of the same definition with the same items.
    let retry = library_rerun(&library, &receipt.definition_id);
    assert_eq!(retry.item_ids, receipt.item_ids);
    settle_unpublished(&library.catalogue().unwrap(), &retry.job_id, "cancelled");
    let snapshot = library.library_snapshot().unwrap();
    assert_eq!(
        summary(&snapshot.items, &receipt.item_ids[0])
            .run
            .as_ref()
            .map(|run| run.state),
        Some(AnalysisJobState::Cancelled)
    );
    drop(library);
    let _ = std::fs::remove_dir_all(root);
}

/// History pages are bounded, newest first, and a cursor continues exactly.
#[test]
fn processing_history_pages_newest_first() {
    let root = scratch_root("history");
    let library = LidarLibrary::open(&root).unwrap();
    let (source, generation) = source_with_head(
        &library,
        "Ground",
        RasterQuantity::GroundElevation,
        CRS_PROJECTED_METRE,
    );
    seed_published_slope(
        &library.catalogue().unwrap(),
        &source,
        &generation,
        "adef-h",
        "item-h",
        "dgen-h",
        None,
    );
    {
        let connection = library.catalogue().unwrap();
        for index in 0..55 {
            connection
                .execute(
                    "INSERT INTO lidar_analysis_jobs(id, definition_id, state, message,
                         recipe_version, input_generations_json, created_at, updated_at)
                     VALUES(?1, 'adef-h', 'failed', 'stopped', 1, '[]', ?2, ?2)",
                    rusqlite::params![format!("anl-{index:02}"), format!("{}", 100 + index)],
                )
                .unwrap();
        }
    }
    let first = library.processing_history("adef-h", None).unwrap();
    assert_eq!(first.runs.len(), 50);
    assert_eq!(first.runs[0].job_id, "anl-54");
    let cursor = first.next_cursor.clone().expect("another page");
    let second = library.processing_history("adef-h", Some(&cursor)).unwrap();
    let ids: Vec<&str> = second.runs.iter().map(|run| run.job_id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "anl-04",
            "anl-03",
            "anl-02",
            "anl-01",
            "anl-00",
            "adef-h-job"
        ]
    );
    assert_eq!(second.next_cursor, None);
    assert_eq!(second.runs[5].outputs[0].generation_id, "dgen-h");
    assert!(
        library
            .processing_history("adef-h", Some("garbage"))
            .is_err()
    );
    assert!(library.processing_history("adef-missing", None).is_err());
    drop(library);
    let _ = std::fs::remove_dir_all(root);
}
