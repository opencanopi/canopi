//! The batched sampler over Rust-engine fixtures: mixed targets, unreadable
//! chunks, concurrency and analytic planes.

use super::*;

/// One request answers mixed targets in target order: a source and a result
/// read their own cells, a head that moved answers stale and an absent item
/// missing, and a point off a target's data reads `None` for that target only.
#[test]
fn one_batch_answers_mixed_targets_in_order() {
    let root = scratch_root("batch-mixed");
    let library = LidarLibrary::open(&root).unwrap();
    let plane = plane_layer(&library, &root, 16, 16);
    let plane_generation = source_head(&library, &plane);
    let result = chunk_result(&library, &plane, "item-chunks");
    // The result's lattice starts at (0, 0) with 1 m cells running south.
    let cells: Vec<f32> = (0..16).map(|index| 100.0 + index as f32).collect();
    generation::publish_test_chunk(&library, &result, 0, 0, 4, 4, &cells);

    let series = sample(
        &library,
        vec![
            target(LibraryItemRole::Source, &plane, &plane_generation),
            target(LibraryItemRole::Derived, "item-chunks", &result),
            target(LibraryItemRole::Source, &plane, "gen-before"),
            target(LibraryItemRole::Derived, "item-gone", "dgen-gone"),
        ],
        vec![point(5.5, 10.5), point(1.5, -2.5), point(500.5, 500.5)],
    );
    assert_eq!(series.len(), 4);
    assert_eq!(values(&series[0]), vec![Some(5.0), None, None]);
    // Cell (1, 2) of the 4 × 4 chunk.
    assert_eq!(values(&series[1]), vec![None, Some(109.0), None]);
    assert_eq!(
        series[2],
        unavailable(LidarSampleUnavailableReason::StaleGeneration)
    );
    assert_eq!(
        series[3],
        unavailable(LidarSampleUnavailableReason::MissingGeneration)
    );
}

/// A target that cannot be read answers `Unavailable` on its own row instead of
/// failing the batch: a result whose chunk file is corrupt on disk and one whose
/// CRS the engine rejects sit between healthy targets that still read values.
#[test]
fn an_unreadable_target_answers_unavailable_and_the_batch_still_reads() {
    let root = scratch_root("batch-unreadable");
    let library = LidarLibrary::open(&root).unwrap();
    let plane = plane_layer(&library, &root, 16, 16);
    let plane_generation = source_head(&library, &plane);
    let healthy = chunk_result(&library, &plane, "item-healthy");
    let cells: Vec<f32> = (0..16).map(|index| 100.0 + index as f32).collect();
    generation::publish_test_chunk(&library, &healthy, 0, 0, 4, 4, &cells);
    let corrupt = chunk_result(&library, &plane, "item-corrupt");
    // Other values than the healthy chunk's, since chunk files are content addressed.
    let other: Vec<f32> = cells.iter().map(|value| value + 1.0).collect();
    let asset = generation::publish_test_chunk(&library, &corrupt, 0, 0, 4, 4, &other);
    std::fs::write(&asset.path, b"not a tiff").unwrap();
    let foreign = chunk_result(&library, &plane, "item-foreign-crs");
    library
        .catalogue()
        .unwrap()
        .execute(
            "UPDATE lidar_derived_generations SET manifest_json = replace(manifest_json, 'EPSG:32631', 'not-a-crs') WHERE id = ?1",
            [&foreign],
        )
        .unwrap();

    let series = sample(
        &library,
        vec![
            target(LibraryItemRole::Source, &plane, &plane_generation),
            target(LibraryItemRole::Derived, "item-corrupt", &corrupt),
            target(LibraryItemRole::Derived, "item-foreign-crs", &foreign),
            target(LibraryItemRole::Derived, "item-healthy", &healthy),
        ],
        vec![point(5.5, 10.5), point(1.5, -2.5)],
    );
    assert_eq!(values(&series[0]), vec![Some(5.0), None]);
    assert_eq!(
        series[1],
        unavailable(LidarSampleUnavailableReason::ReadFailed)
    );
    assert_eq!(
        series[2],
        unavailable(LidarSampleUnavailableReason::TransformFailed)
    );
    assert_eq!(values(&series[3]), vec![None, Some(109.0)]);
}

/// Row values re-sample on every pointer move, so a target that stays
/// unreadable is reported once per generation, not once per request.
#[test]
fn an_unreadable_target_is_reported_once_however_often_it_is_sampled() {
    let root = scratch_root("batch-reported-once");
    let library = LidarLibrary::open(&root).unwrap();
    let plane = plane_layer(&library, &root, 16, 16);
    let corrupt = chunk_result(&library, &plane, "item-corrupt-once");
    let cells: Vec<f32> = (0..16).map(|index| 300.0 + index as f32).collect();
    let asset = generation::publish_test_chunk(&library, &corrupt, 0, 0, 4, 4, &cells);
    std::fs::write(&asset.path, b"not a tiff").unwrap();
    let aimed = target(LibraryItemRole::Derived, "item-corrupt-once", &corrupt);

    let written = warnings_during(|| {
        for column in 0..4 {
            let series = sample(
                &library,
                vec![aimed.clone()],
                vec![point(f64::from(column) + 0.5, -1.5)],
            );
            assert_eq!(
                series[0],
                unavailable(LidarSampleUnavailableReason::ReadFailed)
            );
        }
    });
    assert_eq!(
        written
            .matches("a LiDAR sample target could not be read")
            .count(),
        1,
        "{written}"
    );
}

/// A chunk file the app may not open answers `ReadFailed`, so the profile
/// offers Retry, and the log names the real cause instead of "missing".
/// Root ignores mode bits, so the test skips itself when the file still opens.
#[cfg(unix)]
#[test]
fn a_chunk_the_app_may_not_open_answers_read_failed_and_logs_the_cause() {
    use std::os::unix::fs::PermissionsExt;
    let root = scratch_root("batch-permission-denied");
    let library = LidarLibrary::open(&root).unwrap();
    let plane = plane_layer(&library, &root, 16, 16);
    let locked = chunk_result(&library, &plane, "item-locked");
    let cells: Vec<f32> = (0..16).map(|index| 500.0 + index as f32).collect();
    let asset = generation::publish_test_chunk(&library, &locked, 0, 0, 4, 4, &cells);
    std::fs::set_permissions(&asset.path, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::File::open(&asset.path).is_ok() {
        std::fs::set_permissions(&asset.path, std::fs::Permissions::from_mode(0o644)).unwrap();
        eprintln!("skipped: mode bits do not stop this user (root)");
        return;
    }
    let aimed = target(LibraryItemRole::Derived, "item-locked", &locked);

    let written = warnings_during(|| {
        let series = sample(&library, vec![aimed.clone()], vec![point(0.5, -0.5)]);
        assert_eq!(
            series[0],
            unavailable(LidarSampleUnavailableReason::ReadFailed)
        );
    });
    std::fs::set_permissions(&asset.path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(written.contains("cannot open prepared raster"), "{written}");
    assert!(written.contains("Permission denied"), "{written}");
    assert!(!written.contains("missing"), "{written}");
}

/// A chunk file that is gone answers `ReadFailed` and the log says it is missing.
#[test]
fn a_chunk_that_is_gone_answers_read_failed_and_logs_missing() {
    let root = scratch_root("batch-chunk-gone");
    let library = LidarLibrary::open(&root).unwrap();
    let plane = plane_layer(&library, &root, 16, 16);
    let gone = chunk_result(&library, &plane, "item-gone");
    let cells: Vec<f32> = (0..16).map(|index| 700.0 + index as f32).collect();
    let asset = generation::publish_test_chunk(&library, &gone, 0, 0, 4, 4, &cells);
    std::fs::remove_file(&asset.path).unwrap();
    let aimed = target(LibraryItemRole::Derived, "item-gone", &gone);

    let written = warnings_during(|| {
        let series = sample(&library, vec![aimed.clone()], vec![point(0.5, -0.5)]);
        assert_eq!(
            series[0],
            unavailable(LidarSampleUnavailableReason::ReadFailed)
        );
    });
    assert!(written.contains("prepared raster is missing"), "{written}");
}

/// N points in one request equal N one-point requests and the analytic plane:
/// the cell's column inside the plane, `None` in its NoData hole, outside it
/// and at a point that is not a number.
#[test]
fn n_points_equal_n_single_samples_and_the_analytic_plane() {
    let root = scratch_root("batch-single");
    let library = LidarLibrary::open(&root).unwrap();
    let plane = plane_layer(&library, &root, 16, 16);
    let aimed = target(
        LibraryItemRole::Source,
        &plane,
        &source_head(&library, &plane),
    );
    let mut points = Vec::new();
    let mut expected = Vec::new();
    for row in -1..17 {
        for column in -1..17 {
            points.push(point(f64::from(column) + 0.5, 16.0 - f64::from(row) - 0.5));
            let inside = (0..16).contains(&column) && (0..16).contains(&row);
            let hole = (8..10).contains(&column) && (6..8).contains(&row);
            expected.push((inside && !hole).then_some(f64::from(column)));
        }
    }
    points.push([f64::NAN, 0.0]);
    expected.push(None);

    let batch = values(&sample(&library, vec![aimed.clone()], points.clone())[0]);
    assert_eq!(batch, expected);
    let singles: Vec<Option<f64>> = points
        .iter()
        .map(|single| values(&sample(&library, vec![aimed.clone()], vec![*single])[0])[0])
        .collect();
    assert_eq!(singles, batch);
}

/// The backend serialises sampling (architecture review finding 3): three
/// concurrent `lidar_sample_points` calls through the real command and
/// executor take at most one of Local's two running slots, so a save on Local
/// is admitted and runs while sampling is held, and every call then answers.
#[test]
fn concurrent_samples_take_one_local_slot_and_a_save_still_runs() {
    use crate::native_operation::{NativeOperationClass, NativeOperationExecutor};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::{Duration, Instant};
    use tauri::Manager;

    let root = scratch_root("sampling-turn");
    let library = LidarLibrary::open(&root).unwrap();
    let plane = plane_layer(&library, &root, 16, 16);
    let aimed = target(
        LibraryItemRole::Source,
        &plane,
        &source_head(&library, &plane),
    );
    let executor = NativeOperationExecutor::production();
    let app = tauri::test::mock_builder()
        .manage(library.clone())
        .manage(executor.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();

    let running = Arc::new(AtomicUsize::new(0));
    let most = Arc::new(AtomicUsize::new(0));
    let released = Arc::new((Mutex::new(false), Condvar::new()));
    let _gate = acceptance_hooks::on_sample_work(&library, {
        let (running, most, released) = (running.clone(), most.clone(), released.clone());
        Arc::new(move || {
            let now = running.fetch_add(1, Ordering::SeqCst) + 1;
            most.fetch_max(now, Ordering::SeqCst);
            let (lock, wake) = &*released;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = wake.wait(open).unwrap();
            }
            running.fetch_sub(1, Ordering::SeqCst);
        })
    });
    let calls: Vec<_> = (0..3)
        .map(|_| {
            let handle = app.handle().clone();
            let request = LidarSamplePointsRequest {
                targets: vec![aimed.clone()],
                points: vec![point(5.5, 10.5)],
            };
            std::thread::spawn(move || {
                tauri::async_runtime::block_on(crate::commands::lidar::lidar_sample_points(
                    handle.state(),
                    handle.state(),
                    request,
                ))
            })
        })
        .collect();
    let deadline = Instant::now() + Duration::from_secs(10);
    while running.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < deadline, "no sampling work started");
        std::thread::sleep(Duration::from_millis(5));
    }
    // Give a second sampler every chance to start beside the first.
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(running.load(Ordering::SeqCst), 1);

    let (saved, save_done) = std::sync::mpsc::channel();
    let save_executor = executor.clone();
    std::thread::spawn(move || {
        saved
            .send(tauri::async_runtime::block_on(save_executor.run(
                NativeOperationClass::Local,
                "design save",
                || Ok(7),
            )))
            .unwrap();
    });
    let save = save_done.recv_timeout(Duration::from_secs(5));

    {
        let (lock, wake) = &*released;
        *lock.lock().unwrap() = true;
        wake.notify_all();
    }
    assert_eq!(save, Ok(Ok(7)), "a save runs while sampling is held");
    for call in calls {
        let series = call.join().unwrap().expect("each sample answers");
        assert_eq!(values(&series[0]), vec![Some(5.0)]);
    }
    assert_eq!(most.load(Ordering::SeqCst), 1);
}

/// Raster work never stalls sampling (held finding 5): with a heavy job (an
/// import or an analysis) and a display plan each running on the class raster
/// work uses, a `lidar_sample_points` call through the real command and
/// executor still answers within its budget, so row values, the pin and the
/// profile keep reading while both run.
#[test]
fn sampling_answers_while_a_heavy_job_and_a_display_plan_run() {
    use crate::native_operation::NativeOperationExecutor;
    use crate::services::lidar::RASTER_WORK;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::{Duration, Instant};
    use tauri::Manager;

    let root = scratch_root("sampling-beside-raster-work");
    let library = LidarLibrary::open(&root).unwrap();
    let plane = plane_layer(&library, &root, 16, 16);
    let aimed = target(
        LibraryItemRole::Source,
        &plane,
        &source_head(&library, &plane),
    );
    let executor = NativeOperationExecutor::production();
    let app = tauri::test::mock_builder()
        .manage(library.clone())
        .manage(executor.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();

    let running = Arc::new(AtomicUsize::new(0));
    let released = Arc::new((Mutex::new(false), Condvar::new()));
    let held: Vec<_> = ["lidar analysis", "lidar display preparation"]
        .into_iter()
        .map(|label| {
            let (executor, running, released) =
                (executor.clone(), running.clone(), released.clone());
            std::thread::spawn(move || {
                tauri::async_runtime::block_on(executor.run(RASTER_WORK, label, move || {
                    running.fetch_add(1, Ordering::SeqCst);
                    let (lock, wake) = &*released;
                    let mut open = lock.lock().unwrap();
                    while !*open {
                        open = wake.wait(open).unwrap();
                    }
                    Ok(())
                }))
            })
        })
        .collect();
    let deadline = Instant::now() + Duration::from_secs(10);
    while running.load(Ordering::SeqCst) < 2 {
        assert!(Instant::now() < deadline, "the raster work never started");
        std::thread::sleep(Duration::from_millis(5));
    }

    let (answered, answer) = std::sync::mpsc::channel();
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        let request = LidarSamplePointsRequest {
            targets: vec![aimed],
            points: vec![point(5.5, 10.5)],
        };
        // The receiver is gone once the budget ran out; the assertion below says so.
        let _ = answered.send(tauri::async_runtime::block_on(
            crate::commands::lidar::lidar_sample_points(handle.state(), handle.state(), request),
        ));
    });
    let sample = answer.recv_timeout(Duration::from_secs(2));

    {
        let (lock, wake) = &*released;
        *lock.lock().unwrap() = true;
        wake.notify_all();
    }
    for work in held {
        work.join().unwrap().unwrap();
    }
    let series = sample
        .expect("a sample answers while raster work holds its slots")
        .expect("the sample succeeds");
    assert_eq!(values(&series[0]), vec![Some(5.0)]);
}

/// A diagonal profile across a result's chunk corner reads every cell, over
/// more than one 256-cell run: chunk (0, 0) holds its column, chunk (1, 1)
/// 2000 plus its own column.
#[test]
fn a_diagonal_across_a_chunk_corner_reads_every_cell() {
    let root = scratch_root("batch-diagonal");
    let library = LidarLibrary::open(&root).unwrap();
    let plane = plane_layer(&library, &root, 16, 16);
    let result = chunk_result(&library, &plane, "item-diagonal");
    let side = generation::CHUNK_SIDE as u32;
    let near: Vec<f32> = (0..side * side)
        .map(|index| (index % side) as f32)
        .collect();
    generation::publish_test_chunk(&library, &result, 0, 0, side, side, &near);
    let far: Vec<f32> = (0..200 * 200)
        .map(|index| 2000.0 + (index % 200) as f32)
        .collect();
    generation::publish_test_chunk(&library, &result, 1, 1, 200, 200, &far);

    let steps: Vec<i64> = (900..1200).collect();
    let points = steps
        .iter()
        .map(|&cell| point(cell as f64 + 0.5, -(cell as f64) - 0.5))
        .collect();
    let read = values(
        &sample(
            &library,
            vec![target(LibraryItemRole::Derived, "item-diagonal", &result)],
            points,
        )[0],
    );
    let expected: Vec<Option<f64>> = steps
        .iter()
        .map(|&cell| {
            Some(if cell < 1024 {
                cell as f64
            } else {
                2000.0 + (cell - 1024) as f64
            })
        })
        .collect();
    assert_eq!(read, expected);
}
