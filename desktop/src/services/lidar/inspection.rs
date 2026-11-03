//! The one sampler behind Site data row values, the pin and the profile
//! (canopi-f47t.42, spec §1.10).
//!
//! It answers "what is the physical value here?" without going through the
//! display path: each target's points are transformed into the generation's own
//! grid in one call, each point picks its containing native pixel, and the
//! composed values are read through the same resolver display and analysis use,
//! one bounded window per run of nearby cells. It never decodes a colourised
//! tile, never interpolates between pixels, and never returns a value from a
//! generation the caller did not ask for.
//!
//! Sources and derived items are different storage contracts, so they are
//! resolved separately: a source is an ordered collection described by
//! `import::GenerationManifest` and binds its members on each read, while a derived item is described by `analyses::DerivedManifest` and always
//! reads through its published chunks. What a number means (its units) is the
//! item's, which the caller already holds.

use std::collections::HashSet;
use std::sync::atomic::AtomicBool;

use canopi_types::library::LibraryItemRole;
use canopi_types::lidar::{
    LIDAR_SAMPLE_MAX_POINTS, LIDAR_SAMPLE_MAX_TARGETS, LidarSamplePointsRequest, LidarSampleSeries,
    LidarSampleTarget, LidarSampleUnavailableReason,
};

use super::analyses;
use super::engine::RasterEngine;
use super::grid::RasterGrid;
use super::{LidarLibrary, catalogue, collection, generation, import};

/// What the sampler keeps between requests, per library.
///
/// Row values re-sample every shown row on every pointer move, so a target
/// that cannot be read is reported once. It is bounded by clearing when full,
/// which costs at most one more report.
#[derive(Default)]
pub(super) struct SampleMemo {
    /// Unreadable targets already logged, as (entity, generation).
    reported: HashSet<(String, String)>,
}

/// Entries the memo holds before it starts over: two requests' worth of targets, so the values and profile lanes do not evict each other.
const MEMO_CAPACITY: usize = 2 * LIDAR_SAMPLE_MAX_TARGETS;

impl SampleMemo {
    /// True the first time this (entity, generation) is reported.
    fn first_report(&mut self, entity_id: &str, generation_id: &str) -> bool {
        let key = (entity_id.to_string(), generation_id.to_string());
        if self.reported.contains(&key) {
            return false;
        }
        if self.reported.len() >= MEMO_CAPACITY {
            self.reported.clear();
        }
        self.reported.insert(key)
    }
}

/// The library's sample memo; a poisoned lock only means a panicked sampler,
/// and every entry it holds is still a correct immutable fact.
fn memo(library: &LidarLibrary) -> std::sync::MutexGuard<'_, SampleMemo> {
    library
        .inner
        .sample_memo
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Which reader serves a target's numbers.
enum TargetRead {
    /// Published result chunks of a derived item.
    Chunks,
    /// An ordered source collection, resolved on demand from its members.
    Collection(Box<import::GenerationManifest>),
}

/// The generation a target's entity currently resolves to, with everything a
/// bounded read needs and nothing that opens a raster yet.
struct SampleTarget {
    generation_id: String,
    /// The lattice the target's cells are addressed in.
    grid: RasterGrid,
    crs_ref: String,
    read: TargetRead,
}

/// Resolve the target entity's current head.
///
/// Source and result targets share only the currency rule; their manifests and
/// readers differ, so each is resolved on its own contract rather than being
/// forced through one shape.
fn resolve_target(
    library: &LidarLibrary,
    target: &LidarSampleTarget,
) -> Result<Option<SampleTarget>, String> {
    let connection = library.catalogue()?;
    match target.kind {
        LibraryItemRole::Source => {
            let Some(row) = catalogue::head_generation(&connection, &target.entity_id)? else {
                return Ok(None);
            };
            let manifest = import::read_generation_manifest(&row.manifest_json)?;
            Ok(Some(SampleTarget {
                generation_id: row.id,
                grid: manifest.grid.clone(),
                crs_ref: manifest.crs_ref.clone(),
                read: TargetRead::Collection(Box::new(manifest)),
            }))
        }
        LibraryItemRole::Derived => {
            // The item owns its result, so an item that no longer exists has no
            // generation to sample even if a row survived.
            if catalogue::get_derived_item(&connection, &target.entity_id)?.is_none() {
                return Ok(None);
            }
            let Some(row) = catalogue::derived_head(&connection, &target.entity_id)? else {
                return Ok(None);
            };
            let manifest = analyses::read_derived_manifest(&row.manifest_json)?;
            Ok(Some(SampleTarget {
                generation_id: row.id,
                grid: manifest.grid,
                crs_ref: manifest.crs_ref,
                read: TargetRead::Chunks,
            }))
        }
    }
}

/// Each point projected into a generation's CRS, or `None` where it cannot be.
type Projected = Vec<Option<(f64, f64)>>;

/// Transform WGS84 `[longitude, latitude]` points into the generation's CRS
/// in one engine call. A point that is not finite, or that the transform cannot
/// place, is `None`; `Ok(None)` means the generation declares no CRS.
fn transform_points(
    engine: &dyn RasterEngine,
    cancel: &AtomicBool,
    crs_ref: &str,
    points: &[[f64; 2]],
) -> Result<Option<Projected>, String> {
    if crs_ref.trim().is_empty() {
        return Ok(None);
    }
    let finite: Vec<(usize, (f64, f64))> = points
        .iter()
        .enumerate()
        .filter(|(_, [longitude, latitude])| longitude.is_finite() && latitude.is_finite())
        .map(|(index, [longitude, latitude])| (index, (*longitude, *latitude)))
        .collect();
    let mut projected = vec![None; points.len()];
    if finite.is_empty() {
        return Ok(Some(projected));
    }
    let placed = engine.transform_points(
        "EPSG:4326",
        crs_ref,
        &finite.iter().map(|(_, point)| *point).collect::<Vec<_>>(),
        cancel,
    )?;
    for ((index, _), point) in finite.iter().zip(placed) {
        projected[*index] = point;
    }
    Ok(Some(projected))
}

/// The largest lattice index this read will carry into a window.
///
/// Far below `i64::MAX` so a one-cell window's end cannot overflow, and inside
/// the range where `f64` still represents consecutive integers. It is a
/// representability guard, not a coverage rule: the lattice origin is not the
/// composition's extent.
const MAX_LATTICE_INDEX: f64 = 9.0e15;

/// The containing native pixel of one projected point.
///
/// The grid is north-up and half-open: a point exactly on the right or bottom
/// edge belongs to the neighbouring pixel, while a point on the top or left
/// edge belongs to the first pixel. `floor` on the fractional cell implements
/// exactly that.
///
/// The result is a **signed lattice coordinate**. An ordered collection keeps
/// its lattice origin while members added later extend beyond the first
/// source's rectangle, negative cell coordinates included, so clipping to
/// `grid.width`/`grid.height` would report NoData for coverage the display and
/// the readers both serve. Whether the addressed cell holds a valid sample is
/// the reader's answer.
fn containing_pixel(grid: &RasterGrid, x: f64, y: f64) -> Option<(i64, i64)> {
    let gt = grid.geotransform;
    if gt[1] == 0.0 || gt[5] == 0.0 {
        return None;
    }
    let cell_x = (x - gt[0]) / gt[1];
    let cell_y = (y - gt[3]) / gt[5];
    if !cell_x.is_finite() || !cell_y.is_finite() {
        return None;
    }
    let pixel_x = cell_x.floor();
    let pixel_y = cell_y.floor();
    if pixel_x.abs() > MAX_LATTICE_INDEX || pixel_y.abs() > MAX_LATTICE_INDEX {
        return None;
    }
    Some((pixel_x as i64, pixel_y as i64))
}

/// The most cells one run's window spans on each side, so a window holds at
/// most 256 × 256 values (about 320 KB with validity).
const RUN_SIDE: i64 = 256;

/// Refuses a request over the generated caps before any work.
pub(super) fn check_sample_caps(request: &LidarSamplePointsRequest) -> Result<(), String> {
    if request.targets.len() > LIDAR_SAMPLE_MAX_TARGETS
        || request.points.len() > LIDAR_SAMPLE_MAX_POINTS
    {
        return Err(format!(
            "a sample request carries at most {LIDAR_SAMPLE_MAX_TARGETS} targets and \
             {LIDAR_SAMPLE_MAX_POINTS} points (got {} and {})",
            request.targets.len(),
            request.points.len()
        ));
    }
    Ok(())
}

/// Sample every target at every point (spec §1.10): the native cell under each
/// WGS84 point, in target and point order.
///
/// Each target is resolved once, its points transformed in one call, its
/// reader bound once, and its cells read one bounded window per run (a window
/// opens only the source members that reach it). A target whose head is not the generation
/// the caller aimed at, before or after the read, answers `StaleGeneration`,
/// so a late answer is never presented as current; an item that is gone answers
/// `MissingGeneration`. A point off the data reads `None`: out of coverage is
/// no data, not an error. A point the generation's CRS rejects answers
/// `TransformFailed`; a target whose stored data cannot be read (a catalogue
/// row, manifest or raster that does not open or parse) answers `ReadFailed`
/// on its own row, so one broken item never blanks the others and the caller
/// may ask again; only the caps fail the whole batch.
pub(super) fn sample_points(
    library: &LidarLibrary,
    engine: &dyn RasterEngine,
    request: &LidarSamplePointsRequest,
) -> Result<Vec<LidarSampleSeries>, String> {
    check_sample_caps(request)?;
    #[cfg(test)]
    super::acceptance_hooks::sample_work_started(library);
    // Nothing cancels a sample: one batch is bounded by the caps, and the
    // frontend keeps one request in flight per lane.
    let cancel = AtomicBool::new(false);
    Ok(request
        .targets
        .iter()
        .map(|target| {
            sample_target(library, engine, &cancel, target, &request.points).unwrap_or_else(
                |error| {
                    // Once per generation: row values ask again on every
                    // pointer move.
                    if memo(library).first_report(&target.entity_id, &target.expected_generation_id)
                    {
                        tracing::warn!(
                            entity_id = %target.entity_id,
                            %error,
                            "a LiDAR sample target could not be read"
                        );
                    }
                    unavailable(LidarSampleUnavailableReason::ReadFailed)
                },
            )
        })
        .collect())
}

fn unavailable(reason: LidarSampleUnavailableReason) -> LidarSampleSeries {
    LidarSampleSeries::Unavailable { reason }
}

fn sample_target(
    library: &LidarLibrary,
    engine: &dyn RasterEngine,
    cancel: &AtomicBool,
    target: &LidarSampleTarget,
    points: &[[f64; 2]],
) -> Result<LidarSampleSeries, String> {
    let Some(resolved) = resolve_target(library, target)? else {
        return Ok(unavailable(LidarSampleUnavailableReason::MissingGeneration));
    };
    // Currency is checked against the generation the read will actually use,
    // not against a cached head.
    if resolved.generation_id != target.expected_generation_id {
        return Ok(unavailable(LidarSampleUnavailableReason::StaleGeneration));
    }
    #[cfg(test)]
    super::acceptance_hooks::after_target(library);
    // A CRS the generation does not declare, or one the engine rejects, cannot
    // place the points.
    let Ok(Some(projected)) = transform_points(engine, cancel, &resolved.crs_ref, points) else {
        return Ok(unavailable(LidarSampleUnavailableReason::TransformFailed));
    };
    let cells: Vec<Option<(i64, i64)>> = projected
        .iter()
        .map(|point| point.and_then(|(x, y)| containing_pixel(&resolved.grid, x, y)))
        .collect();
    let values = read_cells(library, &resolved, &cells, cancel)?;
    #[cfg(test)]
    super::acceptance_hooks::after_read(library);
    // Recheck currency once after the reads without holding the catalogue
    // across them: a head that moved makes the values stale before delivery,
    // and a target that disappeared is missing rather than a stale success.
    Ok(match resolve_target(library, target)? {
        None => unavailable(LidarSampleUnavailableReason::MissingGeneration),
        Some(current) if current.generation_id != resolved.generation_id => {
            unavailable(LidarSampleUnavailableReason::StaleGeneration)
        }
        Some(_) => LidarSampleSeries::Values { values },
    })
}

/// Read every cell, one bounded window per run; a point with no cell, an
/// invalid sample or a non-finite one is `None`.
fn read_cells(
    library: &LidarLibrary,
    target: &SampleTarget,
    cells: &[Option<(i64, i64)>],
    cancel: &AtomicBool,
) -> Result<Vec<Option<f64>>, String> {
    let mut values = vec![None; cells.len()];
    if cells.iter().all(Option::is_none) {
        return Ok(values);
    }
    let reader = match &target.read {
        TargetRead::Chunks => generation::GenerationReader::Chunks(
            generation::GenerationChunkReader::new(&target.generation_id, generation::RESULT_ROLE),
        ),
        TargetRead::Collection(manifest) => generation::GenerationReader::Collection(Box::new(
            collection::load_reader(library, &target.generation_id, manifest, cancel)?,
        )),
    };
    for run in cell_runs(cells) {
        let window = reader.read_window(library, run.window, cancel)?;
        for index in run.points {
            let Some((x, y)) = cells[index] else {
                continue;
            };
            let offset = usize::try_from(
                (y - run.window.y) * i64::from(run.window.width) + (x - run.window.x),
            )
            .map_err(|_| "a sampled cell lies outside its run".to_string())?;
            if window.valid.get(offset).copied().unwrap_or(0) == 0 {
                continue;
            }
            let value = f64::from(window.samples.get(offset).copied().unwrap_or(f32::NAN));
            values[index] = value.is_finite().then_some(value);
        }
    }
    Ok(values)
}

/// One window of consecutive cells and the points it answers.
#[derive(Debug, PartialEq)]
struct CellRun {
    window: generation::LatticeWindow,
    /// Indices into the point list whose cell lies in `window`.
    points: Vec<usize>,
}

/// Groups the cells, in point order, into runs whose bounding box stays
/// within `RUN_SIDE` cells on each side; a point without a cell joins none.
fn cell_runs(cells: &[Option<(i64, i64)>]) -> Vec<CellRun> {
    // A run's box as inclusive cell bounds: x0, y0, x1, y1.
    type Bounds = (i64, i64, i64, i64);
    let close = |(x0, y0, x1, y1): Bounds, points: Vec<usize>| CellRun {
        window: generation::LatticeWindow {
            x: x0,
            y: y0,
            width: (x1 - x0 + 1) as u32,
            height: (y1 - y0 + 1) as u32,
        },
        points,
    };
    let mut runs = Vec::new();
    let mut open: Option<(Bounds, Vec<usize>)> = None;
    for (index, cell) in cells.iter().enumerate() {
        let Some((x, y)) = *cell else {
            continue;
        };
        open = Some(match open.take() {
            Some(((x0, y0, x1, y1), mut points)) => {
                let grown = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
                if grown.2 - grown.0 < RUN_SIDE && grown.3 - grown.1 < RUN_SIDE {
                    points.push(index);
                    (grown, points)
                } else {
                    runs.push(close((x0, y0, x1, y1), points));
                    ((x, y, x, y), vec![index])
                }
            }
            None => ((x, y, x, y), vec![index]),
        });
    }
    if let Some((bounds, points)) = open {
        runs.push(close(bounds, points));
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid() -> RasterGrid {
        RasterGrid {
            width: 10,
            height: 10,
            geotransform: [0.0, 1.0, 0.0, 10.0, 0.0, -1.0],
        }
    }

    /// Web Mercator, derived independently of the engine.
    ///
    /// Written here rather than read from the engine so the oracle cannot agree with a
    /// broken transform by sharing its source. The formula is the published one:
    /// `x = R * lambda`, `y = R * ln(tan(pi/4 + phi/2))` with the ellipsoid
    /// replaced by the sphere Web Mercator actually uses.
    fn web_mercator(longitude: f64, latitude: f64) -> (f64, f64) {
        const R: f64 = 6_378_137.0;
        let lambda = longitude.to_radians();
        let phi = latitude.to_radians();
        (
            R * lambda,
            R * (std::f64::consts::FRAC_PI_4 + phi / 2.0).tan().ln(),
        )
    }

    /// The real transform and the real pixel selection, against an independent
    /// oracle, at a non-equatorial latitude.
    ///
    /// The other tests in this module exercise the half-open convention in
    /// isolation. This one runs the engine's real transform and then selects
    /// the containing pixel from the projected point, so a wrong axis
    /// order, a swapped coordinate pair or an off-by-one in the row inversion
    /// would all surface here rather than passing as a plausible number. The
    /// grid is deliberately placed away from the equator: a transform that
    /// silently ignored latitude scaling would still land inside a
    /// Mercator-centred rectangle but not inside this one.
    #[test]
    fn the_real_transform_lands_in_the_expected_cell() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        // A 250-metre Web Mercator grid whose north-west corner is the
        // projection of (-0.6°, 48.9°), north and west of every sample below, so
        // every expected coordinate is derived from the oracle rather than from
        // the grid and every sample lands in the interior.
        let (origin_x, origin_y) = web_mercator(-0.6, 48.9);
        let cell = 250.0;
        let grid = RasterGrid {
            width: 1000,
            height: 1000,
            geotransform: [origin_x, cell, 0.0, origin_y, 0.0, -cell],
        };

        for (longitude, latitude) in [(0.2, 48.75), (0.0, 48.5), (-0.3, 48.2)] {
            let (projected_x, projected_y) = web_mercator(longitude, latitude);
            let expected_column = ((projected_x - origin_x) / cell).floor();
            let expected_row = ((projected_y - origin_y) / -cell).floor();
            assert!(
                (0.0..1000.0).contains(&expected_column) && (0.0..1000.0).contains(&expected_row),
                "the fixture must place ({longitude}, {latitude}) inside the grid"
            );

            let projected =
                transform_points(&engine, &cancel, "EPSG:3857", &[[longitude, latitude]])
                    .expect("the transform runs")
                    .expect("the CRS is declared")[0]
                    .expect("a finite WGS84 point projects");
            // A metre is far below the assertions that follow, and the two
            // implementations differ only by floating-point rounding.
            assert!(
                (projected.0 - projected_x).abs() < 1.0,
                "x for ({longitude}, {latitude}): {} vs oracle {projected_x}",
                projected.0
            );
            assert!(
                (projected.1 - projected_y).abs() < 1.0,
                "y for ({longitude}, {latitude}): {} vs oracle {projected_y}",
                projected.1
            );
            assert_eq!(
                containing_pixel(&grid, projected.0, projected.1),
                Some((expected_column as i64, expected_row as i64)),
                "cell for ({longitude}, {latitude})"
            );
        }
    }

    #[test]
    fn the_containing_pixel_is_half_open_at_the_far_edges() {
        let grid = grid();
        // The top-left corner belongs to the first pixel.
        assert_eq!(containing_pixel(&grid, 0.0, 10.0), Some((0, 0)));
        // A point inside the first pixel's own span.
        assert_eq!(containing_pixel(&grid, 0.5, 9.5), Some((0, 0)));
        // The last included pixel.
        assert_eq!(containing_pixel(&grid, 9.999, 0.001), Some((9, 9)));
        // The right and bottom edges belong to the neighbouring cell, which this
        // lattice does not cover, rather than being clamped into the last one.
        // The grid's north-west corner is (0, 10) with a -1 y resolution, so the
        // row index is `10 - y` and the bottom edge is row 10.
        assert_eq!(containing_pixel(&grid, 10.0, 5.0), Some((10, 5)));
        assert_eq!(containing_pixel(&grid, 5.0, 0.0), Some((5, 10)));
        assert_eq!(containing_pixel(&grid, -0.001, 5.0), Some((-1, 5)));
    }

    /// The lattice rectangle is not the composition's extent.
    ///
    /// An ordered collection keeps its original lattice while members appended
    /// later reach outside the first source's rectangle, negative indices
    /// included. Clipping here reported NoData for coverage the display and the
    /// readers both serve, so the index is returned and the reader answers
    /// coverage.
    #[test]
    fn cells_beyond_the_lattice_rectangle_keep_their_signed_coordinate() {
        let grid = grid();
        for (x, y, expected) in [
            (-4.5, 5.5, (-5, 4)),
            (25.5, 5.5, (25, 4)),
            (5.5, -12.25, (5, 22)),
            (-1000.5, -1000.5, (-1001, 1010)),
        ] {
            assert_eq!(
                containing_pixel(&grid, x, y),
                Some(expected),
                "point ({x}, {y})"
            );
        }
    }

    /// An index the window arithmetic cannot carry is refused, not wrapped.
    #[test]
    fn an_unrepresentable_lattice_index_is_refused() {
        let grid = grid();
        assert_eq!(containing_pixel(&grid, 1.0e18, 0.0), None);
        assert_eq!(containing_pixel(&grid, 0.0, -1.0e18), None);
        // Just inside the guard still yields a usable signed coordinate.
        assert!(containing_pixel(&grid, 1.0e15, 5.0).is_some());
    }

    fn run(x: i64, y: i64, width: u32, height: u32, points: &[usize]) -> CellRun {
        CellRun {
            window: generation::LatticeWindow {
                x,
                y,
                width,
                height,
            },
            points: points.to_vec(),
        }
    }

    /// Consecutive cells share one window while its box stays within 256 cells
    /// a side; the 257th column starts the next run, and a point with no cell
    /// joins none.
    #[test]
    fn a_run_splits_where_its_box_would_pass_256_cells() {
        let mut cells: Vec<Option<(i64, i64)>> = (0..300).map(|x| Some((x, 7))).collect();
        cells.insert(10, None);
        let runs = cell_runs(&cells);
        let first: Vec<usize> = (0..10).chain(11..257).collect();
        let second: Vec<usize> = (257..301).collect();
        assert_eq!(
            runs,
            vec![run(0, 7, 256, 1, &first), run(256, 7, 44, 1, &second)]
        );
    }

    /// A diagonal line's box grows on both sides, so it splits at 256 too, and
    /// a run going back over its own cells stays one window.
    #[test]
    fn a_diagonal_splits_on_its_box_and_a_point_revisited_stays_in_its_run() {
        let cells: Vec<Option<(i64, i64)>> = (0..300)
            .map(|step| Some((-100 + step, 50 - step)))
            .chain([Some((-100, 50))])
            .collect();
        let runs = cell_runs(&cells);
        assert_eq!(runs.len(), 3);
        assert_eq!(runs[0].window, run(-100, -205, 256, 256, &[]).window);
        assert_eq!(runs[0].points, (0..256).collect::<Vec<_>>());
        assert_eq!(runs[1].window, run(156, -249, 44, 44, &[]).window);
        // Back to the start: far outside the second run's box.
        assert_eq!(runs[2], run(-100, 50, 1, 1, &[300]));
        assert_eq!(
            cell_runs(&[Some((3, 3)), Some((4, 3)), Some((3, 3))]),
            vec![run(3, 3, 2, 1, &[0, 1, 2])]
        );
        assert!(cell_runs(&[None, None]).is_empty());
    }

    /// Over either generated cap is refused, before any target is resolved.
    #[test]
    fn requests_over_the_caps_are_refused() {
        let target = LidarSampleTarget {
            kind: LibraryItemRole::Source,
            entity_id: "absent".to_string(),
            expected_generation_id: "g".to_string(),
        };
        let at_caps = LidarSamplePointsRequest {
            targets: vec![target.clone(); LIDAR_SAMPLE_MAX_TARGETS],
            points: vec![[0.0, 0.0]; LIDAR_SAMPLE_MAX_POINTS],
        };
        assert_eq!(check_sample_caps(&at_caps), Ok(()));
        let mut targets = at_caps.clone();
        targets.targets.push(target);
        let mut points = at_caps;
        points.points.push([0.0, 0.0]);
        for over in [targets, points] {
            let error = check_sample_caps(&over).unwrap_err();
            assert!(
                error.contains("at most 8 targets and 4096 points"),
                "{error}"
            );
        }
    }

    #[test]
    fn a_degenerate_grid_has_no_containing_pixel() {
        let mut broken = grid();
        broken.geotransform[1] = 0.0;
        assert_eq!(containing_pixel(&broken, 1.0, 1.0), None);
        let mut broken = grid();
        broken.geotransform[5] = 0.0;
        assert_eq!(containing_pixel(&broken, 1.0, 1.0), None);
    }
}

/// Stream C's latency probe (canopi-f47t.42): row values sample every shown
/// row at one point, so one hover is one point over 6–8 targets.
///
/// Budget: p95 ≤ 50 ms per 6-target point when idle and ≤ 150 ms during an
/// import. Run with the two IGN 0.5 m MNT tiles of the live-check master
/// (copied, never read in place) and the pinned GeoLibre CLI:
/// `CANOPI_LIDAR_SAMPLER_FIXTURE_DIR=<dir> CANOPI_GEOLIBRE_BIN=<geolibre>
/// cargo test -p canopi-desktop --lib --release -- --ignored sampler_latency --nocapture`
#[cfg(test)]
mod latency_probe {
    use super::super::{LidarLibrary, analyses, import};
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    const POINTS: usize = 500;
    /// Strips cut from each tile for the many-member collection: 24 members,
    /// the most one import admits.
    const MANY_STRIPS_PER_TILE: u32 = 12;

    /// The fixture tiles, copied into `work` so the master stays untouched.
    fn copied_tiles(work: &Path) -> Vec<PathBuf> {
        let dir = std::env::var_os("CANOPI_LIDAR_SAMPLER_FIXTURE_DIR")
            .map(PathBuf::from)
            .expect("CANOPI_LIDAR_SAMPLER_FIXTURE_DIR names the IGN MNT tiles");
        let mut tiles: Vec<PathBuf> = std::fs::read_dir(&dir)
            .expect("the fixture dir reads")
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "tif"))
            .collect();
        tiles.sort();
        assert!(tiles.len() >= 2, "two adjacent tiles are needed");
        let copies = work.join("tiles");
        std::fs::create_dir_all(&copies).unwrap();
        tiles
            .iter()
            .take(2)
            .map(|tile| {
                let copy = copies.join(tile.file_name().unwrap());
                std::fs::copy(tile, &copy).expect("the tile copies");
                copy
            })
            .collect()
    }

    /// Splits one tile into `parts` vertical strips, west to east, so two
    /// tiles make a collection with real member boundaries to cross: halves
    /// for the 4-member collection, narrow strips for a many-member one.
    fn strips(engine: &dyn RasterEngine, tile: &Path, out: &Path, parts: u32) -> Vec<PathBuf> {
        let cancel = AtomicBool::new(false);
        let probe = engine.probe(tile, &cancel).expect("the tile probes");
        let values = engine
            .read_f32(tile, probe.width, probe.height, &cancel)
            .expect("the tile reads");
        let stem = tile.file_stem().unwrap().to_string_lossy().to_string();
        let nodata = probe.nodata.unwrap_or(-99_999.0);
        (0..parts)
            .map(|part| {
                let x0 = probe.width * part / parts;
                let width = probe.width * (part + 1) / parts - x0;
                let mut strip = Vec::with_capacity((width * probe.height) as usize);
                for row in 0..probe.height {
                    let start = (row * probe.width + x0) as usize;
                    strip.extend_from_slice(&values[start..start + width as usize]);
                }
                let mut geotransform = probe.geotransform;
                geotransform[0] += f64::from(x0) * geotransform[1];
                let grid = RasterGrid {
                    width,
                    height: probe.height,
                    geotransform,
                };
                let path = out.join(format!("{stem}-{parts}-{x0}.tif"));
                engine
                    .write_geotiff(
                        &path,
                        super::super::engine::RasterGeoref {
                            grid: &grid,
                            crs: &probe.crs_ref,
                        },
                        nodata,
                        &strip,
                        &cancel,
                    )
                    .expect("the strip writes");
                path
            })
            .collect()
    }

    fn import_source(library: &LidarLibrary, name: &str, paths: &[PathBuf]) -> String {
        let layer = library
            .create_layer(
                name,
                canopi_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .expect("layer created");
        let job = library.record_import_job(&layer).expect("job recorded");
        import::stage_and_publish(library, &job, &layer, paths, &AtomicBool::new(false))
            .expect("the source publishes");
        library.finish_import_sources(&job, Ok(()));
        layer
    }

    fn head(library: &LidarLibrary, kind: LibraryItemRole, id: &str) -> String {
        let connection = library.catalogue().unwrap();
        match kind {
            LibraryItemRole::Source => catalogue::head_generation(&connection, id)
                .unwrap()
                .map(|row| row.id),
            LibraryItemRole::Derived => catalogue::derived_head(&connection, id)
                .unwrap()
                .map(|row| row.id),
        }
        .expect("the item is published")
    }

    /// `POINTS` deterministic points over the two tiles, in WGS84.
    fn points(engine: &dyn RasterEngine, tile: &Path) -> Vec<(f64, f64)> {
        let cancel = AtomicBool::new(false);
        let probe = engine.probe(tile, &cancel).unwrap();
        let gt = probe.geotransform;
        let (width, height) = (
            2.0 * f64::from(probe.width) * gt[1],
            f64::from(probe.height) * gt[5].abs(),
        );
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 11) as f64 / (1u64 << 53) as f64
        };
        let projected: Vec<(f64, f64)> = (0..POINTS)
            .map(|_| (gt[0] + next() * width, gt[3] - next() * height))
            .collect();
        engine
            .transform_points(&probe.crs_ref, "EPSG:4326", &projected, &cancel)
            .unwrap()
            .into_iter()
            .map(|point| point.expect("every fixture point places"))
            .collect()
    }

    fn percentile(sorted: &[Duration], p: f64) -> Duration {
        let index = ((sorted.len() as f64 - 1.0) * p).round() as usize;
        sorted[index]
    }

    /// One 6-target request per point through the real command, so each
    /// waits for the sampling turn and a Local slot as hover does; timed.
    /// Returns the sorted durations and how many values were found.
    fn sample_all(
        app: &tauri::App<tauri::test::MockRuntime>,
        targets: &[LidarSampleTarget],
        points: &[(f64, f64)],
    ) -> (Vec<Duration>, usize) {
        use tauri::Manager;
        let mut found = 0;
        let mut durations: Vec<Duration> = points
            .iter()
            .map(|&(longitude, latitude)| {
                let started = Instant::now();
                let series =
                    tauri::async_runtime::block_on(crate::commands::lidar::lidar_sample_points(
                        app.state(),
                        app.state(),
                        LidarSamplePointsRequest {
                            targets: targets.to_vec(),
                            points: vec![[longitude, latitude]],
                        },
                    ))
                    .expect("the batch samples");
                let elapsed = started.elapsed();
                found += series
                    .iter()
                    .filter(|one| {
                        matches!(one, LidarSampleSeries::Values { values } if values[0].is_some())
                    })
                    .count();
                elapsed
            })
            .collect();
        durations.sort();
        (durations, found)
    }

    fn report(label: &str, durations: &[Duration], found: usize) -> Duration {
        let p95 = percentile(durations, 0.95);
        println!(
            "{label}: {} points x 6 targets, {found} values; p50 {:?}, p95 {p95:?}, max {:?}",
            durations.len(),
            percentile(durations, 0.5),
            durations.last().unwrap()
        );
        p95
    }

    #[test]
    #[ignore = "local fixture: the IGN MNT tiles (CANOPI_LIDAR_SAMPLER_FIXTURE_DIR) and the pinned GeoLibre CLI"]
    fn sampler_latency_over_six_targets_idle_and_during_an_import() {
        let work = crate::test_scratch::TestScratch::new("lidar-sampler-latency");
        let tiles = copied_tiles(&work);
        let library = LidarLibrary::open(&work.join("app")).expect("library opens");
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let parts = work.join("parts");
        std::fs::create_dir_all(&parts).unwrap();
        let members: Vec<PathBuf> = tiles
            .iter()
            .flat_map(|tile| strips(&engine, tile, &parts, 2))
            .collect();
        // A source imported from as many small tiles as one import admits:
        // every hover binds all its members.
        let narrow: Vec<PathBuf> = tiles
            .iter()
            .flat_map(|tile| strips(&engine, tile, &parts, MANY_STRIPS_PER_TILE))
            .collect();

        let collection = import_source(&library, "four members", &members);
        let many = import_source(&library, "many members", &narrow);
        let west = import_source(&library, "west tile", &tiles[..1]);
        let east = import_source(&library, "east tile", &tiles[1..]);
        let slope_collection =
            analyses::test_support::run_slope(&library, &collection, "degrees", None).item_ids[0]
                .clone();
        let slope_west =
            analyses::test_support::run_slope(&library, &west, "degrees", None).item_ids[0].clone();
        let targets: Vec<LidarSampleTarget> = [
            (LibraryItemRole::Source, collection),
            (LibraryItemRole::Source, many),
            (LibraryItemRole::Source, west),
            (LibraryItemRole::Source, east),
            (LibraryItemRole::Derived, slope_collection),
            (LibraryItemRole::Derived, slope_west),
        ]
        .into_iter()
        .map(|(kind, entity_id)| LidarSampleTarget {
            kind,
            expected_generation_id: head(&library, kind, &entity_id),
            entity_id,
        })
        .collect();
        let points = points(&engine, &tiles[0]);
        let executor = crate::native_operation::NativeOperationExecutor::production();
        let app = tauri::test::mock_builder()
            .manage(library.clone())
            .manage(executor.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();

        let (idle, found) = sample_all(&app, &targets, &points);
        let idle_p95 = report("idle", &idle, found);

        // The same points again while an import of both tiles runs, over and
        // over on the executor class a real import takes, until the sampling
        // ends.
        let stop = Arc::new(AtomicBool::new(false));
        let importer = {
            let library = library.clone();
            let tiles = tiles.clone();
            let stop = stop.clone();
            let executor = executor.clone();
            std::thread::spawn(move || {
                let mut imports = 0;
                while !stop.load(Ordering::Relaxed) {
                    let (library, tiles) = (library.clone(), tiles.clone());
                    tauri::async_runtime::block_on(executor.run(
                        super::super::RASTER_WORK,
                        "lidar import sources",
                        move || Ok(import_source(&library, "busy import", &tiles)),
                    ))
                    .expect("the busy import runs");
                    imports += 1;
                }
                imports
            })
        };
        // Let the import reach its heavy phase first.
        std::thread::sleep(Duration::from_millis(500));
        let (busy, found) = sample_all(&app, &targets, &points);
        stop.store(true, Ordering::Relaxed);
        let imports = importer.join().expect("the importer finishes");
        let busy_p95 = report(&format!("during {imports} import(s)"), &busy, found);

        assert!(
            idle_p95 <= Duration::from_millis(50),
            "idle p95 {idle_p95:?} is over the 50 ms budget"
        );
        assert!(
            busy_p95 <= Duration::from_millis(150),
            "p95 during an import {busy_p95:?} is over the 150 ms budget"
        );
    }
}
