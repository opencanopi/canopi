//! End-to-end vertical-slice validation against the real IGN 0446_6807 MNT
//! fixture, the raster engine and the pinned GeoLibre CLI.
//!
//! Ignored by default: it requires the GeoLibre CLI (`CANOPI_GEOLIBRE_BIN`)
//! and the fixture under `~/Downloads`. Run on a development OS with:
//! `cargo test -p canopi-desktop lidar::e2e -- --ignored --nocapture`

use super::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

/// Total bytes under a directory tree, and how many files they are.
///
/// The resource contract separates **durable** bytes, which a published
/// generation owns and a restart must keep, from **temporary** bytes, which a
/// completed job must not leave behind. Both are measured by walking the tree
/// rather than trusting a job's own accounting.
fn tree_bytes(root: &std::path::Path) -> (u64, u64) {
    let mut total = 0u64;
    let mut files = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => stack.push(path),
                Ok(_) => {
                    if let Ok(meta) = entry.metadata() {
                        total = total.saturating_add(meta.len());
                        files = files.saturating_add(1);
                    }
                }
                Err(_) => {}
            }
        }
    }
    (total, files)
}

/// Report the durable and temporary footprint of a library root.
///
/// Staging and job scratch are the only places a completed job may leave
/// nothing, so the temporary figure is what proves the cleanup, while the
/// durable figure is what a restart must reproduce.
fn report_library_bytes(label: &str, root: &std::path::Path) -> (u64, u64, u64, u64) {
    let (durable, durable_files) = tree_bytes(root);
    // `jobs` holds per-job scratch, which a settled job must empty. The other
    // roots are durable: `sources` and `prepared` are retained inputs.
    let (temporary, temporary_files) = tree_bytes(&root.join("jobs"));
    let job_dirs: Vec<String> = std::fs::read_dir(root.join("jobs"))
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| {
                    let (bytes, files) = tree_bytes(&entry.path());
                    format!("{}({bytes}B/{files}f)", entry.file_name().to_string_lossy())
                })
                .collect()
        })
        .unwrap_or_default();
    println!(
        "{label}: durable {durable} bytes in {durable_files} files, \
         temporary {temporary} bytes in {temporary_files} files, \
         job scratch [{}]",
        job_dirs.join(", ")
    );
    (durable, durable_files, temporary, temporary_files)
}

/// The display route draws one entity: its derivatives prepare for the
/// current generation and together hold valid values. Returns that generation.
fn assert_displays(
    library: &LidarLibrary,
    kind: common_types::library::LibraryItemRole,
    entity_id: &str,
) -> String {
    library
        .prepare_display_now(kind, entity_id)
        .expect("display derivatives prepare");
    let descriptor = library
        .display_descriptor(&common_types::lidar::LidarDisplayRequest {
            kind,
            entity_id: entity_id.to_string(),
            expected_generation_id: None,
            retry: false,
            relief: false,
        })
        .expect("descriptor reads");
    assert_eq!(
        descriptor.state,
        common_types::lidar::LidarDisplayState::Ready,
        "{:?}",
        descriptor.message
    );
    assert!(
        !descriptor.assets.is_empty(),
        "a displayed entity has assets"
    );
    let valid = descriptor.assets.iter().any(|asset| {
        library
            .inner
            .engine
            .statistics(Path::new(&asset.path), &AtomicBool::new(false))
            .expect("derivative opens through the engine")
            .valid_percent
            > 0.0
    });
    assert!(
        valid,
        "the display derivatives of {entity_id} hold no valid values"
    );
    descriptor
        .generation_id
        .expect("a ready descriptor names its generation")
}

/// Select the real ground-elevation fixture, explicitly rather than by discovery.
///
/// `CANOPI_LIDAR_E2E_FIXTURE` names the file to use, which keeps this test
/// runnable on a host whose available IGN tile is not the default one without
/// silently substituting a different tile. When the variable is unset the
/// documented `0446_6807` tile under `~/Downloads` is used, and a missing fixture
/// is reported rather than replaced. The test's expected scientific values are
/// tile-independent, so the selection changes only which real raster is read.
fn fixture_mnt() -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("CANOPI_LIDAR_E2E_FIXTURE") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "CANOPI_LIDAR_E2E_FIXTURE points at a missing file: {}",
            path.display()
        ));
    }
    let downloads = dirs_home().join("Downloads");
    let dir = downloads.join("LHD_FXX_0446_6807_MNT_O_0M50_LAMB93_IGN69");
    let file = dir.join("LHD_FXX_0446_6807_MNT_O_0M50_LAMB93_IGN69");
    if file.is_file() {
        return Ok(file);
    }
    Err(format!(
        "IGN MNT fixture is missing; set CANOPI_LIDAR_E2E_FIXTURE to an explicit \
         ground-elevation GeoTIFF (looked for {})",
        file.display()
    ))
}

fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// The item lifecycle on the real IGN MNT fixture: import, publish, display,
/// GeoLibre slope, restart reuse, rename, a second import of the same file as a
/// separate item, and delete. Run with:
/// `CANOPI_LIDAR_E2E_FIXTURE=<mnt> cargo test -p canopi-desktop --lib -- --ignored e2e_import_publish --nocapture`
#[test]
#[ignore = "local fixture: an IGN MNT tile and the pinned GeoLibre CLI; see CANOPI_LIDAR_E2E_FIXTURE"]
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn e2e_import_publish_slope_restart_reuse() {
    let engine = crate::services::lidar::rust_engine::RustRasterEngine;
    let engine_version = engine
        .version()
        .expect("the raster engine reports a version");

    let fixture = match fixture_mnt() {
        Ok(path) => path,
        Err(reason) => panic!("{reason}"),
    };
    let work = crate::test_scratch::TestScratch::new("lidar-e2e");
    let cancel = AtomicBool::new(false);

    // Open the library (slice 1: catalogue + assets under app data root).
    let library = LidarLibrary::open(&work).expect("library opens");

    // 1. Create one named ground layer.
    let layer_id = library
        .create_layer(
            "IGN ground POC",
            common_types::library::RasterQuantity::GroundElevation,
            None,
            false,
        )
        .expect("layer created");

    // 2. Prepare the real TIFF: probe, valid mask, controlled COG, source facts.
    //    Preparation is the validation step now, so an unusable fixture fails
    //    here rather than at a review.
    let job_id = library.record_import_job(&layer_id).expect("job recorded");
    let staging = {
        import::stage_import(
            &library,
            &job_id,
            &layer_id,
            std::slice::from_ref(&fixture),
            &cancel,
        )
        .expect("the fixture is admitted");
        import::read_staged_import(&library, &job_id).expect("staged payload")
    };
    println!(
        "staged: {} source(s), {} valid cells",
        staging.sources.len(),
        staging.sources[0].valid_cells
    );

    // 3. Publish it: one fixed generation.
    let outcome = import::apply_import(&library, &staging, &cancel).expect("apply publishes");
    library.finish_import_sources(&job_id, Ok(()));
    let completed_job = library
        .get_import_job(&job_id)
        .unwrap()
        .expect("completed import job remains queryable");
    assert_eq!(
        completed_job.state,
        common_types::lidar::LidarImportJobState::Complete
    );
    // A settled job reports its outcome through its state; the phase it passed
    // through while publishing is cleared so a reader cannot mistake a stale
    // percentage for work still running.
    assert_eq!(completed_job.progress, None);
    println!("published: {}", outcome.summary());

    // Snapshot shows the layer with its display derivatives.
    let snapshot = library.library_snapshot().expect("snapshot");
    assert_eq!(snapshot.items.len(), 1);
    let layer = &snapshot.items[0];
    assert_eq!(layer.id, layer_id);
    assert!(
        layer
            .coverage_cells
            .expect("this fixture measured its coverage")
            > 3_000_000
    );
    assert_displays(
        &library,
        common_types::library::LibraryItemRole::Source,
        &layer_id,
    );

    // 4. One persisted slope result via the analysis pipeline.
    let receipt = analyses::test_support::run_slope(&library, &layer_id, "degrees", None);
    let snapshot = library.library_snapshot().expect("snapshot after analysis");
    let analysis = snapshot
        .items
        .iter()
        .find(|item| item.id == receipt.item_ids[0])
        .expect("the result is listed");
    assert_eq!(analysis.state, common_types::lidar::LidarResultState::Ready);
    assert_displays(
        &library,
        common_types::library::LibraryItemRole::Derived,
        &analysis.id,
    );
    println!("analysis ready: {:?}", analysis.value_range);

    // 5. Restart reuse: reopen the library; layers, results, displays and
    // immutable originals all survive without recomputation.
    drop(library);
    let reopened = LidarLibrary::open(&work).expect("library reopens");
    let snapshot = reopened.library_snapshot().expect("snapshot after restart");
    assert_eq!(snapshot.items.len(), 2);
    let result = snapshot
        .items
        .iter()
        .find(|item| item.id == receipt.item_ids[0])
        .expect("the result survives");
    assert_eq!(result.state, common_types::lidar::LidarResultState::Ready);
    assert_eq!(result.freshness, common_types::library::Freshness::Current);
    assert_displays(
        &reopened,
        common_types::library::LibraryItemRole::Source,
        &layer_id,
    );
    assert_displays(
        &reopened,
        common_types::library::LibraryItemRole::Derived,
        &result.id,
    );
    let engine_status = reopened.engine_status();
    assert!(engine_status.available);
    assert_eq!(
        engine_status.version.as_deref(),
        Some(engine_version.as_str())
    );

    // Rename preserves identity and results.
    reopened
        .rename_item(&layer_id, "IGN ground renamed")
        .expect("rename");
    let snapshot = reopened.library_snapshot().expect("snapshot after rename");
    let source = snapshot
        .items
        .iter()
        .find(|item| item.id == layer_id)
        .unwrap();
    assert_eq!(source.name.as_deref(), Some("IGN ground renamed"));
    let result = snapshot
        .items
        .iter()
        .find(|item| item.id == receipt.item_ids[0])
        .unwrap();
    assert_eq!(
        result.provenance.as_ref().unwrap().inputs[0].item_id,
        layer_id
    );

    // Importing the same file again creates a separate item; the first item's
    // head is untouched.
    let first_head = catalogue::head_generation(&reopened.catalogue().unwrap(), &layer_id)
        .unwrap()
        .expect("first item published");
    let second_layer = reopened
        .create_layer(
            "IGN ground again",
            common_types::library::RasterQuantity::GroundElevation,
            None,
            false,
        )
        .expect("second layer created");
    let second_job = reopened
        .record_import_job(&second_layer)
        .expect("second job recorded");
    import::stage_and_publish(
        &reopened,
        &second_job,
        &second_layer,
        std::slice::from_ref(&fixture),
        &cancel,
    )
    .expect("the second item publishes");
    reopened.finish_import_sources(&second_job, Ok(()));
    let snapshot = reopened
        .library_snapshot()
        .expect("snapshot with two items");
    assert_eq!(snapshot.items.len(), 3, "two sources and one result");
    assert_eq!(
        catalogue::head_generation(&reopened.catalogue().unwrap(), &layer_id)
            .unwrap()
            .expect("first item still published")
            .id,
        first_head.id
    );
    assert_displays(
        &reopened,
        common_types::library::LibraryItemRole::Source,
        &second_layer,
    );
    reopened
        .delete_item(&second_layer)
        .expect("the second item deletes");

    // A source with a saved result is kept until the result is deleted.
    assert!(reopened.delete_item(&layer_id).is_err());
    reopened
        .delete_item(&receipt.item_ids[0])
        .expect("the result deletes");
    reopened
        .delete_item(&layer_id)
        .expect("the source deletes once nothing depends on it");
    let deleted = reopened.library_snapshot().expect("snapshot after delete");
    assert!(deleted.items.is_empty());

    let _ = std::fs::remove_dir_all(&work);
}

/// Resource-measured vertical slice on the real IGN MNT fixture: import as an
/// ordered collection, display derivatives, GeoLibre slope published as sparse
/// result and quality chunks, and restart reuse, sampled for combined memory.
/// Run with:
/// `CANOPI_LIDAR_E2E_FIXTURE=<mnt> cargo test -p canopi-desktop --lib -- --ignored e2e_sparse --nocapture`
#[test]
#[ignore = "local fixture: an IGN MNT tile and the pinned GeoLibre CLI; see CANOPI_LIDAR_E2E_FIXTURE"]
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn e2e_sparse_generation_lifecycle() {
    let engine = crate::services::lidar::rust_engine::RustRasterEngine;
    engine
        .version()
        .expect("the raster engine reports a version");
    let fixture = match fixture_mnt() {
        Ok(path) => path,
        Err(reason) => panic!("{reason}"),
    };
    let work = crate::test_scratch::TestScratch::new("lidar-e2e-sparse");
    let cancel = AtomicBool::new(false);

    // Sample the combined working set from an idle baseline for the whole run.
    let sampler = super::measurement::Sampler::start();
    // 1. Real import published as sparse resolved chunks.
    let library = LidarLibrary::open(&work).expect("library opens");
    let layer_id = library
        .create_layer(
            "IGN ground sparse",
            common_types::library::RasterQuantity::GroundElevation,
            None,
            false,
        )
        .expect("layer created");
    let job_id = library.record_import_job(&layer_id).expect("job recorded");
    let staging = {
        import::stage_import(
            &library,
            &job_id,
            &layer_id,
            std::slice::from_ref(&fixture),
            &cancel,
        )
        .expect("the fixture is admitted");
        import::read_staged_import(&library, &job_id).expect("staged payload")
    };
    let staged_cells = staging.sources[0].valid_cells;
    assert!(staged_cells > 3_000_000, "4M-cell tile: {staged_cells}");
    import::apply_import(&library, &staging, &cancel).expect("apply");
    library.finish_import_sources(&job_id, Ok(()));

    let head = {
        let connection = library.catalogue().unwrap();
        catalogue::head_generation(&connection, &layer_id)
            .unwrap()
            .expect("head published")
    };
    // A one-occurrence composition carries its member's exact facts without
    // reading the composed pixels.
    assert!(
        head.coverage_cells
            .expect("a one-member composition carries its member's exact count")
            > 3_000_000
    );
    let chunks = {
        let connection = library.catalogue().unwrap();
        catalogue::generation_chunk_assets(&connection, &head.id, "result").unwrap()
    };
    assert!(
        chunks.is_empty(),
        "an ordered composition materializes no resolved chunks"
    );
    println!(
        "sparse import: {} cells in {} chunks, value range {:?}..{:?}",
        head.coverage_cells
            .expect("this fixture measured its coverage"),
        chunks.len(),
        head.min_value,
        head.max_value
    );

    // 2. The layer's display derivatives prepare and hold its values.
    let generation_id = assert_displays(
        &library,
        common_types::library::LibraryItemRole::Source,
        &layer_id,
    );

    // 3. Slope over the chunked head publishes sparse result and quality.
    let receipt = analyses::test_support::run_slope(&library, &layer_id, "degrees", None);
    let analysis_head = {
        let connection = library.catalogue().unwrap();
        catalogue::derived_head(&connection, &receipt.item_ids[0])
            .unwrap()
            .expect("analysis head")
    };
    let (result_chunks, quality_chunks) = {
        let connection = library.catalogue().unwrap();
        (
            catalogue::generation_chunk_assets(&connection, &analysis_head.id, "result").unwrap(),
            catalogue::generation_chunk_assets(&connection, &analysis_head.id, "quality").unwrap(),
        )
    };
    assert!(!result_chunks.is_empty(), "result chunks published");
    assert!(!quality_chunks.is_empty(), "quality chunks published");
    println!(
        "sparse slope: {} result chunks, {} quality chunks, range {:?}..{:?}",
        result_chunks.len(),
        quality_chunks.len(),
        analysis_head.min_value,
        analysis_head.max_value
    );
    assert_displays(
        &library,
        common_types::library::LibraryItemRole::Derived,
        &receipt.item_ids[0],
    );

    // 4. Restart reuse: the sparse head, its display and its result survive.
    drop(library);
    let reopened = LidarLibrary::open(&work).expect("library reopens");
    let snapshot = reopened.library_snapshot().expect("snapshot after restart");
    assert_eq!(
        snapshot
            .items
            .iter()
            .find(|item| item.id == layer_id)
            .unwrap()
            .coverage_cells,
        Some(head.coverage_cells.unwrap_or(0).max(0) as u64),
        "coverage survives restart"
    );
    assert_eq!(
        assert_displays(
            &reopened,
            common_types::library::LibraryItemRole::Source,
            &layer_id
        ),
        generation_id,
        "the same immutable head is displayed after restart"
    );

    drop(reopened);
    let measurement = sampler.finish();
    let _ = super::measurement::gate_combined_budget("sparse MNT lifecycle", &measurement);
    let _ = std::fs::remove_dir_all(&work);
}

/// The 12 MNH tiles of one IGN batch, enumerated rather than assumed.
fn fixture_mnh_batch() -> Result<Vec<PathBuf>, String> {
    let directory = std::env::var_os("CANOPI_LIDAR_MNH_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs_home().join("Downloads").join("la magnerie"));
    let mut files: Vec<PathBuf> = std::fs::read_dir(&directory)
        .map_err(|error| format!("MNH batch directory is unavailable: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().contains("_MNH_"))
                .unwrap_or(false)
        })
        // IGN delivers each tile either as a bare file or as a folder holding
        // the raster under the tile's own name beside its JSON sidecar.
        .filter_map(|path| {
            if path.is_file() {
                return Some(path);
            }
            let inner = path.join(path.file_name()?);
            inner.is_file().then_some(inner)
        })
        .collect();
    files.sort();
    if files.is_empty() {
        return Err(format!(
            "no MNH tiles found under {}; set CANOPI_LIDAR_MNH_DIR",
            directory.display()
        ));
    }
    Ok(files)
}

/// The authorized 12-tile MNH batch: a 48M-cell union imported as one batch,
/// published sparsely, displayed on demand, and reopened. MNH is height above
/// ground, so it is deliberately never used as slope input here.
#[test]
#[ignore = "local fixture: the 12-tile MNH batch and a host with headroom; see CANOPI_LIDAR_MNH_DIR"]
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn e2e_mnh_batch_import_apply_display_restart() {
    let engine = crate::services::lidar::rust_engine::RustRasterEngine;
    engine
        .version()
        .expect("the raster engine reports a version");
    let files = match fixture_mnh_batch() {
        Ok(files) => files,
        Err(reason) => panic!("{reason}"),
    };
    println!("MNH batch: {} tiles", files.len());
    for file in &files {
        let (digest, bytes) = super::raster_assets::hash_file(file, &AtomicBool::new(false))
            .expect("tile hashes with bounded I/O");
        println!(
            "  {} {} bytes {}",
            file.file_name().unwrap_or_default().to_string_lossy(),
            bytes,
            digest
        );
    }
    let work = crate::test_scratch::TestScratch::new("lidar-e2e-mnh");
    let cancel = AtomicBool::new(false);
    // Twelve files and 48,000,000 processing cells are both inside the
    // production policy, so this authorized run needs no admission override:
    // it witnesses the real limits a user gets.
    assert_eq!(
        admission::limits(),
        admission::AdmissionLimits::production()
    );

    // The combined-memory sample starts from an idle baseline before any raster
    // work and keeps sampling until the workload settles.
    let sampler = super::measurement::Sampler::start();
    let library = LidarLibrary::open(&work).expect("library opens");
    let layer_id = library
        .create_layer(
            "MNH batch",
            common_types::library::RasterQuantity::AboveGroundHeight,
            None,
            false,
        )
        .expect("layer created");
    let job_id = library.record_import_job(&layer_id).expect("job recorded");
    let staging = {
        import::stage_import(&library, &job_id, &layer_id, &files, &cancel)
            .expect("every tile is admitted");
        import::read_staged_import(&library, &job_id).expect("staged payload")
    };
    let staged_cells: u64 = staging
        .sources
        .iter()
        .map(|source| source.valid_cells)
        .sum();
    println!(
        "staged: {staged_cells} valid cells across {} tiles",
        staging.sources.len()
    );
    assert_eq!(
        staged_cells, 48_000_000,
        "twelve 2000x2000 tiles aligned into an 8000x6000 union"
    );
    assert_eq!(
        (staging.union_grid.width, staging.union_grid.height),
        (8000, 6000)
    );
    import::apply_import(&library, &staging, &cancel).expect("apply");
    library.finish_import_sources(&job_id, Ok(()));

    let head = {
        let connection = library.catalogue().unwrap();
        catalogue::head_generation(&connection, &layer_id)
            .unwrap()
            .expect("head published")
    };
    // Twelve occurrences cannot be composed from metadata alone, so the
    // generation claims no exact count; the batch's own member facts are the
    // diagnostic, and its display range is a labelled source envelope.
    assert_eq!(head.coverage_cells, None);
    assert_eq!(head.display_basis.as_deref(), Some("source-envelope"));
    let members = {
        let connection = library.catalogue().unwrap();
        catalogue::collection_members(&connection, &head.id).unwrap()
    };
    assert_eq!(
        members.len(),
        files.len(),
        "every selected tile is its own occurrence"
    );
    // The composition itself stores no resolved result chunks: the occurrences
    // are read from their own source COGs on demand.
    let resolved_chunks = {
        let connection = library.catalogue().unwrap();
        catalogue::generation_chunk_assets(&connection, &head.id, "result").unwrap()
    };
    assert!(
        resolved_chunks.is_empty(),
        "an ordered composition materializes nothing: {} resolved chunks",
        resolved_chunks.len()
    );
    // Every source occurrence retains its own standard COG, which is what makes
    // the batch readable without a composed raster.
    let source_cogs = {
        let connection = library.catalogue().unwrap();
        members
            .iter()
            .filter(|member| {
                catalogue::interpretation_cog(&connection, &member.interpretation_id)
                    .ok()
                    .flatten()
                    .is_some()
            })
            .count()
    };
    assert_eq!(
        source_cogs,
        files.len(),
        "every occurrence keeps a retained source COG"
    );
    println!(
        "applied: {members_len} source occurrences, {source_cogs} retained source COGs, \
         exact range {exact:?}, display range {display:?}..{display_max:?}",
        members_len = members.len(),
        exact = head.min_value.zip(head.max_value),
        display = head.display_min_value,
        display_max = head.display_max_value,
    );

    // Display: the layer's derivatives prepare and hold its values.
    let prepared = std::time::Instant::now();
    assert_displays(
        &library,
        common_types::library::LibraryItemRole::Source,
        &layer_id,
    );
    println!(
        "display derivatives prepared in {:.0} ms",
        prepared.elapsed().as_secs_f64() * 1000.0
    );

    // The resource contract separates durable bytes, which a restart must
    // reproduce, from temporary bytes, which a settled job must not leave behind.
    let (durable, _durable_files, temporary, temporary_files) =
        report_library_bytes("MNH batch after import and analysis", &work);
    assert_eq!(
        temporary, 0,
        "a settled job left {temporary} temporary bytes in {temporary_files} files"
    );
    assert!(
        durable > 0,
        "a settled job must have published durable bytes"
    );

    // Restart reuse: the head, its chunks and its tiles survive.
    drop(library);
    let reopened = LidarLibrary::open(&work).expect("library reopens");
    let snapshot = reopened.library_snapshot().expect("snapshot after restart");
    // The reopened layer reports the same composition and, honestly, the same
    // unknown exact coverage: a restart must not invent a count it never took.
    assert_eq!(snapshot.items[0].coverage_cells, None);
    assert_eq!(
        snapshot.items[0]
            .display_range
            .map(|range| range.basis)
            .map(|basis| format!("{basis:?}"))
            .as_deref(),
        Some("SourceEnvelope")
    );
    println!(
        "restart: coverage {:?}, display range {:?}",
        snapshot.items[0].coverage_cells,
        snapshot.items[0]
            .display_range
            .map(|range| (range.min, range.max))
    );

    // The combined working set is a sampled process-tree total: the root plus
    // every observed live descendant, summed per tick. Resident sets are
    // summed, so shared pages are double-counted (conservative), and sampling
    // can miss peaks shorter than the interval (a lower bound, never an upper
    // one). The run report states the baseline and incomplete ticks.
    let measurement = sampler.finish();
    let _ = super::measurement::gate_combined_budget("MNH batch", &measurement);

    drop(reopened);
    let _ = std::fs::remove_dir_all(&work);
}
