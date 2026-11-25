//! Deterministic emitter for `canopi-format/spec/v10/` and `spec/v10/additions/`
//! (contracts §10, ADR 0026; 2.1-Q7, 2.1-Q36, 2.1-M31, 2.1-M94, 2.1-M161, 2.1-Q355).
//!
//! Emits the full v10 spec bundle directly from the typed v10 Rust definitions
//! (`CanopiFileV10`, `DESIGN_FILE_FIELDS_V10`, `PrintSetupV10`) alongside the frozen
//! `spec/v10/read-schema.json` from Step 2.0.4 so the M31 compatibility check is real.

use canopi_types::design::v10::DESIGN_FILE_FIELDS_V10;
use serde_json::{Value, json};

use crate::chain::{CANOPI_CURRENT, CANOPI_FLOOR, canonicalize_json, release_label};
use crate::core::{NewDesignInput, new_design};

/// One emitted file under `canopi-format/spec/v10/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmittedSpecFile {
    /// Relative path under `canopi-format/spec/v10/`.
    pub relative_path: &'static str,
    /// Pretty-printed deterministic JSON with trailing newline.
    pub content: String,
}

/// Returns every file emitted under `canopi-format/spec/v10/` in deterministic order.
///
/// `v10_schema` is generated directly from `canopi_types::design::v10::CanopiFileV10`
/// and `print_setup_schema` directly from `PrintSetupV10` (`2.1-M31`, `2.1-M161`).
/// `expected.json` is intentionally NOT emitted here — it is a hand-written golden checked by tests.
#[must_use]
pub fn emit_v10_spec_files(v10_schema: &Value, print_setup_schema: &Value) -> Vec<EmittedSpecFile> {
    let fixture = v10_full_fixture();
    let fixture_bytes = pretty_canonical_json(&fixture);

    vec![
        EmittedSpecFile {
            relative_path: "schema.json",
            content: pretty_canonical_json(v10_schema),
        },
        EmittedSpecFile {
            relative_path: "fields.json",
            content: pretty_canonical_json(&v10_fields_table()),
        },
        EmittedSpecFile {
            relative_path: "defaults.json",
            content: pretty_canonical_json(&new_design(&NewDesignInput {
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
            relative_path: "additions/print_setup.json",
            content: pretty_canonical_json(&addition_print_setup(print_setup_schema)),
        },
        EmittedSpecFile {
            relative_path: "additions/zone_style.json",
            content: pretty_canonical_json(&addition_zone_style(v10_schema)),
        },
        EmittedSpecFile {
            relative_path: "additions/timeline_offset.json",
            content: pretty_canonical_json(&addition_timeline_offset(v10_schema)),
        },
    ]
}

/// Builds `spec/v10/fields.json` directly from [`DESIGN_FILE_FIELDS_V10`] and frozen `release_label`.
#[must_use]
pub fn v10_fields_table() -> Value {
    let fields: Vec<Value> = DESIGN_FILE_FIELDS_V10
        .iter()
        .filter(|f| f.key != "extra")
        .map(|f| {
            json!({
                "key": f.key,
                "owner": f.owner.as_str(),
                "required": f.key == "version",
            })
        })
        .collect();
    canonicalize_json(&json!({
        "floor": CANOPI_FLOOR,
        "current": CANOPI_CURRENT,
        "release_labels": {
            "9": release_label(9),
            "10": release_label(10),
        },
        "fields": fields,
    }))
}

/// Full v10 fixture covering every `DESIGN_FILE_FIELDS_V10` key with non-default values, every
/// nested struct filled, v10 additions (`print_setup` per M161, zone `stroke_color`/`opacity`,
/// timeline `offset_days`), and one unknown root key (contracts §10).
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

/// Formats any JSON value in canonical sorted-key pretty-printed form with a trailing newline.
#[must_use]
pub fn pretty_canonical_json(value: &Value) -> String {
    let mut s = serde_json::to_string_pretty(&canonicalize_json(value))
        .unwrap_or_else(|_| String::from("{}"));
    s.push('\n');
    s
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
            { "name": "zones", "visible": true, "locked": false, "opacity": 0.75, "future_layer_flag": true },
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
                "position": { "lon": 2.2945, "lat": 48.8584, "future_point_crs_note": "wgs84" },
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
                    "framing": { "paper": "A4", "orientation": "landscape" },
                    "scale": { "kind": "fit" }
                },
                {
                    "id": "page-2",
                    "name": "Detail A",
                    "area": {
                        "kind": "split_sheet",
                        "split": "split-1",
                        "along_page": { "right_m": 0.0, "down_m": 0.0, "future_offset_meta": 1 },
                        "size": { "width_m": 50.0, "height_m": 35.0, "future_size_meta": "m" }
                    },
                    "scale": { "kind": "ratio", "denominator": 200 }
                }
            ]
        },
        "views": [
            {
                "id": "view-1",
                "name": "South slope",
                "future_view_key": "keep",
                "camera": {
                    "lon": 2.2945,
                    "lat": 48.8584,
                    "zoom": 19.0,
                    "bearing": 15.0,
                    "ground_size_m": { "width": 100.0, "height": 70.0 },
                    "future_camera_key": 42
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
                "future_story_key": true,
                "steps": [
                    { "id": "step-1", "view_id": "view-1", "title": "Overview", "future_step_key": "keep" }
                ]
            }
        ]
    })
}

fn addition_print_setup(print_setup_schema: &Value) -> Value {
    canonicalize_json(&json!({
        "addition": "print_setup",
        "ledger": ["2.1-Q36", "2.1-M90", "2.1-M94", "2.1-M161", "2.1-Q356"],
        "target": "$.print_setup",
        "optional": true,
        "ignored_by_reader_release": true,
        "schema": print_setup_schema
    }))
}

fn addition_zone_style(v10_schema: &Value) -> Value {
    let zone_props = &v10_schema["$defs"]["ZoneV10"]["properties"];
    canonicalize_json(&json!({
        "addition": "zone_style",
        "ledger": ["2.1-Q36", "2.1-M94", "2.1-Q355"],
        "target": "$.zones[*]",
        "optional": true,
        "ignored_by_reader_release": true,
        "properties": {
            "stroke_color": zone_props["stroke_color"],
            "opacity": zone_props["opacity"]
        }
    }))
}

fn addition_timeline_offset(v10_schema: &Value) -> Value {
    let offset_schema = &v10_schema["$defs"]["TimelineActionV10"]["properties"]["offset_days"];
    canonicalize_json(&json!({
        "addition": "timeline_offset",
        "ledger": ["2.1-Q36", "2.1-M94", "2.1-Q155"],
        "target": "$.timeline[*].offset_days",
        "optional": true,
        "ignored_by_reader_release": true,
        "schema": offset_schema
    }))
}
