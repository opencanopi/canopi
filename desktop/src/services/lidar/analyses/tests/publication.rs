//! Publication and refresh: runs publish heads, refresh in place, and refuse
//! what no longer matches the library. No engine.

use super::*;

/// A run publishes every output's head and records the tool; a refresh keeps
/// the item ids, upserts the heads, revokes the superseded chunks and keeps
/// both runs in the processing history.
#[test]
fn a_refresh_updates_items_in_place_and_keeps_the_run_history() {
    let root = scratch_root("refresh");
    let library = LidarLibrary::open(&root).unwrap();
    let (source, _) = source_with_head(
        &library,
        "Ground",
        RasterQuantity::GroundElevation,
        CRS_PROJECTED_METRE,
    );
    let first = record(&library, &slope_request(&source, "degrees", Some("Steep")));
    let item_id = first.item_ids[0].clone();
    let first_generation =
        publish_fake(&library, &first.job_id, "digest-a", "geolibre-cli 1.5.3").unwrap();
    assert_first_run_published(&library, &first, &first_generation, &source);

    let refresh = library_rerun(&library, &first.definition_id);
    assert_eq!(refresh.definition_id, first.definition_id);
    assert_eq!(
        refresh.item_ids, first.item_ids,
        "a refresh keeps the item ids"
    );
    let refused =
        record_rerun(&library.catalogue().unwrap(), &first.definition_id, None).unwrap_err();
    assert!(refused.contains("already running"), "{refused}");
    // While the refresh runs, the published result stays Ready and the run
    // reports itself.
    let snapshot = library.library_snapshot().unwrap();
    let running = summary(&snapshot.items, &item_id);
    assert_eq!(running.state, LidarResultState::Ready);
    assert_eq!(
        running.run.as_ref().map(|run| run.state),
        Some(AnalysisJobState::Preparing)
    );
    let second_generation =
        publish_fake(&library, &refresh.job_id, "digest-b", "geolibre-cli 1.5.3").unwrap();
    assert_refresh_superseded(&library, &item_id, &first_generation, &second_generation);
    assert_history_newest_first(
        &library,
        &first.definition_id,
        [
            (refresh.job_id.as_str(), second_generation.as_str()),
            (first.job_id.as_str(), first_generation.as_str()),
        ],
    );
    drop(library);
    let _ = std::fs::remove_dir_all(root);
}

/// The first run's job completed with its tool, and its one output item reads
/// as a ready derived result over `source` with its provenance.
fn assert_first_run_published(
    library: &LidarLibrary,
    first: &AnalysisReceipt,
    first_generation: &str,
    source: &str,
) {
    let item_id = &first.item_ids[0];
    {
        let connection = library.catalogue().unwrap();
        let head = catalogue::derived_head(&connection, item_id)
            .unwrap()
            .unwrap();
        assert_eq!(head.id, first_generation);
        let job = catalogue::get_analysis_job(&connection, &first.job_id)
            .unwrap()
            .unwrap();
        assert_eq!(job.state, "complete");
        assert!(job.finished_at.is_some());
        let tool = parse_tool(job.tool_provenance.as_deref()).unwrap();
        assert_eq!(tool.tools, ["slope"]);
    }
    let snapshot = library.library_snapshot().unwrap();
    let published = summary(&snapshot.items, item_id);
    assert_eq!(published.role, LibraryItemRole::Derived);
    assert_eq!(published.state, LidarResultState::Ready);
    assert_eq!(published.name.as_deref(), Some("Steep"));
    assert_eq!(published.units, "°");
    assert_eq!(published.value_range, Some([1.0, 3.0]));
    let provenance = published.provenance.as_ref().unwrap();
    assert_eq!(provenance.analysis_id, "terrain.slope");
    assert_eq!(provenance.recipe_version, 1);
    assert_eq!(provenance.job_id, first.job_id);
    assert_eq!(provenance.inputs[0].item_id, source);
    assert_eq!(summary(&snapshot.items, source).dependents, 1);
}

/// The refresh's generation is the head; the superseded one's chunks are
/// revoked while its row stays for the history.
fn assert_refresh_superseded(
    library: &LidarLibrary,
    item_id: &str,
    first_generation: &str,
    second_generation: &str,
) {
    {
        let connection = library.catalogue().unwrap();
        assert_eq!(
            catalogue::derived_head(&connection, item_id)
                .unwrap()
                .unwrap()
                .id,
            second_generation
        );
    }
    assert_eq!(
        count(
            library,
            &format!(
                "SELECT COUNT(*) FROM lidar_generation_chunks WHERE generation_id = '{first_generation}'"
            )
        ),
        0,
        "the superseded generation's chunks are revoked"
    );
    assert_eq!(
        count(library, "SELECT COUNT(*) FROM lidar_derived_generations"),
        2,
        "the superseded generation row stays for the history"
    );
}

/// One history page holds both completed runs, newest first, each with the
/// generation it published: `(job id, generation id)` pairs.
fn assert_history_newest_first(
    library: &LidarLibrary,
    definition_id: &str,
    expected: [(&str, &str); 2],
) {
    let history = library.processing_history(definition_id, None).unwrap();
    assert_eq!(history.next_cursor, None);
    let runs: Vec<(&str, AnalysisJobState, &str)> = history
        .runs
        .iter()
        .map(|run| {
            (
                run.job_id.as_str(),
                run.state,
                run.outputs[0].generation_id.as_str(),
            )
        })
        .collect();
    let expected: Vec<(&str, AnalysisJobState, &str)> = expected
        .iter()
        .map(|(job, generation)| (*job, AnalysisJobState::Complete, *generation))
        .collect();
    assert_eq!(runs, expected);
    assert_eq!(history.runs[0].outputs[0].coverage_cells, Some(4));
}

/// A cancelled run and a job a restart interrupted keep no status text: the
/// state says what happened, and the UI words it in the user's language.
/// Only a failure's own reason is stored.
#[test]
fn a_cancelled_or_interrupted_job_keeps_no_status_text() {
    let root = scratch_root("status-text");
    let library = LidarLibrary::open(&root).unwrap();
    let (source, _) = source_with_head(
        &library,
        "Ground",
        RasterQuantity::GroundElevation,
        CRS_PROJECTED_METRE,
    );
    let cancelled = record(&library, &slope_request(&source, "degrees", None));
    library.cancel_job(&cancelled.job_id);
    let stopped = record(&library, &slope_request(&source, "percent", None));
    settle_unpublished(&library.catalogue().unwrap(), &stopped.job_id, "cancelled");
    record(
        &library,
        &slope_request(&source, "degrees", Some("Running")),
    );
    library
        .record_import_item(
            "Orchard",
            RasterQuantity::GroundElevation,
            None,
            false,
            &[root.join("orchard.tif")],
        )
        .unwrap();
    drop(library);
    let reopened = LidarLibrary::open(&root).unwrap();
    assert_eq!(
        count(
            &reopened,
            "SELECT COUNT(*) FROM lidar_analysis_jobs WHERE state IN ('cancelled', 'failed')"
        ),
        3
    );
    assert_eq!(
        count(
            &reopened,
            "SELECT COUNT(*) FROM lidar_import_jobs WHERE state = 'failed'"
        ),
        1
    );
    assert_eq!(
        count(
            &reopened,
            "SELECT (SELECT COUNT(*) FROM lidar_analysis_jobs WHERE message IS NOT NULL)
                  + (SELECT COUNT(*) FROM lidar_import_jobs WHERE message IS NOT NULL)"
        ),
        0
    );
    drop(reopened);
    let _ = std::fs::remove_dir_all(root);
}

/// A cancelled job, a moved input or a deleted item publishes nothing.
#[test]
fn publication_is_refused_when_the_run_no_longer_matches_the_library() {
    let root = scratch_root("publish-refusals");
    let library = LidarLibrary::open(&root).unwrap();
    let (source, _) = source_with_head(
        &library,
        "Ground",
        RasterQuantity::GroundElevation,
        CRS_PROJECTED_METRE,
    );
    let cancelled = record(&library, &slope_request(&source, "degrees", None));
    library.cancel_job(&cancelled.job_id);
    assert_eq!(
        publish_fake(&library, &cancelled.job_id, "digest-c", "v").unwrap_err(),
        "cancelled"
    );

    let moved = record(&library, &slope_request(&source, "degrees", None));
    {
        let connection = library.catalogue().unwrap();
        connection
            .execute(
                "INSERT INTO lidar_layer_generations
                 (id, layer_id, created_at, manifest_json, bounds_3857, crs_class)
                 VALUES ('gen-elsewhere', ?1, '1', '{}', '[0,0,1,1]', 'projected-metre')",
                [&source],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE lidar_layer_heads SET generation_id = 'gen-elsewhere' WHERE layer_id = ?1",
                [&source],
            )
            .unwrap();
    }
    let error = publish_fake(&library, &moved.job_id, "digest-m", "v").unwrap_err();
    assert!(error.contains("changed during the calculation"), "{error}");

    assert_eq!(
        count(&library, "SELECT COUNT(*) FROM lidar_derived_heads"),
        0
    );
    assert_eq!(
        count(
            &library,
            "SELECT COUNT(*) FROM lidar_generation_chunks WHERE state != 'published'"
        ),
        0,
        "refused runs leave no unpublished chunk rows"
    );
    drop(library);
    let _ = std::fs::remove_dir_all(root);
}

/// Rerun revalidates stored settings against the current recipe and pins the
/// inputs' current data; what can no longer run is refused by name.
#[test]
fn rerun_refuses_settings_the_recipe_no_longer_accepts_and_missing_inputs() {
    let root = scratch_root("rerun-refusals");
    let library = LidarLibrary::open(&root).unwrap();
    let (source, _) = source_with_head(
        &library,
        "Ground",
        RasterQuantity::GroundElevation,
        CRS_PROJECTED_METRE,
    );
    seed_published_slope(
        &library.catalogue().unwrap(),
        &source,
        "gen-old",
        "adef-a",
        "item-a",
        "dgen-a",
        None,
    );
    library
        .catalogue()
        .unwrap()
        .execute(
            "UPDATE lidar_analysis_definitions
             SET parameters_json = '[{\"key\":\"unit\",\"value\":{\"Choice\":\"radians\"}}]'",
            [],
        )
        .unwrap();
    let error = library.rerun_analysis("adef-a").unwrap_err();
    assert!(error.contains("no longer valid"), "{error}");
    library
        .catalogue()
        .unwrap()
        .execute(
            "UPDATE lidar_analysis_definitions
             SET parameters_json = '[{\"key\":\"unit\",\"value\":{\"Choice\":\"degrees\"}}]'",
            [],
        )
        .unwrap();
    library
        .catalogue()
        .unwrap()
        .execute("DELETE FROM lidar_layer_heads", [])
        .unwrap();
    let error = library.rerun_analysis("adef-a").unwrap_err();
    assert!(error.contains("no published data"), "{error}");
    let error = library.rerun_analysis("adef-missing").unwrap_err();
    assert!(error.contains("does not exist"), "{error}");
    assert_eq!(
        count(&library, "SELECT COUNT(*) FROM lidar_analysis_jobs"),
        1
    );
    drop(library);
    let _ = std::fs::remove_dir_all(root);
}

/// A job pinned to a recipe version this build does not run fails by name
/// before any input is read, and the published result stays.
#[test]
fn an_unknown_recipe_version_fails_by_name_and_keeps_the_result() {
    let root = scratch_root("unknown-recipe");
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
        "adef-f",
        "item-f",
        "dgen-f",
        None,
    );
    library
        .catalogue()
        .unwrap()
        .execute(
            "INSERT INTO lidar_analysis_jobs(id, definition_id, state, recipe_version,
                 input_generations_json, created_at, updated_at)
             VALUES('anl-future', 'adef-f', 'preparing', 7, '[]', '5', '5')",
            [],
        )
        .unwrap();
    let error = run_job(&library, "anl-future", &AtomicBool::new(false)).unwrap_err();
    assert!(error.contains("recipe version 7"), "{error}");
    assert_eq!(
        catalogue::derived_head(&library.catalogue().unwrap(), "item-f")
            .unwrap()
            .unwrap()
            .id,
        "dgen-f"
    );
    drop(library);
    let _ = std::fs::remove_dir_all(root);
}
