//! Bounded reads over an item's ordered source COGs and over analysis results.
//!
//! One resolver serves publication measurement, slope and inspection. It reads
//! only the window a caller asks for, maps signed lattice coordinates onto each
//! member's own grid, and composes topmost-valid: a higher-priority valid
//! sample wins and NoData reveals the one below. No union raster, no
//! absent-coordinate walk and no whole-extent buffer is created.

use super::catalogue;
use super::grid::RasterGrid;
use super::paths::LidarPaths;
use super::prepared_raster::{PreparedRaster, RasterWindow};
pub(super) use super::raster_assets::CogAsset;
use rusqlite::Connection;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};

/// Spatial chunk side shared by resolved generation and result storage.
pub(super) const CHUNK_SIDE: i64 = 1024;
/// Largest requested window side, matching the reader's halo allowance.
const MAX_WINDOW_SIDE: i64 = super::prepared_raster::MAX_HALO_SIDE as i64;
/// Catalogue role of a generation's resolved numeric chunks.
pub(super) const RESULT_ROLE: &str = "result";
/// Catalogue role of a result's separate 0/1 quality chunks.
pub(super) const QUALITY_ROLE: &str = "quality";

/// One source occurrence available for composition: a retained COG.
#[derive(Clone)]
pub(super) struct ResolvedMember {
    /// Composition order, bottom-most first.
    pub ordinal: i64,
    pub grid: RasterGrid,
    /// Effective validity rule for this occurrence's own samples.
    pub nodata: Option<f32>,
    pub cog: CogAsset,
}

/// A half-open window in signed lattice cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct LatticeWindow {
    pub x: i64,
    pub y: i64,
    pub width: u32,
    pub height: u32,
}

/// Resolved values and exact validity for one window.
#[derive(Debug)]
pub(super) struct ResolvedWindow {
    pub samples: Vec<f32>,
    pub valid: Vec<u8>,
}

/// Resolve one window over an ordered occurrence sequence.
pub(super) fn resolve_window(
    members: &[ResolvedMember],
    lattice: &RasterGrid,
    window: LatticeWindow,
    cancel: &AtomicBool,
) -> Result<ResolvedWindow, String> {
    let cells = validate_window(window)?;
    let width = window.width as usize;
    // The ordered sequence is a precondition: reject a misordered list before
    // reading anything rather than replaying part of it.
    let mut previous: Option<i64> = None;
    for member in members {
        if let Some(previous) = previous
            && member.ordinal < previous
        {
            return Err(format!(
                "member ordinal {} is out of order after {previous}",
                member.ordinal
            ));
        }
        previous = Some(member.ordinal);
    }
    let mut samples = vec![f32::NAN; cells];
    let mut valid = vec![0u8; cells];
    for member in members {
        check_cancel(cancel)?;
        let (offset_x, offset_y) = lattice_offset(lattice, &member.grid)?;
        // Member cell that corresponds to the window's first lattice cell.
        let member_x0 = window.x - offset_x;
        let member_y0 = window.y - offset_y;
        let member_x1 = member_x0 + i64::from(window.width);
        let member_y1 = member_y0 + i64::from(window.height);
        let clip_x0 = member_x0.max(0);
        let clip_y0 = member_y0.max(0);
        let clip_x1 = member_x1.min(i64::from(member.grid.width));
        let clip_y1 = member_y1.min(i64::from(member.grid.height));
        if clip_x0 >= clip_x1 || clip_y0 >= clip_y1 {
            continue;
        }
        let member_window = RasterWindow {
            x: clip_x0 as u32,
            y: clip_y0 as u32,
            width: (clip_x1 - clip_x0) as u32,
            height: (clip_y1 - clip_y0) as u32,
        };
        let dest_x = (clip_x0 + offset_x - window.x) as usize;
        let dest_y = (clip_y0 + offset_y - window.y) as usize;
        let (member_samples, member_valid) = read_member_window(member, member_window, cancel)?;
        for row in 0..member_window.height as usize {
            for column in 0..member_window.width as usize {
                let index = row * member_window.width as usize + column;
                if member_valid[index] == 0 {
                    // Invalid incoming samples never erase existing coverage.
                    continue;
                }
                // Members are visited bottom-most first, so a later valid
                // sample is the higher-priority one.
                let target = (dest_y + row) * width + dest_x + column;
                samples[target] = member_samples[index];
                valid[target] = 1;
            }
        }
    }
    check_cancel(cancel)?;
    Ok(ResolvedWindow { samples, valid })
}

/// Occupied spatial chunks of an ordered sequence, in chunk coordinates.
///
/// Only the chunks each occurrence actually covers are visited; the empty gap
/// between distant occurrences contributes nothing.
pub(super) fn occupied_chunks(
    members: &[ResolvedMember],
    lattice: &RasterGrid,
) -> Result<Vec<(i64, i64)>, String> {
    let mut chunks = BTreeSet::new();
    for member in members {
        let (offset_x, offset_y) = lattice_offset(lattice, &member.grid)?;
        let x0 = offset_x;
        let y0 = offset_y;
        let x1 = offset_x + i64::from(member.grid.width);
        let y1 = offset_y + i64::from(member.grid.height);
        if x0 >= x1 || y0 >= y1 {
            continue;
        }
        for chunk_y in y0.div_euclid(CHUNK_SIDE)..=(y1 - 1).div_euclid(CHUNK_SIDE) {
            for chunk_x in x0.div_euclid(CHUNK_SIDE)..=(x1 - 1).div_euclid(CHUNK_SIDE) {
                chunks.insert((chunk_x, chunk_y));
            }
        }
    }
    Ok(chunks.into_iter().collect())
}

/// One immutable ordered source collection, read in bounded windows.
///
/// A Data Layer is an ordered list of independently prepared source COGs; its
/// numeric value is the highest-priority valid sample at each location, and
/// NoData reveals a valid sample below. Nothing is materialized: display,
/// inspection and slope all resolve the same member list on demand, so a
/// snapshot costs member metadata rather than a merged elevation raster.
///
/// `members` is held in resolver iteration order — bottom-most first — so the
/// existing ordered replay applies one uniform "paint the valid samples"
/// rule and the highest-priority source wins by being painted last. The
/// top-first list the UI and transport show is this list reversed; that
/// conversion is internal and never persisted twice.
#[derive(Clone)]
pub(super) struct CollectionReader {
    members: Vec<ResolvedMember>,
    /// Stable occurrence identity of `members`, parallel to it.
    /// The layer's fixed lattice, which every member coordinate is relative to.
    lattice: RasterGrid,
}

impl CollectionReader {
    /// Bind one snapshot's top-first member list.
    pub(super) fn new(
        members: Vec<(String, ResolvedMember)>,
        lattice: RasterGrid,
    ) -> Result<Self, String> {
        let mut ordered = Vec::with_capacity(members.len());
        // Reverse into resolver iteration order and renumber the ordinals, so
        // the ascending-ordinal precondition holds: highest priority last.
        for (index, (_member_id, mut member)) in members.into_iter().rev().enumerate() {
            lattice.compatible(&member.grid)?;
            member.ordinal = i64::try_from(index).unwrap_or(i64::MAX);
            ordered.push(member);
        }
        Ok(Self {
            members: ordered,
            lattice,
        })
    }

    /// The occurrence list in resolver iteration order (bottom-most first).
    ///
    /// Slope reuses it so analysis reads the same composed window the display
    /// does, rather than a stack of independently computed per-file slopes.
    pub(super) fn resolved(&self) -> &[ResolvedMember] {
        &self.members
    }

    /// Occupied 1024-cell lattice chunks of the current composition.
    ///
    /// Arithmetic over member extents only: the empty space between separated
    /// sources never contributes, and no raster is opened.
    #[cfg(test)]
    pub(super) fn occupied_chunks(&self) -> Result<Vec<(i64, i64)>, String> {
        occupied_chunks(&self.members, &self.lattice)
    }

    /// Resolve one bounded window of the composed value.
    pub(super) fn read_window(
        &self,
        window: LatticeWindow,
        cancel: &AtomicBool,
    ) -> Result<ResolvedWindow, String> {
        resolve_window(&self.members, &self.lattice, window, cancel)
    }
}

/// How an immutable generation's numbers are read.
///
/// Source items read their ordered members; slope results read their
/// published chunks.
#[derive(Clone)]
pub(super) enum GenerationReader {
    /// Published result chunks of an analysis.
    Chunks(GenerationChunkReader),
    /// An ordered source collection resolved on demand.
    Collection(Box<CollectionReader>),
}

impl GenerationReader {
    pub(super) fn read_window(
        &self,
        library: &super::LidarLibrary,
        window: LatticeWindow,
        cancel: &AtomicBool,
    ) -> Result<ResolvedWindow, String> {
        match self {
            Self::Chunks(owner) => owner.read_window(library, window, cancel),
            Self::Collection(collection) => collection.read_window(window, cancel),
        }
    }
}

/// The lattice grid of one chunk, clipped to the chunk's full square.
pub(super) fn chunk_grid(lattice: &RasterGrid, chunk_x: i64, chunk_y: i64) -> RasterGrid {
    RasterGrid {
        width: CHUNK_SIDE as u32,
        height: CHUNK_SIDE as u32,
        geotransform: [
            lattice.geotransform[0] + chunk_x as f64 * CHUNK_SIDE as f64 * lattice.geotransform[1],
            lattice.geotransform[1],
            0.0,
            lattice.geotransform[3] + chunk_y as f64 * CHUNK_SIDE as f64 * lattice.geotransform[5],
            0.0,
            lattice.geotransform[5],
        ],
    }
}

/// Values and validity for one member window.
fn read_member_window(
    member: &ResolvedMember,
    window: RasterWindow,
    cancel: &AtomicBool,
) -> Result<(Vec<f32>, Vec<u8>), String> {
    let mut reader =
        PreparedRaster::open_committed(&member.cog.path, &member.cog.grid, member.nodata)?;
    let read = reader.read_window(window, cancel)?;
    Ok((read.samples().to_vec(), read.valid().to_vec()))
}

/// One persisted resolved-chunk reference the reader can select.
#[derive(Debug, Clone)]
pub(super) struct PersistedChunk {
    pub chunk_x: i64,
    pub chunk_y: i64,
    pub asset: CogAsset,
    pub nodata: Option<f32>,
}

/// Test support: publish one synthetic chunk record with its own committed COG
/// plus the catalogue rows a reader resolves it from.
///
/// Shared by the generation and tile test modules so both exercise the same
/// published shape.
#[cfg(test)]
pub(super) fn publish_test_chunk(
    library: &super::LidarLibrary,
    generation_id: &str,
    chunk_x: i64,
    chunk_y: i64,
    width: u32,
    height: u32,
    values: &[f32],
) -> CogAsset {
    let engine = library.inner.engine.as_ref();
    let paths = &library.inner.paths;
    let dir = paths.root().to_path_buf();
    let grid = RasterGrid {
        width,
        height,
        geotransform: [0.0, 1.0, 0.0, 0.0, 0.0, -1.0],
    };
    let asset = crate::services::lidar::raster_assets::write_cog_asset(
        engine,
        &AtomicBool::new(false),
        paths,
        &dir,
        &format!("chunk-{}-{}-{}", generation_id, chunk_x, chunk_y),
        &grid,
        "EPSG:3857",
        Some(f32::NAN),
        values,
    )
    .expect("test chunk COG is created");
    let (valid_cells, sum_value) = values
        .iter()
        .filter(|value| value.is_finite())
        .fold((0i64, 0.0f64), |(count, sum), value| {
            (count + 1, sum + f64::from(*value))
        });
    let connection = library.catalogue().unwrap();
    super::catalogue::insert_raster_asset(
        &connection,
        &asset_row(paths, &asset, "EPSG:3857").unwrap(),
    )
    .unwrap();
    super::catalogue::insert_unpublished_chunks(
        &connection,
        generation_id,
        &[super::catalogue::GenerationChunkRow {
            role: RESULT_ROLE.to_string(),
            chunk_x,
            chunk_y,
            asset_sha256: asset.sha256.clone(),
            valid_cells,
            min_value: 0.0,
            max_value: 0.0,
            sum_value,
        }],
    )
    .unwrap();
    super::catalogue::publish_generation_chunks(&connection, generation_id).unwrap();
    asset
}

/// Read one window from persisted resolved chunks.
///
/// This is the published-generation read path: it never replays member
/// history, never opens a source COG and never touches a coordinate without a
/// chunk row. Absent chunks are invalid coverage; a corrupt asset is an error,
/// not empty coverage. Tests use it to check what analysis published.
#[cfg(test)]
pub(super) fn read_persisted_window(
    chunks: &[PersistedChunk],
    window: LatticeWindow,
    cancel: &AtomicBool,
) -> Result<ResolvedWindow, String> {
    let cells = validate_window(window)?;
    let mut samples = vec![f32::NAN; cells];
    let mut valid = vec![0u8; cells];
    read_chunk_records(chunks, window, cancel, &mut samples, &mut valid)?;
    Ok(ResolvedWindow { samples, valid })
}

/// Read the intersecting portion of each given record into an existing buffer.
///
/// Records are addressed directly instead of scanning the window's chunk
/// range, so the cost is what the caller actually supplied.
fn read_chunk_records(
    chunks: &[PersistedChunk],
    window: LatticeWindow,
    cancel: &AtomicBool,
    samples: &mut [f32],
    valid: &mut [u8],
) -> Result<(), String> {
    let width = window.width as usize;
    let end_x = window
        .x
        .checked_add(i64::from(window.width))
        .ok_or_else(|| "chunk read window overflows".to_string())?;
    let end_y = window
        .y
        .checked_add(i64::from(window.height))
        .ok_or_else(|| "chunk read window overflows".to_string())?;
    for chunk in chunks {
        check_cancel(cancel)?;
        let chunk_origin_x = chunk
            .chunk_x
            .checked_mul(CHUNK_SIDE)
            .ok_or_else(|| "chunk origin overflows".to_string())?;
        let chunk_origin_y = chunk
            .chunk_y
            .checked_mul(CHUNK_SIDE)
            .ok_or_else(|| "chunk origin overflows".to_string())?;
        let chunk_end_x = chunk_origin_x
            .checked_add(i64::from(chunk.asset.grid.width))
            .ok_or_else(|| "chunk extent overflows".to_string())?;
        let chunk_end_y = chunk_origin_y
            .checked_add(i64::from(chunk.asset.grid.height))
            .ok_or_else(|| "chunk extent overflows".to_string())?;
        // Exact signed overlap: a record that does not intersect contributes
        // nothing and is never opened.
        if chunk_end_x <= window.x
            || chunk_origin_x >= end_x
            || chunk_end_y <= window.y
            || chunk_origin_y >= end_y
        {
            continue;
        }
        let clip_x0 = (window.x - chunk_origin_x).max(0);
        let clip_y0 = (window.y - chunk_origin_y).max(0);
        let clip_x1 = (end_x - chunk_origin_x).min(i64::from(chunk.asset.grid.width));
        let clip_y1 = (end_y - chunk_origin_y).min(i64::from(chunk.asset.grid.height));
        if clip_x0 >= clip_x1 || clip_y0 >= clip_y1 {
            continue;
        }
        let member_window = RasterWindow {
            x: clip_x0 as u32,
            y: clip_y0 as u32,
            width: (clip_x1 - clip_x0) as u32,
            height: (clip_y1 - clip_y0) as u32,
        };
        let mut reader =
            PreparedRaster::open_committed(&chunk.asset.path, &chunk.asset.grid, chunk.nodata)?;
        let read = reader.read_window(member_window, cancel)?;
        let dest_x = (clip_x0 + chunk_origin_x - window.x) as usize;
        let dest_y = (clip_y0 + chunk_origin_y - window.y) as usize;
        for row in 0..member_window.height as usize {
            for column in 0..member_window.width as usize {
                let index = row * member_window.width as usize + column;
                if read.valid()[index] == 0 {
                    continue;
                }
                let target = (dest_y + row) * width + dest_x + column;
                samples[target] = read.samples()[index];
                valid[target] = 1;
            }
        }
    }
    check_cancel(cancel)?;
    Ok(())
}

/// Maximum chunk records one catalogue page returns.
///
/// The page is the unit of catalogue work: a reader never loads a whole
/// generation's records to answer a window or a reduction.
pub(super) const CHUNK_PAGE_MAX: usize = 256;

/// One immutable generation and role, bound for paged reads.
///
/// The owner holds no catalogue lock and no record list: every page is fetched
/// in its own short catalogue read, the lock is released, and only then is a
/// committed asset opened. A read therefore costs what its window intersects
/// rather than what the whole generation stores.
#[derive(Debug, Clone)]
pub(super) struct GenerationChunkReader {
    generation_id: String,
    role: String,
}

impl GenerationChunkReader {
    pub(super) fn new(generation_id: &str, role: &str) -> Self {
        Self {
            generation_id: generation_id.to_string(),
            role: role.to_string(),
        }
    }

    /// One page of records intersecting `window`, or the whole generation when
    /// no window is given. The catalogue lock is held only for this query.
    pub(super) fn page(
        &self,
        library: &super::LidarLibrary,
        window: Option<LatticeWindow>,
        after: Option<(i64, i64)>,
    ) -> Result<Vec<PersistedChunk>, String> {
        let filter = match window {
            Some(window) => Some(chunk_window(window)?),
            None => None,
        };
        let rows = {
            let connection = library.catalogue()?;
            super::catalogue::generation_chunk_page(
                &connection,
                &self.generation_id,
                &self.role,
                filter,
                after,
                CHUNK_PAGE_MAX,
            )?
        };
        let mut chunks = Vec::with_capacity(rows.len());
        for row in rows {
            chunks.push(persisted_chunk(&library.inner.paths, row)?);
        }
        Ok(chunks)
    }

    /// Read one window, page by page, opening only intersecting records.
    pub(super) fn read_window(
        &self,
        library: &super::LidarLibrary,
        window: LatticeWindow,
        cancel: &AtomicBool,
    ) -> Result<ResolvedWindow, String> {
        let cells = validate_window(window)?;
        let mut samples = vec![f32::NAN; cells];
        let mut valid = vec![0u8; cells];
        let mut cursor = None;
        loop {
            check_cancel(cancel)?;
            let page = self.page(library, Some(window), cursor)?;
            if page.is_empty() {
                break;
            }
            let returned = page.len();
            cursor = page.last().map(|chunk| (chunk.chunk_y, chunk.chunk_x));
            read_chunk_records(&page, window, cancel, &mut samples, &mut valid)?;
            if returned < CHUNK_PAGE_MAX {
                break;
            }
        }
        check_cancel(cancel)?;
        Ok(ResolvedWindow { samples, valid })
    }
}

/// Chunk-coordinate bounds of one lattice-cell window, exactly and checked.
fn chunk_window(window: LatticeWindow) -> Result<super::catalogue::ChunkWindow, String> {
    let end_x = window
        .x
        .checked_add(i64::from(window.width))
        .ok_or_else(|| "chunk read window overflows".to_string())?;
    let end_y = window
        .y
        .checked_add(i64::from(window.height))
        .ok_or_else(|| "chunk read window overflows".to_string())?;
    super::catalogue::ChunkWindow::for_cells(window.x, end_x, window.y, end_y, CHUNK_SIDE)
}

/// Resolve one catalogue row into its readable record.
fn persisted_chunk(
    paths: &super::paths::LidarPaths,
    row: super::catalogue::ChunkAssetRow,
) -> Result<PersistedChunk, String> {
    let asset = cog_from_row(paths, &row.asset)?;
    Ok(PersistedChunk {
        chunk_x: row.chunk_x,
        chunk_y: row.chunk_y,
        nodata: asset.nodata,
        asset,
    })
}

/// Read one window of a sparse 0/1 quality mask.
///
/// Absent quality chunks mean quality zero, and a present chunk must hold
/// exact 0/1 samples: a corrupt mask can never read as partial coverage. The
/// returned validity is complete, because quality zero is a value, not a gap.
/// Tests use it to check the quality mask analysis published.
#[cfg(test)]
pub(super) fn read_quality_chunks_window(
    chunks: &[PersistedChunk],
    window: LatticeWindow,
    cancel: &AtomicBool,
) -> Result<ResolvedWindow, String> {
    let resolved = read_persisted_window(chunks, window, cancel)?;
    let mut samples = vec![0f32; resolved.samples.len()];
    for (index, value) in resolved.samples.iter().enumerate() {
        if resolved.valid[index] == 0 {
            continue;
        }
        samples[index] = match *value {
            0.0 => 0.0,
            1.0 => 1.0,
            other => {
                return Err(format!(
                    "quality chunk holds {other} at cell {index}, expected exact 0 or 1"
                ));
            }
        };
    }
    Ok(ResolvedWindow {
        samples,
        valid: vec![1u8; resolved.valid.len()],
    })
}

/// Per-block aggregate of one interpretation's occupied coverage.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct RegionAggregate {
    pub block_x: i64,
    pub block_y: i64,
    pub valid_cells: i64,
    pub min_value: f64,
    pub max_value: f64,
    pub sum_value: f64,
}

/// Lattice cells from the layer anchor to a member grid's first cell.
pub(super) fn lattice_offset(
    lattice: &RasterGrid,
    grid: &RasterGrid,
) -> Result<(i64, i64), String> {
    lattice.compatible(grid)?;
    let pixel_x = lattice.geotransform[1];
    let pixel_y = lattice.geotransform[5].abs();
    if pixel_x <= 0.0 || pixel_y <= 0.0 {
        return Err("layer lattice has a degenerate pixel size".to_string());
    }
    let offset_x = (grid.geotransform[0] - lattice.geotransform[0]) / pixel_x;
    let offset_y = (lattice.geotransform[3] - grid.geotransform[3]) / pixel_y;
    if !offset_x.is_finite() || !offset_y.is_finite() {
        return Err("member grid offset is not representable".to_string());
    }
    Ok((offset_x.round() as i64, offset_y.round() as i64))
}

pub(super) fn window_grid(
    lattice: &RasterGrid,
    window: LatticeWindow,
) -> Result<RasterGrid, String> {
    let origin_x = lattice.geotransform[0] + window.x as f64 * lattice.geotransform[1];
    let origin_y = lattice.geotransform[3] + window.y as f64 * lattice.geotransform[5];
    if !origin_x.is_finite() || !origin_y.is_finite() {
        return Err("window origin is not representable".to_string());
    }
    Ok(RasterGrid {
        width: window.width,
        height: window.height,
        geotransform: [
            origin_x,
            lattice.geotransform[1],
            0.0,
            origin_y,
            0.0,
            lattice.geotransform[5],
        ],
    })
}

fn validate_window(window: LatticeWindow) -> Result<usize, String> {
    if window.width == 0 || window.height == 0 {
        return Err("lattice window must not be empty".to_string());
    }
    if i64::from(window.width) > MAX_WINDOW_SIDE || i64::from(window.height) > MAX_WINDOW_SIDE {
        return Err(format!(
            "lattice window {}x{} exceeds the {MAX_WINDOW_SIDE}x{MAX_WINDOW_SIDE} window cap",
            window.width, window.height
        ));
    }
    usize::try_from(u64::from(window.width) * u64::from(window.height))
        .map_err(|_| "lattice window is too large for this platform".to_string())
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".to_string());
    }
    Ok(())
}

/// Resolve one catalogue asset row into a readable, non-deleting COG handle.
pub(super) fn cog_from_row(
    paths: &LidarPaths,
    row: &catalogue::RasterAssetRow,
) -> Result<CogAsset, String> {
    let grid = RasterGrid {
        width: u32::try_from(row.width)
            .map_err(|_| format!("asset {} has a negative width", row.sha256))?,
        height: u32::try_from(row.height)
            .map_err(|_| format!("asset {} has a negative height", row.sha256))?,
        geotransform: super::import::parse_geotransform(&row.geotransform)?,
    };
    Ok(CogAsset {
        sha256: row.sha256.clone(),
        path: paths.root().join(&row.rel_path),
        bytes: u64::try_from(row.bytes).unwrap_or(0),
        grid,
        nodata: row.nodata.map(|value| value as f32),
    })
}

/// Record one created asset so chunk rows may reference its digest.
pub(super) fn asset_row(
    paths: &LidarPaths,
    asset: &CogAsset,
    crs_ref: &str,
) -> Result<catalogue::RasterAssetRow, String> {
    let rel_path = asset
        .path
        .strip_prefix(paths.root())
        .map_err(|_| format!("asset {} is outside the library root", asset.path.display()))?
        .to_string_lossy()
        .into_owned();
    Ok(catalogue::RasterAssetRow {
        sha256: asset.sha256.clone(),
        rel_path,
        bytes: i64::try_from(asset.bytes).unwrap_or(i64::MAX),
        profile: super::raster_assets::COG_PROFILE.to_string(),
        width: i64::from(asset.grid.width),
        height: i64::from(asset.grid.height),
        geotransform: super::import::format_geotransform(asset.grid.geotransform),
        crs_ref: crs_ref.to_string(),
        nodata: asset.nodata.map(f64::from),
    })
}

/// Published resolved chunks of one generation and role, ready for the read
/// path. Absent chunks stay invalid coverage.
///
/// Test oracle only: every production reader binds a `GenerationChunkReader`
/// and fetches bounded pages, so no caller materializes a whole generation's
/// records.
#[cfg(test)]
pub(super) fn persisted_chunks(
    connection: &Connection,
    paths: &LidarPaths,
    generation_id: &str,
    role: &str,
) -> Result<Vec<PersistedChunk>, String> {
    let rows = catalogue::generation_chunk_assets(connection, generation_id, role)?;
    let mut chunks = Vec::with_capacity(rows.len());
    for row in rows {
        let asset = cog_from_row(paths, &row.asset)?;
        chunks.push(PersistedChunk {
            chunk_x: row.chunk_x,
            chunk_y: row.chunk_y,
            nodata: asset.nodata,
            asset,
        });
    }
    Ok(chunks)
}

/// The retained standard COG of one prepared interpretation, when present.
pub(super) fn retained_cog(
    connection: &Connection,
    paths: &LidarPaths,
    interpretation_id: &str,
) -> Result<Option<(CogAsset, Option<f32>)>, String> {
    match catalogue::interpretation_cog(connection, interpretation_id)? {
        Some((row, nodata)) => Ok(Some((
            cog_from_row(paths, &row)?,
            nodata.map(|value| value as f32),
        ))),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::lidar::engine::RasterEngine;
    use crate::services::lidar::paths::LidarPaths;
    use crate::services::lidar::raster_assets::write_cog_asset;
    use std::path::{Path, PathBuf};

    fn cancellation() -> AtomicBool {
        AtomicBool::new(false)
    }

    fn scratch(label: &str) -> crate::test_scratch::TestScratch {
        crate::test_scratch::TestScratch::new(&format!("resolver-{label}"))
    }

    fn lattice() -> RasterGrid {
        RasterGrid {
            width: 1,
            height: 1,
            geotransform: [0.0, 1.0, 0.0, 0.0, 0.0, -1.0],
        }
    }

    /// A member whose origin sits `x`/`y` lattice cells from the anchor; `y`
    /// grows downward, so a negative `y` places it above the anchor.
    fn member_grid(x: i64, y: i64, width: u32, height: u32) -> RasterGrid {
        RasterGrid {
            width,
            height,
            geotransform: [x as f64, 1.0, 0.0, -(y as f64), 0.0, -1.0],
        }
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "ratcheted before 2.1-M188; group the arguments when this function next changes"
    )]
    fn cog_member(
        engine: &dyn RasterEngine,
        paths: &LidarPaths,
        dir: &Path,
        name: &str,
        x: i64,
        y: i64,
        width: u32,
        height: u32,
        value: f32,
        hole: Option<(u32, u32)>,
    ) -> ResolvedMember {
        let grid = member_grid(x, y, width, height);
        let mut values = vec![value; (width * height) as usize];
        if let Some((hx, hy)) = hole {
            values[(hy * width + hx) as usize] = f32::NAN;
        }
        let asset = write_cog_asset(
            engine,
            &cancellation(),
            paths,
            dir,
            name,
            &grid,
            "EPSG:3857",
            Some(f32::NAN),
            &values,
        )
        .expect("member COG is created");
        ResolvedMember {
            ordinal: 0,
            grid,
            nodata: Some(f32::NAN),
            cog: asset,
        }
    }

    /// A member whose file is never opened: validation and chunk planning
    /// happen before any read.
    fn unread_member(grid: RasterGrid) -> ResolvedMember {
        ResolvedMember {
            ordinal: 0,
            grid: grid.clone(),
            nodata: None,
            cog: CogAsset {
                sha256: String::new(),
                path: PathBuf::new(),
                bytes: 0,
                grid,
                nodata: None,
            },
        }
    }

    fn full_window(x: i64, y: i64, width: u32, height: u32) -> LatticeWindow {
        LatticeWindow {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn members_above_and_left_of_the_anchor_resolve_signed_lattice_cells() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let dir = scratch("negative");
        let paths = LidarPaths::open(&dir).unwrap();
        let lattice = lattice();
        // Two cells up and two cells left of the anchor.
        let mut upper = cog_member(&engine, &paths, &dir, "upper", -2, -2, 2, 2, 11.0, None);
        upper.ordinal = 0;
        let window = full_window(-2, -2, 4, 4);
        let resolved = resolve_window(&[upper.clone()], &lattice, window, &cancellation()).unwrap();
        let window_grid = window_grid(&lattice, window).unwrap();
        assert_eq!(window_grid.geotransform[0], -2.0);
        assert_eq!(window_grid.geotransform[3], 2.0);
        assert_eq!(
            resolved.valid,
            vec![1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        );
        assert_eq!(resolved.samples[0], 11.0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn occupied_chunks_skip_the_gap_between_distant_members() {
        let lattice = lattice();
        let mut first = unread_member(member_grid(0, 0, 4, 3));
        let mut second = first.clone();
        second.ordinal = 1;
        // One million cells to the right, far outside the first member's chunk.
        second.grid = member_grid(1_000_000, 0, 4, 3);
        let adjacent = occupied_chunks(&[first.clone()], &lattice).unwrap();
        let distant = occupied_chunks(&[first.clone(), second], &lattice).unwrap();
        assert_eq!(adjacent.len(), 1);
        assert_eq!(distant.len(), 2, "only occupied chunks are enumerated");
        // A member straddling a chunk edge occupies both of its chunks.
        first.grid = member_grid(1023, 0, 4, 3);
        let straddling = occupied_chunks(&[first], &lattice).unwrap();
        assert_eq!(straddling, vec![(0, 0), (1, 0)]);
    }

    #[test]
    fn windows_and_ordinals_are_validated_before_reading() {
        let lattice = lattice();
        let member = unread_member(member_grid(0, 0, 2, 2));
        let error = resolve_window(
            std::slice::from_ref(&member),
            &lattice,
            full_window(0, 0, 0, 4),
            &cancellation(),
        )
        .expect_err("empty windows are rejected");
        assert!(error.contains("must not be empty"), "{error}");

        let error = resolve_window(
            std::slice::from_ref(&member),
            &lattice,
            full_window(0, 0, MAX_WINDOW_SIDE as u32 + 1, 1),
            &cancellation(),
        )
        .expect_err("oversized windows are rejected");
        assert!(error.contains("window cap"), "{error}");

        let mut later = member.clone();
        later.ordinal = 5;
        let error = resolve_window(
            &[later, member.clone()],
            &lattice,
            full_window(0, 0, 1, 1),
            &cancellation(),
        )
        .expect_err("ordinal order is enforced");
        assert!(error.contains("out of order"), "{error}");

        let misaligned = ResolvedMember {
            grid: RasterGrid {
                width: 2,
                height: 2,
                geotransform: [0.5, 1.0, 0.0, 0.0, 0.0, -1.0],
            },
            ..member.clone()
        };
        let error = resolve_window(
            &[misaligned],
            &lattice,
            full_window(0, 0, 1, 1),
            &cancellation(),
        )
        .expect_err("unaligned member grids are rejected");
        assert!(error.contains("aligned"), "{error}");
    }

    #[test]
    fn ordered_collection_resolves_topmost_valid_without_materializing_anything() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let dir = scratch("ordered-collection");
        let registry = LidarPaths::open(&dir).unwrap();
        let lattice = lattice();
        let grid = member_grid(0, 0, 3, 1);

        // Bottom A = [10,20,30]; top B = [100,NoData,0] on the same three
        // cells. NoData reveals the valid sample below, and a valid zero and a
        // valid negative both survive: neither is treated as absence.
        let author = |name: &str, nodata: f32, values: &[f32]| {
            let asset = write_cog_asset(
                &engine,
                &cancellation(),
                &registry,
                &dir,
                name,
                &grid,
                "EPSG:3857",
                Some(nodata),
                values,
            )
            .expect("member COG is created");
            ResolvedMember {
                ordinal: 0,
                grid: grid.clone(),
                nodata: Some(nodata),
                cog: asset,
            }
        };
        let bottom = author("bottom", f32::NAN, &[10.0, 20.0, 30.0]);
        let top = author("top", f32::NAN, &[100.0, f32::NAN, 0.0]);

        // The reader is built from a top-first list, exactly as the UI and the
        // transport present it.
        let top_first = |first: &ResolvedMember, second: &ResolvedMember| {
            CollectionReader::new(
                vec![
                    ("first".to_string(), first.clone()),
                    ("second".to_string(), second.clone()),
                ],
                lattice.clone(),
            )
            .unwrap()
        };
        let window = LatticeWindow {
            x: 0,
            y: 0,
            width: 3,
            height: 1,
        };
        let resolved = top_first(&top, &bottom)
            .read_window(window, &cancellation())
            .unwrap();
        assert_eq!(resolved.samples, vec![100.0, 20.0, 0.0]);
        assert_eq!(resolved.valid, vec![1, 1, 1]);

        // The list order is the priority: the other order composes differently.
        let swapped = top_first(&bottom, &top)
            .read_window(window, &cancellation())
            .unwrap();
        assert_eq!(swapped.samples, vec![10.0, 20.0, 30.0]);
        assert!(swapped.valid.iter().all(|valid| *valid == 1));

        // No composed raster exists anywhere: the composition is resolved from
        // the retained source COGs.
        let reader = top_first(&top, &bottom);
        assert_eq!(reader.occupied_chunks().unwrap(), vec![(0, 0)]);
        assert_eq!(reader.resolved().len(), 2);
        let composed: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("gen") || name.contains("chunk"))
            .collect();
        assert!(
            composed.is_empty(),
            "an ordered composition materializes nothing: {composed:?}"
        );

        // A distant second member adds only its own occupied chunk, so the empty
        // gap contributes neither work nor coverage.
        let far = cog_member(
            &engine, &registry, &dir, "far", 1_000_000, 0, 4, 3, 2.0, None,
        );
        let sparse =
            CollectionReader::new(vec![("far".to_string(), far)], lattice.clone()).unwrap();
        assert_eq!(sparse.occupied_chunks().unwrap(), vec![(976, 0)]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn persisted_chunks_are_read_directly_and_absent_chunks_are_invalid() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let dir = scratch("persisted");
        let paths = LidarPaths::open(&dir).unwrap();
        let lattice = lattice();
        let chunk_side = CHUNK_SIDE as u32;
        let mut chunks = Vec::new();
        for (chunk_x, value) in [(0i64, 1.0f32), (2i64, 3.0f32)] {
            let grid = chunk_grid(&lattice, chunk_x, 0);
            let values = vec![value; (chunk_side * chunk_side) as usize];
            let asset = write_cog_asset(
                &engine,
                &cancellation(),
                &paths,
                &dir,
                &format!("chunk-{chunk_x}"),
                &grid,
                "EPSG:3857",
                Some(f32::NAN),
                &values,
            )
            .unwrap();
            chunks.push(PersistedChunk {
                chunk_x,
                chunk_y: 0,
                asset,
                nodata: Some(f32::NAN),
            });
        }

        // A window inside the first chunk.
        let first =
            read_persisted_window(&chunks, full_window(0, 0, 4, 3), &cancellation()).unwrap();
        assert_eq!(first.valid, vec![1; 12]);
        assert!(first.samples.iter().all(|value| *value == 1.0));

        // The gap between chunk 0 and chunk 2 has no row: exact invalid mask,
        // and no member replay or absent-coordinate walk produces coverage.
        let gap =
            read_persisted_window(&chunks, full_window(1024, 0, 4, 3), &cancellation()).unwrap();
        assert!(gap.valid.iter().all(|valid| *valid == 0));
        assert!(gap.samples.iter().all(|value| value.is_nan()));

        // The distant chunk reads its own persisted bytes.
        let far = read_persisted_window(
            &chunks,
            full_window(2 * CHUNK_SIDE, 0, 4, 3),
            &cancellation(),
        )
        .unwrap();
        assert!(far.samples.iter().all(|value| *value == 3.0));

        // A truncated asset is an error, never empty coverage.
        let corrupted = chunks.clone();
        let path = corrupted[0].asset.path.clone();
        let bytes = std::fs::read(&path).unwrap();
        std::fs::write(&path, &bytes[..bytes.len() / 2]).unwrap();
        let error = read_persisted_window(&corrupted, full_window(0, 0, 4, 3), &cancellation())
            .expect_err("a corrupt chunk must fail the read");
        assert!(!error.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    // -----------------------------------------------------------------------
    // BG3/BG2: paged generation reads and complete reduction footprints
    // -----------------------------------------------------------------------

    fn constant_chunk(value: f32) -> Vec<f32> {
        vec![value; 4 * 4]
    }

    /// A record whose committed file is gone stays an error, and a small window
    /// never opens the records it does not intersect.
    #[test]
    fn unrelated_records_are_never_opened_for_a_small_window() {
        let dir = scratch("paged-window");
        let library = crate::services::lidar::LidarLibrary::open(&dir).unwrap();
        publish_test_chunk(&library, "generation-c", 0, 0, 4, 4, &constant_chunk(7.0));
        // A record far away whose file is removed: a reader that visited it
        // would fail instead of returning the window it was asked for.
        let unwanted =
            publish_test_chunk(&library, "generation-c", 9, 9, 4, 4, &constant_chunk(3.0));
        std::fs::remove_file(&unwanted.path).unwrap();
        let owner = GenerationChunkReader::new("generation-c", RESULT_ROLE);
        let resolved = owner
            .read_window(&library, full_window(0, 0, 4, 4), &cancellation())
            .unwrap();
        assert!(resolved.samples.iter().all(|value| *value == 7.0));
        assert!(resolved.valid.iter().all(|valid| *valid == 1));
        // The distant record is still a referenced asset: a read that must open
        // it, or a footprint that only partly covers it, reports the missing
        // file instead of empty coverage.
        let distant = full_window(9 * CHUNK_SIDE, 9 * CHUNK_SIDE, 4, 4);
        let error = owner
            .read_window(&library, distant, &cancellation())
            .expect_err("a missing committed file is an error");
        assert!(!error.is_empty());
        // Cancellation before the first page publishes nothing and a later
        // healthy pass reads the same window exactly.
        let cancelled = AtomicBool::new(true);
        assert!(
            owner
                .read_window(&library, full_window(0, 0, 4, 4), &cancelled)
                .is_err()
        );
        let resolved = owner
            .read_window(&library, full_window(0, 0, 4, 4), &cancellation())
            .unwrap();
        assert!(resolved.samples.iter().all(|value| *value == 7.0));
        // The window page loads the one intersecting record and no other.
        let page = {
            let connection = library.catalogue().unwrap();
            catalogue::generation_chunk_page(
                &connection,
                "generation-c",
                RESULT_ROLE,
                Some(catalogue::ChunkWindow::for_cells(0, 4, 0, 4, CHUNK_SIDE).unwrap()),
                None,
                CHUNK_PAGE_MAX,
            )
            .unwrap()
        };
        assert_eq!(page.len(), 1);
        assert_eq!((page[0].chunk_x, page[0].chunk_y), (0, 0));
        // Both records remain published: nothing was deleted by reading.
        let all = {
            let connection = library.catalogue().unwrap();
            catalogue::generation_chunk_page(
                &connection,
                "generation-c",
                RESULT_ROLE,
                None,
                None,
                CHUNK_PAGE_MAX,
            )
            .unwrap()
        };
        assert_eq!(all.len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Publish one record whose stored aggregate is the only thing a reader
    /// needs: no file exists, so any read of it would fail loudly.
    fn publish_stored_chunk(
        library: &crate::services::lidar::LidarLibrary,
        generation_id: &str,
        chunk_x: i64,
        chunk_y: i64,
        valid_cells: i64,
        sum_value: f64,
    ) {
        let paths = &library.inner.paths;
        let sha256 = format!("stored-{generation_id}-{chunk_x}-{chunk_y}");
        let asset = CogAsset {
            sha256: sha256.clone(),
            path: paths.asset_cog(&sha256),
            bytes: 0,
            grid: RasterGrid {
                width: 4,
                height: 4,
                geotransform: [0.0, 1.0, 0.0, 0.0, 0.0, -1.0],
            },
            nodata: Some(f32::NAN),
        };
        let connection = library.catalogue().unwrap();
        catalogue::insert_raster_asset(
            &connection,
            &asset_row(paths, &asset, "EPSG:3857").unwrap(),
        )
        .unwrap();
        catalogue::insert_unpublished_chunks(
            &connection,
            generation_id,
            &[catalogue::GenerationChunkRow {
                role: RESULT_ROLE.to_string(),
                chunk_x,
                chunk_y,
                asset_sha256: sha256,
                valid_cells,
                min_value: 0.0,
                max_value: 0.0,
                sum_value,
            }],
        )
        .unwrap();
        catalogue::publish_generation_chunks(&connection, generation_id).unwrap();
    }

    /// More than two pages of occupied records contribute exactly once, page at
    /// most `CHUNK_PAGE_MAX` records, and distant records stay out of a small
    /// window's path.
    #[test]
    fn paged_reads_cover_every_occupied_record_once_with_bounded_pages() {
        let dir = scratch("paged-records");
        let library = crate::services::lidar::LidarLibrary::open(&dir).unwrap();
        // 600 occupied records in a 24x25 block, each holding four valid cells
        // whose sum is `4 * index`, plus 50 distant records outside it.
        let mut index = 0i64;
        for chunk_y in 0..25 {
            for chunk_x in 0..24 {
                let value = index as f64;
                publish_stored_chunk(&library, "generation-p", chunk_x, chunk_y, 4, value * 4.0);
                index += 1;
            }
        }
        for distant in 0..50 {
            publish_stored_chunk(
                &library,
                "generation-p",
                9000 + distant,
                9000,
                4,
                1_000_000.0,
            );
        }
        // Pages are bounded and ordered, and the full walk sees every record
        // exactly once.
        let mut seen: Vec<(i64, i64)> = Vec::new();
        let mut cursor = None;
        let mut pages = 0usize;
        loop {
            let page = {
                let connection = library.catalogue().unwrap();
                catalogue::generation_chunk_page(
                    &connection,
                    "generation-p",
                    RESULT_ROLE,
                    None,
                    cursor,
                    CHUNK_PAGE_MAX,
                )
                .unwrap()
            };
            if page.is_empty() {
                break;
            }
            pages += 1;
            assert!(
                page.len() <= CHUNK_PAGE_MAX,
                "a page holds at most {CHUNK_PAGE_MAX} records"
            );
            assert!(
                page.windows(2)
                    .all(|pair| (pair[0].chunk_y, pair[0].chunk_x)
                        < (pair[1].chunk_y, pair[1].chunk_x)),
                "page order is stable"
            );
            cursor = page.last().map(|row| (row.chunk_y, row.chunk_x));
            seen.extend(page.iter().map(|row| (row.chunk_x, row.chunk_y)));
        }
        assert!(pages >= 3, "more than two pages were exercised: {pages}");
        assert_eq!(seen.len(), 650);
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), 650, "no record was returned twice");

        // A small window loads only what it intersects, and its aggregate is
        // the one record's stored sum.
        let window = catalogue::ChunkWindow::for_cells(0, 8, 0, 8, CHUNK_SIDE).unwrap();
        let filtered = {
            let connection = library.catalogue().unwrap();
            catalogue::generation_chunk_page(
                &connection,
                "generation-p",
                RESULT_ROLE,
                Some(window),
                None,
                CHUNK_PAGE_MAX,
            )
            .unwrap()
        };
        assert_eq!(filtered.len(), 1);
        assert_eq!((filtered[0].chunk_x, filtered[0].chunk_y), (0, 0));
        let _ = std::fs::remove_dir_all(dir);
    }
}
