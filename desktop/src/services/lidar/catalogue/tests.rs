//! `catalogue.rs`'s own tests: the catalogue's SQL, its version and its generation rows.

use super::*;

#[test]
fn import_progress_is_monotonic_and_stops_with_the_job() {
    let dir = crate::test_scratch::TestScratch::new("canopi-import-progress-test");
    std::fs::create_dir_all(&dir).unwrap();
    let connection = open(&dir.join("catalogue.sqlite")).unwrap();
    connection
        .execute_batch(
            "INSERT INTO lidar_source_layers
                (id, name, item_kind, quantity, units, created_at)
             VALUES ('layer', 'Ground', 'raster', 'ground-elevation', 'm', '0');
             INSERT INTO lidar_import_jobs
                (id, layer_id, state, created_at, updated_at,
                 progress_phase, progress_percent)
             VALUES ('job', 'layer', 'applying', '0', '0',
                     'composing_layer', 0);",
        )
        .unwrap();

    assert!(update_import_progress(&connection, "job", "composing_layer", 10).unwrap());
    assert!(!update_import_progress(&connection, "job", "composing_layer", 9).unwrap());
    assert!(update_import_progress(&connection, "job", "rendering_map", 72).unwrap());
    let row = get_import_job(&connection, "job").unwrap().unwrap();
    assert_eq!(row.progress_phase.as_deref(), Some("rendering_map"));
    assert_eq!(row.progress_percent, Some(72));

    connection
        .execute(
            "UPDATE lidar_import_jobs SET state = 'complete', progress_percent = 100
             WHERE id = 'job'",
            [],
        )
        .unwrap();
    assert!(!update_import_progress(&connection, "job", "rendering_map", 80).unwrap());
    assert_eq!(
        get_import_job(&connection, "job")
            .unwrap()
            .unwrap()
            .progress_percent,
        Some(100)
    );

    drop(connection);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_fresh_catalogue_records_the_current_version() {
    let root = crate::test_scratch::TestScratch::new("canopi-catalogue-fresh");
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("lidar-library.sqlite");
    assert_eq!(stored_version(&path).unwrap(), None);
    drop(open(&path).unwrap());
    assert_eq!(stored_version(&path).unwrap(), Some(CATALOGUE_VERSION));
    // Reopening a current catalogue is a no-op.
    drop(open(&path).unwrap());
    assert_eq!(stored_version(&path).unwrap(), Some(CATALOGUE_VERSION));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn unpublished_chunk_rows_are_invisible_until_the_generation_publishes() {
    let root = crate::test_scratch::TestScratch::new("canopi-chunks");
    std::fs::create_dir_all(&root).unwrap();
    let connection = open(&root.join("lidar-library.sqlite")).unwrap();
    connection
        .execute(
            "INSERT INTO lidar_raster_assets(
                sha256, rel_path, bytes, profile, width, height, geotransform, crs_ref, nodata, created_at)
             VALUES('sha-chunk', 'assets/sha-chunk/cog.tif', 8, 'cog-f32-t256-raw-v1',
                1024, 1024, '[0,1,0,0,0,-1]', 'EPSG:3857', NULL, '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
    let rows = vec![GenerationChunkRow {
        role: "resolved".to_string(),
        chunk_x: 0,
        chunk_y: 0,
        asset_sha256: "sha-chunk".to_string(),
        valid_cells: 12,
        min_value: 1.0,
        max_value: 3.0,
        sum_value: 24.0,
    }];
    insert_unpublished_chunks(&connection, "gen-1", &rows).unwrap();
    assert!(
        generation_chunk_page(&connection, "gen-1", "resolved", None, None, 10)
            .unwrap()
            .is_empty(),
        "an unpublished generation exposes no chunk rows"
    );
    let published = publish_generation_chunks(&connection, "gen-1").unwrap();
    assert_eq!(published, 1);
    let page = generation_chunk_page(&connection, "gen-1", "resolved", None, None, 10).unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].asset.sha256, "sha-chunk");
    assert_eq!(page[0].aggregate_sum_value, 24.0);
    // A result role keeps its own rows.
    assert!(
        generation_chunk_page(&connection, "gen-1", "quality", None, None, 10)
            .unwrap()
            .is_empty()
    );
    drop(connection);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn chunk_pages_order_by_position_and_filter_spatially_in_sql() {
    let root = crate::test_scratch::TestScratch::new("canopi-chunk-pages");
    std::fs::create_dir_all(&root).unwrap();
    let connection = open(&root.join("catalogue.sqlite")).unwrap();
    connection
        .execute(
            "INSERT INTO lidar_raster_assets(
                sha256, rel_path, bytes, profile, width, height, geotransform, crs_ref, nodata, created_at)
             VALUES('sha-page', 'assets/sha-page/cog.tif', 8, 'cog-f32-t256-raw-v1',
                1024, 1024, '[0,1,0,0,0,-1]', 'EPSG:3857', NULL, '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
    // Four records: two rows of two columns, plus a distant record that no
    // small window may return.
    let rows: Vec<GenerationChunkRow> = [(0, 0), (1, 0), (0, 1), (1, 1), (7, 2)]
        .into_iter()
        .map(|(chunk_x, chunk_y)| GenerationChunkRow {
            role: "resolved".to_string(),
            chunk_x,
            chunk_y,
            asset_sha256: "sha-page".to_string(),
            valid_cells: 1,
            min_value: 1.0,
            max_value: 1.0,
            sum_value: 1.0,
        })
        .collect();
    insert_unpublished_chunks(&connection, "gen-1", &rows).unwrap();
    publish_generation_chunks(&connection, "gen-1").unwrap();

    // Keyset pages of two: stable position order, no repeat and no gap.
    let first = generation_chunk_page(&connection, "gen-1", "resolved", None, None, 2).unwrap();
    let cursor = first
        .last()
        .map(|row| (row.chunk_y, row.chunk_x))
        .expect("first page has rows");
    assert_eq!(
        first
            .iter()
            .map(|row| (row.chunk_y, row.chunk_x))
            .collect::<Vec<_>>(),
        vec![(0, 0), (0, 1)]
    );
    let second =
        generation_chunk_page(&connection, "gen-1", "resolved", None, Some(cursor), 2).unwrap();
    assert_eq!(
        second
            .iter()
            .map(|row| (row.chunk_y, row.chunk_x))
            .collect::<Vec<_>>(),
        vec![(1, 0), (1, 1)]
    );
    let third = generation_chunk_page(
        &connection,
        "gen-1",
        "resolved",
        None,
        second.last().map(|row| (row.chunk_y, row.chunk_x)),
        2,
    )
    .unwrap();
    assert_eq!(
        third
            .iter()
            .map(|row| (row.chunk_y, row.chunk_x))
            .collect::<Vec<_>>(),
        vec![(2, 7)]
    );

    // A window filter runs before rows load: chunk 0 covers cells 0..1024.
    let window = ChunkWindow::for_cells(0, 1024, 0, 2048, 1024).unwrap();
    assert_eq!(
        (window.min_x, window.max_x, window.min_y, window.max_y),
        (0, 0, 0, 1)
    );
    let filtered =
        generation_chunk_page(&connection, "gen-1", "resolved", Some(window), None, 10).unwrap();
    assert_eq!(
        filtered
            .iter()
            .map(|row| (row.chunk_y, row.chunk_x))
            .collect::<Vec<_>>(),
        vec![(0, 0), (1, 0)],
        "only intersecting records load"
    );
    // Negative coordinates stay exact: cells -1..0 touch chunk -1 only.
    let negative = ChunkWindow::for_cells(-1, 0, 0, 1, 1024).unwrap();
    assert_eq!(
        (
            negative.min_x,
            negative.max_x,
            negative.min_y,
            negative.max_y
        ),
        (-1, -1, 0, 0)
    );
    assert!(
        generation_chunk_page(&connection, "gen-1", "resolved", Some(negative), None, 10)
            .unwrap()
            .is_empty()
    );
    // The index carries the read order, so paging needs no sort step.
    let plan: String = connection
        .query_row(
            "EXPLAIN QUERY PLAN SELECT g.chunk_x, g.chunk_y
             FROM lidar_generation_chunks g
             WHERE g.generation_id = 'gen-1' AND g.role = 'resolved'
               AND g.state = 'published'
             ORDER BY g.chunk_y, g.chunk_x LIMIT 2",
            [],
            |row| row.get(3),
        )
        .unwrap();
    assert!(
        !plan.contains("TEMP B-TREE"),
        "the paged read order must come from the index: {plan}"
    );
    drop(connection);
    let _ = std::fs::remove_dir_all(root);
}
