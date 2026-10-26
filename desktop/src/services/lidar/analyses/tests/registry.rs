//! The analysis registry and definitions: what runs where, what an item can
//! feed, and what a new definition records or refuses. No engine.

use super::*;

/// Relief is drawn for imported elevations only: a result's display parts
/// are windows of its chunks, which the relief writer does not shade, and a
/// result asked for relief is unavailable. The first analysis that outputs
/// an elevation therefore brings Windows-part relief with it.
#[test]
fn no_analysis_outputs_an_elevation() {
    for analysis in ANALYSIS_REGISTRY {
        for output in analysis.outputs {
            let LibraryItemType::Raster { quantity } = output.item;
            assert!(
                !crate::services::lidar::display_cog::draws_relief(quantity),
                "{} outputs {quantity:?}, which draws as relief: relief for derived parts first",
                analysis.id
            );
        }
    }
}

/// Every registry entry runs on exactly one executor and every executor has an
/// entry; a windowed halo fits the bounded readers.
#[test]
fn every_registry_entry_has_exactly_one_executor() {
    for analysis in ANALYSIS_REGISTRY {
        let matching = EXECUTORS
            .iter()
            .filter(|executor| executor.analysis_id() == analysis.id)
            .count();
        assert_eq!(matching, 1, "{} needs exactly one executor", analysis.id);
        let AnalysisLane::GeolibreWindowed { halo } = analysis.lane;
        assert!(
            halo <= crate::services::lidar::prepared_raster::MAX_RECIPE_HALO,
            "{} reads beyond the bounded halo",
            analysis.id
        );
    }
    for executor in EXECUTORS {
        assert!(
            definition(executor.analysis_id()).is_some(),
            "{} has no registry entry",
            executor.analysis_id()
        );
    }
}

/// The class comes from the table row of the stored reference (A7, A9).
#[test]
fn crs_classes_come_from_the_row_of_the_stored_reference() {
    assert_eq!(crs_class("EPSG:2154"), CRS_PROJECTED_METRE);
    assert_eq!(crs_class("EPSG:4471"), CRS_PROJECTED_METRE);
    assert_eq!(
        crs_class("EPSG:3857"),
        CRS_PROJECTED_OTHER,
        "Web Mercator metres are not ground metres"
    );
    assert_eq!(crs_class("EPSG:4326"), "geographic");
    assert_eq!(crs_class("EPSG:4171"), "geographic");
    assert_eq!(crs_class("EPSG:2263"), "unknown", "feet are not a row");
    assert_eq!(crs_class(""), "unknown");
    assert!(values_in_metres(" Metres "));
    assert!(!values_in_metres("ft"));
}

/// Offers name why an item cannot feed an analysis, from catalogue facts only.
#[test]
fn offers_name_why_an_item_cannot_feed_an_analysis() {
    let ground = LibraryItemType::Raster {
        quantity: RasterQuantity::GroundElevation,
    };
    let facts = |item_type, units: &str, head: Option<&str>| ItemFacts {
        item_type,
        units: units.to_string(),
        head: head.map(|class| ("gen".to_string(), class.to_string())),
    };
    let slope = |facts: &ItemFacts, engine: &Result<GeolibreTool, String>| {
        offers(facts, engine)
            .into_iter()
            .find(|offer| offer.analysis_id == "terrain.slope")
            .expect("slope is offered to every item")
            .unavailable
    };
    let engine = installed("geolibre-cli 1.5.3");
    assert_eq!(
        slope(&facts(ground, "m", Some(CRS_PROJECTED_METRE)), &engine),
        None
    );
    assert_eq!(
        slope(
            &facts(
                LibraryItemType::Raster {
                    quantity: RasterQuantity::SurfaceElevation
                },
                "m",
                Some(CRS_PROJECTED_METRE)
            ),
            &engine
        ),
        Some(AnalysisUnavailable::WrongInput {
            expected: vec![ground]
        })
    );
    assert_eq!(
        slope(&facts(ground, "m", None), &engine),
        Some(AnalysisUnavailable::NotReady)
    );
    assert_eq!(
        slope(&facts(ground, "ft", Some(CRS_PROJECTED_METRE)), &engine),
        Some(AnalysisUnavailable::ValuesNotMetres {
            units: "ft".to_string()
        })
    );
    assert_eq!(
        slope(&facts(ground, "m", Some("geographic")), &engine),
        Some(AnalysisUnavailable::GridNotProjectedMetres)
    );
    assert_eq!(
        slope(
            &facts(ground, "m", Some(CRS_PROJECTED_METRE)),
            &Err("the GeoLibre engine is not installed".to_string())
        ),
        Some(AnalysisUnavailable::EngineMissing {
            detail: "the GeoLibre engine is not installed".to_string()
        })
    );
}

/// A new definition, its input, one item per output and a job pinned to the
/// input's current generation are recorded together; the units come from the
/// chosen parameter.
#[test]
fn creating_a_definition_records_items_inputs_and_a_pinned_job() {
    let root = scratch_root("create");
    let library = LidarLibrary::open(&root).unwrap();
    let (source, generation) = source_with_head(
        &library,
        "Ground",
        RasterQuantity::GroundElevation,
        CRS_PROJECTED_METRE,
    );
    let receipt = record(
        &library,
        &slope_request(&source, "percent", Some("  North slope ")),
    );
    assert_eq!(receipt.item_ids.len(), 1);
    let connection = library.catalogue().unwrap();
    let definition = catalogue::get_definition(&connection, &receipt.definition_id)
        .unwrap()
        .unwrap();
    assert_eq!(definition.analysis_id, "terrain.slope");
    assert_eq!(
        parse_parameters(&definition.parameters_json).unwrap(),
        vec![AnalysisParamValue {
            key: "unit".to_string(),
            value: ParamValue::Choice("percent".to_string()),
        }]
    );
    assert_eq!(
        catalogue::definition_inputs(&connection, &receipt.definition_id).unwrap(),
        vec![catalogue::AnalysisInputRow {
            input_key: "dem".to_string(),
            item_id: source.clone(),
        }]
    );
    let item = catalogue::get_derived_item(&connection, &receipt.item_ids[0])
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            item.output_key.as_str(),
            item.quantity.as_str(),
            item.units.as_str(),
            item.name.as_deref()
        ),
        ("slope", "slope", "%", Some("North slope"))
    );
    let job = catalogue::get_analysis_job(&connection, &receipt.job_id)
        .unwrap()
        .unwrap();
    assert_eq!((job.state.as_str(), job.recipe_version), ("preparing", 1));
    assert_eq!(
        parse_pinned_inputs(&job.input_generations_json).unwrap(),
        vec![ProvenanceInput {
            key: "dem".to_string(),
            item_id: source,
            generation_id: generation,
        }]
    );
    drop(connection);
    drop(library);
    let _ = std::fs::remove_dir_all(root);
}

/// Invalid requests are refused by name before anything is written.
#[test]
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn invalid_requests_are_refused_by_name_and_create_nothing() {
    let root = scratch_root("refuse");
    let library = LidarLibrary::open(&root).unwrap();
    let (ground, _) = source_with_head(
        &library,
        "Ground",
        RasterQuantity::GroundElevation,
        CRS_PROJECTED_METRE,
    );
    let (surface, _) = source_with_head(
        &library,
        "Surface",
        RasterQuantity::SurfaceElevation,
        CRS_PROJECTED_METRE,
    );
    let (geographic, _) = source_with_head(
        &library,
        "Degrees",
        RasterQuantity::GroundElevation,
        "geographic",
    );
    let (mercator, _) = source_with_head(
        &library,
        "Mercator",
        RasterQuantity::GroundElevation,
        CRS_PROJECTED_OTHER,
    );
    let unpublished = library
        .create_layer("Pending", RasterQuantity::GroundElevation, None, false)
        .unwrap();
    let refuse = |request: AnalysisRequest, needle: &str| {
        let error = record_definition(&library.catalogue().unwrap(), &request, None).unwrap_err();
        assert!(error.contains(needle), "{error} should mention {needle}");
    };
    let valid = || slope_request(&ground, "degrees", None);
    refuse(
        AnalysisRequest {
            analysis_id: "terrain.aspect".to_string(),
            ..valid()
        },
        "no analysis 'terrain.aspect'",
    );
    refuse(
        slope_request(&surface, "degrees", None),
        "must be ground-elevation",
    );
    refuse(
        slope_request(&geographic, "degrees", None),
        "projected grid",
    );
    // Web Mercator is projected and in metres, but not ground metres.
    refuse(slope_request(&mercator, "degrees", None), "ground metres");
    refuse(
        slope_request(&unpublished, "degrees", None),
        "no published data",
    );
    refuse(
        slope_request("lyr-missing", "degrees", None),
        "does not exist",
    );
    refuse(
        AnalysisRequest {
            parameters: Vec::new(),
            ..valid()
        },
        "choose a value for 'unit'",
    );
    refuse(slope_request(&ground, "radians", None), "not an option");
    refuse(
        AnalysisRequest {
            inputs: Vec::new(),
            ..valid()
        },
        "choose an item for input 'dem'",
    );
    refuse(
        AnalysisRequest {
            inputs: vec![AnalysisInputBinding {
                key: "surface".to_string(),
                item_id: ground.clone(),
            }],
            ..valid()
        },
        "no input 'surface'",
    );
    refuse(
        AnalysisRequest {
            outputs: vec!["aspect".to_string()],
            ..valid()
        },
        "no output 'aspect'",
    );
    // A missing engine refuses creation too.
    library
        .inner
        .geolibre
        .preset(Err("the GeoLibre engine is not installed".to_string()));
    let error = library.create_analysis(&valid()).unwrap_err();
    assert!(error.contains("not installed"), "{error}");
    for table in [
        "lidar_analysis_definitions",
        "lidar_analysis_inputs",
        "lidar_derived_items",
        "lidar_analysis_jobs",
    ] {
        assert_eq!(
            count(&library, &format!("SELECT COUNT(*) FROM {table}")),
            0,
            "{table}"
        );
    }
    // The snapshot says why new runs are unavailable; nothing else changes.
    let snapshot = library.library_snapshot().unwrap();
    assert!(!snapshot.engines.geolibre.available);
    assert_eq!(
        summary(&snapshot.items, &ground).offers[0].unavailable,
        Some(AnalysisUnavailable::EngineMissing {
            detail: "the GeoLibre engine is not installed".to_string()
        })
    );
    drop(library);
    let _ = std::fs::remove_dir_all(root);
}
