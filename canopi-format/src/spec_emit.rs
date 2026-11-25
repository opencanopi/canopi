//! Deterministic emitter for `canopi-format/spec/v10/` and `spec/v10/additions/`
//! (contracts §10, ADR 0026; 2.1-Q7, 2.1-Q36, 2.1-M31, 2.1-M94, 2.1-M161, 2.1-Q355).
//!
//! Emits the full v10 spec bundle alongside the frozen `spec/v10/read-schema.json`
//! from Step 2.0.4:
//! - `schema.json`: full v10 schema (strictly compatible with `read-schema.json` + `additions/`)
//! - `fields.json`: v10 root fields, owners, defaults, and frozen `release_label` table
//! - `defaults.json`: canonical new-Design v10 defaults
//! - `fixture.canopi`: full v10 fixture covering every field with non-default values + unknown root key
//! - `expected.json`: canonical decoded output of `fixture.canopi`
//! - `additions/{print_setup,zone_style,timeline_offset}.json`: post-freeze v10 optional additions

use serde_json::{Value, json};

use crate::chain::{CANOPI_CURRENT, CANOPI_FLOOR, canonicalize_json, release_label};
use crate::core::{NewDesignInput, decode_design, new_design};
use crate::v10::read_schema;

/// One emitted file under `canopi-format/spec/v10/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmittedSpecFile {
    /// Relative path under `canopi-format/spec/v10/`.
    pub relative_path: &'static str,
    /// Pretty-printed deterministic JSON with trailing newline.
    pub content: String,
}

/// Returns every file emitted under `canopi-format/spec/v10/` in deterministic order.
#[must_use]
pub fn emit_v10_spec_files() -> Vec<EmittedSpecFile> {
    let fixture = v10_full_fixture();
    let fixture_bytes = pretty_json(&fixture);
    let expected = decode_design(fixture_bytes.as_bytes())
        .map(|opened| opened.design)
        .unwrap_or_else(|_| fixture.clone());

    vec![
        EmittedSpecFile {
            relative_path: "schema.json",
            content: pretty_json(&v10_full_schema()),
        },
        EmittedSpecFile {
            relative_path: "fields.json",
            content: pretty_json(&v10_fields_table()),
        },
        EmittedSpecFile {
            relative_path: "defaults.json",
            content: pretty_json(&new_design(&NewDesignInput {
                name: String::new(),
                plant_display: None,
                created_at: String::new(),
            })),
        },
        EmittedSpecFile {
            relative_path: "fixture.canopi",
            content: fixture_bytes,
        },
        EmittedSpecFile {
            relative_path: "expected.json",
            content: pretty_json(&expected),
        },
        EmittedSpecFile {
            relative_path: "additions/print_setup.json",
            content: pretty_json(&addition_print_setup()),
        },
        EmittedSpecFile {
            relative_path: "additions/zone_style.json",
            content: pretty_json(&addition_zone_style()),
        },
        EmittedSpecFile {
            relative_path: "additions/timeline_offset.json",
            content: pretty_json(&addition_timeline_offset()),
        },
    ]
}

/// Builds the full v10 schema from the frozen `read-schema.json` plus declared `additions/`
/// so the emitted schema stays strictly compatible with the frozen reader schema (2.1-M31).
#[must_use]
pub fn v10_full_schema() -> Value {
    let mut schema = read_schema()
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
    if let Some(props) = schema.get_mut("properties").and_then(Value::as_object_mut) {
        props.insert(
            "print_setup".to_owned(),
            json!({
                "description": "Optional PDF print setup (v10 addition, 2.1-Q36, 2.1-M90, 2.1-M161).",
                "type": ["object", "null"],
                "default": null
            }),
        );
        props.insert(
            "budget_ext".to_owned(),
            json!({
                "description": "Optional non-plant budget extension bag preserved by v9->v10 (2.1-Q162, 2.1-M491).",
                "type": ["object", "null"],
                "default": null
            }),
        );
    }
    if let Some(defs) = schema.get_mut("$defs").and_then(Value::as_object_mut) {
        if let Some(zone_props) = defs
            .get_mut("Zone")
            .and_then(|z| z.get_mut("properties"))
            .and_then(Value::as_object_mut)
        {
            zone_props.insert(
                "stroke_color".to_owned(),
                json!({ "type": ["string", "null"], "default": null }),
            );
            zone_props.insert(
                "opacity".to_owned(),
                json!({ "type": ["number", "null"], "minimum": 0.0, "maximum": 1.0, "default": null }),
            );
        }
        if let Some(tl_props) = defs
            .get_mut("TimelineAction")
            .and_then(|t| t.get_mut("properties"))
            .and_then(Value::as_object_mut)
        {
            tl_props.insert(
                "offset_days".to_owned(),
                json!({ "type": ["integer", "null"], "default": null }),
            );
        }
    }
    canonicalize_json(&schema)
}

/// Builds `spec/v10/fields.json`: v10 field ownership table and frozen release labels.
#[must_use]
pub fn v10_fields_table() -> Value {
    canonicalize_json(&json!({
        "floor": CANOPI_FLOOR,
        "current": CANOPI_CURRENT,
        "release_labels": {
            "9": release_label(9),
            "10": release_label(10),
        },
        "fields": [
            { "key": "version", "owner": "format", "required": true },
            { "key": "name", "owner": "document", "required": false },
            { "key": "description", "owner": "document", "required": false },
            { "key": "plant_species_colors", "owner": "scene", "required": false },
            { "key": "plant_species_symbols", "owner": "scene", "required": false },
            { "key": "plant_species_codes", "owner": "scene", "required": false },
            { "key": "layers", "owner": "scene", "required": false },
            { "key": "plants", "owner": "scene", "required": false },
            { "key": "zones", "owner": "scene", "required": false },
            { "key": "annotations", "owner": "scene", "required": false },
            { "key": "measurement_guides", "owner": "scene", "required": false },
            { "key": "consortiums", "owner": "document", "required": false },
            { "key": "groups", "owner": "scene", "required": false },
            { "key": "timeline", "owner": "document", "required": false },
            { "key": "budget", "owner": "document", "required": false },
            { "key": "budget_currency", "owner": "document", "required": false },
            { "key": "budget_ext", "owner": "document", "required": false },
            { "key": "site_data", "owner": "document", "required": false },
            { "key": "plant_display", "owner": "document", "required": false },
            { "key": "print_setup", "owner": "document", "required": false },
            { "key": "views", "owner": "document", "required": false },
            { "key": "stories", "owner": "document", "required": false },
            { "key": "map_view", "owner": "format", "required": false },
            { "key": "created_at", "owner": "format", "required": false },
            { "key": "updated_at", "owner": "format", "required": false }
        ]
    }))
}

/// Full v10 fixture covering every field with non-default values, every nested struct filled,
/// v10 additions (`print_setup`, zone `stroke_color`/`opacity`, timeline `offset_days`), and one
/// unknown root key (contracts §10).
#[must_use]
pub fn v10_full_fixture() -> Value {
    let mut root = serde_json::Map::new();
    root.insert("version".to_owned(), json!(10));
    root.insert("name".to_owned(), json!("Meadow Food Forest"));
    root.insert(
        "description".to_owned(),
        json!("Full v10 spec fixture covering every field, addition, and unknown root key."),
    );
    merge_object(&mut root, fixture_scene_fields());
    merge_object(&mut root, fixture_document_fields());
    merge_object(&mut root, fixture_print_and_views());
    root.insert(
        "map_view".to_owned(),
        json!({
            "lon": 2.2945,
            "lat": 48.8584,
            "zoom": 18.0,
            "bearing": 0.0,
            "ground_size_m": { "width": 200.0, "height": 140.0 }
        }),
    );
    root.insert("created_at".to_owned(), json!("2026-11-20T09:00:00.000Z"));
    root.insert("updated_at".to_owned(), json!("2026-11-25T05:00:00.000Z"));
    root.insert(
        "future_unknown_root_key".to_owned(),
        json!({ "preserved": true }),
    );
    canonicalize_json(&Value::Object(root))
}

fn merge_object(dst: &mut serde_json::Map<String, Value>, src: Value) {
    if let Value::Object(map) = src {
        for (k, v) in map {
            dst.insert(k, v);
        }
    }
}

fn fixture_scene_fields() -> Value {
    json!({
        "plant_species_colors": { "Malus domestica": "#5E8B7E" },
        "plant_species_symbols": { "Malus domestica": "apple" },
        "plant_species_codes": { "Malus domestica": "MD" },
        "layers": [
            { "name": "zones", "visible": true, "locked": false, "opacity": 0.75 },
            { "name": "plants", "visible": true, "locked": false, "opacity": 1.0 }
        ],
        "plants": [
            {
                "id": "plant-1",
                "locked": false,
                "canonical_name": "Malus domestica",
                "common_name": "Apple",
                "color": "#5E8B7E",
                "symbol": "apple",
                "pinned_name": true,
                "position": { "lon": 2.2945, "lat": 48.8584 },
                "rotation": 15.0,
                "canopy_spread_m": 4.5,
                "notes": "Grafted on MM106",
                "planted_date": "2026-11-15",
                "quantity": 1
            },
            {
                "id": "plant-2",
                "locked": true,
                "canonical_name": "Corylus avellana",
                "common_name": "Hazel",
                "color": null,
                "symbol": null,
                "pinned_name": false,
                "position": { "lon": 2.2948, "lat": 48.8586 },
                "rotation": 0.0,
                "canopy_spread_m": 3.0,
                "notes": null,
                "planted_date": null,
                "quantity": 1
            }
        ],
        "zones": [
            {
                "id": "zone-1",
                "name": "Swale Bed",
                "locked": false,
                "zone_type": "polygon",
                "points": [
                    { "lon": 2.2941, "lat": 48.8581 },
                    { "lon": 2.2946, "lat": 48.8581 },
                    { "lon": 2.2946, "lat": 48.8585 }
                ],
                "rotation": 0.0,
                "fill_color": "#3A6EA5",
                "stroke_color": "#1E3A5F",
                "opacity": 0.65,
                "notes": "Contour swale"
            }
        ],
        "annotations": [
            {
                "id": "note-1",
                "locked": false,
                "annotation_type": "text",
                "position": { "lon": 2.2944, "lat": 48.8583 },
                "text": "North windbreak",
                "font_size": 14.0,
                "rotation": 0.0
            }
        ],
        "measurement_guides": [
            {
                "id": "guide-1",
                "locked": false,
                "start": { "lon": 2.2942, "lat": 48.8582 },
                "end": { "lon": 2.2947, "lat": 48.8585 }
            }
        ],
        "groups": [
            {
                "id": "group-1",
                "locked": false,
                "name": "Apple Guild",
                "members": [
                    { "kind": "plant", "id": "plant-1" },
                    { "kind": "measurement_guide", "id": "guide-1" }
                ]
            }
        ]
    })
}

fn fixture_document_fields() -> Value {
    json!({
        "consortiums": [
            {
                "target": { "kind": "species", "canonical_name": "Malus domestica" },
                "stratum": "high",
                "start_phase": 1,
                "end_phase": 3
            }
        ],
        "timeline": [
            {
                "id": "task-1",
                "action_type": "planting",
                "description": "Mulch apple guild",
                "start_date": "2026-11-20",
                "end_date": "2026-11-25",
                "offset_days": 14,
                "targets": [{ "kind": "placed_plant", "plant_id": "plant-1" }],
                "completed": false,
                "order": 0
            }
        ],
        "budget": [
            {
                "target": { "kind": "species", "canonical_name": "Malus domestica" },
                "unit_cost": 28.5,
                "ext": { "currency": "EUR" }
            }
        ],
        "budget_currency": "EUR",
        "budget_ext": {
            "non_plant_lines": [
                {
                    "target": { "kind": "zone", "zone_id": "zone-1" },
                    "category": "earthworks",
                    "description": "Swale excavation",
                    "unit_cost": 450.0
                }
            ]
        },
        "site_data": {
            "visible": true,
            "entries": [
                {
                    "id": "lyr-terrain",
                    "name": "Terrain",
                    "visible": true,
                    "opacity": 0.8,
                    "order": 0,
                    "ramp": "Terrain",
                    "reversed": false,
                    "range": { "mode": "Custom", "min": 10.0, "max": 85.0 }
                }
            ]
        },
        "plant_display": {
            "color_by": "species",
            "labels": "common",
            "symbol_scale": 1.15,
            "outline": true
        }
    })
}

fn fixture_print_and_views() -> Value {
    json!({
        "print_setup": {
            "splits": [
                {
                    "id": "split-1",
                    "pivot": { "lon": 2.2945, "lat": 48.8584 },
                    "angle_deg": 15.0
                }
            ],
            "pages": [
                {
                    "id": "page-1",
                    "name": "Overview",
                    "area": { "kind": "whole_design", "angle_deg": 0.0 },
                    "scale": { "kind": "fit" }
                },
                {
                    "id": "page-2",
                    "name": "Detail A",
                    "area": {
                        "kind": "split_sheet",
                        "split": "split-1",
                        "along_page": { "right_m": 0.0, "down_m": 0.0 },
                        "size": { "width_m": 50.0, "height_m": 35.0 }
                    },
                    "scale": { "kind": "ratio", "denominator": 200 }
                }
            ]
        },
        "views": [
            {
                "id": "view-1",
                "name": "South slope",
                "camera": {
                    "lon": 2.2945,
                    "lat": 48.8584,
                    "zoom": 19.0,
                    "bearing": 15.0,
                    "ground_size_m": { "width": 100.0, "height": 70.0 }
                },
                "visible_layers": {
                    "background": { "kind": "satellite" },
                    "terrain": { "contours": true, "hillshade": false },
                    "scene_layers": ["zones", "plants"],
                    "site_data": ["lyr-terrain"]
                },
                "highlighted": {
                    "species": ["Malus domestica"],
                    "objects": [{ "kind": "zone", "id": "zone-1" }]
                }
            }
        ],
        "stories": [
            {
                "id": "story-1",
                "name": "Site walk",
                "steps": [
                    { "id": "step-1", "view_id": "view-1", "title": "Overview" }
                ]
            }
        ]
    })
}

fn addition_print_setup() -> Value {
    canonicalize_json(&json!({
        "addition": "print_setup",
        "ledger": ["2.1-Q36", "2.1-M90", "2.1-M94", "2.1-M161", "2.1-Q356"],
        "target": "$.print_setup",
        "optional": true,
        "ignored_by_reader_release": true,
        "schema": {
            "type": ["object", "null"],
            "properties": {
                "splits": { "type": "array" },
                "pages": { "type": "array" }
            }
        }
    }))
}

fn addition_zone_style() -> Value {
    canonicalize_json(&json!({
        "addition": "zone_style",
        "ledger": ["2.1-Q36", "2.1-M94", "2.1-Q355"],
        "target": "$.zones[*]",
        "optional": true,
        "ignored_by_reader_release": true,
        "properties": {
            "stroke_color": { "type": ["string", "null"], "default": null },
            "opacity": { "type": ["number", "null"], "minimum": 0.0, "maximum": 1.0, "default": null }
        }
    }))
}

fn addition_timeline_offset() -> Value {
    canonicalize_json(&json!({
        "addition": "timeline_offset",
        "ledger": ["2.1-Q36", "2.1-M94", "2.1-Q155"],
        "target": "$.timeline[*].offset_days",
        "optional": true,
        "ignored_by_reader_release": true,
        "schema": { "type": ["integer", "null"], "default": null }
    }))
}

fn pretty_json(value: &Value) -> String {
    let mut s = serde_json::to_string_pretty(&canonicalize_json(value))
        .unwrap_or_else(|_| String::from("{}"));
    s.push('\n');
    s
}
