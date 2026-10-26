//! Tiled GeoTIFF and COG output on the `wbgeotiff` codec and GeoKey primitives.
//!
//! One writer produces every profile the library persists: the controlled
//! numeric COG (uncompressed, no overviews), the display COG (Deflate,
//! averaged valid-data overviews), the relief COG (Deflate, each level from
//! its own band) and the tiled Deflate exchange GeoTIFF.
//! Every file is little-endian classic TIFF with 256×256 Float32 tiles, its
//! directories at the front (what the bounded reader parses from a prefix)
//! and tile data after them. Overviews halve while a side exceeds one tile,
//! sized by floor division, and average only valid samples, the layout GDAL's
//! COG driver produced for the same profile.
//!
//! The writer reads its band through [`BandSource`] in row windows of whole
//! tiles, at most the caller's cell budget each, so a band in memory and a
//! band streamed from its file take the same path and give the same bytes.
//! Each overview level is averaged from the level before it, read back from
//! the tiles already written, or ([`write_levels`]) read from its own band.

use super::super::engine::check_cancel;
use super::super::grid::RasterGrid;
use super::super::prepared_raster::RasterWindow;
use super::tiff;
use std::fs::File;
use std::io::{BufWriter, Seek as _, SeekFrom, Write as _};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use wbgeotiff::geo_keys::GeoKeyDirectory;
use wbgeotiff::ifd::ByteOrder;
use wbgeotiff::tags::{Compression, SampleFormat, tag};

/// Tile side of every profile.
pub(super) const TILE: u32 = 256;
/// Classic TIFF addresses 32-bit offsets; the import budget (400 M cells,
/// 1.6 GB of Float32, charged before a source converts) keeps every profile
/// below it, so the writer refuses rather than switch layouts.
const MAX_CLASSIC_BYTES: u64 = u32::MAX as u64;

/// What kind of file to write.
#[derive(Debug, Clone, Copy)]
pub(super) struct CogProfile {
    pub compression: Compression,
    pub overviews: bool,
}

/// Where the raster sits.
#[derive(Debug, Clone, Copy)]
pub(super) struct CogGeoref<'a> {
    pub grid: &'a RasterGrid,
    pub geo_keys: Option<&'a GeoKeyDirectory>,
}

/// A band the writer reads window by window.
pub(super) trait BandSource {
    /// Fill `out` (row-major, `window.width * window.height`) with `window`,
    /// which lies inside the band.
    fn read(
        &mut self,
        window: RasterWindow,
        out: &mut [f32],
        cancel: &AtomicBool,
    ) -> Result<(), String>;
}

/// A band already in memory, row-major.
pub(super) struct SliceSource<'a> {
    pub samples: &'a [f32],
    pub width: u32,
}

impl BandSource for SliceSource<'_> {
    fn read(
        &mut self,
        window: RasterWindow,
        out: &mut [f32],
        _cancel: &AtomicBool,
    ) -> Result<(), String> {
        let (columns, width) = (window.width as usize, self.width as usize);
        for (row, target) in out.chunks_mut(columns).enumerate() {
            let start = (window.y as usize + row) * width + window.x as usize;
            target.copy_from_slice(&self.samples[start..start + columns]);
        }
        Ok(())
    }
}

impl<T: BandSource + ?Sized> BandSource for &mut T {
    fn read(
        &mut self,
        window: RasterWindow,
        out: &mut [f32],
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        (**self).read(window, out, cancel)
    }
}

impl<T: BandSource + ?Sized> BandSource for Box<T> {
    fn read(
        &mut self,
        window: RasterWindow,
        out: &mut [f32],
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        (**self).read(window, out, cancel)
    }
}

/// Each level of a file written level by level ([`write_levels`]): level 0
/// is the full resolution, level `k` the `k`-th overview.
pub(super) trait LevelSource {
    fn level(&mut self, index: u32) -> Result<Box<dyn BandSource + '_>, String>;
}

impl BandSource for tiff::BandReader {
    fn read(
        &mut self,
        window: RasterWindow,
        out: &mut [f32],
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        tiff::BandReader::read(self, window, out, cancel)
    }
}

/// Write the band `source` yields (`georef.grid` sized) to `path`, reading
/// at most `budget` cells of row windows at a time, and removing a partial
/// file on any failure.
pub(super) fn write(
    path: &Path,
    georef: CogGeoref<'_>,
    nodata: Option<f32>,
    source: &mut dyn BandSource,
    profile: CogProfile,
    budget: u64,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let levels = if profile.overviews {
        overview_count(u64::from(georef.grid.width), u64::from(georef.grid.height))
    } else {
        0
    };
    let written = write_inner(
        path,
        georef,
        nodata,
        Levels::Averaged(source),
        levels,
        profile.compression,
        budget,
        cancel,
    );
    if written.is_err() {
        let _ = std::fs::remove_file(path);
    }
    written
}

/// Write a file of `levels` overviews whose every level is read from its own
/// band of `sources` (level `k` is `georef.grid` halved `k` times, by floor
/// division), each in row windows of at most `budget` cells, removing a
/// partial file on any failure.
#[expect(
    clippy::too_many_arguments,
    reason = "ratcheted before 2.1-M188; group the arguments when this function next changes"
)]
pub(super) fn write_levels(
    path: &Path,
    georef: CogGeoref<'_>,
    nodata: Option<f32>,
    sources: &mut dyn LevelSource,
    levels: u32,
    compression: Compression,
    budget: u64,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let written = write_inner(
        path,
        georef,
        nodata,
        Levels::Each(sources),
        levels,
        compression,
        budget,
        cancel,
    );
    if written.is_err() {
        let _ = std::fs::remove_file(path);
    }
    written
}

/// Where a file's levels come from.
enum Levels<'s> {
    /// One band; each overview averaged from the level before it, read back
    /// from the file being written.
    Averaged(&'s mut dyn BandSource),
    /// Each level from its own band.
    Each(&'s mut dyn LevelSource),
}

/// The sizes of `levels` overviews below `width` × `height`, full
/// resolution first: each halves the one before by floor division.
pub(super) fn level_dims(width: u32, height: u32, levels: u32) -> Vec<(u32, u32)> {
    let mut dims = vec![(width, height)];
    let (mut width, mut height) = (width, height);
    for _ in 0..levels {
        width = (width / 2).max(1);
        height = (height / 2).max(1);
        dims.push((width, height));
    }
    dims
}

/// How many reduced-resolution levels [`write`] builds over a `width` ×
/// `height` base: one per halving while the longer side exceeds a tile. The
/// display lattice snaps to 2^levels by the same rule (`warp.rs`).
pub(super) fn overview_count(width: u64, height: u64) -> u32 {
    let (mut side, mut levels) = (width.max(height), 0);
    while side > u64::from(TILE) {
        side /= 2;
        levels += 1;
    }
    levels
}

#[expect(
    clippy::too_many_arguments,
    reason = "ratcheted before 2.1-M188; group the arguments when this function next changes"
)]
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn write_inner(
    path: &Path,
    georef: CogGeoref<'_>,
    nodata: Option<f32>,
    mut levels: Levels<'_>,
    overviews: u32,
    compression: Compression,
    budget: u64,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let grid = georef.grid;
    if grid.width == 0 || grid.height == 0 {
        return Err("cannot write an empty raster".to_string());
    }
    check_cancel(cancel)?;

    // Reduced-resolution levels, each half the size of the previous one.
    let level_dims = level_dims(grid.width, grid.height, overviews);

    // Directory sizes depend on tile counts only, so the directories can be
    // reserved at the front and filled in once every tile's placement is known.
    let geo_keys = georef.geo_keys.map(GeoKeyDirectory::encode);
    let nodata_text = nodata.map(|value| format!("{:?}", f64::from(value)));
    let mut directory_offsets = Vec::with_capacity(level_dims.len());
    let mut cursor = 8u64;
    for (index, (width, height)) in level_dims.iter().enumerate() {
        directory_offsets.push(cursor);
        let placeholder = directory(
            cursor,
            *width,
            *height,
            index > 0,
            &vec![0; tile_count(*width, *height)],
            &vec![0; tile_count(*width, *height)],
            0,
            compression,
            (index == 0).then_some(georef),
            geo_keys.as_ref().filter(|_| index == 0),
            nodata_text.as_deref(),
        );
        cursor += placeholder.len() as u64;
    }
    let data_start = cursor;

    let file =
        File::create(path).map_err(|e| format!("Failed to create {}: {e}", path.display()))?;
    let mut output = TileOutput {
        file: BufWriter::new(file),
        position: data_start,
        compression,
        pad: nodata.unwrap_or(0.0),
        tile: vec![0.0; (TILE * TILE) as usize],
    };
    output
        .file
        .write_all(&vec![0u8; data_start as usize])
        .map_err(|e| format!("Failed to reserve the raster directory: {e}"))?;

    // Tile data: full resolution first, then each overview, either from its
    // own band or halved from the level before it as read back from this file.
    let mut placements: Vec<(Vec<u32>, Vec<u32>)> = Vec::with_capacity(level_dims.len());
    for index in 0..level_dims.len() {
        let placed = match &mut levels {
            Levels::Each(sources) => {
                let mut band = sources.level(index as u32)?;
                output.level(&mut band, level_dims[index], budget, cancel)?
            }
            Levels::Averaged(source) if index == 0 => {
                output.level(*source, level_dims[0], budget, cancel)?
            }
            Levels::Averaged(_) => {
                output
                    .file
                    .flush()
                    .map_err(|e| format!("Failed to flush the raster: {e}"))?;
                let (offsets, counts) = &placements[index - 1];
                let (source_width, source_height) = level_dims[index - 1];
                let mut written = tiff::BandReader::open(
                    path,
                    tiff::BandFormat {
                        width: source_width,
                        height: source_height,
                        format: SampleFormat::IeeeFloat,
                        bits: 32,
                        compression_tag: compression.tag_value(),
                        predictor: 1,
                        chunk_bands: 1,
                        byte_order: ByteOrder::LittleEndian,
                        layout: tiff::Layout::Tiles {
                            width: TILE,
                            height: TILE,
                            offsets: offsets.iter().map(|offset| u64::from(*offset)).collect(),
                            counts: counts.iter().map(|count| u64::from(*count)).collect(),
                        },
                    },
                    output.pad,
                )?;
                // Half the budget for the level's own windows, the rest for
                // the rows they are averaged from.
                let window_budget = budget / 2;
                let mut halved = Halved::new(
                    Box::new(&mut written),
                    (source_width, source_height),
                    nodata,
                    budget.saturating_sub(window_cells(level_dims[index], window_budget)),
                );
                output.level(&mut halved, level_dims[index], window_budget, cancel)?
            }
        };
        placements.push(placed);
    }
    output
        .file
        .flush()
        .map_err(|e| format!("Failed to flush the raster: {e}"))?;

    // Now the directories, with every tile placed.
    let mut file = output
        .file
        .into_inner()
        .map_err(|e| format!("Failed to finish the raster: {e}"))?;
    for (index, (width, height)) in level_dims.iter().enumerate() {
        let next = directory_offsets.get(index + 1).copied().unwrap_or(0);
        let (offsets, counts) = &placements[index];
        let bytes = directory(
            directory_offsets[index],
            *width,
            *height,
            index > 0,
            offsets,
            counts,
            next,
            compression,
            (index == 0).then_some(georef),
            geo_keys.as_ref().filter(|_| index == 0),
            nodata_text.as_deref(),
        );
        debug_assert_eq!(
            directory_offsets[index] + bytes.len() as u64,
            directory_offsets
                .get(index + 1)
                .copied()
                .unwrap_or(data_start)
        );
        file.seek(SeekFrom::Start(directory_offsets[index]))
            .and_then(|_| file.write_all(&bytes))
            .map_err(|e| format!("Failed to write the raster directory: {e}"))?;
    }
    file.seek(SeekFrom::Start(0))
        .and_then(|_| file.write_all(&header(directory_offsets[0])))
        .map_err(|e| format!("Failed to write the raster header: {e}"))?;
    file.flush()
        .map_err(|e| format!("Failed to flush the raster: {e}"))
}

/// Tiles per row window: as many as `budget` cells hold, at least one.
fn window_tiles(width: u32, budget: u64) -> u32 {
    let fit = (budget / u64::from(TILE * TILE)).clamp(1, u64::from(u32::MAX)) as u32;
    fit.min(width.div_ceil(TILE))
}

/// Cells of the largest row window a level of `dims` reads under `budget`.
fn window_cells(dims: (u32, u32), budget: u64) -> u64 {
    let columns = (window_tiles(dims.0, budget) * TILE).min(dims.0);
    u64::from(columns) * u64::from(TILE.min(dims.1))
}

/// The tile stream after the reserved directories.
struct TileOutput {
    file: BufWriter<File>,
    position: u64,
    compression: Compression,
    pad: f32,
    tile: Vec<f32>,
}

impl TileOutput {
    /// Write one level's tiles in row-major order from row windows of
    /// whole tiles, returning their offsets and byte counts.
    fn level(
        &mut self,
        source: &mut dyn BandSource,
        (width, height): (u32, u32),
        budget: u64,
        cancel: &AtomicBool,
    ) -> Result<(Vec<u32>, Vec<u32>), String> {
        let tiles_x = width.div_ceil(TILE);
        let tiles_y = height.div_ceil(TILE);
        let run = window_tiles(width, budget);
        let capacity = window_cells((width, height), budget) as usize;
        let mut window = super::Cells::zeroed(capacity);
        let mut offsets = Vec::with_capacity((tiles_x * tiles_y) as usize);
        let mut counts = Vec::with_capacity((tiles_x * tiles_y) as usize);
        for tile_y in 0..tiles_y {
            check_cancel(cancel)?;
            let y = tile_y * TILE;
            let rows = TILE.min(height - y);
            for first in (0..tiles_x).step_by(run as usize) {
                let x = first * TILE;
                let columns = (run * TILE).min(width - x);
                let cells = (columns * rows) as usize;
                source.read(
                    RasterWindow {
                        x,
                        y,
                        width: columns,
                        height: rows,
                    },
                    &mut window[..cells],
                    cancel,
                )?;
                for tile_x in first..(first + run).min(tiles_x) {
                    let x0 = (tile_x - first) * TILE;
                    let tile_columns = TILE.min(columns - x0) as usize;
                    self.tile.fill(self.pad);
                    for row in 0..rows as usize {
                        let start = row * columns as usize + x0 as usize;
                        self.tile[row * TILE as usize..row * TILE as usize + tile_columns]
                            .copy_from_slice(&window[start..start + tile_columns]);
                    }
                    let (offset, count) = self.write_tile()?;
                    offsets.push(offset);
                    counts.push(count);
                }
            }
        }
        Ok((offsets, counts))
    }

    fn write_tile(&mut self) -> Result<(u32, u32), String> {
        let bytes: Vec<u8> = self
            .tile
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        let encoded = wbgeotiff::compression::compress(self.compression, &bytes)
            .map_err(|e| format!("Failed to compress a raster tile: {e}"))?;
        if self.position + encoded.len() as u64 > MAX_CLASSIC_BYTES {
            return Err("the raster exceeds the 4 GiB classic TIFF limit".to_string());
        }
        self.file
            .write_all(&encoded)
            .map_err(|e| format!("Failed to write a raster tile: {e}"))?;
        let placed = (self.position as u32, encoded.len() as u32);
        self.position += encoded.len() as u64;
        Ok(placed)
    }
}

fn tile_count(width: u32, height: u32) -> usize {
    (width.div_ceil(TILE) * height.div_ceil(TILE)) as usize
}

fn header(first_directory: u64) -> [u8; 8] {
    let mut bytes = [0u8; 8];
    bytes[..2].copy_from_slice(b"II");
    bytes[2..4].copy_from_slice(&42u16.to_le_bytes());
    bytes[4..].copy_from_slice(&(first_directory as u32).to_le_bytes());
    bytes
}

/// The next level of a band: each cell averages the valid samples of its
/// source block (floor-sized levels give some blocks a third row or column),
/// and a block with no valid sample stays NoData. Source rows are read in
/// windows of at most `budget` cells (at least one target row's). Halving a
/// band `k` times stacks `k` of them.
pub(super) struct Halved<'a> {
    source: Box<dyn BandSource + 'a>,
    width: u32,
    height: u32,
    target_width: u32,
    target_height: u32,
    nodata: Option<f32>,
    budget: u64,
}

impl<'a> Halved<'a> {
    /// The next level of the `width` × `height` band `source`.
    pub(super) fn new(
        source: Box<dyn BandSource + 'a>,
        (width, height): (u32, u32),
        nodata: Option<f32>,
        budget: u64,
    ) -> Self {
        Self {
            source,
            width,
            height,
            target_width: (width / 2).max(1),
            target_height: (height / 2).max(1),
            nodata,
            budget,
        }
    }

    /// Source rows (or columns) `start..end` averaged into target cell `at`.
    fn block(at: u32, source: u32, target: u32) -> (u32, u32) {
        let (at, source, target) = (u64::from(at), u64::from(source), u64::from(target));
        let start = at * source / target;
        let end = ((at + 1) * source / target).min(source).max(start + 1);
        (start as u32, end as u32)
    }
}

impl BandSource for Halved<'_> {
    fn read(
        &mut self,
        window: RasterWindow,
        out: &mut [f32],
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        let invalid = self.nodata.unwrap_or(f32::NAN);
        let (x0, _) = Self::block(window.x, self.width, self.target_width);
        let (_, x1) = Self::block(window.x + window.width - 1, self.width, self.target_width);
        let columns = (x1 - x0) as usize;
        // Runs of target rows whose source rows fit the budget, at least one
        // target row each, as (first, last, source y0, source y1).
        let end = window.y + window.height;
        let mut runs = Vec::new();
        let mut first = window.y;
        while first < end {
            let (y0, mut y1) = Self::block(first, self.height, self.target_height);
            let mut last = first + 1;
            while last < end {
                let (_, next) = Self::block(last, self.height, self.target_height);
                if u64::from(next - y0) * columns as u64 > self.budget {
                    break;
                }
                y1 = next;
                last += 1;
            }
            runs.push((first, last, y0, y1));
            first = last;
        }
        let largest = runs
            .iter()
            .map(|(_, _, y0, y1)| (y1 - y0) as usize * columns)
            .max()
            .unwrap_or(0);
        let mut rows = super::Cells::zeroed(largest);
        for (first, last, y0, y1) in runs {
            check_cancel(cancel)?;
            let cells = (y1 - y0) as usize * columns;
            self.source.read(
                RasterWindow {
                    x: x0,
                    y: y0,
                    width: x1 - x0,
                    height: y1 - y0,
                },
                &mut rows[..cells],
                cancel,
            )?;
            for target_y in first..last {
                let (sy0, sy1) = Self::block(target_y, self.height, self.target_height);
                let line = (target_y - window.y) as usize * window.width as usize;
                for column in 0..window.width {
                    let (sx0, sx1) = Self::block(window.x + column, self.width, self.target_width);
                    let mut sum = 0f64;
                    let mut count = 0u32;
                    for y in sy0..sy1 {
                        let row = (y - y0) as usize * columns;
                        for x in sx0..sx1 {
                            let value = rows[row + (x - x0) as usize];
                            if value.is_finite() && self.nodata.is_none_or(|marker| value != marker)
                            {
                                sum += f64::from(value);
                                count += 1;
                            }
                        }
                    }
                    out[line + column as usize] = if count > 0 {
                        (sum / f64::from(count)) as f32
                    } else {
                        invalid
                    };
                }
            }
        }
        Ok(())
    }
}

/// TIFF field types.
const SHORT: u16 = 3;
const LONG: u16 = 4;
const ASCII: u16 = 2;
const DOUBLE: u16 = 12;

struct Field {
    tag: u16,
    kind: u16,
    count: u32,
    payload: Vec<u8>,
}

fn shorts(tag: u16, values: &[u16]) -> Field {
    Field {
        tag,
        kind: SHORT,
        count: values.len() as u32,
        payload: values.iter().flat_map(|v| v.to_le_bytes()).collect(),
    }
}

fn longs(tag: u16, values: &[u32]) -> Field {
    Field {
        tag,
        kind: LONG,
        count: values.len() as u32,
        payload: values.iter().flat_map(|v| v.to_le_bytes()).collect(),
    }
}

fn doubles(tag: u16, values: &[f64]) -> Field {
    Field {
        tag,
        kind: DOUBLE,
        count: values.len() as u32,
        payload: values.iter().flat_map(|v| v.to_le_bytes()).collect(),
    }
}

fn ascii(tag: u16, text: &str) -> Field {
    let mut payload = text.as_bytes().to_vec();
    payload.push(0);
    Field {
        tag,
        kind: ASCII,
        count: payload.len() as u32,
        payload,
    }
}

/// One image file directory, serialised at `at` with its out-of-line values
/// right after it. Sizes depend on the counts alone, never on the values.
#[expect(
    clippy::too_many_arguments,
    reason = "ratcheted before 2.1-M188; group the arguments when this function next changes"
)]
fn directory(
    at: u64,
    width: u32,
    height: u32,
    reduced: bool,
    tile_offsets: &[u32],
    tile_counts: &[u32],
    next: u64,
    compression: Compression,
    georef: Option<CogGeoref<'_>>,
    geo_keys: Option<&(Vec<u16>, Vec<f64>, String)>,
    nodata: Option<&str>,
) -> Vec<u8> {
    let mut fields = Vec::new();
    if reduced {
        fields.push(longs(tag::NewSubFileType, &[1]));
    }
    fields.push(longs(tag::ImageWidth, &[width]));
    fields.push(longs(tag::ImageLength, &[height]));
    fields.push(shorts(tag::BitsPerSample, &[32]));
    fields.push(shorts(tag::Compression, &[compression.tag_value()]));
    fields.push(shorts(tag::PhotometricInterpretation, &[1]));
    fields.push(shorts(tag::SamplesPerPixel, &[1]));
    fields.push(shorts(tag::PlanarConfiguration, &[1]));
    fields.push(longs(tag::TileWidth, &[TILE]));
    fields.push(longs(tag::TileLength, &[TILE]));
    fields.push(longs(tag::TileOffsets, tile_offsets));
    fields.push(longs(tag::TileByteCounts, tile_counts));
    fields.push(shorts(tag::SampleFormat, &[3]));
    if let Some(georef) = georef {
        let gt = georef.grid.geotransform;
        fields.push(doubles(tag::ModelPixelScaleTag, &[gt[1], -gt[5], 0.0]));
        fields.push(doubles(
            tag::ModelTiepointTag,
            &[0.0, 0.0, 0.0, gt[0], gt[3], 0.0],
        ));
    }
    if let Some((words, values, text)) = geo_keys {
        fields.push(shorts(tag::GeoKeyDirectoryTag, words));
        if !values.is_empty() {
            fields.push(doubles(tag::GeoDoubleParamsTag, values));
        }
        if !text.is_empty() {
            fields.push(ascii(tag::GeoAsciiParamsTag, text));
        }
    }
    if let Some(nodata) = nodata {
        fields.push(ascii(tag::GdalNodata, nodata));
    }
    fields.sort_by_key(|field| field.tag);

    let entries_end = at + 2 + 12 * fields.len() as u64 + 4;
    let mut entries = Vec::with_capacity(2 + 12 * fields.len() + 4);
    let mut extra: Vec<u8> = Vec::new();
    entries.extend_from_slice(&(fields.len() as u16).to_le_bytes());
    for field in &fields {
        entries.extend_from_slice(&field.tag.to_le_bytes());
        entries.extend_from_slice(&field.kind.to_le_bytes());
        entries.extend_from_slice(&field.count.to_le_bytes());
        if field.payload.len() <= 4 {
            let mut inline = [0u8; 4];
            inline[..field.payload.len()].copy_from_slice(&field.payload);
            entries.extend_from_slice(&inline);
        } else {
            let offset = entries_end + extra.len() as u64;
            entries.extend_from_slice(&(offset as u32).to_le_bytes());
            extra.extend_from_slice(&field.payload);
            if extra.len() % 2 == 1 {
                extra.push(0);
            }
        }
    }
    entries.extend_from_slice(&(next as u32).to_le_bytes());
    entries.extend_from_slice(&extra);
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole next level of a `width`×`height` band.
    fn halve(source: &[f32], width: u32, height: u32, nodata: Option<f32>) -> Vec<f32> {
        let (target_width, target_height) = ((width / 2).max(1), (height / 2).max(1));
        let slice = SliceSource {
            samples: source,
            width,
        };
        let mut halved = Halved::new(Box::new(slice), (width, height), nodata, u64::MAX);
        let mut out = vec![0.0; (target_width * target_height) as usize];
        halved
            .read(
                RasterWindow {
                    x: 0,
                    y: 0,
                    width: target_width,
                    height: target_height,
                },
                &mut out,
                &AtomicBool::new(false),
            )
            .unwrap();
        out
    }

    #[test]
    fn halving_averages_valid_samples_only_and_keeps_holes() {
        let source = [1.0, 3.0, -9999.0, -9999.0, 5.0, 7.0, -9999.0, f32::NAN, 9.0];
        // Every valid sample of the 3×3 block, the sentinel and NaN excluded.
        assert_eq!(halve(&source, 3, 3, Some(-9999.0)), vec![5.0]);
        assert_eq!(halve(&[-9999.0; 4], 2, 2, Some(-9999.0)), vec![-9999.0]);
        assert!(halve(&[f32::NAN; 4], 2, 2, None)[0].is_nan());
    }

    #[test]
    fn level_sizes_follow_the_cog_driver() {
        let sizes = |width: u32, height: u32| {
            let mut dims = Vec::new();
            let (mut w, mut h) = (width, height);
            while w.max(h) > TILE {
                w = (w / 2).max(1);
                h = (h / 2).max(1);
                dims.push((w, h));
            }
            dims
        };
        assert_eq!(sizes(600, 400), vec![(300, 200), (150, 100)]);
        assert_eq!(sizes(513, 100), vec![(256, 50)]);
        assert_eq!(sizes(256, 256), vec![]);
        assert_eq!(
            sizes(4000, 3000),
            vec![(2000, 1500), (1000, 750), (500, 375), (250, 187)]
        );
    }

    #[test]
    fn directory_size_is_independent_of_its_values() {
        let grid = RasterGrid {
            width: 300,
            height: 260,
            geotransform: [0.0, 1.0, 0.0, 260.0, 0.0, -1.0],
        };
        let georef = CogGeoref {
            grid: &grid,
            geo_keys: None,
        };
        let zeros = vec![0u32; 4];
        let real = vec![u32::MAX; 4];
        let a = directory(
            8,
            300,
            260,
            false,
            &zeros,
            &zeros,
            0,
            Compression::Deflate,
            Some(georef),
            None,
            Some("-9999.0"),
        );
        let b = directory(
            8,
            300,
            260,
            false,
            &real,
            &real,
            999,
            Compression::Deflate,
            Some(georef),
            None,
            Some("-9999.0"),
        );
        assert_eq!(a.len(), b.len());
    }
}
