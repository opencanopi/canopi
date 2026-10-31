//! The pure-Rust raster engine (ADR 0014).
//!
//! In-process reading, conversion, statistics and reprojection: `wbgeotiff`
//! for TIFF/COG primitives (the engine reads GeoTIFF only) and the
//! one CRS authority (`crs.rs` on `proj4rs` over the `crs_table.rs` rows).
//! Nothing is bundled or discovered at run time; the engine is always
//! available and its version names the crates.
//!
//! Memory: a GeoTIFF converts through the one writer in row windows of at
//! most the library's capacity limit (`import::MAX_RAW_EXTRACTION_CELLS`),
//! whatever its size; each overview level is averaged from the level before
//! it, read back from the file being written. Beside the windows the writer
//! holds one output tile and the reader one decoded chunk of at most
//! `tiff::MAX_STREAMED_CHUNK_BYTES`. A GeoTIFF with a larger compressed
//! chunk is loaded whole after the capacity check, with
//! the same named reason every whole-raster read gives. Cancellation is
//! honoured between windows, chunks and levels.

mod cog;
#[cfg(test)]
mod comparison;
mod crs;
#[cfg(test)]
mod crs_reference_points;
pub(crate) mod crs_table;
mod relief;
mod source;
mod tiff;
mod warp;

pub(crate) use crs_table::CrsKind;
pub(crate) use tiff::is_tiff;

#[cfg(test)]
use super::engine::RasterStatistics;
use super::engine::{
    DISPLAY_NODATA, ProbeError, RasterEngine, RasterGeoref, RasterInput, RasterProbe, bounds_of,
    check_cancel, grid_corners,
};
use super::grid::RasterGrid;
use super::import::{raw_extraction_cells, validate_working_grid};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use wbgeotiff::tags::Compression;

/// The crate versions this build compiles in; `tests` pins them to `Cargo.lock`.
pub(super) const WBGEOTIFF_VERSION: &str = "0.1.2";
pub(super) const WBGEOTIFF_REVISION: &str = "9c0ff4fdf3513f27b89c78e294610c3b418b3a4f";
pub(crate) const PROJ4RS_VERSION: &str = "0.2.0";

/// The kind of a stored reference's row; `None` for a reference Canopi
/// does not place.
pub(crate) fn crs_kind(reference: &str) -> Option<CrsKind> {
    crs::from_reference(reference).ok().map(|crs| crs.kind())
}

/// WGS84's meridional and prime-vertical radii at latitude `lat` (degrees).
fn wgs84_radii(lat: f64) -> (f64, f64) {
    const A: f64 = 6_378_137.0;
    const E2: f64 = 0.006_694_379_990_14;
    let phi = lat.to_radians();
    let w = (1.0 - E2 * phi.sin().powi(2)).sqrt();
    (A * (1.0 - E2) / w.powi(3), A / w)
}

/// The ground size of one cell of `grid` in `crs_ref`, in metres: a metre
/// grid's own pixel size; for degrees or Web Mercator's stretched metres, the
/// side of a square with the cell's ground area at the grid's centre (on the
/// WGS84 ellipsoid's local radii). `None` for a CRS Canopi does not place.
pub(crate) fn cell_ground_size_m(grid: &RasterGrid, crs_ref: &str) -> Option<f64> {
    let native = crs::from_reference(crs_ref).ok()?;
    let (x, y) = grid.pixel_size();
    let size = if native.kind() == CrsKind::ProjectedMetre {
        (x * y).sqrt()
    } else {
        let to_wgs84 = crs::Transformer::new(&native, &crs::from_reference("EPSG:4326").ok()?);
        let gt = grid.geotransform;
        let centre_x = gt[0] + gt[1] * f64::from(grid.width) / 2.0;
        let centre_y = gt[3] + gt[5] * f64::from(grid.height) / 2.0;
        let (lon, lat) = to_wgs84.apply(centre_x, centre_y).ok()?;
        let (east_lon, _) = to_wgs84.apply(centre_x + x, centre_y).ok()?;
        let (_, north_lat) = to_wgs84.apply(centre_x, centre_y + y).ok()?;
        let (meridional, prime_vertical) = wgs84_radii(lat);
        let phi = lat.to_radians();
        let east = (east_lon - lon).abs().to_radians() * prime_vertical * phi.cos();
        let north = (north_lat - lat).abs().to_radians() * meridional;
        (east * north).sqrt()
    };
    (size.is_finite() && size > 0.0).then_some(size)
}

/// The east-west and north-south ground sizes of a cell of each row of
/// `grid` in `native`, in metres, at the row's latitude: degrees through the
/// WGS84 radii (as [`cell_ground_size_m`]), Mercator metres as nominal ×
/// cos(latitude), any other projected grid nominal (as gdaldem).
fn row_ground_sizes(
    grid: &RasterGrid,
    native: &crs::ResolvedCrs,
) -> Result<Vec<(f64, f64)>, String> {
    let gt = grid.geotransform;
    let (x, y) = (gt[1].abs(), gt[5].abs());
    if native.kind() == CrsKind::ProjectedMetre {
        return Ok(vec![(x, y); grid.height as usize]);
    }
    let to_wgs84 = crs::Transformer::new(native, &crs::from_reference("EPSG:4326")?);
    let centre_x = gt[0] + gt[1] * f64::from(grid.width) / 2.0;
    (0..grid.height)
        .map(|row| {
            let row_y = gt[3] + gt[5] * (f64::from(row) + 0.5);
            let (lon, lat) = to_wgs84.apply(centre_x, row_y)?;
            let phi = lat.to_radians();
            let sizes = if native.kind() == CrsKind::Geographic {
                let (east_lon, _) = to_wgs84.apply(centre_x + x, row_y)?;
                let (_, north_lat) = to_wgs84.apply(centre_x, row_y + y)?;
                let (meridional, prime_vertical) = wgs84_radii(lat);
                (
                    (east_lon - lon).abs().to_radians() * prime_vertical * phi.cos(),
                    (north_lat - lat).abs().to_radians() * meridional,
                )
            } else {
                (x * phi.cos(), y * phi.cos())
            };
            if sizes.0 > 0.0 && sizes.1 > 0.0 && sizes.0.is_finite() && sizes.1.is_finite() {
                Ok(sizes)
            } else {
                Err("the raster's cell size cannot be shaded".to_string())
            }
        })
        .collect()
}

/// The display zoom of an item whose parts are `grids` in `crs_ref`: every
/// part's derivative is written at it, so the parts share one lattice (A2).
pub(crate) fn display_zoom<'a>(
    crs_ref: &str,
    grids: impl IntoIterator<Item = &'a RasterGrid>,
) -> Result<u32, String> {
    warp::zoom(&crs::from_reference(crs_ref)?, grids)
}

/// The Web Mercator lattice grid a display derivative of `grid` in
/// `crs_ref` is written on at `zoom`, and the row's definition: what the
/// GDAL oracle warps with (A6).
#[cfg(test)]
pub(crate) fn display_lattice(
    grid: &RasterGrid,
    crs_ref: &str,
    zoom: u32,
) -> Result<(RasterGrid, &'static str), String> {
    let native = crs::from_reference(crs_ref)?;
    let row = crs_table::row_of(native.code()).ok_or_else(|| format!("{crs_ref} has no row"))?;
    Ok((warp::lattice(grid, &native, zoom)?, row.proj))
}

/// What a manifest records as the engine that produced a numeric output.
pub(super) fn engine_version() -> String {
    format!(
        "canopi-raster-engine (wbgeotiff {WBGEOTIFF_VERSION}@{}, proj4rs {PROJ4RS_VERSION})",
        &WBGEOTIFF_REVISION[..7]
    )
}

/// Band samples a conversion holds outside its fixed working set (one output
/// tile and one decoded source chunk): row windows, halving windows and whole
/// loads. Tests read their high-water mark through [`high_water`];
/// production builds keep no count.
pub(super) struct Cells {
    samples: Vec<f32>,
}

impl Cells {
    pub(super) fn new(samples: Vec<f32>) -> Self {
        #[cfg(test)]
        high_water::add(samples.len() as u64);
        Self { samples }
    }

    pub(super) fn zeroed(len: usize) -> Self {
        Self::new(vec![0.0; len])
    }

    /// The samples, no longer counted as held by the conversion.
    pub(super) fn into_vec(mut self) -> Vec<f32> {
        // Drop counts what is left, which is nothing once taken.
        #[cfg(test)]
        high_water::remove(self.samples.len() as u64);
        std::mem::take(&mut self.samples)
    }
}

impl std::ops::Deref for Cells {
    type Target = [f32];

    fn deref(&self) -> &[f32] {
        &self.samples
    }
}

impl std::ops::DerefMut for Cells {
    fn deref_mut(&mut self) -> &mut [f32] {
        &mut self.samples
    }
}

#[cfg(test)]
impl Drop for Cells {
    fn drop(&mut self) {
        high_water::remove(self.samples.len() as u64);
    }
}

/// Test-only high-water mark of [`Cells`] on this thread.
#[cfg(test)]
pub(super) mod high_water {
    use std::cell::Cell;

    thread_local! {
        /// `(held now, most held since the last reset)`.
        static CELLS: Cell<(u64, u64)> = const { Cell::new((0, 0)) };
    }

    pub(super) fn add(cells: u64) {
        CELLS.with(|slot| {
            let (now, peak) = slot.get();
            slot.set((now + cells, peak.max(now + cells)));
        });
    }

    pub(super) fn remove(cells: u64) {
        CELLS.with(|slot| {
            let (now, peak) = slot.get();
            slot.set((now.saturating_sub(cells), peak));
        });
    }

    /// Start a new measurement from what is held now.
    pub(super) fn reset() {
        CELLS.with(|slot| {
            let (now, _) = slot.get();
            slot.set((now, now));
        });
    }

    pub(super) fn peak() -> u64 {
        CELLS.with(|slot| slot.get().1)
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RustRasterEngine;

/// A band ready to be written: its placement, CRS and validity rule.
struct Prepared<'a> {
    grid: RasterGrid,
    crs: crs::ResolvedCrs,
    nodata: Option<f32>,
    band: PreparedBand<'a>,
}

enum PreparedBand<'a> {
    Samples(&'a [f32]),
    Source(source::Band),
}

/// What the one writer writes.
enum Target {
    /// The band in its own CRS with this profile.
    Native(cog::CogProfile),
    /// A display derivative warped to Web Mercator at the item's zoom.
    Display { zoom: u32 },
    /// The relief derivative of an elevation, on the display's lattice.
    Relief { zoom: u32 },
}

impl RustRasterEngine {
    fn prepare<'a>(
        input: RasterInput<'a>,
        georef: Option<RasterGeoref<'_>>,
        nodata: Option<f32>,
        operation: &str,
        cancel: &AtomicBool,
    ) -> Result<Prepared<'a>, String> {
        check_cancel(cancel)?;
        match input {
            RasterInput::Samples { grid, values } => {
                let georef = georef
                    .ok_or_else(|| "samples need a georeference to become a raster".to_string())?;
                if georef.grid != grid {
                    return Err("the samples' grid and their georeference disagree".to_string());
                }
                validate_working_grid(grid, operation)?;
                let cells = usize::try_from(u64::from(grid.width) * u64::from(grid.height))
                    .map_err(|_| "raster is too large for this platform".to_string())?;
                if values.len() != cells {
                    return Err(format!(
                        "{} samples do not fill a {}x{} grid",
                        values.len(),
                        grid.width,
                        grid.height
                    ));
                }
                Ok(Prepared {
                    grid: grid.clone(),
                    crs: crs::from_reference(georef.crs)?,
                    nodata,
                    band: PreparedBand::Samples(values),
                })
            }
            RasterInput::File(path) => {
                let opened = source::open(path, operation, cancel)?;
                check_cancel(cancel)?;
                let (grid, crs) = match georef {
                    Some(georef) => {
                        if georef.grid.width != opened.grid.width
                            || georef.grid.height != opened.grid.height
                        {
                            return Err(format!(
                                "the georeference is {}x{} but {} is {}x{}",
                                georef.grid.width,
                                georef.grid.height,
                                path.display(),
                                opened.grid.width,
                                opened.grid.height
                            ));
                        }
                        (georef.grid.clone(), crs::from_reference(georef.crs)?)
                    }
                    None => {
                        let crs = opened.crs.ok_or_else(|| {
                            format!(
                                "{} has no coordinate system; Canopi requires a horizontal CRS",
                                path.display()
                            )
                        })?;
                        (opened.grid, crs)
                    }
                };
                Ok(Prepared {
                    grid,
                    crs,
                    nodata: nodata.or(opened.nodata),
                    band: PreparedBand::Source(opened.band),
                })
            }
        }
    }

    /// Write a prepared band through the one writer, in row windows of at
    /// most the capacity limit.
    fn write(
        prepared: Prepared<'_>,
        output: &Path,
        target: Target,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        let width = prepared.grid.width;
        let mut slice;
        let mut reader;
        let band: &mut dyn cog::BandSource = match prepared.band {
            PreparedBand::Samples(samples) => {
                slice = cog::SliceSource { samples, width };
                &mut slice
            }
            PreparedBand::Source(source::Band::Whole(ref samples)) => {
                slice = cog::SliceSource { samples, width };
                &mut slice
            }
            PreparedBand::Source(source::Band::Streamed(streamed)) => {
                reader = streamed;
                &mut reader
            }
        };
        let profile = match target {
            Target::Native(profile) => profile,
            Target::Relief { zoom } => {
                return warp::write_relief(
                    output,
                    &prepared.grid,
                    &prepared.crs,
                    zoom,
                    band,
                    prepared.nodata,
                    DISPLAY_NODATA,
                    raw_extraction_cells(),
                    cancel,
                );
            }
            Target::Display { zoom } => {
                return warp::write(
                    output,
                    &prepared.grid,
                    &prepared.crs,
                    zoom,
                    band,
                    prepared.nodata.unwrap_or(DISPLAY_NODATA),
                    raw_extraction_cells(),
                    cancel,
                );
            }
        };
        cog::write(
            output,
            cog::CogGeoref {
                grid: &prepared.grid,
                geo_keys: Some(&crs::geokeys_for(&prepared.crs)),
            },
            prepared.nodata,
            band,
            profile,
            raw_extraction_cells(),
            cancel,
        )
    }
}

impl RustRasterEngine {
    /// Write the relief derivative of the elevation `input` to `output`: grey
    /// shaded relief on the lattice pixels, and with the levels, of its
    /// display derivative at `zoom` (`warp::write_relief`). Not on the engine
    /// seam: only the Rust engine draws relief, and the comparison lane holds
    /// it to gdaldem.
    pub(crate) fn write_relief_cog(
        &self,
        input: RasterInput<'_>,
        output: &Path,
        georef: Option<RasterGeoref<'_>>,
        nodata: Option<f32>,
        zoom: u32,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        let prepared = Self::prepare(input, georef, nodata, "the relief derivative", cancel)?;
        Self::write(prepared, output, Target::Relief { zoom }, cancel)
    }
}

impl RasterEngine for RustRasterEngine {
    fn version(&self) -> Result<String, String> {
        Ok(engine_version())
    }

    fn probe(&self, raster: &Path, cancel: &AtomicBool) -> Result<RasterProbe, ProbeError> {
        check_cancel(cancel)?;
        source::probe(raster)
    }

    #[cfg(test)]
    fn statistics(&self, raster: &Path, cancel: &AtomicBool) -> Result<RasterStatistics, String> {
        let opened = source::open(raster, "raster statistics", cancel)?;
        check_cancel(cancel)?;
        let nodata = opened.nodata;
        let samples = opened.into_samples("raster statistics", cancel)?;
        let valid = |value: &f32| value.is_finite() && nodata.is_none_or(|marker| *value != marker);
        let mut minimum = f64::INFINITY;
        let mut maximum = f64::NEG_INFINITY;
        let mut sum = 0f64;
        let mut count = 0u64;
        for value in samples.iter().filter(|value| valid(value)) {
            let value = f64::from(*value);
            minimum = minimum.min(value);
            maximum = maximum.max(value);
            sum += value;
            count += 1;
        }
        if count == 0 {
            return Ok(RasterStatistics {
                minimum: 0.0,
                maximum: 0.0,
                mean: 0.0,
                std_dev: 0.0,
                valid_percent: 0.0,
            });
        }
        let mean = sum / count as f64;
        let squares: f64 = samples
            .iter()
            .filter(|value| valid(value))
            .map(|value| (f64::from(*value) - mean).powi(2))
            .sum();
        Ok(RasterStatistics {
            minimum,
            maximum,
            mean,
            std_dev: (squares / count as f64).sqrt(),
            valid_percent: count as f64 * 100.0 / samples.len() as f64,
        })
    }

    fn wgs84_extent(&self, raster: &Path, cancel: &AtomicBool) -> Result<[f64; 4], String> {
        let probe = self.probe(raster, cancel)?;
        if probe.crs_ref.is_empty() {
            return Err("the raster has no geographic extent".to_string());
        }
        let placed = self.transform_points(
            &probe.crs_ref,
            "EPSG:4326",
            &grid_corners(&source::grid_of(&probe)),
            cancel,
        )?;
        bounds_of(&placed).ok_or_else(|| "the raster has no geographic extent".to_string())
    }

    fn read_f32(
        &self,
        raster: &Path,
        width: u32,
        height: u32,
        cancel: &AtomicBool,
    ) -> Result<Vec<f32>, String> {
        let opened = source::open(raster, "raw raster extraction", cancel)?;
        if opened.grid.width != width || opened.grid.height != height {
            return Err(format!(
                "raw raster buffer has {} bytes, expected {}",
                u64::from(opened.grid.width) * u64::from(opened.grid.height) * 4,
                u64::from(width) * u64::from(height) * 4
            ));
        }
        opened.into_samples("raw raster extraction", cancel)
    }

    fn write_geotiff(
        &self,
        output: &Path,
        georef: RasterGeoref<'_>,
        nodata: f32,
        values: &[f32],
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        let prepared = Self::prepare(
            RasterInput::Samples {
                grid: georef.grid,
                values,
            },
            Some(georef),
            Some(nodata),
            "the raster output",
            cancel,
        )?;
        Self::write(
            prepared,
            output,
            Target::Native(cog::CogProfile {
                compression: Compression::Deflate,
                overviews: false,
            }),
            cancel,
        )
    }

    fn write_controlled_cog(
        &self,
        input: RasterInput<'_>,
        output: &Path,
        georef: Option<RasterGeoref<'_>>,
        nodata: Option<f32>,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        let prepared = Self::prepare(input, georef, nodata, "the raster conversion", cancel)?;
        Self::write(
            prepared,
            output,
            Target::Native(cog::CogProfile {
                compression: Compression::None,
                overviews: false,
            }),
            cancel,
        )
    }

    fn write_display_cog(
        &self,
        input: RasterInput<'_>,
        output: &Path,
        georef: Option<RasterGeoref<'_>>,
        nodata: Option<f32>,
        zoom: u32,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        let prepared = Self::prepare(input, georef, nodata, "the display derivative", cancel)?;
        Self::write(prepared, output, Target::Display { zoom }, cancel)
    }

    fn transform_points(
        &self,
        source_crs: &str,
        target_crs: &str,
        points: &[(f64, f64)],
        cancel: &AtomicBool,
    ) -> Result<Vec<Option<(f64, f64)>>, String> {
        check_cancel(cancel)?;
        let transformer = crs::Transformer::new(
            &crs::from_reference(source_crs)?,
            &crs::from_reference(target_crs)?,
        );
        Ok(points
            .iter()
            .map(|(x, y)| {
                transformer
                    .apply(*x, *y)
                    .ok()
                    .filter(|(x, y)| x.is_finite() && y.is_finite())
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::super::prepared_raster::{PreparedRaster, RasterWindow};
    use super::*;
    use std::sync::atomic::Ordering;

    fn scratch(label: &str) -> crate::test_scratch::TestScratch {
        crate::test_scratch::TestScratch::new(&format!("rust-engine-{label}"))
    }

    fn cancel() -> AtomicBool {
        AtomicBool::new(false)
    }

    /// Authored values with every special Float32 case.
    fn value(x: u32, y: u32) -> f32 {
        match (x % 23, y % 17) {
            (0, 0) => -9999.0,
            (1, 1) => f32::NAN,
            (2, 2) => f32::INFINITY,
            (3, 3) => 0.0,
            (4, 4) => -12.5,
            _ => (x as f32) * 0.5 - (y as f32) * 0.25,
        }
    }

    fn values(width: u32, height: u32) -> Vec<f32> {
        (0..height)
            .flat_map(|y| (0..width).map(move |x| value(x, y)))
            .collect()
    }

    fn grid(width: u32, height: u32) -> RasterGrid {
        RasterGrid {
            width,
            height,
            geotransform: [444_999.75, 0.5, 0.0, 6_806_000.25, 0.0, -0.5],
        }
    }

    fn assert_same_samples(got: &[f32], expected: &[f32]) {
        assert_eq!(got.len(), expected.len());
        for (index, (got, expected)) in got.iter().zip(expected).enumerate() {
            if expected.is_nan() {
                assert!(got.is_nan(), "sample {index} must stay NaN, got {got}");
            } else {
                assert_eq!(got.to_bits(), expected.to_bits(), "sample {index}");
            }
        }
    }

    /// How an authored source TIFF chunks its samples.
    #[derive(Clone, Copy)]
    enum Chunking {
        Strips(u32),
        Tiles(u32, u32),
    }

    /// Author a little-endian Float32 GeoTIFF the way GDAL writes elevation
    /// tiles: EPSG:2154 keys, a -9999 NoData tag and the test grid, chunked
    /// as asked, with `compression` (1 none, 8 Deflate) and `predictor`
    /// (1 none, 3 floating point). Edge tiles are padded with NoData.
    #[expect(
        clippy::too_many_lines,
        reason = "ratcheted before 2.1-M188; split when this function next changes"
    )]
    fn write_source_tiff(
        path: &Path,
        width: u32,
        height: u32,
        chunking: Chunking,
        compression: u16,
        predictor: u16,
        samples: &[f32],
    ) {
        let codec = Compression::from_tag(compression);
        let encode = |chunk: &[f32], columns: usize| -> Vec<u8> {
            let mut bytes: Vec<u8> = chunk.iter().flat_map(|v| v.to_le_bytes()).collect();
            if predictor == 3 {
                // TIFF Technical Note 3: per row, byte planes most significant
                // first, then byte-wise horizontal differencing.
                for row in bytes.chunks_mut(columns * 4) {
                    let planes: Vec<u8> = (0..4)
                        .flat_map(|plane| row.chunks(4).map(move |sample| sample[3 - plane]))
                        .collect();
                    row.copy_from_slice(&planes);
                    for index in (1..row.len()).rev() {
                        row[index] = row[index].wrapping_sub(row[index - 1]);
                    }
                }
            }
            wbgeotiff::compression::compress(codec, &bytes).unwrap()
        };
        let (w, h) = (width as usize, height as usize);
        let mut chunks = Vec::new();
        match chunking {
            Chunking::Strips(rows_per_strip) => {
                for first in (0..h).step_by(rows_per_strip as usize) {
                    let last = (first + rows_per_strip as usize).min(h);
                    chunks.push(encode(&samples[first * w..last * w], w));
                }
            }
            Chunking::Tiles(tile_width, tile_height) => {
                let (tw, th) = (tile_width as usize, tile_height as usize);
                for y0 in (0..h).step_by(th) {
                    for x0 in (0..w).step_by(tw) {
                        let mut tile = vec![-9999.0f32; tw * th];
                        for row in 0..th.min(h - y0) {
                            for column in 0..tw.min(w - x0) {
                                tile[row * tw + column] = samples[(y0 + row) * w + x0 + column];
                            }
                        }
                        chunks.push(encode(&tile, tw));
                    }
                }
            }
        }
        let mut file = vec![0u8; 8];
        file[..4].copy_from_slice(b"II\x2a\x00");
        let mut offsets = Vec::new();
        let mut counts = Vec::new();
        for chunk in &chunks {
            offsets.push(file.len() as u32);
            counts.push(chunk.len() as u32);
            file.extend_from_slice(chunk);
        }
        if file.len() % 2 == 1 {
            file.push(0);
        }
        let (key_words, key_doubles, key_text) =
            crs::geokeys_for(&crs::from_reference("EPSG:2154").unwrap()).encode();
        let geotransform = grid(width, height).geotransform;
        let shorts = |values: &[u16]| {
            (
                3u16,
                values.len(),
                values
                    .iter()
                    .flat_map(|v| v.to_le_bytes())
                    .collect::<Vec<u8>>(),
            )
        };
        let longs = |values: &[u32]| {
            (
                4u16,
                values.len(),
                values
                    .iter()
                    .flat_map(|v| v.to_le_bytes())
                    .collect::<Vec<u8>>(),
            )
        };
        let doubles = |values: &[f64]| {
            (
                12u16,
                values.len(),
                values
                    .iter()
                    .flat_map(|v| v.to_le_bytes())
                    .collect::<Vec<u8>>(),
            )
        };
        let ascii = |text: &str| {
            let mut bytes = text.as_bytes().to_vec();
            bytes.push(0);
            (2u16, bytes.len(), bytes)
        };
        let mut fields = vec![
            (256u16, longs(&[width])),
            (257, longs(&[height])),
            (258, shorts(&[32])),
            (259, shorts(&[compression])),
            (262, shorts(&[1])),
            (277, shorts(&[1])),
            (284, shorts(&[1])),
            (317, shorts(&[predictor])),
            (339, shorts(&[3])),
            (33550, doubles(&[geotransform[1], -geotransform[5], 0.0])),
            (
                33922,
                doubles(&[0.0, 0.0, 0.0, geotransform[0], geotransform[3], 0.0]),
            ),
            (34735, shorts(&key_words)),
            (42113, ascii("-9999")),
        ];
        if !key_doubles.is_empty() {
            fields.push((34736, doubles(&key_doubles)));
        }
        if !key_text.is_empty() {
            fields.push((34737, ascii(&key_text)));
        }
        match chunking {
            Chunking::Strips(rows_per_strip) => {
                fields.push((273, longs(&offsets)));
                fields.push((278, longs(&[rows_per_strip])));
                fields.push((279, longs(&counts)));
            }
            Chunking::Tiles(tile_width, tile_height) => {
                fields.push((322, longs(&[tile_width])));
                fields.push((323, longs(&[tile_height])));
                fields.push((324, longs(&offsets)));
                fields.push((325, longs(&counts)));
            }
        }
        fields.sort_by_key(|(tag, _)| *tag);
        let directory = file.len();
        file[4..8].copy_from_slice(&(directory as u32).to_le_bytes());
        let mut extra_at = directory + 2 + fields.len() * 12 + 4;
        let mut entries = (fields.len() as u16).to_le_bytes().to_vec();
        let mut extra = Vec::new();
        for (tag, (kind, count, payload)) in &fields {
            entries.extend_from_slice(&tag.to_le_bytes());
            entries.extend_from_slice(&kind.to_le_bytes());
            entries.extend_from_slice(&(*count as u32).to_le_bytes());
            if payload.len() <= 4 {
                let mut inline = [0u8; 4];
                inline[..payload.len()].copy_from_slice(payload);
                entries.extend_from_slice(&inline);
            } else {
                entries.extend_from_slice(&(extra_at as u32).to_le_bytes());
                extra.extend_from_slice(payload);
                if payload.len() % 2 == 1 {
                    extra.push(0);
                }
                extra_at = directory + 2 + fields.len() * 12 + 4 + extra.len();
            }
        }
        entries.extend_from_slice(&0u32.to_le_bytes());
        file.extend_from_slice(&entries);
        file.extend_from_slice(&extra);
        std::fs::write(path, file).unwrap();
    }

    /// canopi-dfc0: a GeoTIFF above the whole-raster limit converts in row
    /// windows that never hold more than the limit, into exactly the bytes
    /// the whole raster gives, for both profiles and every chunk layout.
    #[test]
    fn geotiff_sources_stream_under_the_limit_into_the_whole_raster_bytes() {
        const LIMIT: u64 = 100_000;
        let dir = scratch("streamed");
        let engine = RustRasterEngine;
        let (width, height) = (701u32, 599u32);
        assert!(u64::from(width * height) > 4 * LIMIT);
        let authored = values(width, height);
        let grid = grid(width, height);
        let georef = RasterGeoref {
            grid: &grid,
            crs: "EPSG:2154",
        };
        let sources = [
            ("striped", Chunking::Strips(7), 8, 3),
            ("tiled", Chunking::Tiles(160, 144), 8, 3),
            ("one-strip", Chunking::Strips(height), 1, 1),
        ];
        for (label, chunking, compression, predictor) in sources {
            let source = dir.join(format!("{label}.tif"));
            write_source_tiff(
                &source,
                width,
                height,
                chunking,
                compression,
                predictor,
                &authored,
            );
            let read = engine.read_f32(&source, width, height, &cancel()).unwrap();
            assert_same_samples(&read, &authored);
            let convert = |input: RasterInput<'_>, output: &Path, nodata: Option<f32>| {
                engine.write_controlled_cog(input, output, Some(georef), nodata, &cancel())
            };
            let whole = dir.join(format!("{label}-whole.tif"));
            convert(
                RasterInput::Samples {
                    grid: &grid,
                    values: &authored,
                },
                &whole,
                Some(-9999.0),
            )
            .unwrap();
            let streamed = dir.join(format!("{label}-streamed.tif"));
            let peak = {
                let _limit = super::super::import::extraction_limit_probe::set(LIMIT);
                high_water::reset();
                convert(RasterInput::File(&source), &streamed, None)
                    .unwrap_or_else(|error| panic!("{label}: {error}"));
                high_water::peak()
            };
            assert!(peak > 0 && peak <= LIMIT, "{label} held {peak} cells");
            assert!(
                std::fs::read(&whole).unwrap() == std::fs::read(&streamed).unwrap(),
                "{label}: the streamed output differs from the whole one"
            );
        }
    }

    /// canopi-dfc0 (C9): a GeoTIFF whose compressed chunk decodes above the
    /// streamed chunk ceiling is loaded whole, so it keeps the capacity
    /// limit: at the limit it converts into the whole raster's bytes, one
    /// cell over it is refused by name, and the same file under the real
    /// ceiling streams past that lowered limit.
    #[test]
    fn a_tiff_chunk_above_the_streamed_ceiling_loads_whole_under_the_limit() {
        let dir = scratch("one-big-chunk");
        let engine = RustRasterEngine;
        let (width, height) = (701u32, 599u32);
        let cells = u64::from(width * height);
        let authored = values(width, height);
        let grid = grid(width, height);
        let georef = RasterGeoref {
            grid: &grid,
            crs: "EPSG:2154",
        };
        // One Deflate strip with the floating-point predictor: about 1.6 MiB
        // decoded, above a lowered ceiling of 1 MiB.
        let source = dir.join("one-deflate-strip.tif");
        write_source_tiff(
            &source,
            width,
            height,
            Chunking::Strips(height),
            8,
            3,
            &authored,
        );
        let whole = dir.join("whole.tif");
        engine
            .write_controlled_cog(
                RasterInput::Samples {
                    grid: &grid,
                    values: &authored,
                },
                &whole,
                Some(georef),
                Some(-9999.0),
                &cancel(),
            )
            .unwrap();
        let convert = |output: &Path| {
            engine.write_controlled_cog(
                RasterInput::File(&source),
                output,
                Some(georef),
                None,
                &cancel(),
            )
        };

        let _ceiling = tiff::chunk_ceiling_probe::set(1024 * 1024);
        let at_limit = dir.join("at-limit.tif");
        {
            let _limit = super::super::import::extraction_limit_probe::set(cells);
            convert(&at_limit).expect("a whole load at the limit converts");
        }
        assert!(
            std::fs::read(&whole).unwrap() == std::fs::read(&at_limit).unwrap(),
            "the whole load gives the whole raster's bytes"
        );

        let over = dir.join("over.tif");
        {
            let _limit = super::super::import::extraction_limit_probe::set(cells - 1);
            let error = convert(&over).expect_err("one cell over the limit is refused");
            assert!(
                error.contains(&format!("requires {cells} cells"))
                    && error.contains(&format!("limited to {}", cells - 1)),
                "the refusal names the limit: {error}"
            );
        }
        assert!(!over.exists());

        // The ceiling alone decides: under the real one the chunk streams.
        drop(_ceiling);
        let streamed = dir.join("streamed.tif");
        {
            let _limit = super::super::import::extraction_limit_probe::set(cells - 1);
            convert(&streamed).expect("under the real ceiling the strip streams");
        }
        assert!(std::fs::read(&whole).unwrap() == std::fs::read(&streamed).unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_written_geotiff_probes_and_reads_back_exactly() {
        let dir = scratch("geotiff");
        let engine = RustRasterEngine;
        let (width, height) = (300u32, 260u32);
        let authored = values(width, height);
        let grid = grid(width, height);
        let path = dir.join("fixture.tif");
        engine
            .write_geotiff(
                &path,
                RasterGeoref {
                    grid: &grid,
                    crs: "EPSG:2154",
                },
                -9999.0,
                &authored,
                &cancel(),
            )
            .unwrap();

        let probe = engine.probe(&path, &cancel()).unwrap();
        assert_eq!(probe.driver, "GTiff");
        assert_eq!((probe.width, probe.height), (width, height));
        assert_eq!(probe.band_count, 1);
        assert_eq!(probe.band_type, "Float32");
        assert_eq!(probe.nodata, Some(-9999.0));
        assert_eq!(probe.geotransform, grid.geotransform);
        assert_eq!(probe.block, [256, 256]);
        assert_eq!(probe.compression, "DEFLATE");
        assert_eq!(probe.overview_count, 0);
        assert!(probe.mask_flags.is_empty());
        assert_eq!(probe.crs_ref, "EPSG:2154");
        assert_eq!(
            super::super::analyses::crs_class(&probe.crs_ref),
            super::super::analyses::CRS_PROJECTED_METRE
        );

        let read = engine.read_f32(&path, width, height, &cancel()).unwrap();
        assert_same_samples(&read, &authored);
        assert!(
            engine
                .read_f32(&path, width, height + 1, &cancel())
                .is_err()
        );

        let stats = engine.statistics(&path, &cancel()).unwrap();
        let valid: Vec<f64> = authored
            .iter()
            .filter(|v| v.is_finite() && **v != -9999.0)
            .map(|v| f64::from(*v))
            .collect();
        let mean = valid.iter().sum::<f64>() / valid.len() as f64;
        assert!((stats.mean - mean).abs() < 1e-9);
        assert_eq!(
            stats.minimum,
            valid.iter().cloned().fold(f64::INFINITY, f64::min)
        );
        assert!(
            (stats.valid_percent - valid.len() as f64 * 100.0 / authored.len() as f64).abs() < 1e-9
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_controlled_profile_is_what_the_bounded_reader_accepts() {
        let dir = scratch("controlled");
        let engine = RustRasterEngine;
        let (width, height) = (300u32, 260u32);
        let authored = values(width, height);
        let grid = grid(width, height);
        let from_samples = dir.join("samples.tif");
        engine
            .write_controlled_cog(
                RasterInput::Samples {
                    grid: &grid,
                    values: &authored,
                },
                &from_samples,
                Some(RasterGeoref {
                    grid: &grid,
                    crs: "EPSG:2154",
                }),
                Some(-9999.0),
                &cancel(),
            )
            .unwrap();
        let probe = engine.probe(&from_samples, &cancel()).unwrap();
        assert_eq!(probe.compression, "NONE");
        assert_eq!(probe.overview_count, 0);
        let mut reader = PreparedRaster::open_committed(&from_samples, &grid, Some(-9999.0))
            .expect("the controlled profile opens through the production reader");
        let window = reader
            .read_window(
                RasterWindow {
                    x: 0,
                    y: 0,
                    width,
                    height,
                },
                &cancel(),
            )
            .unwrap();
        assert_same_samples(window.samples(), &authored);
        let expected_valid: Vec<u8> = authored
            .iter()
            .map(|v| u8::from(v.is_finite() && *v != -9999.0))
            .collect();
        assert_eq!(window.valid(), expected_valid.as_slice());
        drop(reader);

        // From a file: a relocated georef and a NoData override, keeping samples.
        let moved = RasterGrid {
            geotransform: [0.0, 1.0, 0.0, f64::from(height), 0.0, -1.0],
            ..grid.clone()
        };
        let from_file = dir.join("file.tif");
        engine
            .write_controlled_cog(
                RasterInput::File(&from_samples),
                &from_file,
                Some(RasterGeoref {
                    grid: &moved,
                    crs: "EPSG:3857",
                }),
                None,
                &cancel(),
            )
            .unwrap();
        let probe = engine.probe(&from_file, &cancel()).unwrap();
        assert_eq!(probe.geotransform, moved.geotransform);
        assert_eq!(probe.nodata, Some(-9999.0), "the input's tag is kept");
        assert_eq!(probe.crs_ref, "EPSG:3857");
        let mut reader = PreparedRaster::open_committed(&from_file, &moved, Some(-9999.0)).unwrap();
        let window = reader
            .read_window(
                RasterWindow {
                    x: 0,
                    y: 0,
                    width,
                    height,
                },
                &cancel(),
            )
            .unwrap();
        assert_same_samples(window.samples(), &authored);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// On a source already on the Web Mercator lattice the warp is the
    /// identity, so the profile's own layout shows.
    #[test]
    fn the_display_profile_carries_averaged_valid_overviews_and_the_tag() {
        let dir = scratch("display");
        let engine = RustRasterEngine;
        let (width, height) = (600u32, 400u32);
        let zoom_18 = 2.0 * 20_037_508.342_789_244 / 256.0 / 262_144.0;
        let grid = RasterGrid {
            width,
            height,
            geotransform: [
                -20_037_508.342_789_244 + 34_000_000.0 * zoom_18,
                zoom_18,
                0.0,
                20_037_508.342_789_244 - 22_000_000.0 * zoom_18,
                0.0,
                -zoom_18,
            ],
        };
        // An x-ramp with a NoData hole, so overviews must average around it.
        let mut authored = Vec::with_capacity((width * height) as usize);
        for row in 0..height {
            for column in 0..width {
                let hole = (100..140).contains(&row) && (100..160).contains(&column);
                authored.push(if hole { -9999.0 } else { column as f32 * 0.5 });
            }
        }
        let path = dir.join("display.tif");
        engine
            .write_display_cog(
                RasterInput::Samples {
                    grid: &grid,
                    values: &authored,
                },
                &path,
                Some(RasterGeoref {
                    grid: &grid,
                    crs: "EPSG:3857",
                }),
                Some(-9999.0),
                super::display_zoom("EPSG:3857", [&grid]).unwrap(),
                &cancel(),
            )
            .unwrap();
        let probe = engine.probe(&path, &cancel()).unwrap();
        assert_eq!(
            (probe.geotransform, probe.crs_ref.as_str()),
            (grid.geotransform, "EPSG:3857")
        );
        assert_eq!(probe.compression, "DEFLATE");
        assert_eq!(
            probe.overview_count, 2,
            "600x400 halves to 300x200 and 150x100"
        );
        assert_eq!(probe.nodata, Some(-9999.0));
        assert_eq!(probe.block, [256, 256]);

        let bytes = std::fs::read(&path).unwrap();
        let layout = wbgeotiff::GeoTiff::parse_cog_layout(&bytes[..(64 << 10).min(bytes.len())])
            .expect("the directories sit in the file's first 64 KiB");
        assert_eq!(layout.levels.len(), 3);
        assert_eq!(
            (layout.levels[1].width, layout.levels[1].height),
            (300, 200)
        );
        assert_eq!(layout.no_data, Some(-9999.0));
        // The first overview averages valid cells only: beside the hole the
        // value is the ramp's mean, inside it the sentinel.
        let level = &layout.levels[1];
        let tile = |x: u32, y: u32| {
            let (offset, count) = level.tile_range(x / 256, y / 256).unwrap();
            let samples = level
                .decode_tile_f64(&bytes[offset as usize..(offset + count) as usize])
                .unwrap();
            samples[((y % 256) * 256 + x % 256) as usize] as f32
        };
        assert_eq!(
            tile(60, 20),
            60.25,
            "the mean of columns 120 and 121 at half scale"
        );
        assert_eq!(
            tile(60, 60),
            -9999.0,
            "a block inside the hole stays NoData"
        );
        assert_eq!(
            tile(49, 50),
            49.25,
            "beside the hole's edge the valid half counts"
        );
        let full = engine.read_f32(&path, width, height, &cancel()).unwrap();
        assert_same_samples(&full, &authored);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn transforms_match_the_registry_and_place_nothing_they_cannot() {
        let engine = RustRasterEngine;
        let placed = engine
            .transform_points(
                "EPSG:2154",
                "EPSG:4326",
                &[(700_000.0, 6_600_000.0), (f64::NAN, 1.0)],
                &cancel(),
            )
            .unwrap();
        let (lon, lat) = placed[0].unwrap();
        assert!((lon - 3.0).abs() < 1e-9 && (lat - 46.5).abs() < 1e-9);
        assert_eq!(placed[1], None);
        let back = engine
            .transform_points("EPSG:4326", "EPSG:2154", &[(3.0, 46.5)], &cancel())
            .unwrap()[0]
            .unwrap();
        assert!((back.0 - 700_000.0).abs() < 1e-3 && (back.1 - 6_600_000.0).abs() < 1e-3);
        assert!(
            engine
                .transform_points("EPSG:999999", "EPSG:4326", &[(0.0, 0.0)], &cancel())
                .is_err()
        );
        assert_eq!(
            engine
                .transform_points("EPSG:3857", "EPSG:4326", &[], &cancel())
                .unwrap(),
            Vec::<Option<(f64, f64)>>::new()
        );
    }

    #[test]
    fn the_extent_of_a_lambert_tile_lands_where_the_ign_places_it() {
        let dir = scratch("extent");
        let engine = RustRasterEngine;
        let grid = grid(2000, 2000);
        let path = dir.join("tile.tif");
        engine
            .write_geotiff(
                &path,
                RasterGeoref {
                    grid: &grid,
                    crs: "EPSG:2154",
                },
                -9999.0,
                &vec![1.0; 4_000_000],
                &cancel(),
            )
            .unwrap();
        let [west, south, east, north] = engine.wgs84_extent(&path, &cancel()).unwrap();
        // gdalinfo's wgs84Extent for LHD_FXX_0445_6806.
        assert!((west - -0.4400076).abs() < 1e-6, "{west}");
        assert!((south - 48.2953405).abs() < 1e-6, "{south}");
        assert!((east - -0.4259494).abs() < 1e-6, "{east}");
        assert!((north - 48.3047203).abs() < 1e-6, "{north}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A 4x4 Float32 GeoTIFF at `origin` (top-left, 0.5 m cells) whose CRS
    /// is `keys`, written by wbgeotiff as other tools write them.
    fn tiff_with_keys(path: &Path, origin: (f64, f64), keys: wbgeotiff::geo_keys::GeoKeyDirectory) {
        wbgeotiff::GeoTiffWriter::new(4, 4, 1)
            .geo_transform(wbgeotiff::GeoTransform::north_up(
                origin.0, 0.5, origin.1, -0.5,
            ))
            .geo_key_directory(keys)
            .write_f32(path, &[1.0; 16])
            .unwrap();
    }

    fn keys(
        shorts: &[(u16, u16)],
        doubles: &[(u16, f64)],
        citation: Option<&str>,
    ) -> wbgeotiff::geo_keys::GeoKeyDirectory {
        let mut builder = wbgeotiff::geo_keys::GeoKeyBuilder::new();
        for (id, value) in shorts {
            builder = builder.short(*id, *value);
        }
        for (id, value) in doubles {
            builder = builder.double(*id, *value);
        }
        if let Some(text) = citation {
            builder = builder.ascii(1026, format!("{text}|"));
        }
        builder.build()
    }

    fn close(got: (f64, f64), expected: (f64, f64), tolerance: f64, label: &str) {
        let deviation = (got.0 - expected.0).abs().max((got.1 - expected.1).abs());
        assert!(
            deviation <= tolerance,
            "{label}: {got:?} is {deviation:e} from {expected:?}"
        );
    }

    /// A1: every transform runs source → WGS84 lon/lat → target, so the
    /// datum shift is kept on the way to Web Mercator, which has no datum.
    /// References: cs2cs (PROJ 9.4.0, no grids).
    #[test]
    fn every_transform_runs_through_wgs84_longitude_and_latitude() {
        let engine = RustRasterEngine;
        let one = |from: &str, to: &str, point: (f64, f64)| {
            engine
                .transform_points(from, to, &[point], &cancel())
                .unwrap()[0]
                .unwrap_or_else(|| panic!("{from} to {to} placed nothing"))
        };
        close(
            one("EPSG:28992", "EPSG:3857", (85_000.0, 447_000.0)),
            (486_208.294_8, 6_801_382.038_1),
            0.05,
            "RD New to Web Mercator",
        );
        for (code, mercator, expected) in [
            (
                "EPSG:2056",
                (890_555.926_346, 5_942_074.072_431),
                (2_642_695.420_2, 1_205_590.522_3),
            ),
            (
                "EPSG:27700",
                (-166_979.236_190, 6_982_997.920_390),
                (433_653.297_0, 344_858.882_7),
            ),
            (
                "EPSG:31370",
                (489_805.759_490, 6_585_991.998_100),
                (152_202.884_1, 165_505.135_5),
            ),
        ] {
            close(one("EPSG:3857", code, mercator), expected, 0.05, code);
            close(one(code, "EPSG:3857", expected), mercator, 0.05, code);
        }
    }

    /// The test tiles' keys as the producers wrote them: the AHN tile names
    /// 28992 with GDAL's citation; the IGN tile spells Lambert-93 out key by
    /// key, every code user-defined, and is placed as 2154 by matching a row.
    #[test]
    fn delft_and_paris_tiles_probe_to_their_codes_and_land_where_proj_places_them() {
        let dir = scratch("tiles");
        let engine = RustRasterEngine;
        let delft = dir.join("ahn_dsm_delft.tif");
        tiff_with_keys(
            &delft,
            (84_400.0, 447_500.0),
            keys(
                &[
                    (1024, 1),
                    (1025, 1),
                    (2054, 9102),
                    (3072, 28992),
                    (3076, 9001),
                ],
                &[],
                Some("Amersfoort / RD New"),
            ),
        );
        let paris = dir.join("ign_mns_paris.tif");
        tiff_with_keys(
            &paris,
            (652_000.0, 6_862_400.0),
            keys(
                &[
                    (1024, 1),
                    (1025, 1),
                    (2048, 32767),
                    (2050, 32767),
                    (2051, 32767),
                    (2052, 9001),
                    (2054, 9102),
                    (2056, 32767),
                    (3072, 32767),
                    (3074, 32767),
                    (3075, 8),
                    (3076, 9001),
                ],
                &[
                    (3078, 49.0),
                    (3079, 44.0),
                    (3084, 3.0),
                    (3085, 46.5),
                    (3086, 700_000.0),
                    (3087, 6_600_000.0),
                ],
                Some("EPSG:2154"),
            ),
        );
        // cs2cs EPSG:28992 / EPSG:2154 to EPSG:4326 of each tile's origin.
        for (path, code, origin, expected) in [
            (
                &delft,
                "EPSG:28992",
                (84_400.0, 447_500.0),
                (4.358_842_937, 52.011_366_569),
            ),
            (
                &paris,
                "EPSG:2154",
                (652_000.0, 6_862_400.0),
                (2.345_766_791, 48.859_845_296),
            ),
        ] {
            let probe = engine.probe(path, &cancel()).unwrap();
            assert_eq!(probe.crs_ref, code);
            let placed = engine
                .transform_points(&probe.crs_ref, "EPSG:4326", &[origin], &cancel())
                .unwrap()[0]
                .unwrap();
            // 1e-7 deg is about a centimetre.
            close(placed, expected, 1e-7, code);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A7: keys spelled to EPSG's precision match the row within the matcher
    /// tolerances (1e-9 deg, 1e-3 m), and the file's ellipsoid must agree.
    #[test]
    fn epsg_precise_belgian_lambert_keys_match_31370_and_another_ellipsoid_is_refused() {
        let dir = scratch("lambert72");
        let engine = RustRasterEngine;
        let lambert72 = |ellipsoid: u16| {
            keys(
                &[
                    (1024, 1),
                    (2048, 32767),
                    (2056, ellipsoid),
                    (3072, 32767),
                    (3075, 8),
                    (3076, 9001),
                ],
                &[
                    (3078, 51.166_667_233_333_33),
                    (3079, 49.833_333_9),
                    (3084, 4.367_486_666_666_666),
                    (3085, 90.0),
                    (3086, 150_000.012_56),
                    (3087, 5_400_088.437_8),
                ],
                None,
            )
        };
        let path = dir.join("lambert72.tif");
        tiff_with_keys(&path, (150_000.0, 170_000.0), lambert72(7022));
        assert_eq!(
            engine.probe(&path, &cancel()).unwrap().crs_ref,
            "EPSG:31370"
        );
        // The same projection on GRS80 is not Belgian Lambert 72.
        let grs80 = dir.join("lambert72-grs80.tif");
        tiff_with_keys(&grs80, (150_000.0, 170_000.0), lambert72(7019));
        let error = engine.probe(&grs80, &cancel()).unwrap_err().to_string();
        assert!(error.contains("user-defined"), "{error}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// GDAL's keys when only the geographic CRS has a code: the projection
    /// spelled out, GeographicType naming the datum's code and no ellipsoid
    /// keys. RD New on Amersfoort (4289) matches 28992; on BD72 (4313, the
    /// International ellipsoid) it matches nothing.
    #[test]
    fn spelled_out_keys_on_a_coded_geographic_system_match_by_its_ellipsoid() {
        let dir = scratch("coded-gcs");
        let engine = RustRasterEngine;
        let rd_new = |geographic: u16| {
            keys(
                &[
                    (1024, 1),
                    (2048, geographic),
                    (3072, 32767),
                    (3075, 16),
                    (3076, 9001),
                ],
                &[
                    (3080, 5.387_638_888_888_89),
                    (3081, 52.156_160_555_555_55),
                    (3082, 155_000.0),
                    (3083, 463_000.0),
                    (3092, 0.999_907_9),
                ],
                None,
            )
        };
        let amersfoort = dir.join("rd-new-4289.tif");
        tiff_with_keys(&amersfoort, (84_400.0, 447_500.0), rd_new(4289));
        assert_eq!(
            engine.probe(&amersfoort, &cancel()).unwrap().crs_ref,
            "EPSG:28992"
        );
        let bd72 = dir.join("rd-new-4313.tif");
        tiff_with_keys(&bd72, (84_400.0, 447_500.0), rd_new(4313));
        let error = engine.probe(&bd72, &cancel()).unwrap_err().to_string();
        assert!(error.contains("user-defined"), "{error}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The overseas UTM rows sit on their own GRS80 systems, which GDAL names
    /// in GeographicType when it spells the projection out: RGFG95, RGR92,
    /// RGM04, RRAF 1991 and RGAF09. RRAF 1991 / UTM 20N (4559) has RGAF09 /
    /// UTM 20N's definition, so either code places it the same.
    #[test]
    fn spelled_out_utm_keys_on_an_overseas_system_match_its_row() {
        let dir = scratch("overseas-gcs");
        let engine = RustRasterEngine;
        let cases: [(u16, f64, f64, &[&str]); 5] = [
            (4624, -51.0, 0.0, &["EPSG:2972"]),
            (4627, 57.0, 10_000_000.0, &["EPSG:2975"]),
            (4470, 45.0, 10_000_000.0, &["EPSG:4471"]),
            (4558, -63.0, 0.0, &["EPSG:4559", "EPSG:5490"]),
            (5489, -63.0, 0.0, &["EPSG:5490"]),
        ];
        for (geographic, lon_0, y_0, expected) in cases {
            let utm = keys(
                &[
                    (1024, 1),
                    (2048, geographic),
                    (3072, 32767),
                    (3075, 1),
                    (3076, 9001),
                ],
                &[
                    (3080, lon_0),
                    (3081, 0.0),
                    (3082, 500_000.0),
                    (3083, y_0),
                    (3092, 0.9996),
                ],
                None,
            );
            let path = dir.join(format!("utm-{geographic}.tif"));
            tiff_with_keys(&path, (400_000.0, 1_000_000.0), utm);
            let probe = engine.probe(&path, &cancel());
            assert!(
                probe
                    .as_ref()
                    .is_ok_and(|probe| expected.contains(&probe.crs_ref.as_str())),
                "GeographicType {geographic}: {:?}",
                probe.map(|probe| probe.crs_ref)
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A projected model with only a geographic code, here ETRS89 and the
    /// GeoTIFF 1.0 ProjectionGeoKey for UTM 32N, names no projection
    /// Canopi reads, so it is refused rather than read as degrees.
    #[test]
    fn a_projected_model_with_only_a_geographic_row_is_refused() {
        let dir = scratch("projected-geographic");
        let engine = RustRasterEngine;
        let path = dir.join("utm.tif");
        tiff_with_keys(
            &path,
            (500_000.0, 5_800_000.0),
            keys(&[(1024, 1), (2048, 4258), (3074, 16032)], &[], None),
        );
        let error = engine.probe(&path, &cancel()).unwrap_err().to_string();
        assert!(
            error.starts_with("The raster's user-defined system is not a supported"),
            "{error}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Compound codes read as their horizontal part.
    #[test]
    fn compound_codes_read_as_their_horizontal_row() {
        let dir = scratch("aliases");
        let engine = RustRasterEngine;
        for (code, expected) in [
            (7415u16, "EPSG:28992"),
            (5698, "EPSG:2154"),
            (5699, "EPSG:2154"),
        ] {
            let path = dir.join(format!("{code}.tif"));
            tiff_with_keys(
                &path,
                (0.0, 0.0),
                keys(&[(1024, 1), (3072, code)], &[], None),
            );
            assert_eq!(
                engine.probe(&path, &cancel()).unwrap().crs_ref,
                expected,
                "{code}"
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// U31: a code outside the table is refused by name, with the systems
    /// Canopi supports: feet (2263), south-west Krovak (2065), and a code
    /// the table does not list (SWEREF99 TM, 3006).
    #[test]
    fn codes_outside_the_table_are_refused_naming_the_code_and_the_supported_systems() {
        let dir = scratch("refused");
        let engine = RustRasterEngine;
        for code in [2263u16, 2065, 3006] {
            let path = dir.join(format!("{code}.tif"));
            tiff_with_keys(
                &path,
                (0.0, 0.0),
                keys(&[(1024, 1), (3072, code)], &[], None),
            );
            let error = engine.probe(&path, &cancel()).unwrap_err().to_string();
            assert!(
                error.contains(&format!("EPSG:{code} is not a supported coordinate system"))
                    && error.contains("Lambert-93 (EPSG:2154)"),
                "{error}"
            );
            let error = engine
                .transform_points(
                    &format!("EPSG:{code}"),
                    "EPSG:4326",
                    &[(0.0, 0.0)],
                    &cancel(),
                )
                .unwrap_err();
            assert!(error.contains(&format!("EPSG:{code}")), "{error}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A8: a format other than GeoTIFF is refused from its signature, even
    /// with a CRS sidecar, before any reader parses it.
    #[test]
    fn a_non_tiff_source_is_refused_even_with_a_prj_sidecar() {
        let dir = scratch("non-tiff");
        let engine = RustRasterEngine;
        let path = dir.join("grid.asc");
        std::fs::write(
            &path,
            "ncols 3\nnrows 2\nxllcorner 100\nyllcorner 200\ncellsize 10\nNODATA_value -1\n1 2 -1\n4.5 5 6\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("grid.prj"),
            r#"PROJCS["RGF93 v1 / Lambert-93",AUTHORITY["EPSG","2154"]]"#,
        )
        .unwrap();
        for error in [
            engine.probe(&path, &cancel()).unwrap_err().to_string(),
            engine.read_f32(&path, 3, 2, &cancel()).unwrap_err(),
        ] {
            assert!(error.contains("is not a GeoTIFF"), "{error}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A7: wbgeotiff, which the GeoLibre CLI writes its outputs with, keys any
    /// 4xxx code as geographic; RGM04 / UTM 38S (4471) is still read by its
    /// row, projected in metres.
    #[test]
    fn a_4471_output_keyed_as_geographic_is_read_by_its_projected_row() {
        let dir = scratch("4471");
        let engine = RustRasterEngine;
        let path = dir.join("mayotte.tif");
        wbgeotiff::GeoTiffWriter::new(4, 4, 1)
            .geo_transform(wbgeotiff::GeoTransform::north_up(
                516_000.0,
                0.5,
                8_585_000.0,
                -0.5,
            ))
            .epsg(4471)
            .write_f32(&path, &[1.0; 16])
            .unwrap();
        let probe = engine.probe(&path, &cancel()).unwrap();
        assert_eq!(probe.crs_ref, "EPSG:4471");
        assert_eq!(
            super::super::analyses::crs_class(&probe.crs_ref),
            super::super::analyses::CRS_PROJECTED_METRE
        );
        // cs2cs EPSG:4326 to EPSG:4471.
        let placed = engine
            .transform_points("EPSG:4326", &probe.crs_ref, &[(45.15, -12.8)], &cancel())
            .unwrap()[0]
            .unwrap();
        close(placed, (516_279.147_9, 8_584_976.634_4), 0.01, "4471");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn whole_raster_work_honours_the_capacity_limit_by_name() {
        let dir = scratch("capacity");
        let engine = RustRasterEngine;
        let oversized = RasterGrid {
            width: 5_001,
            height: 5_000,
            geotransform: [0.0, 1.0, 0.0, 5_000.0, 0.0, -1.0],
        };
        let error = engine
            .write_controlled_cog(
                RasterInput::Samples {
                    grid: &oversized,
                    values: &[],
                },
                &dir.join("never.tif"),
                Some(RasterGeoref {
                    grid: &oversized,
                    crs: "EPSG:3857",
                }),
                None,
                &cancel(),
            )
            .unwrap_err();
        assert!(error.contains("whole-raster read is limited"), "{error}");
        assert!(!dir.join("never.tif").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_set_flag_cancels_before_any_output_exists() {
        let dir = scratch("cancel");
        let engine = RustRasterEngine;
        let grid = grid(64, 64);
        let flag = cancel();
        flag.store(true, Ordering::Relaxed);
        let error = engine
            .write_display_cog(
                RasterInput::Samples {
                    grid: &grid,
                    values: &vec![1.0; 64 * 64],
                },
                &dir.join("cancelled.tif"),
                Some(RasterGeoref {
                    grid: &grid,
                    crs: "EPSG:3857",
                }),
                None,
                18,
                &flag,
            )
            .unwrap_err();
        assert_eq!(error, "cancelled");
        assert!(!dir.join("cancelled.tif").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stripped_integer_sources_convert_like_a_float32_cast() {
        let dir = scratch("stripped");
        let engine = RustRasterEngine;
        let (width, height) = (70u32, 45u32);
        let authored: Vec<i16> = (0..width * height)
            .map(|index| (index as i32 % 5000 - 2500) as i16)
            .collect();
        let path = dir.join("int16.tif");
        wbgeotiff::GeoTiffWriter::new(width, height, 1)
            .layout(wbgeotiff::WriteLayout::Stripped { rows_per_strip: 7 })
            .compression(wbgeotiff::Compression::Lzw)
            .geo_transform(wbgeotiff::GeoTransform::north_up(10.0, 1.0, 55.0, -1.0))
            .epsg(3857)
            .no_data(-2500.0)
            .write_i16(&path, &authored)
            .unwrap();
        let probe = engine.probe(&path, &cancel()).unwrap();
        assert_eq!(probe.band_type, "Int16");
        assert_eq!(probe.compression, "LZW");
        assert_eq!(probe.block, [width, 7]);
        assert_eq!(probe.nodata, Some(-2500.0));
        assert_eq!(probe.geotransform, [10.0, 1.0, 0.0, 55.0, 0.0, -1.0]);
        let read = engine.read_f32(&path, width, height, &cancel()).unwrap();
        let expected: Vec<f32> = authored.iter().map(|v| f32::from(*v)).collect();
        assert_eq!(read, expected);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The recorded crate versions are the ones the lockfile pins, so a bump
    /// cannot ship under a stale engine version.
    #[test]
    fn the_engine_version_names_the_locked_crates() {
        let lock = include_str!("../../../../../Cargo.lock");
        let pinned = |name: &str| -> Vec<(String, String)> {
            let mut found = Vec::new();
            let mut blocks = lock.split("[[package]]");
            blocks.next();
            for block in blocks {
                let field = |key: &str| {
                    block
                        .lines()
                        .find_map(|line| line.strip_prefix(&format!("{key} = \"")))
                        .map(|rest| rest.trim_end_matches('"').to_string())
                };
                if field("name").as_deref() == Some(name) {
                    found.push((
                        field("version").unwrap_or_default(),
                        field("source").unwrap_or_default(),
                    ));
                }
            }
            found
        };
        let geotiff = pinned("wbgeotiff");
        assert_eq!(
            geotiff.len(),
            1,
            "one wbgeotiff serves every dependant: {geotiff:?}"
        );
        assert_eq!(geotiff[0].0, WBGEOTIFF_VERSION);
        assert!(
            geotiff[0].1.ends_with(&format!("#{WBGEOTIFF_REVISION}")),
            "{}",
            geotiff[0].1
        );
        assert_eq!(pinned("proj4rs")[0].0, PROJ4RS_VERSION);
        assert!(engine_version().contains("wbgeotiff 0.1.2@9c0ff4f"));
    }
}
