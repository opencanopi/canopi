//! Tests for `design`, an out-of-line test module so `design.rs` keeps under the file-size limit.

use super::*;
use serde_json::json;

fn geo_file(plants: serde_json::Value) -> CanopiFile {
    serde_json::from_value(design_with(json!({ "plants": plants })))
        .expect("current design should deserialize")
}

fn plant_at(lon: f64, lat: f64) -> serde_json::Value {
    json!({
        "id": "plant-1",
        "canonical_name": "Malus domestica",
        "position": { "lon": lon, "lat": lat }
    })
}

#[test]
fn design_positions_are_lon_lat_and_round_trip_exactly() {
    let file = geo_file(json!([plant_at(2.294_481_234_5, 48.858_370_123_4)]));
    assert_eq!(
        file.plants[0].position,
        GeoPoint {
            lon: 2.294_481_234_5,
            lat: 48.858_370_123_4
        }
    );
    validate_design_geometry(&file).expect("in-range positions are valid");
    let value = serde_json::to_value(&file).expect("design should serialize");
    assert_eq!(
        value["plants"][0]["position"],
        json!({ "lon": 2.294_481_234_5, "lat": 48.858_370_123_4 })
    );
    assert!(value.get("spatial_frame").is_none());
}

#[test]
fn design_geometry_rejects_out_of_range_positions() {
    for (lon, lat, leaf) in [
        (180.0001, 0.0, "$.plants[0].position.lon"),
        (-180.0001, 0.0, "$.plants[0].position.lon"),
        (0.0, 85.0511287798067, "$.plants[0].position.lat"),
        (181.0, 86.0, "$.plants[0].position.lat"),
    ] {
        let file = geo_file(json!([plant_at(lon, lat)]));
        let refusal = validate_design_geometry(&file).expect_err("out of range");
        assert_eq!(refusal.field_path.to_string(), leaf, "({lon}, {lat})");
    }
}

#[test]
fn design_positions_reject_local_metre_points() {
    let result = serde_json::from_value::<CanopiFile>(design_with(json!({
        "plants": [{
            "id": "plant-1",
            "canonical_name": "Malus domestica",
            "position": { "x": 1.0, "y": 2.0 }
        }]
    })));
    assert!(result.is_err(), "design positions must be lon/lat");
}

#[test]
fn design_objects_missing_lock_state_load_unlocked_and_serialize_explicitly() {
    let file: CanopiFile = serde_json::from_value(json!({
        "version": 9,
        "name": "Implicit locks",
        "description": null,
        "plant_species_colors": {},
        "layers": [
            { "name": "plants", "visible": true, "locked": false, "opacity": 1.0 }
        ],
        "plants": [
            {
                "id": "plant-1",
                "canonical_name": "Malus domestica",
                "common_name": "Apple",
                "position": { "lon": 13.0, "lat": 23.0 },
                "rotation": null,
                "scale": null,
                "notes": null,
                "planted_date": null,
                "quantity": 1
            }
        ],
        "zones": [
            {
                "id": "zone-1",
                "zone_type": "rect",
                "points": [
                    { "lon": 13.0, "lat": 23.0 },
                    { "lon": 13.00001, "lat": 23.0 },
                    { "lon": 13.00001, "lat": 22.99999 }
                ],
                "fill_color": null,
                "notes": null
            }
        ],
        "annotations": [
            {
                "id": "annotation-1",
                "annotation_type": "text",
                "position": { "lon": 13.00002, "lat": 23.00003 },
                "text": "Note",
                "font_size": 16.0,
                "rotation": null
            }
        ],
        "consortiums": [],
        "groups": [
            {
                "id": "group-1",
                "name": null,
                "members": [
                    { "kind": "plant", "id": "plant-1" },
                    { "kind": "zone", "id": "zone-1" }
                ]
            }
        ],
        "timeline": [],
        "budget": [],
        "budget_currency": "EUR",
        "created_at": "2026-04-02T00:00:00.000Z",
        "updated_at": "2026-04-02T00:00:00.000Z"
    }))
    .expect("design objects without locked fields should load");

    assert!(!file.plants[0].locked);
    assert!(!file.zones[0].locked);
    assert!(!file.annotations[0].locked);
    assert!(!file.groups[0].locked);
    assert_eq!(file.zones[0].rotation, 0.0);

    let value = serde_json::to_value(&file).expect("canopi file should serialize");
    assert_eq!(value["plants"][0]["locked"], json!(false));
    assert_eq!(value["zones"][0]["locked"], json!(false));
    assert_eq!(value["zones"][0]["rotation"], json!(0.0));
    assert_eq!(value["annotations"][0]["locked"], json!(false));
    assert_eq!(value["groups"][0]["locked"], json!(false));
}

fn admitted(value: serde_json::Value) -> Result<CanopiFile, String> {
    let file: CanopiFile = serde_json::from_value(value).map_err(|e| e.to_string())?;
    admit_design_identities_and_ranges(&file).map_err(|refusal| refusal.to_string())?;
    Ok(file)
}

fn design_with(overrides: serde_json::Value) -> serde_json::Value {
    let mut value = json!({
        "version": 9,
        "name": "Admission",
        "plant_species_colors": {},
        "layers": [],
        "plants": [],
        "zones": [],
        "annotations": [],
        "consortiums": [],
        "groups": [],
        "timeline": [],
        "budget": [],
        "created_at": "2026-09-28T00:00:00.000Z",
        "updated_at": "2026-09-28T00:00:00.000Z"
    });
    for (key, override_value) in overrides.as_object().expect("object overrides") {
        value[key] = override_value.clone();
    }
    value
}

#[test]
fn plants_and_guides_need_an_id_and_unique_non_empty_ids() {
    let plant = |id: Option<&str>| {
        let mut value = json!({ "canonical_name": "Malus domestica", "position": { "lon": 13.0, "lat": 23.0 } });
        if let Some(id) = id {
            value["id"] = json!(id);
        }
        value
    };
    let guide = |id: Option<&str>| {
        let mut value =
            json!({ "start": { "lon": 13.0, "lat": 23.0 }, "end": { "lon": 13.001, "lat": 23.0 } });
        if let Some(id) = id {
            value["id"] = json!(id);
        }
        value
    };
    // A hand-edited file missing an id is refused: Canopi never invents one.
    assert!(
        admitted(design_with(json!({ "plants": [plant(None)] })))
            .unwrap_err()
            .contains("missing field `id`")
    );
    assert!(
        admitted(design_with(json!({ "measurement_guides": [guide(None)] })))
            .unwrap_err()
            .contains("missing field `id`")
    );
    assert_eq!(
        admitted(design_with(json!({ "plants": [plant(Some(""))] }))).unwrap_err(),
        "$.plants[0].id: expected a non-empty id"
    );
    assert_eq!(
        admitted(design_with(
            json!({ "measurement_guides": [guide(Some(""))] })
        ))
        .unwrap_err(),
        "$.measurement_guides[0].id: expected a non-empty id"
    );
    assert_eq!(
        admitted(design_with(
            json!({ "plants": [plant(Some("plant-1")), plant(Some("plant-1"))] })
        ))
        .unwrap_err(),
        "$.plants[1].id: expected a unique id"
    );
    assert_eq!(
        admitted(design_with(
            json!({ "measurement_guides": [guide(Some("g")), guide(Some("g"))] })
        ))
        .unwrap_err(),
        "$.measurement_guides[1].id: expected a unique id"
    );
    let file = admitted(design_with(json!({
        "plants": [plant(Some("plant-2")), plant(Some("plant-1"))],
        "measurement_guides": [guide(Some("guide-1"))]
    })))
    .expect("explicit ids are admitted as they are");
    assert_eq!(file.plants[0].id, "plant-2");
    assert_eq!(file.measurement_guides[0].id, "guide-1");
}

#[test]
fn a_design_missing_a_list_canopi_always_writes_is_refused() {
    let complete = design_with(json!({}));
    admitted(complete.clone()).expect("a Design with every written list loads");
    for key in ["annotations", "consortiums", "groups", "timeline", "budget"] {
        let mut value = complete.clone();
        value.as_object_mut().expect("object").remove(key);
        let error = admitted(value).expect_err(key);
        assert!(error.contains(&format!("missing field `{key}`")), "{error}");
    }
}

#[test]
fn zones_annotations_and_groups_need_unique_non_empty_ids() {
    let zone = |id: &str| json!({ "id": id, "zone_type": "rect", "points": [] });
    assert_eq!(
        admitted(design_with(json!({ "zones": [zone("bed"), zone("bed")] }))).unwrap_err(),
        "$.zones[1].id: expected a unique id"
    );
    assert_eq!(
        admitted(design_with(json!({ "zones": [zone("")] }))).unwrap_err(),
        "$.zones[0].id: expected a non-empty id"
    );
    let note = |id: &str| {
        json!({
            "id": id, "annotation_type": "text", "position": { "lon": 13.0, "lat": 23.0 },
            "text": "Note", "font_size": 14.0
        })
    };
    assert_eq!(
        admitted(design_with(
            json!({ "annotations": [note("n"), note("n")] })
        ))
        .unwrap_err(),
        "$.annotations[1].id: expected a unique id"
    );
    let group = |id: &str| json!({ "id": id, "name": null, "members": [] });
    assert_eq!(
        admitted(design_with(json!({ "groups": [group("g"), group("g")] }))).unwrap_err(),
        "$.groups[1].id: expected a unique id"
    );
}

#[test]
fn ranges_are_checked_after_deserialization() {
    let plant = |scale: serde_json::Value| {
        json!({
            "id": "plant-1", "canonical_name": "Malus domestica",
            "position": { "lon": 13.0, "lat": 23.0 }, "scale": scale
        })
    };
    assert!(admitted(design_with(json!({ "plants": [plant(json!(0.0))] }))).is_err());
    assert!(admitted(design_with(json!({ "plants": [plant(json!(-1.0))] }))).is_err());
    assert!(admitted(design_with(json!({ "plants": [plant(json!(0.2))] }))).is_ok());
    assert!(
        admitted(design_with(
            json!({ "plants": [plant(serde_json::Value::Null)] })
        ))
        .is_ok()
    );
    assert!(admitted(design_with(json!({
        "annotations": [{ "id": "n", "annotation_type": "text", "position": { "lon": 13.0, "lat": 23.0 }, "text": "x", "font_size": 0.0 }]
    }))).is_err());
    assert!(
        admitted(design_with(json!({
            "layers": [{ "name": "plants", "visible": true, "locked": false, "opacity": 1.5 }]
        })))
        .is_err()
    );
    // The section has no version of its own: the file's version covers it,
    // and an older dev file's `schema_version` is dropped like any unknown key.
    assert!(
        admitted(design_with(json!({
            "lidar": { "visible": true, "entries": [] }
        })))
        .is_ok()
    );
    assert!(
        admitted(design_with(json!({
            "lidar": { "schema_version": 2, "visible": true, "entries": [] }
        })))
        .is_ok()
    );
    let lidar = |entry: serde_json::Value| {
        design_with(json!({
            "lidar": { "visible": true, "entries": [entry] }
        }))
    };
    let entry = |opacity: f64, name: &str, range: serde_json::Value| {
        json!({
            "kind": "Derived", "id": "slope", "name": name, "visible": true,
            "opacity": opacity, "order": 0, "ramp": "YellowRed", "reversed": true,
            "range": range
        })
    };
    assert!(admitted(lidar(entry(1.2, "Slope", serde_json::Value::Null))).is_err());
    assert!(admitted(lidar(entry(0.4, "Slope", serde_json::Value::Null))).is_ok());
    assert_eq!(
        admitted(lidar(entry(0.4, " ", serde_json::Value::Null))).unwrap_err(),
        "$.lidar.entries[0].name: expected a non-empty name"
    );
    let custom = |min: f64, max: f64| json!({ "mode": "Custom", "min": min, "max": max });
    assert!(admitted(lidar(entry(0.4, "Slope", custom(0.0, 30.0)))).is_ok());
    assert_eq!(
        admitted(lidar(entry(0.4, "Slope", custom(30.0, 30.0)))).unwrap_err(),
        "$.lidar.entries[0].range: expected finite min and max with min below max"
    );
    assert!(admitted(lidar(entry(0.4, "Slope", custom(40.0, 30.0)))).is_err());
}

#[test]
fn a_custom_colour_range_must_be_finite_even_when_built_in_memory() {
    // JSON cannot carry a non-finite number, but a Design built in memory
    // can; admission refuses it before it is written.
    let mut file: CanopiFile = serde_json::from_value(design_with(json!({
        "lidar": { "visible": true, "entries": [{
            "kind": "Source", "id": "dem", "name": "Terrain model", "visible": true,
            "opacity": 1.0, "order": 0, "ramp": null, "reversed": false, "range": null
        }] }
    })))
    .expect("a Design with one LiDAR entry loads");
    file.lidar.as_mut().expect("lidar section").entries[0].range =
        Some(crate::lidar::LidarColourRange::Custom {
            min: f64::NAN,
            max: 30.0,
        });
    assert!(admit_design_identities_and_ranges(&file).is_err());
}

fn zone_file(zone: serde_json::Value) -> Result<CanopiFile, serde_json::Error> {
    serde_json::from_value(json!({
        "version": 9,
        "name": "Zones",
        "plant_species_colors": {},
        "layers": [],
        "plants": [],
        "zones": [zone],
        "annotations": [],
        "consortiums": [],
        "groups": [],
        "timeline": [],
        "budget": [],
        "created_at": "2026-09-27T00:00:00.000Z",
        "updated_at": "2026-09-27T00:00:00.000Z"
    }))
}

#[test]
fn zones_keep_a_stable_id_beside_an_optional_display_name() {
    let named = zone_file(json!({
        "id": "zone-1",
        "name": "North bed",
        "zone_type": "rect",
        "points": []
    }))
    .expect("a named zone loads");
    assert_eq!(named.zones[0].id, "zone-1");
    assert_eq!(named.zones[0].name.as_deref(), Some("North bed"));

    let unnamed = zone_file(json!({ "id": "zone-2", "zone_type": "line", "points": [] }))
        .expect("an unnamed zone loads");
    assert_eq!(unnamed.zones[0].name, None);
    let value = serde_json::to_value(&unnamed).expect("design should serialize");
    assert_eq!(value["zones"][0]["id"], json!("zone-2"));
    assert_eq!(value["zones"][0]["name"], json!(null));

    // A v8 zone, whose name was its identity, has no id and is refused.
    assert!(zone_file(json!({ "name": "North bed", "zone_type": "rect", "points": [] })).is_err());
}

#[test]
fn general_deserialization_rejects_obsolete_object_group_shape() {
    let result = serde_json::from_value::<CanopiFile>(json!({
        "version": 9,
        "name": "Legacy groups require ingestion",
        "plant_species_colors": {},
        "layers": [],
        "plants": [{
            "id": "plant-1",
            "canonical_name": "Malus domestica",
            "position": { "lon": 13.0, "lat": 23.0 }
        }],
        "zones": [{
            "id": "zone-1",
            "zone_type": "rect",
            "points": []
        }],
        "annotations": [],
        "consortiums": [],
        "timeline": [],
        "budget": [],
        "groups": [{
            "id": "legacy",
            "member_ids": ["plant-1", "zone-1"]
        }],
        "created_at": "2026-07-15T00:00:00.000Z",
        "updated_at": "2026-07-15T00:00:00.000Z"
    }));

    assert!(
        result.is_err(),
        "obsolete Object Groups must not enter the runtime",
    );
}

/// A Design through both admission checks, as a load runs them.
fn admitted_whole(value: serde_json::Value) -> Result<CanopiFile, String> {
    let file = admitted(value)?;
    validate_design_geometry(&file).map_err(|refusal| refusal.to_string())?;
    Ok(file)
}

#[test]
fn admission_accepts_a_rotated_zone_a_scaled_plant_and_a_rotated_annotation_canopi_f47t_52_228() {
    let file = admitted_whole(design_with(json!({
        "plants": [{
            "id": "plant-1", "canonical_name": "Malus domestica",
            "position": { "lon": 13.0, "lat": 23.0 }, "scale": 1.5, "rotation": 45.0
        }],
        "zones": [{
            "id": "bed", "zone_type": "rect", "rotation": 30.0,
            "points": [{ "lon": 13.0, "lat": 23.0 }, { "lon": 13.001, "lat": 23.001 }]
        }],
        "annotations": [{
            "id": "n", "annotation_type": "text", "position": { "lon": 13.0, "lat": 23.0 },
            "text": "Note", "font_size": 14.0, "rotation": 15.0
        }]
    })))
    .expect("a rotated zone, a scaled and rotated plant and a rotated annotation are admitted");
    assert_eq!(file.zones[0].rotation, 30.0);
    assert_eq!(
        (file.plants[0].scale, file.plants[0].rotation),
        (Some(1.5), Some(45.0))
    );
    assert_eq!(file.annotations[0].rotation, Some(15.0));
}

#[test]
fn admission_refuses_font_size_0_or_minus_1_and_scale_0_canopi_f47t_52_228() {
    let note = |font_size: f64| {
        design_with(json!({
            "annotations": [{
                "id": "n", "annotation_type": "text", "position": { "lon": 13.0, "lat": 23.0 },
                "text": "Note", "font_size": font_size
            }]
        }))
    };
    for font_size in [0.0, -1.0] {
        assert_eq!(
            admitted_whole(note(font_size)).unwrap_err(),
            "$.annotations[0].font_size: expected a finite number above 0",
            "font size {font_size}"
        );
    }
    assert!(admitted_whole(note(0.5)).is_ok());
    assert_eq!(
        admitted_whole(design_with(json!({
            "plants": [{
                "id": "plant-1", "canonical_name": "Malus domestica",
                "position": { "lon": 13.0, "lat": 23.0 }, "scale": 0.0
            }]
        })))
        .unwrap_err(),
        "$.plants[0].scale: expected a finite number above 0"
    );
}

#[test]
fn a_designs_integer_fields_read_9_and_9_0_and_refuse_9_5_minus_1_and_4294967296_canopi_f47t_52_228()
 {
    // Each unsigned integer field a Design holds: its version, a plant's quantity and a
    // consortium's phases.
    let with_integer = |field: &str, value: serde_json::Value| match field {
        "version" => design_with(json!({ "version": value })),
        "quantity" => design_with(json!({
            "plants": [{
                "id": "plant-1", "canonical_name": "Malus domestica",
                "position": { "lon": 13.0, "lat": 23.0 }, "quantity": value
            }]
        })),
        phase => {
            let mut consortium = json!({
                "target": { "kind": "species", "canonical_name": "Malus domestica" },
                "stratum": "high", "start_phase": 0, "end_phase": 1
            });
            consortium[phase] = value;
            design_with(json!({ "consortiums": [consortium] }))
        }
    };
    let read = |field: &str, file: &CanopiFile| match field {
        "version" => file.version,
        "quantity" => file.plants[0].quantity.expect("a quantity"),
        "start_phase" => file.consortiums[0].start_phase,
        _ => file.consortiums[0].end_phase,
    };
    for field in ["version", "quantity", "start_phase", "end_phase"] {
        for value in [json!(9), json!(9.0)] {
            let file = admitted(with_integer(field, value.clone()))
                .unwrap_or_else(|error| panic!("{field} {value}: {error}"));
            assert_eq!(read(field, &file), 9, "{field} {value}");
        }
        for value in [
            json!(9.5),
            json!(-1),
            json!(-1.0),
            json!(4_294_967_296_u64),
            json!(4_294_967_296.0),
        ] {
            let error = admitted(with_integer(field, value.clone()))
                .expect_err(&format!("{field} {value} is refused"));
            assert!(
                error.contains("expected an unsigned 32-bit integer"),
                "{field} {value}: {error}"
            );
        }
    }
    // A timeline action's order is the signed field: -1 reads, 2147483648 and 9.5 are refused.
    let action = |order: serde_json::Value| {
        design_with(json!({
            "timeline": [{
                "id": "a", "action_type": "planting", "description": "Plant",
                "completed": false, "order": order
            }]
        }))
    };
    for (order, read) in [(json!(9.0), 9), (json!(-1), -1), (json!(-1.0), -1)] {
        assert_eq!(admitted(action(order)).unwrap().timeline[0].order, read);
    }
    for order in [
        json!(9.5),
        json!(2_147_483_648_u64),
        json!(2_147_483_648.0),
        json!(-2_147_483_649.0),
    ] {
        assert!(
            admitted(action(order.clone()))
                .expect_err(&format!("order {order} is refused"))
                .contains("expected a signed 32-bit integer")
        );
    }
}

/// canopi-f47t.52.245 (2.1-M482): a v9 file written before a field existed reads it at its
/// documented default: no `budget_currency` is EUR, a timeline action without `targets` is
/// `[manual]`, and a budget line without `target` is Manual.
#[test]
fn canopi_f47t_52_245_a_v9_file_missing_later_fields_reads_their_defaults() {
    let file = admitted(design_with(json!({
        "timeline": [{
            "id": "a", "action_type": "planting", "description": "Plant",
            "completed": false, "order": 0
        }],
        "budget": [{
            "category": "plants", "description": "Apples", "quantity": 2.0,
            "unit_cost": 12.0, "currency": "EUR"
        }]
    })))
    .expect("an older v9 file reads");
    assert_eq!(file.budget_currency, DEFAULT_BUDGET_CURRENCY);
    assert_eq!(DEFAULT_BUDGET_CURRENCY, "EUR");
    assert!(matches!(
        file.timeline[0].targets.as_slice(),
        [PanelTarget::Manual]
    ));
    assert!(matches!(file.budget[0].target, PanelTarget::Manual));
}
