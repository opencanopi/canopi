//! The engine comparison lane: the Rust engine against GDAL on the same
//! inputs, through the one seam both implement.
//!
//! Ignored by default and skipped cleanly when GDAL is not installed
//! (`CANOPI_LIDAR_GDAL_BIN`, then `PATH`). It is the standing accuracy proof
//! behind ADR 0014: probe facts, Float32 samples, the controlled profile, the
//! display warp (against `gdalwarp` on the same lattice, A6), point
//! transforms and statistics must agree within the tolerances stated beside
//! each assertion. Point transforms are also checked against a `cs2cs`
//! snapshot on every `cargo test`
//! (`crs::tests::every_row_matches_proj_on_its_reference_grid`); this lane
//! samples each row more densely against live PROJ, inverse included. Run with
//! `cargo test -p canopi-desktop --lib rust_engine::comparison -- --ignored --nocapture`;
//! `CANOPI_LIDAR_REFERENCE_DIR` adds real tiles to the display comparison.

use super::super::engine::{RasterEngine, RasterGeoref, RasterInput, RasterProbe};
use super::super::gdal_engine::{GdalEngine, GdalProgram};
use super::super::grid::RasterGrid;
use super::super::prepared_raster::PreparedRaster;
use super::RustRasterEngine;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

fn cancel() -> AtomicBool {
    AtomicBool::new(false)
}

/// One deviation, kept for the printed report.
struct Report {
    lines: Vec<String>,
}

impl Report {
    fn note(&mut self, line: String) {
        println!("{line}");
        self.lines.push(line);
    }
}

fn authored(x: u32, y: u32) -> f32 {
    match (x % 23, y % 17) {
        (0, 0) => -9999.0,
        (1, 1) => f32::NAN,
        (2, 2) => f32::INFINITY,
        (3, 3) => 0.0,
        (4, 4) => -12.5,
        _ => ((x as f32) * 0.75 - (y as f32) * 1.25).sin() * 500.0 + 150.0,
    }
}

fn valid(value: f32, nodata: Option<f32>) -> bool {
    value.is_finite() && nodata.is_none_or(|marker| value != marker)
}

/// Samples agree when both are NaN or within `tolerance`.
fn max_sample_deviation(a: &[f32], b: &[f32]) -> (f64, usize) {
    assert_eq!(a.len(), b.len(), "sample counts");
    let mut max = 0f64;
    let mut nan_mismatch = 0usize;
    for (x, y) in a.iter().zip(b) {
        match (x.is_nan(), y.is_nan()) {
            (true, true) => {}
            (false, false) => max = max.max((f64::from(*x) - f64::from(*y)).abs()),
            _ => nan_mismatch += 1,
        }
    }
    (max, nan_mismatch)
}

fn read_controlled(path: &Path, grid: &RasterGrid, nodata: Option<f32>) -> (Vec<f32>, Vec<u8>) {
    let mut reader =
        PreparedRaster::open_committed(path, grid, nodata).expect("controlled COG opens");
    let cells = grid.width as usize * grid.height as usize;
    let mut samples = vec![0f32; cells];
    let mut valid = vec![0u8; cells];
    reader
        .scan(&cancel(), |window, window_samples, window_valid| {
            for row in 0..window.height {
                for column in 0..window.width {
                    let target = ((window.y + row) as usize) * grid.width as usize
                        + (window.x + column) as usize;
                    let source = (row * window.width + column) as usize;
                    samples[target] = window_samples[source];
                    valid[target] = window_valid[source];
                }
            }
            Ok(())
        })
        .expect("controlled COG scans");
    (samples, valid)
}

fn assert_probe_facts(label: &str, gdal: &RasterProbe, rust: &RasterProbe) {
    assert_eq!(
        (gdal.width, gdal.height),
        (rust.width, rust.height),
        "{label}: dims"
    );
    assert_eq!(gdal.band_count, rust.band_count, "{label}: bands");
    assert_eq!(gdal.band_type, rust.band_type, "{label}: band type");
    assert_eq!(
        gdal.nodata.map(f32::to_bits),
        rust.nodata.map(f32::to_bits),
        "{label}: nodata"
    );
    for (index, (a, b)) in gdal.geotransform.iter().zip(&rust.geotransform).enumerate() {
        assert!(
            (a - b).abs() <= 1e-9 * a.abs().max(1.0),
            "{label}: geotransform[{index}] {a} vs {b}"
        );
    }
    assert_eq!(
        gdal_crs_class(&gdal.crs_ref),
        super::super::analyses::crs_class(&rust.crs_ref),
        "{label}: CRS class ({} vs {})",
        gdal.crs_ref,
        rust.crs_ref
    );
    // A tiled file's block is a fact of the file; for strips GDAL reports its
    // own access block (one row for a single whole-image strip), so only the
    // width is compared.
    if gdal.block[0] != gdal.width {
        assert_eq!(gdal.block, rust.block, "{label}: block");
    } else {
        assert_eq!(gdal.block[0], rust.block[0], "{label}: strip width");
    }
    assert_eq!(gdal.compression, rust.compression, "{label}: compression");
    assert_eq!(
        gdal.overview_count, rust.overview_count,
        "{label}: overviews"
    );
    assert_eq!(gdal.scale, rust.scale, "{label}: scale");
    assert_eq!(gdal.offset, rust.offset, "{label}: offset");
}

/// Compare every operation on one georeferenced source both engines read.
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn compare_source(
    report: &mut Report,
    label: &str,
    source: &Path,
    dir: &Path,
    gdal: &GdalEngine,
    rust: &RustRasterEngine,
) {
    let c = cancel();
    let gdal_probe = gdal.probe(source, &c).expect("GDAL probes");
    let rust_probe = rust.probe(source, &c).expect("the Rust engine probes");
    assert_probe_facts(label, &gdal_probe, &rust_probe);
    let grid = RasterGrid {
        width: rust_probe.width,
        height: rust_probe.height,
        geotransform: rust_probe.geotransform,
    };
    let a = gdal.wgs84_extent(source, &c).expect("GDAL extent");
    let b = rust.wgs84_extent(source, &c).expect("Rust extent");
    let deviation = a
        .iter()
        .zip(&b)
        .map(|(x, y)| (x - y).abs())
        .fold(0f64, f64::max);
    report.note(format!(
        "{label}: WGS84 extent max deviation {deviation:.3e} deg"
    ));
    assert!(deviation <= 1e-6, "{label}: extent {a:?} vs {b:?}");

    let gdal_samples = gdal
        .read_f32(source, grid.width, grid.height, &c)
        .expect("GDAL reads Float32");
    let rust_samples = rust
        .read_f32(source, grid.width, grid.height, &c)
        .expect("the Rust engine reads Float32");
    let (deviation, nan_mismatch) = max_sample_deviation(&gdal_samples, &rust_samples);
    report.note(format!(
        "{label}: Float32 samples max deviation {deviation:.3e}, NaN mismatches {nan_mismatch}"
    ));
    assert!(
        deviation <= 1e-4 && nan_mismatch == 0,
        "{label}: samples differ"
    );

    // GDAL counts ±inf as values (its max and mean become inf); Canopi's
    // validity rule is finite and not NoData, so statistics are compared only
    // on inputs without infinities.
    if rust_samples.iter().any(|value| value.is_infinite()) {
        report.note(format!(
            "{label}: statistics not compared (the fixture holds ±inf, which GDAL counts)"
        ));
    } else {
        let gdal_stats = gdal.statistics(source, &c).expect("GDAL statistics");
        let rust_stats = rust.statistics(source, &c).expect("Rust statistics");
        let relative = |a: f64, b: f64| (a - b).abs() / a.abs().max(1e-9);
        report.note(format!(
        "{label}: statistics min {:.3e} max {:.3e} mean {:.3e} std {:.3e} valid% {:.3e} (relative)",
        relative(gdal_stats.minimum, rust_stats.minimum),
        relative(gdal_stats.maximum, rust_stats.maximum),
        relative(gdal_stats.mean, rust_stats.mean),
        relative(gdal_stats.std_dev, rust_stats.std_dev),
        (gdal_stats.valid_percent - rust_stats.valid_percent).abs()
    ));
        // gdalinfo prints 14 significant digits of its double accumulators.
        assert!(
            relative(gdal_stats.minimum, rust_stats.minimum) <= 1e-9,
            "{label}: min"
        );
        assert!(
            relative(gdal_stats.maximum, rust_stats.maximum) <= 1e-9,
            "{label}: max"
        );
        assert!(
            relative(gdal_stats.mean, rust_stats.mean) <= 1e-9,
            "{label}: mean"
        );
        assert!(
            relative(gdal_stats.std_dev, rust_stats.std_dev) <= 1e-7,
            "{label}: std"
        );
        assert!(
            (gdal_stats.valid_percent - rust_stats.valid_percent).abs() <= 0.01,
            "{label}: valid%"
        );
    }

    // The controlled profile from each engine, read by the production reader.
    let georef = RasterGeoref {
        grid: &grid,
        crs: &rust_probe.crs_ref,
    };
    let nodata = rust_probe.nodata;
    let gdal_cog = dir.join(format!("{label}-gdal-controlled.tif"));
    let rust_cog = dir.join(format!("{label}-rust-controlled.tif"));
    gdal.write_controlled_cog(
        RasterInput::File(source),
        &gdal_cog,
        Some(georef),
        nodata,
        &c,
    )
    .expect("GDAL writes the controlled COG");
    rust.write_controlled_cog(
        RasterInput::File(source),
        &rust_cog,
        Some(georef),
        nodata,
        &c,
    )
    .expect("the Rust engine writes the controlled COG");
    let (a, a_valid) = read_controlled(&gdal_cog, &grid, nodata);
    let (b, b_valid) = read_controlled(&rust_cog, &grid, nodata);
    let (deviation, nan_mismatch) = max_sample_deviation(&a, &b);
    assert!(
        deviation == 0.0 && nan_mismatch == 0 && a_valid == b_valid,
        "{label}: controlled COGs differ (max {deviation}, NaN mismatches {nan_mismatch})"
    );
    report.note(format!(
        "{label}: controlled COG samples identical, validity identical"
    ));
    // Each engine reads the other's controlled COG the same way.
    let cross = rust.probe(&gdal_cog, &c).expect("Rust probes GDAL's COG");
    let cross_back = gdal.probe(&rust_cog, &c).expect("GDAL probes the Rust COG");
    assert_probe_facts(&format!("{label} cross-probe"), &cross_back, &cross);

    // The display warp, both engines from the same numeric COG.
    compare_display(report, label, &rust_cog, dir, gdal, rust, nodata);
}

/// The display warp against `gdalwarp -r near` on the same Web Mercator
/// lattice with the row's own Helmert shift (A6). Both pick, at each pixel
/// centre, the native cell under it, so they differ only where the two
/// transforms (within 1 cm of each other, A16) put the centre on either side
/// of a cell edge: every differing pixel must lie within 1 cm of one.
/// Overviews then agree within tolerance away from those pixels.
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn compare_display(
    report: &mut Report,
    label: &str,
    source: &Path,
    dir: &Path,
    gdal: &GdalEngine,
    rust: &RustRasterEngine,
    nodata: Option<f32>,
) {
    let c = cancel();
    let gdal_display = dir.join(format!("{label}-gdal-display.tif"));
    let rust_display = dir.join(format!("{label}-rust-display.tif"));
    let probe = rust.probe(source, &c).expect("Rust probes the source");
    let zoom = super::display_zoom(
        &probe.crs_ref,
        [&RasterGrid {
            width: probe.width,
            height: probe.height,
            geotransform: probe.geotransform,
        }],
    )
    .expect("the source has a display zoom");
    gdal.write_display_cog(
        RasterInput::File(source),
        &gdal_display,
        None,
        nodata,
        zoom,
        &c,
    )
    .expect("GDAL warps the display COG");
    let started = std::time::Instant::now();
    rust.write_display_cog(
        RasterInput::File(source),
        &rust_display,
        None,
        nodata,
        zoom,
        &c,
    )
    .expect("the Rust engine warps the display COG");
    let elapsed = started.elapsed();
    let a_probe = rust
        .probe(&gdal_display, &c)
        .expect("Rust probes GDAL's display COG");
    let b_probe = rust
        .probe(&rust_display, &c)
        .expect("Rust probes its display COG");
    assert_eq!(b_probe.crs_ref, "EPSG:3857", "{label}");
    assert_eq!(a_probe.crs_ref, b_probe.crs_ref, "{label}: display CRS");
    assert_eq!(
        (a_probe.width, a_probe.height),
        (b_probe.width, b_probe.height),
        "{label}: display size"
    );
    for (a, b) in a_probe.geotransform.iter().zip(&b_probe.geotransform) {
        assert!(
            (a - b).abs() <= 1e-6,
            "{label}: {:?} vs {:?}",
            a_probe.geotransform,
            b_probe.geotransform
        );
    }
    assert_eq!(a_probe.nodata, b_probe.nodata, "{label}: display NoData");
    assert_eq!(
        a_probe.overview_count, b_probe.overview_count,
        "{label}: overview count"
    );
    assert_eq!(b_probe.compression, "DEFLATE");
    assert_eq!(b_probe.block, [256, 256]);
    let a = rust
        .read_f32(&gdal_display, a_probe.width, a_probe.height, &c)
        .expect("Rust reads GDAL's display COG");
    let mut b = rust
        .read_f32(&rust_display, b_probe.width, b_probe.height, &c)
        .expect("Rust reads its display COG");
    let shown = |value: f32| valid(value, b_probe.nodata);
    let differing: Vec<usize> = (0..a.len())
        .filter(|index| {
            let (x, y) = (a[*index], b[*index]);
            shown(x) != shown(y) || (shown(x) && x != y)
        })
        .collect();
    // How far each differing centre lies from the nearest native cell edge.
    let gt = b_probe.geotransform;
    let centres: Vec<(f64, f64)> = differing
        .iter()
        .map(|index| {
            let (column, row) = (
                index % b_probe.width as usize,
                index / b_probe.width as usize,
            );
            (
                gt[0] + (column as f64 + 0.5) * gt[1],
                gt[3] + (row as f64 + 0.5) * gt[5],
            )
        })
        .collect();
    let placed = rust
        .transform_points("EPSG:3857", &probe.crs_ref, &centres, &c)
        .expect("centres place");
    let ngt = probe.geotransform;
    let mut farthest = 0f64;
    for (index, point) in differing.iter().zip(placed) {
        let (x, y) = point.expect("a differing centre places natively");
        let edge = |coordinate: f64, origin: f64, cell: f64| {
            let fraction = (coordinate - origin) / cell;
            (fraction - fraction.round()).abs() * cell.abs()
        };
        let distance = edge(x, ngt[0], ngt[1]).min(edge(y, ngt[3], ngt[5]));
        farthest = farthest.max(distance);
        assert!(
            distance <= 0.01,
            "{label}: pixel {index} differs ({} vs {}) {distance} m from a native cell edge",
            a[*index],
            b[*index]
        );
        b[*index] = f32::NAN;
    }
    report.note(format!(
        "{label}: display {}x{} on the lattice, {} of {} pixels differ, all within {farthest:.1e} m of a native cell edge; Rust warp {elapsed:.2?}",
        b_probe.width,
        b_probe.height,
        differing.len(),
        a.len()
    ));
    // The warp pads a derivative so every overview level halves exactly on
    // the lattice, which also makes GDAL's weighting of partial source pixels
    // (on a level with an odd side) moot: the overviews compare cell by cell.
    let (mut width, mut height) = (b_probe.width, b_probe.height);
    for _ in 0..super::cog::overview_count(u64::from(width), u64::from(height)) {
        assert!(
            width % 2 == 0 && height % 2 == 0,
            "{label}: the {}x{} display halves an odd side ({width}x{height})",
            b_probe.width,
            b_probe.height
        );
        (width, height) = (width / 2, height / 2);
    }
    let display_grid = RasterGrid {
        width: b_probe.width,
        height: b_probe.height,
        geotransform: b_probe.geotransform,
    };
    compare_overviews(
        report,
        label,
        &gdal_display,
        &rust_display,
        b_probe.nodata,
        &b,
        &display_grid,
    );
}

/// One level of a COG: `(width, height, samples)`.
type Level = (u32, u32, Vec<f32>);

/// Every level of a COG, full resolution first.
fn cog_levels(path: &Path) -> Vec<Level> {
    let bytes = std::fs::read(path).expect("COG bytes");
    let layout = wbgeotiff::GeoTiff::parse_cog_layout(&bytes[..(4 << 20).min(bytes.len())])
        .expect("COG layout");
    layout
        .levels
        .iter()
        .map(|level| {
            let mut samples = vec![f32::NAN; (level.width * level.height) as usize];
            for ty in 0..level.tiles_y {
                for tx in 0..level.tiles_x {
                    let (offset, count) = level.tile_range(tx, ty).expect("tile range");
                    let tile = level
                        .decode_tile_f64(&bytes[offset as usize..(offset + count) as usize])
                        .expect("tile decodes");
                    for row in 0..level.tile_height {
                        let y = ty * level.tile_height + row;
                        if y >= level.height {
                            break;
                        }
                        for column in 0..level.tile_width {
                            let x = tx * level.tile_width + column;
                            if x >= level.width {
                                break;
                            }
                            samples[(y * level.width + x) as usize] =
                                tile[(row * level.tile_width + column) as usize] as f32;
                        }
                    }
                }
            }
            (level.width, level.height, samples)
        })
        .collect()
}

/// Overview samples: both engines average the valid samples of each block in
/// double precision and store Float32, so cells agree bit for bit except
/// where the source block holds a NaN or ±inf (or, in `full`, a pixel the two
/// warps resolved differently, marked NaN). GDAL propagates a non-finite
/// sample into the average; Canopi averages the finite samples, which is the
/// display rule. Those "poisoned" cells are counted and reported; every
/// other cell must agree within 1e-3.
fn compare_overviews(
    report: &mut Report,
    label: &str,
    gdal_display: &Path,
    rust_display: &Path,
    nodata: Option<f32>,
    full: &[f32],
    grid: &RasterGrid,
) {
    let a: Vec<_> = cog_levels(gdal_display).into_iter().skip(1).collect();
    let b: Vec<_> = cog_levels(rust_display).into_iter().skip(1).collect();
    assert_eq!(a.len(), b.len(), "{label}: overview levels");
    // Cells whose source block holds a non-finite sample, level by level with
    // the writer's own block mapping.
    let mut poisoned: Vec<bool> = full.iter().map(|value| !value.is_finite()).collect();
    let (mut sw, mut sh) = (grid.width as usize, grid.height as usize);
    for (index, ((aw, ah, a), (bw, bh, b))) in a.iter().zip(&b).enumerate() {
        assert_eq!((aw, ah), (bw, bh), "{label}: overview {index} size");
        let (dw, dh) = (*aw as usize, *ah as usize);
        let mut next = vec![false; dw * dh];
        for dy in 0..dh {
            let y0 = dy * sh / dh;
            let y1 = ((dy + 1) * sh / dh).min(sh).max(y0 + 1);
            for dx in 0..dw {
                let x0 = dx * sw / dw;
                let x1 = ((dx + 1) * sw / dw).min(sw).max(x0 + 1);
                next[dy * dw + dx] = (y0..y1).any(|y| (x0..x1).any(|x| poisoned[y * sw + x]));
            }
        }
        poisoned = next;
        (sw, sh) = (dw, dh);
        let mut max = 0f64;
        let mut disagreements = 0usize;
        let mut poisoned_cells = 0usize;
        for (index, (x, y)) in a.iter().zip(b).enumerate() {
            if poisoned[index] {
                poisoned_cells += 1;
                continue;
            }
            match (valid(*x, nodata), valid(*y, nodata)) {
                (true, true) => {
                    let deviation = (f64::from(*x) - f64::from(*y)).abs();
                    if deviation > 1e-3 * f64::from(x.abs().max(1.0)) {
                        disagreements += 1;
                    }
                    max = max.max(deviation);
                }
                (false, false) => {}
                _ => disagreements += 1,
            }
        }
        report.note(format!(
            "{label}: overview {} ({aw}x{ah}) max deviation {max:.3e}, {disagreements} cells beyond tolerance, {poisoned_cells} cells with non-finite sources not compared",
            index + 1
        ));
        assert_eq!(
            disagreements,
            0,
            "{label}: overview {} disagrees",
            index + 1
        );
    }
}

/// The class of the WKT2 gdalinfo reports, in the catalogue's vocabulary.
fn gdal_crs_class(wkt: &str) -> &'static str {
    let wkt = wkt.trim_start();
    if wkt.starts_with("GEOGCRS[") {
        super::super::analyses::CRS_GEOGRAPHIC
    } else if wkt.contains("METHOD[\"Popular Visualisation Pseudo Mercator\"") {
        super::super::analyses::CRS_PROJECTED_OTHER
    } else if wkt.starts_with("PROJCRS[") && wkt.contains("LENGTHUNIT[\"metre\",1]") {
        super::super::analyses::CRS_PROJECTED_METRE
    } else {
        "unknown"
    }
}

/// Point transforms on a 9×9 lon/lat grid inside each table row's area of
/// use (its inner 80%), in both directions, GDAL given the row's own PROJ
/// definition, so the same Helmert shift whatever grids the machine's PROJ
/// holds: forward within 1e-3 m, inverse within 1e-7 deg. How far PROJ's own
/// choice of operation sits is the reference points' business
/// (`crs::tests`).
fn compare_transforms(report: &mut Report, gdal: &GdalEngine, rust: &RustRasterEngine) {
    let c = cancel();
    for row in super::crs_table::ROWS {
        let code = &format!("EPSG:{}", row.code);
        let [lon_min, lat_min, lon_max, lat_max] = row.area;
        let mut geographic = Vec::new();
        for i in 0..9 {
            for j in 0..9 {
                // Inset by a tenth, as the reference grids are: at an area's
                // corners PROJ may have no shift to take.
                let along = |n: i32| 0.1 + 0.8 * f64::from(n) / 8.0;
                geographic.push((
                    lon_min + (lon_max - lon_min) * along(i),
                    lat_min + (lat_max - lat_min) * along(j),
                ));
            }
        }
        let a = gdal
            .transform_points("EPSG:4326", row.proj, &geographic, &c)
            .expect("GDAL forward");
        let b = rust
            .transform_points("EPSG:4326", code, &geographic, &c)
            .expect("Rust forward");
        let mut forward = 0f64;
        let mut projected = Vec::new();
        for (index, (x, y)) in a.iter().zip(&b).enumerate() {
            let (Some(x), Some(y)) = (x, y) else {
                panic!("{code}: point {index} placed by one engine only ({x:?} vs {y:?})");
            };
            forward = forward.max((x.0 - y.0).abs().max((x.1 - y.1).abs()));
            projected.push(*x);
        }
        let a = gdal
            .transform_points(row.proj, "EPSG:4326", &projected, &c)
            .expect("GDAL inverse");
        let b = rust
            .transform_points(code, "EPSG:4326", &projected, &c)
            .expect("Rust inverse");
        let mut inverse = 0f64;
        for (x, y) in a.iter().zip(&b) {
            let (Some(x), Some(y)) = (x, y) else {
                panic!("{code}: inverse placed by one engine only");
            };
            inverse = inverse.max((x.0 - y.0).abs().max((x.1 - y.1).abs()));
        }
        report.note(format!(
            "{code}: forward max deviation {forward:.3e} m over {} points in [{lon_min}, {lon_max}]x[{lat_min}, {lat_max}], inverse {inverse:.3e} deg",
            geographic.len()
        ));
        assert!(forward <= 1e-3, "{code}: forward deviation {forward} m");
        assert!(inverse <= 1e-7, "{code}: inverse deviation {inverse} deg");
    }
}

fn write_raw(dir: &Path, name: &str, width: u32, height: u32) -> PathBuf {
    let values: Vec<f32> = (0..height)
        .flat_map(|y| (0..width).map(move |x| authored(x, y)))
        .collect();
    let raw = dir.join(format!("{name}.raw"));
    super::super::import::write_f32_raw(&raw, &values).expect("raw fixture");
    std::fs::write(
        raw.with_extension("hdr"),
        format!(
            "ENVI\nsamples = {width}\nlines = {height}\nbands = 1\ndata type = 4\nbyte order = 0\nheader offset = 0\n"
        ),
    )
    .expect("ENVI header");
    raw
}

/// GDAL-authored fixtures: one Float32 base and its layout and type variants.
fn gdal_fixtures(dir: &Path, gdal: &GdalEngine) -> Vec<(String, PathBuf)> {
    let c = cancel();
    let (width, height) = (300u32, 260u32);
    let raw = write_raw(dir, "base", width, height);
    let base = dir.join("float32-tiled.tif");
    let placement = [
        "-a_srs",
        "EPSG:2154",
        "-a_ullr",
        "444999.75",
        "6806000.25",
        "445149.75",
        "6805870.25",
        "-a_nodata",
        "-9999",
    ];
    let translate = |extra: &[&str], input: &Path, output: &Path| {
        let mut args: Vec<String> = ["-q", "-of", "GTiff"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        args.extend(extra.iter().map(|s| s.to_string()));
        args.push(input.display().to_string());
        args.push(output.display().to_string());
        gdal.run(GdalProgram::Translate, &args, Some(&c))
            .unwrap_or_else(|error| panic!("{} converts: {error}", output.display()));
    };
    let mut args: Vec<&str> = placement.to_vec();
    args.extend([
        "-co",
        "TILED=YES",
        "-co",
        "COMPRESS=DEFLATE",
        "-co",
        "PREDICTOR=3",
    ]);
    translate(&args, &raw, &base);
    let mut fixtures = vec![("float32-tiled".to_string(), base.clone())];
    let variants: [(&str, &[&str]); 6] = [
        (
            "float32-striped",
            &["-co", "TILED=NO", "-co", "BLOCKYSIZE=32"],
        ),
        (
            "int16-lzw-predictor2",
            &["-ot", "Int16", "-co", "COMPRESS=LZW", "-co", "PREDICTOR=2"],
        ),
        ("byte", &["-ot", "Byte", "-co", "TILED=YES"]),
        ("uint32-bigendian", &["-ot", "UInt32", "-co", "ENDIAN=BIG"]),
        (
            "float64-bigendian-deflate",
            &[
                "-ot",
                "Float64",
                "-co",
                "ENDIAN=BIG",
                "-co",
                "COMPRESS=DEFLATE",
                "-co",
                "TILED=YES",
            ],
        ),
        ("packbits", &["-co", "COMPRESS=PACKBITS"]),
    ];
    for (name, extra) in variants {
        let output = dir.join(format!("{name}.tif"));
        translate(extra, &base, &output);
        fixtures.push((name.to_string(), output));
    }
    // A user-defined Lambert CRS spelled out without a registry code, as IGN
    // tiles carry it.
    let user_defined = dir.join("user-defined-lambert.tif");
    translate(
        &[
            "-a_srs",
            "+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs",
            "-co",
            "TILED=YES",
        ],
        &base,
        &user_defined,
    );
    fixtures.push(("user-defined-lambert".to_string(), user_defined));
    fixtures
}

/// Real tiles in national grids whose display warp is compared too: every
/// GeoTIFF in `CANOPI_LIDAR_REFERENCE_DIR` (the Delft AHN tile in RD New and
/// the Paris IGN tile in spelled-out Lambert-93 keys, for instance).
fn reference_tiles() -> Vec<PathBuf> {
    let Some(dir) = std::env::var_os("CANOPI_LIDAR_REFERENCE_DIR") else {
        return Vec::new();
    };
    let mut tiles: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "tif"))
        .collect();
    tiles.sort();
    tiles
}

fn ign_fixture() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("CANOPI_LIDAR_E2E_FIXTURE") {
        return Some(PathBuf::from(explicit)).filter(|path| path.is_file());
    }
    let downloads = std::env::var_os("HOME")
        .map(PathBuf::from)?
        .join("Downloads");
    let candidates = std::fs::read_dir(&downloads).ok()?;
    for entry in candidates.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("LHD_FXX_") && name.contains("_MNT_") {
            let file = entry.path().join(&name);
            if file.is_file() {
                return Some(file);
            }
        }
    }
    None
}

#[test]
#[ignore = "cross-checks the Rust engine against GDAL (gdalinfo, gdal_translate, gdalwarp, gdaltransform on PATH or CANOPI_LIDAR_GDAL_BIN); skipped cleanly without GDAL"]
fn the_rust_engine_matches_gdal_on_the_same_inputs() {
    let dir = crate::test_scratch::TestScratch::new("engine-comparison");
    let gdal_logs = dir.join("gdal-logs");
    std::fs::create_dir_all(&gdal_logs).expect("GDAL log dir");
    let gdal = GdalEngine::in_dir(gdal_logs);
    let gdal_version = match gdal.version() {
        Ok(version) => version,
        Err(reason) => {
            println!("skipped: {reason}");
            return;
        }
    };
    let rust = RustRasterEngine;
    let mut report = Report { lines: Vec::new() };
    report.note(format!(
        "comparing {} with {gdal_version}",
        rust.version().expect("engine version")
    ));

    for (label, path) in gdal_fixtures(&dir, &gdal) {
        compare_source(&mut report, &label, &path, &dir, &gdal, &rust);
    }
    match ign_fixture() {
        Some(fixture) => {
            report.note(format!("IGN fixture: {}", fixture.display()));
            compare_source(&mut report, "ign-mnt", &fixture, &dir, &gdal, &rust);
        }
        None => report.note("IGN fixture: not present, skipped".to_string()),
    }
    for tile in reference_tiles() {
        let label = tile
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        report.note(format!("reference tile: {}", tile.display()));
        compare_display(&mut report, &label, &tile, &dir, &gdal, &rust, None);
    }
    compare_transforms(&mut report, &gdal, &rust);

    println!("\n=== engine comparison report ===");
    for line in &report.lines {
        println!("{line}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// One level's agreement with the oracle: interior cells (all nine of the
/// stencil inside the band and valid) beyond ±1 grey and their largest
/// deviation, and the same for edge cells, which are reported only.
#[derive(Default, Debug)]
struct Agreement {
    interior: usize,
    interior_beyond: usize,
    interior_max: f64,
    edge: usize,
    edge_beyond: usize,
    edge_max: f64,
    validity_mismatch: usize,
}

/// `gdal_translate` with fixed arguments into `output`.
fn translate(gdal: &GdalEngine, args: &[&str], input: &Path, output: &Path) {
    let mut argv: Vec<String> = ["-q", "--config", "GDAL_PAM_ENABLED", "NO"]
        .into_iter()
        .chain(args.iter().copied())
        .map(str::to_string)
        .collect();
    argv.push(input.display().to_string());
    argv.push(output.display().to_string());
    gdal.run(GdalProgram::Translate, &argv, None)
        .unwrap_or_else(|error| panic!("gdal_translate {args:?}: {error}"));
}

/// gdaldem's hillshade of `input` with the light and defaults of D2.
fn gdaldem_hillshade(gdal: &GdalEngine, input: &Path, output: &Path) {
    let argv: Vec<String> = [
        "hillshade",
        "-q",
        "-az",
        "315",
        "-alt",
        "45",
        "-z",
        "1",
        "-compute_edges",
        "--config",
        "GDAL_PAM_ENABLED",
        "NO",
    ]
    .into_iter()
    .map(str::to_string)
    .chain([input.display().to_string(), output.display().to_string()])
    .collect();
    gdal.run(GdalProgram::Dem, &argv, None)
        .unwrap_or_else(|error| panic!("gdaldem hillshade: {error}"));
}

/// Canopi's relief of native level `level` of `samples` (`grid` in `crs_ref`),
/// shaded on that level's grid before any warp.
fn native_relief(
    samples: &[f32],
    grid: &RasterGrid,
    crs_ref: &str,
    nodata: Option<f32>,
    level: u32,
) -> (RasterGrid, Vec<f32>) {
    use super::cog::BandSource as _;
    let dims = super::cog::level_dims(grid.width, grid.height, level);
    let (width, height) = dims[level as usize];
    let gt = grid.geotransform;
    let native = RasterGrid {
        width,
        height,
        geotransform: [
            gt[0],
            gt[1] * f64::from(grid.width) / f64::from(width),
            0.0,
            gt[3],
            0.0,
            gt[5] * f64::from(grid.height) / f64::from(height),
        ],
    };
    let mut band: Box<dyn super::cog::BandSource> = Box::new(super::cog::SliceSource {
        samples,
        width: grid.width,
    });
    for dims in &dims[..level as usize] {
        band = Box::new(super::cog::Halved::new(band, *dims, nodata, u64::MAX));
    }
    let crs = super::crs::from_reference(crs_ref).expect("the fixture's CRS resolves");
    let mut shaded = super::relief::Shaded::new(
        band,
        (width, height),
        nodata,
        super::row_ground_sizes(&native, &crs).expect("ground sizes"),
        super::DISPLAY_NODATA,
    );
    let mut out = vec![0f32; (width * height) as usize];
    shaded
        .read(
            super::super::prepared_raster::RasterWindow {
                x: 0,
                y: 0,
                width,
                height,
            },
            &mut out,
            &cancel(),
        )
        .expect("the relief reads");
    (native, out)
}

/// Shading agreement on the native grid of one level: `gdal` is gdaldem's
/// Byte output (0 where it wrote nothing), `elevation` the averaged level it
/// shaded.
fn native_agreement(
    ours: &[f32],
    gdal: &[f32],
    elevation: &[f32],
    width: u32,
    height: u32,
    nodata: Option<f32>,
) -> Agreement {
    let mut agreement = Agreement::default();
    let (w, h) = (width as i64, height as i64);
    for y in 0..h {
        for x in 0..w {
            let index = (y * w + x) as usize;
            let mine = valid(ours[index], Some(super::DISPLAY_NODATA));
            let theirs = gdal[index] != 0.0 && gdal[index].is_finite();
            if mine != theirs {
                agreement.validity_mismatch += 1;
                continue;
            }
            if !mine {
                continue;
            }
            let interior = (-1..=1).all(|dy| {
                (-1..=1).all(|dx| {
                    let (nx, ny) = (x + dx, y + dy);
                    (0..w).contains(&nx)
                        && (0..h).contains(&ny)
                        && valid(elevation[(ny * w + nx) as usize], nodata)
                })
            });
            let deviation = (f64::from(ours[index]) - f64::from(gdal[index])).abs();
            if interior {
                agreement.interior += 1;
                agreement.interior_max = agreement.interior_max.max(deviation);
                agreement.interior_beyond += usize::from(deviation > 1.0);
            } else {
                agreement.edge += 1;
                agreement.edge_max = agreement.edge_max.max(deviation);
                agreement.edge_beyond += usize::from(deviation > 1.0);
            }
        }
    }
    agreement
}

/// D3 against the oracle on the real IGN LiDAR HD tile: for each level `k`
/// of the relief derivative, GDAL averages the tile to its level-`k` size
/// (`gdal_translate -r average`), shades it (`gdaldem hillshade -az 315 -alt
/// 45 -z 1 -compute_edges`) and warps it by nearest neighbour onto lattice
/// level `k` (`gdalwarp -r near`). Interior cells agree within ±1 grey on the
/// native grid and on the lattice (a lattice pixel whose centre lies within
/// a centimetre of a native cell edge may take the cell beside it, as in the
/// display comparison); edge cells are counted and reported. The tile split
/// in two (`-srcwin`) leaves no gap and no double cover on any level.
#[test]
#[ignore = "local fixture: the IGN LiDAR HD tile and gdaldem on PATH; see CANOPI_LIDAR_E2E_FIXTURE"]
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn e2e_relief_matches_gdaldem_horn() {
    let dir = crate::test_scratch::TestScratch::new("relief-comparison");
    let gdal_logs = dir.join("gdal-logs");
    std::fs::create_dir_all(&gdal_logs).expect("GDAL log dir");
    let gdal = GdalEngine::in_dir(gdal_logs);
    match gdal.discover() {
        Ok(tools) if tools.gdaldem.is_some() => {}
        Ok(_) => return println!("skipped: gdaldem not found"),
        Err(reason) => return println!("skipped: {reason}"),
    }
    let Some(fixture) = ign_fixture() else {
        return println!("skipped: the IGN LiDAR HD tile is not present");
    };
    let rust = RustRasterEngine;
    let c = cancel();
    let mut report = Report { lines: Vec::new() };
    let probe = rust.probe(&fixture, &c).expect("the tile probes");
    let grid = RasterGrid {
        width: probe.width,
        height: probe.height,
        geotransform: probe.geotransform,
    };
    let nodata = probe.nodata;
    let zoom = super::display_zoom(&probe.crs_ref, [&grid]).expect("display zoom");
    let relief = dir.join("ign-relief.tif");
    let started = std::time::Instant::now();
    rust.write_relief_cog(RasterInput::File(&fixture), &relief, None, None, zoom, &c)
        .expect("the Rust engine writes the relief");
    report.note(format!(
        "relief of {} ({}x{}) at zoom {zoom} in {:.2?}",
        fixture.display(),
        grid.width,
        grid.height,
        started.elapsed()
    ));
    let display = dir.join("ign-display.tif");
    rust.write_display_cog(RasterInput::File(&fixture), &display, None, None, zoom, &c)
        .expect("the Rust engine writes the display derivative");
    let levels = cog_levels(&relief);
    assert_eq!(
        levels.len(),
        cog_levels(&display).len(),
        "the relief has the display derivative's level count"
    );
    let (lattice, definition) =
        super::display_lattice(&grid, &probe.crs_ref, zoom).expect("lattice");
    let samples = rust
        .read_f32(&fixture, grid.width, grid.height, &c)
        .expect("the tile reads");

    let mut failures = Vec::new();
    for (level, (width, height, ours)) in levels.iter().enumerate() {
        let k = level as u32;
        // GDAL's level: the tile averaged once to the level's size.
        let (native, mine) = native_relief(&samples, &grid, &probe.crs_ref, nodata, k);
        let averaged = if k == 0 {
            fixture.clone()
        } else {
            let output = dir.join(format!("average-{k}.tif"));
            translate(
                &gdal,
                &[
                    "-r",
                    "average",
                    "-ot",
                    "Float32",
                    "-outsize",
                    &native.width.to_string(),
                    &native.height.to_string(),
                ],
                &fixture,
                &output,
            );
            output
        };
        let shade = dir.join(format!("gdaldem-{k}.tif"));
        gdaldem_hillshade(&gdal, &averaged, &shade);
        let theirs = gdal
            .read_f32(&shade, native.width, native.height, &c)
            .expect("gdaldem's relief reads");
        let elevation = gdal
            .read_f32(&averaged, native.width, native.height, &c)
            .expect("the averaged level reads");
        let agreement = native_agreement(
            &mine,
            &theirs,
            &elevation,
            native.width,
            native.height,
            nodata,
        );
        report.note(format!(
            "level {k} native {}x{} ({:.2} m): {} interior cells, {} beyond ±1 grey (max {}); {} edge cells, {} beyond (max {}); {} validity mismatches",
            native.width,
            native.height,
            native.geotransform[1],
            agreement.interior,
            agreement.interior_beyond,
            agreement.interior_max,
            agreement.edge,
            agreement.edge_beyond,
            agreement.edge_max,
            agreement.validity_mismatch
        ));
        if agreement.interior_beyond > 0 || agreement.validity_mismatch > 0 {
            failures.push(format!("level {k} native: {agreement:?}"));
        }

        // The oracle warped onto lattice level k.
        let scale = f64::from(1u32 << k);
        let level_lattice = RasterGrid {
            width: lattice.width >> k,
            height: lattice.height >> k,
            geotransform: [
                lattice.geotransform[0],
                lattice.geotransform[1] * scale,
                0.0,
                lattice.geotransform[3],
                0.0,
                lattice.geotransform[5] * scale,
            ],
        };
        assert_eq!(
            (level_lattice.width, level_lattice.height),
            (*width, *height),
            "level {k} sits on lattice level {k}"
        );
        let warped = dir.join(format!("gdaldem-{k}-3857.tif"));
        let args = super::super::gdal_engine::display_warp_arguments(
            &shade,
            &warped,
            definition,
            &level_lattice,
            Some(0.0),
            super::DISPLAY_NODATA,
        );
        gdal.run(GdalProgram::Warp, &args, None).expect("gdalwarp");
        let oracle = gdal
            .read_f32(&warped, *width, *height, &c)
            .expect("the warped oracle reads");
        let shown = |value: f32| valid(value, Some(super::DISPLAY_NODATA));
        let differing: Vec<usize> = (0..ours.len())
            .filter(|index| {
                let (a, b) = (ours[*index], oracle[*index]);
                shown(a) != shown(b) || (shown(a) && (f64::from(a) - f64::from(b)).abs() > 1.0)
            })
            .collect();
        let gt = level_lattice.geotransform;
        let centres: Vec<(f64, f64)> = differing
            .iter()
            .map(|index| {
                let (column, row) = (index % *width as usize, index / *width as usize);
                (
                    gt[0] + (column as f64 + 0.5) * gt[1],
                    gt[3] + (row as f64 + 0.5) * gt[5],
                )
            })
            .collect();
        let placed = rust
            .transform_points("EPSG:3857", &probe.crs_ref, &centres, &c)
            .expect("centres place");
        let ngt = native.geotransform;
        let (mut tie, mut interior, mut edge) = (0usize, 0usize, 0usize);
        for point in placed {
            let (x, y) = point.expect("a differing centre places natively");
            let fraction = |coordinate: f64, origin: f64, cell: f64| (coordinate - origin) / cell;
            let (fx, fy) = (fraction(x, ngt[0], ngt[1]), fraction(y, ngt[3], ngt[5]));
            let near_edge = |f: f64, cell: f64| (f - f.round()).abs() * cell.abs() <= 0.01;
            let (cx, cy) = (fx.floor() as i64, fy.floor() as i64);
            let inside = (1..i64::from(native.width) - 1).contains(&cx)
                && (1..i64::from(native.height) - 1).contains(&cy)
                && (-1..=1).all(|dy| {
                    (-1..=1).all(|dx| {
                        valid(
                            elevation[((cy + dy) * i64::from(native.width) + cx + dx) as usize],
                            nodata,
                        )
                    })
                });
            if near_edge(fx, ngt[1]) || near_edge(fy, ngt[5]) {
                tie += 1;
            } else if inside {
                interior += 1;
            } else {
                edge += 1;
            }
        }
        report.note(format!(
            "level {k} lattice {width}x{height}: {} pixels shown, {interior} interior beyond ±1 grey, {edge} edge beyond, {tie} at a native cell edge",
            ours.iter().filter(|value| shown(**value)).count()
        ));
        if interior > 0 {
            failures.push(format!("level {k} lattice: {interior} interior pixels"));
        }
    }

    // The tile in two halves: every lattice pixel of the whole is shown by
    // exactly one half, on every level.
    let half = grid.width / 2;
    let parts: Vec<PathBuf> = [(0, half), (half, grid.width - half)]
        .into_iter()
        .enumerate()
        .map(|(index, (x, width))| {
            let part = dir.join(format!("half-{index}.tif"));
            translate(
                &gdal,
                &[
                    "-srcwin",
                    &x.to_string(),
                    "0",
                    &width.to_string(),
                    &grid.height.to_string(),
                ],
                &fixture,
                &part,
            );
            part
        })
        .collect();
    let grids: Vec<RasterGrid> = parts
        .iter()
        .map(|part| {
            let probe = rust.probe(part, &c).expect("a half probes");
            RasterGrid {
                width: probe.width,
                height: probe.height,
                geotransform: probe.geotransform,
            }
        })
        .collect();
    let split_zoom = super::display_zoom(&probe.crs_ref, grids.iter()).expect("zoom");
    assert_eq!(split_zoom, zoom, "the halves draw at the tile's zoom");
    let halves: Vec<(RasterGrid, Vec<Level>)> = parts
        .iter()
        .map(|part| {
            let output = part.with_extension("relief.tif");
            rust.write_relief_cog(RasterInput::File(part), &output, None, None, zoom, &c)
                .expect("a half's relief");
            let probe = rust.probe(&output, &c).expect("a half's relief probes");
            (
                RasterGrid {
                    width: probe.width,
                    height: probe.height,
                    geotransform: probe.geotransform,
                },
                cog_levels(&output),
            )
        })
        .collect();
    for (level, (width, height, whole)) in levels.iter().enumerate() {
        let shown = |value: f32| valid(value, Some(super::DISPLAY_NODATA));
        let resolution = lattice.geotransform[1] * f64::from(1u32 << level);
        let mut cover = vec![0u8; whole.len()];
        for (part_grid, part_levels) in &halves {
            let (part_width, part_height, part) = &part_levels[level];
            let dx =
                ((part_grid.geotransform[0] - lattice.geotransform[0]) / resolution).round() as i64;
            let dy =
                ((lattice.geotransform[3] - part_grid.geotransform[3]) / resolution).round() as i64;
            for row in 0..i64::from(*part_height) {
                for column in 0..i64::from(*part_width) {
                    if !shown(part[(row * i64::from(*part_width) + column) as usize]) {
                        continue;
                    }
                    let (x, y) = (column + dx, row + dy);
                    assert!(
                        (0..i64::from(*width)).contains(&x) && (0..i64::from(*height)).contains(&y),
                        "level {level}: a half shows a pixel outside the whole"
                    );
                    cover[(y * i64::from(*width) + x) as usize] += 1;
                }
            }
        }
        let gaps = (0..whole.len())
            .filter(|index| shown(whole[*index]) && cover[*index] == 0)
            .count();
        let doubles = cover.iter().filter(|count| **count > 1).count();
        report.note(format!(
            "level {level} split at column {half}: {gaps} gaps, {doubles} double cover"
        ));
        if gaps > 0 || doubles > 0 {
            failures.push(format!(
                "level {level} split: {gaps} gaps, {doubles} doubles"
            ));
        }
    }

    println!("\n=== relief comparison report ===");
    for line in &report.lines {
        println!("{line}");
    }
    let _ = std::fs::remove_dir_all(&dir);
    assert!(failures.is_empty(), "{failures:#?}");
}
