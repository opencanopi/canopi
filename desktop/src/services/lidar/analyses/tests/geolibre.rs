//! The lidar-native lane: the pinned GeoLibre CLI on Rust-engine fixtures
//! (ignored unless `CANOPI_GEOLIBRE_BIN` is set).

use super::*;

/// A published slope is readable through the sampler in the units it was
/// computed in. The plane rises one metre per metre, so its slope is 45° and
/// 100 % wherever it has neighbours.
#[test]
#[ignore = "requires the pinned GeoLibre CLI (CANOPI_GEOLIBRE_BIN)"]
fn the_sampler_reads_a_published_slope_in_both_units() {
    let root = scratch_root("inspection");
    let library = LidarLibrary::open(&root).unwrap();
    let layer_id = plane_layer(&library, &root, 16, 16);
    let mut observed = Vec::new();
    for (unit, expected) in [("degrees", 45.0_f64), ("percent", 100.0_f64)] {
        let receipt = run_slope(&library, &layer_id, unit, None);
        let item_id = &receipt.item_ids[0];
        let generation_id = catalogue::derived_head(&library.catalogue().unwrap(), item_id)
            .unwrap()
            .unwrap()
            .id;
        let read = values(
            &sample(
                &library,
                vec![target(LibraryItemRole::Derived, item_id, &generation_id)],
                vec![point(5.5, 16.0 - 5.5)],
            )[0],
        );
        let value = read[0].unwrap_or_else(|| panic!("cell (5, 5) must hold a slope"));
        assert!((value - expected).abs() < 0.5, "{unit}: {value}");
        observed.push(value);
    }
    assert!((observed[1] - 100.0 * observed[0].to_radians().tan()).abs() < 0.5);
    drop(library);
    let _ = std::fs::remove_dir_all(root);
}

/// `terrain.slope@1` runs the pinned CLI window by window: it matches the
/// analytic surface on both sides of a 1024-cell chunk seam, keeps NoData
/// centres invalid, marks quality only where the whole 5×5 input was valid,
/// records what ran, and a second analysis is a separate result.
#[test]
#[ignore = "requires the pinned GeoLibre CLI (CANOPI_GEOLIBRE_BIN)"]
fn geolibre_slope_matches_the_analytic_surface_across_a_chunk_seam() {
    let root = scratch_root("seam");
    let library = LidarLibrary::open(&root).unwrap();
    let (width, height) = (1040u32, 12u32);
    let layer_id = import_layer(&library, &[curved_member(&root, width, height, 600..603)]);
    let degrees = run_slope(&library, &layer_id, "degrees", Some("Steepness"));
    let read = |item: &str| {
        let half = width / 2;
        let left = result_window(
            &library,
            item,
            generation::LatticeWindow {
                x: 0,
                y: 0,
                width: half,
                height,
            },
        );
        let right = result_window(
            &library,
            item,
            generation::LatticeWindow {
                x: i64::from(half),
                y: 0,
                width: half,
                height,
            },
        );
        let join = |l: &[u8], r: &[u8]| -> Vec<u8> {
            (0..height as usize)
                .flat_map(|row| {
                    let span = row * half as usize..(row + 1) * half as usize;
                    l[span.clone()]
                        .iter()
                        .chain(&r[span])
                        .copied()
                        .collect::<Vec<_>>()
                })
                .collect()
        };
        let values: Vec<f32> = (0..height as usize)
            .flat_map(|row| {
                let span = row * half as usize..(row + 1) * half as usize;
                left.0[span.clone()]
                    .iter()
                    .chain(&right.0[span])
                    .copied()
                    .collect::<Vec<_>>()
            })
            .collect();
        (values, join(&left.1, &right.1), join(&left.2, &right.2))
    };
    let (values, valid, quality) = read(&degrees.item_ids[0]);
    let near_hole = |x: u32, y: u32| (598..605).contains(&x) && y < 5;
    let mut compared = 0usize;
    for y in 0..height {
        for x in 0..width {
            let index = (y * width + x) as usize;
            if (600..603).contains(&x) && y < 3 {
                assert_eq!(valid[index], 0, "a NoData centre stays invalid at {x},{y}");
                continue;
            }
            assert_eq!(valid[index], 1, "a valid centre has a value at {x},{y}");
            let interior = (2..height - 2).contains(&y) && (2..width - 2).contains(&x);
            let expected_quality = interior && !near_hole(x, y);
            assert_eq!(
                quality[index],
                u8::from(expected_quality),
                "quality at {x},{y}"
            );
            if expected_quality {
                let expected = curved_gradient(f64::from(x), f64::from(y))
                    .atan()
                    .to_degrees();
                let error = (f64::from(values[index]) - expected).abs();
                assert!(error < 0.01, "{x},{y}: {} vs {expected}", values[index]);
                compared += 1;
            }
        }
    }
    assert!(
        compared > 8_000,
        "the comparison covers the surface ({compared} cells)"
    );
    for x in 1020..1028 {
        assert_eq!(
            quality[(5 * width + x) as usize],
            1,
            "the seam at {x} is interior"
        );
    }

    let snapshot = library.library_snapshot().unwrap();
    let published = summary(&snapshot.items, &degrees.item_ids[0]);
    let provenance = published.provenance.as_ref().unwrap();
    assert_eq!(
        (provenance.analysis_id.as_str(), provenance.recipe_version),
        ("terrain.slope", 1)
    );
    let tool = provenance.tool.as_ref().expect("the tool is recorded");
    assert!(tool.version.starts_with("geolibre-cli "), "{tool:?}");
    assert_eq!(
        tool.revision,
        crate::services::lidar::geolibre::GEOLIBRE_REVISION
    );
    assert_eq!(tool.tools, ["slope"]);
    assert_eq!(published.freshness, Freshness::Current);

    let percent = run_slope(&library, &layer_id, "percent", Some("Steepness"));
    assert_ne!(
        percent.item_ids, degrees.item_ids,
        "a second analysis is a separate result"
    );
    let (values, _, _) = read(&percent.item_ids[0]);
    let (x, y) = (1024u32, 6u32);
    let expected = 100.0 * curved_gradient(f64::from(x), f64::from(y));
    let got = f64::from(values[(y * width + x) as usize]);
    assert!((got - expected).abs() < 0.05, "percent {got} vs {expected}");
    let snapshot = library.library_snapshot().unwrap();
    assert_eq!(
        snapshot
            .items
            .iter()
            .filter(|item| item.role == LibraryItemRole::Derived && item.generation_id.is_some())
            .count(),
        2,
        "the first result is still there"
    );
    drop(library);
    let _ = std::fs::remove_dir_all(&root);
}

/// Cancelling while the GeoLibre child computes a window kills and reaps that
/// child, publishes nothing and leaves no scratch behind.
#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires the pinned GeoLibre CLI (CANOPI_GEOLIBRE_BIN)"]
fn cancelling_a_geolibre_run_kills_its_child_and_publishes_nothing() {
    let root = scratch_root("cancel-child");
    let library = LidarLibrary::open(&root).unwrap();
    let tool = library
        .inner
        .geolibre
        .discover()
        .expect("GeoLibre CLI")
        .path;
    let layer_id = import_layer(&library, &[curved_member(&root, 1024, 1024, 0..0)]);
    let receipt = record(&library, &slope_request(&layer_id, "degrees", None));
    let cancel = AtomicBool::new(false);
    // A scoped watcher cancels once the child is running; the scope joins it.
    let error = std::thread::scope(|scope| {
        scope.spawn(|| {
            let started = std::time::Instant::now();
            while running(&tool) == 0 {
                assert!(
                    started.elapsed().as_secs() < 60,
                    "the GeoLibre child never started"
                );
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        run_job(&library, &receipt.job_id, &cancel).expect_err("a cancelled run does not publish")
    });
    assert_eq!(error, "cancelled");
    assert_eq!(running(&tool), 0, "the GeoLibre child was reaped");
    assert_eq!(
        count(&library, "SELECT COUNT(*) FROM lidar_derived_heads"),
        0
    );
    assert!(
        !library
            .inner
            .paths
            .analysis_scratch_dir(&receipt.job_id)
            .exists()
    );
    drop(library);
    let _ = std::fs::remove_dir_all(&root);
}

/// A run cancelled before its first window publishes nothing and leaves no
/// scratch or unpublished rows.
#[test]
#[ignore = "requires the pinned GeoLibre CLI (CANOPI_GEOLIBRE_BIN)"]
fn a_cancelled_run_publishes_nothing() {
    let root = scratch_root("cancel-early");
    let library = LidarLibrary::open(&root).unwrap();
    let layer_id = import_layer(
        &library,
        &[raster(&root, "cancel", &vec![1.0; 192], 16, 12, 0.0)],
    );
    let receipt = record(&library, &slope_request(&layer_id, "degrees", None));
    let error = run_job(&library, &receipt.job_id, &AtomicBool::new(true)).unwrap_err();
    assert_eq!(error, "cancelled");
    assert_eq!(
        count(&library, "SELECT COUNT(*) FROM lidar_derived_heads"),
        0
    );
    assert_eq!(
        count(
            &library,
            "SELECT COUNT(*) FROM lidar_generation_chunks WHERE state != 'published'"
        ),
        0
    );
    assert!(
        !library
            .inner
            .paths
            .analysis_scratch_dir(&receipt.job_id)
            .exists()
    );
    drop(library);
    let _ = std::fs::remove_dir_all(&root);
}
