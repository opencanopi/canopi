//! Acceptance runs: head changes during sampling, failed refreshes and the
//! rerun command with saved identity.

use super::*;

/// The sampler never answers from a generation the caller did not aim at, even
/// when the head moves while the values are being read.
#[test]
fn acceptance_sampling_rejects_head_changes_during_value_and_nodata_reads() {
    for mode in ["value", "hole", "early-nodata"] {
        let root = scratch_root(&format!("acceptance-inspect-{mode}"));
        let library = LidarLibrary::open(&root).unwrap();
        let layer = plane_layer(&library, &root, 16, 16);
        let old = catalogue::head_generation(&library.catalogue().unwrap(), &layer)
            .unwrap()
            .unwrap();
        publish_source(&library, &layer, &root.join("plane.tif"));
        let new = catalogue::head_generation(&library.catalogue().unwrap(), &layer)
            .unwrap()
            .unwrap();
        assert_ne!(old.id, new.id);
        {
            let connection = library.catalogue().unwrap();
            connection
                .execute(
                    "UPDATE lidar_layer_heads SET generation_id = ?1 WHERE layer_id = ?2",
                    rusqlite::params![old.id, layer],
                )
                .unwrap();
            if mode == "early-nodata" {
                let mut manifest = read_generation_manifest(&old.manifest_json).unwrap();
                // A finite point cannot be represented as an i64 lattice index.
                manifest.grid.geotransform[0] = 1.0e30;
                connection
                    .execute(
                        "UPDATE lidar_layer_generations SET manifest_json = ?1 WHERE id = ?2",
                        rusqlite::params![serde_json::to_string(&manifest).unwrap(), old.id],
                    )
                    .unwrap();
            }
        }
        let (x, y) = if mode == "hole" {
            (8.5, 9.5)
        } else {
            (5.5, 10.5)
        };
        let aimed = target(LibraryItemRole::Source, &layer, &old.id);
        let request = || sample(&library, vec![aimed.clone()], vec![point(x, y)]);
        let healthy = values(&request()[0]);
        if mode == "value" {
            assert_eq!(healthy, vec![Some(5.0)]);
        } else {
            assert_eq!(healthy, vec![None]);
        }
        let reached = std::rc::Rc::new(std::cell::Cell::new(false));
        let observed = reached.clone();
        let change = Box::new(move |library: &LidarLibrary| {
            observed.set(true);
            library
                .catalogue()
                .unwrap()
                .execute(
                    "UPDATE lidar_layer_heads SET generation_id = ?1 WHERE layer_id = ?2",
                    rusqlite::params![new.id, layer],
                )
                .unwrap();
        });
        let guard = if mode == "early-nodata" {
            acceptance_hooks::on_target(change)
        } else {
            acceptance_hooks::on_read(change)
        };
        let raced = request();
        assert!(reached.get(), "the fault boundary must be exercised");
        assert_eq!(
            raced,
            vec![unavailable(LidarSampleUnavailableReason::StaleGeneration)],
            "{mode}"
        );
        drop(guard);
        drop(library);
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// A refresh that fails mid-write keeps the published result and its bytes;
/// running the job again without the fault refreshes the same item in place.
#[test]
#[ignore = "requires the pinned GeoLibre CLI; generated two-block plane, no private fixtures"]
fn acceptance_a_failed_refresh_keeps_the_published_result() {
    for fault in ["capacity", "write"] {
        let root = scratch_root(&format!("acceptance-midwrite-{fault}"));
        let library = LidarLibrary::open(&root).unwrap();
        // Two occupied chunks; the fault happens after the first has output.
        let layer = plane_layer(&library, &root, 1030, 16);
        let first = run_slope(&library, &layer, "degrees", None);
        let item_id = first.item_ids[0].clone();
        let head = catalogue::derived_head(&library.catalogue().unwrap(), &item_id)
            .unwrap()
            .unwrap();
        let mut accepted_bytes = Vec::new();
        files(&root.join("lidar/assets"), &mut accepted_bytes);
        assert!(!accepted_bytes.is_empty());

        let refresh = library_rerun(&library, &first.definition_id);
        let reached = std::rc::Rc::new(std::cell::Cell::new(false));
        let observed = reached.clone();
        let guard = acceptance_hooks::on_block(Box::new(move |scratch, has_output| {
            assert!(has_output, "the fault must follow completed output");
            observed.set(true);
            if fault == "capacity" {
                paths::capacity_probe::set(Some(0));
            } else {
                // A real filesystem create failure in the next window.
                std::fs::create_dir(scratch.join("window-1-0.raw")).unwrap();
            }
        }));
        let error = run_job(&library, &refresh.job_id, &AtomicBool::new(false))
            .expect_err("a mid-write fault aborts");
        assert!(reached.get());
        if fault == "capacity" {
            assert!(error.contains("free"), "{error}");
        } else {
            assert!(error.contains("Failed to create raw buffer"), "{error}");
        }
        drop(guard);
        let after = catalogue::derived_head(&library.catalogue().unwrap(), &item_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            after.id, head.id,
            "a failed refresh keeps the published head"
        );
        for (path, bytes) in &accepted_bytes {
            assert_eq!(&std::fs::read(path).unwrap(), bytes);
        }
        assert!(
            !library
                .inner
                .paths
                .analysis_scratch_dir(&refresh.job_id)
                .exists()
        );

        let outcome = run_job(&library, &refresh.job_id, &AtomicBool::new(false)).unwrap();
        assert!(outcome.coverage_cells > 0, "{}", outcome.summary());
        let next = catalogue::derived_head(&library.catalogue().unwrap(), &item_id)
            .unwrap()
            .unwrap();
        assert_ne!(next.id, head.id, "the refresh replaced the head in place");
        drop(library);
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Through the real commands: create two results, refresh one in place, and
/// retry a failed run with its saved identity.
#[test]
#[ignore = "requires the pinned GeoLibre CLI; real published plane and Tauri-managed command state"]
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn acceptance_rerun_command_refreshes_in_place_and_retries_with_saved_identity() {
    use crate::native_operation::NativeOperationExecutor;
    use tauri::Manager;

    fn await_job(library: &LidarLibrary, job: &str) -> String {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let state: String = library
                .catalogue()
                .unwrap()
                .query_row(
                    "SELECT state FROM lidar_analysis_jobs WHERE id = ?1",
                    [job],
                    |row| row.get(0),
                )
                .unwrap();
            if state != "preparing" && !library.inner.cancel_flags.lock().unwrap().contains_key(job)
            {
                return state;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "job {job} did not settle"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    let root = scratch_root("acceptance-rerun-command");
    let library = LidarLibrary::open(&root).unwrap();
    let executor = NativeOperationExecutor::production();
    library.attach_executor(executor.clone());
    let app = tauri::test::mock_builder()
        .manage(library.clone())
        .manage(executor)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let layer = plane_layer(&library, &root, 16, 16);
    let create = |unit: &str, name: &str| {
        tauri::async_runtime::block_on(crate::commands::lidar::lidar_create_analysis(
            app.state(),
            app.state(),
            slope_request(&layer, unit, Some(name)),
        ))
        .unwrap()
    };
    let rerun = |definition: &str| {
        tauri::async_runtime::block_on(crate::commands::lidar::lidar_rerun_analysis(
            app.state(),
            app.state(),
            definition.to_string(),
        ))
    };
    let north = create("degrees", "North slope");
    let south = create("percent", "South slope");
    assert_eq!(await_job(&library, &north.job_id), "complete");
    assert_eq!(await_job(&library, &south.job_id), "complete");
    let head = |item: &str| {
        catalogue::derived_head(&library.catalogue().unwrap(), item)
            .unwrap()
            .unwrap()
            .id
    };
    let north_first = head(&north.item_ids[0]);
    let south_first = head(&south.item_ids[0]);
    let read = values(
        &sample(
            &library,
            vec![target(
                LibraryItemRole::Derived,
                &south.item_ids[0],
                &south_first,
            )],
            vec![point(5.5, 10.5)],
        )[0],
    );
    assert!(
        matches!(read[0], Some(value) if (value - 100.0).abs() < 0.01),
        "{read:?}"
    );

    // Refresh updates the item in place; the other result is untouched.
    let refreshed = rerun(&south.definition_id).unwrap();
    assert_eq!(refreshed.item_ids, south.item_ids);
    assert_eq!(await_job(&library, &refreshed.job_id), "complete");
    assert_ne!(head(&south.item_ids[0]), south_first);
    assert_eq!(head(&north.item_ids[0]), north_first);
    let snapshot = library.library_snapshot().unwrap();
    let south_item = summary(&snapshot.items, &south.item_ids[0]);
    assert_eq!(south_item.name.as_deref(), Some("South slope"));
    assert_eq!(south_item.units, "%");
    let history = library
        .processing_history(&south.definition_id, None)
        .unwrap();
    assert_eq!(
        history.runs.len(),
        2,
        "the earlier run stays in the history"
    );

    // A failed run retries through the same command with its saved identity.
    library
        .catalogue()
        .unwrap()
        .execute(
            "UPDATE lidar_analysis_jobs SET state = 'failed', message = 'engine stopped'
             WHERE id = ?1",
            [&north.job_id],
        )
        .unwrap();
    let retried = rerun(&north.definition_id).unwrap();
    assert_eq!(retried.item_ids, north.item_ids);
    assert_eq!(await_job(&library, &retried.job_id), "complete");
    drop(app);
    drop(library);
    std::fs::remove_dir_all(root).unwrap();
}
