//! Bounded native reads of one controlled raster derivative.
//!
//! Import staging and slope result statistics need exact Float32 samples and
//! validity in row order, but holding the whole raster is what the dense
//! engine's capacity limit exists for. This module prepares one disposable
//! derivative through the raster engine — uncompressed, single-band
//! Float32 COG, 256×256 blocks, no overviews — and then streams it back
//! through the native tiled reader GeoLibre selected (`wbgeotiff`), one
//! bounded window at a time.
//!
//! Ownership: a `PreparedRaster` owns exactly one temporary derivative inside
//! the caller's scratch directory. Dropping it closes the file handle and
//! removes that derivative and its sidecars; it never touches originals,
//! originals' sidecars or accepted generations. The controlled format is
//! deliberately uncompressed so no unbounded decompressor ever runs on
//! arbitrary input, and the reader rejects any derivative that does not match
//! that format instead of guessing.

#[cfg(test)]
use super::engine::{RasterEngine, RasterInput};
use super::grid::RasterGrid;
use super::paths;
use std::fs::File;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use wbgeotiff::{CogLevel, Compression, GeoTiff, SampleFormat};

/// Largest side of one requested window, and the row band used by a scan.
const MAX_WINDOW_SIDE: u32 = 1024;
/// Widest halo any qualified analysis recipe reads: Horn's 3×3 needs one
/// cell, GeoLibre's projected 5×5 two.
pub(super) const MAX_RECIPE_HALO: u32 = 2;
/// Largest side of an explicitly requested window: a scan window plus the
/// widest recipe halo on each edge. One such window stays far inside
/// `MAX_LIVE_BYTES`.
pub(super) const MAX_HALO_SIDE: u32 = MAX_WINDOW_SIDE + 2 * MAX_RECIPE_HALO;
/// Controlled derivative geometry.
const TILE_SIDE: u32 = 256;
const TILE_SAMPLES: usize = (TILE_SIDE as usize) * (TILE_SIDE as usize);
const TILE_BYTES: u64 = (TILE_SAMPLES as u64) * 4;
/// Metadata prefix growth: first attempt, doubling ceiling.
const METADATA_PREFIX_START: u64 = 64 * 1024;
const METADATA_PREFIX_CEILING: u64 = 4 * 1024 * 1024;
/// Free space kept beyond the derivative and any new numeric output.
pub(super) const FREE_SPACE_FLOOR_BYTES: u64 = 256 * 1024 * 1024;
/// Cap on buffers this adapter holds at once: one window (samples + validity),
/// one encoded tile and its decoded samples.
const MAX_LIVE_BYTES: u64 = 64 * 1024 * 1024;

/// One half-open, raster-aligned integer window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RasterWindow {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl RasterWindow {
    /// Exclusive right/bottom bounds, after rejecting every request this
    /// adapter must not attempt to allocate or read.
    fn bounds(&self, grid: &RasterGrid, cap: u32) -> Result<(u32, u32), String> {
        if self.width == 0 || self.height == 0 {
            return Err("raster window must not be empty".to_string());
        }
        if self.width > cap || self.height > cap {
            return Err(format!(
                "raster window {}x{} exceeds the {cap}x{cap} window cap",
                self.width, self.height
            ));
        }
        let x_end = self
            .x
            .checked_add(self.width)
            .ok_or_else(|| "raster window x range overflows".to_string())?;
        let y_end = self
            .y
            .checked_add(self.height)
            .ok_or_else(|| "raster window y range overflows".to_string())?;
        if x_end > grid.width || y_end > grid.height {
            return Err(format!(
                "raster window {}x{}+{}+{} is outside the {}x{} raster",
                self.width, self.height, self.x, self.y, grid.width, grid.height
            ));
        }
        Ok((x_end, y_end))
    }

    fn cells(&self) -> Result<usize, String> {
        let cells = u64::from(self.width)
            .checked_mul(u64::from(self.height))
            .ok_or_else(|| "raster window cell count overflows".to_string())?;
        usize::try_from(cells)
            .map_err(|_| "raster window is too large for this platform".to_string())
    }
}

/// Samples and validity for one window, row-major and exactly window-sized.
///
/// The owning window read and committed-asset open below are consumed by the
/// B2 generation resolver (`canopi-jv8a.4`); until it lands they carry a
/// documented dead-code allowance rather than disappearing from the reader.
#[derive(Debug)]
pub(super) struct WindowSamples {
    samples: Vec<f32>,
    valid: Vec<u8>,
}

impl WindowSamples {
    pub(super) fn samples(&self) -> &[f32] {
        &self.samples
    }

    pub(super) fn valid(&self) -> &[u8] {
        &self.valid
    }
}

/// One opened, validated derivative. See the module docs for ownership.
#[derive(Debug)]
pub(super) struct PreparedRaster {
    file: Option<File>,
    path: PathBuf,
    owns_derivative: bool,
    /// True while this reader's consumer may write numeric output that shares
    /// the volume; committed reads are read-only and carry no reserve.
    capacity_guard: bool,
    scratch_dir: PathBuf,
    level: CogLevel,
    grid: RasterGrid,
    nodata: Option<f32>,
    tile_bytes: Vec<u8>,
}

impl PreparedRaster {
    /// Prepare one controlled derivative of `input` and open it for reads.
    ///
    /// `input` is an admitted managed original or an immutable result; the
    /// derivative is written into `job_scratch`, which the owning job removes.
    /// `nodata` is the effective validity rule already established by the
    /// probe for this interpretation; validity stays finite-and-not-NoData
    /// exactly as the previous full-buffer conversion defined it.
    /// `additional_output_bytes` is the numeric output the caller will write
    /// while this derivative is alive; it is charged together with the
    /// derivative, its metadata allowance and the shared reserve, because all
    /// of them coexist. Output that already exists on disk is already
    /// reflected in the measured free space and must not be charged again.
    #[cfg(test)]
    pub(super) fn open(
        engine: &dyn RasterEngine,
        input: &Path,
        grid: &RasterGrid,
        nodata: Option<f32>,
        additional_output_bytes: u64,
        job_scratch: &Path,
        cancel: &AtomicBool,
    ) -> Result<Self, String> {
        check_cancel(cancel)?;
        if grid.width == 0 || grid.height == 0 {
            return Err("cannot prepare a raster with an empty grid".to_string());
        }
        let required = required_free_bytes(grid.width, grid.height, additional_output_bytes)?;
        paths::require_free_space(job_scratch, required, "the prepared raster working set")?;

        let path = derivative_path(job_scratch, input);
        let prepared =
            engine.write_controlled_cog(RasterInput::File(input), &path, None, None, cancel);
        if let Err(error) = prepared {
            remove_derivative(&path);
            return Err(error);
        }
        let raster =
            match Self::open_derivative(path.clone(), grid, nodata, job_scratch, true, true) {
                Ok(raster) => raster,
                Err(error) => {
                    remove_derivative(&path);
                    return Err(error);
                }
            };
        check_cancel(cancel)?;
        Ok(raster)
    }

    /// Open one committed asset for bounded reads.
    ///
    /// The file must already be a validated controlled COG; nothing is
    /// prepared, nothing is charged against free space, and dropping the
    /// reader closes the handle without deleting the committed bytes.
    pub(super) fn open_committed(
        path: &Path,
        grid: &RasterGrid,
        nodata: Option<f32>,
    ) -> Result<Self, String> {
        let scratch = path.parent().unwrap_or_else(|| Path::new("."));
        Self::open_derivative(path.to_path_buf(), grid, nodata, scratch, false, false)
    }

    /// Grid this reader was validated against.
    #[cfg(test)]
    pub(super) fn grid(&self) -> &RasterGrid {
        &self.grid
    }

    /// Open and validate one derivative that already exists.
    fn open_derivative(
        path: PathBuf,
        grid: &RasterGrid,
        nodata: Option<f32>,
        job_scratch: &Path,
        owns_derivative: bool,
        capacity_guard: bool,
    ) -> Result<Self, String> {
        let mut file = File::open(&path).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => {
                format!("prepared raster is missing: {}", path.display())
            }
            _ => format!("cannot open prepared raster {}: {error}", path.display()),
        })?;
        let file_len = file
            .metadata()
            .map_err(|error| format!("Failed to inspect prepared raster: {error}"))?
            .len();
        let level = read_controlled_level(&mut file, file_len, grid)?;
        Ok(Self {
            file: Some(file),
            path,
            owns_derivative,
            capacity_guard,
            scratch_dir: job_scratch.to_path_buf(),
            level,
            grid: grid.clone(),
            nodata,
            tile_bytes: vec![0; TILE_BYTES as usize],
        })
    }

    /// Read one half-open, in-bounds window.
    pub(super) fn read_window(
        &mut self,
        window: RasterWindow,
        cancel: &AtomicBool,
    ) -> Result<WindowSamples, String> {
        window.bounds(&self.grid, MAX_HALO_SIDE)?;
        let cells = window.cells()?;
        ensure_live_budget(cells)?;
        let mut samples = vec![0f32; cells];
        let mut valid = vec![0u8; cells];
        self.read_into(window, &mut samples, &mut valid, cancel)?;
        Ok(WindowSamples { samples, valid })
    }

    /// Read the whole raster in bounded windows, in row-band order, handing
    /// each window to `consume` before the buffers are reused.
    ///
    /// The windows tile the raster exactly once, so persisted row-major output
    /// can be written without retaining the raster and without re-reading a
    /// decoded tile.
    pub(super) fn scan(
        &mut self,
        cancel: &AtomicBool,
        mut consume: impl FnMut(&RasterWindow, &[f32], &[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        let band = MAX_WINDOW_SIDE.min(self.grid.height);
        let block = MAX_WINDOW_SIDE.min(self.grid.width);
        let capacity = (band as usize)
            .checked_mul(block as usize)
            .ok_or_else(|| "raster scan window is too large".to_string())?;
        ensure_live_budget(capacity)?;
        let mut samples = vec![0f32; capacity];
        let mut valid = vec![0u8; capacity];
        let mut y = 0u32;
        while y < self.grid.height {
            let height = band.min(self.grid.height - y);
            let mut x = 0u32;
            while x < self.grid.width {
                check_cancel(cancel)?;
                let width = block.min(self.grid.width - x);
                let window = RasterWindow {
                    x,
                    y,
                    width,
                    height,
                };
                let cells = window.cells()?;
                self.read_into(window, &mut samples[..cells], &mut valid[..cells], cancel)?;
                // Recheck at every consumer boundary: a wide row band would
                // otherwise perform many bounded writes before its next check.
                // Committed reads write nothing, so only an owned derivative
                // carries the reserve requirement.
                if self.capacity_guard {
                    paths::require_free_space(
                        &self.scratch_dir,
                        FREE_SPACE_FLOOR_BYTES,
                        "the raster window scan",
                    )?;
                }
                consume(&window, &samples[..cells], &valid[..cells])?;
                x += width;
            }
            y += height;
        }
        check_cancel(cancel)
    }

    fn read_into(
        &mut self,
        window: RasterWindow,
        samples: &mut [f32],
        valid: &mut [u8],
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        let (x_end, y_end) = window.bounds(&self.grid, MAX_HALO_SIDE)?;
        let cells = window.cells()?;
        if samples.len() != cells || valid.len() != cells {
            return Err(format!(
                "raster window buffers hold {} and {} cells, expected {cells}",
                samples.len(),
                valid.len()
            ));
        }
        check_cancel(cancel)?;
        observe_window(cells, &self.tile_bytes);
        let tile_x_end = x_end.div_ceil(TILE_SIDE);
        let tile_y_end = y_end.div_ceil(TILE_SIDE);
        for tile_y in window.y / TILE_SIDE..tile_y_end {
            for tile_x in window.x / TILE_SIDE..tile_x_end {
                check_cancel(cancel)?;
                let values = self.decode_tile(tile_x, tile_y)?;
                let tile_origin_x = tile_x * TILE_SIDE;
                let tile_origin_y = tile_y * TILE_SIDE;
                let x_start = window.x.max(tile_origin_x);
                let x_stop = x_end.min(tile_origin_x + TILE_SIDE);
                let y_start = window.y.max(tile_origin_y);
                let y_stop = y_end.min(tile_origin_y + TILE_SIDE);
                for y in y_start..y_stop {
                    let source_row = (y - tile_origin_y) as usize * TILE_SIDE as usize;
                    let target_row = (y - window.y) as usize * window.width as usize;
                    for x in x_start..x_stop {
                        let value = values[source_row + (x - tile_origin_x) as usize] as f32;
                        let index = target_row + (x - window.x) as usize;
                        samples[index] = value;
                        valid[index] = u8::from(
                            value.is_finite() && self.nodata.is_none_or(|nodata| value != nodata),
                        );
                    }
                }
            }
        }
        Ok(())
    }

    /// Decode exactly one 256×256 tile; no tile cache and no prefetch.
    fn decode_tile(&mut self, tile_x: u32, tile_y: u32) -> Result<Vec<f64>, String> {
        let (offset, count) = self
            .level
            .tile_range(tile_x, tile_y)
            .ok_or_else(|| format!("prepared raster has no tile at ({tile_x}, {tile_y})"))?;
        if count != TILE_BYTES {
            return Err(format!(
                "prepared raster tile ({tile_x}, {tile_y}) declares {count} bytes, expected {TILE_BYTES}"
            ));
        }
        let Self {
            file,
            tile_bytes,
            level,
            ..
        } = self;
        let file = file
            .as_mut()
            .ok_or_else(|| "prepared raster is already closed".to_string())?;
        let encoded = &mut tile_bytes[..count as usize];
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| format!("Failed to seek prepared raster tile: {error}"))?;
        file.read_exact(encoded)
            .map_err(|error| format!("Failed to read prepared raster tile: {error}"))?;
        let values = level
            .decode_tile_f64(encoded)
            .map_err(|error| format!("Failed to decode prepared raster tile: {error}"))?;
        if values.len() != TILE_SAMPLES {
            return Err(format!(
                "prepared raster tile ({tile_x}, {tile_y}) decoded {} samples, expected {TILE_SAMPLES}",
                values.len()
            ));
        }
        observe_tile();
        Ok(values)
    }
}

impl Drop for PreparedRaster {
    fn drop(&mut self) {
        // Close the handle before removing the file: Windows refuses to delete
        // an open file, and the caller may reuse the scratch directory.
        let _ = self.file.take();
        if self.owns_derivative {
            remove_derivative(&self.path);
        }
    }
}

/// Uncompressed derivative size, padded to whole 256×256 tiles.
pub(super) fn padded_cog_bytes(width: u32, height: u32) -> Result<u64, String> {
    let padded = |side: u32| -> Result<u64, String> {
        u64::from(side)
            .div_ceil(u64::from(TILE_SIDE))
            .checked_mul(u64::from(TILE_SIDE))
            .ok_or_else(|| "raster derivative padding overflows".to_string())
    };
    padded(width)?
        .checked_mul(padded(height)?)
        .and_then(|cells| cells.checked_mul(4))
        .ok_or_else(|| "raster derivative size overflows".to_string())
}

/// Bytes that must be free before preparation starts.
///
/// The derivative, its metadata allowance, any numeric output written while
/// the derivative is alive, and the shared reserve all coexist, so one checked
/// estimate covers them. Independent per-allocation checks would each see the
/// same free bytes and admit a footprint that does not fit.
pub(super) fn required_free_bytes(
    width: u32,
    height: u32,
    additional_output_bytes: u64,
) -> Result<u64, String> {
    padded_cog_bytes(width, height)?
        .checked_add(METADATA_PREFIX_CEILING)
        .and_then(|bytes| bytes.checked_add(additional_output_bytes))
        .and_then(|bytes| bytes.checked_add(FREE_SPACE_FLOOR_BYTES))
        .ok_or_else(|| {
            format!(
                "the combined raster working set for {width}x{height} with \
                 {additional_output_bytes} output bytes overflows"
            )
        })
}

#[cfg(test)]
fn derivative_path(job_scratch: &Path, input: &Path) -> PathBuf {
    let token = super::grid::sha256_hex(
        format!(
            "{}|{}|{}",
            input.display(),
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default(),
        )
        .as_bytes(),
    );
    job_scratch.join(format!("prepared-{}.tif", &token[..16]))
}

/// Remove a derivative and the sidecars an engine may have created beside it.
fn remove_derivative(path: &Path) {
    let _ = std::fs::remove_file(path);
    for sidecar in [
        path.with_extension("tif.msk"),
        path.with_extension("tif.aux.xml"),
    ] {
        let _ = std::fs::remove_file(sidecar);
    }
}

/// Parse the derivative's layout from a growing front-of-file prefix.
///
/// The prefix doubles from 64 KiB to a 4 MiB ceiling and never reads past the
/// file length. A layout that is still unavailable at the ceiling is a named
/// unsupported-preparation error: this reader has no whole-file fallback.
fn read_controlled_level(
    file: &mut File,
    file_len: u64,
    grid: &RasterGrid,
) -> Result<CogLevel, String> {
    let mut size = METADATA_PREFIX_START.min(file_len);
    loop {
        let mut prefix = vec![0u8; size as usize];
        file.seek(SeekFrom::Start(0))
            .map_err(|error| format!("Failed to read prepared raster metadata: {error}"))?;
        file.read_exact(&mut prefix)
            .map_err(|error| format!("Failed to read prepared raster metadata: {error}"))?;
        match GeoTiff::parse_cog_layout(&prefix) {
            Ok(layout) => return select_level(layout, file_len, grid),
            Err(error) => {
                if size >= METADATA_PREFIX_CEILING || size >= file_len {
                    return Err(format!(
                        "prepared raster metadata is unavailable within the {} MiB prefix ceiling (last attempt {size} of {file_len} bytes): {error}",
                        METADATA_PREFIX_CEILING / (1024 * 1024)
                    ));
                }
                size = (size.saturating_mul(2))
                    .min(METADATA_PREFIX_CEILING)
                    .min(file_len);
            }
        }
    }
}

/// Keep exactly one full-resolution level and reject anything else.
fn select_level(
    layout: wbgeotiff::CogLayout,
    file_len: u64,
    grid: &RasterGrid,
) -> Result<CogLevel, String> {
    if layout.levels.len() != 1 {
        return Err(format!(
            "prepared raster declares {} levels; the controlled derivative has exactly one",
            layout.levels.len()
        ));
    }
    let level = layout
        .levels
        .into_iter()
        .next()
        .ok_or_else(|| "prepared raster declares no levels".to_string())?;
    validate_level(&level, file_len, grid)?;
    Ok(level)
}

fn validate_level(level: &CogLevel, file_len: u64, grid: &RasterGrid) -> Result<(), String> {
    if level.width != grid.width || level.height != grid.height {
        return Err(format!(
            "prepared raster is {}x{} but the expected grid is {}x{}",
            level.width, level.height, grid.width, grid.height
        ));
    }
    if level.samples_per_pixel != 1 {
        return Err(format!(
            "prepared raster has {} bands; the controlled derivative is single-band",
            level.samples_per_pixel
        ));
    }
    if level.bits_per_sample != 32 || level.sample_format != SampleFormat::IeeeFloat {
        return Err(format!(
            "prepared raster is {} bits per sample in {:?}; the controlled derivative is Float32",
            level.bits_per_sample, level.sample_format
        ));
    }
    if level.compression != Compression::None {
        return Err(format!(
            "prepared raster is compressed ({:?}); the controlled derivative is uncompressed",
            level.compression
        ));
    }
    if level.tile_width != TILE_SIDE || level.tile_height != TILE_SIDE {
        return Err(format!(
            "prepared raster uses {}x{} tiles; the controlled derivative uses {TILE_SIDE}x{TILE_SIDE}",
            level.tile_width, level.tile_height
        ));
    }
    let expected_tiles = u64::from(level.width)
        .div_ceil(u64::from(TILE_SIDE))
        .checked_mul(u64::from(level.height).div_ceil(u64::from(TILE_SIDE)))
        .ok_or_else(|| "prepared raster tile count overflows".to_string())?;
    let declared_tiles = level.tile_offsets.len() as u64;
    if declared_tiles != expected_tiles || level.tile_byte_counts.len() as u64 != expected_tiles {
        return Err(format!(
            "prepared raster declares {} offsets and {} byte counts for {expected_tiles} tiles",
            level.tile_offsets.len(),
            level.tile_byte_counts.len()
        ));
    }
    for (index, (offset, count)) in level
        .tile_offsets
        .iter()
        .zip(level.tile_byte_counts.iter())
        .enumerate()
    {
        if *count != TILE_BYTES {
            return Err(format!(
                "prepared raster tile {index} declares {count} bytes, expected {TILE_BYTES}"
            ));
        }
        let end = offset
            .checked_add(*count)
            .ok_or_else(|| format!("prepared raster tile {index} range overflows"))?;
        if end > file_len {
            return Err(format!(
                "prepared raster tile {index} ends at byte {end}, past the {file_len}-byte file"
            ));
        }
    }
    Ok(())
}

/// Reject a request whose buffers this adapter must not hold at once.
fn ensure_live_budget(cells: usize) -> Result<(), String> {
    let live = live_bytes(cells);
    if live > MAX_LIVE_BYTES {
        return Err(format!(
            "a {cells}-cell window needs {live} live bytes, above the {} MiB adapter cap",
            MAX_LIVE_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

/// Buffers alive during one window: window samples and validity, the encoded
/// tile, and that tile's decoded samples.
fn live_bytes(cells: usize) -> u64 {
    (cells as u64)
        .saturating_mul(5)
        .saturating_add(TILE_BYTES)
        .saturating_add(TILE_SAMPLES as u64 * 8)
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".to_string());
    }
    Ok(())
}

#[cfg(test)]
fn observe_window(cells: usize, tile_bytes: &[u8]) {
    let live = live_bytes(cells).saturating_sub(TILE_BYTES) + tile_bytes.len() as u64;
    observability::WINDOWS_READ.with(|value| value.set(value.get() + 1));
    observability::PEAK_LIVE_BYTES.with(|value| value.set(value.get().max(live)));
}

#[cfg(not(test))]
fn observe_window(_cells: usize, _tile_bytes: &[u8]) {}

#[cfg(test)]
fn observe_tile() {
    observability::TILES_DECODED.with(|value| value.set(value.get() + 1));
}

#[cfg(not(test))]
fn observe_tile() {}

/// Test-only decode observations: proof that the native path produced the
/// bytes a caller test inspects, and that its buffers stayed bounded.
///
/// The counters are thread-local because every reader call is synchronous: a
/// test asserts on the work its own call did, so a concurrently running test
/// resetting a process-global counter can no longer erase that evidence.
#[cfg(test)]
pub(super) mod observability {
    use std::cell::Cell;

    thread_local! {
        pub(crate) static TILES_DECODED: Cell<u64> = const { Cell::new(0) };
        pub(crate) static WINDOWS_READ: Cell<u64> = const { Cell::new(0) };
        pub(crate) static PEAK_LIVE_BYTES: Cell<u64> = const { Cell::new(0) };
    }

    pub(crate) fn reset() {
        TILES_DECODED.with(|value| value.set(0));
        WINDOWS_READ.with(|value| value.set(0));
        PEAK_LIVE_BYTES.with(|value| value.set(0));
    }

    pub(crate) fn tiles_decoded() -> u64 {
        TILES_DECODED.with(Cell::get)
    }

    pub(crate) fn peak_live_bytes() -> u64 {
        PEAK_LIVE_BYTES.with(Cell::get)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------
    // Hermetic TIFF fixture
    // -----------------------------------------------------------------

    /// Minimal writer for an uncompressed, tiled, Float32 classic TIFF whose
    /// IFD sits at the front of the file, so the pinned reader's front-of-file
    /// COG layout parse applies. Tests mutate declared metadata to present the
    /// malformed derivatives a preparation step must reject; the values are
    /// authored here, independently of the reader under test.
    pub(super) struct TiffFixture {
        pub width: u32,
        pub height: u32,
        pub compression: u16,
        pub bits_per_sample: u16,
        pub sample_format: u16,
        pub tile_width: u32,
        pub tile_height: u32,
        pub nodata: Option<&'static str>,
        pub extra_level: bool,
        pub truncated_tail: bool,
        pub declares_extra_tile: bool,
        pub offsets_beyond_file: bool,
    }

    impl TiffFixture {
        pub fn new(width: u32, height: u32) -> Self {
            Self {
                width,
                height,
                compression: 1,
                bits_per_sample: 32,
                sample_format: 3,
                tile_width: TILE_SIDE,
                tile_height: TILE_SIDE,
                nodata: Some("-9999"),
                extra_level: false,
                truncated_tail: false,
                declares_extra_tile: false,
                offsets_beyond_file: false,
            }
        }

        /// Authored sample value for one cell.
        pub fn value(x: u32, y: u32) -> f32 {
            match (x, y) {
                (3, 4) => -9999.0,
                (7, 2) => f32::NAN,
                (9, 9) => f32::INFINITY,
                (11, 5) => 0.0,
                (12, 5) => -12.5,
                _ => 1000.0 + x as f32 * 0.25 - y as f32 * 2.0,
            }
        }

        #[expect(
            clippy::too_many_lines,
            reason = "ratcheted before 2.1-M188; split when this function next changes"
        )]
        pub fn bytes(&self) -> Vec<u8> {
            let tiles_x = self.width.div_ceil(self.tile_width);
            let tiles_y = self.height.div_ceil(self.tile_height);
            let tiles = (tiles_x * tiles_y) as usize;
            let declared_tiles = if self.declares_extra_tile {
                tiles + 1
            } else {
                tiles
            };
            let tile_pixels = (self.tile_width * self.tile_height) as usize;
            let tile_payload_bytes = tile_pixels * 4;

            // IFD geometry is known before any bytes are written: the entry
            // count fixes the directory size, and the tile arrays have one
            // 4-byte slot per declared tile.
            let mut entries: Vec<(u16, u16, u32, Vec<u8>)> = vec![
                (256, 4, 1, u32::to_le_bytes(self.width).to_vec()),
                (257, 4, 1, u32::to_le_bytes(self.height).to_vec()),
                (258, 3, 1, u16::to_le_bytes(self.bits_per_sample).to_vec()),
                (259, 3, 1, u16::to_le_bytes(self.compression).to_vec()),
                (262, 3, 1, u16::to_le_bytes(1).to_vec()),
                (277, 3, 1, u16::to_le_bytes(1).to_vec()),
                (284, 3, 1, u16::to_le_bytes(1).to_vec()),
                (317, 3, 1, u16::to_le_bytes(1).to_vec()),
                (322, 4, 1, u32::to_le_bytes(self.tile_width).to_vec()),
                (323, 4, 1, u32::to_le_bytes(self.tile_height).to_vec()),
                (339, 3, 1, u16::to_le_bytes(self.sample_format).to_vec()),
            ];
            if let Some(nodata) = self.nodata {
                let mut ascii = nodata.as_bytes().to_vec();
                ascii.push(0);
                entries.push((42113, 2, ascii.len() as u32, ascii));
            }
            let entry_count = entries.len() + 2;
            let ifd_offset = 8u32;
            let ifd_bytes = 2 + entry_count * 12 + 4;
            let external_start = ifd_offset as usize + ifd_bytes;
            let inline_len: usize = entries
                .iter()
                .filter(|(_, _, _, value)| value.len() > 4)
                .map(|(_, _, _, value)| value.len() + (value.len() % 2))
                .sum();
            let external_len = inline_len + declared_tiles * 4 * 2;
            let payload_start = external_start + external_len;
            let tile_offsets: Vec<u32> = (0..declared_tiles)
                .map(|tile| {
                    if tile < tiles {
                        (payload_start + tile * tile_payload_bytes) as u32
                    } else {
                        0
                    }
                })
                .collect();

            let mut external = Vec::new();
            let mut encoded: Vec<(u16, u16, u32, Vec<u8>)> = Vec::new();
            for (tag, kind, count, value) in entries {
                if value.len() > 4 {
                    let offset = external_start + external.len();
                    external.extend_from_slice(&value);
                    if external.len() % 2 == 1 {
                        external.push(0);
                    }
                    encoded.push((tag, kind, count, u32::to_le_bytes(offset as u32).to_vec()));
                } else {
                    encoded.push((tag, kind, count, value));
                }
            }
            let offsets_at = if self.offsets_beyond_file {
                u32::MAX - 64
            } else {
                (external_start + external.len()) as u32
            };
            for offset in &tile_offsets {
                external.extend_from_slice(&offset.to_le_bytes());
            }
            let counts_at = if self.offsets_beyond_file {
                u32::MAX - 32
            } else {
                (external_start + external.len()) as u32
            };
            for tile in 0..declared_tiles {
                let count = if tile < tiles { TILE_BYTES as u32 } else { 0 };
                external.extend_from_slice(&count.to_le_bytes());
            }
            encoded.push((
                324,
                4,
                declared_tiles as u32,
                offsets_at.to_le_bytes().to_vec(),
            ));
            encoded.push((
                325,
                4,
                declared_tiles as u32,
                counts_at.to_le_bytes().to_vec(),
            ));
            encoded.sort_by_key(|(tag, _, _, _)| *tag);
            assert_eq!(encoded.len(), entry_count as usize);
            assert_eq!(external.len(), external_len, "fixture external area");

            // Tile payloads, row-major by tile, padded to the declared size.
            let mut payload = vec![0u8; tiles * tile_payload_bytes];
            for tile_y in 0..tiles_y {
                for tile_x in 0..tiles_x {
                    let tile = (tile_y * tiles_x + tile_x) as usize;
                    for row in 0..self.tile_height {
                        for column in 0..self.tile_width {
                            let x = tile_x * self.tile_width + column;
                            let y = tile_y * self.tile_height + row;
                            let value = if x < self.width && y < self.height {
                                Self::value(x, y)
                            } else {
                                0.0
                            };
                            let index =
                                tile * tile_pixels + (row * self.tile_width + column) as usize;
                            payload[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
                        }
                    }
                }
            }

            let second_ifd_at = if self.extra_level {
                Some(payload_start + payload.len())
            } else {
                None
            };
            let mut out = Vec::with_capacity(payload_start + payload.len());
            out.extend_from_slice(b"II");
            out.extend_from_slice(&42u16.to_le_bytes());
            out.extend_from_slice(&ifd_offset.to_le_bytes());
            out.extend_from_slice(&(encoded.len() as u16).to_le_bytes());
            for (tag, kind, count, value) in &encoded {
                out.extend_from_slice(&tag.to_le_bytes());
                out.extend_from_slice(&kind.to_le_bytes());
                out.extend_from_slice(&count.to_le_bytes());
                let mut inline = [0u8; 4];
                inline[..value.len()].copy_from_slice(value);
                out.extend_from_slice(&inline);
            }
            out.extend_from_slice(&(second_ifd_at.unwrap_or(0) as u32).to_le_bytes());
            out.extend_from_slice(&external);
            assert_eq!(out.len(), payload_start, "fixture payload offset");
            out.extend_from_slice(&payload);
            if let Some(second_ifd) = second_ifd_at {
                let entries = [
                    (
                        256u16,
                        4u16,
                        1u32,
                        u32::to_le_bytes(self.width.div_ceil(2)).to_vec(),
                    ),
                    (
                        257,
                        4,
                        1,
                        u32::to_le_bytes(self.height.div_ceil(2)).to_vec(),
                    ),
                    (258, 3, 1, u16::to_le_bytes(32).to_vec()),
                    (259, 3, 1, u16::to_le_bytes(1).to_vec()),
                    (262, 3, 1, u16::to_le_bytes(1).to_vec()),
                    (277, 3, 1, u16::to_le_bytes(1).to_vec()),
                    (322, 4, 1, u32::to_le_bytes(TILE_SIDE).to_vec()),
                    (323, 4, 1, u32::to_le_bytes(TILE_SIDE).to_vec()),
                    (324, 4, 1, u32::to_le_bytes(tile_offsets[0]).to_vec()),
                    (325, 4, 1, u32::to_le_bytes(TILE_BYTES as u32).to_vec()),
                    (339, 3, 1, u16::to_le_bytes(3).to_vec()),
                ];
                out.resize(second_ifd, 0);
                out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
                for (tag, kind, count, value) in &entries {
                    out.extend_from_slice(&tag.to_le_bytes());
                    out.extend_from_slice(&kind.to_le_bytes());
                    out.extend_from_slice(&count.to_le_bytes());
                    let mut inline = [0u8; 4];
                    inline[..value.len()].copy_from_slice(value);
                    out.extend_from_slice(&inline);
                }
                out.extend_from_slice(&0u32.to_le_bytes());
            }
            if self.truncated_tail {
                let keep = payload_start + payload.len() / 2;
                out.truncate(keep);
            }
            out
        }
    }

    struct Scratch {
        dir: crate::test_scratch::TestScratch,
    }

    impl Scratch {
        fn new(label: &str) -> Self {
            Self {
                dir: crate::test_scratch::TestScratch::new(&format!("prepared-{label}")),
            }
        }

        fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.dir.join(name);
            std::fs::write(&path, bytes).expect("fixture writes");
            path
        }

        fn path(&self, name: &str) -> PathBuf {
            self.dir.join(name)
        }
    }

    fn test_grid(width: u32, height: u32) -> RasterGrid {
        RasterGrid {
            width,
            height,
            geotransform: [0.0, 1.0, 0.0, height as f64, 0.0, -1.0],
        }
    }

    fn open_fixture(path: &Path, grid: &RasterGrid, nodata: Option<f32>) -> PreparedRaster {
        PreparedRaster::open_derivative(
            path.to_path_buf(),
            grid,
            nodata,
            path.parent().unwrap(),
            false,
            false,
        )
        .expect("fixture opens")
    }

    /// A committed read that carries the write reserve, so capacity
    /// observation can be exercised without a real preparation.
    fn open_fixture_guarded(path: &Path, grid: &RasterGrid, nodata: Option<f32>) -> PreparedRaster {
        PreparedRaster::open_derivative(
            path.to_path_buf(),
            grid,
            nodata,
            path.parent().unwrap(),
            false,
            true,
        )
        .expect("fixture opens")
    }

    fn cancellation() -> AtomicBool {
        AtomicBool::new(false)
    }

    fn authored_valid(value: f32, nodata: Option<f32>) -> u8 {
        u8::from(value.is_finite() && nodata.is_none_or(|sentinel| value != sentinel))
    }

    // -----------------------------------------------------------------
    // Window reads
    // -----------------------------------------------------------------

    #[test]
    fn full_window_matches_the_authored_values_and_validity() {
        let scratch = Scratch::new("full");
        let fixture = TiffFixture::new(600, 600);
        let path = scratch.write("full.tif", &fixture.bytes());
        let grid = test_grid(600, 600);
        let mut raster = open_fixture(&path, &grid, Some(-9999.0));

        let window = RasterWindow {
            x: 0,
            y: 0,
            width: 600,
            height: 600,
        };
        let read = raster
            .read_window(window, &cancellation())
            .expect("window reads");
        assert_eq!(read.samples().len(), 600 * 600);
        for y in 0..600u32 {
            for x in 0..600u32 {
                let index = (y * 600 + x) as usize;
                let expected = TiffFixture::value(x, y);
                let got = read.samples()[index];
                if expected.is_nan() {
                    assert!(got.is_nan(), "cell ({x},{y}) must stay NaN, got {got}");
                } else {
                    assert_eq!(
                        got.to_bits(),
                        expected.to_bits(),
                        "cell ({x},{y}) sample differs"
                    );
                }
                assert_eq!(
                    read.valid()[index],
                    authored_valid(expected, Some(-9999.0)),
                    "cell ({x},{y}) validity differs"
                );
            }
        }
        assert_eq!(raster.grid.width, 600);
    }

    #[test]
    fn edge_windows_clip_padded_tiles() {
        let scratch = Scratch::new("edges");
        let fixture = TiffFixture::new(600, 600);
        let path = scratch.write("edges.tif", &fixture.bytes());
        let mut raster = open_fixture(&path, &test_grid(600, 600), Some(-9999.0));

        // Straddles a tile seam and a padded edge tile in one window.
        let window = RasterWindow {
            x: 500,
            y: 480,
            width: 100,
            height: 120,
        };
        let read = raster.read_window(window, &cancellation()).unwrap();
        assert_eq!(read.samples().len(), 100 * 120);
        for row in 0..120u32 {
            for column in 0..100u32 {
                let (x, y) = (500 + column, 480 + row);
                let index = (row * 100 + column) as usize;
                let expected = TiffFixture::value(x, y);
                let got = read.samples()[index];
                if expected.is_nan() {
                    assert!(got.is_nan());
                } else {
                    assert_eq!(got.to_bits(), expected.to_bits(), "cell ({x},{y})");
                }
                assert_eq!(read.valid()[index], authored_valid(expected, Some(-9999.0)));
            }
        }

        // Single last-pixel window: maximum padding inside the final tile.
        let last = RasterWindow {
            x: 599,
            y: 599,
            width: 1,
            height: 1,
        };
        let read = raster.read_window(last, &cancellation()).unwrap();
        assert_eq!(read.samples(), &[TiffFixture::value(599, 599)]);
        assert_eq!(read.valid(), &[1]);
    }

    #[test]
    fn declared_nodata_absent_leaves_only_non_finite_cells_invalid() {
        let scratch = Scratch::new("nodata-none");
        let mut fixture = TiffFixture::new(600, 600);
        fixture.nodata = None;
        let path = scratch.write("none.tif", &fixture.bytes());
        let mut raster = open_fixture(&path, &test_grid(600, 600), None);
        let read = raster
            .read_window(
                RasterWindow {
                    x: 0,
                    y: 0,
                    width: 600,
                    height: 600,
                },
                &cancellation(),
            )
            .unwrap();
        let sentinel = (4 * 600 + 3) as usize;
        assert_eq!(read.samples()[sentinel], -9999.0);
        assert_eq!(
            read.valid()[sentinel],
            1,
            "without a declared NoData the sentinel is data"
        );
        let nan = (2 * 600 + 7) as usize;
        assert!(read.samples()[nan].is_nan());
        assert_eq!(read.valid()[nan], 0);
    }

    #[test]
    fn invalid_windows_are_rejected_before_reading() {
        let scratch = Scratch::new("reject");
        let fixture = TiffFixture::new(600, 600);
        let path = scratch.write("reject.tif", &fixture.bytes());
        let mut raster = open_fixture(&path, &test_grid(600, 600), Some(-9999.0));
        let cases = [
            (
                RasterWindow {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 8,
                },
                "empty",
            ),
            (
                RasterWindow {
                    x: 0,
                    y: 0,
                    width: 8,
                    height: 0,
                },
                "empty",
            ),
            (
                RasterWindow {
                    x: 0,
                    y: 0,
                    width: MAX_HALO_SIDE + 1,
                    height: 1,
                },
                "cap",
            ),
            (
                RasterWindow {
                    x: 0,
                    y: 0,
                    width: 1,
                    height: MAX_HALO_SIDE + 1,
                },
                "cap",
            ),
            (
                RasterWindow {
                    x: 600,
                    y: 0,
                    width: 1,
                    height: 1,
                },
                "outside",
            ),
            (
                RasterWindow {
                    x: 0,
                    y: 600,
                    width: 1,
                    height: 1,
                },
                "outside",
            ),
            (
                RasterWindow {
                    x: 599,
                    y: 0,
                    width: 2,
                    height: 1,
                },
                "outside",
            ),
            (
                RasterWindow {
                    x: u32::MAX,
                    y: 0,
                    width: 2,
                    height: 1,
                },
                "overflows",
            ),
        ];
        for (window, expected) in cases {
            let error = raster
                .read_window(window, &cancellation())
                .expect_err("window must be rejected");
            assert!(
                error.contains(expected),
                "window {window:?} produced {error:?}, expected {expected:?}"
            );
        }
    }

    #[test]
    fn grid_disagreement_is_rejected() {
        let scratch = Scratch::new("grid");
        let fixture = TiffFixture::new(600, 600);
        let path = scratch.write("grid.tif", &fixture.bytes());
        let error = PreparedRaster::open_derivative(
            path,
            &test_grid(600, 601),
            Some(-9999.0),
            &scratch.dir,
            false,
            false,
        )
        .expect_err("mismatched grid must be rejected");
        assert!(error.contains("expected grid"), "{error}");
    }

    // -----------------------------------------------------------------
    // Scanning and bounds
    // -----------------------------------------------------------------

    #[test]
    fn scan_covers_a_multi_window_raster_exactly_once_in_band_order() {
        let scratch = Scratch::new("scan");
        let fixture = TiffFixture::new(1100, 2100);
        let path = scratch.write("scan.tif", &fixture.bytes());
        let mut raster = open_fixture(&path, &test_grid(1100, 2100), Some(-9999.0));

        let mut seen = vec![0u8; 1100 * 2100];
        let mut samples = vec![f32::NAN; 1100 * 2100];
        let mut windows: Vec<RasterWindow> = Vec::new();
        raster
            .scan(&cancellation(), |window, window_samples, window_valid| {
                windows.push(*window);
                assert!(window.width <= MAX_WINDOW_SIDE && window.height <= MAX_WINDOW_SIDE);
                for row in 0..window.height {
                    for column in 0..window.width {
                        let (x, y) = (window.x + column, window.y + row);
                        let index = (y * 1100 + x) as usize;
                        seen[index] += 1;
                        samples[index] = window_samples[(row * window.width + column) as usize];
                        let expected = TiffFixture::value(x, y);
                        assert_eq!(
                            window_valid[(row * window.width + column) as usize],
                            authored_valid(expected, Some(-9999.0)),
                            "validity at ({x},{y})"
                        );
                    }
                }
                Ok(())
            })
            .expect("scan completes");

        assert!(
            windows.len() > 1,
            "a 1100x2100 raster needs several bounded windows"
        );
        assert!(seen.iter().all(|count| *count == 1), "every cell once");
        for y in 0..2100u32 {
            for x in 0..1100u32 {
                let expected = TiffFixture::value(x, y);
                let got = samples[(y * 1100 + x) as usize];
                if expected.is_nan() {
                    assert!(got.is_nan());
                } else {
                    assert_eq!(got.to_bits(), expected.to_bits(), "cell ({x},{y})");
                }
            }
        }
        // Row bands advance top to bottom; each band's windows advance left to right.
        let mut previous = windows[0];
        for window in &windows[1..] {
            assert!(
                window.y > previous.y || window.x > previous.x,
                "windows stay in row-major order"
            );
            previous = *window;
        }
    }

    #[test]
    fn scan_live_buffers_stay_under_the_adapter_cap() {
        observability::reset();
        let scratch = Scratch::new("live");
        let fixture = TiffFixture::new(1100, 2100);
        let path = scratch.write("live.tif", &fixture.bytes());
        let mut raster = open_fixture(&path, &test_grid(1100, 2100), Some(-9999.0));
        raster.scan(&cancellation(), |_, _, _| Ok(())).unwrap();

        let peak = observability::peak_live_bytes();
        assert!(peak > 0, "windows were observed");
        assert!(
            peak <= MAX_LIVE_BYTES,
            "peak live bytes {peak} must stay under the {MAX_LIVE_BYTES}-byte cap"
        );
        assert!(
            observability::tiles_decoded() > 0,
            "tiles were decoded through the native reader"
        );
    }

    // -----------------------------------------------------------------
    // Combined working-set budget
    // -----------------------------------------------------------------

    /// One mebibyte, the unit the admission message reports.
    const MIB: u64 = 1024 * 1024;

    /// Independently calculated from the documented formula: a 1024x1024
    /// Float32 raster has a 4 MiB padded derivative, a 4 MiB metadata
    /// allowance, 5 MiB of staged outputs (four sample bytes plus one validity
    /// byte per cell) and the 256 MiB reserve.
    #[test]
    fn combined_working_set_sums_every_simultaneously_live_allocation() {
        let cells = 1024 * 1024;
        assert_eq!(
            required_free_bytes(1024, 1024, cells * 5).expect("estimate"),
            269 * MIB
        );
        // With nothing new in flight the same grid keeps the preparation-only
        // requirement.
        assert_eq!(
            required_free_bytes(1024, 1024, 0).expect("estimate"),
            264 * MIB
        );
        // Both former independent checks admitted 265 MiB free (261 MiB for
        // the outputs, 264 MiB for preparation); the combined one must not.
        assert!(required_free_bytes(1024, 1024, cells * 5).expect("estimate") > 265 * MIB);
        assert!(required_free_bytes(1024, 1024, cells * 5).expect("estimate") <= 269 * MIB);
    }

    #[test]
    fn combined_working_set_overflow_is_a_named_error() {
        let error = required_free_bytes(1024, 1024, u64::MAX).expect_err("overflow must fail");
        assert!(error.contains("overflows"), "{error}");
        let error = required_free_bytes(u32::MAX, u32::MAX, 0).expect_err("padded size must fail");
        assert!(error.contains("overflows"), "{error}");
    }

    #[test]
    fn scan_observes_capacity_at_every_window_boundary() {
        let scratch = Scratch::new("window-capacity");
        let fixture = TiffFixture::new(1100, 2100);
        let path = scratch.write("window-capacity.tif", &fixture.bytes());
        let mut raster = open_fixture_guarded(&path, &test_grid(1100, 2100), Some(-9999.0));
        let _guard = paths::capacity_probe::override_available(FREE_SPACE_FLOOR_BYTES);
        let mut consumed = 0u32;
        let error = raster
            .scan(&cancellation(), |_window, _samples, _valid| {
                consumed += 1;
                if consumed == 1 {
                    // The space measured at the start is gone by the next
                    // consumer boundary.
                    paths::capacity_probe::set(Some(FREE_SPACE_FLOOR_BYTES - 1));
                }
                Ok(())
            })
            .expect_err("the scan must stop once the reserve is gone");
        assert_eq!(
            consumed, 1,
            "the first window was delivered and the next was refused"
        );
        assert!(error.contains("the raster window scan"), "{error}");
        assert!(
            error.contains("255 MiB"),
            "names the measured space: {error}"
        );
    }

    #[test]
    fn live_budget_rejects_a_window_above_the_cap() {
        let cap_cells = (MAX_WINDOW_SIDE as usize) * (MAX_WINDOW_SIDE as usize);
        assert!(ensure_live_budget(cap_cells).is_ok());
        let error = ensure_live_budget(cap_cells * 16).expect_err("above the cap");
        assert!(error.contains("adapter cap"), "{error}");
    }

    #[test]
    fn padded_derivative_size_rounds_up_to_whole_tiles() {
        assert_eq!(padded_cog_bytes(600, 600).unwrap(), 768 * 768 * 4);
        assert_eq!(padded_cog_bytes(256, 256).unwrap(), 256 * 256 * 4);
        assert_eq!(padded_cog_bytes(1, 1).unwrap(), 256 * 256 * 4);
    }

    // -----------------------------------------------------------------
    // Malformed derivatives
    // -----------------------------------------------------------------

    #[test]
    fn malformed_derivatives_are_rejected() {
        type Case = (&'static str, Box<dyn Fn(&mut TiffFixture)>, &'static str);
        let cases: Vec<Case> = vec![
            (
                "compressed",
                Box::new(|fixture: &mut TiffFixture| fixture.compression = 8),
                "uncompressed",
            ),
            (
                "bits",
                Box::new(|fixture: &mut TiffFixture| fixture.bits_per_sample = 64),
                "Float32",
            ),
            (
                "format",
                Box::new(|fixture: &mut TiffFixture| fixture.sample_format = 2),
                "Float32",
            ),
            (
                "tiles",
                Box::new(|fixture: &mut TiffFixture| fixture.tile_width = 128),
                "tiles",
            ),
            (
                "two levels",
                Box::new(|fixture: &mut TiffFixture| fixture.extra_level = true),
                "levels",
            ),
            (
                "tile count",
                Box::new(|fixture: &mut TiffFixture| fixture.declares_extra_tile = true),
                "tiles",
            ),
            (
                "truncated",
                Box::new(|fixture: &mut TiffFixture| fixture.truncated_tail = true),
                "past the",
            ),
        ];
        for (label, mutate, expected) in cases {
            let scratch = Scratch::new("malformed");
            let mut fixture = TiffFixture::new(600, 600);
            mutate(&mut fixture);
            let path = scratch.write("malformed.tif", &fixture.bytes());
            let error = PreparedRaster::open_derivative(
                path,
                &test_grid(600, 600),
                Some(-9999.0),
                &scratch.dir,
                false,
                false,
            )
            .err()
            .unwrap_or_else(|| panic!("{label} derivative must be rejected"));
            assert!(
                error.contains(expected),
                "{label} derivative produced {error:?}, expected {expected:?}"
            );
        }
    }

    #[test]
    fn metadata_beyond_the_prefix_ceiling_fails_without_a_full_read() {
        let scratch = Scratch::new("ceiling");
        // A header whose tile-offset array sits far past the file end, so no
        // prefix can ever complete it. The file is padded past the ceiling so
        // the reader has to grow its prefix all the way up before failing.
        let mut fixture = TiffFixture::new(600, 600);
        fixture.offsets_beyond_file = true;
        let mut bytes = fixture.bytes();
        bytes.resize((METADATA_PREFIX_CEILING + 1024) as usize, 0);
        let path = scratch.write("ceiling.tif", &bytes);
        let error = PreparedRaster::open_derivative(
            path,
            &test_grid(600, 600),
            Some(-9999.0),
            &scratch.dir,
            false,
            false,
        )
        .expect_err("unavailable metadata must fail");
        assert!(
            error.contains("prefix ceiling"),
            "expected a named metadata-ceiling error, got {error:?}"
        );
    }

    #[test]
    fn missing_derivative_is_a_named_error() {
        let scratch = Scratch::new("missing");
        let error = PreparedRaster::open_derivative(
            scratch.path("absent.tif"),
            &test_grid(4, 4),
            None,
            &scratch.dir,
            false,
            false,
        )
        .expect_err("missing derivative must fail");
        assert!(error.contains("missing"), "{error}");
    }

    // -----------------------------------------------------------------
    // Cancellation, ownership and capacity
    // -----------------------------------------------------------------

    #[test]
    fn cancellation_stops_a_scan_and_dropping_removes_only_its_derivative() {
        let scratch = Scratch::new("cancel");
        let fixture = TiffFixture::new(1100, 2100);
        let owner = scratch.write("owner.tif", &fixture.bytes());
        let other = scratch.write("other.tif", &fixture.bytes());
        let cancel = cancellation();
        cancel.store(true, Ordering::Relaxed);

        let mut raster = PreparedRaster::open_derivative(
            owner.clone(),
            &test_grid(1100, 2100),
            Some(-9999.0),
            &scratch.dir,
            true,
            true,
        )
        .unwrap();
        let error = raster
            .scan(&cancel, |_, _, _| Ok(()))
            .expect_err("cancelled scan must fail");
        assert_eq!(error, "cancelled");
        drop(raster);
        assert!(!owner.exists(), "the owned derivative is removed on drop");
        assert!(other.exists(), "another derivative is untouched");

        // Cancellation before the first decode also fails cleanly.
        let mut raster = open_fixture(&other, &test_grid(1100, 2100), Some(-9999.0));
        let error = raster
            .read_window(
                RasterWindow {
                    x: 0,
                    y: 0,
                    width: 8,
                    height: 8,
                },
                &cancel,
            )
            .expect_err("cancelled read must fail");
        assert_eq!(error, "cancelled");
    }

    // -----------------------------------------------------------------
    // Real preparation through the raster engine
    // -----------------------------------------------------------------

    const F32_NODATA: f32 = -9999.0;

    /// Authored value for the real-engine fixture, including the cases the
    /// Float32 conversion contract must preserve.
    fn real_value(x: u32, y: u32) -> f32 {
        match (x % 37, y % 29) {
            (0, 0) => F32_NODATA,
            (1, 1) => f32::NAN,
            (2, 2) => f32::INFINITY,
            (3, 3) => f32::NEG_INFINITY,
            (4, 4) => 0.0,
            (5, 5) => -12.5,
            _ => ((x as f32) * 0.75 - (y as f32) * 1.25).sin() * 500.0,
        }
    }

    fn authored_values(width: u32, height: u32) -> Vec<f32> {
        (0..height)
            .flat_map(|y| (0..width).map(move |x| real_value(x, y)))
            .collect()
    }

    /// Build a real GeoTIFF fixture through the engine from authored values.
    fn authored_source(scratch: &Scratch, name: &str, width: u32, height: u32) -> PathBuf {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let tif = scratch.path(&format!("{name}.tif"));
        let source_grid = RasterGrid {
            width,
            height,
            geotransform: [0.0, 1.0, 0.0, height as f64, 0.0, -1.0],
        };
        engine
            .write_geotiff(
                &tif,
                crate::services::lidar::engine::RasterGeoref {
                    grid: &source_grid,
                    crs: "EPSG:3857",
                },
                F32_NODATA,
                &authored_values(width, height),
                &cancellation(),
            )
            .expect("fixture converts to GeoTIFF");
        tif
    }

    /// The authored values, through the cast a typed fixture was written with,
    /// as the independent oracle the streaming reader must match.
    fn authored_oracle(grid: &RasterGrid, cast: fn(f32) -> f32) -> (Vec<u8>, Vec<u8>) {
        let raw: Vec<u8> = authored_values(grid.width, grid.height)
            .into_iter()
            .map(cast)
            .flat_map(|value| value.to_le_bytes())
            .collect();
        let mask = crate::services::lidar::grid::valid_mask_from_f32_raw_checked(
            grid.width,
            grid.height,
            &raw,
            Some(F32_NODATA),
            |_| Ok(()),
        )
        .expect("oracle mask");
        (raw, mask.bytes().to_vec())
    }

    /// Collect the streaming reader's output for a whole raster.
    fn streamed_bytes(source: &Path, grid: &RasterGrid, scratch: &Scratch) -> (Vec<u8>, Vec<u8>) {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = cancellation();
        let cells = (grid.width as usize) * (grid.height as usize);
        let mut samples = vec![0f32; cells];
        let mut valid = vec![0u8; cells];
        let mut raster = PreparedRaster::open(
            &engine,
            source,
            grid,
            Some(F32_NODATA),
            0,
            &scratch.dir,
            &cancel,
        )
        .expect("preparation succeeds");
        raster
            .scan(&cancel, |window, window_samples, window_valid| {
                for row in 0..window.height {
                    for column in 0..window.width {
                        let index = ((window.y + row) as usize) * (grid.width as usize)
                            + (window.x + column) as usize;
                        samples[index] = window_samples[(row * window.width + column) as usize];
                        valid[index] = window_valid[(row * window.width + column) as usize];
                    }
                }
                Ok(())
            })
            .expect("scan succeeds");
        drop(raster);
        let raw = samples
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        (raw, valid)
    }

    fn assert_matches_oracle(raw: &[u8], valid: &[u8], oracle_raw: &[u8], oracle_valid: &[u8]) {
        assert_eq!(raw.len(), oracle_raw.len(), "streamed sample byte count");
        assert_eq!(
            valid.len(),
            oracle_valid.len(),
            "streamed validity byte count"
        );
        for index in 0..valid.len() {
            let expected =
                f32::from_le_bytes(oracle_raw[index * 4..index * 4 + 4].try_into().unwrap());
            let got = f32::from_le_bytes(raw[index * 4..index * 4 + 4].try_into().unwrap());
            if expected.is_nan() {
                assert!(got.is_nan(), "sample {index} must stay NaN, got {got}");
            } else {
                assert_eq!(
                    got.to_bits(),
                    expected.to_bits(),
                    "sample {index} differs from the authored Float32 value"
                );
            }
            assert_eq!(valid[index], oracle_valid[index], "validity at {index}");
        }
    }

    #[test]
    fn preparation_streams_exactly_the_authored_float32_values() {
        observability::reset();
        let scratch = Scratch::new("real-f32");
        let (width, height) = (300, 260);
        let source = authored_source(&scratch, "f32", width, height);
        let grid = test_grid(width, height);
        let (oracle_raw, oracle_valid) = authored_oracle(&grid, |value| value);
        let (raw, valid) = streamed_bytes(&source, &grid, &scratch);
        assert_matches_oracle(&raw, &valid, &oracle_raw, &oracle_valid);
        assert_eq!(raw.len(), (width * height * 4) as usize);
        assert!(
            observability::tiles_decoded() > 0,
            "the native tiled reader decoded the derivative"
        );

        // The derivative is temporary, and preparing it wrote nothing beside
        // the read-only input.
        let leftovers: Vec<_> = std::fs::read_dir(&scratch.dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("prepared-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "derivative left behind: {leftovers:?}"
        );
        assert!(
            !scratch.path("f32.tif.aux.xml").exists(),
            "preparation must not write auxiliary metadata beside the input"
        );
        assert!(source.exists(), "the managed original is untouched");
    }

    /// Every admitted sample type and layout streams back as the Float32 cast
    /// of what was written: a striped Float32 file, Int16, Byte, UInt32 and
    /// Float64, each written through wbgeotiff from the authored values.
    #[test]
    fn preparation_matches_the_oracle_for_admitted_numeric_types_and_layouts() {
        use wbgeotiff::{GeoTiffWriter, GeoTransform, WriteLayout};
        let scratch = Scratch::new("real-types");
        let (width, height) = (180, 140);
        let base = authored_source(&scratch, "base", width, height);
        let grid = test_grid(width, height);
        let values = authored_values(width, height);
        let writer = |layout: WriteLayout| {
            GeoTiffWriter::new(width, height, 1)
                .layout(layout)
                .geo_transform(GeoTransform::north_up(0.0, 1.0, f64::from(height), -1.0))
                .epsg(3857)
                .no_data(f64::from(F32_NODATA))
        };
        let tiled = WriteLayout::Tiled {
            tile_width: 256,
            tile_height: 256,
        };
        // A striped source exercises preparation from a legacy layout.
        let striped = scratch.path("striped.tif");
        writer(WriteLayout::Stripped { rows_per_strip: 32 })
            .write_f32(&striped, &values)
            .expect("striped fixture writes");
        let int16 = scratch.path("int16.tif");
        writer(tiled)
            .write_i16(
                &int16,
                &values.iter().map(|v| *v as i16).collect::<Vec<_>>(),
            )
            .expect("int16 fixture writes");
        let byte = scratch.path("byte.tif");
        writer(tiled)
            .write_u8(&byte, &values.iter().map(|v| *v as u8).collect::<Vec<_>>())
            .expect("byte fixture writes");
        let uint32 = scratch.path("uint32.tif");
        writer(tiled)
            .write_u32(
                &uint32,
                &values.iter().map(|v| *v as u32).collect::<Vec<_>>(),
            )
            .expect("uint32 fixture writes");
        let float64 = scratch.path("float64.tif");
        writer(tiled)
            .write_f64(
                &float64,
                &values.iter().map(|v| f64::from(*v)).collect::<Vec<_>>(),
            )
            .expect("float64 fixture writes");

        type Cast = fn(f32) -> f32;
        let variants: [(&str, Cast, PathBuf); 6] = [
            ("float32-tiled", |v| v, base),
            ("float32-striped", |v| v, striped),
            ("int16", |v| f32::from(v as i16), int16),
            ("byte", |v| f32::from(v as u8), byte),
            ("uint32", |v| v as u32 as f32, uint32),
            ("float64", |v| v, float64),
        ];
        for (label, cast, target) in variants {
            let (oracle_raw, oracle_valid) = authored_oracle(&grid, cast);
            let (raw, valid) = streamed_bytes(&target, &grid, &scratch);
            println!("{label}: {} samples", raw.len() / 4);
            assert_matches_oracle(&raw, &valid, &oracle_raw, &oracle_valid);
        }
    }

    #[test]
    fn preparation_failure_and_cancellation_leave_no_derivative() {
        let scratch = Scratch::new("real-failure");
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let grid = test_grid(64, 64);

        let cancel = cancellation();
        cancel.store(true, Ordering::Relaxed);
        let source = authored_source(&scratch, "cancel", 64, 64);
        let error = PreparedRaster::open(
            &engine,
            &source,
            &grid,
            Some(F32_NODATA),
            0,
            &scratch.dir,
            &cancel,
        )
        .expect_err("a cancelled preparation must fail");
        assert_eq!(error, "cancelled");

        let missing = scratch.path("absent-input.tif");
        let error = PreparedRaster::open(
            &engine,
            &missing,
            &grid,
            Some(F32_NODATA),
            0,
            &scratch.dir,
            &cancellation(),
        )
        .expect_err("a failed preparation must fail");
        assert!(!error.is_empty());

        let leftovers: Vec<_> = std::fs::read_dir(&scratch.dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("prepared-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "failed preparations left derivatives behind: {leftovers:?}"
        );
    }

    #[test]
    fn free_space_requirement_reports_a_named_reason() {
        let scratch = Scratch::new("space");
        paths::require_free_space(&scratch.dir, 1, "the test output").expect("space exists");
        let error = paths::require_free_space(&scratch.dir, u64::MAX / 2, "the test output")
            .expect_err("an impossible requirement must fail");
        assert!(error.contains("the test output"), "{error}");
        assert!(error.contains("MiB"), "{error}");
        assert!(
            paths::available_bytes(&scratch.dir).unwrap() > 0,
            "the platform reports capacity here"
        );
    }
}
