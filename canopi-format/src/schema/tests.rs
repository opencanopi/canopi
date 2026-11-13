//! Tests for `schema`, a sibling module so `schema.rs` keeps under the file-size limit.

use super::{admit_schema, unsupported_keyword};
use serde_json::{Value, json};

/// The generated v9 `CanopiFile` schema, the one the Desktop decode walks.
fn v9_schema() -> &'static Value {
    static SCHEMA: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(canopi_types::design::canopi_file_json_schema)
}

/// A new v9 Design as the Desktop writes it.
fn design() -> Value {
    let layer =
        |name: &str| json!({ "name": name, "visible": true, "locked": false, "opacity": 1.0 });
    json!({
        "version": 9, "name": "Garden", "description": null,
        "plant_species_colors": {}, "plant_species_symbols": {}, "plant_species_codes": {},
        "layers": [layer("base"), layer("plants"), layer("zones"), layer("annotations")],
        "plants": [], "zones": [], "annotations": [], "measurement_guides": [],
        "consortiums": [], "groups": [], "timeline": [], "budget": [], "budget_currency": "EUR",
        "views": [], "stories": [],
        "created_at": "2026-07-02T00:00:00Z", "updated_at": "2026-07-02T00:00:00Z"
    })
}

fn view(camera: Value) -> Value {
    json!({
        "id": "view-1", "name": "Hedges", "camera": camera,
        "visible_layers": {
            "background": { "kind": "satellite" },
            "terrain": { "contours": false, "hillshade": false },
            "scene_layers": [], "site_data": []
        },
        "highlighted": { "species": [], "objects": [] },
        "title": "Hedges", "text": []
    })
}

fn camera() -> Value {
    json!({
        "lon": 2.29, "lat": 48.85, "zoom": 19.0, "bearing": 0.0,
        "ground_size_m": { "width": 312.5, "height": 187.5 }
    })
}

/// The path and text of the refusal, or `None` when `value` is admitted.
fn refused(value: &Value) -> Option<(String, String)> {
    admit_schema(value, v9_schema())
        .err()
        .map(|refusal| (refusal.field_path.to_string(), refusal.to_string()))
}

fn path_of(value: &Value) -> String {
    refused(value).expect("the value is refused").0
}

#[test]
fn a_new_design_is_admitted() {
    assert_eq!(refused(&design()), None);
    let mut value = design();
    value["views"] = json!([view(camera())]);
    value["map_view"] = camera();
    value["future_field"] = json!({ "kept": [1, "two"] });
    assert_eq!(refused(&value), None);
}

/// canopi-cyqd: of two faults the first in sorted key order is named, as the Web decoder
/// names it, whatever order the file lists them in.
#[test]
fn canopi_cyqd_of_two_faults_the_first_in_sorted_key_order_is_named() {
    let mut value = design();
    let object = value.as_object_mut().expect("object");
    object.insert(
        "zones".to_owned(),
        json!([{ "zone_type": "rect", "points": [] }]),
    );
    object.insert(
        "plants".to_owned(),
        json!([{ "id": "p", "canonical_name": "Malus", "position": { "lon": 2.0, "lat": 86.0 } }]),
    );
    assert_eq!(path_of(&value), "$.plants[0].position.lat");

    let mut camera = camera();
    camera["zoom"] = json!(28.0);
    camera["lat"] = json!(-90.0);
    value["map_view"] = camera;
    assert_eq!(path_of(&value), "$.map_view.lat");

    let mut missing = design();
    let object = missing.as_object_mut().expect("object");
    object.remove("updated_at");
    object.remove("budget");
    assert_eq!(path_of(&missing), "$.budget");
}

/// canopi-cyqd: inside a tagged enum an unknown kind names `.kind`, and a missing field
/// of a known kind names that field.
#[test]
fn canopi_cyqd_a_tagged_enum_names_its_kind_or_its_missing_leaf() {
    let mut value = design();
    let mut highlighted = view(camera());
    highlighted["highlighted"]["objects"] = json!([{ "kind": "pond", "id": "p" }]);
    value["views"] = json!([highlighted]);
    assert_eq!(path_of(&value), "$.views[0].highlighted.objects[0].kind");

    let mut value = design();
    let mut no_kind = view(camera());
    no_kind["highlighted"]["objects"] = json!([{ "id": "p" }]);
    value["views"] = json!([no_kind]);
    assert_eq!(path_of(&value), "$.views[0].highlighted.objects[0].kind");

    let mut value = design();
    value["timeline"] = json!([{
        "id": "task-1", "action_type": "planting", "description": "Plant",
        "start_date": "2026-04-01", "end_date": "2026-04-02", "recurrence": null,
        "targets": [{ "kind": "zone" }], "depends_on": null, "completed": false, "order": 0
    }]);
    assert_eq!(path_of(&value), "$.timeline[0].targets[0].zone_id");
}

/// canopi-cyqd: a fault in a map names the map's value, never its key. Of two faults in
/// one map the first in sorted key order is named, where the Web names the first in file
/// order: the two may differ, which is diagnostic only (the path never reaches the user).
#[test]
fn canopi_cyqd_a_map_fault_names_the_map_value_never_its_key() {
    let mut value = design();
    value["plant_species_colors"] = json!({ "Pyrus": 2, "Malus domestica": 1 });
    let (path, text) = refused(&value).expect("a number is not a colour");
    assert_eq!(path, "$.plant_species_colors[*]");
    assert!(!text.contains("Malus") && !text.contains("Pyrus"), "{text}");
}

/// canopi-cyqd: the refusal reads as the path and what was expected, never a file value:
/// a hostile species key or enum value stays out of it.
#[test]
fn canopi_cyqd_a_refusal_never_carries_a_file_value() {
    let hostile = "<img src=x onerror=alert(1)> /home/alice/garden.canopi";
    let mut value = design();
    value["plant_species_colors"] = json!({ hostile: 5 });
    let (_, text) = refused(&value).expect("a number is not a colour");
    assert_eq!(text, "$.plant_species_colors[*]: expected a string");

    let mut value = design();
    let mut labelled = view(camera());
    labelled["labels"] = json!(hostile);
    value["views"] = json!([labelled]);
    let (path, text) = refused(&value).expect("an unknown label mode");
    assert_eq!(path, "$.views[0].labels");
    assert!(
        !text.contains("alice") && !text.contains("onerror"),
        "{text}"
    );

    let mut value = design();
    value["name"] = json!({ hostile: hostile });
    let (path, text) = refused(&value).expect("a name is a string");
    assert_eq!((path.as_str(), text.contains("alice")), ("$.name", false));
}

#[test]
fn numbers_are_held_to_their_schema_bounds_and_formats() {
    for (field, number, expected) in [
        (
            "zoom",
            json!(27.5),
            "$.map_view.zoom: expected a number less than or equal to 27",
        ),
        (
            "bearing",
            json!(-1),
            "$.map_view.bearing: expected a number greater than or equal to 0",
        ),
        (
            "lon",
            json!("2"),
            "$.map_view.lon: expected a finite number",
        ),
    ] {
        let mut value = design();
        let mut view_camera = camera();
        view_camera[field] = number;
        value["map_view"] = view_camera;
        assert_eq!(
            refused(&value).map(|(_, text)| text).as_deref(),
            Some(expected)
        );
    }
    let mut value = design();
    value["version"] = json!(9.5);
    assert_eq!(path_of(&value), "$.version");
}

/// A keyword the walker does not handle would admit what the Web refuses: the check
/// every schema builder runs in tests names it and where it is.
#[test]
fn an_unsupported_schema_keyword_is_named_with_its_place() {
    assert_eq!(unsupported_keyword(v9_schema()), None);
    let mut schema = v9_schema().clone();
    schema["properties"]["plants"]["maxItems"] = json!(1);
    assert_eq!(
        unsupported_keyword(&schema).as_deref(),
        Some("$schema.properties.plants: keyword maxItems")
    );
    schema["properties"]["plants"] = json!({ "type": "number", "format": "int64" });
    assert_eq!(
        unsupported_keyword(&schema).as_deref(),
        Some("$schema.properties.plants: format int64")
    );
}
