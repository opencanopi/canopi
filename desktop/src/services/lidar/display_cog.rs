//! Display derivatives for the upstream WASM raster renderer.
//!
//! Numeric COGs deliberately keep one uncompressed base level, which the
//! numeric readers require. The renderer instead needs tiled, compressed files
//! with overviews, so each displayed entity gets **display derivatives**: a
//! versioned profile of DEFLATE, 256-pixel blocks and averaged valid-data
//! overviews, warped to EPSG:3857 on one global lattice by the engine, so the
//! renderer does no coordinate work (U31). They are regenerable display data
//! only — never a source member, a head or a result — and every read of
//! physical values keeps using the exact numeric generation.
//!
//! One derivative is produced per display source, in the entity's saved
//! priority order (top-first):
//!
//! - an ordered-collection source occurrence converts its own immutable COG,
//!   keyed by content digest, so reuse across items and Designs is free;
//! - a derived item's resolved chunks are read through their exact numeric
//!   reader in bounded windows, grouped into parts of at most
//!   `PART_CHUNKS`² occupied chunks. Empty space between distant chunks is never
//!   allocated.
//!
//! Files are written in a staging directory outside the WebView's asset scope
//! and renamed into `display-cog/` only when complete, so the renderer can never
//! read a partial derivative. Keys include the generation or content identity
//! and the profile, so a newer generation never reuses an older URL.

use super::engine::{DISPLAY_NODATA, RasterGeoref, RasterInput};
use super::grid::RasterGrid;
use super::{LidarLibrary, catalogue, collection, generation};
use common_types::library::{LibraryItemRole, RasterQuantity};
use common_types::lidar::{
    LidarDisplayAsset, LidarDisplayDescriptor, LidarDisplayRequest, LidarDisplayState,
};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Versioned display profile; every derivative key starts with it, and the
/// startup prune drops derivatives of any other. v2: derivatives are warped
/// to EPSG:3857 (U31), so every earlier one regenerates once.
pub(super) const DISPLAY_PROFILE: &str = "display-cog-3857-v2";
/// SHA-256 of what places and draws this profile's pixels beyond each CRS
/// row's own definition (proj4rs, the Web Mercator and WGS84 rows, the
/// warp's lattices for sample grids, and the web fixture derivative and
/// relief); a test
/// fails when any changes, so the profile is bumped with it. Each row's
/// definition is recorded on its own (`ROW_DIGESTS` in the tests), so a new
/// row needs no bump and an edited one does. The relief joined the digest
/// under v2 without a bump, and its fixture moved under the web display
/// fixture without one: no relief derivative was written before it.
#[cfg(test)]
const DISPLAY_PROFILE_DIGEST: &str =
    "3be60df74a45245546a6bc47ae404721e5e006a22fea4cf5f1f7567b80506b15";
/// Largest side of a composed part, in 1024-cell chunks: a part is composed
/// in memory and converted whole, so 4×4 chunks keep it inside the engine's
/// capacity limit (`import::MAX_RAW_EXTRACTION_CELLS`).
const PART_CHUNKS: i64 = 4;

/// How one derivative is produced.
#[derive(Clone)]
enum PartSource {
    /// One immutable numeric COG converted with its own validity rule, as
    /// its elevation or its relief.
    Asset {
        path: PathBuf,
        nodata: Option<f32>,
        relief: bool,
    },
    /// Bounded windows of an exact reader over occupied chunks of one group.
    Windows {
        reader: Arc<WindowReader>,
        /// Group's occupied chunk coordinates, row-major.
        chunks: Vec<(i64, i64)>,
    },
}

/// An exact numeric reader for composed parts.
struct WindowReader {
    reader: generation::GenerationReader,
    lattice: RasterGrid,
    crs_ref: String,
}

#[derive(Clone)]
struct PartSpec {
    key: String,
    source: PartSource,
}

/// Every derivative one entity generation needs, top-first.
pub(super) struct DisplayPlan {
    kind: LibraryItemRole,
    entity_id: String,
    generation_id: String,
    /// Whether the plan draws the item's relief rather than its values.
    relief: bool,
    /// The item's display zoom: every part is drawn on its lattice.
    zoom: u32,
    parts: Vec<PartSpec>,
}

impl DisplayPlan {
    fn key(&self) -> String {
        plan_key(self.kind, &self.entity_id, &self.generation_id, self.relief)
    }
}

enum Planned {
    Plan(Arc<DisplayPlan>),
    Unavailable(Option<String>, String),
}

/// Library-owned preparation lane state.
#[derive(Default)]
pub(crate) struct DisplayPreparation {
    plans: HashMap<String, Arc<DisplayPlan>>,
    queue: VecDeque<Arc<DisplayPlan>>,
    pending: HashSet<String>,
    failures: HashMap<String, String>,
    running: bool,
}

/// A plan's identity in the preparation lane: the variant is part of it, so
/// relief and elevation never share a pending plan or a failure.
fn plan_key(kind: LibraryItemRole, entity_id: &str, generation_id: &str, relief: bool) -> String {
    let variant = if relief { "/relief" } else { "" };
    format!(
        "{}{generation_id}{variant}",
        entity_plan_prefix(kind, entity_id)
    )
}

/// What every plan key of one entity starts with.
fn entity_plan_prefix(kind: LibraryItemRole, entity_id: &str) -> String {
    let kind = match kind {
        LibraryItemRole::Source => "source",
        LibraryItemRole::Derived => "derived",
    };
    format!("{kind}/{entity_id}/")
}

fn nodata_tag(nodata: Option<f32>) -> String {
    match nodata {
        Some(value) => format!("{:08x}", value.to_bits()),
        None => "none".to_string(),
    }
}

/// Whether an item of `quantity` draws as relief by default (D2): the three
/// elevations.
pub(super) fn draws_relief(quantity: RasterQuantity) -> bool {
    matches!(
        quantity,
        RasterQuantity::GroundElevation
            | RasterQuantity::SurfaceElevation
            | RasterQuantity::AboveGroundHeight
    )
}

/// Whether the imported item `layer_id` draws as relief by default.
fn source_draws_relief(library: &LidarLibrary, layer_id: &str) -> Result<bool, String> {
    let connection = library.catalogue()?;
    Ok(catalogue::get_layer(&connection, layer_id)?
        .and_then(|layer| RasterQuantity::from_key(&layer.quantity))
        .is_some_and(draws_relief))
}

/// Resolve the current generation of one entity and the derivatives its
/// values (or, with `relief`, its relief) need.
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn build_plan(
    library: &LidarLibrary,
    kind: LibraryItemRole,
    entity_id: &str,
    relief: bool,
    cancel: &AtomicBool,
) -> Result<Planned, String> {
    match kind {
        LibraryItemRole::Source => {
            if relief && !source_draws_relief(library, entity_id)? {
                return Ok(Planned::Unavailable(
                    None,
                    "only an elevation draws as relief".to_string(),
                ));
            }
            let head = {
                let connection = library.catalogue()?;
                catalogue::head_generation(&connection, entity_id)?
            };
            let Some(head) = head else {
                return Ok(Planned::Unavailable(
                    None,
                    "this item has no published data yet".to_string(),
                ));
            };
            let manifest = super::import::read_generation_manifest(&head.manifest_json)?;
            let members = collection::snapshot_members(library, &head.id, cancel)?;
            let zoom = super::rust_engine::display_zoom(
                &manifest.crs_ref,
                members.iter().map(|member| &member.resolved.grid),
            )?;
            let parts = members
                .into_iter()
                .map(|member| {
                    let cog = &member.resolved.cog;
                    PartSpec {
                        key: variant_key(
                            asset_key(&cog.sha256, member.resolved.nodata, zoom),
                            relief,
                        ),
                        source: PartSource::Asset {
                            path: cog.path.clone(),
                            nodata: member.resolved.nodata,
                            relief,
                        },
                    }
                })
                .collect();
            Ok(Planned::Plan(Arc::new(DisplayPlan {
                kind,
                entity_id: entity_id.to_string(),
                generation_id: head.id,
                relief,
                zoom,
                parts,
            })))
        }
        LibraryItemRole::Derived => {
            // No analysis outputs an elevation in 2.0
            // (`analyses::tests::no_analysis_outputs_an_elevation`).
            if relief {
                return Ok(Planned::Unavailable(
                    None,
                    "a result has no relief to draw".to_string(),
                ));
            }
            let result = {
                let connection = library.catalogue()?;
                catalogue::derived_head(&connection, entity_id)?
            };
            let Some(result) = result else {
                return Ok(Planned::Unavailable(
                    None,
                    "this result has not been published".to_string(),
                ));
            };
            let manifest = super::analyses::read_derived_manifest(&result.manifest_json)?;
            let coordinates = {
                let connection = library.catalogue()?;
                catalogue::published_chunk_coordinates(
                    &connection,
                    &result.id,
                    generation::RESULT_ROLE,
                )?
            };
            let chunk_grids: Vec<RasterGrid> = coordinates
                .iter()
                .map(|(x, y)| generation::chunk_grid(&manifest.grid, *x, *y))
                .collect();
            let zoom = super::rust_engine::display_zoom(
                &manifest.crs_ref,
                std::iter::once(&manifest.grid).chain(&chunk_grids),
            )?;
            let reader = Arc::new(WindowReader {
                reader: generation::GenerationReader::Chunks(
                    generation::GenerationChunkReader::new(&result.id, generation::RESULT_ROLE),
                ),
                lattice: manifest.grid.clone(),
                crs_ref: manifest.crs_ref.clone(),
            });
            let parts = grouped_parts(&gen_prefix(&result.id), &reader, coordinates);
            Ok(Planned::Plan(Arc::new(DisplayPlan {
                kind,
                entity_id: entity_id.to_string(),
                generation_id: result.id,
                relief,
                zoom,
                parts,
            })))
        }
    }
}

/// The derivative key of one numeric COG under its NoData rule, drawn at
/// its item's zoom: an asset shared by items at different latitudes gets one
/// derivative per zoom.
fn asset_key(sha256: &str, nodata: Option<f32>, zoom: u32) -> String {
    format!("{}{}-z{zoom}", asset_prefix(sha256), nodata_tag(nodata))
}

/// The key of `key`'s relief when `relief`: inside the same prefix, so
/// forgetting an asset's derivatives forgets its relief too.
fn variant_key(key: String, relief: bool) -> String {
    if relief { format!("{key}-relief") } else { key }
}

/// What every derivative key of one numeric COG starts with, whatever its
/// NoData rule, zoom or variant.
pub(super) fn asset_prefix(sha256: &str) -> String {
    format!("{DISPLAY_PROFILE}-asset-{sha256}-")
}

/// What every derivative key of one derived generation's parts starts with.
pub(super) fn gen_prefix(generation_id: &str) -> String {
    format!("{DISPLAY_PROFILE}-gen-{generation_id}-")
}

/// Group occupied chunks into parts of at most `PART_CHUNKS`² chunks, each
/// keyed `prefix` and its group coordinates.
fn grouped_parts(
    prefix: &str,
    reader: &Arc<WindowReader>,
    coordinates: Vec<(i64, i64)>,
) -> Vec<PartSpec> {
    let mut groups: BTreeMap<(i64, i64), Vec<(i64, i64)>> = BTreeMap::new();
    for (x, y) in coordinates {
        groups
            .entry((y.div_euclid(PART_CHUNKS), x.div_euclid(PART_CHUNKS)))
            .or_default()
            .push((x, y));
    }
    groups
        .into_iter()
        .map(|((group_y, group_x), chunks)| PartSpec {
            key: format!("{prefix}{group_x}_{group_y}"),
            source: PartSource::Windows {
                reader: Arc::clone(reader),
                chunks,
            },
        })
        .collect()
}

/// A prepared derivative as the registry records it.
#[derive(Clone)]
struct Prepared {
    /// File name inside `display-cog/`; empty for a part with no valid cell.
    file: String,
    bounds: [f64; 4],
}

fn registered(display: &rusqlite::Connection, key: &str) -> Result<Option<Prepared>, String> {
    use rusqlite::OptionalExtension as _;
    display
        .query_row(
            "SELECT file, west, south, east, north FROM display_cogs WHERE key = ?1",
            [key],
            |row| {
                Ok(Prepared {
                    file: row.get(0)?,
                    bounds: [row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?],
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to read the display registry: {e}"))
}

fn record(
    display: &rusqlite::Connection,
    key: &str,
    prepared: &Prepared,
    bytes: u64,
) -> Result<(), String> {
    display
        .execute(
            "INSERT INTO display_cogs(key, file, bytes, west, south, east, north, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(key) DO UPDATE SET file = excluded.file, bytes = excluded.bytes,
                 west = excluded.west, south = excluded.south, east = excluded.east,
                 north = excluded.north, created_at = excluded.created_at",
            rusqlite::params![
                key,
                prepared.file,
                i64::try_from(bytes).unwrap_or(i64::MAX),
                prepared.bounds[0],
                prepared.bounds[1],
                prepared.bounds[2],
                prepared.bounds[3],
                catalogue::now_iso(),
            ],
        )
        .map_err(|e| format!("Failed to record a display derivative: {e}"))?;
    Ok(())
}

/// A registered derivative whose file is still on disk.
fn ready_part(library: &LidarLibrary, key: &str) -> Result<Option<Prepared>, String> {
    let prepared = {
        let display = library.display()?;
        registered(&display, key)?
    };
    Ok(prepared.filter(|prepared| {
        prepared.file.is_empty()
            || library
                .inner
                .paths
                .display_cog_dir()
                .join(&prepared.file)
                .is_file()
    }))
}

impl LidarLibrary {
    /// Describe the display derivatives of one entity's current generation,
    /// starting their preparation when any is missing.
    pub fn display_descriptor(
        &self,
        request: &LidarDisplayRequest,
    ) -> Result<LidarDisplayDescriptor, String> {
        let cancel = AtomicBool::new(false);
        let planned = build_plan(
            self,
            request.kind,
            &request.entity_id,
            request.relief,
            &cancel,
        )?;
        let empty = |generation_id: Option<String>, state, message: Option<String>| {
            LidarDisplayDescriptor {
                kind: request.kind,
                entity_id: request.entity_id.clone(),
                generation_id,
                profile: DISPLAY_PROFILE.to_string(),
                relief: request.relief,
                state,
                message,
                assets: Vec::new(),
                prepared_assets: 0,
                total_assets: 0,
            }
        };
        let plan = match planned {
            Planned::Unavailable(generation_id, message) => {
                return Ok(empty(
                    generation_id,
                    LidarDisplayState::Unavailable,
                    Some(message),
                ));
            }
            Planned::Plan(plan) => plan,
        };
        if let Some(expected) = request.expected_generation_id.as_deref()
            && expected != plan.generation_id
        {
            return Ok(empty(
                Some(plan.generation_id.clone()),
                LidarDisplayState::Stale,
                Some("the item changed since it was requested".to_string()),
            ));
        }
        let mut assets = Vec::with_capacity(plan.parts.len());
        let mut prepared = 0u32;
        for part in &plan.parts {
            if let Some(ready) = ready_part(self, &part.key)? {
                prepared += 1;
                if !ready.file.is_empty() {
                    assets.push(LidarDisplayAsset {
                        path: self
                            .inner
                            .paths
                            .display_cog_dir()
                            .join(&ready.file)
                            .display()
                            .to_string(),
                        bounds: ready.bounds,
                    });
                }
            }
        }
        let total = u32::try_from(plan.parts.len()).unwrap_or(u32::MAX);
        let mut descriptor = empty(
            Some(plan.generation_id.clone()),
            LidarDisplayState::Ready,
            None,
        );
        descriptor.prepared_assets = prepared;
        descriptor.total_assets = total;
        if prepared == total {
            descriptor.assets = assets;
            return Ok(descriptor);
        }
        let key = plan.key();
        let failure = {
            let mut state = self.display_preparation()?;
            if request.retry {
                state.failures.remove(&key);
            }
            state.failures.get(&key).cloned()
        };
        if let Some(message) = failure {
            descriptor.state = LidarDisplayState::Failed;
            descriptor.message = Some(message);
            return Ok(descriptor);
        }
        self.enqueue_display_preparation(plan)?;
        descriptor.state = LidarDisplayState::Preparing;
        Ok(descriptor)
    }

    pub(crate) fn display_preparation(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, DisplayPreparation>, String> {
        self.inner
            .display_preparation
            .lock()
            .map_err(|_| "LiDAR display preparation state poisoned".to_string())
    }

    /// Drop the entity's queued plans and remembered failures, every variant
    /// and generation; a plan already running finishes.
    pub(super) fn forget_entity_plans(
        &self,
        kind: LibraryItemRole,
        entity_id: &str,
    ) -> Result<(), String> {
        let prefix = entity_plan_prefix(kind, entity_id);
        let mut state = self.display_preparation()?;
        let state = &mut *state;
        state.plans.retain(|key, _| !key.starts_with(&prefix));
        state.failures.retain(|key, _| !key.starts_with(&prefix));
        let pending = &mut state.pending;
        state.queue.retain(|plan| {
            let key = plan.key();
            let keep = !key.starts_with(&prefix);
            if !keep {
                pending.remove(&key);
            }
            keep
        });
        Ok(())
    }

    fn enqueue_display_preparation(&self, plan: Arc<DisplayPlan>) -> Result<(), String> {
        let key = plan.key();
        let start = {
            let mut state = self.display_preparation()?;
            state.plans.insert(key.clone(), Arc::clone(&plan));
            if state.pending.insert(key) {
                state.queue.push_back(plan);
            }
            !std::mem::replace(&mut state.running, true)
        };
        if start {
            let library = self.clone();
            let executor = match self.executor() {
                Ok(executor) => executor,
                Err(error) => {
                    if let Ok(mut state) = self.display_preparation() {
                        state.running = false;
                    }
                    return Err(error);
                }
            };
            tauri::async_runtime::spawn(async move {
                loop {
                    let next = library.display_preparation().ok().and_then(|mut state| {
                        let next = state.queue.pop_front();
                        if next.is_none() {
                            state.running = false;
                        }
                        next
                    });
                    let Some(plan) = next else { break };
                    let key = plan.key();
                    let worker = library.clone();
                    let job = Arc::clone(&plan);
                    let outcome = executor
                        .run(super::RASTER_WORK, "lidar display preparation", move || {
                            let cancel = AtomicBool::new(false);
                            worker.prepare_display_plan(&job, &cancel)
                        })
                        .await;
                    if let Ok(mut state) = library.display_preparation() {
                        state.pending.remove(&key);
                        match outcome {
                            Ok(()) => {
                                state.failures.remove(&key);
                            }
                            Err(error) => {
                                tracing::warn!(key, error, "LiDAR display preparation failed");
                                state.failures.insert(key, error);
                            }
                        }
                    }
                }
            });
        }
        Ok(())
    }

    /// Prepare every missing derivative of one plan, in priority order.
    pub(super) fn prepare_display_plan(
        &self,
        plan: &DisplayPlan,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        for part in &plan.parts {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".to_string());
            }
            if ready_part(self, &part.key)?.is_some() {
                continue;
            }
            let (prepared, bytes) = self.prepare_part(part, plan.zoom, cancel)?;
            let display = self.display()?;
            record(&display, &part.key, &prepared, bytes)?;
        }
        Ok(())
    }

    fn prepare_part(
        &self,
        part: &PartSpec,
        zoom: u32,
        cancel: &AtomicBool,
    ) -> Result<(Prepared, u64), String> {
        let staging = self.inner.paths.display_cog_staging_dir();
        std::fs::create_dir_all(&staging)
            .map_err(|e| format!("Failed to create display staging: {e}"))?;
        let file = format!("{}.tif", part.key);
        let staged = staging.join(&file);
        let _ = std::fs::remove_file(&staged);
        let engine = self.inner.engine.as_ref();
        match &part.source {
            PartSource::Asset {
                path,
                nodata,
                relief,
            } => {
                let bytes = std::fs::metadata(path)
                    .map_err(|e| format!("Display source {} is unavailable: {e}", path.display()))?
                    .len();
                super::paths::require_free_space(
                    &staging,
                    display_free_bytes(bytes),
                    "Display preparation",
                )?;
                let converted = if *relief {
                    // Only the Rust engine draws relief (not on the seam).
                    super::rust_engine::RustRasterEngine.write_relief_cog(
                        RasterInput::File(path),
                        &staged,
                        None,
                        *nodata,
                        zoom,
                        cancel,
                    )
                } else {
                    engine.write_display_cog(
                        RasterInput::File(path),
                        &staged,
                        None,
                        *nodata,
                        zoom,
                        cancel,
                    )
                };
                if let Err(error) = converted {
                    let _ = std::fs::remove_file(&staged);
                    return Err(error);
                }
            }
            PartSource::Windows { reader, chunks } => {
                let written = self.write_part_windows(reader, chunks, &staged, zoom, cancel);
                match written {
                    Ok(true) => {}
                    Ok(false) => {
                        // No valid cell: record the part as empty rather than
                        // publishing a transparent file.
                        return Ok((
                            Prepared {
                                file: String::new(),
                                bounds: [0.0; 4],
                            },
                            0,
                        ));
                    }
                    Err(error) => {
                        let _ = std::fs::remove_file(&staged);
                        return Err(error);
                    }
                }
            }
        }
        let bounds = match engine.wgs84_extent(&staged, cancel) {
            Ok(bounds) => bounds,
            Err(error) => {
                let _ = std::fs::remove_file(&staged);
                return Err(error);
            }
        };
        crate::design::sync_file(&staged)
            .map_err(|e| format!("Failed to sync a display derivative: {e}"))?;
        let bytes = std::fs::metadata(&staged)
            .map(|meta| meta.len())
            .unwrap_or(0);
        let published = self.inner.paths.display_cog_dir().join(&file);
        std::fs::rename(&staged, &published)
            .map_err(|e| format!("Failed to publish a display derivative: {e}"))?;
        Ok((Prepared { file, bounds }, bytes))
    }

    /// Compose one part from bounded exact windows. Returns whether any cell
    /// is valid.
    fn write_part_windows(
        &self,
        reader: &WindowReader,
        chunks: &[(i64, i64)],
        staged: &Path,
        zoom: u32,
        cancel: &AtomicBool,
    ) -> Result<bool, String> {
        let side = generation::CHUNK_SIDE;
        let min_x = chunks.iter().map(|chunk| chunk.0).min().unwrap_or(0);
        let max_x = chunks.iter().map(|chunk| chunk.0).max().unwrap_or(0);
        let min_y = chunks.iter().map(|chunk| chunk.1).min().unwrap_or(0);
        let max_y = chunks.iter().map(|chunk| chunk.1).max().unwrap_or(0);
        let columns = (max_x - min_x + 1) as usize;
        let rows = (max_y - min_y + 1) as usize;
        let width = columns * side as usize;
        let height = rows * side as usize;
        let row_bytes = width * 4;
        super::paths::require_free_space(
            staged.parent().unwrap_or(staged),
            display_free_bytes((row_bytes * height) as u64),
            "Display preparation",
        )?;
        let occupied: HashSet<(i64, i64)> = chunks.iter().copied().collect();
        // The part is composed in memory: at most `PART_CHUNKS`² chunks, and
        // empty space between distant chunks is never part of one group.
        let mut samples = vec![DISPLAY_NODATA; width * height];
        let mut any_valid = false;
        for chunk_y in min_y..=max_y {
            for chunk_x in min_x..=max_x {
                if cancel.load(Ordering::Relaxed) {
                    return Err("cancelled".to_string());
                }
                if !occupied.contains(&(chunk_x, chunk_y)) {
                    continue;
                }
                let window = reader.reader.read_window(
                    self,
                    generation::LatticeWindow {
                        x: chunk_x * side,
                        y: chunk_y * side,
                        width: side as u32,
                        height: side as u32,
                    },
                    cancel,
                )?;
                let column = (chunk_x - min_x) as usize * side as usize;
                let row0 = (chunk_y - min_y) as usize * side as usize;
                for line in 0..side as usize {
                    let start = line * side as usize;
                    let target = (row0 + line) * width + column;
                    for index in 0..side as usize {
                        let valid = window.valid[start + index] != 0;
                        let sample = window.samples[start + index];
                        if valid && sample.is_finite() {
                            any_valid = true;
                            samples[target + index] = sample;
                        }
                    }
                }
            }
        }
        if !any_valid {
            return Ok(false);
        }
        let gt = reader.lattice.geotransform;
        let grid = RasterGrid {
            width: width as u32,
            height: height as u32,
            geotransform: [
                gt[0] + (min_x * side) as f64 * gt[1],
                gt[1],
                0.0,
                gt[3] + (min_y * side) as f64 * gt[5],
                0.0,
                gt[5],
            ],
        };
        self.inner
            .engine
            .write_display_cog(
                RasterInput::Samples {
                    grid: &grid,
                    values: &samples,
                },
                staged,
                Some(RasterGeoref {
                    grid: &grid,
                    crs: &reader.crs_ref,
                }),
                Some(DISPLAY_NODATA),
                zoom,
                cancel,
            )
            .map(|_| true)
    }
}

impl LidarLibrary {
    /// Prepare the derivative of every staged source the item's default view
    /// draws (D8: the relief of an elevation, else the values) before the
    /// import publishes, inside the import job: a new item is displayable the
    /// moment it appears. The other view is prepared the first time it is
    /// asked for. A failure or cancellation here publishes nothing.
    pub(super) fn prepare_staged_display(
        &self,
        staging: &super::import::StagedImport,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        // The whole batch is compatible (one CRS) and publishes as one item,
        // so its zoom is the published plan's.
        let Some(first) = staging.sources.first() else {
            return Ok(());
        };
        let grids: Vec<RasterGrid> = staging
            .sources
            .iter()
            .map(|source| RasterGrid {
                width: source.width,
                height: source.height,
                geotransform: source.geotransform,
            })
            .collect();
        let zoom = super::rust_engine::display_zoom(&first.crs_ref, &grids)?;
        let relief = source_draws_relief(self, &staging.layer_id)?;
        for source in &staging.sources {
            let cog = &source.source_cog;
            let part = PartSpec {
                key: variant_key(asset_key(&cog.sha256, cog.nodata, zoom), relief),
                source: PartSource::Asset {
                    path: cog.resolve(&self.inner.paths, &source.job_id)?,
                    nodata: cog.nodata,
                    relief,
                },
            };
            if ready_part(self, &part.key)?.is_some() {
                continue;
            }
            let (prepared, bytes) = self.prepare_part(&part, zoom, cancel)?;
            let display = self.display()?;
            record(&display, &part.key, &prepared, bytes)?;
        }
        Ok(())
    }
}

/// Forget the derivatives of one source COG no item published, and remove
/// their files: an unpublished import's (`import::discard_job_files`). No
/// WebView reads them, since only a published item is drawn.
pub(super) fn forget_asset_derivatives(library: &LidarLibrary, sha256: &str) -> Result<(), String> {
    forget_derivatives(library, &asset_prefix(sha256))
}

/// Forget every registered derivative whose key starts with `prefix`
/// ([`asset_prefix`], [`gen_prefix`]) and remove its file; the caller makes
/// sure no drawn item still uses them.
pub(super) fn forget_derivatives(library: &LidarLibrary, prefix: &str) -> Result<(), String> {
    let files: Vec<String> = {
        let display = library.display()?;
        let files = display
            .prepare("SELECT file FROM display_cogs WHERE instr(key, ?1) = 1 AND file != ''")
            .map_err(|e| e.to_string())?
            .query_map([prefix], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        display
            .execute(
                "DELETE FROM display_cogs WHERE instr(key, ?1) = 1",
                [prefix],
            )
            .map_err(|e| e.to_string())?;
        files
    };
    for file in files {
        match std::fs::remove_file(library.inner.paths.display_cog_dir().join(&file)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to remove the derivative {file}: {error}")),
        }
    }
    Ok(())
}

/// Every registered derivative key, in key order.
pub(super) fn registered_derivative_keys(library: &LidarLibrary) -> Result<Vec<String>, String> {
    let display = library.display()?;
    let mut statement = display
        .prepare("SELECT key FROM display_cogs ORDER BY key")
        .map_err(|e| e.to_string())?;
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Remove staging leftovers, derivatives of an earlier profile and published
/// files the registry does not own.
///
/// Runs at startup, when no WebView reader can hold a derivative open, so an
/// unreferenced file can go without racing an admitted read.
pub(super) fn prune_display_derivatives(library: &LidarLibrary) -> Result<(), String> {
    let staging = library.inner.paths.display_cog_staging_dir();
    for entry in std::fs::read_dir(&staging).into_iter().flatten().flatten() {
        let _ = std::fs::remove_file(entry.path());
    }
    let owned: HashSet<String> = {
        let display = library.display()?;
        display
            .execute(
                "DELETE FROM display_cogs WHERE instr(key, ?1) != 1",
                [format!("{DISPLAY_PROFILE}-")],
            )
            .map_err(|e| e.to_string())?;
        let mut statement = display
            .prepare("SELECT file FROM display_cogs WHERE file != ''")
            .map_err(|e| e.to_string())?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for entry in std::fs::read_dir(library.inner.paths.display_cog_dir())
        .into_iter()
        .flatten()
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !owned.contains(&name) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// Free bytes a display derivative of a raw (uncompressed) source asset of
/// `source_bytes` may need.
fn display_free_bytes(source_bytes: u64) -> u64 {
    // The Web Mercator rung is the finest whose pixel fits inside a cell as
    // it lands there, so the source's pixels grow up to four times on an
    // unrotated grid and up to sixteen times on one turned 45° (LAEA Europe
    // near its edges). Repeated nearest-neighbour samples compress, but
    // Deflate barely shrinks Float32 values: the worst supported case
    // measured about 4.4 times the raw source with overviews (a test), so
    // five times is the ceiling.
    source_bytes.saturating_mul(5)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The free-space check before a derivative covers what the warp writes
    /// at its worst: values Deflate cannot shrink, on a cell just above a
    /// rung. An unrotated grid draws at up to four times its pixels (0.82 m
    /// Lambert-93 cells near 46°N draw at zoom 18); a grid turned against
    /// Web Mercator draws at up to sixteen times (LAEA Europe at 40°E 40°N,
    /// and near its western edge at 80°N, where cells turn about 45°).
    #[test]
    fn the_free_space_asked_for_a_derivative_covers_the_finest_rung() {
        for (crs, origin, cell, min_pixels) in [
            ("EPSG:2154", [700_000.0, 6_600_000.0], 0.82, 3.5),
            ("EPSG:3035", [6_820_000.0, 2_383_000.0], 0.5955, 11.0),
            ("EPSG:3035", [3_503_900.0, 6_592_190.0], 0.5955, 16.0),
        ] {
            assert_derivative_fits(crs, origin, cell, min_pixels);
        }
    }

    fn assert_derivative_fits(crs: &str, origin: [f64; 2], cell: f64, min_pixels: f64) {
        use super::super::engine::{RasterEngine, RasterGeoref, RasterInput};
        let engine = super::super::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let root = crate::test_scratch::TestScratch::new("canopi-display-free-space");
        std::fs::create_dir_all(&root).unwrap();
        let side = 512u32;
        let mut state = 12_345u64;
        let values: Vec<f32> = (0..side * side)
            .map(|_| {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                // Random mantissa bits in [128, 256): nothing to compress.
                f32::from_bits(((state >> 33) as u32 & 0x007f_ffff) | 0x4300_0000)
            })
            .collect();
        let grid = RasterGrid {
            width: side,
            height: side,
            geotransform: [origin[0], cell, 0.0, origin[1], 0.0, -cell],
        };
        let source = root.join("source.tif");
        engine
            .write_controlled_cog(
                RasterInput::Samples {
                    grid: &grid,
                    values: &values,
                },
                &source,
                Some(RasterGeoref { grid: &grid, crs }),
                Some(-9999.0),
                &cancel,
            )
            .unwrap();
        let zoom = super::super::rust_engine::display_zoom(crs, [&grid]).unwrap();
        let display = root.join("display.tif");
        engine
            .write_display_cog(
                RasterInput::File(&source),
                &display,
                None,
                Some(-9999.0),
                zoom,
                &cancel,
            )
            .unwrap();
        let probe = engine.probe(&display, &cancel).unwrap();
        let pixels = f64::from(probe.width) * f64::from(probe.height);
        let source_bytes = std::fs::metadata(&source).unwrap().len();
        let display_bytes = std::fs::metadata(&display).unwrap().len();
        assert!(
            pixels > min_pixels * f64::from(side * side),
            "{crs}: the fixture draws at the finest rung: {pixels} pixels"
        );
        assert!(
            display_bytes <= display_free_bytes(source_bytes),
            "{crs}: {display_bytes} bytes written, {} asked for",
            display_free_bytes(source_bytes)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A result's display derivative is written at the same rung as a
    /// per-file one, so its free-space check asks for the same ceiling.
    #[test]
    fn the_free_space_asked_for_a_result_part_covers_the_finest_rung() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-part-free-space");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).unwrap();
        let reader = WindowReader {
            reader: generation::GenerationReader::Chunks(generation::GenerationChunkReader::new(
                "gen-free",
                generation::RESULT_ROLE,
            )),
            lattice: RasterGrid {
                width: 1024,
                height: 1024,
                geotransform: [0.0, 1.0, 0.0, 0.0, 0.0, -1.0],
            },
            crs_ref: String::new(),
        };
        let _full = super::super::paths::capacity_probe::override_available(0);
        let error = library
            .write_part_windows(
                &reader,
                &[(0, 0)],
                &root.join("part.tif"),
                18,
                &AtomicBool::new(false),
            )
            .unwrap_err();
        let side = generation::CHUNK_SIDE as u64;
        let raw = side * side * 4;
        assert!(
            error.contains(&format!("({} bytes)", display_free_bytes(raw))),
            "{error}"
        );
        drop(library);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn distant_chunks_form_separate_parts_without_the_gap_between() {
        let reader = Arc::new(WindowReader {
            reader: generation::GenerationReader::Chunks(generation::GenerationChunkReader::new(
                "gen-1",
                generation::RESULT_ROLE,
            )),
            lattice: RasterGrid {
                width: 1024,
                height: 1024,
                geotransform: [0.0, 1.0, 0.0, 0.0, 0.0, -1.0],
            },
            crs_ref: String::new(),
        });
        // Two adjacent chunks and one 200 chunks away.
        let parts = grouped_parts("gen-1-", &reader, vec![(0, 0), (1, 0), (200, 3)]);
        let keys: Vec<&str> = parts.iter().map(|part| part.key.as_str()).collect();
        assert_eq!(keys, ["gen-1-0_0", "gen-1-50_0"]);
        let PartSource::Windows { chunks, .. } = &parts[1].source else {
            panic!("composed part")
        };
        assert_eq!(chunks, &[(200, 3)]);
    }

    #[test]
    fn the_part_sentinel_round_trips_through_its_decimal_tag() {
        assert_eq!(DISPLAY_NODATA, -(2.0_f32.powi(127)));
        let tag = format!("{:?}", f64::from(DISPLAY_NODATA));
        let parsed: f64 = tag.parse().unwrap();
        assert_eq!(parsed, f64::from(DISPLAY_NODATA), "{tag}");
        assert_eq!(parsed as f32, DISPLAY_NODATA);
    }

    #[test]
    fn negative_lattice_chunks_group_by_floor() {
        let reader = Arc::new(WindowReader {
            reader: generation::GenerationReader::Chunks(generation::GenerationChunkReader::new(
                "gen-2",
                generation::RESULT_ROLE,
            )),
            lattice: RasterGrid {
                width: 1,
                height: 1,
                geotransform: [0.0, 1.0, 0.0, 0.0, 0.0, -1.0],
            },
            crs_ref: String::new(),
        });
        let parts = grouped_parts("gen-2-", &reader, vec![(-1, -1), (0, 0)]);
        let keys: Vec<&str> = parts.iter().map(|part| part.key.as_str()).collect();
        assert_eq!(keys, ["gen-2--1_-1", "gen-2-0_0"]);
    }
}

#[cfg(test)]
impl LidarLibrary {
    /// Test support: prepare an entity's derivatives synchronously, its
    /// values and, for an elevation, its relief.
    pub(super) fn prepare_display_now(
        &self,
        kind: LibraryItemRole,
        entity_id: &str,
    ) -> Result<(), String> {
        let cancel = AtomicBool::new(false);
        let relief = kind == LibraryItemRole::Source && source_draws_relief(self, entity_id)?;
        for variant in [false, true]
            .into_iter()
            .filter(|variant| !variant || relief)
        {
            match build_plan(self, kind, entity_id, variant, &cancel)? {
                Planned::Plan(plan) => self.prepare_display_plan(&plan, &cancel)?,
                Planned::Unavailable(_, message) => return Err(message),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod library_tests {
    use super::*;
    use common_types::library::RasterQuantity;

    pub(super) fn plane_source(
        library: &LidarLibrary,
        root: &Path,
        name: &str,
        origin_x: f64,
    ) -> PathBuf {
        let engine = &library.inner.engine;
        let cancel = AtomicBool::new(false);
        let (width, height) = (600u32, 400u32);
        // x-ramp with a NoData hole, so validity must survive conversion.
        let mut values = Vec::with_capacity((width * height) as usize);
        for row in 0..height {
            for column in 0..width {
                let hole = (100..140).contains(&row) && (100..160).contains(&column);
                values.push(if hole { -9999.0 } else { column as f32 * 0.5 });
            }
        }
        let raw = root.join(format!("{name}.raw"));
        super::super::import::write_f32_raw(&raw, &values).unwrap();
        let source = root.join(format!("{name}.tif"));
        super::super::import::raw_to_tif(
            engine.as_ref(),
            &cancel,
            &raw,
            &source,
            &RasterGrid {
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

    pub(super) fn info(library: &LidarLibrary, path: &str) -> super::super::engine::RasterProbe {
        library
            .inner
            .engine
            .probe(Path::new(path), &AtomicBool::new(false))
            .unwrap()
    }

    /// A published multi-source item is displayed from one content-keyed,
    /// compressed, overviewed derivative per source, top-first, each keeping
    /// its source's own NoData rule; the numeric generation is untouched.
    #[test]
    #[expect(
        clippy::too_many_lines,
        reason = "ratcheted before 2.1-M188; split when this function next changes"
    )]
    fn published_sources_display_from_overviewed_derivatives_in_priority_order() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-cog");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).expect("library opens");
        let cancel = AtomicBool::new(false);
        let west = plane_source(&library, &root, "west", 445_000.0);
        let east = plane_source(&library, &root, "east", 445_300.0);
        let layer_id = library
            .create_layer("pair", RasterQuantity::GroundElevation, None, false)
            .unwrap();
        let job_id = library.record_import_job(&layer_id).unwrap();
        super::super::import::stage_and_publish(
            &library,
            &job_id,
            &layer_id,
            &[west, east],
            &cancel,
        )
        .unwrap();
        let generation_id = library
            .library_snapshot()
            .unwrap()
            .items
            .into_iter()
            .find(|layer| layer.id == layer_id)
            .and_then(|layer| layer.generation_id)
            .expect("published head");

        library
            .prepare_display_now(LibraryItemRole::Source, &layer_id)
            .unwrap();
        let descriptor = library
            .display_descriptor(&LidarDisplayRequest {
                kind: LibraryItemRole::Source,
                entity_id: layer_id.clone(),
                expected_generation_id: Some(generation_id.clone()),
                retry: false,
                relief: false,
            })
            .unwrap();
        assert_eq!(descriptor.state, LidarDisplayState::Ready, "{descriptor:?}");
        assert_eq!(
            descriptor.generation_id.as_deref(),
            Some(generation_id.as_str())
        );
        assert_eq!(descriptor.assets.len(), 2);
        assert_eq!(descriptor.total_assets, 2);
        // Top-first: the east source was listed last, so it is below the west.
        let display_dir = library.inner.paths.display_cog_dir();
        for asset in &descriptor.assets {
            let path = Path::new(&asset.path);
            assert_eq!(path.parent(), Some(display_dir.as_path()));
            let meta = info(&library, &asset.path);
            assert_eq!(meta.nodata, Some(-9999.0), "{meta:?}");
            assert!(meta.overview_count > 0, "overviews: {meta:?}");
            assert_eq!(meta.compression, "DEFLATE");
            // Lambert-93 near 445 km E / 6806 km N lies around 0.4°W, 48.3°N.
            assert!(
                (-0.5..-0.3).contains(&asset.bounds[0]),
                "{:?}",
                asset.bounds
            );
            assert!(
                (48.2..48.4).contains(&asset.bounds[1]),
                "{:?}",
                asset.bounds
            );
        }
        assert!(descriptor.assets[0].bounds[0] < descriptor.assets[1].bounds[0]);

        // A caller aiming at another generation is told the item moved on.
        let stale = library
            .display_descriptor(&LidarDisplayRequest {
                kind: LibraryItemRole::Source,
                entity_id: layer_id.clone(),
                expected_generation_id: Some("gen-older".to_string()),
                retry: false,
                relief: false,
            })
            .unwrap();
        assert_eq!(stale.state, LidarDisplayState::Stale);
        assert!(stale.assets.is_empty());

        // An unpublished item has nothing to draw, which is not an error.
        let empty_id = library
            .create_layer("empty", RasterQuantity::GroundElevation, None, false)
            .unwrap();
        let empty = library
            .display_descriptor(&LidarDisplayRequest {
                kind: LibraryItemRole::Source,
                entity_id: empty_id,
                expected_generation_id: None,
                retry: false,
                relief: false,
            })
            .unwrap();
        assert_eq!(empty.state, LidarDisplayState::Unavailable);

        // A second preparation reuses the content-keyed derivatives.
        let before: Vec<_> = descriptor
            .assets
            .iter()
            .map(|asset| std::fs::metadata(&asset.path).unwrap().modified().unwrap())
            .collect();
        library
            .prepare_display_now(LibraryItemRole::Source, &layer_id)
            .unwrap();
        let after: Vec<_> = descriptor
            .assets
            .iter()
            .map(|asset| std::fs::metadata(&asset.path).unwrap().modified().unwrap())
            .collect();
        assert_eq!(before, after);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The import job prepares the derivatives the published item's plan
    /// asks for: every part is ready the moment the item appears, so the
    /// first display regenerates nothing.
    #[test]
    fn derivatives_prepared_at_import_are_the_ones_the_item_displays() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-staged");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).expect("library opens");
        let cancel = AtomicBool::new(false);
        let west = plane_source(&library, &root, "west", 445_000.0);
        let east = plane_source(&library, &root, "east", 445_600.0);
        let layer_id = library
            .create_layer("staged", RasterQuantity::GroundElevation, None, false)
            .unwrap();
        let job_id = library.record_import_job(&layer_id).unwrap();
        super::super::import::stage_import(&library, &job_id, &layer_id, &[west, east], &cancel)
            .unwrap();
        let staging = super::super::import::read_staged_import(&library, &job_id).unwrap();
        library.prepare_staged_display(&staging, &cancel).unwrap();
        super::super::import::apply_import(&library, &staging, &cancel).unwrap();
        // A ground elevation's default view is its relief (D8).
        let Planned::Plan(plan) =
            build_plan(&library, LibraryItemRole::Source, &layer_id, true, &cancel).unwrap()
        else {
            panic!("a published item has a plan")
        };
        assert_eq!(plan.parts.len(), 2);
        for part in &plan.parts {
            assert!(
                ready_part(&library, &part.key).unwrap().is_some(),
                "{} was not prepared at import",
                part.key
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A derivative an earlier display profile wrote is never served: the
    /// startup prune drops its row and file, and the item regenerates.
    #[test]
    fn derivatives_of_an_earlier_profile_are_pruned_and_regenerated() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-profile");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).expect("library opens");
        let cancel = AtomicBool::new(false);
        let source = plane_source(&library, &root, "tile", 445_000.0);
        let layer_id = library
            .create_layer("tile", RasterQuantity::GroundElevation, None, false)
            .unwrap();
        let job_id = library.record_import_job(&layer_id).unwrap();
        super::super::import::stage_and_publish(&library, &job_id, &layer_id, &[source], &cancel)
            .unwrap();
        library
            .prepare_display_now(LibraryItemRole::Source, &layer_id)
            .unwrap();
        // Rewrite each row as the first profile keyed it: without a profile.
        {
            let keys = registered_derivative_keys(&library).unwrap();
            let display = library.display().unwrap();
            assert!(!keys.is_empty());
            for key in keys {
                assert!(key.starts_with(&format!("{DISPLAY_PROFILE}-")), "{key}");
                let earlier = &key[DISPLAY_PROFILE.len() + 1..];
                display
                    .execute(
                        "UPDATE display_cogs SET key = ?1 WHERE key = ?2",
                        [earlier, key.as_str()],
                    )
                    .unwrap();
            }
        }

        prune_display_derivatives(&library).unwrap();
        let display_dir = library.inner.paths.display_cog_dir();
        assert_eq!(std::fs::read_dir(&display_dir).unwrap().count(), 0);
        let Planned::Plan(plan) =
            build_plan(&library, LibraryItemRole::Source, &layer_id, false, &cancel).unwrap()
        else {
            panic!("a published item has a plan")
        };
        for part in &plan.parts {
            assert!(
                ready_part(&library, &part.key).unwrap().is_none(),
                "{}",
                part.key
            );
        }
        library
            .prepare_display_now(LibraryItemRole::Source, &layer_id)
            .unwrap();
        for part in &plan.parts {
            assert!(
                ready_part(&library, &part.key).unwrap().is_some(),
                "{}",
                part.key
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A published RD New item near Delft: a ramp of distinct values with a
    /// -9999 hole and a few NaN cells. Returns its id and generation.
    fn publish_rd_item(
        library: &LidarLibrary,
        root: &Path,
        name: &str,
        width: u32,
        height: u32,
    ) -> (String, String) {
        let engine = &library.inner.engine;
        let cancel = AtomicBool::new(false);
        let mut values = Vec::with_capacity((width * height) as usize);
        for row in 0..height {
            for column in 0..width {
                values.push(if (row * 7 + column * 3) % 41 == 0 {
                    -9999.0
                } else if (row * 5 + column) % 97 == 0 {
                    f32::NAN
                } else {
                    (row * width + column) as f32 * 0.25 + 1.0
                });
            }
        }
        let raw = root.join(format!("{name}.raw"));
        super::super::import::write_f32_raw(&raw, &values).unwrap();
        let source = root.join(format!("{name}.tif"));
        super::super::import::raw_to_tif(
            engine.as_ref(),
            &cancel,
            &raw,
            &source,
            &RasterGrid {
                width,
                height,
                geotransform: [85_000.25, 0.5, 0.0, 447_499.75, 0.0, -0.5],
            },
            "EPSG:28992",
            -9999.0,
        )
        .unwrap();
        let layer_id = library
            .create_layer(name, RasterQuantity::GroundElevation, None, false)
            .unwrap();
        let job_id = library.record_import_job(&layer_id).unwrap();
        super::super::import::stage_and_publish(library, &job_id, &layer_id, &[source], &cancel)
            .unwrap();
        let generation_id = library
            .library_snapshot()
            .unwrap()
            .items
            .into_iter()
            .find(|layer| layer.id == layer_id)
            .and_then(|layer| layer.generation_id)
            .expect("published head");
        (layer_id, generation_id)
    }

    /// The one derivative of a published item, with its descriptor bounds.
    fn prepared_asset(library: &LidarLibrary, layer_id: &str) -> (PathBuf, [f64; 4]) {
        library
            .prepare_display_now(LibraryItemRole::Source, layer_id)
            .unwrap();
        let descriptor = library
            .display_descriptor(&LidarDisplayRequest {
                kind: LibraryItemRole::Source,
                entity_id: layer_id.to_string(),
                expected_generation_id: None,
                retry: false,
                relief: false,
            })
            .unwrap();
        assert_eq!(descriptor.state, LidarDisplayState::Ready, "{descriptor:?}");
        assert_eq!(descriptor.assets.len(), 1);
        let asset = &descriptor.assets[0];
        (PathBuf::from(&asset.path), asset.bounds)
    }

    /// What hover reads at each Web Mercator point: the value, or `None`
    /// for NoData.
    fn hover(
        library: &LidarLibrary,
        layer_id: &str,
        generation_id: &str,
        points: &[(f64, f64)],
    ) -> Vec<(f64, f64, Option<f64>)> {
        use common_types::lidar::{LidarSamplePointsRequest, LidarSampleSeries, LidarSampleTarget};
        let engine = library.inner.engine.as_ref();
        let cancel = AtomicBool::new(false);
        let placed: Vec<(f64, f64)> = engine
            .transform_points("EPSG:3857", "EPSG:4326", points, &cancel)
            .unwrap()
            .into_iter()
            .map(|point| point.expect("a pixel centre places in WGS84"))
            .collect();
        let series = super::super::inspection::sample_points(
            library,
            engine,
            &LidarSamplePointsRequest {
                targets: vec![LidarSampleTarget {
                    kind: LibraryItemRole::Source,
                    entity_id: layer_id.to_string(),
                    expected_generation_id: generation_id.to_string(),
                }],
                points: placed
                    .iter()
                    .map(|&(longitude, latitude)| [longitude, latitude])
                    .collect(),
            },
        )
        .unwrap();
        let LidarSampleSeries::Values { values } = &series[0] else {
            panic!("hover over {layer_id}: {series:?}");
        };
        placed
            .into_iter()
            .zip(values)
            .map(|((longitude, latitude), value)| (longitude, latitude, *value))
            .collect()
    }

    /// The centre of pixel `(column, row)` of a derivative.
    fn pixel_centre(
        probe: &super::super::engine::RasterProbe,
        column: u32,
        row: u32,
    ) -> (f64, f64) {
        let gt = probe.geotransform;
        (
            gt[0] + (f64::from(column) + 0.5) * gt[1],
            gt[3] + (f64::from(row) + 0.5) * gt[5],
        )
    }

    /// A4: at the centre of a drawn Web Mercator pixel the display shows the
    /// value hover reads there, NoData included.
    #[test]
    fn a_pixel_centre_shows_the_value_hover_reads_there() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-hover");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).expect("library opens");
        let (layer_id, generation_id) = publish_rd_item(&library, &root, "delft", 120, 80);
        let (path, _) = prepared_asset(&library, &layer_id);
        let probe = info(&library, &path.display().to_string());
        assert_eq!(probe.crs_ref, "EPSG:3857");
        let drawn = library
            .inner
            .engine
            .read_f32(&path, probe.width, probe.height, &AtomicBool::new(false))
            .unwrap();
        let pixels: Vec<(u32, u32)> = (0..probe.height)
            .step_by(3)
            .flat_map(|row| (0..probe.width).step_by(3).map(move |column| (column, row)))
            .collect();
        let centres: Vec<(f64, f64)> = pixels
            .iter()
            .map(|(column, row)| pixel_centre(&probe, *column, *row))
            .collect();
        let read = hover(&library, &layer_id, &generation_id, &centres);
        let (mut values, mut empty) = (0usize, 0usize);
        for ((column, row), (_, _, hovered)) in pixels.iter().zip(read) {
            let shown = drawn[(row * probe.width + column) as usize];
            let shown_value =
                (shown.is_finite() && Some(shown) != probe.nodata).then_some(f64::from(shown));
            assert_eq!(shown_value, hovered, "pixel ({column}, {row})");
            if hovered.is_some() {
                values += 1;
            } else {
                empty += 1;
            }
        }
        assert!(
            values > 1_000 && empty > 100,
            "{values} values, {empty} NoData"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Whether the committed fixture JSON is what the engine gives now:
    /// positions (`bounds`, a probe's `longitude` and `latitude`) within
    /// 1e-12°, since they pass through the platform's libm, which may round
    /// the last bit differently on the Windows and macOS runners; everything
    /// else, values included, exactly.
    fn same_fixture(committed: &serde_json::Value, expected: &serde_json::Value) -> bool {
        use serde_json::Value;
        fn near(a: &Value, b: &Value) -> bool {
            match (a, b) {
                (Value::Array(a), Value::Array(b)) => {
                    a.len() == b.len() && a.iter().zip(b).all(|(a, b)| near(a, b))
                }
                (Value::Number(a), Value::Number(b)) => a
                    .as_f64()
                    .zip(b.as_f64())
                    .is_some_and(|(a, b)| (a - b).abs() <= 1e-12),
                _ => a == b,
            }
        }
        match (committed, expected) {
            (Value::Object(a), Value::Object(b)) => {
                a.len() == b.len()
                    && a.iter().all(|(key, value)| {
                        b.get(key).is_some_and(|other| {
                            if matches!(key.as_str(), "bounds" | "longitude" | "latitude") {
                                near(value, other)
                            } else {
                                same_fixture(value, other)
                            }
                        })
                    })
            }
            (Value::Array(a), Value::Array(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_fixture(a, b))
            }
            _ => committed == expected,
        }
    }

    /// Positions may differ in their last bit between platforms, values and
    /// everything else may not.
    #[test]
    fn the_fixture_check_allows_last_bit_position_differences_only() {
        let committed = serde_json::json!({
            "bounds": [4.35, 52.0, 4.36, 52.01],
            "nodata": -9999.0,
            "width": 24,
            "probes": [{ "longitude": 4.355, "latitude": 52.005, "value": 3.25 }],
        });
        let next = |value: f64| serde_json::json!(f64::from_bits(value.to_bits() + 1));
        let mut moved = committed.clone();
        moved["probes"][0]["latitude"] = next(52.005);
        moved["probes"][0]["longitude"] = next(4.355);
        moved["bounds"][3] = next(52.01);
        assert!(same_fixture(&committed, &moved), "a last-bit move");
        let mut changed = committed.clone();
        changed["probes"][0]["value"] = next(3.25);
        assert!(!same_fixture(&committed, &changed), "a changed value");
        let mut shifted = committed.clone();
        shifted["probes"][0]["longitude"] = serde_json::json!(4.355_001);
        assert!(!same_fixture(&committed, &shifted), "a moved probe");
        let mut resized = committed.clone();
        resized["width"] = serde_json::json!(25);
        assert!(!same_fixture(&committed, &resized), "a resized derivative");
    }

    /// The web suite opens this derivative with the real cog-tiler-wasm
    /// (`raster-display/rust-display-cog.test.ts`) and reads the probes back,
    /// so the fixture must be what the engine writes now. Rewrite it with
    /// `CANOPI_UPDATE_FIXTURES=1`.
    #[test]
    fn the_web_display_fixture_is_what_the_engine_writes() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-fixture");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).expect("library opens");
        let (layer_id, generation_id) = publish_rd_item(&library, &root, "fixture", 24, 16);
        let (path, bounds) = prepared_asset(&library, &layer_id);
        let probe = info(&library, &path.display().to_string());
        let pixels: Vec<(u32, u32)> = (0..probe.height)
            .step_by(5)
            .flat_map(|row| (0..probe.width).step_by(5).map(move |column| (column, row)))
            .collect();
        let centres: Vec<(f64, f64)> = pixels
            .iter()
            .map(|(column, row)| pixel_centre(&probe, *column, *row))
            .collect();
        let probes: Vec<serde_json::Value> = hover(&library, &layer_id, &generation_id, &centres)
            .into_iter()
            .map(|(longitude, latitude, value)| {
                serde_json::json!({ "longitude": longitude, "latitude": latitude, "value": value })
            })
            .collect();
        let expected = serde_json::json!({
            "bounds": bounds,
            "nodata": probe.nodata,
            "width": probe.width,
            "height": probe.height,
            "probes": probes,
        });
        let fixtures =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("web/src/maplibre/raster-display/fixtures");
        let tif = fixtures.join("rust-display-cog.tif");
        let json = fixtures.join("rust-display-cog.json");
        if std::env::var_os("CANOPI_UPDATE_FIXTURES").is_some() {
            std::fs::create_dir_all(&fixtures).unwrap();
            std::fs::copy(&path, &tif).unwrap();
            std::fs::write(
                &json,
                serde_json::to_string_pretty(&expected).unwrap() + "\n",
            )
            .unwrap();
        }
        let stale =
            "the web display fixture is stale: rerun this test with CANOPI_UPDATE_FIXTURES=1";
        let committed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&json).expect(stale)).expect(stale);
        assert!(
            same_fixture(&committed, &expected),
            "{stale}\ncommitted: {committed}\nnow: {expected}"
        );
        let engine = library.inner.engine.as_ref();
        let cancel = AtomicBool::new(false);
        let committed_probe = engine.probe(&tif, &cancel).expect(stale);
        assert_eq!(
            (
                committed_probe.geotransform,
                committed_probe.crs_ref.as_str()
            ),
            (probe.geotransform, probe.crs_ref.as_str()),
            "{stale}"
        );
        let read = |raster: &Path| {
            engine
                .read_f32(raster, probe.width, probe.height, &cancel)
                .expect(stale)
                .into_iter()
                .map(f32::to_bits)
                .collect::<Vec<_>>()
        };
        assert!(read(&tif) == read(&path), "{stale}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Publish `name` from Lambert-93 planes `100 + 0.5 column + 0.25 row`
    /// (one value per 1 m cell of the whole plane), one source per column
    /// range of `columns`, listed top-first, and the paths of its prepared
    /// derivatives, top-first.
    fn publish_plane_item(
        library: &LidarLibrary,
        root: &Path,
        name: &str,
        columns: &[(u32, u32)],
        rows: u32,
    ) -> Vec<(PathBuf, [f64; 4])> {
        let engine = &library.inner.engine;
        let cancel = AtomicBool::new(false);
        let sources: Vec<PathBuf> = columns
            .iter()
            .enumerate()
            .map(|(index, (first, width))| {
                let values: Vec<f32> = (0..rows)
                    .flat_map(|row| {
                        (*first..first + width)
                            .map(move |column| 100.0 + 0.5 * column as f32 + 0.25 * row as f32)
                    })
                    .collect();
                let raw = root.join(format!("{name}-{index}.raw"));
                super::super::import::write_f32_raw(&raw, &values).unwrap();
                let source = root.join(format!("{name}-{index}.tif"));
                super::super::import::raw_to_tif(
                    engine.as_ref(),
                    &cancel,
                    &raw,
                    &source,
                    &RasterGrid {
                        width: *width,
                        height: rows,
                        geotransform: [
                            SEAM_ORIGIN.0 + f64::from(*first),
                            1.0,
                            0.0,
                            SEAM_ORIGIN.1,
                            0.0,
                            -1.0,
                        ],
                    },
                    "EPSG:2154",
                    -9999.0,
                )
                .unwrap();
                source
            })
            .collect();
        let layer_id = library
            .create_layer(name, RasterQuantity::GroundElevation, None, false)
            .unwrap();
        let job_id = library.record_import_job(&layer_id).unwrap();
        super::super::import::stage_and_publish(library, &job_id, &layer_id, &sources, &cancel)
            .unwrap();
        library
            .prepare_display_now(LibraryItemRole::Source, &layer_id)
            .unwrap();
        let descriptor = library
            .display_descriptor(&LidarDisplayRequest {
                kind: LibraryItemRole::Source,
                entity_id: layer_id,
                expected_generation_id: None,
                retry: false,
                relief: false,
            })
            .unwrap();
        assert_eq!(descriptor.state, LidarDisplayState::Ready, "{descriptor:?}");
        descriptor
            .assets
            .iter()
            .map(|asset| (PathBuf::from(&asset.path), asset.bounds))
            .collect()
    }

    /// Top-left corner of the seam fixtures' plane, Lambert-93 metres.
    const SEAM_ORIGIN: (f64, f64) = (445_000.0, 6_806_000.0);

    /// Copy `derivative` to the web fixture `name` under
    /// `CANOPI_UPDATE_FIXTURES`, and fail unless the committed file holds the
    /// same placement and samples.
    fn check_web_fixture(library: &LidarLibrary, derivative: &Path, name: &str, stale: &str) {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("web/src/maplibre/raster-display/fixtures")
            .join(name);
        if std::env::var_os("CANOPI_UPDATE_FIXTURES").is_some() {
            std::fs::create_dir_all(fixture.parent().unwrap()).unwrap();
            std::fs::copy(derivative, &fixture).unwrap();
        }
        let engine = library.inner.engine.as_ref();
        let cancel = AtomicBool::new(false);
        let probe = engine.probe(derivative, &cancel).unwrap();
        let committed = engine.probe(&fixture, &cancel).expect(stale);
        assert_eq!(
            (committed.geotransform, committed.width, committed.height),
            (probe.geotransform, probe.width, probe.height),
            "{stale}: {name}"
        );
        let read = |raster: &Path| {
            engine
                .read_f32(raster, probe.width, probe.height, &cancel)
                .expect(stale)
                .into_iter()
                .map(f32::to_bits)
                .collect::<Vec<_>>()
        };
        assert!(read(&fixture) == read(derivative), "{stale}: {name}");
    }

    /// The seam probe (canopi-f47t.49, `raster-display/display-seams.test.ts`)
    /// draws these derivatives with the real cog-tiler: an item of two
    /// adjacent Lambert-93 planes (west on top) and an item of the whole
    /// plane drawn under it, each NoData-free, wide enough for two overview
    /// levels per half. Rewrite them with `CANOPI_UPDATE_FIXTURES=1`.
    #[test]
    fn the_web_seam_fixtures_are_what_the_engine_writes() {
        let root = crate::test_scratch::TestScratch::new("canopi-seam-fixture");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).expect("library opens");
        let (half, rows) = (448u32, 96u32);
        let seam = publish_plane_item(&library, &root, "seam", &[(0, half), (half, half)], rows);
        let under = publish_plane_item(&library, &root, "under", &[(0, 2 * half)], rows);
        assert_eq!((seam.len(), under.len()), (2, 1));
        for (path, _) in seam.iter().chain(&under) {
            let probe = info(&library, &path.display().to_string());
            assert!(probe.overview_count >= 2, "{probe:?}");
        }
        let names = [
            "rust-display-seam-a.tif",
            "rust-display-seam-b.tif",
            "rust-display-seam-under.tif",
        ];
        let stale =
            "the web seam fixtures are stale: rerun this test with CANOPI_UPDATE_FIXTURES=1";
        for ((path, _), name) in seam.iter().chain(&under).zip(names) {
            check_web_fixture(&library, path, name, stale);
        }
        let zoom = super::super::rust_engine::display_zoom(
            "EPSG:2154",
            [&RasterGrid {
                width: 2 * half,
                height: rows,
                geotransform: [SEAM_ORIGIN.0, 1.0, 0.0, SEAM_ORIGIN.1, 0.0, -1.0],
            }],
        )
        .unwrap();
        let expected = serde_json::json!({
            "zoom": zoom,
            "nodata": -9999.0,
            "range": [100.0, 100.0 + 0.5 * f64::from(2 * half - 1) + 0.25 * f64::from(rows - 1)],
            "top": [
                { "asset": names[0], "bounds": seam[0].1 },
                { "asset": names[1], "bounds": seam[1].1 },
            ],
            "under": { "asset": names[2], "bounds": under[0].1 },
            "plane": {
                "crs": "EPSG:2154",
                "origin": [SEAM_ORIGIN.0, SEAM_ORIGIN.1],
                "cell": 1.0,
                "columns": 2 * half,
                "rows": rows,
                "split": half,
                "value": "100 + 0.5 column + 0.25 row",
            },
        });
        let json = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("web/src/maplibre/raster-display/fixtures/rust-display-seam.json");
        if std::env::var_os("CANOPI_UPDATE_FIXTURES").is_some() {
            std::fs::write(
                &json,
                serde_json::to_string_pretty(&expected).unwrap() + "\n",
            )
            .unwrap();
        }
        let committed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&json).expect(stale)).expect(stale);
        assert!(
            same_fixture(&committed, &expected),
            "{stale}\ncommitted: {committed}\nnow: {expected}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// RD New top-left corner of the relief fixture's 1 m plane: 640 × 160
    /// cells centred on the web display fixture's source
    /// ([`publish_rd_item`]), so the gallery's Colours round trip draws the
    /// elevation COG where it drew the relief.
    const RELIEF_ORIGIN: (f64, f64) = (84_686.0, 447_576.0);

    /// The web suite draws this relief with the real cog-tiler
    /// (`raster-display/rust-display-cog.test.ts`) at its three finest
    /// levels, and the UI gallery draws it under the web display fixture: a
    /// rolling RD New ground elevation around that fixture's source, with a
    /// NoData hole, shaded by the engine. Its bytes enter [`profile_digest_inputs`], so a
    /// shading change bumps the display profile. Rewrite it with
    /// `CANOPI_UPDATE_FIXTURES=1`.
    #[test]
    fn the_web_relief_fixture_is_what_the_engine_writes() {
        let root = crate::test_scratch::TestScratch::new("canopi-relief-fixture");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).expect("library opens");
        let cancel = AtomicBool::new(false);
        let (columns, rows) = (640u32, 160u32);
        let values: Vec<f32> = (0..rows)
            .flat_map(|row| {
                (0..columns).map(move |column| {
                    let (x, y) = (column as f32, row as f32);
                    if (x - 200.0).hypot(y - 80.0) < 28.0 {
                        -9999.0
                    } else {
                        100.0 + 8.0 * (x / 23.0).sin() + 6.0 * (y / 17.0).cos() + 0.05 * x
                    }
                })
            })
            .collect();
        let raw = root.join("relief.raw");
        super::super::import::write_f32_raw(&raw, &values).unwrap();
        let source = root.join("relief.tif");
        super::super::import::raw_to_tif(
            library.inner.engine.as_ref(),
            &cancel,
            &raw,
            &source,
            &RasterGrid {
                width: columns,
                height: rows,
                geotransform: [RELIEF_ORIGIN.0, 1.0, 0.0, RELIEF_ORIGIN.1, 0.0, -1.0],
            },
            "EPSG:28992",
            -9999.0,
        )
        .unwrap();
        let layer_id = library
            .create_layer("relief", RasterQuantity::GroundElevation, None, false)
            .unwrap();
        let job_id = library.record_import_job(&layer_id).unwrap();
        super::super::import::stage_and_publish(&library, &job_id, &layer_id, &[source], &cancel)
            .unwrap();
        library
            .prepare_display_now(LibraryItemRole::Source, &layer_id)
            .unwrap();
        let descriptor = library
            .display_descriptor(&LidarDisplayRequest {
                kind: LibraryItemRole::Source,
                entity_id: layer_id,
                expected_generation_id: None,
                retry: false,
                relief: true,
            })
            .unwrap();
        assert_eq!(descriptor.state, LidarDisplayState::Ready, "{descriptor:?}");
        let [asset] = descriptor.assets.as_slice() else {
            panic!("one relief asset: {descriptor:?}")
        };
        let probe = info(&library, &asset.path);
        assert!(probe.overview_count >= 2, "{probe:?}");
        let stale =
            "the web relief fixture is stale: rerun this test with CANOPI_UPDATE_FIXTURES=1";
        check_web_fixture(
            &library,
            Path::new(&asset.path),
            "rust-display-relief.tif",
            stale,
        );
        let zoom = super::super::rust_engine::display_zoom(
            "EPSG:28992",
            [&RasterGrid {
                width: columns,
                height: rows,
                geotransform: [RELIEF_ORIGIN.0, 1.0, 0.0, RELIEF_ORIGIN.1, 0.0, -1.0],
            }],
        )
        .unwrap();
        let expected = serde_json::json!({
            "zoom": zoom,
            "nodata": probe.nodata,
            "bounds": asset.bounds,
            "levels": probe.overview_count + 1,
        });
        let json = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("web/src/maplibre/raster-display/fixtures/rust-display-relief.json");
        if std::env::var_os("CANOPI_UPDATE_FIXTURES").is_some() {
            std::fs::write(
                &json,
                serde_json::to_string_pretty(&expected).unwrap() + "\n",
            )
            .unwrap();
        }
        let committed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&json).expect(stale)).expect(stale);
        assert!(
            same_fixture(&committed, &expected),
            "{stale}\ncommitted: {committed}\nnow: {expected}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// What decides a display pixel's place and value beyond each row's own
    /// definition: proj4rs and the Web Mercator and WGS84 rows every
    /// transform passes through, the lattice the warp gives fixed sample
    /// grids in each kind of projection at four cell sizes (its rung, edge
    /// and padding rules), and the bytes of the web fixture derivative (its
    /// sampling, mesh and file layout) and of the web relief fixture (its
    /// shading and per-level stack). A change to any must bump
    /// `DISPLAY_PROFILE` (and then the digest): derivatives written before
    /// it would otherwise be served again beside new ones. Lattices are
    /// whole pixel indices, so a last-bit difference in a platform's libm
    /// cannot change them. Other rows stay out, since a new row moves no
    /// existing pixel; each is recorded on its own in [`ROW_DIGESTS`].
    fn profile_digest_inputs() -> String {
        use super::super::rust_engine::{crs_table, display_lattice, display_zoom};
        use sha2::Digest as _;
        const HALF_WORLD: f64 = 20_037_508.342_789_244;
        // Top-left corners in native units, and a cell size unit.
        let samples = [
            ("EPSG:28992", 85_000.0, 447_500.0, 1.0),
            ("EPSG:2154", 650_000.0, 6_862_000.0, 1.0),
            ("EPSG:25833", 391_000.0, 5_820_000.0, 1.0),
            ("EPSG:32633", 500_000.0, 7_770_000.0, 1.0),
            ("EPSG:5514", -740_000.0, -1_045_000.0, 1.0),
            ("EPSG:3035", 3_900_000.0, 3_200_000.0, 1.0),
            ("EPSG:3857", 486_000.0, 6_802_000.0, 1.0),
            ("EPSG:4326", 4.35, 52.0, 1.0 / 111_320.0),
        ];
        let mut lattices = String::new();
        for (reference, x, y, unit) in samples {
            for cell in [0.5, 1.0, 5.0, 25.0] {
                let grid = RasterGrid {
                    width: 1500,
                    height: 1100,
                    geotransform: [x, cell * unit, 0.0, y, 0.0, -cell * unit],
                };
                let zoom = display_zoom(reference, [&grid]).expect("a sample has a zoom");
                let (lattice, _) =
                    display_lattice(&grid, reference, zoom).expect("a sample is placed");
                let gt = lattice.geotransform;
                let column = ((gt[0] + HALF_WORLD) / gt[1]).round() as i64;
                let row = ((HALF_WORLD - gt[3]) / gt[1]).round() as i64;
                lattices.push_str(&format!(
                    "{reference} {cell}: z{zoom} {column} {row} {} {}\n",
                    lattice.width, lattice.height
                ));
            }
        }
        let fixture = |name: &str| {
            let bytes = std::fs::read(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("web/src/maplibre/raster-display/fixtures")
                    .join(name),
            )
            .expect("the web display fixtures");
            sha2::Sha256::digest(&bytes)
        };
        format!(
            "{:?}|{:?}|proj4rs {}|{lattices}|fixture {:x}|relief {:x}",
            crs_table::row_of(3857),
            crs_table::row_of(4326),
            super::super::rust_engine::PROJ4RS_VERSION,
            fixture("rust-display-cog.tif"),
            fixture("rust-display-relief.tif")
        )
    }

    /// U31: adding a code later is one row plus a reference point. A row
    /// moves no pixel of any other row's derivatives, so it stays out of the
    /// profile digest, and adding one never regenerates every library's
    /// display derivatives.
    #[test]
    fn a_crs_row_added_later_leaves_the_display_profile_alone() {
        use super::super::rust_engine::crs_table;
        let inputs = profile_digest_inputs();
        for row in crs_table::ROWS
            .iter()
            .filter(|row| ![3857, 4326].contains(&row.code))
        {
            assert!(
                !inputs.contains(row.proj),
                "EPSG:{} enters the display profile digest",
                row.code
            );
        }
    }

    /// Each readable code (rows and aliases) with the first 16 hex digits
    /// of the SHA-256 of the PROJ definition it is read with, as recorded
    /// under `DISPLAY_PROFILE`. A new code adds a line; an edited one moves
    /// pixels in derivatives users already have, so it bumps the profile.
    const ROW_DIGESTS: &str = "\
2056 299374e00df0843b
2100 4d3c4277d45710eb
2154 6f46dcd489d2aa67
2169 2717ba968a395c0d
2972 f1aeba19af41bbd3
2975 6bff6f711311c136
3035 743cbe1b4e3347df
3812 d63f383e5337736d
3857 00ec30c2eb6aa0a6
3942 8eca8f35f82dedb2
3943 3d53495cd228b4f7
3944 55afb61416b01786
3945 a0dcb0c7334f98b8
3946 c21003c2afed0c5d
3947 cf5bd4e0406003b3
3948 83d09ac7c306c754
3949 1dd822049d6bcb4c
3950 c9c156976d566b00
4171 1b8468790c7a0b42
4258 1b8468790c7a0b42
4326 88239a63bf06662a
4471 84411064ff67da9a
4559 6ab54543cbf94783
5490 6ab54543cbf94783
5514 abc8796d8e59a6f0
5698 6f46dcd489d2aa67
5699 6f46dcd489d2aa67
7415 a8b6ae08039fdc9e
21781 87c280362e8e310d
25828 9c865d877836d9e2
25829 b8fa5243a310ed34
25830 c6811a6321f1d601
25831 e928142a05b9a7ed
25832 a7fc0cbd6f210359
25833 d5b7d9b7d5305c89
25834 14c80471fa3fd33b
25835 41c90776dcad89f0
25836 8658975f732fcc6f
25837 351b88d9e55367be
25838 2210b236dbea82f6
27572 5d2807918bb8f426
27700 f0b39268d10f88ca
28992 a8b6ae08039fdc9e
31287 26aa002814c76c58
31370 c488995a6e11d34c
32601 6ca7c6de52a2cd96
32602 3cfae13bc5729eaa
32603 1def0cac9ef9fce4
32604 269158898e087ee3
32605 127d981e5fe9b68c
32606 157acf2234bf4471
32607 97135e2f4822c8f1
32608 69458294f75d0bb4
32609 e96db910a95e5c85
32610 e240383c11a156c2
32611 d25d0242aff9ecfa
32612 dba0c69497ff16f5
32613 f0c01871954ea3f2
32614 75596be93acbf13b
32615 9dca60c9a992bf74
32616 df322022bd3fb02b
32617 1b398697acf02751
32618 028c9e724a0e1de7
32619 70d586bd6896c797
32620 b7162c880d1f92a4
32621 62b79385619f535e
32622 4aa230b9266b1e1b
32623 fb7cd3519d640bb7
32624 f0249443521a9691
32625 8d6f106ff5c4f8dd
32626 129b27e7d488b614
32627 d1901902896ac420
32628 ba3526568356b2d7
32629 7ebc6ebff2b2adc5
32630 6e615b79c3da0c94
32631 d26c0354a6b514f4
32632 c63ba2239d1d6ea3
32633 46f994704f0c11d4
32634 80a189a18cdb5100
32635 7645c73e6caba198
32636 aa7bc2849f32e299
32637 8d4bf53f0c4594f0
32638 18f301abe3901ff5
32639 898398358c57fb0e
32640 6b017f4b59c70fd8
32641 577dcee5784bbb52
32642 22f8b3afd36816e5
32643 382e716b590fe613
32644 03fca9b2d4948fe2
32645 ee4a7c0690e91e70
32646 e89559f5cd86228f
32647 6e258504bba7e71d
32648 9b9ab6902ee321b0
32649 1398ec9ee40f07ed
32650 058c3eabe5714255
32651 fdb16ce4a89aa392
32652 f3b40d2addd46e17
32653 62dc8d4c983e8cc7
32654 506d40f1e99a1462
32655 87f1375587266407
32656 2711d138c758bd4c
32657 66924886430b7be4
32658 67125e3332cd5f6e
32659 27a1e553fd6e6a40
32660 77ea6ad19b6c72f5
32701 257895543bf23fc8
32702 e3a78cb299975ab9
32703 3b188721d7c44d4e
32704 4678ed1863661d5f
32705 6f60226226369fee
32706 d6b5a421c2e622a6
32707 c953f53d82464451
32708 7f4f44f2ce254e49
32709 53d55e131c41dbe3
32710 56165b4ab2b35130
32711 5d68607659943b33
32712 30eda9f07f6ca830
32713 0697e74b3fc8915b
32714 8697ebbb7d5b549b
32715 e8bd31ed39d2b7e3
32716 8bfa602b88a8d372
32717 6cfdc7a0c93555f4
32718 81e898d02981e939
32719 81a91fb4ce03e2a8
32720 64e61e6c0520dda5
32721 9ff3cdf277b582f1
32722 efaf52eafb5deb63
32723 7d156766a2c18fc1
32724 e5ae864b91f141d8
32725 a781a64ce312042f
32726 e014df21f9f3d20f
32727 164f8a2e6f71ab70
32728 74634fe8d8be4424
32729 65c77102467fb598
32730 8b8b55204641aa0d
32731 d737ee833137a69a
32732 acb0d5fa1b1ab390
32733 045b4ec6317f4119
32734 aee61e30e085e1f6
32735 e082169ec96f80f9
32736 f543c886d145e8f4
32737 d7a2e7bd3b717aba
32738 716767141b066e76
32739 97573a5a5bd22d62
32740 01313080446c9665
32741 256eb6ac2ec27109
32742 544bed981a577078
32743 762b2bd3be29bfa5
32744 32aa236e2f1f5f43
32745 8391a4b277f01d0a
32746 2819f422a1325a97
32747 a3d9ed3405becfde
32748 5eac432ba2c6f002
32749 6c9965affd1f82f5
32750 41446ec67ba32508
32751 8ab1146f9976f68f
32752 6ffe971d672ee8fd
32753 281be5d365d2082e
32754 b738e7e4b6ffc649
32755 dba577848a963f17
32756 217c481d865c02fb
32757 ddc7d755aaeb3ffc
32758 64662f6a70656250
32759 e7927d716867803a
32760 2202ccee0a176760
";

    /// The current `code digest` lines of every readable code.
    fn current_row_digests() -> BTreeMap<u32, String> {
        use super::super::rust_engine::crs_table;
        use sha2::Digest as _;
        crs_table::ROWS
            .iter()
            .map(|row| row.code)
            .chain(crs_table::ALIASES.iter().map(|(alias, _)| *alias))
            .map(|code| {
                let proj = crs_table::row_of(code).expect("a readable code").proj;
                let digest = format!("{:x}", sha2::Sha256::digest(proj.as_bytes()));
                (code, digest[..16].to_string())
            })
            .collect()
    }

    /// Codes whose definition changed since it was recorded, codes with no
    /// record yet, and records of codes no longer read.
    fn row_digest_changes(
        recorded: &str,
        current: &BTreeMap<u32, String>,
    ) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
        let recorded: BTreeMap<u32, &str> = recorded
            .lines()
            .filter_map(|line| line.split_once(' '))
            .map(|(code, digest)| (code.parse().expect("a recorded code"), digest))
            .collect();
        let edited = current
            .iter()
            .filter(|(code, digest)| recorded.get(code).is_some_and(|d| d != digest))
            .map(|(code, _)| *code)
            .collect();
        let added = current
            .keys()
            .filter(|code| !recorded.contains_key(code))
            .copied()
            .collect();
        let removed = recorded
            .keys()
            .filter(|code| !current.contains_key(code))
            .copied()
            .collect();
        (edited, added, removed)
    }

    #[test]
    fn an_edited_crs_row_is_told_apart_from_an_added_or_removed_one() {
        let current = BTreeMap::from([
            (2154, "aaaa".to_string()),
            (28992, "bbbb".to_string()),
            (32633, "cccc".to_string()),
        ]);
        assert_eq!(
            row_digest_changes("2154 aaaa\n28992 ffff\n4559 dddd\n", &current),
            (vec![28992], vec![32633], vec![4559])
        );
    }

    /// The display profile digest leaves CRS rows out so a new code needs
    /// no bump; an edited row or a re-pointed alias moves the pixels of its
    /// items' derivatives, so it must bump `DISPLAY_PROFILE`.
    #[test]
    fn an_edited_crs_row_bumps_the_display_profile() {
        let current = current_row_digests();
        let (edited, added, removed) = row_digest_changes(ROW_DIGESTS, &current);
        let table: String = current
            .iter()
            .map(|(code, digest)| format!("{code} {digest}\n"))
            .collect();
        assert!(
            edited.is_empty(),
            "the definition of {edited:?} changed: bump DISPLAY_PROFILE, then record \
             ROW_DIGESTS as:\n{table}"
        );
        assert!(
            added.is_empty() && removed.is_empty(),
            "codes {added:?} added and {removed:?} removed: record ROW_DIGESTS as \
             (no profile bump):\n{table}"
        );
    }

    /// The profile names everything in [`profile_digest_inputs`].
    #[test]
    fn the_profile_records_what_places_and_draws_display_pixels() {
        use sha2::Digest as _;
        let inputs = profile_digest_inputs();
        let digest = format!("{:x}", sha2::Sha256::digest(inputs.as_bytes()));
        assert_eq!(
            (DISPLAY_PROFILE, digest.as_str()),
            (DISPLAY_PROFILE, DISPLAY_PROFILE_DIGEST),
            "display placement or drawing changed: bump DISPLAY_PROFILE, then record the new digest"
        );
    }
}

#[cfg(test)]
mod chunk_display_tests {
    use super::library_tests::{info, plane_source};
    use super::*;
    use common_types::library::RasterQuantity;

    /// A published slope result whose chunks the caller then writes.
    fn seed_chunk_result(library: &LidarLibrary, item_id: &str, generation_id: &str) {
        let connection = library.catalogue().unwrap();
        connection
            .execute(
                "INSERT INTO lidar_source_layers(id, name, item_kind, quantity, units, created_at)
                 VALUES (?1, 'Source', 'raster', 'ground-elevation', 'm', '0')",
                [format!("lyr-{item_id}")],
            )
            .unwrap();
        super::super::analyses::test_support::seed_published_slope(
            &connection,
            &format!("lyr-{item_id}"),
            "gen-source",
            &format!("adef-{item_id}"),
            item_id,
            generation_id,
            None,
        );
    }

    /// A chunked derived result displays from one part per group of occupied
    /// chunks: distant coverage produces two small parts, never one raster
    /// spanning the empty space between them.
    #[test]
    fn distant_result_chunks_display_as_separate_parts_without_the_gap() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-chunks");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).unwrap();
        seed_chunk_result(&library, "item-far", "dgen-far");
        let near: Vec<f32> = (0..16)
            .map(|index| if index == 5 { f32::NAN } else { 1.0 })
            .collect();
        let far = vec![2.0f32; 16];
        generation::publish_test_chunk(&library, "dgen-far", 0, 0, 4, 4, &near);
        generation::publish_test_chunk(&library, "dgen-far", 300, 0, 4, 4, &far);

        library
            .prepare_display_now(LibraryItemRole::Derived, "item-far")
            .unwrap();
        let descriptor = library
            .display_descriptor(&LidarDisplayRequest {
                kind: LibraryItemRole::Derived,
                entity_id: "item-far".to_string(),
                expected_generation_id: Some("dgen-far".to_string()),
                retry: false,
                relief: false,
            })
            .unwrap();
        assert_eq!(descriptor.state, LidarDisplayState::Ready, "{descriptor:?}");
        assert_eq!(descriptor.assets.len(), 2, "one part per distant group");
        for asset in &descriptor.assets {
            let info = library
                .inner
                .engine
                .probe(Path::new(&asset.path), &AtomicBool::new(false))
                .unwrap();
            // One 1024 m chunk near the equator spans about 0.0092 degrees.
            let [west, south, east, north] = asset.bounds;
            assert!(
                east - west < 0.0095 && north - south < 0.0095,
                "a part covers its own chunk only: {:?}",
                asset.bounds
            );
            // A probe reports the tag at Float32 precision; the renderer parses
            // the TIFF tag itself, so check the stored text round-trips.
            assert_eq!(
                info.nodata,
                Some(DISPLAY_NODATA),
                "invalid cells use the display sentinel"
            );
            assert_eq!(
                stored_nodata_tag(&asset.path),
                Some(f64::from(DISPLAY_NODATA))
            );
        }
        // The far part starts 300 chunks east of the near one.
        let west: Vec<f64> = descriptor
            .assets
            .iter()
            .map(|asset| asset.bounds[0])
            .collect();
        assert!(west[1] > west[0], "{west:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The GDAL_NODATA TIFF tag text, parsed as the WASM renderer parses it.
    fn stored_nodata_tag(path: &str) -> Option<f64> {
        let bytes = std::fs::read(path).ok()?;
        let text = String::from_utf8_lossy(&bytes);
        text.split('\0')
            .filter(|chunk| chunk.contains('e') && chunk.starts_with('-'))
            .find_map(|chunk| chunk.trim().parse::<f64>().ok())
    }

    /// A derivative that cannot be written leaves a failed, retryable display
    /// state; the numeric generation is untouched and a retry succeeds once
    /// space returns.
    #[test]
    fn a_failed_derivative_write_is_retryable_and_publishes_nothing_partial() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-capacity");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).unwrap();
        seed_chunk_result(&library, "item-cap", "dgen-cap");
        generation::publish_test_chunk(&library, "dgen-cap", 0, 0, 4, 4, &[1.0; 16]);

        {
            let _full = super::super::paths::capacity_probe::override_available(1024);
            let error = library
                .prepare_display_now(LibraryItemRole::Derived, "item-cap")
                .unwrap_err();
            assert!(error.contains("needs at least"), "{error}");
        }
        assert!(
            std::fs::read_dir(library.inner.paths.display_cog_dir())
                .unwrap()
                .next()
                .is_none(),
            "nothing partial is published"
        );
        assert!(
            std::fs::read_dir(library.inner.paths.display_cog_staging_dir())
                .unwrap()
                .next()
                .is_none(),
            "the failed write left no staging file"
        );
        library
            .prepare_display_now(LibraryItemRole::Derived, "item-cap")
            .unwrap();
        let ready = library
            .display_descriptor(&LidarDisplayRequest {
                kind: LibraryItemRole::Derived,
                entity_id: "item-cap".to_string(),
                expected_generation_id: None,
                retry: false,
                relief: false,
            })
            .unwrap();
        assert_eq!(ready.state, LidarDisplayState::Ready);
        assert_eq!(ready.assets.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A plan's identity: each variant has its own key, and every key of an
    /// entity starts with its prefix, which another entity's never does.
    #[test]
    fn each_variant_of_an_entity_plan_has_its_own_key_inside_the_entity_prefix() {
        let elevation = plan_key(LibraryItemRole::Source, "lyr-a", "gen-1", false);
        let relief = plan_key(LibraryItemRole::Source, "lyr-a", "gen-1", true);
        assert_ne!(elevation, relief);
        let prefix = entity_plan_prefix(LibraryItemRole::Source, "lyr-a");
        assert!(elevation.starts_with(&prefix) && relief.starts_with(&prefix));
        assert!(!plan_key(LibraryItemRole::Source, "lyr-ab", "gen-1", false).starts_with(&prefix));
        assert!(!plan_key(LibraryItemRole::Derived, "lyr-a", "gen-1", false).starts_with(&prefix));
        assert!(asset_key("sha", Some(-9999.0), 17).starts_with(&asset_prefix("sha")));
    }

    /// Forgetting one generation's prefix removes its derivatives' rows and
    /// files, and leaves another generation's.
    #[test]
    fn forgetting_a_generation_prefix_frees_only_its_derivatives() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-forget-gen");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).unwrap();
        for (item, generation_id) in [("item-a", "dgen-a"), ("item-b", "dgen-b")] {
            seed_chunk_result(&library, item, generation_id);
            generation::publish_test_chunk(&library, generation_id, 0, 0, 4, 4, &[1.0; 16]);
            library
                .prepare_display_now(LibraryItemRole::Derived, item)
                .unwrap();
        }
        let keys = registered_derivative_keys(&library).unwrap();
        assert_eq!(keys.len(), 2, "{keys:?}");
        assert!(
            keys.iter()
                .any(|key| key.starts_with(&gen_prefix("dgen-a")))
        );
        let files = |library: &LidarLibrary| {
            std::fs::read_dir(library.inner.paths.display_cog_dir())
                .unwrap()
                .count()
        };
        assert_eq!(files(&library), 2);

        forget_derivatives(&library, &gen_prefix("dgen-a")).unwrap();
        let kept = registered_derivative_keys(&library).unwrap();
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert!(kept[0].starts_with(&gen_prefix("dgen-b")), "{kept:?}");
        assert_eq!(files(&library), 1);
        drop(library);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Forgetting an entity's plans drops its queued plans, pending marks and
    /// failures of every variant, and keeps another entity's.
    #[test]
    fn forgetting_an_entitys_plans_drops_its_queue_and_failures_only() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-forget-plans");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).unwrap();
        let cancel = AtomicBool::new(false);
        for (item, generation_id) in [("item-a", "dgen-a"), ("item-b", "dgen-b")] {
            seed_chunk_result(&library, item, generation_id);
            generation::publish_test_chunk(&library, generation_id, 0, 0, 4, 4, &[1.0; 16]);
            let Planned::Plan(plan) =
                build_plan(&library, LibraryItemRole::Derived, item, false, &cancel).unwrap()
            else {
                panic!("a published result has a plan")
            };
            let mut state = library.display_preparation().unwrap();
            let key = plan_key(plan.kind, &plan.entity_id, &plan.generation_id, false);
            state.plans.insert(key.clone(), Arc::clone(&plan));
            state.pending.insert(key.clone());
            state.queue.push_back(plan);
            state.failures.insert(key, "failed".to_string());
            state.failures.insert(
                plan_key(LibraryItemRole::Derived, item, generation_id, true),
                "failed".to_string(),
            );
        }

        library
            .forget_entity_plans(LibraryItemRole::Derived, "item-a")
            .unwrap();
        let state = library.display_preparation().unwrap();
        let kept = entity_plan_prefix(LibraryItemRole::Derived, "item-b");
        assert_eq!(state.queue.len(), 1);
        assert_eq!(state.queue[0].entity_id, "item-b");
        for keys in [
            state.plans.keys().collect::<Vec<_>>(),
            state.pending.iter().collect(),
            state.failures.keys().collect(),
        ] {
            assert!(
                !keys.is_empty() && keys.iter().all(|key| key.starts_with(&kept)),
                "{keys:?}"
            );
        }
        assert_eq!(state.failures.len(), 2);
        drop(state);
        drop(library);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A published ground elevation from one plane source, its id and generation.
    fn publish_ground(library: &LidarLibrary, root: &Path, name: &str) -> (String, String) {
        publish_ground_at(library, root, name, 445_000.0)
    }

    /// [`publish_ground`] from a plane at `origin_x`, so its content differs.
    fn publish_ground_at(
        library: &LidarLibrary,
        root: &Path,
        name: &str,
        origin_x: f64,
    ) -> (String, String) {
        let cancel = AtomicBool::new(false);
        let source = plane_source(library, root, name, origin_x);
        let layer_id = library
            .create_layer(name, RasterQuantity::GroundElevation, None, false)
            .unwrap();
        let job_id = library.record_import_job(&layer_id).unwrap();
        super::super::import::stage_and_publish(library, &job_id, &layer_id, &[source], &cancel)
            .unwrap();
        let generation_id = library
            .library_snapshot()
            .unwrap()
            .items
            .into_iter()
            .find(|layer| layer.id == layer_id)
            .and_then(|layer| layer.generation_id)
            .expect("published head");
        (layer_id, generation_id)
    }

    fn ask(
        library: &LidarLibrary,
        kind: LibraryItemRole,
        entity_id: &str,
        relief: bool,
    ) -> Result<LidarDisplayDescriptor, String> {
        library.display_descriptor(&LidarDisplayRequest {
            kind,
            entity_id: entity_id.to_string(),
            expected_generation_id: None,
            retry: false,
            relief,
        })
    }

    // The relief user paths (canopi-2add). These tests have no executor:
    // `prepare_display_now` prepares an elevation's values and relief.

    /// A ground elevation asked for its relief gets its own derivative, keyed
    /// apart from the elevation one, holding greys 1–255 and the display
    /// NoData.
    #[test]
    fn a_ground_elevation_asked_with_relief_draws_its_own_grey_derivative() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-relief");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).unwrap();
        let (layer_id, _) = publish_ground(&library, &root, "tile");
        library
            .prepare_display_now(LibraryItemRole::Source, &layer_id)
            .unwrap();
        let elevation = ask(&library, LibraryItemRole::Source, &layer_id, false).unwrap();
        let relief = ask(&library, LibraryItemRole::Source, &layer_id, true).unwrap();
        assert_eq!(elevation.state, LidarDisplayState::Ready, "{elevation:?}");
        assert_eq!(relief.state, LidarDisplayState::Ready, "{relief:?}");
        assert!(relief.relief && !elevation.relief);
        assert_eq!(relief.assets.len(), 1);
        assert_ne!(
            relief.assets[0].path, elevation.assets[0].path,
            "the relief is its own derivative"
        );
        let keys = registered_derivative_keys(&library).unwrap();
        assert!(keys.iter().any(|key| key.ends_with("-relief")), "{keys:?}");
        let probe = info(&library, &relief.assets[0].path);
        let values = library
            .inner
            .engine
            .read_f32(
                Path::new(&relief.assets[0].path),
                probe.width,
                probe.height,
                &AtomicBool::new(false),
            )
            .unwrap();
        assert!(values.iter().any(|value| *value != DISPLAY_NODATA));
        assert!(
            values.iter().all(|value| *value == DISPLAY_NODATA
                || (value.fract() == 0.0 && (1.0..=255.0).contains(value))),
            "greys 1–255 or the display NoData"
        );
        drop(library);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A failed relief plan is the relief's own: the elevation stays Ready.
    #[test]
    fn a_failed_relief_plan_leaves_the_elevation_ready() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-relief-failed");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).unwrap();
        let (layer_id, generation_id) = publish_ground(&library, &root, "tile");
        library
            .prepare_display_now(LibraryItemRole::Source, &layer_id)
            .unwrap();
        for key in registered_derivative_keys(&library).unwrap() {
            if key.ends_with("-relief") {
                forget_derivatives(&library, &key).unwrap();
            }
        }
        library.display_preparation().unwrap().failures.insert(
            plan_key(LibraryItemRole::Source, &layer_id, &generation_id, true),
            "the relief failed".to_string(),
        );
        let relief = ask(&library, LibraryItemRole::Source, &layer_id, true).unwrap();
        assert_eq!(relief.state, LidarDisplayState::Failed, "{relief:?}");
        let elevation = ask(&library, LibraryItemRole::Source, &layer_id, false).unwrap();
        assert_eq!(elevation.state, LidarDisplayState::Ready, "{elevation:?}");
        drop(library);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Relief and elevation asked for together queue two plans: neither is
    /// lost to the other's pending mark.
    #[test]
    fn relief_and_elevation_asked_together_are_both_queued() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-relief-queue");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).unwrap();
        let (layer_id, generation_id) = publish_ground(&library, &root, "tile");
        // Without an executor each request leaves its plan queued.
        let _ = ask(&library, LibraryItemRole::Source, &layer_id, false);
        let _ = ask(&library, LibraryItemRole::Source, &layer_id, true);
        let state = library.display_preparation().unwrap();
        for relief in [false, true] {
            let key = plan_key(LibraryItemRole::Source, &layer_id, &generation_id, relief);
            assert!(state.pending.contains(&key), "{key} is queued");
        }
        assert_eq!(state.queue.len(), 2);
        drop(state);
        drop(library);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// canopi-44vf: Delete drops the item's display plans still queued (here
    /// Colours asked just before Delete), so when the worker next runs
    /// nothing registers or writes for the deleted item, before or after
    /// reopening.
    #[test]
    fn deleting_an_item_with_a_queued_display_plan_leaves_nothing_after_the_worker_runs() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-delete-queued");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).unwrap();
        let (deleted, _) = publish_ground_at(&library, &root, "deleted", 445_000.0);
        let (kept, _) = publish_ground_at(&library, &root, "kept", 452_000.0);
        // Without an executor the request leaves its plan queued.
        let _ = ask(&library, LibraryItemRole::Source, &deleted, false);
        let queued_keys: Vec<String> = {
            let state = library.display_preparation().unwrap();
            assert_eq!(state.queue.len(), 1, "the plan is queued");
            state.queue[0]
                .parts
                .iter()
                .map(|part| part.key.clone())
                .collect()
        };
        assert!(!queued_keys.is_empty());

        library.delete_item(&deleted).unwrap();
        {
            let prefix = entity_plan_prefix(LibraryItemRole::Source, &deleted);
            let state = library.display_preparation().unwrap();
            assert!(
                state.queue.iter().all(|plan| plan.entity_id != deleted)
                    && state.plans.keys().all(|key| !key.starts_with(&prefix))
                    && state.pending.iter().all(|key| !key.starts_with(&prefix)),
                "Delete drops the queued plan"
            );
        }

        // The worker starts with the next request and drains the queue in
        // order, so once the kept item is ready any leftover plan has run.
        library.attach_executor(crate::native_operation::NativeOperationExecutor::production());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let ready = loop {
            let descriptor = ask(&library, LibraryItemRole::Source, &kept, false).unwrap();
            if descriptor.state == LidarDisplayState::Ready {
                break descriptor;
            }
            assert_ne!(
                descriptor.state,
                LidarDisplayState::Failed,
                "{descriptor:?}"
            );
            assert!(std::time::Instant::now() < deadline, "{descriptor:?}");
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        let kept_files: std::collections::BTreeSet<PathBuf> = ready
            .assets
            .iter()
            .map(|asset| PathBuf::from(&asset.path))
            .collect();
        let display_files = |library: &LidarLibrary| -> std::collections::BTreeSet<PathBuf> {
            std::fs::read_dir(library.inner.paths.display_cog_dir())
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| path.is_file())
                .collect()
        };
        let leaked = |library: &LidarLibrary| -> Vec<String> {
            registered_derivative_keys(library)
                .unwrap()
                .into_iter()
                .filter(|key| queued_keys.contains(key))
                .collect()
        };
        assert_eq!(leaked(&library), Vec::<String>::new());
        assert_eq!(display_files(&library), kept_files);

        let held = Arc::downgrade(&library.inner);
        drop(library);
        while held.strong_count() > 0 {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let reopened = LidarLibrary::open(&root).unwrap();
        assert_eq!(leaked(&reopened), Vec::<String>::new());
        assert_eq!(display_files(&reopened), kept_files);
        drop(reopened);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// D8: the import prepares the kind's default view, so a new ground
    /// elevation draws its relief at once; Colours is prepared the first time
    /// it is asked for.
    #[test]
    fn a_new_ground_elevation_draws_relief_at_once_and_colours_on_first_pick() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-relief-import");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).unwrap();
        let cancel = AtomicBool::new(false);
        let source = plane_source(&library, &root, "tile", 445_000.0);
        let layer_id = library
            .create_layer("tile", RasterQuantity::GroundElevation, None, false)
            .unwrap();
        let job_id = library.record_import_job(&layer_id).unwrap();
        super::super::import::stage_import(&library, &job_id, &layer_id, &[source], &cancel)
            .unwrap();
        let staging = super::super::import::read_staged_import(&library, &job_id).unwrap();
        library.prepare_staged_display(&staging, &cancel).unwrap();
        super::super::import::apply_import(&library, &staging, &cancel).unwrap();

        let relief = ask(&library, LibraryItemRole::Source, &layer_id, true)
            .expect("the relief is ready without a preparation");
        assert_eq!(relief.state, LidarDisplayState::Ready, "{relief:?}");
        let keys = registered_derivative_keys(&library).unwrap();
        assert!(
            !keys.is_empty() && keys.iter().all(|key| key.ends_with("-relief")),
            "the import prepared the relief only: {keys:?}"
        );
        let generation_id = relief.generation_id.clone().unwrap();
        let _ = ask(&library, LibraryItemRole::Source, &layer_id, false);
        assert!(
            library
                .display_preparation()
                .unwrap()
                .pending
                .contains(&plan_key(
                    LibraryItemRole::Source,
                    &layer_id,
                    &generation_id,
                    false
                )),
            "Colours is prepared on its first request"
        );
        drop(library);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// No analysis outputs an elevation in 2.0, so a derived item has no
    /// relief to draw.
    #[test]
    fn a_derived_item_asked_for_relief_is_unavailable() {
        let root = crate::test_scratch::TestScratch::new("canopi-display-relief-derived");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).unwrap();
        seed_chunk_result(&library, "item-slope", "dgen-slope");
        generation::publish_test_chunk(&library, "dgen-slope", 0, 0, 4, 4, &[1.0; 16]);
        library
            .prepare_display_now(LibraryItemRole::Derived, "item-slope")
            .unwrap();
        let relief = ask(&library, LibraryItemRole::Derived, "item-slope", true).unwrap();
        assert_eq!(relief.state, LidarDisplayState::Unavailable, "{relief:?}");
        drop(library);
        let _ = std::fs::remove_dir_all(&root);
    }
}
