//! Fixed reusable library items (GeoLibre adoption S2).
//!
//! A published source's content is fixed: importing more data creates another
//! item, analyses create derived items, and nothing refreshes itself. These
//! tests cross the real `LidarLibrary` owner and a temporary library.

use super::*;
use common_types::library::{LibraryItemRole, LibraryItemSummary, RasterQuantity};
use common_types::lidar::{
    LidarDisplayRequest, LidarDisplayState, LidarImportRefusalReason, LidarResultState,
};
use std::path::Path;

fn scratch(label: &str) -> crate::test_scratch::TestScratch {
    crate::test_scratch::TestScratch::new(&format!("fixed-{label}"))
}

fn seed_result(connection: &Connection, layer_id: &str, item_id: &str, source_generation: &str) {
    analyses::test_support::seed_published_slope(
        connection,
        layer_id,
        source_generation,
        &format!("adef-{item_id}"),
        item_id,
        &format!("dgen-{item_id}"),
        None,
    );
}

fn item<'a>(items: &'a [LibraryItemSummary], id: &str) -> &'a LibraryItemSummary {
    items
        .iter()
        .find(|item| item.id == id)
        .unwrap_or_else(|| panic!("{id} is listed"))
}

fn count(library: &LidarLibrary, sql: &str) -> i64 {
    library
        .catalogue()
        .unwrap()
        .query_row(sql, [], |row| row.get(0))
        .unwrap()
}

/// A source with a saved result cannot be deleted: the result keeps meaning
/// only while its input exists. Deleting the result first leaves the source,
/// and then the source can go.
#[test]
fn deleting_a_source_with_a_saved_result_is_refused_until_the_result_is_deleted() {
    let root = scratch("delete-guard");
    let library = LidarLibrary::open(&root).unwrap();
    let (layer_id, _) = library
        .record_import_item(
            "Orchard",
            RasterQuantity::GroundElevation,
            None,
            false,
            &[root.join("a.tif")],
        )
        .unwrap();
    seed_result(
        &library.catalogue().unwrap(),
        &layer_id,
        "item-kept",
        "gen-input",
    );

    let refused = library.delete_item(&layer_id).unwrap_err();
    assert!(refused.contains("1 saved result"), "{refused}");
    assert_eq!(
        count(&library, "SELECT COUNT(*) FROM lidar_source_layers"),
        1
    );
    assert_eq!(
        count(&library, "SELECT COUNT(*) FROM lidar_analysis_definitions"),
        1
    );
    assert_eq!(
        count(&library, "SELECT COUNT(*) FROM lidar_derived_heads"),
        1
    );

    let impact = library.delete_impact(&layer_id).unwrap();
    assert_eq!(impact.dependent_item_ids, ["item-kept"]);
    let snapshot = library.library_snapshot().unwrap();
    assert_eq!(item(&snapshot.items, &layer_id).dependents, 1);

    library.delete_item("item-kept").unwrap();
    assert_eq!(
        count(&library, "SELECT COUNT(*) FROM lidar_source_layers"),
        1
    );
    library.delete_item(&layer_id).unwrap();
    assert_eq!(
        count(&library, "SELECT COUNT(*) FROM lidar_source_layers"),
        0
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// One import is one item: it exists as an unpublished operation, is never
/// presented as a ready empty dataset, keeps its identity and saved request
/// across Retry, and Dismiss removes only that unpublished operation.
#[test]
fn an_import_is_one_unpublished_item_with_a_retryable_saved_request() {
    let root = scratch("import-item");
    let library = LidarLibrary::open(&root).unwrap();
    let first = root.join("north.tif");
    let second = root.join("south.tif");
    let (layer_id, job_id) = library
        .record_import_item(
            "  Orchard survey ",
            RasterQuantity::GroundElevation,
            None,
            false,
            &[first.clone(), second.clone()],
        )
        .unwrap();

    let snapshot = library.library_snapshot().unwrap();
    let item = item(&snapshot.items, &layer_id);
    assert_eq!(item.name.as_deref(), Some("Orchard survey"));
    assert_eq!(item.role, LibraryItemRole::Source);
    assert_eq!(item.generation_id, None);
    assert_eq!(item.state, LidarResultState::Preparing);
    assert_eq!(
        item.import_job.as_ref().map(|job| job.job_id.as_str()),
        Some(job_id.as_str())
    );

    library
        .catalogue()
        .unwrap()
        .execute(
            "UPDATE lidar_import_jobs SET state = 'failed', message = 'south.tif is not tiled' WHERE id = ?1",
            [&job_id],
        )
        .unwrap();
    let failed = library.library_snapshot().unwrap();
    let item = self::item(&failed.items, &layer_id);
    assert_eq!(item.state, LidarResultState::Failed);
    assert_eq!(item.generation_id, None);

    let (retry_layer, retry_job, paths) = library.record_import_retry(&layer_id).unwrap();
    assert_eq!(retry_layer, layer_id);
    assert_ne!(retry_job, job_id);
    assert_eq!(
        paths,
        [first, second],
        "Retry keeps the saved selection order"
    );
    assert!(
        library.record_import_retry(&layer_id).is_err(),
        "a running operation cannot be retried twice"
    );

    let refused = library.dismiss_import(&layer_id).unwrap_err();
    assert!(refused.contains("running"), "{refused}");
    // Cancel on a Retry puts the item back to its failed import; only
    // Dismiss removes it, with every import it had.
    library.cancel_import(&retry_job).unwrap();
    assert_eq!(row_message(&library, &layer_id), "south.tif is not tiled");
    library.dismiss_import(&layer_id).unwrap();
    assert_eq!(
        count(&library, "SELECT COUNT(*) FROM lidar_source_layers"),
        0
    );
    assert_eq!(count(&library, "SELECT COUNT(*) FROM lidar_import_jobs"), 0);
    let _ = std::fs::remove_dir_all(&root);
}

/// An empty selection or a blank name creates nothing.
#[test]
fn an_import_without_files_or_name_creates_nothing() {
    let root = scratch("import-refused");
    let library = LidarLibrary::open(&root).unwrap();
    assert!(
        library
            .record_import_item("Orchard", RasterQuantity::GroundElevation, None, false, &[])
            .is_err()
    );
    assert!(
        library
            .record_import_item(
                "  ",
                RasterQuantity::GroundElevation,
                None,
                false,
                &[root.join("a.tif")]
            )
            .is_err()
    );
    assert_eq!(
        count(&library, "SELECT COUNT(*) FROM lidar_source_layers"),
        0
    );
    assert_eq!(count(&library, "SELECT COUNT(*) FROM lidar_import_jobs"), 0);
    let _ = std::fs::remove_dir_all(&root);
}

fn plane(library: &LidarLibrary, root: &Path, name: &str, origin_x: f64) -> PathBuf {
    let cancel = AtomicBool::new(false);
    let (width, height) = (64u32, 48u32);
    let values: Vec<f32> = (0..height)
        .flat_map(|y| (0..width).map(move |x| (x, y)))
        .map(|(x, _)| x as f32)
        .collect();
    let raw = root.join(format!("{name}.raw"));
    import::write_f32_raw(&raw, &values).unwrap();
    let source = root.join(format!("{name}.tif"));
    import::raw_to_tif(
        library.inner.engine.as_ref(),
        &cancel,
        &raw,
        &source,
        &grid::RasterGrid {
            width,
            height,
            geotransform: [origin_x, 1.0, 0.0, 6_806_000.0, 0.0, -1.0],
        },
        "EPSG:2154",
        -9999.0,
    )
    .unwrap();
    source
}

fn await_import(library: &LidarLibrary, job_id: &str) -> LidarImportJobState {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let job = library.get_import_job(job_id).unwrap().unwrap();
        if matches!(
            job.state,
            LidarImportJobState::Complete | LidarImportJobState::Failed
        ) && !library
            .inner
            .cancel_flags
            .lock()
            .unwrap()
            .contains_key(job_id)
        {
            return job.state;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "import {job_id} did not settle"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// Through the real command state: an import publishes one item whose display
/// derivatives already exist, a published item refuses more sources, and
/// neither import nor reopening enqueues any analysis.
#[test]
fn an_import_publishes_one_fixed_item_with_display_ready_and_nothing_refreshes() {
    let root = scratch("import-publish");
    let library = LidarLibrary::open(&root).unwrap();
    let executor = crate::native_operation::NativeOperationExecutor::production();
    library.attach_executor(executor.clone());
    let west = plane(&library, &root, "west", 445_000.0);
    let east = plane(&library, &root, "east", 445_064.0);

    let receipt = library
        .import_item(
            "Pair",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![west.clone(), east],
        )
        .unwrap();
    assert_eq!(
        await_import(&library, &receipt.job_id),
        LidarImportJobState::Complete
    );
    let snapshot = library.library_snapshot().unwrap();
    let item = item(&snapshot.items, &receipt.layer_id);
    assert_eq!(item.state, LidarResultState::Ready);
    let generation = item.generation_id.clone().expect("published head");

    // Display derivatives were staged by the import job itself: a ground
    // elevation's default view, its relief (D8).
    let descriptor = library
        .display_descriptor(&LidarDisplayRequest {
            kind: LibraryItemRole::Source,
            entity_id: receipt.layer_id.clone(),
            expected_generation_id: Some(generation.clone()),
            retry: false,
            relief: true,
        })
        .unwrap();
    assert_eq!(descriptor.state, LidarDisplayState::Ready, "{descriptor:?}");
    assert_eq!(descriptor.assets.len(), 2);

    // A published item's content is fixed, even for a stale caller.
    let refused = library
        .begin_import_sources(
            HeavyJobLease::acquire(&library, "imp-stale").unwrap(),
            "imp-stale",
            &receipt.layer_id,
            vec![west],
        )
        .unwrap_err();
    assert!(refused.contains("published"), "{refused}");
    let head = catalogue::head_generation(&library.catalogue().unwrap(), &receipt.layer_id)
        .unwrap()
        .unwrap();
    assert_eq!(head.id, generation);

    // A saved result whose input is not the head is out of date, never
    // refreshed by itself: reopening the library and attaching the executor
    // enqueue nothing.
    seed_result(
        &library.catalogue().unwrap(),
        &receipt.layer_id,
        "item-old",
        "gen-earlier",
    );
    close(library);
    let reopened = LidarLibrary::open(&root).unwrap();
    reopened.attach_executor(executor);
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(
        count(&reopened, "SELECT COUNT(*) FROM lidar_analysis_jobs"),
        1,
        "only the seeded, completed run"
    );
    assert_eq!(
        count(
            &reopened,
            "SELECT COUNT(*) FROM lidar_analysis_jobs WHERE state = 'preparing'"
        ),
        0
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// Renaming a result is metadata: its values, input and identity stay, and
/// nothing is enqueued.
#[test]
fn renaming_a_result_changes_only_its_name() {
    let root = scratch("rename-result");
    let library = LidarLibrary::open(&root).unwrap();
    let (layer_id, _) = library
        .record_import_item(
            "Orchard",
            RasterQuantity::GroundElevation,
            None,
            false,
            &[root.join("a.tif")],
        )
        .unwrap();
    seed_result(
        &library.catalogue().unwrap(),
        &layer_id,
        "item-named",
        "gen-input",
    );
    library.rename_item("item-named", "  North slope ").unwrap();
    library.rename_item(&layer_id, "Orchard 2024").unwrap();
    let snapshot = library.library_snapshot().unwrap();
    let result = item(&snapshot.items, "item-named");
    assert_eq!(result.name.as_deref(), Some("North slope"));
    assert_eq!(
        result
            .provenance
            .as_ref()
            .map(|provenance| provenance.inputs[0].generation_id.as_str()),
        Some("gen-input")
    );
    assert_eq!(result.generation_id.as_deref(), Some("dgen-item-named"));
    assert_eq!(
        item(&snapshot.items, &layer_id).name.as_deref(),
        Some("Orchard 2024")
    );
    assert!(library.rename_item("item-named", "   ").is_err());
    assert!(library.rename_item("item-missing", "Name").is_err());
    assert_eq!(
        count(&library, "SELECT COUNT(*) FROM lidar_analysis_jobs"),
        1,
        "only the seeded run"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// A library wired like the app's, so an admitted import would start.
fn attached_library(root: &Path) -> LidarLibrary {
    let library = LidarLibrary::open(root).unwrap();
    library.attach_executor(crate::native_operation::NativeOperationExecutor::production());
    library
}

/// Drops the last handle on `library`, waiting for a settling job's own, so
/// its catalogue connection is closed before the next open. Windows cannot
/// set aside a catalogue another connection still holds (the rebuild then
/// reads Unavailable), while Unix moves it regardless, so a handle left
/// behind is caught here on every platform.
fn close(library: LidarLibrary) {
    let held = std::sync::Arc::downgrade(&library.inner);
    drop(library);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while held.strong_count() > 0 {
        assert!(
            std::time::Instant::now() < deadline,
            "{} other handles keep the library and its catalogue open",
            held.strong_count()
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// Asserts a refusal shown in the import dialog: it names the user's file and
/// nothing about where it lives or how the system failed, and the refused
/// import left no item and no job behind.
fn assert_refused_in_dialog(library: &LidarLibrary, root: &Path, error: &str, name: &str) {
    assert!(error.contains(name), "the refusal names {name}: {error}");
    let root = root.display().to_string();
    assert!(!error.contains(&root), "no root path in: {error}");
    assert!(!error.contains("os error"), "no system error in: {error}");
    assert_eq!(
        count(library, "SELECT COUNT(*) FROM lidar_source_layers"),
        0,
        "no item for a refused import"
    );
    assert_eq!(
        count(library, "SELECT COUNT(*) FROM lidar_import_jobs"),
        0,
        "no job for a refused import"
    );
}

/// The GeoTIFF `plane` writes, with its projected code key rewritten to
/// `code`, a code no listed coordinate system has.
fn plane_in_code(library: &LidarLibrary, root: &Path, name: &str, code: u16) -> PathBuf {
    let path = plane(library, root, name, 445_000.0);
    let mut bytes = std::fs::read(&path).unwrap();
    // ProjectedCSTypeGeoKey (3072), stored in the directory itself, one
    // value: EPSG:2154, little-endian.
    let key: Vec<u8> = [3072u16, 0, 1, 2154]
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect();
    let at: Vec<usize> = bytes
        .windows(key.len())
        .enumerate()
        .filter(|(_, window)| *window == key.as_slice())
        .map(|(index, _)| index)
        .collect();
    assert_eq!(at.len(), 1, "one projected code key in {}", path.display());
    bytes[at[0] + 6..at[0] + 8].copy_from_slice(&code.to_le_bytes());
    std::fs::write(&path, bytes).unwrap();
    path
}

/// canopi-try2: a selected file that is gone is refused when Import is
/// clicked, by name, and creates nothing.
#[test]
fn importing_a_missing_file_is_refused_by_name_and_creates_nothing() {
    let root = scratch("import-missing");
    let library = attached_library(&root);
    let error = library
        .import_item(
            "Orchard",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![root.join("gone.tif")],
        )
        .unwrap_err()
        .detail;
    assert!(error.contains("cannot be found"), "{error}");
    assert_refused_in_dialog(&library, &root, &error, "gone.tif");
}

/// U31: a GeoTIFF in a coordinate system Canopi cannot place is refused when
/// Import is clicked with the typed refusal naming its code, and creates
/// nothing.
#[test]
fn importing_a_geotiff_in_a_refused_code_is_refused_and_creates_nothing() {
    let root = scratch("import-refused-code");
    let library = attached_library(&root);
    let source = plane_in_code(&library, &root, "elsewhere", 65_000);
    let refusal = library
        .import_item(
            "Elsewhere",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![source],
        )
        .unwrap_err();
    assert_eq!(
        refusal.reason,
        LidarImportRefusalReason::UnsupportedCrs {
            file: "elsewhere.tif".to_string(),
            crs: "EPSG:65000".to_string()
        }
    );
    let error = refusal.detail;
    assert!(
        error.contains("65000"),
        "the refusal names the code: {error}"
    );
    assert_refused_in_dialog(&library, &root, &error, "elsewhere.tif");
}

/// A file that is not a GeoTIFF is refused from its signature, before any
/// reader parses it whole, and creates nothing.
#[test]
fn importing_a_file_that_is_not_a_geotiff_is_refused_before_it_is_read() {
    let root = scratch("import-not-tiff");
    let library = attached_library(&root);
    let source = root.join("dem.asc");
    std::fs::write(
        &source,
        "ncols 2\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 1\nNODATA_value -9999\n1 2\n3 4\n",
    )
    .unwrap();
    let error = library
        .import_item(
            "Grid",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![source],
        )
        .unwrap_err()
        .detail;
    assert!(error.contains("not a GeoTIFF"), "{error}");
    assert!(
        !error.contains("readable raster"),
        "refused before a reader parsed it: {error}"
    );
    assert_refused_in_dialog(&library, &root, &error, "dem.asc");
}

/// A one-cell Float32 TIFF that is readable but not placed: with no
/// georeferencing tags, or (`zero_scale`) with a pixel scale of zero.
fn ungeoreferenced_tiff(root: &Path, name: &str, zero_scale: bool) -> PathBuf {
    // (tag, type, count, value or data): SHORT is 3, LONG is 4, DOUBLE is 12;
    // doubles and the cell follow the directory, in entry order.
    let mut entries: Vec<(u16, u16, Vec<f64>)> = vec![
        (256, 3, vec![1.0]),  // ImageWidth
        (257, 3, vec![1.0]),  // ImageLength
        (258, 3, vec![32.0]), // BitsPerSample
        (259, 3, vec![1.0]),  // Compression: none
        (262, 3, vec![1.0]),  // Photometric: black is zero
        (273, 4, vec![]),     // StripOffsets: the cell, filled in below
        (277, 3, vec![1.0]),  // SamplesPerPixel
        (278, 3, vec![1.0]),  // RowsPerStrip
        (279, 4, vec![4.0]),  // StripByteCounts
        (339, 3, vec![3.0]),  // SampleFormat: float
    ];
    if zero_scale {
        entries.push((33550, 12, vec![0.0, 0.0, 0.0])); // ModelPixelScale
        entries.push((33922, 12, vec![0.0, 0.0, 0.0, 445_000.0, 6_806_000.0, 0.0])); // ModelTiepoint
    }
    let directory_end = 8 + 2 + entries.len() * 12 + 4;
    let doubles: usize = entries
        .iter()
        .filter(|(_, kind, _)| *kind == 12)
        .map(|(_, _, values)| values.len() * 8)
        .sum();
    let cell_at = (directory_end + doubles) as u32;
    let mut bytes = b"II\x2a\x00".to_vec();
    bytes.extend_from_slice(&8u32.to_le_bytes());
    bytes.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    let mut data = Vec::new();
    for (tag, kind, values) in &entries {
        bytes.extend_from_slice(&tag.to_le_bytes());
        bytes.extend_from_slice(&kind.to_le_bytes());
        let count = values.len().max(1) as u32;
        bytes.extend_from_slice(&count.to_le_bytes());
        match kind {
            3 => {
                bytes.extend_from_slice(&(values[0] as u16).to_le_bytes());
                bytes.extend_from_slice(&[0, 0]);
            }
            4 => {
                let value = values.first().map_or(cell_at, |value| *value as u32);
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            _ => {
                let at = (directory_end + data.len()) as u32;
                bytes.extend_from_slice(&at.to_le_bytes());
                data.extend(values.iter().flat_map(|value| value.to_le_bytes()));
            }
        }
    }
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&data);
    assert_eq!(bytes.len(), cell_at as usize);
    bytes.extend_from_slice(&1.5f32.to_le_bytes());
    let path = root.join(format!("{name}.tif"));
    std::fs::write(&path, bytes).unwrap();
    path
}

/// A readable TIFF without a geotransform, or with a pixel size of zero, is
/// refused as one Canopi cannot place, not as a file it cannot read.
#[test]
fn an_ungeoreferenced_tiff_is_refused_as_having_no_coordinate_system() {
    let root = scratch("import-untagged");
    let library = attached_library(&root);
    for (name, zero_scale) in [("scan", false), ("flat", true)] {
        let source = ungeoreferenced_tiff(&root, name, zero_scale);
        let refusal =
            admission::check_sources_placeable(library.inner.engine.as_ref(), &[source], &|path| {
                path.file_name().unwrap().to_string_lossy().into_owned()
            })
            .unwrap_err();
        let file = format!("{name}.tif");
        assert_eq!(
            refusal.reason,
            LidarImportRefusalReason::NoCrs { file: file.clone() }
        );
        assert!(refusal.detail.contains(&file), "{}", refusal.detail);
    }
}

/// A chosen file that cannot be opened is refused by name, without its
/// folder or the system's error, and creates nothing.
#[cfg(unix)]
#[test]
fn importing_a_file_that_cannot_be_opened_is_refused_by_name() {
    use std::os::unix::fs::PermissionsExt as _;
    let root = scratch("import-unopenable");
    let library = attached_library(&root);
    let source = root.join("locked.tif");
    std::fs::write(&source, b"II\x2a\x00 a locked GeoTIFF").unwrap();
    std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::File::open(&source).is_ok() {
        // Permissions do not bind this user (root): nothing to observe.
        return;
    }
    let error = library
        .import_item(
            "Grid",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![source.clone()],
        )
        .unwrap_err();
    std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        error.reason,
        LidarImportRefusalReason::Unreadable {
            file: "locked.tif".to_string()
        }
    );
    let error = error.detail;
    assert!(error.contains("cannot be read"), "{error}");
    assert_refused_in_dialog(&library, &root, &error, "locked.tif");
}

/// The failed import Retry is offered on: its job's message is what the item's
/// row shows.
fn failed_import(library: &LidarLibrary, source: PathBuf, message: &str) -> String {
    let (layer_id, job_id) = library
        .record_import_item(
            "Orchard",
            RasterQuantity::GroundElevation,
            None,
            false,
            &[source],
        )
        .unwrap();
    library.fail_import_job(&job_id, message);
    layer_id
}

/// The message the item's row shows, once its latest import has failed.
fn row_message(library: &LidarLibrary, layer_id: &str) -> String {
    let snapshot = library.library_snapshot().unwrap();
    let job = item(&snapshot.items, layer_id)
        .import_job
        .as_ref()
        .expect("a retryable import");
    assert_eq!(job.state, LidarImportJobState::Failed);
    job.message.clone().unwrap_or_default()
}

/// A Retry whose saved file has gone is refused by name before a job is
/// recorded: the refusal replaces the failed import's message on the item's
/// row, and refusing again adds no job row.
#[test]
fn retrying_an_import_whose_file_is_gone_is_refused_on_its_item_without_a_new_job() {
    let root = scratch("retry-missing");
    let library = attached_library(&root);
    let layer_id = failed_import(&library, root.join("gone.tif"), "first failure");
    let error = library.retry_import(&layer_id).unwrap_err().detail;
    assert!(error.contains("gone.tif cannot be found"), "{error}");
    assert!(!error.contains(&root.display().to_string()), "{error}");
    assert_eq!(row_message(&library, &layer_id), error);
    assert_eq!(library.retry_import(&layer_id).unwrap_err().detail, error);
    assert_eq!(count(&library, "SELECT COUNT(*) FROM lidar_import_jobs"), 1);
}

/// A Cancel that lands after its import has already failed changes nothing:
/// the item keeps that failure's reason, never an older one, and a first
/// import's item is not deleted.
#[test]
fn a_cancel_after_its_import_failed_keeps_that_failure() {
    let root = scratch("cancel-after-failure");
    let library = attached_library(&root);
    let layer_id = failed_import(&library, root.join("gone.tif"), "first failure");
    let (_, retry_job, _) = library.record_import_retry(&layer_id).unwrap();
    library.fail_import_job(&retry_job, "second failure");

    library.cancel_import(&retry_job).unwrap();
    assert_eq!(row_message(&library, &layer_id), "second failure");

    let first = failed_import(&library, root.join("gone.tif"), "only failure");
    let first_job: String = library
        .catalogue()
        .unwrap()
        .query_row(
            "SELECT id FROM lidar_import_jobs WHERE layer_id = ?1",
            [&first],
            |row| row.get(0),
        )
        .unwrap();
    library.cancel_import(&first_job).unwrap();
    assert_eq!(row_message(&library, &first), "only failure");
}

/// A refused Retry whose reason cannot be written onto its item still returns
/// the refusal itself, not the failed write.
#[test]
fn a_refused_retry_returns_its_reason_when_the_row_cannot_be_updated() {
    let root = scratch("retry-refused-write-fails");
    let library = attached_library(&root);
    let layer_id = failed_import(&library, root.join("gone.tif"), "first failure");
    library
        .catalogue()
        .unwrap()
        .execute_batch(
            "CREATE TEMP TRIGGER jobs_read_only BEFORE UPDATE ON lidar_import_jobs
             BEGIN SELECT RAISE(ABORT, 'jobs are read-only'); END;",
        )
        .unwrap();
    let error = library.retry_import(&layer_id).unwrap_err().detail;
    assert!(error.contains("gone.tif cannot be found"), "{error}");
    assert!(!error.contains("read-only"), "{error}");
    assert_eq!(count(&library, "SELECT COUNT(*) FROM lidar_import_jobs"), 1);
}

/// A library the catalogue rebuild made: its one item, named "Orchard", is
/// rebuilt from `source`'s bytes kept as the managed original of `sha256`, which
/// was imported as `elsewhere.tif`. Returns the library and the item.
fn rebuilt_library(root: &Path, source: &Path, sha256: &str) -> (LidarLibrary, String) {
    rebuilt_item(root, &[(source, sha256, "elsewhere.tif")])
}

/// A library the catalogue rebuild made, whose one item "Orchard" has
/// `members` (source bytes, sha256, the name it was imported as) in order.
fn rebuilt_item(root: &Path, members: &[(&Path, &str, &str)]) -> (LidarLibrary, String) {
    let lidar = paths::library_root(root);
    let item = source_meta::ItemMeta {
        id: "lyr-rebuilt".to_string(),
        name: "Orchard".to_string(),
        quantity: RasterQuantity::GroundElevation.key().to_string(),
        units: "m".to_string(),
        created_at: "10".to_string(),
        members: members
            .iter()
            .map(|(_, sha256, _)| sha256.to_string())
            .collect(),
        analyses: Vec::new(),
    };
    for (source, sha256, name) in members {
        let dir = lidar.join("sources").join(sha256);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::copy(source, dir.join("original")).unwrap();
        let meta = source_meta::SourceMeta {
            version: source_meta::META_VERSION,
            sha256: sha256.to_string(),
            original_filename: name.to_string(),
            size_bytes: std::fs::metadata(source).unwrap().len(),
            imported_at: "10".to_string(),
            items: vec![item.clone()],
        };
        source_meta::write(&dir.join(source_meta::META_FILE), &meta).unwrap();
    }
    std::fs::write(lidar.join(paths::CATALOGUE_FILE), b"not a catalogue").unwrap();
    let library = attached_library(root);
    assert!(matches!(
        library.open_status(),
        recovery::LibraryOpenStatus::Recovered { items: 1, .. }
    ));
    // A failed import to retry; the Data library's banner says why.
    assert_eq!(row_message(&library, "lyr-rebuilt"), "");
    (library, "lyr-rebuilt".to_string())
}

/// A rebuilt item whose Retry passes the check but whose import then refuses
/// one member (south-up, found only while preparing): the failure on the
/// item's row names that member's imported file, never "original".
#[test]
fn a_rebuilt_item_whose_import_refuses_a_member_names_the_imported_file() {
    let workbench = scratch("retry-rebuilt-south-up-tiles");
    let west = plane(&attached_library(&workbench), &workbench, "west", 445_000.0);
    // A positive pixel height is written as a negative ModelPixelScale y,
    // which reads back as a south-up grid.
    let east = workbench.join("east.tif");
    wbgeotiff::GeoTiffWriter::new(4, 4, 1)
        .geo_transform(wbgeotiff::GeoTransform::north_up(
            445_064.0,
            1.0,
            6_806_000.0,
            1.0,
        ))
        .epsg(2154)
        .no_data(-9999.0)
        .write_f32(&east, &[5.0; 16])
        .unwrap();
    let root = scratch("retry-rebuilt-south-up");
    let (library, layer_id) = rebuilt_item(
        &root,
        &[
            (west.as_path(), "sha-west", "west.tif"),
            (east.as_path(), "sha-east", "east.tif"),
        ],
    );
    let receipt = library.retry_import(&layer_id).unwrap();
    assert_eq!(
        await_import(&library, &receipt.job_id),
        LidarImportJobState::Failed
    );
    let message = row_message(&library, &layer_id);
    assert!(message.contains("east.tif"), "{message}");
    assert!(message.contains("south-up"), "{message}");
    assert!(
        !message.contains("original"),
        "no managed name in: {message}"
    );
}

/// U31 on a rebuilt item: a Retry whose managed original is in a refused code
/// is refused with the typed message, naming the file the user imported rather
/// than the managed copy, and that message replaces the rebuild's "Retry
/// prepares this item again" on the row instead of vanishing with the dialog.
#[test]
fn retrying_a_rebuilt_item_in_a_refused_code_keeps_the_refusal_on_the_item() {
    let workbench = scratch("retry-refused-code-tile");
    let tile = plane_in_code(&attached_library(&workbench), &workbench, "tile", 65_000);
    let root = scratch("retry-refused-code");
    let (library, layer_id) = rebuilt_library(&root, &tile, "sha-refused");
    let jobs = count(&library, "SELECT COUNT(*) FROM lidar_import_jobs");
    let error = library.retry_import(&layer_id).unwrap_err();
    assert_eq!(
        error.reason,
        LidarImportRefusalReason::UnsupportedCrs {
            file: "elsewhere.tif".to_string(),
            crs: "EPSG:65000".to_string()
        },
        "a rebuilt item's refusal names the file it was imported as"
    );
    let error = error.detail;
    assert!(
        error.contains("65000"),
        "the refusal names the code: {error}"
    );
    assert!(
        error.contains("elsewhere.tif"),
        "the refusal names the imported file: {error}"
    );
    assert!(!error.contains("original"), "no managed name in: {error}");
    assert!(!error.contains(&root.display().to_string()), "{error}");
    assert_eq!(row_message(&library, &layer_id), error);
    assert_eq!(
        count(&library, "SELECT COUNT(*) FROM lidar_import_jobs"),
        jobs,
        "the refusal adds no job row"
    );
    assert!(
        library.record_import_retry(&layer_id).is_ok(),
        "the item still offers Retry"
    );
}

/// A rebuilt item whose managed original has gone is refused under the name it
/// was imported with, never as "original".
#[test]
fn retrying_a_rebuilt_item_whose_original_is_gone_names_the_imported_file() {
    let workbench = scratch("retry-rebuilt-gone-tile");
    let tile = plane(&attached_library(&workbench), &workbench, "tile", 445_000.0);
    let root = scratch("retry-rebuilt-gone");
    let (library, layer_id) = rebuilt_library(&root, &tile, "sha-gone");
    std::fs::remove_file(library.inner.paths.source_original("sha-gone")).unwrap();
    let error = library.retry_import(&layer_id).unwrap_err().detail;
    assert!(
        error.starts_with("elsewhere.tif cannot be found"),
        "{error}"
    );
    assert_eq!(row_message(&library, &layer_id), error);
}

/// While a raster job holds the heavy lease, Import and Retry are refused in
/// the dialog with nothing recorded: no item, no job, and the item's earlier
/// failure stays its message (a busy library is not the item's failure).
#[test]
fn import_and_retry_are_refused_with_nothing_recorded_while_a_raster_job_runs() {
    let root = scratch("import-busy");
    let library = attached_library(&root);
    let tile = plane(&library, &root, "terrain", 445_000.0);
    let layer_id = failed_import(&library, tile.clone(), "earlier");
    let lease = HeavyJobLease::acquire(&library, "imp-running").unwrap();

    let error = library
        .import_item(
            "Terrain",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![tile],
        )
        .unwrap_err()
        .detail;
    assert!(error.contains("already running"), "{error}");
    let error = library.retry_import(&layer_id).unwrap_err();
    assert_eq!(error.reason, LidarImportRefusalReason::JobRunning);
    let error = error.detail;
    assert!(error.contains("already running"), "{error}");

    assert_eq!(
        count(&library, "SELECT COUNT(*) FROM lidar_source_layers"),
        1,
        "Import recorded no item"
    );
    assert_eq!(
        count(&library, "SELECT COUNT(*) FROM lidar_import_jobs"),
        1,
        "neither recorded a job"
    );
    assert_eq!(row_message(&library, &layer_id), "earlier");

    // The lease is the only obstacle: once the raster job ends, Retry runs.
    drop(lease);
    let receipt = library.retry_import(&layer_id).unwrap();
    assert_eq!(
        await_import(&library, &receipt.job_id),
        LidarImportJobState::Complete
    );
}

/// Every file under the library's sources, jobs, assets and display folders.
fn library_files(library: &LidarLibrary) -> Vec<PathBuf> {
    fn walk(dir: &Path, found: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, found);
            } else {
                found.push(path);
            }
        }
    }
    let paths = &library.inner.paths;
    let mut found = Vec::new();
    for dir in [
        paths.root().join("sources"),
        paths.root().join("assets"),
        paths.jobs_dir(),
        paths.display_cog_dir(),
    ] {
        walk(&dir, &mut found);
    }
    found
}

/// The catalogue and display rows an import writes, by table.
fn import_rows(library: &LidarLibrary) -> Vec<(&'static str, i64)> {
    let mut rows: Vec<(&'static str, i64)> = [
        "lidar_source_layers",
        "lidar_import_jobs",
        "lidar_sources",
        "lidar_interpretations",
        "lidar_raster_assets",
    ]
    .into_iter()
    .map(|table| {
        (
            table,
            count(library, &format!("SELECT COUNT(*) FROM {table}")),
        )
    })
    .collect();
    rows.push((
        "display_cogs",
        library
            .display()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM display_cogs", [], |row| row.get(0))
            .unwrap(),
    ));
    rows
}

fn no_import_rows() -> Vec<(&'static str, i64)> {
    [
        "lidar_source_layers",
        "lidar_import_jobs",
        "lidar_sources",
        "lidar_interpretations",
        "lidar_raster_assets",
        "display_cogs",
    ]
    .into_iter()
    .map(|table| (table, 0))
    .collect()
}

/// Waits until a job's own settlement has run (its cancel flag is gone).
fn await_settled(library: &LidarLibrary, job_id: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while library
        .inner
        .cancel_flags
        .lock()
        .unwrap()
        .contains_key(job_id)
    {
        assert!(
            std::time::Instant::now() < deadline,
            "import {job_id} did not settle"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// A failed import frees its files on the raster lane, inside the executor's
/// admission, never on the async runtime: while its settlement waits for the
/// display registry, other raster work on a one-slot lane waits too.
#[test]
fn a_failed_import_frees_its_files_on_the_raster_lane() {
    use crate::native_operation::{
        NativeOperationClassLimits, NativeOperationExecutor, NativeOperationLimits,
    };
    let root = scratch("settle-on-lane");
    let library = LidarLibrary::open(&root).unwrap();
    let lane = NativeOperationClassLimits::new(4, 1);
    let executor =
        NativeOperationExecutor::new(NativeOperationLimits::new(lane, lane, lane, lane, lane))
            .unwrap();
    library.attach_executor(executor.clone());
    let west = plane(&library, &root, "west", 445_000.0);
    // Half a cell off, so the batch stages and then fails as a whole.
    let shifted = plane(&library, &root, "shifted", 445_000.5);
    let display = library.display().unwrap();
    let receipt = library
        .import_item(
            "Orchard",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![west, shifted],
        )
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while library
        .get_import_job(&receipt.job_id)
        .unwrap()
        .unwrap()
        .state
        != LidarImportJobState::Failed
    {
        assert!(
            std::time::Instant::now() < deadline,
            "the import never failed"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    // The settlement is now freeing the staged COGs and waits for the held
    // display registry; a raster probe must queue behind it.
    let (ran, probe_ran) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let outcome = tauri::async_runtime::block_on(executor.run(RASTER_WORK, "probe", || Ok(())));
        let _ = ran.send(outcome);
    });
    assert!(
        probe_ran
            .recv_timeout(std::time::Duration::from_millis(300))
            .is_err(),
        "the settlement holds the raster lane while it frees the job's files"
    );
    drop(display);
    probe_ran
        .recv_timeout(std::time::Duration::from_secs(60))
        .unwrap()
        .unwrap();
    assert_eq!(
        await_import(&library, &receipt.job_id),
        LidarImportJobState::Failed
    );
    assert_eq!(library_files(&library), Vec::<PathBuf>::new());
    let _ = std::fs::remove_dir_all(&root);
}

/// A catalogue from before Cancel deleted its item (version 24) can hold an
/// import row in the retired state 'cancelled'. It is set aside and rebuilt
/// from the originals (ADR 0021), so no item shows as preparing forever.
#[test]
fn a_catalogue_holding_a_cancelled_import_is_rebuilt_not_shown_preparing() {
    let root = scratch("cancelled-row");
    {
        let library = LidarLibrary::open(&root).unwrap();
        let (_, job_id) = library
            .record_import_item(
                "Orchard",
                RasterQuantity::GroundElevation,
                None,
                false,
                &[root.join("orchard.tif")],
            )
            .unwrap();
        let connection = library.catalogue().unwrap();
        connection
            .execute(
                "UPDATE lidar_import_jobs SET state = 'cancelled' WHERE id = ?1",
                [&job_id],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE lidar_catalogue_meta SET value = '24' WHERE key = 'schema_version'",
                [],
            )
            .unwrap();
    }

    let reopened = LidarLibrary::open(&root).unwrap();
    let preparing: Vec<_> = reopened
        .library_snapshot()
        .unwrap()
        .items
        .into_iter()
        .filter(|item| item.state == LidarResultState::Preparing)
        .map(|item| item.id)
        .collect();
    assert_eq!(preparing, Vec::<String>::new());
    assert!(matches!(
        reopened.inner.status,
        recovery::LibraryOpenStatus::Recovered { .. }
    ));
    let _ = std::fs::remove_dir_all(&root);
}

/// Through the real commands: Cancel returns once the item is gone, while
/// the cancelled job may still be settling under the heavy lease. Importing
/// the same file then waits for that job to let go instead of refusing it
/// for a job the library no longer shows.
#[test]
fn importing_again_waits_for_a_cancelled_job_to_let_go() {
    use crate::commands::lidar::{lidar_cancel_import, lidar_import_item};
    use tauri::Manager;
    let root = scratch("cancel-reimport");
    let library = LidarLibrary::open(&root).unwrap();
    let executor = crate::native_operation::NativeOperationExecutor::production();
    library.attach_executor(executor.clone());
    let app = tauri::test::mock_builder()
        .manage(library.clone())
        .manage(executor)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let source = plane(&library, &root, "orchard", 445_000.0);
    // Held, the display registry keeps the job from reaching its next step.
    let display = library.display().unwrap();
    let receipt = library
        .import_item(
            "Orchard",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![source.clone()],
        )
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while library
        .get_import_job(&receipt.job_id)
        .unwrap()
        .unwrap()
        .state
        != LidarImportJobState::Applying
    {
        assert!(
            std::time::Instant::now() < deadline,
            "the import never prepared"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    tauri::async_runtime::block_on(lidar_cancel_import(
        app.state(),
        app.state(),
        receipt.job_id.clone(),
    ))
    .unwrap();
    assert!(library.library_snapshot().unwrap().items.is_empty());

    let (sent, imported) = std::sync::mpsc::channel();
    let handle = app.handle().clone();
    let path = source.display().to_string();
    std::thread::spawn(move || {
        let _ = sent.send(tauri::async_runtime::block_on(lidar_import_item(
            handle.state(),
            handle.state(),
            "Orchard".to_string(),
            RasterQuantity::GroundElevation,
            None,
            None,
            vec![path],
        )));
    });
    let early = imported.recv_timeout(std::time::Duration::from_millis(300));
    assert!(
        early.is_err(),
        "Import waits while the cancelled job settles: {early:?}"
    );
    drop(display);
    let again = imported
        .recv_timeout(std::time::Duration::from_secs(60))
        .unwrap()
        .unwrap();
    assert_eq!(
        await_import(&library, &again.job_id),
        LidarImportJobState::Complete
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// Through the real commands (user, 2026-10-09): Cancel on a Retry puts the
/// item back to Failed with Retry instead of deleting it. A rebuilt item keeps
/// its managed original and the `meta.json` that names it, so a later
/// catalogue rebuild still recovers it.
#[test]
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn cancelling_a_retry_puts_a_rebuilt_item_back_to_failed_and_a_rebuild_recovers_it() {
    use crate::commands::lidar::{lidar_cancel_import, lidar_retry_import};
    use tauri::Manager;
    let workbench = scratch("cancel-retry-tile");
    let tile = plane(&attached_library(&workbench), &workbench, "tile", 445_000.0);
    let root = scratch("cancel-retry");
    let (library, layer_id) = rebuilt_library(&root, &tile, "sha-kept");
    let executor = crate::native_operation::NativeOperationExecutor::production();
    library.attach_executor(executor.clone());
    let app = tauri::test::mock_builder()
        .manage(library.clone())
        .manage(executor)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    // Held, the display registry keeps the retry from reaching publication.
    let display = library.display().unwrap();
    let receipt = tauri::async_runtime::block_on(lidar_retry_import(
        app.state(),
        app.state(),
        layer_id.clone(),
    ))
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while library
        .get_import_job(&receipt.job_id)
        .unwrap()
        .unwrap()
        .state
        != LidarImportJobState::Applying
    {
        assert!(
            std::time::Instant::now() < deadline,
            "the retry never prepared"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    tauri::async_runtime::block_on(lidar_cancel_import(
        app.state(),
        app.state(),
        receipt.job_id.clone(),
    ))
    .unwrap();
    let back_to_failed = |library: &LidarLibrary| {
        let snapshot = library.library_snapshot().unwrap();
        let listed = item(&snapshot.items, &layer_id);
        assert_eq!(listed.state, LidarResultState::Failed);
        let job = listed.import_job.as_ref().expect("Retry is offered");
        assert_eq!(job.state, LidarImportJobState::Failed);
        assert_ne!(job.job_id, receipt.job_id, "the cancelled retry is gone");
    };
    back_to_failed(&library);
    drop(display);
    await_settled(&library, &receipt.job_id);
    back_to_failed(&library);
    let original = library.inner.paths.source_original("sha-kept");
    assert!(original.is_file(), "the managed original is kept");
    let meta = source_meta::read(&library.inner.paths.source_meta("sha-kept"))
        .expect("the original's meta is kept");
    assert_eq!(
        meta.items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        [layer_id.as_str()],
        "the meta still names the item"
    );

    // The mock app keeps its managed library, and so the catalogue
    // connection, until the process ends, and Windows cannot set aside a
    // catalogue another connection holds (`close`). The rebuild therefore
    // opens a copy: the catalogue as an older Canopi left it, and the
    // originals with their `meta.json`, which are all a rebuild reads.
    let copy = scratch("cancel-retry-reopened");
    let copied = paths::library_root(&copy);
    std::fs::create_dir_all(&copied).unwrap();
    {
        let connection = library.catalogue().unwrap();
        connection
            .execute(
                "UPDATE lidar_catalogue_meta SET value = '24' WHERE key = 'schema_version'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "VACUUM INTO ?1",
                [copied.join(paths::CATALOGUE_FILE).to_str().unwrap()],
            )
            .unwrap();
    }
    let kept = library.inner.paths.source_dir("sha-kept");
    let copied_source = copied.join("sources").join("sha-kept");
    std::fs::create_dir_all(&copied_source).unwrap();
    for name in ["original", source_meta::META_FILE] {
        std::fs::copy(kept.join(name), copied_source.join(name)).unwrap();
    }
    drop(app);
    let reopened = LidarLibrary::open(&copy).unwrap();
    assert!(matches!(
        reopened.open_status(),
        recovery::LibraryOpenStatus::Recovered {
            items: 1,
            generated: 0,
            ..
        }
    ));
    let snapshot = reopened.library_snapshot().unwrap();
    let recovered = item(&snapshot.items, &layer_id);
    assert_eq!(recovered.name.as_deref(), Some("Orchard"));
    assert_eq!(recovered.state, LidarResultState::Failed);
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&copy);
    let _ = std::fs::remove_dir_all(&workbench);
}

/// Through the real commands: a rebuilt item's Retry cancelled, then
/// Dismiss, clicked while the cancelled job may still be settling, frees the
/// managed original the item's saved selection named, with its row and its
/// `meta.json`: nothing of the item stays on disk or in the catalogue.
#[test]
fn dismissing_a_rebuilt_item_after_a_cancelled_retry_frees_its_originals() {
    use crate::commands::lidar::{lidar_cancel_import, lidar_dismiss_import, lidar_retry_import};
    use tauri::Manager;
    let workbench = scratch("dismiss-rebuilt-tile");
    let tile = plane(&attached_library(&workbench), &workbench, "tile", 445_000.0);
    let root = scratch("dismiss-rebuilt");
    let (library, layer_id) = rebuilt_library(&root, &tile, "sha-kept");
    let executor = crate::native_operation::NativeOperationExecutor::production();
    library.attach_executor(executor.clone());
    let app = tauri::test::mock_builder()
        .manage(library.clone())
        .manage(executor)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    // Held, the display registry keeps the retry from reaching publication.
    let display = library.display().unwrap();
    let receipt = tauri::async_runtime::block_on(lidar_retry_import(
        app.state(),
        app.state(),
        layer_id.clone(),
    ))
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while library
        .get_import_job(&receipt.job_id)
        .unwrap()
        .unwrap()
        .state
        != LidarImportJobState::Applying
    {
        assert!(
            std::time::Instant::now() < deadline,
            "the retry never prepared"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    tauri::async_runtime::block_on(lidar_cancel_import(
        app.state(),
        app.state(),
        receipt.job_id.clone(),
    ))
    .unwrap();
    drop(display);

    tauri::async_runtime::block_on(lidar_dismiss_import(
        app.state(),
        app.state(),
        layer_id.clone(),
    ))
    .unwrap();

    await_settled(&library, &receipt.job_id);
    assert!(library.library_snapshot().unwrap().items.is_empty());
    assert_eq!(import_rows(&library), no_import_rows());
    assert_eq!(library_files(&library), Vec::<PathBuf>::new());
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&workbench);
}

/// Through the real commands: a rebuilt item's Retry that fails with no
/// cancel shows Failed, with Dismiss, while its job still holds the heavy
/// lease to free its files; Dismiss clicked then waits for that settlement
/// instead of being refused, and frees the item's originals.
#[test]
fn dismissing_while_a_failed_retry_still_settles_waits_for_it() {
    use crate::commands::lidar::{lidar_dismiss_import, lidar_retry_import};
    use tauri::Manager;
    let workbench = scratch("dismiss-settling-tiles");
    let west = plane(&attached_library(&workbench), &workbench, "west", 445_000.0);
    // Half a cell off, so the retry stages both and then fails as a whole.
    let shifted = plane(
        &attached_library(&workbench),
        &workbench,
        "shifted",
        445_000.5,
    );
    let root = scratch("dismiss-settling");
    let (library, layer_id) = rebuilt_item(
        &root,
        &[
            (west.as_path(), "sha-west", "west.tif"),
            (shifted.as_path(), "sha-shifted", "shifted.tif"),
        ],
    );
    let executor = crate::native_operation::NativeOperationExecutor::production();
    library.attach_executor(executor.clone());
    let app = tauri::test::mock_builder()
        .manage(library.clone())
        .manage(executor)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    // Held, the display registry keeps the failed job's settlement, which
    // frees its staged COGs, from finishing.
    let display = library.display().unwrap();
    let receipt = tauri::async_runtime::block_on(lidar_retry_import(
        app.state(),
        app.state(),
        layer_id.clone(),
    ))
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while library
        .get_import_job(&receipt.job_id)
        .unwrap()
        .unwrap()
        .state
        != LidarImportJobState::Failed
    {
        assert!(
            std::time::Instant::now() < deadline,
            "the retry never failed"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    let handle = app.handle().clone();
    let dismissing = layer_id.clone();
    let (sent, dismissed) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let outcome = tauri::async_runtime::block_on(lidar_dismiss_import(
            handle.state(),
            handle.state(),
            dismissing,
        ));
        let _ = sent.send(outcome);
    });
    assert!(
        dismissed
            .recv_timeout(std::time::Duration::from_millis(300))
            .is_err(),
        "Dismiss waits for the item's settling job"
    );
    drop(display);
    dismissed
        .recv_timeout(std::time::Duration::from_secs(60))
        .unwrap()
        .unwrap();

    await_settled(&library, &receipt.job_id);
    assert!(library.library_snapshot().unwrap().items.is_empty());
    assert_eq!(import_rows(&library), no_import_rows());
    assert_eq!(library_files(&library), Vec::<PathBuf>::new());
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&workbench);
}

/// Two rebuilt items whose saved selections share one managed original:
/// dismissing one keeps the original, its row and the other item, whose
/// `meta.json` then names it alone; dismissing the other frees the original.
#[test]
fn dismissing_one_of_two_rebuilt_items_sharing_an_original_keeps_it() {
    let workbench = scratch("dismiss-shared-rebuilt-tile");
    let tile = plane(&attached_library(&workbench), &workbench, "tile", 445_000.0);
    let root = scratch("dismiss-shared-rebuilt");
    let lidar = paths::library_root(&root);
    let dir = lidar.join("sources").join("sha-shared");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(&tile, dir.join("original")).unwrap();
    let member_of = |id: &str, name: &str, created_at: &str| source_meta::ItemMeta {
        id: id.to_string(),
        name: name.to_string(),
        quantity: RasterQuantity::GroundElevation.key().to_string(),
        units: "m".to_string(),
        created_at: created_at.to_string(),
        members: vec!["sha-shared".to_string()],
        analyses: Vec::new(),
    };
    let meta = source_meta::SourceMeta {
        version: source_meta::META_VERSION,
        sha256: "sha-shared".to_string(),
        original_filename: "tile.tif".to_string(),
        size_bytes: std::fs::metadata(&tile).unwrap().len(),
        imported_at: "10".to_string(),
        items: vec![
            member_of("lyr-first", "First", "10"),
            member_of("lyr-second", "Second", "11"),
        ],
    };
    source_meta::write(&dir.join(source_meta::META_FILE), &meta).unwrap();
    std::fs::write(lidar.join(paths::CATALOGUE_FILE), b"not a catalogue").unwrap();
    let library = attached_library(&root);
    assert!(matches!(
        library.open_status(),
        recovery::LibraryOpenStatus::Recovered { items: 2, .. }
    ));

    library.dismiss_import("lyr-first").unwrap();
    let original = library.inner.paths.source_original("sha-shared");
    assert!(original.is_file(), "the shared original stays");
    assert_eq!(
        count(
            &library,
            "SELECT COUNT(*) FROM lidar_sources WHERE sha256 = 'sha-shared'"
        ),
        1
    );
    let snapshot = library.library_snapshot().unwrap();
    assert_eq!(snapshot.items.len(), 1);
    item(&snapshot.items, "lyr-second");
    let meta = source_meta::read(&library.inner.paths.source_meta("sha-shared")).unwrap();
    assert_eq!(
        meta.items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["lyr-second"]
    );

    library.dismiss_import("lyr-second").unwrap();
    assert_eq!(import_rows(&library), no_import_rows());
    assert_eq!(library_files(&library), Vec::<PathBuf>::new());
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&workbench);
}

/// A rebuilt item whose managed original a published item also uses:
/// dismissing the rebuilt item keeps the original, its row and the published
/// item.
#[test]
fn dismissing_a_rebuilt_item_keeps_an_original_a_published_item_uses() {
    use sha2::Digest;
    let workbench = scratch("dismiss-published-shared-tile");
    let tile = plane(&attached_library(&workbench), &workbench, "tile", 445_000.0);
    let sha256 = format!("{:x}", sha2::Sha256::digest(std::fs::read(&tile).unwrap()));
    let root = scratch("dismiss-published-shared");
    let (library, layer_id) = rebuilt_library(&root, &tile, &sha256);
    let published = library
        .import_item(
            "Published",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![tile.clone()],
        )
        .unwrap();
    assert_eq!(
        await_import(&library, &published.job_id),
        LidarImportJobState::Complete
    );

    library.dismiss_import(&layer_id).unwrap();

    assert!(library.inner.paths.source_original(&sha256).is_file());
    assert_eq!(
        library
            .catalogue()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM lidar_sources WHERE sha256 = ?1",
                [&sha256],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
    let snapshot = library.library_snapshot().unwrap();
    assert_eq!(snapshot.items.len(), 1);
    assert!(
        item(&snapshot.items, &published.layer_id)
            .generation_id
            .is_some()
    );
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&workbench);
}

/// Dismiss frees a rebuilt item's originals under the heavy lease, as a
/// settling import does, so it is refused while another raster job runs and
/// changes nothing; once that job has finished it frees them.
#[test]
fn dismissing_a_rebuilt_item_waits_for_no_other_raster_job() {
    let workbench = scratch("dismiss-rebuilt-leased-tile");
    let tile = plane(&attached_library(&workbench), &workbench, "tile", 445_000.0);
    let root = scratch("dismiss-rebuilt-leased");
    let (library, layer_id) = rebuilt_library(&root, &tile, "sha-kept");
    let files = library_files(&library);

    let other = HeavyJobLease::acquire(&library, "imp-other").unwrap();
    let refused = library.dismiss_import(&layer_id).unwrap_err();
    assert!(refused.contains("already running"), "{refused}");
    assert_eq!(library.library_snapshot().unwrap().items.len(), 1);
    assert_eq!(library_files(&library), files);

    drop(other);
    library.dismiss_import(&layer_id).unwrap();
    assert_eq!(import_rows(&library), no_import_rows());
    assert_eq!(library_files(&library), Vec::<PathBuf>::new());
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&workbench);
}

/// A Dismiss that stops after its catalogue commit, before its originals'
/// folders go (a crash), never lets a catalogue rebuild list the item again:
/// each released original's `meta.json` names no item before the commit.
#[test]
fn a_rebuild_after_a_dismiss_stopped_before_its_folders_went_lists_nothing() {
    let workbench = scratch("dismiss-crash-rebuild-tile");
    let tile = plane(&attached_library(&workbench), &workbench, "tile", 445_000.0);
    let root = scratch("dismiss-crash-rebuild");
    let (library, layer_id) = rebuilt_library(&root, &tile, "sha-kept");

    drop(library.release_dismissed_item(&layer_id).unwrap());
    assert_eq!(import_rows(&library), no_import_rows());
    assert!(library.inner.paths.source_original("sha-kept").is_file());
    let meta = source_meta::read(&library.inner.paths.source_meta("sha-kept"))
        .expect("the released original's meta");
    assert!(meta.items.is_empty(), "the meta names no item");

    close(library);
    std::fs::write(
        paths::library_root(&root).join(paths::CATALOGUE_FILE),
        b"not a catalogue",
    )
    .unwrap();
    let reopened = LidarLibrary::open(&root).unwrap();
    assert!(matches!(
        reopened.open_status(),
        recovery::LibraryOpenStatus::Recovered {
            items: 0,
            generated: 0,
            ..
        }
    ));
    assert!(reopened.library_snapshot().unwrap().items.is_empty());
    assert!(!reopened.inner.paths.source_dir("sha-kept").exists());
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&workbench);
}

/// The next start removes the folders of originals a Dismiss released but
/// stopped short of removing: no catalogue row and no `meta.json` item
/// claims them.
#[test]
fn reopening_after_a_dismiss_stopped_before_its_folders_went_removes_them() {
    let workbench = scratch("dismiss-crash-reopen-tile");
    let tile = plane(&attached_library(&workbench), &workbench, "tile", 445_000.0);
    let root = scratch("dismiss-crash-reopen");
    let (library, layer_id) = rebuilt_library(&root, &tile, "sha-kept");

    drop(library.release_dismissed_item(&layer_id).unwrap());
    let folder = library.inner.paths.source_dir("sha-kept");
    assert!(folder.is_dir(), "the stop kept the folder");
    close(library);

    let reopened = LidarLibrary::open(&root).unwrap();
    assert!(matches!(
        reopened.open_status(),
        recovery::LibraryOpenStatus::Ready
    ));
    assert!(!folder.exists(), "the next start removed the folder");
    assert!(reopened.library_snapshot().unwrap().items.is_empty());
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&workbench);
}

/// A released original's folder that Dismiss could not remove stays hidden
/// and goes at the next start.
#[cfg(unix)]
#[test]
fn an_original_dismiss_could_not_remove_goes_at_the_next_start() {
    use std::os::unix::fs::PermissionsExt;
    let workbench = scratch("dismiss-remove-fails-tile");
    let tile = plane(&attached_library(&workbench), &workbench, "tile", 445_000.0);
    let root = scratch("dismiss-remove-fails");
    let (library, layer_id) = rebuilt_library(&root, &tile, "sha-kept");
    let folder = library.inner.paths.source_dir("sha-kept");
    let locked = folder.join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::write(locked.join("file"), b"kept").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();

    library.dismiss_import(&layer_id).unwrap();
    assert!(folder.is_dir(), "the removal failed");
    assert!(library.library_snapshot().unwrap().items.is_empty());
    assert_eq!(import_rows(&library), no_import_rows());
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
    close(library);

    let reopened = LidarLibrary::open(&root).unwrap();
    assert!(!folder.exists(), "the next start removed the folder");
    assert!(reopened.library_snapshot().unwrap().items.is_empty());
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&workbench);
}

/// Cancel deletes the half-imported item at once, and the job's settlement
/// removes every file it wrote: nothing is listed, nothing stays on disk,
/// and the same file imports again under the same name (user, 2026-10-09).
#[test]
fn cancelling_an_import_deletes_its_item_and_every_file_it_wrote() {
    let root = scratch("cancel-deletes");
    let library = attached_library(&root);
    let source = plane(&library, &root, "orchard", 445_000.0);
    // Held, the display registry stops the job after preparation, when its
    // original, staged COG and staging record are all on disk.
    let display = library.display().unwrap();
    let receipt = library
        .import_item(
            "Orchard",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![source.clone()],
        )
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while library
        .get_import_job(&receipt.job_id)
        .unwrap()
        .unwrap()
        .state
        != LidarImportJobState::Applying
    {
        assert!(
            std::time::Instant::now() < deadline,
            "the import never prepared"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(!library_files(&library).is_empty(), "the job wrote files");

    library.cancel_import(&receipt.job_id).unwrap();
    assert!(
        library.library_snapshot().unwrap().items.is_empty(),
        "the item is gone at once"
    );
    drop(display);
    await_settled(&library, &receipt.job_id);

    assert_eq!(import_rows(&library), no_import_rows());
    assert_eq!(library_files(&library), Vec::<PathBuf>::new());

    let again = library
        .import_item(
            "Orchard",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![source],
        )
        .unwrap();
    assert_eq!(
        await_import(&library, &again.job_id),
        LidarImportJobState::Complete
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// A cancel that reaches an import after it published leaves the finished
/// item, never half of it.
#[test]
fn a_cancel_after_publication_keeps_the_finished_item() {
    let root = scratch("cancel-after-publish");
    let library = attached_library(&root);
    let source = plane(&library, &root, "orchard", 445_000.0);
    let receipt = library
        .import_item(
            "Orchard",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![source],
        )
        .unwrap();
    assert_eq!(
        await_import(&library, &receipt.job_id),
        LidarImportJobState::Complete
    );
    let files = library_files(&library);
    let rows = import_rows(&library);

    library.cancel_import(&receipt.job_id).unwrap();

    let snapshot = library.library_snapshot().unwrap();
    assert!(
        item(&snapshot.items, &receipt.layer_id)
            .generation_id
            .is_some()
    );
    assert_eq!(import_rows(&library), rows);
    assert_eq!(library_files(&library), files);
    let _ = std::fs::remove_dir_all(&root);
}

/// A cancel that lands just before publication commits wins: publication is
/// refused and the settlement removes the staged originals, the promoted COG
/// and the display derivatives the job prepared.
#[test]
fn a_cancel_before_the_publication_commits_leaves_nothing() {
    let root = scratch("cancel-before-commit");
    let library = attached_library(&root);
    let source = plane(&library, &root, "orchard", 445_000.0);
    let cancel = AtomicBool::new(false);
    let (layer_id, job_id) = library
        .record_import_item(
            "Orchard",
            RasterQuantity::GroundElevation,
            None,
            false,
            std::slice::from_ref(&source),
        )
        .unwrap();
    import::stage_import(&library, &job_id, &layer_id, &[source], &cancel).unwrap();
    let staging = import::read_staged_import(&library, &job_id).unwrap();
    library.prepare_staged_display(&staging, &cancel).unwrap();
    assert!(
        import_rows(&library)
            .iter()
            .any(|(table, rows)| *table == "display_cogs" && *rows > 0),
        "the job prepared its display derivative"
    );

    library.cancel_import(&job_id).unwrap();
    import::apply_import(&library, &staging, &cancel)
        .expect_err("a cancelled import never publishes");
    library.discard_import_job_files(&job_id);

    assert_eq!(import_rows(&library), no_import_rows());
    assert_eq!(library_files(&library), Vec::<PathBuf>::new());
    let _ = std::fs::remove_dir_all(&root);
}

/// A cancelled import of a file another item already published frees only
/// what it wrote itself: the published item's original, COG and display
/// derivative stay.
#[test]
fn a_cancelled_import_keeps_the_files_a_published_item_shares() {
    let root = scratch("cancel-shared");
    let library = attached_library(&root);
    let source = plane(&library, &root, "orchard", 445_000.0);
    let first = library
        .import_item(
            "Orchard",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![source.clone()],
        )
        .unwrap();
    assert_eq!(
        await_import(&library, &first.job_id),
        LidarImportJobState::Complete
    );
    let files = library_files(&library);
    let cancel = AtomicBool::new(false);
    let (layer_id, job_id) = library
        .record_import_item(
            "Orchard again",
            RasterQuantity::GroundElevation,
            None,
            false,
            std::slice::from_ref(&source),
        )
        .unwrap();
    import::stage_import(&library, &job_id, &layer_id, &[source], &cancel).unwrap();
    let staging = import::read_staged_import(&library, &job_id).unwrap();
    library.prepare_staged_display(&staging, &cancel).unwrap();

    library.cancel_import(&job_id).unwrap();
    library.discard_import_job_files(&job_id);

    assert_eq!(library_files(&library), files);
    let snapshot = library.library_snapshot().unwrap();
    assert_eq!(snapshot.items.len(), 1);
    assert!(
        item(&snapshot.items, &first.layer_id)
            .generation_id
            .is_some()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// A failed import keeps its item for Retry, but no file: once dismissed,
/// nothing of it is left on disk or in the catalogue.
#[test]
fn dismissing_a_failed_import_leaves_no_file_behind() {
    let root = scratch("dismiss-frees");
    let library = attached_library(&root);
    let west = plane(&library, &root, "west", 445_000.0);
    // Half a cell off the first source's lattice: both originals are copied
    // and prepared before the batch is refused.
    let east = plane(&library, &root, "east", 445_064.5);
    let receipt = library
        .import_item(
            "Pair",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![west, east],
        )
        .unwrap();
    assert_eq!(
        await_import(&library, &receipt.job_id),
        LidarImportJobState::Failed
    );

    library.dismiss_import(&receipt.layer_id).unwrap();

    assert_eq!(import_rows(&library), no_import_rows());
    assert_eq!(library_files(&library), Vec::<PathBuf>::new());
    let _ = std::fs::remove_dir_all(&root);
}

/// The kind a refusal crosses IPC with: `null` for one that is only text.
fn refusal_kind(error: &impl serde::Serialize) -> serde_json::Value {
    serde_json::to_value(error).unwrap()["reason"]["kind"].clone()
}

/// canopi-bkbh: Import and Retry refusals carry their kind, so the frontend
/// names each in the interface language; the detail stays English.
#[test]
fn import_and_retry_refusals_carry_their_kind() {
    let root = scratch("refusal-kinds");
    let library = attached_library(&root);
    let import = |source: PathBuf| {
        library
            .import_item(
                "Refused",
                RasterQuantity::GroundElevation,
                None,
                false,
                vec![source],
            )
            .unwrap_err()
    };
    assert_eq!(
        refusal_kind(&import(root.join("gone.tif"))),
        "SourceMissing"
    );
    let ascii = root.join("dem.asc");
    std::fs::write(&ascii, "ncols 1\nnrows 1\n").unwrap();
    assert_eq!(refusal_kind(&import(ascii)), "NotGeotiff");
    let refused =
        serde_json::to_value(import(plane_in_code(&library, &root, "nyc", 2263))).unwrap();
    assert_eq!(
        refused["reason"],
        serde_json::json!({ "kind": "UnsupportedCrs", "file": "nyc.tif", "crs": "EPSG:2263" })
    );

    let layer_id = failed_import(&library, root.join("lost.tif"), "first failure");
    assert_eq!(
        refusal_kind(&library.retry_import(&layer_id).unwrap_err()),
        "SourceMissing"
    );
    let tile = plane(&library, &root, "terrain", 445_000.0);
    let lease = HeavyJobLease::acquire(&library, "imp-running").unwrap();
    assert_eq!(refusal_kind(&import(tile)), "JobRunning");
    drop(lease);
    let _ = std::fs::remove_dir_all(&root);
}

/// canopi-9m01: a GeoTIFF whose header reads but whose data is cut short is
/// accepted at Import and fails as a job; the job keeps the engine's detail,
/// by file name, for diagnostics.
#[test]
fn a_truncated_geotiff_fails_as_a_job_with_its_detail_kept() {
    let root = scratch("import-truncated");
    let library = attached_library(&root);
    let source = plane(&library, &root, "truncated", 445_000.0);
    let bytes = std::fs::read(&source).unwrap();
    std::fs::write(&source, &bytes[..bytes.len() * 3 / 4]).unwrap();
    let receipt = library
        .import_item(
            "Truncated",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![source],
        )
        .expect("the header reads, so Import accepts the file");
    assert_eq!(
        await_import(&library, &receipt.job_id),
        LidarImportJobState::Failed
    );
    let detail = row_message(&library, &receipt.layer_id);
    assert!(detail.contains("truncated.tif"), "{detail}");
    assert!(!detail.contains(&root.display().to_string()), "{detail}");
    let _ = std::fs::remove_dir_all(&root);
}

/// An item imported from `tile` and settled, as the app shows it.
fn imported(library: &LidarLibrary, name: &str, tile: &Path) -> String {
    let receipt = library
        .import_item(
            name,
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![tile.to_path_buf()],
        )
        .unwrap();
    assert_eq!(
        await_import(library, &receipt.job_id),
        LidarImportJobState::Complete
    );
    receipt.layer_id
}

/// canopi-44vf, through the real command: Delete everywhere frees the item's
/// original, its source COG, its display derivatives and its settled job's
/// folder, so disk use drops.
#[test]
fn deleting_an_item_everywhere_frees_its_files() {
    use tauri::Manager;
    let root = scratch("delete-frees");
    let library = LidarLibrary::open(&root).unwrap();
    let executor = crate::native_operation::NativeOperationExecutor::production();
    library.attach_executor(executor.clone());
    let app = tauri::test::mock_builder()
        .manage(library.clone())
        .manage(executor)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let tile = plane(&library, &root, "tile", 445_000.0);
    let layer_id = imported(&library, "Tile", &tile);
    library
        .prepare_display_now(LibraryItemRole::Source, &layer_id)
        .unwrap();
    assert!(!library_files(&library).is_empty());
    assert!(
        !display_cog::registered_derivative_keys(&library)
            .unwrap()
            .is_empty()
    );

    tauri::async_runtime::block_on(crate::commands::lidar::lidar_delete_item(
        app.state(),
        app.state(),
        layer_id,
    ))
    .unwrap();
    assert_eq!(library_files(&library), Vec::<PathBuf>::new());
    assert_eq!(
        display_cog::registered_derivative_keys(&library).unwrap(),
        Vec::<String>::new()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// canopi-44vf: deleting one of two items imported from the same file keeps
/// what the other still draws from; deleting the second frees everything.
#[test]
fn deleting_one_of_two_items_sharing_a_file_keeps_it_for_the_other() {
    let root = scratch("delete-shared");
    let library = attached_library(&root);
    let tile = plane(&library, &root, "tile", 445_000.0);
    let first = imported(&library, "First", &tile);
    let second = imported(&library, "Second", &tile);
    library
        .prepare_display_now(LibraryItemRole::Source, &first)
        .unwrap();

    library.delete_item(&first).unwrap();
    for relief in [false, true] {
        let descriptor = library
            .display_descriptor(&LidarDisplayRequest {
                kind: LibraryItemRole::Source,
                entity_id: second.clone(),
                expected_generation_id: None,
                retry: false,
                relief,
            })
            .unwrap();
        assert_eq!(descriptor.state, LidarDisplayState::Ready, "{descriptor:?}");
        for asset in &descriptor.assets {
            assert!(Path::new(&asset.path).is_file(), "{} is kept", asset.path);
        }
    }

    library.delete_item(&second).unwrap();
    assert_eq!(library_files(&library), Vec::<PathBuf>::new());
    let _ = std::fs::remove_dir_all(&root);
}

/// canopi-44vf: deleting a calculated result frees its chunks and its display
/// derivatives; its input keeps every file of its own.
#[test]
fn deleting_a_result_frees_its_chunks_and_derivatives() {
    let root = scratch("delete-result");
    let library = attached_library(&root);
    let tile = plane(&library, &root, "tile", 445_000.0);
    let layer_id = imported(&library, "Tile", &tile);
    library
        .prepare_display_now(LibraryItemRole::Source, &layer_id)
        .unwrap();
    let kept_files = library_files(&library);
    let kept_keys = display_cog::registered_derivative_keys(&library).unwrap();
    let source_generation = catalogue::head_generation(&library.catalogue().unwrap(), &layer_id)
        .unwrap()
        .unwrap()
        .id;
    let result = "item-slope".to_string();
    seed_result(
        &library.catalogue().unwrap(),
        &layer_id,
        &result,
        &source_generation,
    );
    generation::publish_test_chunk(&library, "dgen-item-slope", 0, 0, 4, 4, &[1.0f32; 16]);
    library
        .prepare_display_now(LibraryItemRole::Derived, &result)
        .unwrap();
    assert_ne!(library_files(&library), kept_files);

    library.delete_item(&result).unwrap();
    assert_eq!(library_files(&library), kept_files);
    assert_eq!(
        display_cog::registered_derivative_keys(&library).unwrap(),
        kept_keys
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// canopi-44vf: Delete while another raster job holds the heavy lease removes
/// the item at once and leaves its files, which that job might be staging
/// again; the next start frees them, display derivatives included.
#[test]
fn deleting_while_another_raster_job_runs_frees_the_files_at_the_next_start() {
    let root = scratch("delete-busy");
    let library = attached_library(&root);
    let tile = plane(&library, &root, "tile", 445_000.0);
    let layer_id = imported(&library, "Tile", &tile);
    library
        .prepare_display_now(LibraryItemRole::Source, &layer_id)
        .unwrap();
    let files = library_files(&library);

    let lease = HeavyJobLease::acquire(&library, "imp-running").unwrap();
    library.delete_item(&layer_id).unwrap();
    assert!(library.library_snapshot().unwrap().items.is_empty());
    assert_eq!(library_files(&library), files, "kept while the job runs");
    drop(lease);
    close(library);

    let reopened = attached_library(&root);
    assert_eq!(library_files(&reopened), Vec::<PathBuf>::new());
    assert_eq!(
        display_cog::registered_derivative_keys(&reopened).unwrap(),
        Vec::<String>::new()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// canopi-44vf: a file Delete cannot remove never fails the committed
/// Delete; the item is gone, and the next start frees what was left.
#[cfg(unix)]
#[test]
fn a_failing_removal_never_fails_a_committed_delete() {
    use std::os::unix::fs::PermissionsExt;
    let root = scratch("delete-locked");
    let library = attached_library(&root);
    let tile = plane(&library, &root, "tile", 445_000.0);
    let layer_id = imported(&library, "Tile", &tile);
    let originals: Vec<PathBuf> = std::fs::read_dir(library.inner.paths.root().join("sources"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(originals.len(), 1);
    let locked = &originals[0];
    std::fs::set_permissions(locked, std::fs::Permissions::from_mode(0o555)).unwrap();

    let deleted = library.delete_item(&layer_id);
    std::fs::set_permissions(locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    deleted.unwrap();
    assert!(library.library_snapshot().unwrap().items.is_empty());
    close(library);

    let reopened = attached_library(&root);
    assert_eq!(library_files(&reopened), Vec::<PathBuf>::new());
    let _ = std::fs::remove_dir_all(&root);
}

/// Two tiles imported as one item: the item and its two `sources/<sha256>/`
/// folders, the first one's locked read-only.
#[cfg(unix)]
fn two_tile_item_with_one_locked_original(
    library: &LidarLibrary,
    root: &Path,
) -> (String, PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let west = plane(library, root, "west", 445_000.0);
    let east = plane(library, root, "east", 445_064.0);
    let receipt = library
        .import_item(
            "Tiles",
            RasterQuantity::GroundElevation,
            None,
            false,
            vec![west, east],
        )
        .unwrap();
    assert_eq!(
        await_import(library, &receipt.job_id),
        LidarImportJobState::Complete
    );
    let mut folders: Vec<PathBuf> = std::fs::read_dir(library.inner.paths.root().join("sources"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    folders.sort();
    assert_eq!(folders.len(), 2);
    std::fs::set_permissions(&folders[0], std::fs::Permissions::from_mode(0o555)).unwrap();
    (receipt.layer_id, folders.remove(0), folders.remove(0))
}

/// An original whose meta cannot be released keeps only its own files: a
/// committed Delete still frees every other original it no longer claims.
#[cfg(unix)]
#[test]
fn an_unwritable_original_never_keeps_another_deleted_original() {
    use std::os::unix::fs::PermissionsExt;
    let root = scratch("delete-one-locked");
    let library = attached_library(&root);
    let (layer_id, locked, free) = two_tile_item_with_one_locked_original(&library, &root);

    let deleted = library.delete_item(&layer_id);
    let free_kept = free.exists();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    deleted.unwrap();
    assert!(!free_kept, "the writable original is freed at once");
    assert!(
        locked.exists(),
        "the locked original waits for the next start"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// The start-up release skips an original whose meta cannot be released and
/// still frees every other original nothing claims.
#[cfg(unix)]
#[test]
fn an_unwritable_original_never_keeps_another_original_at_the_next_start() {
    use std::os::unix::fs::PermissionsExt;
    let root = scratch("prune-one-locked");
    let library = attached_library(&root);
    let (layer_id, locked, free) = two_tile_item_with_one_locked_original(&library, &root);
    let lease = HeavyJobLease::acquire(&library, "imp-running").unwrap();
    library.delete_item(&layer_id).unwrap();
    drop(lease);
    assert!(free.exists(), "kept while the job runs");
    close(library);

    let reopened = attached_library(&root);
    let free_kept = free.exists();
    let files = library_files(&reopened);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!free_kept, "the writable original is freed at start");
    assert!(
        locked.exists(),
        "the locked original waits for a later start"
    );
    assert!(
        files.iter().all(|file| !file.starts_with(&free)),
        "{files:?}"
    );
    close(reopened);
    let reopened = attached_library(&root);
    assert_eq!(library_files(&reopened), Vec::<PathBuf>::new());
    let _ = std::fs::remove_dir_all(&root);
}

/// Import, Retry and Dismiss wait while Delete or Dismiss frees files under
/// the heavy lease, instead of refusing as if an import or calculation ran.
#[test]
fn work_admitted_after_stopping_jobs_waits_for_files_being_freed() {
    let root = scratch("await-freeing");
    let library = attached_library(&root);
    let freeing = HeavyJobLease::acquire_for_freeing(&library).unwrap();
    let (sent, waited) = std::sync::mpsc::channel();
    let waiting = library.clone();
    std::thread::spawn(move || {
        tauri::async_runtime::block_on(waiting.await_stopping_jobs());
        let _ = sent.send(());
    });
    assert!(
        waited
            .recv_timeout(std::time::Duration::from_millis(300))
            .is_err(),
        "waits while files are freed"
    );
    drop(freeing);
    waited
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("admitted once the files are freed");

    let running = HeavyJobLease::acquire(&library, "imp-running").unwrap();
    tauri::async_runtime::block_on(library.await_stopping_jobs());
    drop(running);
    let _ = std::fs::remove_dir_all(&root);
}

/// D6: a job failure shows only the generic message, so its reason reaches
/// the log a problem report carries; a cancelled job logs no failure.
#[test]
fn a_failed_job_logs_its_reason_for_the_problem_report() {
    #[derive(Clone, Default)]
    struct Captured(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl std::io::Write for Captured {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let root = scratch("failure-logged");
    let library = attached_library(&root);
    let tile = plane(&library, &root, "tile", 445_000.0);
    let log = Captured::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer({
            let log = log.clone();
            move || log.clone()
        })
        .with_ansi(false)
        .with_max_level(tracing::Level::WARN)
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        failed_import(&library, tile, "tiling failed on tile.tif");
        library.fail_analysis_job("anl-broken", "the engine stopped on slope");
        library.fail_analysis_job("anl-stopped", "cancelled");
    });
    let written = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
    assert!(written.contains("tiling failed on tile.tif"), "{written}");
    assert!(written.contains("the engine stopped on slope"), "{written}");
    assert!(written.contains("anl-broken"), "{written}");
    assert!(!written.contains("anl-stopped"), "{written}");
    let _ = std::fs::remove_dir_all(&root);
}
