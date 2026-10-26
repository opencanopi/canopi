//! Import staging and publication for source items.
//!
//! Each selected source is probed, validated and prepared as a retained COG
//! whose valid cells and range are measured once. The raster engine performs format
//! conversion and georeferencing only. Catalogue locks are held only for short
//! reads and the publish transaction — never during raster computation.
//! Publication is atomic: promoted assets, the ordered members and the item's
//! only head commit in one transaction.

use super::LidarLibrary;
use super::admission;
use super::catalogue::{self, new_id, now_iso};
use super::collection;
use super::engine::{RasterEngine, RasterGeoref};
use super::generation::{self};
use super::grid::{self, GeoTransform, RasterGrid, union_grid};
use super::paths::LidarPaths;
use super::prepared_raster::PreparedRaster;
#[cfg(test)]
use super::prepared_raster::RasterWindow;
use common_types::lidar::{
    LidarImportProgressPhase, LidarImportRefusal, LidarImportRefusalReason as Reason,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

/// Canonical NoData used for a layer whose first source declares none.
pub const FALLBACK_NODATA: f32 = -99999.0;
/// Most cells one whole-raster read into memory may hold (analysis blocks,
/// test oracles, and the conversions that cannot stream: formats other than
/// GeoTIFF and GeoTIFFs with one huge compressed chunk). It is also the row
/// window budget of a streamed conversion. Item reads never materialize a
/// whole raster.
pub(crate) const MAX_RAW_EXTRACTION_CELLS: u64 = 25_000_000;

/// The whole-raster limit in force on this thread: the production constant,
/// or the lower bound a test installed through [`extraction_limit_probe`].
pub(crate) fn raw_extraction_cells() -> u64 {
    #[cfg(test)]
    if let Some(cells) = extraction_limit_probe::overridden() {
        return cells;
    }
    MAX_RAW_EXTRACTION_CELLS
}

#[cfg(test)]
thread_local! {
    static EXTRACTION_LIMIT: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

/// Test-only seam for the whole-raster limit, thread-local like
/// `admission::limits_probe`, so a lowered limit reaches only its own test.
#[cfg(test)]
pub(crate) mod extraction_limit_probe {
    pub(crate) fn overridden() -> Option<u64> {
        super::EXTRACTION_LIMIT.with(std::cell::Cell::get)
    }

    /// Hold the limit at `cells` until the guard is dropped.
    pub(crate) fn set(cells: u64) -> Guard {
        super::EXTRACTION_LIMIT.with(|slot| slot.set(Some(cells)));
        Guard
    }

    pub(crate) struct Guard;

    impl Drop for Guard {
        fn drop(&mut self) {
            super::EXTRACTION_LIMIT.with(|slot| slot.set(None));
        }
    }
}

/// What reading an item's sources costs: each source across its full native
/// grid. NoData is charged too, because a mostly-NoData source still costs
/// decoding work; the count is work accounting, not a coverage measurement.
fn ordered_processing_cost(
    incoming: &[&StagedSource],
) -> Result<Vec<admission::ProcessingCost>, String> {
    Ok(incoming
        .iter()
        .map(|source| admission::ProcessingCost {
            width: source.width,
            height: source.height,
        })
        .collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StagedSource {
    pub filename: String,
    pub sha256: String,
    pub managed_original: PathBuf,
    pub interp_hash: String,
    pub width: u32,
    pub height: u32,
    pub geotransform: GeoTransform,
    pub crs_ref: String,
    pub nodata: Option<f32>,
    pub value_range: [f64; 2],
    pub size_bytes: u64,
    /// The staged job that owns this source's prepared bytes.
    pub job_id: String,
    /// The retained controlled source COG this interpretation reads from.
    pub source_cog: RetainedSourceCog,
    /// Valid cells the prepared source actually holds, so the batch can refuse
    /// an all-NoData member by name.
    pub valid_cells: u64,
    pub compatible: bool,
    pub issues: Vec<String>,
}

/// One retained controlled source COG, as a staged job records it.
///
/// The digest names the immutable content-addressed asset; the grid lives on
/// the staged source itself, and the effective NoData is this source's own
/// rule, never another member's sentinel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RetainedSourceCog {
    pub sha256: String,
    pub bytes: u64,
    pub nodata: Option<f32>,
    pub value_range: [f64; 2],
    /// Location relative to the owning job's root while the job is unpublished.
    pub relative_path: String,
}

impl RetainedSourceCog {
    /// Resolve this retained COG's readable path under the owning job root;
    /// the digest is identity, never proof that a global file exists.
    pub(super) fn resolve(&self, paths: &LidarPaths, job_id: &str) -> Result<PathBuf, String> {
        let relative = &self.relative_path;
        resolve_under_root(&paths.job_dir(job_id), relative).map_err(|error| {
            format!("staged source COG location {relative} escapes its job root: {error}")
        })
    }
}

/// The share of a job's one progress bar that preparation fills; publication
/// carries on from it, so the percentage only rises across the whole job.
/// Publication's own steps (rendering the map, then [`apply_import`]) sit
/// above it.
const PREPARATION_SHARE: usize = 40;

/// Advance a preparing job once `converted` of its `total` sources are
/// converted, under the existing "Preparing raster" phase, within
/// [`PREPARATION_SHARE`].
fn record_staging_progress(library: &LidarLibrary, job_id: &str, converted: usize, total: usize) {
    let percent = (converted.min(total) * PREPARATION_SHARE / total.max(1)) as u8;
    library.record_import_progress(job_id, LidarImportProgressPhase::PreparingRaster, percent);
}

/// Move a prepared job to publishing, at the end of preparation's share and
/// under "Rendering map", publication's first step (the display derivative).
///
/// Guarded on the staging state so a job that was cancelled while it prepared
/// stays cancelled and its publication is refused.
fn mark_publishing(library: &LidarLibrary, job_id: &str) -> Result<(), String> {
    let connection = library.catalogue()?;
    connection
        .execute(
            "UPDATE lidar_import_jobs
             SET state = 'applying', message = NULL,
                 progress_phase = ?2, progress_percent = ?3,
                 updated_at = ?4
             WHERE id = ?1 AND state = 'staging'",
            rusqlite::params![
                job_id,
                super::import_progress_phase_key(LidarImportProgressPhase::RenderingMap),
                PREPARATION_SHARE as i64,
                catalogue::now_iso()
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Read the staged payload one job wrote during preparation.
///
/// The payload is the job's own record of what it prepared, and publication
/// reads it to publish exactly what was validated.
pub fn read_staged_import(library: &LidarLibrary, job_id: &str) -> Result<StagedImport, String> {
    let path = library.inner.paths.job_dir(job_id).join("staging.json");
    let staging_json = std::fs::read_to_string(&path)
        .map_err(|e| format!("Staged import data is missing: {e}"))?;
    serde_json::from_str(&staging_json).map_err(|e| format!("Invalid staging data: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StagedImport {
    pub job_id: String,
    pub layer_id: String,
    pub layer_nodata: f32,
    pub union_grid: RasterGrid,
    pub sources: Vec<StagedSource>,
    /// Processing cells this batch was admitted for.
    pub processing_cells: u64,
    pub engine_version: String,
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

pub fn stage_import(
    library: &LidarLibrary,
    job_id: &str,
    layer_id: &str,
    source_paths: &[PathBuf],
    cancel: &AtomicBool,
) -> Result<(), String> {
    let engine = library.inner.engine.as_ref();
    let paths = &library.inner.paths;
    // A rebuilt item's saved selection holds managed originals: every
    // message names a source by the file it was imported as, the rule the
    // Retry check uses too.
    let names = library.saved_source_names(source_paths)?;
    let name_of = |path: &Path| {
        names
            .get(path)
            .cloned()
            .unwrap_or_else(|| admission::source_name(path))
    };
    validate_selection(source_paths, &name_of)?;

    let layer = {
        let connection = library.catalogue()?;
        let layer = catalogue::get_layer(&connection, layer_id)?
            .ok_or_else(|| format!("Layer {layer_id} does not exist"))?;
        if catalogue::head_generation(&connection, layer_id)?.is_some() {
            return Err("this library item is already published and fixed".to_string());
        }
        layer
    };

    let job_dir = paths.job_dir(job_id);
    std::fs::create_dir_all(&job_dir).map_err(|e| format!("Failed to create job dir: {e}"))?;

    let mut staged: Vec<StagedSource> = Vec::new();
    for source_path in source_paths {
        check_cancel(cancel)?;
        // A source this batch cannot use refuses the whole batch, and the
        // refusal names the user's own file: "the probe failed on a hashed copy"
        // is not an answer anyone can act on.
        let filename = name_of(source_path);
        let earlier = ordered_processing_cost(&staged.iter().collect::<Vec<_>>())?;
        let staged_source = stage_source(
            engine,
            paths,
            library,
            &layer.quantity,
            &layer.units,
            source_path,
            &filename,
            &earlier,
            job_id,
            &job_dir,
            cancel,
        )
        .map_err(|error| format!("{filename}: {error}"))?;
        staged.push(staged_source);
        record_staging_progress(library, job_id, staged.len(), source_paths.len());
    }

    // One common interpretation for the whole batch: the first compatible
    // source is the anchor every other selected source must match, so an
    // EPSG:3857 and an EPSG:4326 raster with equal coordinates are not both
    // admitted into one item.
    {
        let anchor = staged
            .iter()
            .find(|source| source.compatible)
            .map(|source| (grid_for_source(source), source.crs_ref.clone()));
        if let Some((anchor_grid, anchor_crs)) = anchor {
            for source in staged.iter_mut().filter(|source| source.compatible) {
                if source.crs_ref.trim() != anchor_crs.trim() {
                    source.compatible = false;
                    source
                        .issues
                        .push("horizontal CRS differs from the other selected sources".to_string());
                }
                if let Err(error) = grid_for_source(source).compatible(&anchor_grid) {
                    source.compatible = false;
                    source.issues.push(format!(
                        "grid incompatible with the other selected sources: {error}"
                    ));
                }
            }
        }
    }

    let compatible: Vec<&StagedSource> = staged.iter().filter(|s| s.compatible).collect();
    if compatible.is_empty() {
        let issues = staged
            .iter()
            .flat_map(|s| s.issues.iter().cloned())
            .collect::<Vec<_>>();
        return Err(format!(
            "no source could join layer '{}': {}",
            layer.name,
            issues.join("; ")
        ));
    }

    // Union grid across every compatible source. It is metadata: work is
    // bounded by blocks, never sized by its area.
    let mut union = grid_for_source(compatible[0]);
    let layer_nodata = compatible[0].nodata.unwrap_or(FALLBACK_NODATA);
    for source in &compatible {
        union = union_grid(&union, &grid_for_source(source))?;
    }
    validate_lattice(&union, "import")?;
    let admitted_processing_cells =
        admission::check_processing_budget(ordered_processing_cost(&compatible)?, "import")?;

    // Every selected source is now prepared and validated independently, and
    // that is all publication needs: the composition is defined by its members,
    // their order and their own stored facts.
    check_cancel(cancel)?;
    let engine_version = engine_version(engine);

    // Every issue is reported against the file it is about, so a refused batch
    // names the user's own sources rather than only the rule that refused them.
    let issues: Vec<String> = staged
        .iter()
        .flat_map(|source| {
            source
                .issues
                .iter()
                .map(|issue| format!("{}: {issue}", source.filename))
        })
        .collect();

    let staging = StagedImport {
        job_id: job_id.to_string(),
        layer_id: layer_id.to_string(),
        layer_nodata,
        union_grid: union,
        sources: staged,
        processing_cells: admitted_processing_cells,
        engine_version,
    };
    std::fs::write(
        job_dir.join("staging.json"),
        serde_json::to_string(&staging).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to persist staging: {e}"))?;

    if !issues.is_empty() {
        return Err(issues.join("; "));
    }
    // Preparation is finished and the batch is valid, so the job moves to
    // publishing here rather than in a separate caller step: publication
    // refuses any other state, and a cancelled job is left cancelled by the
    // guarded update below.
    mark_publishing(library, job_id)?;
    Ok(())
}

/// Refuse a batch that contains any rejected source.
///
/// A selected batch is atomic: publishing the compatible subset would silently
/// accept a selection the user never approved. The UI already refuses to
/// confirm such a batch, and this is the same rule enforced where the
/// publication actually happens.
pub(super) fn ensure_whole_batch_compatible(staging: &StagedImport) -> Result<(), String> {
    let rejected: Vec<String> = staging
        .sources
        .iter()
        .filter(|source| !source.compatible)
        .map(|source| format!("{}: {}", source.filename, source.issues.join("; ")))
        .collect();
    if rejected.is_empty() {
        return Ok(());
    }
    Err(format!(
        "the selected batch contains sources that cannot be published, so none was: {}",
        rejected.join(" | ")
    ))
}

/// The layer's fixed lattice, recorded from its first accepted source.
///
/// The anchor never moves, so a later import that extends the layer left or up
/// keeps every unchanged member's chunk coordinates. Width and height describe
/// only how far the lattice currently reaches right and down from the anchor;
/// the sparse resolver addresses negative cells directly.
fn layer_lattice_grid(
    connection: &rusqlite::Connection,
    layer_id: &str,
    anchor: &RasterGrid,
    crs_ref: &str,
) -> Result<RasterGrid, String> {
    let row = catalogue::LayerLatticeRow {
        origin_x: anchor.geotransform[0],
        origin_y: anchor.geotransform[3],
        pixel_x: anchor.geotransform[1],
        pixel_y: anchor.geotransform[5],
        crs_ref: crs_ref.to_string(),
    };
    catalogue::record_layer_lattice(connection, layer_id, &row)?;
    let stored = catalogue::layer_lattice(connection, layer_id)?
        .ok_or_else(|| "layer lattice was not recorded".to_string())?;
    Ok(RasterGrid {
        width: anchor.width,
        height: anchor.height,
        geotransform: [
            stored.origin_x,
            stored.pixel_x,
            0.0,
            stored.origin_y,
            0.0,
            stored.pixel_y,
        ],
    })
}

/// Validate a selection against the one admission policy.
///
/// Every bound comes from `admission`, so an authorized representative run
/// can raise it for its own thread and nothing else changes. Refusals name a
/// source through `name_of` ([`admission::source_name`] for the user's files;
/// Retry names a managed original by the file it was imported as), never its
/// folder or a system error. The dialog never submits an empty selection, so
/// one is `Internal`; a folder reads as a file that cannot be read.
pub(super) fn validate_selection(
    source_paths: &[PathBuf],
    name_of: &dyn Fn(&Path) -> String,
) -> Result<(), LidarImportRefusal> {
    if source_paths.is_empty() {
        return Err("select at least one raster source".to_string().into());
    }
    admission::check_source_count(source_paths.len())?;
    let mut total_bytes = 0u64;
    for path in source_paths {
        let name = name_of(path);
        let file = name.clone();
        let metadata = std::fs::metadata(path).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => admission::refusal(
                Reason::SourceMissing { file },
                format!("{name} cannot be found; choose the files again"),
            ),
            _ => admission::refusal(
                Reason::Unreadable { file },
                format!("{name} cannot be read; choose the files again"),
            ),
        })?;
        if !metadata.is_file() {
            return Err(admission::refusal(
                Reason::Unreadable { file: name.clone() },
                format!("{name} is not a file; choose the files again"),
            ));
        }
        admission::check_source_bytes(&name, metadata.len())?;
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or_else(admission::import_too_large)?;
    }
    admission::check_import_bytes(total_bytes)
}

pub(crate) fn validate_working_grid(grid: &RasterGrid, operation: &str) -> Result<(), String> {
    let cells = u64::from(grid.width)
        .checked_mul(u64::from(grid.height))
        .ok_or_else(|| format!("{operation} dimensions overflow"))?;
    let limit = raw_extraction_cells();
    if cells > limit {
        return Err(format!(
            "{operation} requires {cells} cells; a whole-raster read is limited to {limit}"
        ));
    }
    Ok(())
}

fn stage_managed_original(
    paths: &LidarPaths,
    source_path: &Path,
    job_dir: &Path,
    cancel: &AtomicBool,
) -> Result<(String, PathBuf, u64), String> {
    let temporary = job_dir.join(format!("source-copy-{}.tmp", new_id("copy")));
    let copied = (|| -> Result<(String, u64), String> {
        let mut source = std::io::BufReader::new(
            std::fs::File::open(source_path)
                .map_err(|e| format!("Failed to open {}: {e}", source_path.display()))?,
        );
        let target_file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| format!("Failed to create managed source staging: {e}"))?;
        let mut target = std::io::BufWriter::new(target_file);
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            check_cancel(cancel)?;
            let read = source
                .read(&mut buffer)
                .map_err(|e| format!("Failed to read {}: {e}", source_path.display()))?;
            if read == 0 {
                break;
            }
            total = total
                .checked_add(read as u64)
                .ok_or_else(|| "source byte count overflow".to_string())?;
            admission::check_source_bytes(&admission::source_name(source_path), total).map_err(
                |error| {
                    format!(
                        "{} while the managed original was being copied",
                        error.detail
                    )
                },
            )?;
            hasher.update(&buffer[..read]);
            target
                .write_all(&buffer[..read])
                .map_err(|e| format!("Failed to stage managed source: {e}"))?;
        }
        target
            .flush()
            .map_err(|e| format!("Failed to flush managed source: {e}"))?;
        target
            .get_ref()
            .sync_all()
            .map_err(|e| format!("Failed to sync managed source: {e}"))?;
        Ok((format!("{:x}", hasher.finalize()), total))
    })();
    let (sha256, size_bytes) = match copied {
        Ok(result) => result,
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
    };

    let managed_dir = paths.source_dir(&sha256);
    std::fs::create_dir_all(&managed_dir)
        .map_err(|e| format!("Failed to create source dir: {e}"))?;
    let managed_original = paths.source_original(&sha256);
    if managed_original.exists() {
        let (existing_hash, existing_size) = hash_file_limited(&managed_original, cancel)?;
        if existing_hash != sha256 || existing_size != size_bytes {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!(
                "managed source {} failed integrity verification",
                managed_original.display()
            ));
        }
        let _ = std::fs::remove_file(&temporary);
    } else {
        // Recorded first, so a job that stops after the rename still frees
        // the original it created (`discard_job_files`).
        let mut created = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(job_dir.join(CREATED_ORIGINALS))
            .map_err(|e| format!("Failed to record the managed source: {e}"))?;
        writeln!(created, "{sha256}")
            .map_err(|e| format!("Failed to record the managed source: {e}"))?;
        std::fs::rename(&temporary, &managed_original)
            .map_err(|e| format!("Failed to publish managed source: {e}"))?;
    }
    Ok((sha256, managed_original, size_bytes))
}

fn hash_file_limited(path: &Path, cancel: &AtomicBool) -> Result<(String, u64), String> {
    let mut file = std::io::BufReader::new(
        std::fs::File::open(path)
            .map_err(|e| format!("Failed to verify {}: {e}", path.display()))?,
    );
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        check_cancel(cancel)?;
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to verify {}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "managed source size overflow".to_string())?;
        admission::check_source_bytes(&admission::source_name(path), total)
            .map_err(|error| format!("{} while the managed original was verified", error.detail))?;
        hasher.update(&buffer[..read]);
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

fn units_compatible(source: &str, layer: &str) -> bool {
    let normalize = |value: &str| value.trim().to_ascii_lowercase();
    let source = normalize(source);
    let layer = normalize(layer);
    source == layer
        || matches!(
            source.as_str(),
            "m" | "metre" | "metres" | "meter" | "meters"
        ) && matches!(
            layer.as_str(),
            "m" | "metre" | "metres" | "meter" | "meters"
        )
}

#[expect(
    clippy::too_many_arguments,
    reason = "ratcheted before 2.1-M188; group the arguments when this function next changes"
)]
fn stage_source(
    engine: &dyn RasterEngine,
    paths: &LidarPaths,
    library: &LidarLibrary,
    quantity: &str,
    units: &str,
    source_path: &Path,
    filename: &str,
    earlier: &[admission::ProcessingCost],
    job_id: &str,
    job_dir: &Path,
    cancel: &AtomicBool,
) -> Result<StagedSource, String> {
    // Stream the source once into job-owned staging while hashing it. This
    // avoids loading an arbitrary TIFF into memory and lets an existing
    // deduplicated original be verified before it is trusted.
    let (sha256, managed_original, size_bytes) =
        stage_managed_original(paths, source_path, job_dir, cancel)?;

    // Probe from the managed copy so the flow survives user-file changes.
    let probe = engine.probe(&managed_original, cancel)?;
    if probe.crs_ref.trim().is_empty() {
        return Err(
            "raster has no coordinate system; Canopi requires a horizontal CRS".to_string(),
        );
    }
    let probe_json = serde_json::to_string(&probe)
        .map_err(|e| format!("Failed to record the raster probe: {e}"))?;

    let mut issues = Vec::new();
    if probe.band_count != 1 {
        issues.push(format!(
            "source has {} bands; Canopi joins single-band numeric rasters",
            probe.band_count
        ));
    }
    if probe.geotransform[1] <= 0.0
        || probe.geotransform[5] >= 0.0
        || probe.geotransform[2].abs() > 1e-12
        || probe.geotransform[4].abs() > 1e-12
    {
        issues.push(
            "rotated, reflected, or south-up rasters are not supported by the current grid engine"
                .to_string(),
        );
    }
    if (probe.scale - 1.0).abs() > f64::EPSILON || probe.offset.abs() > f64::EPSILON {
        issues.push(
            "band scale/offset metadata is not supported; materialize physical values before import"
                .to_string(),
        );
    }
    if probe
        .mask_flags
        .iter()
        .any(|flag| !flag.eq_ignore_ascii_case("ALL_VALID"))
    {
        issues.push(
            "dataset validity masks are not supported; encode invalid cells as declared NoData"
                .to_string(),
        );
    }
    if let Some(unit) = probe.unit.as_deref()
        && !units_compatible(unit, units)
    {
        issues.push(format!(
            "band unit '{unit}' does not match layer unit '{units}'"
        ));
    }

    // One retained controlled source COG carries this interpretation's numbers
    // from here on; the managed original is never loaded whole and no durable
    // raw/mask pair is written beside it.
    let source_grid = RasterGrid {
        width: probe.width,
        height: probe.height,
        geotransform: probe.geotransform,
    };
    // No working-area check here: the engine streams a GeoTIFF into the
    // retained COG in row windows (anything it must load whole passes its
    // capacity rule) and the facts are read from that COG in bounded
    // windows. The bound is the admission processing budget, charged from
    // the probe with every source converted before this one, so an import
    // that will be refused never converts. Every selected source counts
    // here: a source later found incompatible refuses the batch anyway.
    validate_lattice(&source_grid, "source raster")?;
    admission::check_processing_budget(
        earlier.iter().copied().chain([admission::ProcessingCost {
            width: probe.width,
            height: probe.height,
        }]),
        "import",
    )?;
    let (source_cog, valid_cells) = stage_source_samples(
        engine,
        cancel,
        &managed_original,
        &source_grid,
        &probe.crs_ref,
        probe.nodata,
        job_dir,
        &sha256,
    )?;
    let value_range = source_cog.value_range;
    if valid_cells == 0 {
        // An all-NoData selection is refused by name here rather than published
        // as an occurrence that can never contribute a sample.
        issues.push(
            "source holds no valid samples; every cell is NoData under its own rule".to_string(),
        );
    }

    // Interpretation identity: content plus interpretation facts, never names.
    let vertical_ref = "unspecified";
    let interp_hash = grid::sha256_hex(
        format!(
            "{}|1|{quantity}|{units}|{}|{}|{}|{}|{}|{vertical_ref}",
            sha256,
            probe.band_type,
            probe.nodata.map(|v| v.to_string()).unwrap_or_default(),
            format_geotransform(probe.geotransform),
            probe.width,
            probe.height,
        )
        .as_bytes(),
    );

    // Short write: durable source + interpretation identity.
    let connection = library.catalogue()?;
    connection
        .execute(
            "INSERT INTO lidar_sources(sha256, original_filename, size_bytes, probe_json, imported_at)
             VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(sha256) DO NOTHING",
            rusqlite::params![sha256, filename, size_bytes as i64, probe_json, now_iso()],
        )
        .map_err(|e| format!("Failed to record source: {e}"))?;
    connection
        .execute(
            "INSERT INTO lidar_interpretations(
                id, source_sha256, band_index, quantity, units, scale, offset,
                crs_ref, vertical_ref, nodata, geotransform, width, height, interp_hash,
                valid_cells, min_value, max_value)
             VALUES(?1, ?2, 1, ?3, ?4, 1, 0, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(interp_hash) DO NOTHING",
            rusqlite::params![
                format!("interp-{interp_hash}"),
                sha256,
                quantity,
                units,
                probe.crs_ref,
                vertical_ref,
                probe.nodata,
                format_geotransform(probe.geotransform),
                probe.width as i64,
                probe.height as i64,
                interp_hash,
                valid_cells as i64,
                (valid_cells > 0).then_some(value_range[0]),
                (valid_cells > 0).then_some(value_range[1]),
            ],
        )
        .map_err(|e| format!("Failed to record interpretation: {e}"))?;
    Ok(StagedSource {
        filename: filename.to_string(),
        sha256,
        managed_original,
        interp_hash,
        width: probe.width,
        height: probe.height,
        geotransform: probe.geotransform,
        crs_ref: probe.crs_ref.clone(),
        nodata: probe.nodata,
        value_range,
        size_bytes,
        job_id: job_id.to_string(),
        source_cog,
        valid_cells,
        compatible: issues.is_empty(),
        issues,
    })
}

// ---------------------------------------------------------------------------
// Streamed source extraction
// ---------------------------------------------------------------------------

/// Convert one source into its job-owned retained COG and read its range and
/// valid-cell count from that COG in bounded windows. A failed or cancelled
/// attempt removes its partial output.
#[expect(
    clippy::too_many_arguments,
    reason = "ratcheted before 2.1-M188; group the arguments when this function next changes"
)]
fn stage_source_samples(
    engine: &dyn RasterEngine,
    cancel: &AtomicBool,
    input: &Path,
    grid: &RasterGrid,
    crs_ref: &str,
    nodata: Option<f32>,
    job_dir: &Path,
    sha256: &str,
) -> Result<(RetainedSourceCog, u64), String> {
    let stem = format!("source-cog-{}", &sha256[..sha256.len().min(16)]);
    // The engine writes the admitted COG as the durable output, so no
    // additional numeric output is charged beside it. The
    // combined footprint is measured against the job scratch, which holds the
    // conversion until it is admitted.
    let asset = super::raster_assets::write_job_source_cog(
        engine, cancel, job_dir, &stem, input, grid, crs_ref, nodata,
    )?;
    let relative_path = asset
        .path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| "staged source COG has no file name".to_string())?;
    let mut reader = PreparedRaster::open_committed(&asset.path, grid, nodata)?;
    let (value_range, valid_cells) = scan_source_facts(&mut reader, cancel)?;
    drop(reader);
    Ok((
        RetainedSourceCog {
            sha256: asset.sha256,
            bytes: asset.bytes,
            nodata,
            value_range,
            relative_path,
        },
        valid_cells,
    ))
}

/// Range and valid-cell count of one retained source, in bounded windows.
///
/// The range spans the samples that are **data**: the reader's validity flag is
/// the single rule, so a declared NoData sentinel is excluded however finite it
/// is, while legitimate zero and negative samples are kept. A sentinel like
/// -9999 would otherwise dominate the range and describe the dataset wrongly.
///
/// A source with no valid sample has no range to report. It returns
/// `[0.0, 0.0]` with a zero count, which callers must read as "no range" rather
/// than as a measured zero: the count is what distinguishes the two.
fn scan_source_facts(
    reader: &mut PreparedRaster,
    cancel: &AtomicBool,
) -> Result<([f64; 2], u64), String> {
    let (mut min, mut max) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut valid_cells = 0u64;
    reader.scan(cancel, |_window, samples, valid| {
        for (value, valid) in samples.iter().zip(valid.iter()) {
            if *valid == 0 {
                continue;
            }
            valid_cells = valid_cells.saturating_add(1);
            let value = f64::from(*value);
            // The flag already requires finiteness; this keeps the range finite
            // even if a future reader relaxes that.
            if value.is_finite() {
                min = min.min(value);
                max = max.max(value);
            }
        }
        Ok(())
    })?;
    if valid_cells > 0 && min.is_finite() {
        Ok(([min, max], valid_cells))
    } else {
        Ok(([0.0, 0.0], valid_cells))
    }
}

/// Check that a lattice is representable, without limiting its area.
///
/// A sparse or block-wise caller never allocates by lattice area, so the dense
/// working ceiling does not apply to it; what must hold is that its geometry is
/// finite and its arithmetic cannot overflow.
fn validate_lattice(grid: &RasterGrid, operation: &str) -> Result<(), String> {
    if grid.width == 0 || grid.height == 0 {
        return Err(format!("{operation} has an empty extent"));
    }
    u64::from(grid.width)
        .checked_mul(u64::from(grid.height))
        .ok_or_else(|| format!("{operation} dimensions overflow"))?;
    if !grid.geotransform.iter().all(|value| value.is_finite()) {
        return Err(format!("{operation} geometry is not finite"));
    }
    if grid.geotransform[1] == 0.0 || grid.geotransform[5] == 0.0 {
        return Err(format!("{operation} has a degenerate pixel size"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Promotion of job-owned source COGs into the content-addressed store
// ---------------------------------------------------------------------------

/// Test-only crash points in publication.
///
/// `check` is compiled in both builds so the real lifecycle calls it
/// unconditionally; only the trigger is test-only, which keeps a fault seam
/// out of production behaviour without a second implementation.
pub(crate) mod promotion_probe {
    #[cfg(test)]
    use std::cell::RefCell;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum FaultPoint {
        /// Before the first job-local COG is moved into the store.
        BeforePromotion,
        /// Immediately before the publication transaction begins, after every
        /// file is in place.
        BeforeTransaction,
    }

    #[cfg(test)]
    thread_local! {
        static ARMED: RefCell<Vec<FaultPoint>> = const { RefCell::new(Vec::new()) };
    }

    #[cfg(test)]
    pub(crate) fn fail_at(point: FaultPoint) {
        ARMED.with(|armed| armed.borrow_mut().push(point));
    }

    #[cfg(test)]
    pub(crate) fn clear() {
        ARMED.with(|armed| armed.borrow_mut().clear());
    }

    /// Consume one armed failure at this point.
    pub(crate) fn check(point: FaultPoint) -> Result<(), String> {
        #[cfg(test)]
        {
            let armed = ARMED.with(|armed| {
                let mut armed = armed.borrow_mut();
                armed
                    .iter()
                    .position(|armed| *armed == point)
                    .map(|position| armed.remove(position))
            });
            if armed.is_some() {
                return Err(format!("injected failure at {point:?}"));
            }
        }
        let _ = point;
        Ok(())
    }
}

/// Resolve a recorded root-relative location under an owned root.
///
/// Only plain path components are accepted: an absolute path, a parent
/// traversal or a prefix component is refused before any file is touched, so a
/// staged record can never name a file outside its owner's root.
fn resolve_under_root(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let recorded = Path::new(relative);
    if recorded.as_os_str().is_empty() || recorded.is_absolute() {
        return Err(format!(
            "recorded location {relative:?} is not root-relative"
        ));
    }
    if recorded
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(format!(
            "recorded location {relative:?} leaves its owning root"
        ));
    }
    Ok(root.join(recorded))
}

/// One source COG in the store, ready for the publication to reference.
#[derive(Debug, Clone)]
struct PromotedSourceCog {
    interpretation_id: String,
    sha256: String,
    /// Global destination the publication references.
    path: PathBuf,
    bytes: u64,
    nodata: Option<f32>,
    grid: RasterGrid,
    crs_ref: String,
}

impl PromotedSourceCog {
    fn asset(&self) -> super::raster_assets::CogAsset {
        super::raster_assets::CogAsset {
            sha256: self.sha256.clone(),
            path: self.path.clone(),
            bytes: self.bytes,
            grid: self.grid.clone(),
            nodata: self.nodata,
        }
    }
}

/// Move every staged source COG this job owns into the content-addressed
/// store (`assets/<sha256>/cog.tif`).
///
/// Idempotent: a destination that already exists holds the same content by
/// construction and is reused after its digest is verified. Nothing references
/// a moved file until the publication transaction commits, so a crash at any
/// point leaves either unreferenced files, which the next open sweeps, or a
/// complete publication. Files are never deleted here.
fn promote_source_cogs(
    library: &LidarLibrary,
    staging: &StagedImport,
    cancel: &AtomicBool,
) -> Result<Vec<PromotedSourceCog>, String> {
    let paths = &library.inner.paths;
    promotion_probe::check(promotion_probe::FaultPoint::BeforePromotion)?;
    let mut promoted = Vec::new();
    for source in staging.sources.iter().filter(|source| source.compatible) {
        check_cancel(cancel)?;
        let cog = &source.source_cog;
        let destination = paths.asset_cog(&cog.sha256);
        if !destination.exists() {
            let parent = destination
                .parent()
                .ok_or_else(|| "asset destination has no directory".to_string())?;
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create asset directory: {e}"))?;
            // The job root and the store share the library filesystem, so this
            // is an atomic move, never a copy.
            let local = cog.resolve(paths, &source.job_id)?;
            std::fs::rename(&local, &destination).map_err(|error| {
                format!(
                    "Failed to move staged source COG {} to {}: {error}",
                    local.display(),
                    destination.display()
                )
            })?;
            super::raster_assets::sync_published_asset(&destination)?;
        }
        // The destination must match the declared identity before any catalogue
        // row references it: a readable layout is not proof that a reused file
        // is the payload this source declares.
        let grid = grid_for_source(source);
        let (destination_digest, destination_bytes) =
            super::raster_assets::hash_file(&destination, cancel)?;
        if destination_digest != cog.sha256 || destination_bytes != cog.bytes {
            return Err(format!(
                "asset {} holds {destination_bytes} bytes of {destination_digest}, not the declared {} bytes of {}",
                destination.display(),
                cog.bytes,
                cog.sha256
            ));
        }
        let reader = PreparedRaster::open_committed(&destination, &grid, cog.nodata)?;
        drop(reader);
        promoted.push(PromotedSourceCog {
            interpretation_id: format!("interp-{}", source.interp_hash),
            sha256: cog.sha256.clone(),
            path: destination,
            bytes: cog.bytes,
            nodata: cog.nodata,
            grid,
            crs_ref: source.crs_ref.clone(),
        });
    }
    Ok(promoted)
}

/// Write the catalogue references that make promoted payloads authoritative.
///
/// Called inside the publication transaction: the generation, its head and the
/// source references it depends on become visible together or not at all.
fn insert_promoted_references(
    connection: &rusqlite::Connection,
    paths: &LidarPaths,
    promoted: &[PromotedSourceCog],
) -> Result<(), String> {
    for asset in promoted {
        catalogue::insert_raster_asset(
            connection,
            &generation::asset_row(paths, &asset.asset(), &asset.crs_ref)?,
        )?;
        connection
            .execute(
                "INSERT INTO lidar_interpretation_cogs(
                    interpretation_id, asset_sha256, nodata, created_at)
                 VALUES(?1, ?2, ?3, ?4)
                 ON CONFLICT(interpretation_id) DO NOTHING",
                rusqlite::params![
                    asset.interpretation_id,
                    asset.sha256,
                    asset.nodata,
                    now_iso(),
                ],
            )
            .map_err(|e| format!("Failed to record interpretation COG: {e}"))?;
    }
    Ok(())
}

/// The job-root file listing, one sha256 per line, the managed originals a
/// job created rather than found.
const CREATED_ORIGINALS: &str = "created-originals";

/// Remove what one unpublished import job wrote: the managed originals it
/// created, the source COGs it staged or promoted and their display
/// derivatives, each with its catalogue rows and only while no published
/// item or saved selection claims it, then the job root itself.
///
/// Called as the job settles, under its heavy lease, so no other import
/// stages the same content meanwhile, and at startup before any job runs.
pub(super) fn discard_job_files(library: &LidarLibrary, job_id: &str) -> Result<(), String> {
    let paths = &library.inner.paths;
    let job_dir = paths.job_dir(job_id);
    let created: Vec<String> = match std::fs::read_to_string(job_dir.join(CREATED_ORIGINALS)) {
        Ok(listing) => listing.lines().map(str::to_string).collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(format!("Failed to read the job's originals: {error}")),
    };
    // Derivatives are prepared only once the staging record is written.
    let staged: Vec<String> = read_staged_import(library, job_id)
        .map(|staging| {
            staging
                .sources
                .into_iter()
                .map(|source| source.source_cog.sha256)
                .collect()
        })
        .unwrap_or_default();
    let (originals, cogs) = {
        let connection = library.catalogue()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let originals = release_unclaimed_originals(&transaction, paths, created)?;
        transaction.commit().map_err(|e| e.to_string())?;
        let referenced = catalogue::referenced_asset_digests(&connection)?;
        let cogs: Vec<String> = staged
            .into_iter()
            .filter(|sha256| !referenced.contains(sha256))
            .collect();
        (originals, cogs)
    };
    for sha256 in &cogs {
        remove_dir_if_present(&paths.asset_dir(sha256))?;
        super::display_cog::forget_asset_derivatives(library, sha256)?;
    }
    remove_original_dirs(library, &originals)?;
    remove_job_root(library, job_id)
}

/// Release each managed original in `candidates` that no published item and
/// no saved import selection claims: mark its meta released, then delete its
/// catalogue rows, and return those originals; the caller commits, then
/// removes them with [`remove_original_dirs`]. Run under the heavy lease, so
/// no import stages the same content meanwhile.
///
/// The meta goes before the commit, so a stop between it and the removal
/// never lets a catalogue rebuild list the item again. An original whose meta
/// cannot be written keeps its rows and files for a later start, and never
/// keeps another.
pub(super) fn release_unclaimed_originals(
    transaction: &rusqlite::Connection,
    paths: &LidarPaths,
    candidates: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut released = Vec::new();
    for sha256 in candidates {
        let claimed: bool = transaction
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM lidar_collection_members AS member
                     JOIN lidar_interpretations AS interpretation
                       ON interpretation.id = member.interpretation_id
                     WHERE interpretation.source_sha256 = ?1)
                 OR EXISTS(
                     SELECT 1 FROM lidar_import_jobs WHERE instr(request_json, ?1) > 0)",
                [&sha256],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if claimed {
            continue;
        }
        if let Err(error) = super::source_meta::release(paths, &sha256) {
            tracing::warn!(%error, "an unclaimed original was kept until a later start");
            continue;
        }
        for sql in [
            "DELETE FROM lidar_interpretation_cogs WHERE interpretation_id IN
             (SELECT id FROM lidar_interpretations WHERE source_sha256 = ?1)",
            "DELETE FROM lidar_interpretations WHERE source_sha256 = ?1",
            "DELETE FROM lidar_sources WHERE sha256 = ?1",
        ] {
            transaction
                .execute(sql, [&sha256])
                .map_err(|e| e.to_string())?;
        }
        released.push(sha256);
    }
    Ok(released)
}

/// Remove the directories, original and `meta.json`, of released originals.
/// The original goes first, so a removal that fails part way never leaves
/// one without the meta that says it names no item; one that fails never
/// keeps another.
pub(super) fn remove_original_dirs(
    library: &LidarLibrary,
    originals: &[String],
) -> Result<(), String> {
    let mut kept = Vec::new();
    for sha256 in originals {
        let removed = match std::fs::remove_file(library.inner.paths.source_original(sha256)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Failed to remove an original: {error}")),
        }
        .and_then(|()| remove_dir_if_present(&library.inner.paths.source_dir(sha256)));
        if let Err(error) = removed {
            kept.push(error);
        }
    }
    if kept.is_empty() {
        Ok(())
    } else {
        Err(kept.join("; "))
    }
}

pub(super) fn remove_dir_if_present(dir: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove {}: {error}", dir.display())),
    }
}

/// Remove one settled job's root and everything it still holds.
pub fn remove_job_root(library: &LidarLibrary, job_id: &str) -> Result<(), String> {
    let root = library.inner.paths.job_dir(job_id);
    match std::fs::remove_dir_all(&root) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to remove settled job root {}: {error}",
            root.display()
        )),
    }
}

/// What publishing a new item produced.
#[derive(Debug)]
pub struct ApplyOutcome {
    pub generation_id: String,
    /// Exact published cells, or `None` when the composition's count is not
    /// derivable from member facts. An unknown count is never reported as zero.
    pub published_cells: Option<u64>,
}

impl ApplyOutcome {
    /// Summary used in structured logs so the generation identity is recorded.
    pub fn summary(&self) -> String {
        format!(
            "generation {} published with {}",
            self.generation_id,
            match self.published_cells {
                Some(cells) => format!("{cells} cells"),
                None => "unknown coverage".to_string(),
            }
        )
    }
}

/// Publish a new fixed item once: its sources, in the listed order, as one
/// ordered collection.
///
/// A published item is fixed, so there is no head to extend or replace: a
/// second publication of the same item is refused. Nothing is materialized;
/// the publication costs member metadata and one bounded measuring pass.
pub fn apply_import(
    library: &LidarLibrary,
    staging: &StagedImport,
    cancel: &AtomicBool,
) -> Result<ApplyOutcome, String> {
    let paths = &library.inner.paths;
    let layer_id = staging.layer_id.clone();
    // Publication's steps sit above preparation's share of the bar.
    library.record_import_progress(
        &staging.job_id,
        LidarImportProgressPhase::ComposingLayer,
        41,
    );
    {
        let connection = library.catalogue()?;
        if catalogue::head_generation(&connection, &layer_id)?.is_some() {
            return Err("this library item is already published and fixed".to_string());
        }
    }
    ensure_whole_batch_compatible(staging)?;
    let compatible: Vec<&StagedSource> = staging.sources.iter().filter(|s| s.compatible).collect();
    if compatible.is_empty() {
        return Err("import has no compatible sources to publish".to_string());
    }
    let mut union = grid_for_source(compatible[0]);
    validate_lattice(&union, "import publication")?;
    for source in &compatible {
        union = union_grid(&union, &grid_for_source(source))?;
        validate_lattice(&union, "import publication union")?;
    }
    admission::check_processing_budget(
        ordered_processing_cost(&compatible)?,
        "import publication",
    )?;
    library.record_import_progress(
        &staging.job_id,
        LidarImportProgressPhase::PreparingRaster,
        65,
    );

    // Move the job's own source COGs into the store first: the generation
    // references global assets, and the references that make them
    // authoritative are written inside the publication transaction.
    let promoted = promote_source_cogs(library, staging, cancel)?;
    library.record_import_progress(
        &staging.job_id,
        LidarImportProgressPhase::PreparingRaster,
        70,
    );
    let crs_ref = compatible[0].crs_ref.clone();
    let lattice = {
        let connection = library.catalogue()?;
        layer_lattice_grid(
            &connection,
            &layer_id,
            &grid_for_source(compatible[0]),
            &crs_ref,
        )?
    };
    // The first listed source is topmost.
    let mut members = Vec::with_capacity(compatible.len());
    let mut manifest_members = Vec::with_capacity(compatible.len());
    for (source, resolved) in compatible
        .iter()
        .zip(incoming_occurrences(paths, &compatible)?)
    {
        manifest_members.push(source.interp_hash.clone());
        members.push(collection::SnapshotMember {
            member_id: new_id("mem"),
            interpretation_id: format!("interp-{}", source.interp_hash),
            resolved,
        });
    }
    let plan = collection::SnapshotPlan {
        members,
        lattice,
        crs_ref,
        nodata: staging.layer_nodata,
        manifest_members,
    };
    library.record_import_progress(
        &staging.job_id,
        LidarImportProgressPhase::ComposingLayer,
        76,
    );
    let measurement = collection::measure(library, &plan, cancel)?;
    // Member facts prove an empty composition exactly.
    if measurement.published_cells == Some(0) {
        let named = compatible
            .iter()
            .map(|source| source.filename.clone())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "selection contains no valid pixels; nothing published ({named})"
        ));
    }
    let (manifest_json, _) = collection::manifest_for(library, &plan)?;
    let generation_id = new_id("gen");
    publish_applied_snapshot(
        library,
        staging,
        &generation_id,
        &plan,
        &measurement,
        &manifest_json,
        &promoted,
    )?;
    library.record_import_progress(&staging.job_id, LidarImportProgressPhase::Finalizing, 98);
    Ok(ApplyOutcome {
        generation_id,
        published_cells: measurement.published_cells,
    })
}

/// Stage, validate and publish one batch the way the one-step route does.
///
/// The same sequence production runs: prepare every source, refuse an
/// incompatible batch, then publish atomically.
#[cfg(test)]
pub(crate) fn stage_and_publish(
    library: &LidarLibrary,
    job_id: &str,
    layer_id: &str,
    source_paths: &[PathBuf],
    cancel: &AtomicBool,
) -> Result<ApplyOutcome, String> {
    stage_import(library, job_id, layer_id, source_paths, cancel)?;
    let staging = read_staged_import(library, job_id)?;
    apply_import(library, &staging, cancel)
}

/// Staged sources as ordered occurrences over their retained source COGs,
/// in the listed order.
fn incoming_occurrences(
    paths: &LidarPaths,
    sources: &[&StagedSource],
) -> Result<Vec<generation::ResolvedMember>, String> {
    sources
        .iter()
        .enumerate()
        .map(|(index, source)| {
            let cog = &source.source_cog;
            let grid = grid_for_source(source);
            Ok(generation::ResolvedMember {
                ordinal: i64::try_from(index).unwrap_or(i64::MAX),
                grid: grid.clone(),
                nodata: cog.nodata.or(source.nodata),
                cog: super::raster_assets::CogAsset {
                    sha256: cog.sha256.clone(),
                    path: paths.asset_cog(&cog.sha256),
                    bytes: cog.bytes,
                    grid,
                    nodata: cog.nodata,
                },
            })
        })
        .collect()
}

/// Give an unpublished item its only generation.
///
/// Insert-only: a published item is fixed, so a second head for the same item
/// is a constraint violation, never an update.
fn insert_layer_head(
    connection: &rusqlite::Connection,
    layer_id: &str,
    generation_id: &str,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO lidar_layer_heads(layer_id, generation_id) VALUES(?1, ?2)",
            rusqlite::params![layer_id, generation_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Publish an item's ordered collection and make it the item's generation.
///
/// The whole commit is one short transaction: the job must still be applying
/// and the item must still be unpublished, and the member rows readers select
/// by become visible with the generation that owns them. A failure publishes
/// nothing.
fn publish_applied_snapshot(
    library: &LidarLibrary,
    staging: &StagedImport,
    generation_id: &str,
    plan: &collection::SnapshotPlan,
    measurement: &collection::SnapshotMeasurement,
    manifest_json: &str,
    promoted: &[PromotedSourceCog],
) -> Result<(), String> {
    promotion_probe::check(promotion_probe::FaultPoint::BeforeTransaction)?;
    let connection = library.catalogue()?;
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let publish = (|| -> Result<(), String> {
        let job_state = connection
            .query_row(
                "SELECT state FROM lidar_import_jobs WHERE id = ?1",
                [&staging.job_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| e.to_string())?;
        if job_state != "applying" {
            return Err(format!("import job cannot publish from state {job_state}"));
        }
        if catalogue::head_generation(&connection, &staging.layer_id)?.is_some() {
            return Err("this library item is already published and fixed".to_string());
        }
        insert_promoted_references(&connection, &library.inner.paths, promoted)?;
        collection::insert_snapshot(
            &connection,
            &staging.layer_id,
            generation_id,
            plan,
            measurement,
            manifest_json,
        )?;
        insert_layer_head(&connection, &staging.layer_id, generation_id)?;
        connection
            .execute(
                "UPDATE lidar_import_jobs
                 SET state = 'complete', progress_phase = 'finalizing',
                     progress_percent = 100, updated_at = ?2 WHERE id = ?1",
                rusqlite::params![staging.job_id, now_iso()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    match publish {
        Ok(()) => connection.execute_batch("COMMIT").map_err(|e| {
            // A COMMIT refused under contention leaves the transaction open on
            // the library's only connection; end it so later work can begin.
            let _ = connection.execute_batch("ROLLBACK");
            e.to_string()
        }),
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// The immutable description of one item generation: an ordered collection of
/// source COGs on a fixed lattice, top-first by interpretation hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationManifest {
    pub grid: RasterGrid,
    pub nodata: f32,
    pub crs_ref: String,
    pub members: Vec<String>,
    pub engine_version: String,
    pub created_at: String,
}

pub fn read_generation_manifest(json: &str) -> Result<GenerationManifest, String> {
    serde_json::from_str(json).map_err(|e| format!("Invalid generation manifest: {e}"))
}

pub fn raw_f32_bytes(
    engine: &dyn RasterEngine,
    raster: &Path,
    width: u32,
    height: u32,
    cancel: &AtomicBool,
) -> Result<Vec<u8>, String> {
    let grid = RasterGrid {
        width,
        height,
        geotransform: [0.0, 1.0, 0.0, 0.0, 0.0, -1.0],
    };
    validate_working_grid(&grid, "raw raster extraction")?;
    let values = engine.read_f32(raster, width, height, cancel)?;
    Ok(values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect())
}

pub(crate) fn f32_sample(raw: &[u8], index: usize) -> f32 {
    let offset = index * 4;
    f32::from_le_bytes([
        raw[offset],
        raw[offset + 1],
        raw[offset + 2],
        raw[offset + 3],
    ])
}

pub fn write_f32_raw(path: &Path, values: &[f32]) -> Result<(), String> {
    let file =
        std::fs::File::create(path).map_err(|e| format!("Failed to create raw buffer: {e}"))?;
    let mut output = std::io::BufWriter::new(file);
    for value in values {
        output
            .write_all(&value.to_le_bytes())
            .map_err(|e| format!("Failed to write raw buffer: {e}"))?;
    }
    output
        .flush()
        .map_err(|e| format!("Failed to flush raw buffer: {e}"))
}

/// Convert a raw little-endian Float32 file into a georeferenced tiled
/// GeoTIFF carrying `nodata`.
pub fn raw_to_tif(
    engine: &dyn RasterEngine,
    cancel: &AtomicBool,
    raw: &Path,
    tif: &Path,
    grid: &RasterGrid,
    crs_ref: &str,
    nodata: f32,
) -> Result<(), String> {
    let bytes = std::fs::read(raw).map_err(|e| format!("Failed to read raw buffer: {e}"))?;
    let expected = usize::try_from(u64::from(grid.width) * u64::from(grid.height) * 4)
        .map_err(|_| "raw raster byte count exceeds this platform".to_string())?;
    if bytes.len() != expected {
        return Err(format!(
            "raw raster buffer has {} bytes, expected {expected}",
            bytes.len()
        ));
    }
    let values: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();
    engine.write_geotiff(
        tif,
        RasterGeoref { grid, crs: crs_ref },
        nodata,
        &values,
        cancel,
    )
}

/// Projected bounds in EPSG:3857 for presentation fit and tile alignment.
pub fn raster_bounds_3857(
    engine: &dyn RasterEngine,
    cancel: &AtomicBool,
    grid: &RasterGrid,
    crs_ref: &str,
) -> Result<[f64; 4], String> {
    let corners = super::engine::grid_corners(grid);
    let placed = engine.transform_points(crs_ref, "EPSG:3857", &corners, cancel)?;
    check_cancel(cancel)?;
    super::engine::bounds_of(&placed)
        .ok_or_else(|| "the raster's corners have no projected position".to_string())
}

fn grid_for_source(source: &StagedSource) -> RasterGrid {
    RasterGrid {
        width: source.width,
        height: source.height,
        geotransform: source.geotransform,
    }
}

pub(crate) fn format_geotransform(gt: GeoTransform) -> String {
    format!(
        "[{},{},{},{},{},{}]",
        gt[0], gt[1], gt[2], gt[3], gt[4], gt[5]
    )
}

pub(crate) fn parse_geotransform(raw: &str) -> Result<GeoTransform, String> {
    let values = serde_json::from_str::<Vec<f64>>(raw)
        .map_err(|error| format!("Invalid stored geotransform: {error}"))?;
    let transform: GeoTransform = values.try_into().map_err(|values: Vec<f64>| {
        format!(
            "Invalid stored geotransform: expected 6 values, found {}",
            values.len()
        )
    })?;
    if !transform.iter().all(|value| value.is_finite()) {
        return Err("Invalid stored geotransform: values must be finite".to_string());
    }
    Ok(transform)
}

pub(super) fn engine_version(engine: &dyn RasterEngine) -> String {
    engine.version().unwrap_or_default()
}

pub use super::engine::check_cancel;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::lidar::engine::RasterEngine;
    use std::sync::atomic::Ordering;

    #[test]
    fn raw_extraction_limit_rejects_extent_explosion_before_allocation() {
        let allowed = RasterGrid {
            width: 5_000,
            height: 5_000,
            geotransform: [0.0, 1.0, 0.0, 5_000.0, 0.0, -1.0],
        };
        assert!(validate_working_grid(&allowed, "test").is_ok());
        let oversized = RasterGrid {
            width: 5_001,
            ..allowed
        };
        let error = validate_working_grid(&oversized, "test").unwrap_err();
        assert!(error.contains("whole-raster read is limited"));
    }

    #[test]
    fn source_selection_caps_count_and_bytes_before_staging() {
        let too_many = vec![PathBuf::from("unused"); admission::MAX_SOURCE_FILES_PER_IMPORT + 1];
        let refused = validate_selection(&too_many, &admission::source_name).unwrap_err();
        assert_eq!(refused.reason, Reason::TooManyFiles { limit: 24 });
        assert!(refused.detail.contains("at most"), "{}", refused.detail);

        let scratch = crate::test_scratch::TestScratch::new("canopi-oversized-source");
        let path = scratch.join("oversized-source");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(admission::MAX_SOURCE_FILE_BYTES + 1).unwrap();
        let error =
            validate_selection(std::slice::from_ref(&path), &admission::source_name).unwrap_err();
        assert_eq!(
            error.reason,
            Reason::SourceTooLarge {
                file: "oversized-source".to_string(),
                limit_mib: 2048
            }
        );
        assert!(error.detail.contains("per-source limit"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn managed_original_is_streamed_and_existing_content_is_verified() {
        let root = crate::test_scratch::TestScratch::new("canopi-managed-source-test");
        let paths = LidarPaths::open(&root).unwrap();
        let job_dir = paths.job_dir("job");
        std::fs::create_dir_all(&job_dir).unwrap();
        let source = root.join("extensionless-source");
        std::fs::write(&source, b"canopi raster bytes").unwrap();

        let (sha256, managed, size) =
            stage_managed_original(&paths, &source, &job_dir, &AtomicBool::new(false)).unwrap();
        assert_eq!(size, 19);
        assert_eq!(std::fs::read(&managed).unwrap(), b"canopi raster bytes");
        // The managed copy is the only file kept for an original: nothing
        // records where the user's file lived.
        let kept: Vec<String> = std::fs::read_dir(paths.source_dir(&sha256))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(kept, vec!["original".to_string()]);
        assert_eq!(
            hash_file_limited(&managed, &AtomicBool::new(false))
                .unwrap()
                .0,
            sha256
        );

        std::fs::write(&managed, b"corrupt").unwrap();
        let error =
            stage_managed_original(&paths, &source, &job_dir, &AtomicBool::new(false)).unwrap_err();
        assert!(error.contains("failed integrity verification"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn geotransform_storage_round_trips() {
        let transform = [445999.75, 0.5, 0.0, 6807000.25, 0.0, -0.5];
        assert_eq!(
            parse_geotransform(&format_geotransform(transform)).unwrap(),
            transform
        );
    }

    #[test]
    fn geotransform_storage_rejects_missing_or_non_finite_values() {
        assert!(parse_geotransform("[1,2,3]").is_err());
        assert!(
            parse_geotransform("0,1,0,1,0,1").is_err(),
            "only the stored JSON form"
        );
    }

    // -----------------------------------------------------------------
    // Streamed staging through the real engine
    // -----------------------------------------------------------------

    /// Authored values for the staging compatibility fixtures.
    fn staged_value(x: u32, y: u32) -> f32 {
        match (x % 23, y % 17) {
            (0, 0) => -9999.0,
            (1, 1) => f32::NAN,
            (2, 2) => f32::INFINITY,
            (3, 3) => 0.0,
            (4, 4) => -12.5,
            _ => (x as f32) * 0.5 - (y as f32) * 0.25,
        }
    }

    /// Independently recomputed value range for the retained conversion.
    /// The range an oracle expects for one source.
    ///
    /// A value the source itself declares as NoData is not one of its values, so
    /// it must not widen the reported range even though it is finite: a legend
    /// that spanned it would describe data the source does not hold.
    fn oracle_range(raw: &[u8], nodata: Option<f32>) -> [f64; 2] {
        let mut min = f64::INFINITY;
        let mut max = f64::NEG_INFINITY;
        for chunk in raw.chunks_exact(4) {
            let value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            if value.is_finite() && Some(value) != nodata {
                min = min.min(value as f64);
                max = max.max(value as f64);
            }
        }
        if min.is_finite() {
            [min, max]
        } else {
            [0.0, 0.0]
        }
    }

    fn write_staging_fixture(
        engine: &dyn RasterEngine,
        dir: &Path,
        name: &str,
        width: u32,
        height: u32,
        nodata: f32,
    ) -> PathBuf {
        let values: Vec<f32> = (0..height)
            .flat_map(|y| (0..width).map(move |x| (x, y)))
            .map(|(x, y)| staged_value(x, y))
            .collect();
        let raw = dir.join(format!("{name}.raw"));
        write_f32_raw(&raw, &values).expect("fixture raw writes");
        let tif = dir.join(format!("{name}.tif"));
        raw_to_tif(
            engine,
            &AtomicBool::new(false),
            &raw,
            &tif,
            &RasterGrid {
                width,
                height,
                geotransform: [0.0, 1.0, 0.0, height as f64, 0.0, -1.0],
            },
            "EPSG:3857",
            nodata,
        )
        .expect("fixture converts");
        let _ = std::fs::remove_file(&raw);
        let _ = std::fs::remove_file(raw.with_extension("hdr"));
        tif
    }

    /// The streamed production staging path must persist exactly the authored
    /// values, for every special value the Float32 contract covers and for an
    /// integer source through its cast, and must really decode through the
    /// native tiled reader rather than a full-buffer fallback.
    #[test]
    fn staged_source_assets_match_the_authored_values() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let root = crate::test_scratch::TestScratch::new("canopi-staging-oracle");
        let library = LidarLibrary::open(&root).expect("library opens");
        let layer_id = library
            .create_layer(
                "staging oracle",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .expect("layer created");
        let job_id = library.record_import_job(&layer_id).expect("job recorded");

        let (width, height) = (60u32, 45u32);
        let float_source =
            write_staging_fixture(&engine, &root, "oracle-f32", width, height, -9999.0);
        // The same values as Int16 (NaN to 0, infinities saturated), the cast
        // an integer source carries into Float32.
        let int_source = root.join("oracle-int16.tif");
        let int_values: Vec<i16> = (0..height)
            .flat_map(|y| (0..width).map(move |x| staged_value(x, y) as i16))
            .collect();
        wbgeotiff::GeoTiffWriter::new(width, height, 1)
            .layout(wbgeotiff::WriteLayout::Tiled {
                tile_width: 256,
                tile_height: 256,
            })
            .geo_transform(wbgeotiff::GeoTransform::north_up(
                0.0,
                1.0,
                f64::from(height),
                -1.0,
            ))
            .epsg(3857)
            .no_data(-9999.0)
            .write_i16(&int_source, &int_values)
            .expect("int16 fixture writes");

        use crate::services::lidar::prepared_raster::observability;
        observability::reset();
        stage_import(
            &library,
            &job_id,
            &layer_id,
            &[float_source.clone(), int_source.clone()],
            &cancel,
        )
        .expect("fixtures are admitted");
        assert!(
            observability::tiles_decoded() > 0,
            "staging must decode through the native tiled reader"
        );

        let staging: StagedImport = serde_json::from_str(
            &std::fs::read_to_string(library.inner.paths.job_dir(&job_id).join("staging.json"))
                .expect("staging json"),
        )
        .expect("staging parses");
        assert_eq!(staging.sources.len(), 2);
        for (source, fixture) in staging.sources.iter().zip([&float_source, &int_source]) {
            assert_eq!(source.width, width);
            assert_eq!(source.height, height);
            assert_eq!(source.nodata, Some(-9999.0));
            assert_eq!(source.size_bytes, std::fs::metadata(fixture).unwrap().len());

            // The authored values are the independent oracle: the Float32
            // fixture verbatim, the Int16 one through the cast it was written with.
            let oracle: Vec<u8> = (0..height)
                .flat_map(|y| (0..width).map(move |x| staged_value(x, y)))
                .map(|value| {
                    if fixture == &int_source {
                        f32::from(value as i16)
                    } else {
                        value
                    }
                })
                .flat_map(|value| value.to_le_bytes())
                .collect();
            let oracle_mask = grid::valid_mask_from_f32_raw_checked(
                width,
                height,
                &oracle,
                Some(-9999.0),
                |_| Ok(()),
            )
            .expect("oracle mask");
            let cog = &source.source_cog;
            let grid = grid_for_source(source);
            let mut reader = PreparedRaster::open_committed(
                &cog.resolve(&library.inner.paths, &source.job_id)
                    .expect("the retained COG resolves"),
                &grid,
                cog.nodata,
            )
            .expect("the retained COG opens through the production reader");
            assert_eq!(reader.grid(), &grid);
            let read = reader
                .read_window(
                    RasterWindow {
                        x: 0,
                        y: 0,
                        width,
                        height,
                    },
                    &cancel,
                )
                .expect("retained COG reads");
            assert_eq!(read.samples().len(), oracle.len() / 4, "sample count");
            assert_eq!(
                read.valid().to_vec(),
                oracle_mask.bytes().to_vec(),
                "validity comes from this source's own effective NoData rule"
            );
            for (index, chunk) in oracle.chunks_exact(4).enumerate() {
                let expected = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                let got = read.samples()[index];
                if expected.is_nan() {
                    assert!(got.is_nan(), "sample {index} must stay NaN");
                } else {
                    assert_eq!(got.to_bits(), expected.to_bits(), "sample {index}");
                }
            }
            assert_eq!(
                source.value_range,
                oracle_range(&oracle, Some(-9999.0)),
                "the range covers the source's own values and nothing it declares as no data"
            );
            assert_eq!(source.valid_cells, oracle_mask.count_valid());
        }

        // Nothing durable beside the retained COG: no prepared derivative, no
        // raw samples and no validity mask survive staging.
        let leftovers: Vec<_> = std::fs::read_dir(library.inner.paths.job_dir(&job_id))
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| {
                name.starts_with("prepared-") || name.ends_with(".raw") || name.ends_with(".bin")
            })
            .collect();
        assert!(
            leftovers.is_empty(),
            "durable raw/mask or derivative left behind: {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn staging_without_a_measurable_scratch_directory_fails_by_name() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let root = crate::test_scratch::TestScratch::new("canopi-absent-scratch");
        let missing = root.join("absent-scratch");
        let error = stage_source_samples(
            &engine,
            &AtomicBool::new(false),
            Path::new("unused.tif"),
            &RasterGrid {
                width: 4,
                height: 4,
                geotransform: [0.0, 1.0, 0.0, 4.0, 0.0, -1.0],
            },
            "EPSG:3857",
            None,
            &missing,
            "0000000000000000",
        )
        .expect_err("unmeasurable capacity must fail");
        assert!(error.contains("Cannot verify free space"), "{error}");
        let _ = std::fs::remove_dir_all(root);
    }

    /// A failed conversion must fail staging, retain nothing durable and leave
    /// no partial asset behind.
    // A read-only directory needs Unix permissions; Windows ignores them on folders.
    #[cfg(unix)]
    #[test]
    fn staged_output_write_failure_removes_partial_assets() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let dir = crate::test_scratch::TestScratch::new("canopi-write-failure");
        std::fs::create_dir_all(&dir).unwrap();
        let (width, height) = (40u32, 30u32);
        let source = write_staging_fixture(&engine, &dir, "failure", width, height, -9999.0);
        let grid = RasterGrid {
            width,
            height,
            geotransform: [0.0, 1.0, 0.0, height as f64, 0.0, -1.0],
        };

        // A read-only scratch root makes the conversion's own output fail.
        let scratch = dir.join("read-only-scratch");
        std::fs::create_dir(&scratch).unwrap();
        let mut permissions = std::fs::metadata(&scratch).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            permissions.set_mode(0o555);
        }
        std::fs::set_permissions(&scratch, permissions).unwrap();

        let error = stage_source_samples(
            &engine,
            &cancel,
            &source,
            &grid,
            "EPSG:3857",
            Some(-9999.0),
            &scratch,
            "0123456789abcdef",
        )
        .expect_err("an unwritable conversion must fail staging");
        assert!(!error.is_empty());
        // Nothing durable was created, and no staged file survives: the job
        // directory holds no source COG, and the global store holds no asset.
        let paths = LidarPaths::open(&dir).expect("library paths");
        let assets: usize = std::fs::read_dir(paths.asset_dir(""))
            .into_iter()
            .flatten()
            .flatten()
            .count();
        assert_eq!(assets, 0, "no asset is created from a failed conversion");
        let staged: Vec<_> = std::fs::read_dir(&scratch)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(staged.is_empty(), "staged leftovers: {staged:?}");

        let mut permissions = std::fs::metadata(&scratch).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            permissions.set_mode(0o755);
        }
        std::fs::set_permissions(&scratch, permissions).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The import caller charges the retained source COG, its conversion
    /// scratch and the shared reserve together, and rejects before any engine
    /// work when that combined footprint does not fit.
    #[test]
    fn staged_source_rejects_an_insufficient_combined_budget_before_preparation() {
        use crate::services::lidar::paths::capacity_probe;
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let dir = crate::test_scratch::TestScratch::new("canopi-combined-budget");
        std::fs::create_dir_all(&dir).unwrap();
        let grid = RasterGrid {
            width: 1024,
            height: 1024,
            geotransform: [0.0, 1.0, 0.0, 1024.0, 0.0, -1.0],
        };
        let required = crate::services::lidar::prepared_raster::required_free_bytes(
            grid.width,
            grid.height,
            0,
        )
        .unwrap();
        let _guard = capacity_probe::override_available(required - 1);
        // A missing input never reaches the engine: the capacity error proves the
        // combined check ran before the conversion.
        let error = stage_source_samples(
            &engine,
            &cancel,
            &dir.join("absent-input.tif"),
            &grid,
            "EPSG:3857",
            None,
            &dir,
            "0123456789abcdef",
        )
        .expect_err("the combined footprint must be rejected");
        assert!(
            error.contains(&required.to_string()),
            "names the required bytes: {error}"
        );
        assert!(
            error.contains(&(required - 1).to_string()),
            "names the available bytes: {error}"
        );
        assert_eq!(
            std::fs::read_dir(&dir)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "tif"))
                .count(),
            0,
            "no conversion output on rejection"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// At exactly the combined requirement the real caller proceeds, and one
    /// byte less still rejects: the boundary is inclusive at the requirement
    /// and one retained COG is the only durable output.
    #[test]
    fn staged_source_admits_exactly_the_combined_requirement() {
        use crate::services::lidar::paths::capacity_probe;
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let dir = crate::test_scratch::TestScratch::new("canopi-combined-boundary");
        std::fs::create_dir_all(&dir).unwrap();
        let paths = LidarPaths::open(&dir).expect("library paths");
        let job_dir = paths.job_dir("boundary-job");
        std::fs::create_dir_all(&job_dir).unwrap();
        let (width, height) = (1024u32, 1024u32);
        let source = write_staging_fixture(&engine, &dir, "boundary", width, height, -9999.0);
        let grid = RasterGrid {
            width,
            height,
            geotransform: [0.0, 1.0, 0.0, height as f64, 0.0, -1.0],
        };
        let required = crate::services::lidar::prepared_raster::required_free_bytes(
            grid.width,
            grid.height,
            0,
        )
        .unwrap();
        {
            let _guard = capacity_probe::override_available(required);
            let (cog, valid_cells) = stage_source_samples(
                &engine,
                &cancel,
                &source,
                &grid,
                "EPSG:3857",
                Some(-9999.0),
                &job_dir,
                "fedcba9876543210",
            )
            .expect("the exact combined requirement admits the work");
            assert!(cog.value_range[0].is_finite() && cog.value_range[1].is_finite());
            assert!(cog.bytes > 0);
            // An independent oracle for the same grid: a cell is valid when it
            // is finite and differs from the declared sentinel.
            let expected_valid = (0..height)
                .flat_map(|y| (0..width).map(move |x| (x, y)))
                .filter(|(x, y)| {
                    let value = staged_value(*x, *y);
                    value.is_finite() && value != -9999.0
                })
                .count() as u64;
            assert_eq!(
                valid_cells, expected_valid,
                "the prepared source reports the valid cells it actually holds"
            );
            let staged_path = cog.resolve(&paths, "boundary-job").unwrap();
            assert!(
                staged_path.exists(),
                "the COG is the job's own durable output at {}",
                staged_path.display()
            );
            assert_eq!(staged_path.parent(), Some(job_dir.as_path()));
            assert!(
                !paths.asset_cog(&cog.sha256).exists(),
                "nothing is admitted globally before publication"
            );
        }
        {
            let _guard = capacity_probe::override_available(required - 1);
            let error = stage_source_samples(
                &engine,
                &cancel,
                &source,
                &grid,
                "EPSG:3857",
                Some(-9999.0),
                &dir,
                "fedcba9876543210",
            )
            .expect_err("one byte below the requirement must reject");
            assert!(error.contains(&required.to_string()), "{error}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    // -----------------------------------------------------------------------
    // Sparse-generation caller slice: stage → review → Apply → reopen → undo
    // -----------------------------------------------------------------------

    /// One constant-fill source with an explicit origin, so tests can place
    /// members on the layer lattice without depending on probe defaults.
    #[expect(
        clippy::too_many_arguments,
        reason = "ratcheted before 2.1-M188; group the arguments when this function next changes"
    )]
    fn write_placed_fixture(
        engine: &dyn RasterEngine,
        dir: &Path,
        name: &str,
        origin_x: f64,
        origin_y: f64,
        width: u32,
        height: u32,
        nodata: f32,
        value: f32,
    ) -> PathBuf {
        let values = vec![value; (width * height) as usize];
        let raw = dir.join(format!("{name}.raw"));
        write_f32_raw(&raw, &values).expect("fixture raw writes");
        let tif = dir.join(format!("{name}.tif"));
        raw_to_tif(
            engine,
            &AtomicBool::new(false),
            &raw,
            &tif,
            &RasterGrid {
                width,
                height,
                geotransform: [origin_x, 1.0, 0.0, origin_y, 0.0, -1.0],
            },
            "EPSG:3857",
            nodata,
        )
        .expect("fixture converts");
        let _ = std::fs::remove_file(&raw);
        let _ = std::fs::remove_file(raw.with_extension("hdr"));
        tif
    }

    /// Declared NoData is not data, so it must not enter the source range.
    ///
    /// The range is the physical span a user sees, and a sentinel like -9999
    /// would otherwise dominate it and misreport the dataset. The rule is the
    /// validity mask's own: a sample counts only when it is finite and differs
    /// from the source's declared NoData, which keeps valid zero and negative
    /// samples and excludes the sentinel.
    #[test]
    fn source_range_excludes_declared_nodata_and_keeps_zero_and_negative() {
        let root = crate::test_scratch::TestScratch::new("canopi-range-nodata");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);

        let nodata = -9999.0f32;
        let raw = root.join("nodata-mix.raw");
        // A finite sentinel beside a valid negative, a valid zero and a valid
        // positive value, which is the case the bug reports.
        write_f32_raw(&raw, &[nodata, -1.5, 0.0, 2.5]).unwrap();
        let tif = root.join("nodata-mix.tif");
        let grid = RasterGrid {
            width: 2,
            height: 2,
            geotransform: [0.0, 1.0, 0.0, 0.0, 0.0, -1.0],
        };
        raw_to_tif(&engine, &cancel, &raw, &tif, &grid, "EPSG:3857", nodata)
            .expect("fixture converts");

        // The retained source COG is the controlled profile the reader accepts,
        // so the test converts through the same writer the production path uses
        // rather than inventing a second profile.
        let cog = crate::services::lidar::raster_assets::write_job_source_cog(
            &engine,
            &cancel,
            &root,
            "controlled",
            &tif,
            &grid,
            "EPSG:3857",
            Some(nodata),
        )
        .expect("fixture converts to the controlled profile");

        let mut reader = PreparedRaster::open_committed(&cog.path, &grid, Some(nodata))
            .expect("reader opens the fixture");
        let (range, valid_cells) = scan_source_facts(&mut reader, &cancel).expect("scan");

        assert_eq!(
            range,
            [-1.5, 2.5],
            "the declared NoData sentinel must not extend the range"
        );
        assert_eq!(valid_cells, 3, "the sentinel is not a valid sample");
        drop(reader);

        // With no declared NoData the same samples are all data, so the rule
        // follows the source's own declaration rather than the value's shape:
        // a legitimate -9999 sample is still data when nothing declares it.
        let mut reader = PreparedRaster::open_committed(&cog.path, &grid, None)
            .expect("reader opens the fixture without a nodata rule");
        let (range, valid_cells) = scan_source_facts(&mut reader, &cancel).expect("scan");
        assert_eq!(range, [-9999.0, 2.5]);
        assert_eq!(valid_cells, 4);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The same fixture placed with an explicit CRS declaration.
    #[expect(
        clippy::too_many_arguments,
        reason = "ratcheted before 2.1-M188; group the arguments when this function next changes"
    )]
    fn write_crs_fixture(
        engine: &dyn RasterEngine,
        dir: &Path,
        name: &str,
        crs: &str,
        origin_x: f64,
        origin_y: f64,
        width: u32,
        height: u32,
        value: f32,
    ) -> PathBuf {
        let values = vec![value; (width * height) as usize];
        let raw = dir.join(format!("{name}.raw"));
        write_f32_raw(&raw, &values).expect("fixture raw writes");
        let tif = dir.join(format!("{name}.tif"));
        raw_to_tif(
            engine,
            &AtomicBool::new(false),
            &raw,
            &tif,
            &RasterGrid {
                width,
                height,
                geotransform: [origin_x, 1.0, 0.0, origin_y, 0.0, -1.0],
            },
            crs,
            -9999.0,
        )
        .expect("fixture converts");
        let _ = std::fs::remove_file(&raw);
        let _ = std::fs::remove_file(raw.with_extension("hdr"));
        tif
    }

    /// Prepare one batch the way the one-step route does, ready to publish.
    ///
    /// Items are fixed once published, so a batch aimed at a published item is
    /// staged into a new item of the same kind, as a user's next import would
    /// be. Callers read the target from `StagedImport::layer_id`.
    fn stage_review(
        library: &LidarLibrary,
        layer_id: &str,
        sources: &[PathBuf],
        cancel: &AtomicBool,
    ) -> (String, StagedImport) {
        let published = catalogue::head_generation(&library.catalogue().unwrap(), layer_id)
            .unwrap()
            .is_some();
        let next_layer;
        let layer_id = if published {
            next_layer = library
                .create_layer(
                    "next import",
                    common_types::library::RasterQuantity::GroundElevation,
                    None,
                    false,
                )
                .expect("next item created");
            next_layer.as_str()
        } else {
            layer_id
        };
        let job_id = library.record_import_job(layer_id).expect("job recorded");
        stage_import(library, &job_id, layer_id, sources, cancel)
            .unwrap_or_else(|error| panic!("fixtures must be admitted: {error}"));
        let staging = read_staged_import(library, &job_id).expect("staged payload");
        (job_id, staging)
    }

    /// The accepted head row of a layer.
    fn head_of(library: &LidarLibrary, layer_id: &str) -> catalogue::GenerationRow {
        let connection = library.catalogue().unwrap();
        catalogue::head_generation(&connection, layer_id)
            .unwrap()
            .expect("layer has a head")
    }

    /// Published resolved-chunk rows of a generation: an ordered collection
    /// materializes none.
    fn published_chunk_count(library: &LidarLibrary, generation_id: &str) -> usize {
        let connection = library.catalogue().unwrap();
        catalogue::generation_chunk_assets(&connection, generation_id, "result")
            .unwrap()
            .len()
    }

    /// Occupied lattice chunks of a layer's accepted composition.
    ///
    /// Derived arithmetically from the member list, which is what the resolver
    /// visits: no raster is opened and the empty gap between separated sources
    /// contributes nothing.
    fn head_occupied_chunks(library: &LidarLibrary, layer_id: &str) -> Vec<(i64, i64)> {
        let head = head_of(library, layer_id);
        let manifest = read_generation_manifest(&head.manifest_json).unwrap();
        let reader = super::super::collection::load_reader(
            library,
            &head.id,
            &manifest,
            &AtomicBool::new(false),
        )
        .expect("every member still resolves");
        reader.occupied_chunks().unwrap()
    }

    /// Member count of a layer's accepted ordered composition.
    fn head_member_count(library: &LidarLibrary, layer_id: &str) -> usize {
        let head = head_of(library, layer_id);
        let connection = library.catalogue().unwrap();
        catalogue::collection_members(&connection, &head.id)
            .unwrap()
            .len()
    }

    /// Read a window of the accepted head exactly as a caller would.
    fn head_window(
        library: &LidarLibrary,
        layer_id: &str,
        window: generation::LatticeWindow,
    ) -> (Vec<f32>, Vec<u8>) {
        let head = head_of(library, layer_id);
        let manifest = read_generation_manifest(&head.manifest_json).unwrap();
        let cancel = AtomicBool::new(false);
        let reader = super::super::collection::load_reader(library, &head.id, &manifest, &cancel)
            .expect("every member still resolves");
        let resolved = reader
            .read_window(window, &cancel)
            .expect("window resolves");
        (resolved.samples, resolved.valid)
    }

    /// P1-4: one common interpretation for a layer's first batch.
    ///
    /// Without an accepted head there is nothing to compare a source against,
    /// so the first compatible selection becomes the anchor. Equal-coordinate
    /// rasters that declare different horizontal CRSs must not be admitted
    /// together: the lattice could not reconcile them and a later read could
    /// not reconcile them either.
    #[test]
    fn a_first_batch_refuses_sources_that_disagree_on_the_horizontal_crs() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let root = crate::test_scratch::TestScratch::new("canopi-first-batch-crs");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let web_mercator =
            write_crs_fixture(&engine, &root, "web", "EPSG:3857", 0.0, 4.0, 4, 4, 5.0);
        let lambert =
            write_crs_fixture(&engine, &root, "lambert", "EPSG:2154", 0.0, 4.0, 4, 4, 7.0);

        let library = LidarLibrary::open(&root).expect("library opens");
        let layer_id = library
            .create_layer(
                "first batch crs",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        let job_id = library.record_import_job(&layer_id).expect("job recorded");
        let staging_error = stage_import(
            &library,
            &job_id,
            &layer_id,
            &[web_mercator, lambert],
            &cancel,
        )
        .expect_err("a mixed-CRS batch is refused by preparation");
        assert!(
            staging_error.contains("horizontal CRS differs"),
            "the refusal names the CRS disagreement: {staging_error}"
        );
        {
            let connection = library.catalogue().unwrap();
            assert!(
                catalogue::head_generation(&connection, &layer_id)
                    .unwrap()
                    .is_none(),
                "a refused batch publishes nothing"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An item's stored coverage ends at its rasters' own edges, not at the
    /// edge of the last 1024-cell chunk they touch, so Fit to data frames the
    /// data itself. Sizes that are not chunk multiples (an 800-pixel IGN tile,
    /// a 1000-cell tile) and a pair whose second source extends past the
    /// first (the lattice keeps the first source's size) both hold it.
    #[test]
    fn an_items_bounds_equal_its_rasters_extent_through_the_crs_authority() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let root = crate::test_scratch::TestScratch::new("canopi-item-bounds");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let (x0, y0) = (652_000.0, 6_863_000.0);
        let single = write_crs_fixture(
            &engine,
            &root,
            "tile",
            "EPSG:2154",
            x0,
            y0,
            1000,
            1000,
            35.0,
        );
        let west = write_crs_fixture(&engine, &root, "west", "EPSG:2154", x0, y0, 800, 800, 35.0);
        let east = write_crs_fixture(
            &engine,
            &root,
            "east",
            "EPSG:2154",
            x0 + 800.0,
            y0 - 100.0,
            800,
            800,
            36.0,
        );
        let library = LidarLibrary::open(&root).expect("library opens");
        let grid = |x: f64, y: f64, width: u32, height: u32| RasterGrid {
            width,
            height,
            geotransform: [x, 1.0, 0.0, y, 0.0, -1.0],
        };
        for (sources, extent) in [
            (vec![single], grid(x0, y0, 1000, 1000)),
            (vec![west, east], grid(x0, y0, 1600, 900)),
        ] {
            let layer_id = library
                .create_layer(
                    "item bounds",
                    common_types::library::RasterQuantity::GroundElevation,
                    None,
                    false,
                )
                .unwrap();
            let (_job, staging) = stage_review(&library, &layer_id, &sources, &cancel);
            apply_import(&library, &staging, &cancel).expect("the item publishes");
            let stored: Vec<f64> =
                serde_json::from_str(&head_of(&library, &layer_id).bounds_3857).unwrap();
            let expected = raster_bounds_3857(&engine, &cancel, &extent, "EPSG:2154").unwrap();
            assert_eq!(stored.len(), 4, "{stored:?}");
            for (got, want) in stored.iter().zip(expected) {
                assert!(
                    (got - want).abs() <= 1e-6 * want.abs().max(1.0),
                    "stored bounds {stored:?} equal the rasters' extent {expected:?}"
                );
            }
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// canopi-dfc0: one bar covers the whole job, so the percentage never
    /// falls. Preparation fills its share once per converted source, the job
    /// moves to publishing at that share under "Rendering map" (the worker's
    /// next step, the display derivative), the worker's own rendering step
    /// does not pull it back, and publication carries on to "Finalizing".
    #[test]
    fn an_import_job_progress_only_rises_from_preparation_to_publication() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let root = crate::test_scratch::TestScratch::new("canopi-job-progress");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let west = write_placed_fixture(&engine, &root, "west", 0.0, 4.0, 4, 4, -9999.0, 5.0);
        let east = write_placed_fixture(&engine, &root, "east", 4.0, 4.0, 4, 4, -9999.0, 7.0);
        let library = LidarLibrary::open(&root).expect("library opens");
        let layer_id = library
            .create_layer(
                "job progress",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        let job_id = library.record_import_job(&layer_id).expect("job recorded");
        let progress = || {
            library
                .get_import_job(&job_id)
                .unwrap()
                .unwrap()
                .progress
                .expect("the job shows progress")
        };
        let mut seen = Vec::new();
        // What preparation shows as each of the two sources converts.
        record_staging_progress(&library, &job_id, 1, 2);
        seen.push(progress());
        record_staging_progress(&library, &job_id, 2, 2);
        seen.push(progress());
        // The real preparation, which ends by moving the job to publishing.
        stage_import(&library, &job_id, &layer_id, &[west, east], &cancel)
            .expect("the pair prepares");
        let publishing = progress();
        assert_eq!(publishing.phase, LidarImportProgressPhase::RenderingMap);
        seen.push(publishing);
        // The worker's rendering step, then publication.
        library.record_import_progress(&job_id, LidarImportProgressPhase::RenderingMap, 1);
        seen.push(progress());
        let staging = read_staged_import(&library, &job_id).expect("staged payload");
        apply_import(&library, &staging, &cancel).expect("the pair publishes");
        let finished = progress();
        assert_eq!(finished.phase, LidarImportProgressPhase::Finalizing);
        seen.push(finished);
        let percents: Vec<u8> = seen.iter().map(|step| step.percent).collect();
        assert!(
            percents.windows(2).all(|pair| pair[0] <= pair[1]),
            "the percentage never falls: {seen:?}"
        );
        assert!(
            percents[1] < 50,
            "preparation leaves most of the bar to publication: {seen:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// canopi-dfc0: preparation advances the job's progress once per
    /// converted source, under the existing "Preparing raster" phase, within
    /// its share of the job's bar.
    #[test]
    fn preparation_advances_progress_once_per_converted_source() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let root = crate::test_scratch::TestScratch::new("canopi-staging-progress");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let west = write_placed_fixture(&engine, &root, "west", 0.0, 4.0, 4, 4, -9999.0, 5.0);
        let east = write_placed_fixture(&engine, &root, "east", 4.0, 4.0, 4, 4, -9999.0, 7.0);
        let broken = root.join("broken.tif");
        std::fs::write(&broken, b"not a raster").unwrap();

        let library = LidarLibrary::open(&root).expect("library opens");
        let layer_id = library
            .create_layer(
                "staging progress",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        let job_id = library.record_import_job(&layer_id).expect("job recorded");
        let progress = || library.get_import_job(&job_id).unwrap().unwrap().progress;
        assert_eq!(progress(), None, "nothing is converted yet");
        // The third source fails after two were converted: the job still
        // shows how far preparation got.
        stage_import(
            &library,
            &job_id,
            &layer_id,
            &[west.clone(), east.clone(), broken],
            &cancel,
        )
        .expect_err("the broken source refuses the batch");
        assert_eq!(
            progress(),
            Some(common_types::lidar::LidarImportProgress {
                phase: LidarImportProgressPhase::PreparingRaster,
                percent: 26,
            })
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// P1-4: an all-NoData source is refused by name before review.
    #[test]
    fn an_all_nodata_source_is_refused_by_name() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let root = crate::test_scratch::TestScratch::new("canopi-zero-valid");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // Every cell equals the declared NoData sentinel, so the source has no
        // valid sample under its own rule.
        let empty = write_placed_fixture(&engine, &root, "empty", 0.0, 4.0, 4, 4, -9999.0, -9999.0);
        let real = write_placed_fixture(&engine, &root, "real", 0.0, 4.0, 4, 4, -9999.0, 5.0);

        let library = LidarLibrary::open(&root).expect("library opens");
        let layer_id = library
            .create_layer(
                "zero valid",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        let job_id = library.record_import_job(&layer_id).expect("job recorded");
        let refusal = stage_import(&library, &job_id, &layer_id, &[empty, real], &cancel)
            .expect_err("an all-NoData source refuses the batch");
        assert!(
            refusal.contains("empty.tif"),
            "the refusal names the file: {refusal}"
        );
        assert!(
            refusal.contains("no valid samples"),
            "and says why: {refusal}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A south-up GeoTIFF is refused at import by name: the display warp
    /// and every reader take north-up grids only.
    #[test]
    fn a_south_up_source_is_refused_by_name() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let root = crate::test_scratch::TestScratch::new("canopi-south-up");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // A positive pixel height is written as a negative ModelPixelScale y,
        // which reads back as a south-up grid.
        let south_up = root.join("south-up.tif");
        wbgeotiff::GeoTiffWriter::new(4, 4, 1)
            .geo_transform(wbgeotiff::GeoTransform::north_up(
                650_000.0,
                1.0,
                6_862_000.0,
                1.0,
            ))
            .epsg(2154)
            .no_data(-9999.0)
            .write_f32(&south_up, &[5.0; 16])
            .unwrap();
        let real = write_placed_fixture(&engine, &root, "real", 0.0, 4.0, 4, 4, -9999.0, 5.0);

        let library = LidarLibrary::open(&root).expect("library opens");
        let layer_id = library
            .create_layer(
                "south up",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        let job_id = library.record_import_job(&layer_id).expect("job recorded");
        let refusal = stage_import(&library, &job_id, &layer_id, &[south_up, real], &cancel)
            .expect_err("a south-up source is refused");
        assert!(
            refusal.contains("south-up.tif"),
            "the refusal names the file: {refusal}"
        );
        assert!(
            refusal.contains("rotated, reflected, or south-up"),
            "and says why: {refusal}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// P1-3: published statistics and the reopened samples are the same
    /// composition.
    ///
    /// A full-cover import of 9 above 5 reads back as 9, so its published range
    /// must be 9..9 as well. Building the incoming occurrence with the
    /// superseded Add/ReplaceOverlap roles measured a different composition
    /// than the one the snapshot actually replays.
    #[test]
    fn published_statistics_match_the_reopened_composition() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let root = crate::test_scratch::TestScratch::new("canopi-published-statistics");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let five = write_placed_fixture(&engine, &root, "five", 0.0, 4.0, 4, 4, -9999.0, 5.0);
        let nine = write_placed_fixture(&engine, &root, "nine", 0.0, 4.0, 4, 4, -9999.0, 9.0);

        let library = LidarLibrary::open(&root).expect("library opens");
        let layer_id = library
            .create_layer(
                "published statistics",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        // One item of two overlapping sources, topmost first.
        let (_job, staging) = stage_review(&library, &layer_id, &[nine, five], &cancel);
        let applied = apply_import(&library, &staging, &cancel).expect("the pair applies");
        let head = head_of(&library, &layer_id);
        assert_eq!(head.id, applied.generation_id);
        // Two members cannot be composed from metadata, so the exact count and
        // range are unknown. What the generation does publish is the display
        // range: the union of its members' own ranges, labelled as an envelope.
        assert_eq!(head.coverage_cells, None);
        assert_eq!(head.min_value, None);
        assert_eq!(head.max_value, None);
        assert_eq!(head.display_min_value, Some(5.0));
        assert_eq!(head.display_max_value, Some(9.0));
        assert_eq!(head.display_basis.as_deref(), Some("source-envelope"));

        drop(library);
        let reopened = LidarLibrary::open(&root).expect("library reopens");
        let (values, valid) = head_window(
            &reopened,
            &layer_id,
            generation::LatticeWindow {
                x: 0,
                y: 0,
                width: 4,
                height: 4,
            },
        );
        assert!(valid.iter().all(|byte| *byte == 1));
        assert!(
            values.iter().all(|value| *value == 9.0),
            "the reopened composition is the one the statistics describe: {values:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// P2-8: source-region facts translate to absolute pixels.
    ///
    /// A 2048x1 source whose valid cells begin in the second block reported no
    /// coverage and a 0..0 range, because every block was read as if it started
    /// at the member's first pixel.
    #[test]
    fn source_region_facts_cover_later_blocks() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let root = crate::test_scratch::TestScratch::new("canopi-region-facts");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // Cells 0..1024 are NoData; 1024..2048 are seven.
        let mut values = vec![-9999.0f32; 2048];
        for value in values.iter_mut().skip(1024) {
            *value = 7.0;
        }
        let source =
            write_oracle_fixture(&engine, &root, "half", 0.0, 1.0, 2048, 1, -9999.0, &values);

        let library = LidarLibrary::open(&root).expect("library opens");
        let layer_id = library
            .create_layer(
                "region facts",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        let (_job, staging) = stage_review(&library, &layer_id, &[source], &cancel);
        apply_import(&library, &staging, &cancel).expect("publishes");

        let summary = library.layer_collection(&layer_id, None).unwrap();
        let listed = &summary.sources[0];
        assert_eq!(
            listed.coverage_cells, 1024,
            "the source list reports the valid half, not the first block"
        );
        assert_eq!(
            listed.value_range,
            [7.0, 7.0],
            "and the range of the samples it actually holds"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // -----------------------------------------------------------------------
    // B5: representative sparse-gap run
    // -----------------------------------------------------------------------

    /// Two members a million pixels apart plus one that extends the lattice
    /// left of the anchor: only the occupied chunks may be stored, read and
    /// displayed, and the gap must never be walked.
    #[test]
    fn sparse_gap_import_stores_only_occupied_chunks() {
        let root = crate::test_scratch::TestScratch::new("canopi-gap-run");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let sampler = crate::services::lidar::measurement::Sampler::start();
        let library = LidarLibrary::open(&root).expect("library opens");
        // The union spans ~45M cells, so this representative run raises the
        // interim admission envelope for its own thread: production keeps the
        // 25M bound, while the block-wise review still costs only the data.
        let _admission = admission::limits_probe::raise(128 * 1024 * 1024, 16, 1024 * 1024 * 1024);

        let left =
            write_placed_fixture(&engine, &root, "left", -500.0, 1000.0, 40, 30, -9999.0, 3.0);
        let anchor =
            write_placed_fixture(&engine, &root, "anchor", 0.0, 1000.0, 60, 45, -9999.0, 5.0);
        let far = write_placed_fixture(
            &engine,
            &root,
            "far",
            1_000_000.0,
            1000.0,
            32,
            24,
            -9999.0,
            7.0,
        );
        let expected_cells = (60 * 45 + 40 * 30 + 32 * 24) as u64;

        let layer_id = library
            .create_layer(
                "sparse gap",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        // The lattice anchors on the first selected source, so selecting the
        // anchor first makes the left member extend it into negative cells.
        let (_job_id, staging) = stage_review(&library, &layer_id, &[anchor, left, far], &cancel);
        assert!(
            staging.union_grid.width > 1_000_000,
            "the union spans the gap: {}",
            staging.union_grid.width
        );
        apply_import(&library, &staging, &cancel).expect("apply");

        let head = head_of(&library, &layer_id);
        assert_eq!(head.coverage_cells, None);
        assert_eq!(head.min_value, None);
        assert_eq!(head.max_value, None);
        assert_eq!(head.display_min_value, Some(3.0));
        assert_eq!(head.display_max_value, Some(7.0));
        assert_eq!(head.display_basis.as_deref(), Some("source-envelope"));
        let _ = expected_cells;
        // The composition materializes nothing at all: its cost is member
        // metadata, and only the occupied lattice blocks are ever visited.
        assert_eq!(
            published_chunk_count(&library, &head.id),
            0,
            "an ordered composition stores no resolved source raster"
        );
        let occupied = head_occupied_chunks(&library, &layer_id);
        assert_eq!(
            occupied.len(),
            3,
            "one block per occupied cell group: {occupied:?}"
        );
        assert!(
            occupied.iter().any(|(x, _)| *x < 0),
            "the left extension lives before the fixed anchor: {occupied:?}"
        );
        assert!(occupied.iter().any(|(x, _)| *x > 900), "{occupied:?}");
        // Nothing anywhere in the library tree is area-proportional: the union
        // is ~45M cells, so a resolved write would be hundreds of megabytes.
        let stored: i64 = {
            let connection = library.catalogue().unwrap();
            connection
                .query_row(
                    "SELECT COALESCE(SUM(a.bytes), 0) FROM lidar_generation_chunks g
                     JOIN lidar_raster_assets a ON a.sha256 = g.asset_sha256
                     WHERE g.generation_id = ?1 AND g.state = 'published'",
                    [&head.id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert_eq!(
            stored, 0,
            "no resolved bytes are written for the composition"
        );
        let gap_rows: i64 = {
            let connection = library.catalogue().unwrap();
            connection
                .query_row(
                    "SELECT COUNT(*) FROM lidar_generation_chunks
                     WHERE generation_id = ?1 AND chunk_x BETWEEN 1 AND 900",
                    [&head.id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert_eq!(gap_rows, 0, "the gap holds no index row at all");

        // Reads: exact values inside each member, exactly invalid in the gap.
        let sample = |x: i64, y: i64| -> (f32, u8) {
            let (samples, valid) = head_window(
                &library,
                &layer_id,
                generation::LatticeWindow {
                    x,
                    y,
                    width: 1,
                    height: 1,
                },
            );
            (samples[0], valid[0])
        };
        // The layer lattice is anchored on the first selected source, so the
        // anchor keeps cell 0 and the left member sits before it.
        let (value, valid) = sample(0, 0);
        assert_eq!((value, valid), (5.0, 1));
        let (value, valid) = sample(-500, 0);
        assert_eq!((value, valid), (3.0, 1));
        let (_, valid) = sample(600, 0);
        assert_eq!(valid, 0, "the gap is exactly invalid");
        let (_, valid) = sample(999_999, 0);
        assert_eq!(valid, 0, "the gap is invalid for its whole width");
        let (value, valid) = sample(1_000_000, 0);
        assert_eq!((value, valid), (7.0, 1));

        drop(library);
        let measurement = sampler.finish();
        let _ = crate::services::lidar::measurement::gate_combined_budget(
            "sparse gap run",
            &measurement,
        );
        let _ = std::fs::remove_dir_all(&root);
    }
    /// The authorized 24-tile authored run: more tiles than the production
    /// file-count ceiling allows, spread across a million-cell gap, imported
    /// as one batch and stored as occupied chunks only.
    #[test]
    fn sparse_twenty_four_tile_batch_stays_chunk_sized() {
        let root = crate::test_scratch::TestScratch::new("canopi-24-tile");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let sampler = crate::services::lidar::measurement::Sampler::start();
        let library = LidarLibrary::open(&root).expect("library opens");
        // No admission override: 24 files and 96M processing cells are inside
        // the production policy, while the union this arrangement spans is far
        // above the retired envelope bound. Running the real policy is what
        // makes this a capacity witness rather than an overridden probe.

        // Three columns eight rows apart, each column 100,000 cells from the
        // next, so the union is far larger than the data it holds.
        let mut sources = Vec::new();
        for column in 0..3u32 {
            for row in 0..8u32 {
                let name = format!("tile-{column}-{row}");
                sources.push(write_placed_fixture(
                    &engine,
                    &root,
                    &name,
                    f64::from(column) * 100_000.0,
                    1000.0 - f64::from(row) * 40.0,
                    32,
                    24,
                    -9999.0,
                    10.0 + f64::from(row) as f32,
                ));
            }
        }
        // Twenty-four files is exactly the production file ceiling: this batch
        // is admitted at the boundary rather than over it, and the union it
        // spans is what the retired envelope bound refused.
        assert_eq!(sources.len(), admission::MAX_SOURCE_FILES_PER_IMPORT);

        let layer_id = library
            .create_layer(
                "24 tiles",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        let (_job_id, staging) = stage_review(&library, &layer_id, &sources, &cancel);
        apply_import(&library, &staging, &cancel).expect("apply");

        let head = head_of(&library, &layer_id);
        // Twenty-four occurrences cannot be composed from metadata alone, so the
        // generation claims no exact count. The member facts below are what the
        // batch is charged and what its display range is built from.
        assert_eq!(
            head.coverage_cells, None,
            "a multi-member composition does not claim an exact count"
        );
        assert_eq!(head.display_basis.as_deref(), Some("source-envelope"));
        assert_eq!(
            head_member_count(&library, &layer_id),
            24,
            "every selected source is its own occurrence"
        );
        assert_eq!(
            head_occupied_chunks(&library, &layer_id).len(),
            3,
            "one occupied block per column; the eight rows share it"
        );
        assert_eq!(
            published_chunk_count(&library, &head.id),
            0,
            "a 24-source batch stores member metadata only"
        );
        let total_bytes: i64 = {
            let connection = library.catalogue().unwrap();
            connection
                .query_row(
                    "SELECT COALESCE(SUM(a.bytes), 0) FROM lidar_generation_chunks g
                     JOIN lidar_raster_assets a ON a.sha256 = g.asset_sha256
                     WHERE g.generation_id = ?1 AND g.state = 'published'",
                    [&head.id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        let union_cells =
            u64::from(staging.union_grid.width) * u64::from(staging.union_grid.height);
        // Processing cost is charged per occurrence, so the same batch that
        // spans an over-limit envelope costs only its own 96M cells. This is
        // the concrete case the retired envelope bound refused by geometry the
        // batch never decodes.
        let proposed: Vec<admission::ProcessingCost> = (0..head_member_count(&library, &layer_id))
            .map(|_| admission::ProcessingCost {
                width: 32,
                height: 24,
            })
            .collect();
        let proposed_cells = admission::processing_cells(proposed.iter().copied()).unwrap();
        println!(
            "24 tiles: {} cells in {} members, {total_bytes} resolved bytes, \
             union {union_cells} cells, proposed {proposed_cells} processing cells",
            24 * 32 * 24,
            head_member_count(&library, &layer_id)
        );
        assert!(
            union_cells > 25_000_000,
            "the arranged union spans far more cells than it holds"
        );
        assert_eq!(proposed_cells, 24 * 32 * 24);
        assert!(
            admission::check_processing_budget(proposed.iter().copied(), "sparse 24-tile batch")
                .is_ok(),
            "the processing budget admits the batch, charging occurrences and not the gap"
        );
        assert!(
            total_bytes < 3 * 8 * 1024 * 1024,
            "three chunks' worth of bytes, not the union's area: {total_bytes}"
        );

        drop(library);
        let measurement = sampler.finish();
        let _ = crate::services::lidar::measurement::gate_combined_budget(
            "24-tile batch",
            &measurement,
        );
        let _ = std::fs::remove_dir_all(&root);
    }
    // -----------------------------------------------------------------------
    // BG5: admission is one policy, decided before review and rechecked at Apply
    // -----------------------------------------------------------------------

    /// Two small sources far apart: their union envelope spans 25M cells, but
    /// the governing bound is the processing cells the collection proposes,
    /// and two 4x4 sources propose 32.
    #[test]
    fn admission_admits_a_separated_pair_by_its_own_cells() {
        let root = crate::test_scratch::TestScratch::new("canopi-admit-over");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let library = LidarLibrary::open(&root).expect("library opens");
        let south_west = write_placed_fixture(&engine, &root, "sw", 0.0, 4.0, 4, 4, -9999.0, 3.0);
        let north_east =
            write_placed_fixture(&engine, &root, "ne", 4997.0, 5000.0, 4, 4, -9999.0, 7.0);
        let layer_id = library
            .create_layer(
                "envelope over",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        // No override: this must run under the real production policy.
        assert_eq!(
            admission::limits(),
            admission::AdmissionLimits::production()
        );
        let (_job_id, staging) =
            stage_review(&library, &layer_id, &[south_west, north_east], &cancel);
        let envelope = u64::from(staging.union_grid.width) * u64::from(staging.union_grid.height);
        assert!(envelope > 25_000_000, "the arrangement is wide: {envelope}");
        assert_eq!(staging.processing_cells, 32);
        apply_import(&library, &staging, &cancel)
            .expect("the processing budget admits the pair, charging the sources and not the gap");
        let head = head_of(&library, &layer_id);
        assert_eq!(head.coverage_cells, None);
        assert_eq!(
            head_member_count(&library, &layer_id),
            2,
            "both separated occurrences are retained"
        );
        drop(library);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A lowered processing budget refuses an ordinary pair before any work
    /// depends on it, and nothing is published: the ordered path consults the
    /// policy rather than a hard-coded ceiling of its own.
    #[test]
    fn admission_refuses_a_pair_over_the_processing_budget() {
        let root = crate::test_scratch::TestScratch::new("canopi-admit-budget");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let library = LidarLibrary::open(&root).expect("library opens");
        let south_west = write_placed_fixture(&engine, &root, "sw", 0.0, 4.0, 4, 4, -9999.0, 3.0);
        let north_east =
            write_placed_fixture(&engine, &root, "ne", 4997.0, 5000.0, 4, 4, -9999.0, 7.0);
        let layer_id = library
            .create_layer(
                "budget over",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        // Only the processing budget is lowered, below the pair's own 32 cells,
        // so a refusal can only come from the processing-budget check.
        let _lowered = admission::limits_probe::set(admission::AdmissionLimits {
            files: 24,
            source_bytes: 2 * 1024 * 1024 * 1024,
            import_bytes: 2 * 1024 * 1024 * 1024,
            processing_cells: 16,
        });
        let job_id = library.record_import_job(&layer_id).expect("job recorded");
        let error = stage_import(
            &library,
            &job_id,
            &layer_id,
            &[south_west, north_east],
            &cancel,
        )
        .expect_err("a pair over the processing budget must be refused");
        assert!(error.contains("processing cells"), "{error}");
        assert!(error.contains("32"), "{error}");
        // Nothing was published and no head was created.
        let connection = library.catalogue().unwrap();
        for table in [
            "lidar_layer_generations",
            "lidar_layer_heads",
            "lidar_generation_chunks",
            "lidar_layer_lattices",
        ] {
            assert_eq!(
                {
                    let mut statement = connection
                        .prepare(&format!("SELECT COUNT(*) FROM {table}"))
                        .unwrap();
                    statement.query_row([], |row| row.get::<_, i64>(0)).unwrap()
                },
                0,
                "{table} must stay empty after a refused import"
            );
        }
        drop(connection);
        drop(library);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// canopi-dfc0: a GeoTIFF streams at any size, so the processing budget
    /// is the bound on what preparation converts, and it is checked from the
    /// probe before a source converts: a source at exactly the budget
    /// prepares, one cell over is refused with no retained COG written, and
    /// a batch is charged as it goes, refusing the source that crosses it by
    /// name before that source converts.
    #[test]
    fn the_processing_budget_refuses_a_source_before_it_converts() {
        let root = crate::test_scratch::TestScratch::new("canopi-budget-before-conversion");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let library = LidarLibrary::open(&root).expect("library opens");
        // Two 4x4 sources: 16 processing cells each.
        let west = write_placed_fixture(&engine, &root, "west", 0.0, 4.0, 4, 4, -9999.0, 5.0);
        let east = write_placed_fixture(&engine, &root, "east", 4.0, 4.0, 4, 4, -9999.0, 7.0);
        let budget = |processing_cells| {
            admission::limits_probe::set(admission::AdmissionLimits {
                files: 24,
                source_bytes: 2 * 1024 * 1024 * 1024,
                import_bytes: 2 * 1024 * 1024 * 1024,
                processing_cells,
            })
        };
        let new_item = |name: &str| {
            library
                .create_layer(
                    name,
                    common_types::library::RasterQuantity::GroundElevation,
                    None,
                    false,
                )
                .unwrap()
        };
        let source_cogs = |job_id: &str| {
            std::fs::read_dir(library.inner.paths.job_dir(job_id))
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .filter(|entry| {
                            entry
                                .file_name()
                                .to_string_lossy()
                                .starts_with("source-cog-")
                        })
                        .count()
                })
                .unwrap_or(0)
        };

        // Exactly the budget: the source prepares.
        {
            let _budget = budget(16);
            let layer_id = new_item("at the budget");
            let job_id = library.record_import_job(&layer_id).expect("job recorded");
            stage_import(
                &library,
                &job_id,
                &layer_id,
                std::slice::from_ref(&west),
                &cancel,
            )
            .expect("a source at exactly the budget prepares");
        }

        // One cell over: refused from the probe, before any conversion.
        {
            let _budget = budget(15);
            let layer_id = new_item("one cell over");
            let job_id = library.record_import_job(&layer_id).expect("job recorded");
            let error = stage_import(
                &library,
                &job_id,
                &layer_id,
                std::slice::from_ref(&west),
                &cancel,
            )
            .expect_err("a source one cell over the budget is refused");
            assert!(
                error.contains("west.tif") && error.contains("16 processing cells"),
                "the refusal names the file and its cost: {error}"
            );
            assert_eq!(source_cogs(&job_id), 0, "nothing was converted");
            assert_eq!(
                library.get_import_job(&job_id).unwrap().unwrap().progress,
                None,
                "no source is reported as converted"
            );
        }

        // A batch is charged source by source: the second crosses the budget
        // and is refused by name before it converts.
        {
            let _budget = budget(31);
            let layer_id = new_item("batch over");
            let job_id = library.record_import_job(&layer_id).expect("job recorded");
            let error = stage_import(
                &library,
                &job_id,
                &layer_id,
                &[west.clone(), east.clone()],
                &cancel,
            )
            .expect_err("a batch over the budget is refused");
            assert!(
                error.contains("east.tif") && error.contains("32 processing cells"),
                "the refusal names the source that crosses the budget: {error}"
            );
            assert_eq!(source_cogs(&job_id), 1, "only the first source converted");
        }
        drop(library);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The managed-original copy and verification paths read the same policy,
    /// so a lowered bound stops a copy and a raised one lets it through: no
    /// hidden hard-coded ceiling survives beside the policy.
    #[test]
    fn the_copy_and_hash_paths_are_governed_by_the_same_policy() {
        let root = crate::test_scratch::TestScratch::new("canopi-copy-policy");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let library = LidarLibrary::open(&root).expect("library opens");
        let source =
            write_placed_fixture(&engine, &root, "policy", 0.0, 64.0, 64, 64, -9999.0, 1.0);
        let bytes = std::fs::metadata(&source).unwrap().len();
        assert!(bytes > 1, "the fixture has content to copy");

        let layer_id = library
            .create_layer(
                "copy policy",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();

        // A lowered per-source bound refuses the selection by name.
        {
            // The bound is lowered below this file's own size, so the refusal
            // can only come from the policy the copy path consults.
            let _lowered = admission::limits_probe::set(admission::AdmissionLimits {
                files: 4,
                source_bytes: (bytes / 2).max(1),
                import_bytes: 4096,
                processing_cells: 1_000_000,
            });
            let job_id = library.record_import_job(&layer_id).expect("job recorded");
            let error = stage_import(
                &library,
                &job_id,
                &layer_id,
                std::slice::from_ref(&source),
                &cancel,
            )
            .expect_err("a source over the lowered bound must be refused");
            assert!(error.contains("per-source limit"), "{error}");
        }

        // The same file is staged once the policy allows it, so no other
        // ceiling stands in the way.
        let (_job_id, _staging) =
            stage_review(&library, &layer_id, std::slice::from_ref(&source), &cancel);
        drop(library);
        let _ = std::fs::remove_dir_all(&root);
    }

    // -----------------------------------------------------------------------
    // BG1: a retained source COG is the durable member payload
    // -----------------------------------------------------------------------

    /// Exact Float32 oracle fixture: the caller's own numbers, sentinel cells
    /// included, so a read compares without a tolerance.
    #[expect(
        clippy::too_many_arguments,
        reason = "ratcheted before 2.1-M188; group the arguments when this function next changes"
    )]
    fn write_oracle_fixture(
        engine: &dyn RasterEngine,
        dir: &Path,
        name: &str,
        origin_x: f64,
        origin_y: f64,
        width: u32,
        height: u32,
        nodata: f32,
        values: &[f32],
    ) -> PathBuf {
        assert_eq!(
            values.len(),
            (width * height) as usize,
            "the oracle covers the grid"
        );
        let raw = dir.join(format!("{name}.raw"));
        write_f32_raw(&raw, values).expect("oracle fixture writes");
        let tif = dir.join(format!("{name}.tif"));
        raw_to_tif(
            engine,
            &AtomicBool::new(false),
            &raw,
            &tif,
            &RasterGrid {
                width,
                height,
                geotransform: [origin_x, 1.0, 0.0, origin_y, 0.0, -1.0],
            },
            "EPSG:3857",
            nodata,
        )
        .expect("fixture converts");
        let _ = std::fs::remove_file(&raw);
        let _ = std::fs::remove_file(raw.with_extension("hdr"));
        tif
    }

    /// Every file under a directory, as relative path and size, in a stable
    /// order: enough to prove a caller created or rewrote nothing.
    fn tree_files(root: &Path) -> Vec<(String, u64)> {
        fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, u64)>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(root, &path, out);
                } else if let Ok(meta) = std::fs::metadata(&path) {
                    out.push((
                        path.strip_prefix(root)
                            .unwrap_or(&path)
                            .to_string_lossy()
                            .into_owned(),
                        meta.len(),
                    ));
                }
            }
        }
        let mut files = Vec::new();
        walk(root, root, &mut files);
        files.sort();
        files
    }

    /// A grid whose Float32 values are exactly representable, with two declared
    /// sentinel cells so validity is exercised beside the values.
    /// Samples at valid cells only; an invalid cell's stored value is not data.
    fn valid_values(values: &[f32], valid: &[u8]) -> Vec<Option<f32>> {
        values
            .iter()
            .zip(valid)
            .map(|(value, valid)| (*valid == 1).then_some(*value))
            .collect()
    }

    fn oracle_grid(width: u32, height: u32) -> (Vec<f32>, Vec<u8>) {
        let mut values: Vec<f32> = (0..(width * height))
            .map(|index| index as f32 * 0.25 - 3.5)
            .collect();
        values[7] = -9999.0;
        values[19] = -9999.0;
        let valid = values
            .iter()
            .map(|value| u8::from(*value != -9999.0))
            .collect();
        (values, valid)
    }

    /// The production vertical slice with source retention: staging keeps one
    /// controlled COG, review and Apply read it, no durable raw/mask/native.tif
    /// copy appears, a restart reads the published generation without preparing
    /// anything, and replacement and undo leave the shared asset immutable.
    #[test]
    fn a_retained_source_cog_is_the_only_durable_member_payload() {
        use crate::services::lidar::prepared_raster::observability;
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let root = crate::test_scratch::TestScratch::new("canopi-retained-payload");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let (width, height) = (6u32, 5u32);
        let (first_values, first_valid) = oracle_grid(width, height);
        let second_values: Vec<f32> = first_values
            .iter()
            .map(|value| {
                if *value == -9999.0 {
                    *value
                } else {
                    *value + 100.0
                }
            })
            .collect();
        let first = write_oracle_fixture(
            &engine,
            &root,
            "retained",
            0.0,
            100.0,
            width,
            height,
            -9999.0,
            &first_values,
        );
        let second = write_oracle_fixture(
            &engine,
            &root,
            "replacement",
            0.0,
            100.0,
            width,
            height,
            -9999.0,
            &second_values,
        );

        let library = LidarLibrary::open(&root).expect("library opens");
        let layer_id = library
            .create_layer(
                "retained payload",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        let (job_one, staging_one) =
            stage_review(&library, &layer_id, std::slice::from_ref(&first), &cancel);

        // Staging retained exactly one COG and no disposable second payload.
        let staged = &staging_one.sources[0];
        let retained = staged.source_cog.clone();
        // Ownership: the COG is the job's own file until publication, and no
        // global asset exists yet.
        let job_cog = retained
            .resolve(&library.inner.paths, &staged.job_id)
            .expect("the staged COG resolves under its job");
        assert!(job_cog.starts_with(library.inner.paths.job_dir(&job_one)));
        assert!(job_cog.exists(), "the job owns its prepared COG");
        let asset = library.inner.paths.asset_cog(&retained.sha256);
        assert!(
            !asset.exists(),
            "nothing is admitted globally before publication"
        );
        let staged_files = tree_files(&library.inner.paths.job_dir(&job_one));
        assert!(
            staged_files
                .iter()
                .all(|(path, _)| !path.ends_with("values.raw") && !path.ends_with("valid.bin")),
            "job scratch keeps no raw/mask payload: {staged_files:?}"
        );
        assert_eq!(
            staged_files
                .iter()
                .filter(|(path, _)| path.ends_with(".tif"))
                .count(),
            1,
            "the job holds exactly its own prepared COG: {staged_files:?}"
        );
        apply_import(&library, &staging_one, &cancel).expect("apply");

        // The interpretation references the shared digest.
        let interpretation_id = format!("interp-{}", staged.interp_hash);
        {
            let connection = library.catalogue().unwrap();
            let (row, nodata) = catalogue::interpretation_cog(&connection, &interpretation_id)
                .unwrap()
                .expect("the interpretation references its retained COG");
            assert_eq!(row.sha256, retained.sha256);
            assert_eq!(nodata, Some(-9999.0));
        }
        assert_eq!(std::fs::metadata(&asset).unwrap().len(), retained.bytes);

        // Restart: the accepted head reads back exactly through the committed
        // reader, and reading prepares nothing.
        drop(library);
        let reopened = LidarLibrary::open(&root).expect("library reopens");
        observability::reset();
        let before_read = tree_files(&root);
        let window = generation::LatticeWindow {
            x: 0,
            y: 0,
            width,
            height,
        };
        let head = head_of(&reopened, &layer_id);
        let _ = head;
        let (values, valid) = head_window(&reopened, &layer_id, window);
        assert_eq!(valid, first_valid, "validity is the source's own rule");
        assert_eq!(
            valid_values(&values, &valid),
            valid_values(&first_values, &first_valid),
            "Float32 values round-trip exactly"
        );
        assert!(
            observability::tiles_decoded() > 0,
            "the committed reader decoded the retained source COG"
        );
        assert_eq!(
            tree_files(&root),
            before_read,
            "reading a published generation prepares nothing"
        );

        // A second item publishes from its own retained source; the first
        // source's shared asset stays byte-identical and its item unchanged.
        let shared_before =
            crate::services::lidar::raster_assets::hash_file(&asset, &AtomicBool::new(false))
                .unwrap();
        let second_layer = reopened
            .create_layer(
                "second payload",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        let (_job_two, staging_two) = stage_review(
            &reopened,
            &second_layer,
            std::slice::from_ref(&second),
            &cancel,
        );
        assert_ne!(
            staging_two.sources[0].source_cog.sha256, retained.sha256,
            "different content is a different asset"
        );
        apply_import(&reopened, &staging_two, &cancel).expect("second item applies");
        let (second_read, second_valid) = head_window(&reopened, &second_layer, window);
        assert_eq!(
            valid_values(&second_read, &second_valid),
            valid_values(&second_values, &first_valid)
        );
        let (values, valid) = head_window(&reopened, &layer_id, window);
        assert_eq!(valid, first_valid);
        assert_eq!(
            valid_values(&values, &valid),
            valid_values(&first_values, &first_valid),
            "the first item is unchanged"
        );
        assert_eq!(
            crate::services::lidar::raster_assets::hash_file(&asset, &AtomicBool::new(false))
                .unwrap(),
            shared_before,
            "a retained asset is immutable"
        );
        drop(reopened);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A publication that fails after preparation publishes nothing, and a
    /// shared asset another publication already references survives exactly as
    /// it was.
    #[test]
    fn a_failed_apply_leaves_a_reused_asset_and_the_head_intact() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let root = crate::test_scratch::TestScratch::new("canopi-reused-asset");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let library = LidarLibrary::open(&root).expect("library opens");
        let layer_id = library
            .create_layer(
                "reused asset",
                common_types::library::RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();

        // One small source published normally: its COG is now a shared asset.
        let small = write_placed_fixture(&engine, &root, "small", 0.0, 4.0, 4, 4, -9999.0, 3.0);
        let (_job_one, staging_one) =
            stage_review(&library, &layer_id, std::slice::from_ref(&small), &cancel);
        let retained = staging_one.sources[0].source_cog.clone();
        apply_import(&library, &staging_one, &cancel).expect("apply");
        let asset = library.inner.paths.asset_cog(&retained.sha256);
        let shared_digest =
            crate::services::lidar::raster_assets::hash_file(&asset, &AtomicBool::new(false))
                .unwrap();
        let head_before = head_of(&library, &layer_id);

        // A second job reuses the same file and is cancelled before it
        // publishes: nothing changes and the shared asset is untouched.
        let (_job_two, staging_two) =
            stage_review(&library, &layer_id, std::slice::from_ref(&small), &cancel);
        assert_eq!(
            staging_two.sources[0].source_cog.sha256, retained.sha256,
            "content addressing reuses the admitted asset"
        );
        cancel.store(true, Ordering::Relaxed);
        let cancelled = apply_import(&library, &staging_two, &cancel)
            .expect_err("a cancelled Apply publishes nothing");
        assert!(cancelled.contains("cancelled"), "{cancelled}");
        cancel.store(false, Ordering::Relaxed);
        assert_eq!(
            crate::services::lidar::raster_assets::hash_file(&asset, &AtomicBool::new(false))
                .unwrap(),
            shared_digest,
            "a cancelled Apply never touches a shared asset"
        );
        assert_eq!(head_of(&library, &layer_id).id, head_before.id);

        // A third job reuses that file beside a far source. It prepares
        // normally — the ordered route charges occurrences, not an envelope —
        // so the failure below is a real publication failure rather than an
        // admission refusal.
        let far = write_placed_fixture(&engine, &root, "far", 5004.0, 5004.0, 4, 4, -9999.0, 7.0);
        let (_job_three, staging_three) =
            stage_review(&library, &layer_id, &[small.clone(), far], &cancel);
        assert_eq!(staging_three.sources[0].source_cog.sha256, retained.sha256);
        let far_interp = format!("interp-{}", staging_three.sources[1].interp_hash);
        {
            let connection = library.catalogue().unwrap();
            assert!(
                catalogue::interpretation_cog(&connection, &far_interp)
                    .unwrap()
                    .is_none(),
                "the new source has no reference yet"
            );
        }

        // A publication interrupted after promotion leaves nothing behind and
        // never disturbs the asset the accepted head already references.
        promotion_probe::fail_at(promotion_probe::FaultPoint::BeforeTransaction);
        let error = apply_import(&library, &staging_three, &cancel)
            .expect_err("the injected failure refuses the publication");
        promotion_probe::clear();
        assert!(error.contains("injected failure"), "{error}");
        let head_after = head_of(&library, &layer_id);
        assert_eq!(head_after.id, head_before.id);
        assert_eq!(head_after.coverage_cells, head_before.coverage_cells);
        {
            let connection = library.catalogue().unwrap();
            assert!(
                catalogue::interpretation_cog(&connection, &far_interp)
                    .unwrap()
                    .is_none(),
                "a refused Apply writes no reference"
            );
            let generations: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM lidar_layer_generations WHERE layer_id = ?1",
                    [&layer_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(generations, 1, "a refused Apply publishes nothing");
        }
        assert_eq!(
            crate::services::lidar::raster_assets::hash_file(&asset, &AtomicBool::new(false))
                .unwrap(),
            shared_digest,
            "the reused asset is untouched"
        );
        let (values, valid) = head_window(
            &library,
            &layer_id,
            generation::LatticeWindow {
                x: 0,
                y: 0,
                width: 4,
                height: 4,
            },
        );
        assert!(valid.iter().all(|byte| *byte == 1));
        assert!(values.iter().all(|value| *value == 3.0));

        // Promotion is idempotent: the same staged batch publishes once the
        // fault is gone, reusing the files it already moved into the store.
        apply_import(&library, &staging_three, &cancel).expect("the retry publishes");
        assert!(
            catalogue::interpretation_cog(&library.catalogue().unwrap(), &far_interp)
                .unwrap()
                .is_some()
        );
        drop(library);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A crash anywhere in publication leaves either no visible item or the
    /// complete one, and restart never deletes referenced data. Files moved
    /// into the store before the commit have no reference and are swept on the
    /// next open; an asset another item references is never touched; a
    /// committed item reads exactly after restart.
    #[test]
    fn a_crash_at_any_publication_point_leaves_no_item_or_a_complete_one() {
        use promotion_probe::FaultPoint;
        #[derive(Clone, Copy, Debug, PartialEq)]
        enum Crash {
            BeforeRename,
            AfterRenameBeforeCommit,
            AfterCommit,
        }
        let window = |x| generation::LatticeWindow {
            x,
            y: 0,
            width: 4,
            height: 4,
        };
        for crash in [
            Crash::BeforeRename,
            Crash::AfterRenameBeforeCommit,
            Crash::AfterCommit,
        ] {
            let engine = crate::services::lidar::rust_engine::RustRasterEngine;
            let cancel = AtomicBool::new(false);
            let root = crate::test_scratch::TestScratch::new("canopi-publication-crash");
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            let library = LidarLibrary::open(&root).expect("library opens");
            let accepted_layer = library
                .create_layer(
                    "accepted",
                    common_types::library::RasterQuantity::GroundElevation,
                    None,
                    false,
                )
                .unwrap();
            let paths = LidarPaths::open(&root).expect("library paths");

            // An accepted item whose source COG the crashing batch shares.
            let shared =
                write_placed_fixture(&engine, &root, "shared", 0.0, 8.0, 4, 4, -9999.0, 5.0);
            let (_, accepted) = stage_review(
                &library,
                &accepted_layer,
                std::slice::from_ref(&shared),
                &cancel,
            );
            apply_import(&library, &accepted, &cancel).expect("apply");
            let shared_asset = paths.asset_cog(&accepted.sources[0].source_cog.sha256);
            let shared_digest = crate::services::lidar::raster_assets::hash_file(
                &shared_asset,
                &AtomicBool::new(false),
            )
            .unwrap();

            let fresh =
                write_placed_fixture(&engine, &root, "fresh", 16.0, 8.0, 4, 4, -9999.0, 7.0);
            let (job, staging) =
                stage_review(&library, &accepted_layer, &[shared.clone(), fresh], &cancel);
            assert_eq!(
                staging.sources[0].source_cog.sha256, accepted.sources[0].source_cog.sha256,
                "the batch shares the accepted asset"
            );
            let fresh_hash = staging.sources[1].interp_hash.clone();
            let fresh_asset = paths.asset_cog(&staging.sources[1].source_cog.sha256);
            match crash {
                Crash::BeforeRename => {
                    promotion_probe::fail_at(FaultPoint::BeforePromotion);
                    apply_import(&library, &staging, &cancel).expect_err("the crash point");
                    assert!(!fresh_asset.exists(), "nothing was moved yet");
                }
                Crash::AfterRenameBeforeCommit => {
                    promotion_probe::fail_at(FaultPoint::BeforeTransaction);
                    apply_import(&library, &staging, &cancel).expect_err("the crash point");
                    assert!(fresh_asset.exists(), "the file was moved before the crash");
                }
                Crash::AfterCommit => {
                    apply_import(&library, &staging, &cancel).expect("apply");
                }
            }
            promotion_probe::clear();
            // The process dies here: no settlement or cleanup runs.
            drop(library);

            let reopened = LidarLibrary::open(&root).expect("library reopens");
            let head =
                catalogue::head_generation(&reopened.catalogue().unwrap(), &staging.layer_id)
                    .unwrap();
            if crash == Crash::AfterCommit {
                assert!(head.is_some(), "a committed item survives restart");
                assert!(fresh_asset.exists());
                assert!(committed_asset(&reopened, &fresh_hash).is_some());
                let (values, valid) = head_window(&reopened, &staging.layer_id, window(16));
                assert!(valid.iter().all(|byte| *byte == 1));
                assert!(values.iter().all(|value| *value == 7.0));
            } else {
                assert!(head.is_none(), "{crash:?}: no visible item");
                assert!(
                    !fresh_asset.exists(),
                    "{crash:?}: an unreferenced file is swept on restart"
                );
                assert_eq!(committed_asset(&reopened, &fresh_hash), None);
            }
            assert!(
                !paths.job_dir(&job).exists(),
                "the interrupted job is settled"
            );
            assert_eq!(
                crate::services::lidar::raster_assets::hash_file(
                    &shared_asset,
                    &AtomicBool::new(false)
                )
                .unwrap(),
                shared_digest,
                "{crash:?}: referenced data is never deleted"
            );
            let (values, valid) = head_window(&reopened, &accepted_layer, window(0));
            assert!(valid.iter().all(|byte| *byte == 1));
            assert!(values.iter().all(|value| *value == 5.0));
            drop(reopened);
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    /// The catalogue's view of one source: its committed reference, when any.
    fn committed_asset(library: &LidarLibrary, interp_hash: &str) -> Option<String> {
        let connection = library.catalogue().unwrap();
        catalogue::interpretation_cog(&connection, &format!("interp-{interp_hash}"))
            .unwrap()
            .map(|(row, _)| row.sha256)
    }
}
