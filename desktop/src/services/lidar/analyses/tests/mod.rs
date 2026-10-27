//! Registry, definitions, runs, publication, refresh and freshness.
//!
//! The first half needs no engine: catalogue rows stand in for raster data.
//! The second half writes analytic surfaces with the Rust raster engine; its
//! ignored tests then run the pinned GeoLibre CLI on them (the `lidar-native`
//! lane). Nothing here launches GDAL.
//!
//! Shared fixtures live here; each submodule holds one area's tests.

mod acceptance;
mod freshness;
mod geolibre;
mod publication;
mod registry;
mod sampling;

use super::test_support::{record, run_slope, seed_published_slope, slope_request};
use super::*;
use crate::services::lidar::import::{self, read_generation_manifest};
use crate::services::lidar::{acceptance_hooks, generation, paths};
use common_types::library::{
    AnalysisInputBinding, LibraryItemRole, LibraryItemSummary, ParamValue,
};
use common_types::lidar::{
    LidarResultState, LidarSamplePointsRequest, LidarSampleSeries, LidarSampleTarget,
    LidarSampleUnavailableReason,
};
use std::path::PathBuf;

fn scratch_root(label: &str) -> crate::test_scratch::TestScratch {
    crate::test_scratch::TestScratch::new(&format!("analyses-{label}"))
}

fn count(library: &LidarLibrary, sql: &str) -> i64 {
    library
        .catalogue()
        .unwrap()
        .query_row(sql, [], |row| row.get(0))
        .unwrap()
}

/// A source item with a published head row and no raster data.
fn source_with_head(
    library: &LidarLibrary,
    name: &str,
    quantity: RasterQuantity,
    crs_class: &str,
) -> (String, String) {
    let layer_id = library.create_layer(name, quantity, None, false).unwrap();
    let generation_id = new_id("gen");
    let connection = library.catalogue().unwrap();
    connection
        .execute(
            "INSERT INTO lidar_layer_generations
             (id, layer_id, created_at, manifest_json, coverage_cells, min_value, max_value,
              bounds_3857, crs_class)
             VALUES (?1, ?2, '0', '{}', 1, 0, 1, '[0,0,1,1]', ?3)",
            rusqlite::params![generation_id, layer_id, crs_class],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO lidar_layer_heads(layer_id, generation_id) VALUES (?1, ?2)",
            rusqlite::params![layer_id, generation_id],
        )
        .unwrap();
    (layer_id, generation_id)
}

fn summary<'a>(items: &'a [LibraryItemSummary], id: &str) -> &'a LibraryItemSummary {
    items
        .iter()
        .find(|item| item.id == id)
        .unwrap_or_else(|| panic!("{id} is listed"))
}

fn installed(version: &str) -> Result<GeolibreTool, String> {
    Ok(GeolibreTool {
        path: PathBuf::from("/nonexistent/geolibre"),
        version: version.to_string(),
    })
}

/// Stage one output as unpublished chunk rows over a recorded asset.
fn stage_fake(library: &LidarLibrary, digest: &str) -> StagedRaster {
    let generation_id = new_id("dgen");
    let connection = library.catalogue().unwrap();
    catalogue::insert_raster_asset(
        &connection,
        &catalogue::RasterAssetRow {
            sha256: digest.to_string(),
            rel_path: format!("assets/{digest}/cog.tif"),
            bytes: 1,
            profile: "test".to_string(),
            width: 1,
            height: 1,
            geotransform: "[0,1,0,0,0,-1]".to_string(),
            crs_ref: "EPSG:32631".to_string(),
            nodata: None,
        },
    )
    .unwrap();
    catalogue::insert_unpublished_chunks(
        &connection,
        &generation_id,
        &[catalogue::GenerationChunkRow {
            role: generation::RESULT_ROLE.to_string(),
            chunk_x: 0,
            chunk_y: 0,
            asset_sha256: digest.to_string(),
            valid_cells: 4,
            min_value: 1.0,
            max_value: 3.0,
            sum_value: 8.0,
        }],
    )
    .unwrap();
    StagedRaster {
        output_key: "slope",
        generation_id,
        grid: RasterGrid {
            width: 1024,
            height: 1024,
            geotransform: [0.0, 1.0, 0.0, 0.0, 0.0, -1.0],
        },
        crs_ref: "EPSG:32631".to_string(),
        crs_class: CRS_PROJECTED_METRE.to_string(),
        bounds_3857: "[0,0,1,1]".to_string(),
        coverage_cells: 4,
        value_range: Some((1.0, 3.0)),
    }
}

fn publish_fake(
    library: &LidarLibrary,
    job_id: &str,
    digest: &str,
    tool_version: &str,
) -> Result<String, String> {
    let (job, inputs) = {
        let connection = library.catalogue().unwrap();
        let job = catalogue::get_analysis_job(&connection, job_id)
            .unwrap()
            .unwrap();
        let inputs = parse_pinned_inputs(&job.input_generations_json)
            .unwrap()
            .into_iter()
            .map(|input| PinnedInput {
                key: input.key,
                item_id: input.item_id,
                generation_id: input.generation_id,
                units: "m".to_string(),
            })
            .collect::<Vec<_>>();
        (job, inputs)
    };
    let staged = stage_fake(library, digest);
    let generation_id = staged.generation_id.clone();
    let tool = installed(tool_version)
        .unwrap()
        .provenance(vec!["slope".to_string()]);
    let published = publish(
        library,
        &job,
        &inputs,
        &ExecutorOutcome {
            outputs: vec![staged],
            tool,
        },
    );
    if published.is_err() {
        catalogue::discard_unpublished_generation_chunks(
            &library.catalogue().unwrap(),
            &generation_id,
        )
        .unwrap();
    }
    published.map(|()| generation_id)
}

fn library_rerun(library: &LidarLibrary, definition_id: &str) -> AnalysisReceipt {
    record_rerun(&library.catalogue().unwrap(), definition_id, None).unwrap()
}

/// Publish one source into `layer_id` through the real stage and apply path.
///
/// A published source never gains a generation in production; currency
/// guards are exercised by first withdrawing the head, which leaves the old
/// generation's rows in place for the guard to see.
fn publish_source(library: &LidarLibrary, layer_id: &str, source: &Path) {
    library
        .catalogue()
        .unwrap()
        .execute(
            "DELETE FROM lidar_layer_heads WHERE layer_id = ?1",
            [layer_id],
        )
        .unwrap();
    let job_id = library.record_import_job(layer_id).unwrap();
    import::stage_and_publish(
        library,
        &job_id,
        layer_id,
        std::slice::from_ref(&source.to_path_buf()),
        &AtomicBool::new(false),
    )
    .expect("the batch publishes");
}

/// A plane rising one metre per metre eastward in EPSG:32631 (a ground
/// metre grid; Web Mercator's metres are not), with a NoData
/// hole at columns 8..10, rows 6..8.
fn plane_layer(library: &LidarLibrary, root: &Path, width: u32, height: u32) -> String {
    let values: Vec<f32> = (0..height)
        .flat_map(|y| (0..width).map(move |x| (x, y)))
        .map(|(x, y)| {
            if (8..10).contains(&x) && (6..8).contains(&y) {
                -9999.0
            } else {
                x as f32
            }
        })
        .collect();
    let source = raster(root, "plane", &values, width, height, 0.0);
    let layer_id = library
        .create_layer("slope plane", RasterQuantity::GroundElevation, None, false)
        .unwrap();
    publish_source(library, &layer_id, &source);
    layer_id
}

fn raster(
    root: &Path,
    name: &str,
    values: &[f32],
    width: u32,
    height: u32,
    origin_x: f64,
) -> PathBuf {
    let engine = crate::services::lidar::rust_engine::RustRasterEngine;
    let raw = root.join(format!("{name}.raw"));
    import::write_f32_raw(&raw, values).unwrap();
    let source = root.join(format!("{name}.tif"));
    import::raw_to_tif(
        &engine,
        &AtomicBool::new(false),
        &raw,
        &source,
        &RasterGrid {
            width,
            height,
            geotransform: [origin_x, 1.0, 0.0, f64::from(height), 0.0, -1.0],
        },
        "EPSG:32631",
        -9999.0,
    )
    .unwrap();
    let _ = std::fs::remove_file(&raw);
    source
}

fn import_layer(library: &LidarLibrary, sources: &[PathBuf]) -> String {
    let layer_id = library
        .create_layer(
            "bounded slope",
            RasterQuantity::GroundElevation,
            None,
            false,
        )
        .unwrap();
    let job_id = library.record_import_job(&layer_id).unwrap();
    import::stage_and_publish(
        library,
        &job_id,
        &layer_id,
        sources,
        &AtomicBool::new(false),
    )
    .expect("the batch publishes");
    layer_id
}

/// `z = 40 sin(2πx/90) + 16 cos(2πy/54)` on a 1 m projected lattice, with a
/// NoData hole where both `x` and `y + 600` fall in `hole`.
fn curved_member(root: &Path, width: u32, height: u32, hole: std::ops::Range<u32>) -> PathBuf {
    let values: Vec<f32> = (0..height)
        .flat_map(|y| (0..width).map(move |x| (x, y)))
        .map(|(x, y)| {
            if hole.contains(&x) && hole.contains(&(y + 600)) {
                -9999.0
            } else {
                curved_height(f64::from(x), f64::from(y)) as f32
            }
        })
        .collect();
    raster(root, "curved", &values, width, height, 0.0)
}

fn curved_height(x: f64, y: f64) -> f64 {
    40.0 * (std::f64::consts::TAU * x / 90.0).sin()
        + 16.0 * (std::f64::consts::TAU * y / 54.0).cos()
}

/// Analytic gradient magnitude (rise over run) at a cell centre.
fn curved_gradient(x: f64, y: f64) -> f64 {
    let dx = 40.0 * std::f64::consts::TAU / 90.0 * (std::f64::consts::TAU * x / 90.0).cos();
    let dy = -16.0 * std::f64::consts::TAU / 54.0 * (std::f64::consts::TAU * y / 54.0).sin();
    dx.hypot(dy)
}

/// Read a window of a derived item's head: values, validity and quality.
fn result_window(
    library: &LidarLibrary,
    item_id: &str,
    window: generation::LatticeWindow,
) -> (Vec<f32>, Vec<u8>, Vec<u8>) {
    let connection = library.catalogue().unwrap();
    let head = catalogue::derived_head(&connection, item_id)
        .unwrap()
        .unwrap();
    let paths = &library.inner.paths;
    let cancel = AtomicBool::new(false);
    let values = generation::read_persisted_window(
        &generation::persisted_chunks(&connection, paths, &head.id, generation::RESULT_ROLE)
            .unwrap(),
        window,
        &cancel,
    )
    .unwrap();
    let quality = generation::read_quality_chunks_window(
        &generation::persisted_chunks(&connection, paths, &head.id, generation::QUALITY_ROLE)
            .unwrap(),
        window,
        &cancel,
    )
    .unwrap();
    (
        values.samples,
        values.valid,
        quality
            .samples
            .iter()
            .map(|value| u8::from(*value == 1.0))
            .collect(),
    )
}

/// The WGS84 point of a fixture cell centre, through the CRS authority,
/// which `rust_engine::crs` tests hold to PROJ.
fn lon_lat(easting: f64, northing: f64) -> (f64, f64) {
    use crate::services::lidar::engine::RasterEngine;
    crate::services::lidar::rust_engine::RustRasterEngine
        .transform_points(
            "EPSG:32631",
            "EPSG:4326",
            &[(easting, northing)],
            &AtomicBool::new(false),
        )
        .unwrap()[0]
        .unwrap()
}

/// One target as the frontend aims it.
fn target(kind: LibraryItemRole, entity_id: &str, generation_id: &str) -> LidarSampleTarget {
    LidarSampleTarget {
        kind,
        entity_id: entity_id.to_string(),
        expected_generation_id: generation_id.to_string(),
    }
}

/// The WGS84 point of a fixture cell centre, as the sampler takes it.
fn point(easting: f64, northing: f64) -> [f64; 2] {
    let (longitude, latitude) = lon_lat(easting, northing);
    [longitude, latitude]
}

/// Sample through the batched sampler and return each target's series.
fn sample(
    library: &LidarLibrary,
    targets: Vec<LidarSampleTarget>,
    points: Vec<[f64; 2]>,
) -> Vec<LidarSampleSeries> {
    library
        .sample_points(&LidarSamplePointsRequest { targets, points })
        .expect("the batch samples")
}

/// One target's values, or a panic naming what came back instead.
fn values(series: &LidarSampleSeries) -> Vec<Option<f64>> {
    match series {
        LidarSampleSeries::Values { values } => values.clone(),
        other => panic!("expected values, got {other:?}"),
    }
}

fn unavailable(reason: LidarSampleUnavailableReason) -> LidarSampleSeries {
    LidarSampleSeries::Unavailable { reason }
}

fn source_head(library: &LidarLibrary, layer_id: &str) -> String {
    catalogue::head_generation(&library.catalogue().unwrap(), layer_id)
        .unwrap()
        .unwrap()
        .id
}

/// A published result over `source_layer` whose chunks the caller writes.
fn chunk_result(library: &LidarLibrary, source_layer: &str, item_id: &str) -> String {
    let generation_id = format!("dgen-{item_id}");
    let source_generation = source_head(library, source_layer);
    seed_published_slope(
        &library.catalogue().unwrap(),
        source_layer,
        &source_generation,
        &format!("adef-{item_id}"),
        item_id,
        &generation_id,
        None,
    );
    generation_id
}

/// The warnings logged while `run` runs, as plain text.
fn warnings_during(run: impl FnOnce()) -> String {
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
    let log = Captured::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer({
            let log = log.clone();
            move || log.clone()
        })
        .with_ansi(false)
        .with_max_level(tracing::Level::WARN)
        .finish();
    tracing::subscriber::with_default(subscriber, run);
    String::from_utf8(log.0.lock().unwrap().clone()).unwrap()
}

/// Processes currently running one executable, read from `/proc`.
#[cfg(target_os = "linux")]
fn running(executable: &Path) -> usize {
    let wanted = std::fs::canonicalize(executable).unwrap();
    std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| std::fs::read_link(entry.path().join("exe")).is_ok_and(|exe| exe == wanted))
        .count()
}

fn files(path: &Path, output: &mut Vec<(PathBuf, Vec<u8>)>) {
    for entry in std::fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files(&path, output);
        } else {
            output.push((path.clone(), std::fs::read(path).unwrap()));
        }
    }
}
