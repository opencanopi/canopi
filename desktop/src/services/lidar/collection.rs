//! Ordered source collections: one library item's priority list of
//! independent source COGs.
//!
//! An item's generation is an immutable list of ordered member occurrences.
//! Its numeric value is the highest-priority valid sample at each location,
//! resolved from the retained source COGs on demand; no merged raster is ever
//! materialized. Display, slope and inspection read the same composition
//! through [`generation::CollectionReader`].
//!
//! The catalogue owns membership and order (library data); a Design owns only
//! references and presentation. This module never touches a Design.

use std::sync::atomic::AtomicBool;

use super::LidarLibrary;
use super::catalogue::{self, CollectionMemberRow};
use super::generation::{self, CollectionReader, ResolvedMember};
use super::grid::{RasterGrid, union_grid};
use super::import::{self, GenerationManifest};

/// One planned occurrence of a generation, top-first.
pub(super) struct SnapshotMember {
    pub member_id: String,
    pub interpretation_id: String,
    pub resolved: ResolvedMember,
}

/// A planned immutable generation, ready to publish.
pub(super) struct SnapshotPlan {
    /// Top-first priority list: index 0 is the topmost source.
    pub members: Vec<SnapshotMember>,
    pub lattice: RasterGrid,
    pub crs_ref: String,
    pub nodata: f32,
    /// Manifest `members` list: interpretation hashes, top-first.
    pub manifest_members: Vec<String>,
}

/// A generation that has been measured and is ready to commit.
pub(super) struct SnapshotMeasurement {
    /// Exact valid cells, or `None` when the composition's count is not
    /// derivable from member metadata.
    pub published_cells: Option<u64>,
    /// Exact composed range, or `None` when it is not derivable.
    pub min_value: Option<f64>,
    pub max_value: Option<f64>,
    /// The range styling and legends use: exact for one member, the envelope
    /// of member ranges otherwise.
    pub display_min_value: f64,
    pub display_max_value: f64,
    pub display_basis: canopi_types::lidar::LidarDisplayRangeBasis,
    pub bounds_3857: [f64; 4],
}

/// Bind one generation's members for a read, top-first.
pub(super) fn load_reader(
    library: &LidarLibrary,
    generation_id: &str,
    manifest: &GenerationManifest,
    cancel: &AtomicBool,
) -> Result<CollectionReader, String> {
    let members = snapshot_members(library, generation_id, cancel)?
        .into_iter()
        .map(|member| (member.member_id, member.resolved))
        .collect();
    CollectionReader::new(members, manifest.grid.clone())
}

/// Resolve one generation's stored rows into readable occurrences, top-first.
pub(super) fn snapshot_members(
    library: &LidarLibrary,
    generation_id: &str,
    cancel: &AtomicBool,
) -> Result<Vec<SnapshotMember>, String> {
    let rows = {
        let connection = library.catalogue()?;
        catalogue::collection_members(&connection, generation_id)?
    };
    rows.iter()
        .map(|row| {
            import::check_cancel(cancel)?;
            resolve_row(library, row)
        })
        .collect()
}

/// Resolve one stored member row into its retained source COG.
fn resolve_row(
    library: &LidarLibrary,
    row: &CollectionMemberRow,
) -> Result<SnapshotMember, String> {
    let connection = library.catalogue()?;
    let interpretation = catalogue::get_interpretation(&connection, &row.interpretation_id)?
        .ok_or_else(|| format!("missing interpretation {}", row.interpretation_id))?;
    let (cog, cog_nodata) =
        generation::retained_cog(&connection, &library.inner.paths, &row.interpretation_id)?
            .ok_or_else(|| format!("the source COG of member {} is missing", row.member_id))?;
    let grid = RasterGrid {
        width: u32::try_from(interpretation.width.max(0)).unwrap_or(u32::MAX),
        height: u32::try_from(interpretation.height.max(0)).unwrap_or(u32::MAX),
        geotransform: import::parse_geotransform(&interpretation.geotransform)?,
    };
    Ok(SnapshotMember {
        member_id: row.member_id.clone(),
        interpretation_id: row.interpretation_id.clone(),
        resolved: ResolvedMember {
            ordinal: row.position,
            grid,
            nodata: cog_nodata.or(interpretation.nodata.map(|value| value as f32)),
            cog,
        },
    })
}

/// Derive a planned composition's metadata **without reading its pixels**.
///
/// Publishing membership does not require knowing the composed values: the
/// composition is defined by its members, their order and their own stored
/// facts, all of which the catalogue already holds. The pass below therefore
/// opens no raster and decodes nothing; its cost follows the member list, not
/// the coverage.
///
/// Exact composed facts are what cannot be derived from member metadata, so
/// they are reported only when they really are derivable:
///
/// - an empty composition is exactly zero cells with no range;
/// - a composition of one member *is* that member, so its exact facts carry
///   over;
/// - anything else reports the exact count and range as unknown rather than
///   summing member counts, which would count overlap and occluded cells twice
///   and call an envelope an area.
///
/// The display range is always available, because it is not a statistic: it is
/// the union of the stored member ranges, labelled by that basis.
pub(super) fn measure(
    library: &LidarLibrary,
    plan: &SnapshotPlan,
    cancel: &AtomicBool,
) -> Result<SnapshotMeasurement, String> {
    import::check_cancel(cancel)?;
    let (exact_cells, exact_min, exact_max, any_range, display_min, display_max) = {
        let connection = library.catalogue()?;
        let mut member_cells = 0u64;
        let mut display_min = f64::INFINITY;
        let mut display_max = f64::NEG_INFINITY;
        let mut any_range = false;
        for member in &plan.members {
            import::check_cancel(cancel)?;
            let (cells, min, max) = member_facts(&connection, member)?;
            member_cells = member_cells.saturating_add(cells);
            if let (Some(min), Some(max)) = (min, max)
                && min.is_finite()
                && max.is_finite()
            {
                display_min = display_min.min(min);
                display_max = display_max.max(max);
                any_range = true;
            }
        }
        // No member holds a valid cell, so the composition holds none either: this
        // is the one composed statement member facts can make soundly, and it is
        // exact because an empty union needs every member to be empty.
        let exact_cells = match plan.members.len() {
            0 => Some(0),
            1 => Some(member_cells),
            _ if member_cells == 0 => Some(0),
            _ => None,
        };
        let (exact_min, exact_max) = match (plan.members.len(), any_range) {
            (1, true) => (Some(display_min), Some(display_max)),
            // An empty or all-NoData composition has a known range of nothing.
            (_, false) if exact_cells == Some(0) => (Some(0.0), Some(0.0)),
            _ => (None, None),
        };
        (
            exact_cells,
            exact_min,
            exact_max,
            any_range,
            display_min,
            display_max,
        )
        // Catalogue facts are collected here; the guard is released before any
        // bounds transform or reader work so unrelated catalogue reads proceed.
    };
    let bounds_3857 = coverage_bounds(library, plan, cancel)?;
    let (display_min_value, display_max_value) = if any_range {
        (display_min, display_max)
    } else {
        // No member declares a range: a constant-domain generation renders
        // transparently, which is what the styling path already does with a
        // zero-width domain.
        (0.0, 0.0)
    };
    Ok(SnapshotMeasurement {
        published_cells: exact_cells,
        min_value: exact_min,
        max_value: exact_max,
        display_min_value,
        display_max_value,
        // A range only one member supplied is that member's own exact range; a
        // union of several is an envelope, and it is labelled as one.
        display_basis: if plan.members.len() == 1 {
            canopi_types::lidar::LidarDisplayRangeBasis::Exact
        } else {
            canopi_types::lidar::LidarDisplayRangeBasis::SourceEnvelope
        },
        bounds_3857,
    })
}

/// One member's own stored exact facts, without opening its payload.
fn member_facts(
    connection: &rusqlite::Connection,
    member: &SnapshotMember,
) -> Result<(u64, Option<f64>, Option<f64>), String> {
    let (cells, min, max) =
        catalogue::interpretation_coverage(connection, &member.interpretation_id)?;
    Ok((cells.max(0) as u64, min, max))
}

/// Display bounds: the envelope of the members' own extents.
///
/// Arithmetic over member grids, opening nothing. It ends at the rasters'
/// edges, not at their last 1024-cell chunk's, so Fit to data frames the data.
/// A composition with no member keeps the lattice bounds.
fn coverage_bounds(
    library: &LidarLibrary,
    plan: &SnapshotPlan,
    cancel: &AtomicBool,
) -> Result<[f64; 4], String> {
    let engine = library.inner.engine.as_ref();
    let mut grids = plan.members.iter().map(|member| &member.resolved.grid);
    let Some(first) = grids.next() else {
        return import::raster_bounds_3857(engine, cancel, &plan.lattice, &plan.crs_ref);
    };
    plan.lattice.compatible(first)?;
    let mut envelope = first.clone();
    for grid in grids {
        envelope = union_grid(&envelope, grid)?;
    }
    import::raster_bounds_3857(engine, cancel, &envelope, &plan.crs_ref)
}

/// The manifest of an ordered snapshot.
pub(super) fn manifest_for(
    library: &LidarLibrary,
    plan: &SnapshotPlan,
) -> Result<(String, GenerationManifest), String> {
    let manifest = GenerationManifest {
        grid: plan.lattice.clone(),
        nodata: plan.nodata,
        crs_ref: plan.crs_ref.clone(),
        members: plan.manifest_members.clone(),
        engine_version: import::engine_version(library.inner.engine.as_ref()),
        created_at: catalogue::now_iso(),
    };
    let json = serde_json::to_string(&manifest).map_err(|e| e.to_string())?;
    Ok((json, manifest))
}

/// Record one generation's row and ordered members.
///
/// Called inside the caller's publication transaction: the generation row, the
/// member rows readers select by, the promoted source references and the head
/// become visible together or not at all.
pub(super) fn insert_snapshot(
    connection: &rusqlite::Connection,
    layer_id: &str,
    generation_id: &str,
    plan: &SnapshotPlan,
    measurement: &SnapshotMeasurement,
    manifest_json: &str,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO lidar_layer_generations(id, layer_id, created_at, manifest_json, coverage_cells, min_value, max_value, display_min_value, display_max_value, display_basis, bounds_3857, crs_class)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                generation_id,
                layer_id,
                catalogue::now_iso(),
                manifest_json,
                measurement.published_cells.map(|cells| cells as i64),
                measurement.min_value,
                measurement.max_value,
                measurement.display_min_value,
                measurement.display_max_value,
                super::display_basis_label(measurement.display_basis),
                serde_json::to_string(&measurement.bounds_3857).map_err(|e| e.to_string())?,
                super::analyses::crs_class(&plan.crs_ref),
            ],
        )
        .map_err(|e| format!("Failed to record the collection generation: {e}"))?;
    let rows: Vec<CollectionMemberRow> = plan
        .members
        .iter()
        .enumerate()
        .map(|(position, member)| CollectionMemberRow {
            member_id: member.member_id.clone(),
            position: position as i64,
            interpretation_id: member.interpretation_id.clone(),
        })
        .collect();
    catalogue::replace_collection_members(connection, generation_id, &rows)
}

/// Encode a member cursor: the snapshot the page belongs to and the last
/// position the caller saw.
///
/// Binding the cursor to the generation makes a page of another generation a
/// refused request instead of a silently mixed list.
pub(super) fn encode_member_cursor(generation_id: &str, after_position: i64) -> String {
    format!("{generation_id}:{after_position}")
}

/// Decode a member cursor, rejecting anything this caller did not produce.
pub(super) fn decode_member_cursor(cursor: &str) -> Result<(String, i64), String> {
    let (generation_id, position) = cursor
        .rsplit_once(':')
        .ok_or_else(|| "invalid source-list cursor".to_string())?;
    if generation_id.is_empty() {
        return Err("invalid source-list cursor".to_string());
    }
    let position = position
        .parse::<i64>()
        .map_err(|_| "invalid source-list cursor".to_string())?;
    Ok((generation_id.to_string(), position))
}
