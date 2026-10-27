//! Library-side presentation snapshots for IPC consumers.
//!
//! The snapshot reports every item with its role, type, status and current
//! generation; derived items add provenance, their latest run and whether they
//! are out of date, and every item lists the analyses it can feed. The map
//! draws each generation through its display descriptor. Document-side
//! visibility, opacity and order live in `.canopi` via the Design Edit seam;
//! the library never reads documents.

use super::analyses::{self, FreshnessCheck, ItemFacts};
use super::catalogue;
use super::engine::RasterEngine;
use super::geolibre::GeolibreTool;
use super::rust_engine;
use common_types::library::{
    AnalysisRunStatus, Freshness, LibraryEngines, LibraryItemRole, LibraryItemSummary,
    LibraryItemType, LibrarySnapshot, Provenance,
};
use common_types::lidar::{LidarEngineStatus, LidarResultState};
use rusqlite::Connection;

#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
pub fn library_snapshot(
    connection: &Connection,
    engine: &dyn RasterEngine,
    geolibre: &Result<GeolibreTool, String>,
) -> Result<LibrarySnapshot, String> {
    let mut items = Vec::new();
    for layer in catalogue::list_layers(connection)? {
        let head = catalogue::head_generation(connection, &layer.id)?;
        let (coverage_cells, display_range, resolution_m, bounds, value_range) = match &head {
            Some(head) => {
                let manifest = super::import::read_generation_manifest(&head.manifest_json).ok();
                (
                    head.coverage_cells.map(|cells| cells.max(0) as u64),
                    display_range_of(head),
                    manifest.as_ref().and_then(|manifest| {
                        rust_engine::cell_ground_size_m(&manifest.grid, &manifest.crs_ref)
                    }),
                    wgs84_bounds(&head.bounds_3857),
                    value_range(head.min_value, head.max_value),
                )
            }
            None => (Some(0), None, None, None, None),
        };
        let import_job = latest_import_job(connection, &layer.id)?;
        // A published item is Ready and stays fixed. An unpublished item is
        // its import operation: preparing while it runs, failed otherwise, and
        // never presented as a ready empty dataset.
        let state = if head.is_some() {
            LidarResultState::Ready
        } else {
            match import_job.as_ref().map(|job| job.state) {
                Some(
                    common_types::lidar::LidarImportJobState::Staging
                    | common_types::lidar::LidarImportJobState::Applying,
                ) => LidarResultState::Preparing,
                _ => LidarResultState::Failed,
            }
        };
        let item_type = LibraryItemType::Raster {
            quantity: analyses::parse_quantity(&layer.quantity)?,
        };
        let facts = ItemFacts {
            item_type,
            units: layer.units.clone(),
            head: head
                .as_ref()
                .map(|head| (head.id.clone(), head.crs_class.clone())),
        };
        items.push(LibraryItemSummary {
            id: layer.id.clone(),
            name: Some(layer.name),
            role: LibraryItemRole::Source,
            item_type,
            units: layer.units,
            state,
            generation_id: head.as_ref().map(|head| head.id.clone()),
            bounds,
            value_range,
            display_range,
            resolution_m,
            coverage_cells,
            import_job,
            provenance: None,
            freshness: Freshness::Current,
            run: None,
            offers: analyses::offers(&facts, geolibre),
            dependents: dependents(connection, &layer.id)?,
            created_at: layer.created_at,
        });
    }

    let mut freshness = FreshnessCheck::new(connection, geolibre);
    for item in catalogue::list_derived_items(connection)? {
        let head = catalogue::derived_head(connection, &item.id)?;
        let latest = catalogue::latest_analysis_job(connection, &item.definition_id)?;
        let definition = catalogue::get_definition(connection, &item.definition_id)?
            .ok_or_else(|| format!("derived item {} has no definition", item.id))?;
        // A published result stays Ready while a refresh runs; the run says
        // so. Without a result the item is its operation: preparing while its
        // job runs, failed otherwise.
        let state = match (&head, latest.as_ref().map(|job| job.state.as_str())) {
            (Some(_), _) => LidarResultState::Ready,
            (None, Some("preparing")) => LidarResultState::Preparing,
            (None, _) => LidarResultState::Failed,
        };
        // Provenance describes the run that produced the current result, or
        // the latest run before there is one.
        let produced_by = match &head {
            Some(head) => catalogue::get_analysis_job(connection, &head.job_id)?,
            None => latest.clone(),
        };
        let provenance = match produced_by {
            Some(job) => Some(Provenance {
                definition_id: definition.id.clone(),
                analysis_id: definition.analysis_id.clone(),
                recipe_version: u32::try_from(job.recipe_version).unwrap_or(0),
                output_key: item.output_key.clone(),
                inputs: analyses::parse_pinned_inputs(&job.input_generations_json)?,
                parameters: analyses::parse_parameters(&definition.parameters_json)?,
                tool: analyses::parse_tool(job.tool_provenance.as_deref()),
                job_id: job.id,
                created_at: job.created_at,
            }),
            None => None,
        };
        let item_type = LibraryItemType::Raster {
            quantity: analyses::parse_quantity(&item.quantity)?,
        };
        let facts = ItemFacts {
            item_type,
            units: item.units.clone(),
            head: head
                .as_ref()
                .map(|head| (head.id.clone(), head.crs_class.clone())),
        };
        let range = head
            .as_ref()
            .and_then(|head| value_range(head.min_value, head.max_value));
        items.push(LibraryItemSummary {
            id: item.id.clone(),
            name: item.name.clone(),
            role: LibraryItemRole::Derived,
            item_type,
            units: item.units.clone(),
            state,
            generation_id: head.as_ref().map(|head| head.id.clone()),
            bounds: head
                .as_ref()
                .and_then(|head| wgs84_bounds(&head.bounds_3857)),
            value_range: range,
            display_range: range.map(|[min, max]| common_types::lidar::LidarDisplayRange {
                min,
                max,
                basis: common_types::lidar::LidarDisplayRangeBasis::Exact,
            }),
            resolution_m: head
                .as_ref()
                .and_then(|head| analyses::read_derived_manifest(&head.manifest_json).ok())
                .and_then(|manifest| {
                    rust_engine::cell_ground_size_m(&manifest.grid, &manifest.crs_ref)
                }),
            coverage_cells: head
                .as_ref()
                .and_then(|head| head.coverage_cells)
                .map(|cells| cells.max(0) as u64),
            import_job: None,
            provenance,
            freshness: freshness.of(&item.id)?,
            run: latest.map(|job| AnalysisRunStatus {
                state: analyses::parse_job_state(&job.state),
                message: job.message,
                job_id: job.id,
            }),
            offers: analyses::offers(&facts, geolibre),
            dependents: dependents(connection, &item.id)?,
            created_at: item.created_at,
        });
    }

    Ok(LibrarySnapshot {
        items,
        engines: LibraryEngines {
            raster: match engine.version() {
                Ok(version) => LidarEngineStatus {
                    available: true,
                    version: Some(version),
                    detail: None,
                },
                Err(error) => LidarEngineStatus {
                    available: false,
                    version: None,
                    detail: Some(error),
                },
            },
            geolibre: match geolibre {
                Ok(tool) => LidarEngineStatus {
                    available: true,
                    version: Some(analyses::tool_label(&tool.provenance(Vec::new()))),
                    detail: None,
                },
                Err(error) => LidarEngineStatus {
                    available: false,
                    version: None,
                    detail: Some(error.clone()),
                },
            },
        },
    })
}

fn dependents(connection: &Connection, item_id: &str) -> Result<u32, String> {
    Ok(u32::try_from(catalogue::dependent_items(connection, item_id)?.len()).unwrap_or(u32::MAX))
}

fn wgs84_bounds(bounds_3857: &str) -> Option<[f64; 4]> {
    serde_json::from_str::<Vec<f64>>(bounds_3857)
        .ok()
        .and_then(|v| <[f64; 4]>::try_from(v).ok())
        .map(bounds_3857_to_wgs84)
}

fn value_range(min: Option<f64>, max: Option<f64>) -> Option<[f64; 2]> {
    match (min, max) {
        (Some(min), Some(max)) => Some([min, max]),
        _ => None,
    }
}

/// The latest import operation recorded for one item.
fn latest_import_job(
    connection: &Connection,
    layer_id: &str,
) -> Result<Option<common_types::lidar::LidarImportJob>, String> {
    use rusqlite::OptionalExtension as _;
    let job_id: Option<String> = connection
        .query_row(
            "SELECT id FROM lidar_import_jobs WHERE layer_id = ?1
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [layer_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read the item's import: {e}"))?;
    match job_id {
        Some(job_id) => super::import_job_summary(connection, &job_id),
        None => Ok(None),
    }
}

/// The display range of a source generation.
///
/// The stored display columns are authoritative. A generation written before
/// they existed falls back to its exact range, which is what it was always
/// displayed with, and a generation with neither reports none rather than a
/// guess: styling then uses its own constant-domain handling.
fn display_range_of(
    head: &catalogue::GenerationRow,
) -> Option<common_types::lidar::LidarDisplayRange> {
    match (head.display_min_value, head.display_max_value) {
        (Some(min), Some(max)) => Some(common_types::lidar::LidarDisplayRange {
            min,
            max,
            basis: super::display_range_basis(head.display_basis.as_deref()),
        }),
        _ => match (head.min_value, head.max_value) {
            (Some(min), Some(max)) => Some(common_types::lidar::LidarDisplayRange {
                min,
                max,
                basis: common_types::lidar::LidarDisplayRangeBasis::Exact,
            }),
            _ => None,
        },
    }
}

fn bounds_3857_to_wgs84(bounds: [f64; 4]) -> [f64; 4] {
    fn longitude(x: f64) -> f64 {
        (x / 20_037_508.342_789_244 * 180.0).clamp(-180.0, 180.0)
    }
    fn latitude(y: f64) -> f64 {
        let radius = 20_037_508.342_789_244 / std::f64::consts::PI;
        (y / radius)
            .sinh()
            .atan()
            .to_degrees()
            .clamp(-85.051_128_78, 85.051_128_78)
    }
    [
        longitude(bounds[0]),
        latitude(bounds[1]),
        longitude(bounds[2]),
        latitude(bounds[3]),
    ]
}

#[cfg(test)]
mod tests {
    use super::bounds_3857_to_wgs84;
    use crate::services::lidar::{LidarLibrary, analyses};

    /// The library sheet sorts by Recently added: each item reports when it
    /// was added, a source from its layer row and a result from its own row.
    #[test]
    fn every_item_reports_when_it_was_added() {
        let root = crate::test_scratch::TestScratch::new("presentation-created-at");
        let library = LidarLibrary::open(&root).unwrap();
        let connection = library.catalogue().unwrap();
        connection
            .execute_batch(
                "INSERT INTO lidar_source_layers
                    (id, name, item_kind, quantity, units, created_at)
                 VALUES ('ground', 'Ground', 'raster', 'ground-elevation', 'm',
                         '1790000000000');",
            )
            .unwrap();
        analyses::test_support::seed_published_slope(
            &connection,
            "ground",
            "gen-ground",
            "adef-slope",
            "slope",
            "dgen-slope",
            None,
        );
        connection
            .execute(
                "UPDATE lidar_derived_items SET created_at = '1790000090000' WHERE id = 'slope'",
                [],
            )
            .unwrap();

        drop(connection);

        let snapshot = library.library_snapshot().unwrap();
        let created = |id: &str| {
            snapshot
                .items
                .iter()
                .find(|item| item.id == id)
                .map(|item| item.created_at.clone())
        };
        assert_eq!(created("ground").as_deref(), Some("1790000000000"));
        assert_eq!(created("slope").as_deref(), Some("1790000090000"));
        let connection = library.catalogue().unwrap();
        assert_eq!(
            super::catalogue::get_layer(&connection, "ground")
                .unwrap()
                .map(|layer| layer.created_at),
            Some("1790000000000".to_owned()),
        );
        assert_eq!(
            super::catalogue::get_derived_item(&connection, "slope")
                .unwrap()
                .map(|item| item.created_at),
            Some("1790000090000".to_owned()),
        );
    }

    /// The profile and the library read `resolution_m` as metres on the ground, so a grid in degrees or in Web
    /// Mercator's stretched metres reports its cells' ground size, and a metre grid its own pixel size.
    #[test]
    fn resolution_is_the_cell_size_on_the_ground_in_metres() {
        let root = crate::test_scratch::TestScratch::new("presentation-resolution");
        let library = LidarLibrary::open(&root).unwrap();
        let connection = library.catalogue().unwrap();
        // One arc-second cells at 48° N; 1 m Web Mercator pixels there; IGN's 0.5 m Lambert-93 grid.
        let arc_second = 1.0 / 3600.0;
        for (id, crs, origin, pixel) in [
            ("degrees", "EPSG:4326", [2.0, 48.0], arc_second),
            ("mercator", "EPSG:3857", [222_639.0, 6_106_855.0], 1.0),
            ("lambert", "EPSG:2154", [445_000.0, 6_806_000.0], 0.5),
        ] {
            let manifest = format!(
                r#"{{"grid":{{"width":100,"height":100,"geotransform":[{},{pixel},0.0,{},0.0,{}]}},"nodata":-9999.0,"crs_ref":"{crs}","members":[],"engine_version":"test","created_at":"1"}}"#,
                origin[0], origin[1], -pixel,
            );
            connection
                .execute(
                    "INSERT INTO lidar_source_layers(id, name, item_kind, quantity, units, created_at)
                     VALUES (?1, ?1, 'raster', 'ground-elevation', 'm', '1')",
                    [id],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO lidar_layer_generations
                        (id, layer_id, created_at, manifest_json, bounds_3857, crs_class)
                     VALUES (?1, ?2, '1', ?3, '[0,0,1,1]', 'projected-metre')",
                    rusqlite::params![format!("gen-{id}"), id, manifest],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO lidar_layer_heads(layer_id, generation_id) VALUES (?1, ?2)",
                    rusqlite::params![id, format!("gen-{id}")],
                )
                .unwrap();
        }
        drop(connection);

        let snapshot = library.library_snapshot().unwrap();
        let resolution = |id: &str| {
            snapshot
                .items
                .iter()
                .find(|item| item.id == id)
                .and_then(|item| item.resolution_m)
                .unwrap()
        };
        // 20.7 m east by 30.9 m north: the side of a square of the same ground area.
        assert!(
            (resolution("degrees") - 25.3).abs() < 0.1,
            "{}",
            resolution("degrees")
        );
        // cos 48° of a Mercator metre.
        assert!(
            (resolution("mercator") - 0.669).abs() < 0.002,
            "{}",
            resolution("mercator")
        );
        assert_eq!(resolution("lambert"), 0.5);
    }

    #[test]
    fn map_bounds_are_projected_to_longitude_and_latitude() {
        let bounds = bounds_3857_to_wgs84([-47_546.0, 6_157_700.0, -45_981.0, 6_159_269.0]);
        assert!(bounds[0] > -0.5 && bounds[2] < -0.4, "{bounds:?}");
        assert!(bounds[1] > 48.2 && bounds[3] < 48.4, "{bounds:?}");
    }
}
