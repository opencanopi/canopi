//! The windowed GeoLibre lane: one 1024² core chunk plus the recipe's halo at a
//! time, never a whole-extent raster.
//!
//! Each occupied chunk of the input's composition is resolved with its halo,
//! staged as a Float32 GeoTIFF with an exact finite NoData sentinel, run
//! through one pinned tool and read back. Only the core is kept: invalid
//! centres stay invalid whatever the tool wrote, and neither the tool's marker
//! nor the sentinel is ever published as a value. A stencil recipe also
//! publishes a 0/1 quality chunk marking cells whose whole stencil input was
//! valid; an all-zero quality chunk is absent.

use super::{RunContext, StagedRaster, values_in_metres};
use crate::services::lidar::catalogue::{self, new_id};
use crate::services::lidar::grid::RasterGrid;
use crate::services::lidar::{generation, import, raster_assets};
use common_types::analysis_registry::{AnalysisLane, AnalysisOutputSpec, GridRequirement};
use common_types::library::AnalysisUnavailable;
use std::path::Path;

/// Finite staging marker for GeoLibre windows: -2^127, exact in Float32 and in
/// its decimal tag. The pinned tools compare neighbour NoData by equality, so
/// NaN would not trigger their valid-centre substitution.
const STAGING_NODATA: f32 = f32::from_bits(0xFF00_0000);

/// One tool run per window.
pub(super) struct WindowedTool {
    pub tool: &'static str,
    /// Arguments after `--input` and `--output`.
    pub args: Vec<String>,
    /// Whether a NoData marker the tool declares can never equal a real value.
    pub marker_is_unambiguous: fn(f32) -> bool,
    /// Publish quality chunks: 1 where the whole halo neighbourhood was valid.
    pub stencil_quality: bool,
}

/// One computed chunk.
struct Block {
    chunk_x: i64,
    chunk_y: i64,
    result: Option<(generation::CogAsset, generation::RegionAggregate)>,
    quality: Option<generation::CogAsset>,
}

/// Run `tool` over every occupied chunk of the source bound to `input_key` and
/// stage `output` as unpublished chunks.
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
pub(super) fn run(
    context: &RunContext<'_>,
    input_key: &str,
    output: &'static AnalysisOutputSpec,
    tool: &WindowedTool,
) -> Result<StagedRaster, String> {
    let library = context.library;
    let cancel = context.cancel;
    let AnalysisLane::GeolibreWindowed { halo } = context.analysis.lane;
    let halo = i64::from(halo);
    let input = context.input(input_key)?;
    let spec = context.input_spec(input_key)?;
    let head = {
        let connection = library.catalogue()?;
        catalogue::layer_generation(&connection, &input.item_id, &input.generation_id)?
    }
    .ok_or_else(|| {
        format!(
            "input '{input_key}' must be an imported source with the pinned data; derived inputs are not windowed"
        )
    })?;
    let manifest = import::read_generation_manifest(&head.manifest_json)?;
    let reader =
        crate::services::lidar::collection::load_reader(library, &head.id, &manifest, cancel)?;
    let occurrences = reader.resolved().to_vec();
    check_requirements(
        context,
        input_key,
        spec.requires,
        &head.crs_class,
        &input.units,
    )?;

    let blocks = generation::occupied_chunks(&occurrences, &manifest.grid)?;
    let total = blocks.len();
    admit_storage(context.scratch, total, halo as u64)?;
    let mut computed = Vec::with_capacity(total);
    for (index, (chunk_x, chunk_y)) in blocks.into_iter().enumerate() {
        import::check_cancel(cancel)?;
        // Recheck before each bounded output: remaining work plus reserve, not
        // a second charge of bytes already written.
        admit_storage(context.scratch, total.saturating_sub(index), halo as u64)?;
        computed.push(compute_block(
            context,
            tool,
            &occurrences,
            &manifest.grid,
            &manifest.crs_ref,
            halo,
            chunk_x,
            chunk_y,
        )?);
        #[cfg(test)]
        crate::services::lidar::acceptance_hooks::after_block(
            context.scratch,
            computed.last().is_some_and(|block| block.result.is_some()),
        );
    }

    let mut coverage_cells = 0u64;
    let (mut min_value, mut max_value) = (f64::INFINITY, f64::NEG_INFINITY);
    for block in &computed {
        if let Some((_, aggregate)) = &block.result {
            coverage_cells = coverage_cells.saturating_add(aggregate.valid_cells.max(0) as u64);
            min_value = min_value.min(aggregate.min_value);
            max_value = max_value.max(aggregate.max_value);
        }
    }
    let value_range =
        (min_value.is_finite() && max_value.is_finite()).then_some((min_value, max_value));

    let generation_id = new_id("dgen");
    let paths = &library.inner.paths;
    let mut rows = Vec::new();
    {
        let connection = library.catalogue()?;
        for block in &computed {
            if let Some((asset, aggregate)) = &block.result {
                catalogue::insert_raster_asset(
                    &connection,
                    &generation::asset_row(paths, asset, &manifest.crs_ref)?,
                )?;
                rows.push(catalogue::GenerationChunkRow {
                    role: generation::RESULT_ROLE.to_string(),
                    chunk_x: block.chunk_x,
                    chunk_y: block.chunk_y,
                    asset_sha256: asset.sha256.clone(),
                    valid_cells: aggregate.valid_cells,
                    min_value: aggregate.min_value,
                    max_value: aggregate.max_value,
                    sum_value: aggregate.sum_value,
                });
            }
            if let Some(asset) = &block.quality {
                catalogue::insert_raster_asset(
                    &connection,
                    &generation::asset_row(paths, asset, &manifest.crs_ref)?,
                )?;
                rows.push(catalogue::GenerationChunkRow {
                    role: generation::QUALITY_ROLE.to_string(),
                    chunk_x: block.chunk_x,
                    chunk_y: block.chunk_y,
                    asset_sha256: asset.sha256.clone(),
                    valid_cells: 1,
                    min_value: 0.0,
                    max_value: 1.0,
                    sum_value: 0.0,
                });
            }
        }
        catalogue::insert_unpublished_chunks(&connection, &generation_id, &rows)?;
    }
    Ok(StagedRaster {
        output_key: output.key,
        generation_id,
        grid: manifest.grid.clone(),
        crs_ref: manifest.crs_ref.clone(),
        crs_class: head.crs_class.clone(),
        bounds_3857: head.bounds_3857.clone(),
        coverage_cells,
        value_range,
    })
}

/// Recheck an input's requirements against the pinned generation's catalogue
/// facts, the ones its request was admitted on (`crs_class` comes from the
/// table row, as the engine reads it).
fn check_requirements(
    context: &RunContext<'_>,
    input_key: &str,
    requires: &[GridRequirement],
    crs_class: &str,
    units: &str,
) -> Result<(), String> {
    for requirement in requires {
        match requirement {
            GridRequirement::MetreValues => {
                if !values_in_metres(units) {
                    return Err(format!(
                        "{} needs values in metres; input '{input_key}' reports '{units}'",
                        context.analysis.id
                    ));
                }
            }
            GridRequirement::ProjectedMetreGrid => {
                if crs_class != super::CRS_PROJECTED_METRE {
                    return Err(format!(
                        "{}: {}",
                        context.analysis.id,
                        super::unavailable_message(
                            input_key,
                            &AnalysisUnavailable::GridNotProjectedMetres
                        )
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Compute one core chunk through the bounded resolver.
#[expect(
    clippy::too_many_arguments,
    reason = "ratcheted before 2.1-M188; group the arguments when this function next changes"
)]
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn compute_block(
    context: &RunContext<'_>,
    tool: &WindowedTool,
    occurrences: &[generation::ResolvedMember],
    lattice: &RasterGrid,
    crs_ref: &str,
    halo: i64,
    chunk_x: i64,
    chunk_y: i64,
) -> Result<Block, String> {
    let library = context.library;
    let engine = library.inner.engine.as_ref();
    let paths = &library.inner.paths;
    let cancel = context.cancel;
    let scratch = context.scratch;
    let side = generation::CHUNK_SIDE;
    let halo_window = generation::LatticeWindow {
        x: chunk_x * side - halo,
        y: chunk_y * side - halo,
        width: (side + 2 * halo) as u32,
        height: (side + 2 * halo) as u32,
    };
    let resolved = generation::resolve_window(occurrences, lattice, halo_window, cancel)?;
    let halo_grid = generation::window_grid(lattice, halo_window)?;
    let halo_side = halo_window.width as usize;
    if resolved
        .samples
        .iter()
        .zip(resolved.valid.iter())
        .any(|(value, valid)| *valid != 0 && *value == STAGING_NODATA)
    {
        return Err(format!(
            "window {chunk_x},{chunk_y} holds a valid sample equal to the staging NoData marker"
        ));
    }
    let staged: Vec<f32> = resolved
        .samples
        .iter()
        .zip(resolved.valid.iter())
        .map(|(value, valid)| if *valid == 0 { STAGING_NODATA } else { *value })
        .collect();

    let stem = format!("window-{chunk_x}-{chunk_y}");
    let raw = scratch.join(format!("{stem}.raw"));
    import::write_f32_raw(&raw, &staged)?;
    let halo_path = scratch.join(format!("{stem}-halo.tif"));
    let written = import::raw_to_tif(
        engine,
        cancel,
        &raw,
        &halo_path,
        &halo_grid,
        crs_ref,
        STAGING_NODATA,
    );
    let _ = std::fs::remove_file(&raw);
    written?;

    let block_path = scratch.join(format!("{stem}-block.tif"));
    let computed =
        library
            .inner
            .geolibre
            .run(tool.tool, &halo_path, &block_path, &tool.args, cancel);
    let _ = std::fs::remove_file(&halo_path);
    if let Err(error) = computed {
        let _ = std::fs::remove_file(&block_path);
        return Err(error);
    }

    // The tool marks uncomputed cells with its own NoData marker, so read it
    // back and treat it as invalid before anything is persisted; a marker a
    // real value could equal is refused by name.
    let block_nodata = engine.probe(&block_path, cancel)?.nodata;
    if let Some(marker) = block_nodata
        && marker.is_finite()
        && !(tool.marker_is_unambiguous)(marker)
    {
        let _ = std::fs::remove_file(&block_path);
        return Err(format!(
            "{} output declares NoData {marker}, which a real value could equal",
            tool.tool
        ));
    }
    let block_raw = import::raw_f32_bytes(
        engine,
        &block_path,
        halo_window.width,
        halo_window.height,
        cancel,
    );
    let _ = std::fs::remove_file(&block_path);
    let block_raw = block_raw?;

    let core_side = side as usize;
    let reach = halo as usize;
    let mut values = vec![f32::NAN; core_side * core_side];
    let mut quality = vec![0f32; core_side * core_side];
    let mut aggregate = generation::RegionAggregate {
        block_x: chunk_x,
        block_y: chunk_y,
        valid_cells: 0,
        min_value: f64::INFINITY,
        max_value: f64::NEG_INFINITY,
        sum_value: 0.0,
    };
    for row in 0..core_side {
        for column in 0..core_side {
            // The core cell sits one halo inside the resolved window.
            let halo_x = column + reach;
            let halo_y = row + reach;
            let value = import::f32_sample(&block_raw, halo_y * halo_side + halo_x);
            let index = row * core_side + column;
            let centre_valid = resolved.valid[halo_y * halo_side + halo_x] != 0;
            if centre_valid
                && value.is_finite()
                && Some(value) != block_nodata
                && value != STAGING_NODATA
            {
                values[index] = value;
                aggregate.valid_cells += 1;
                aggregate.min_value = aggregate.min_value.min(f64::from(value));
                aggregate.max_value = aggregate.max_value.max(f64::from(value));
                aggregate.sum_value += f64::from(value);
            }
            if tool.stencil_quality
                && neighbourhood_is_valid(&resolved.valid, halo_side, halo_x, halo_y, reach)
            {
                quality[index] = 1.0;
            }
        }
    }

    let core_grid = generation::chunk_grid(lattice, chunk_x, chunk_y);
    let result = if aggregate.valid_cells == 0 {
        None
    } else {
        Some((
            raster_assets::write_cog_asset(
                engine,
                cancel,
                paths,
                scratch,
                &stem,
                &core_grid,
                crs_ref,
                Some(f32::NAN),
                &values,
            )?,
            aggregate,
        ))
    };
    let quality = if quality.contains(&1.0) {
        Some(raster_assets::write_cog_asset(
            engine,
            cancel,
            paths,
            scratch,
            &format!("{stem}-quality"),
            &core_grid,
            crs_ref,
            None,
            &quality,
        )?)
    } else {
        None
    };
    Ok(Block {
        chunk_x,
        chunk_y,
        result,
        quality,
    })
}

/// Whether the whole `(2·reach+1)²` input neighbourhood of one halo cell was
/// originally valid.
fn neighbourhood_is_valid(valid: &[u8], side: usize, x: usize, y: usize, reach: usize) -> bool {
    for row in y.saturating_sub(reach)..=(y + reach).min(side - 1) {
        for column in x.saturating_sub(reach)..=(x + reach).min(side - 1) {
            if valid[row * side + column] == 0 {
                return false;
            }
        }
    }
    true
}

/// Storage admission over the actual occupied work.
///
/// Covers core+halo buffers, staged result and quality bytes and the shared
/// reserve with checked arithmetic. Widely separated small members admit
/// despite a large lattice envelope; occupied work beyond available storage is
/// refused before any output is written.
pub(super) fn admit_storage(
    scratch: &Path,
    occupied_blocks: usize,
    halo: u64,
) -> Result<(), String> {
    let side = u64::try_from(generation::CHUNK_SIDE)
        .map_err(|_| "chunk side is not representable".to_string())?;
    let overflow = || "the windowed working set overflows".to_string();
    let halo_side = halo
        .checked_mul(2)
        .and_then(|margin| side.checked_add(margin))
        .ok_or_else(overflow)?;
    let halo_cells = halo_side.checked_mul(halo_side).ok_or_else(overflow)?;
    let core_cells = side.checked_mul(side).ok_or_else(overflow)?;
    // Core+halo f32 samples, staged result+quality bytes, and one block's
    // scratch overlap, all per occupied block.
    let per_block = halo_cells
        .checked_mul(4)
        .and_then(|bytes| bytes.checked_add(core_cells.checked_mul(8)?))
        .and_then(|bytes| bytes.checked_add(core_cells.checked_mul(4)?))
        .ok_or_else(overflow)?;
    let blocks = u64::try_from(occupied_blocks).map_err(|_| overflow())?;
    let side_u32 = u32::try_from(side).map_err(|_| overflow())?;
    let reserve =
        crate::services::lidar::prepared_raster::required_free_bytes(side_u32, side_u32, 0)?;
    let total = per_block
        .checked_mul(blocks)
        .and_then(|bytes| bytes.checked_add(reserve))
        .ok_or_else(overflow)?;
    crate::services::lidar::paths::require_free_space(
        scratch,
        total,
        "the windowed analysis working set",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn low_capacity_refuses_windowed_admission_before_output() {
        let root = crate::test_scratch::TestScratch::new("canopi-windowed-admission");
        std::fs::create_dir_all(&root).unwrap();
        {
            let _guard = crate::services::lidar::paths::capacity_probe::override_available(
                8 * 1024 * 1024 * 1024,
            );
            admit_storage(&root, 4, 2).expect("ample capacity admits");
        }
        {
            let _guard = crate::services::lidar::paths::capacity_probe::override_available(1);
            let error = admit_storage(&root, 4, 2).expect_err("low capacity refuses");
            assert!(error.contains("free"), "named capacity reason: {error}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_neighbourhood_is_valid_only_when_every_cell_is() {
        let mut valid = vec![1u8; 25];
        assert!(neighbourhood_is_valid(&valid, 5, 2, 2, 2));
        valid[0] = 0;
        assert!(!neighbourhood_is_valid(&valid, 5, 2, 2, 2));
        assert!(neighbourhood_is_valid(&valid, 5, 3, 3, 1));
    }
}
