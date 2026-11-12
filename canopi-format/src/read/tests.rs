//! Tests for `read`, a sibling module so `read.rs` keeps under the file-size limit.

use super::{FIRST_READ_VERSION, read_newer_design};
use canopi_types::design::{DesignLoadFailureKind, ObjectGroupMember, PanelTarget};
use canopi_types::library::LibraryItemRole;
use serde_json::{Value, json};

fn point(lon: f64, lat: f64) -> Value {
    json!({ "lon": lon, "lat": lat })
}

/// A v10 Design with each name and shape v10 changes, and keys this build does not know.
fn v10() -> Value {
    json!({
        "version": 10, "name": "Orchard",
        "plants": [{
            "id": "p1", "canonical_name": "Malus domestica", "position": point(2.29, 48.85),
            "canopy_spread_m": 4.5, "scale": 0.0, "ext": { "later": true }
        }],
        "measurement_guides": [{ "id": "m1", "start": point(2.29, 48.85), "end": point(2.3, 48.85) }],
        "groups": [{ "id": "g1", "members": [
            { "kind": "plant", "id": "p1" }, { "kind": "measurement_guide", "id": "m1" }
        ] }],
        "site_data": { "visible": true, "entries": [
            { "id": "lyr-1", "name": "Terrain", "ramp": "Aurora", "kind": { "any": "value" }, "order": 2 },
            { "id": "item-2", "name": "Slope", "ramp": "Magma", "opacity": 0.5 }
        ] },
        "budget": [
            { "target": { "kind": "species", "canonical_name": "Malus domestica" }, "unit_cost": 12.5,
              "ext": { "quantity": 3 } },
            { "target": { "kind": "zone", "zone_id": "z1" }, "unit_cost": 4 }
        ],
        "budget_currency": "USD",
        "plant_display": { "color_by": "by_height", "labels": "names", "outline": true },
        "a_later_root_key": { "kept": false }
    })
}

fn refusal_of(value: &Value) -> (DesignLoadFailureKind, String) {
    let refused = read_newer_design(value).expect_err("the read refuses it");
    (refused.kind, refused.refusal.field_path.to_string())
}

#[test]
fn a_v10_design_reads_into_this_builds_shape_with_v10_names_mapped_back() {
    let read = read_newer_design(&v10()).expect("a v10 Design reads");
    assert_eq!(read.saved_by_version, FIRST_READ_VERSION);
    let view = read.view;
    assert_eq!(
        view.version,
        canopi_types::design::CURRENT_CANOPI_FILE_VERSION
    );
    assert_eq!(view.plants[0].scale, Some(4.5), "the spread, not `scale`");
    assert_eq!(
        view.groups[0].members,
        [ObjectGroupMember::Plant {
            id: "p1".to_owned()
        }]
    );
    let lidar = view.lidar.expect("Site data reads as the LiDAR section");
    let roles = lidar.entries.iter().map(|entry| (entry.kind, entry.ramp));
    assert_eq!(
        roles.collect::<Vec<_>>(),
        [
            (LibraryItemRole::Source, None),
            (
                LibraryItemRole::Derived,
                Some(canopi_types::lidar::LidarRamp::Magma)
            )
        ]
    );
    assert_eq!(view.budget.len(), 1, "the zone line is skipped");
    assert!(matches!(
        &view.budget[0].target,
        PanelTarget::Species { canonical_name } if canonical_name == "Malus domestica"
    ));
    assert_eq!(
        (view.budget[0].unit_cost, view.budget[0].currency.as_str()),
        (12.5, "USD")
    );
    assert_eq!(view.extra.len(), 1, "an unknown root key is ignored");
}

/// canopi-f47t.52.270: a valid v10 `plant_display` reads as the complete v9 stored shape,
/// each absent option, unknown open literal or colour that is no `#RRGGBB` at its v9
/// default, so the 2.0 reader repairs nothing in a file that was never written.
#[test]
fn canopi_f47t_52_270_a_v10_plant_display_reads_complete_so_nothing_is_repaired() {
    let display = |stored: Value| {
        let mut value = v10();
        value["plant_display"] = stored;
        read_newer_design(&value)
            .expect("a v10 Design reads")
            .view
            .extra
            .remove("plant_display")
    };
    let defaults = json!({
        "color_by": "species", "one_color": "#27231D", "symbol_scale": 1.0,
        "outline": true, "labels": "names"
    });
    assert_eq!(display(json!({})), Some(defaults.clone()));
    assert_eq!(
        display(json!({ "color_by": "by_height", "labels": "initials", "one_color": "teal" })),
        Some(defaults),
        "an unknown literal reads as its default"
    );
    assert_eq!(
        display(json!({
            "color_by": "one_color", "one_color": "#a1b2c3", "symbol_scale": 1.5,
            "outline": false, "labels": "codes", "stratum_colors": { "high": "#112233" }
        })),
        Some(json!({
            "color_by": "one_color", "one_color": "#a1b2c3", "symbol_scale": 1.5,
            "outline": false, "labels": "codes", "stratum_colors": { "high": "#112233" }
        }))
    );
}

/// 2.1-M481: only `version` is required at the root; every other field has its default.
#[test]
fn a_v10_design_of_only_its_version_reads_with_every_default() {
    let view = read_newer_design(&json!({ "version": 10.0 }))
        .expect("defaults fill every field")
        .view;
    assert_eq!(
        (view.name.as_str(), view.budget_currency.as_str()),
        ("", "EUR")
    );
    assert!(view.plants.is_empty() && view.layers.is_empty() && view.lidar.is_none());
}

/// canopi-cyqd, 2.1-M481: a version-10 file the read schema refuses is `invalid_document`
/// at its field's path.
#[test]
fn canopi_cyqd_a_version_10_file_the_read_refuses_is_invalid_document_at_its_path() {
    let mut value = v10();
    value["plants"][0]["position"]["lat"] = json!(86.0);
    assert_eq!(
        refusal_of(&value),
        (
            DesignLoadFailureKind::InvalidDocument,
            "$.plants[0].position.lat".to_owned()
        )
    );
    let mut value = v10();
    value["groups"][0]["members"][1]["kind"] = json!("pond");
    assert_eq!(refusal_of(&value).1, "$.groups[0].members[1].kind");
}

/// 2.1-M481: a file above version 10 the read schema refuses was saved by a Canopi that
/// may have changed what this build reads: `newer_version`, never `invalid_document`.
#[test]
fn a_version_above_10_failing_the_read_schema_is_newer_version_not_invalid_document() {
    let mut value = v10();
    value["version"] = json!(11);
    value["plants"][0]["position"] = json!("somewhere else");
    assert_eq!(
        refusal_of(&value),
        (
            DesignLoadFailureKind::NewerVersion,
            "$.plants[0].position".to_owned()
        )
    );
    value["version"] = json!(10);
    assert_eq!(refusal_of(&value).0, DesignLoadFailureKind::InvalidDocument);
    let mut later = v10();
    later["version"] = json!(12);
    later["site_data"]["entries"][0]["opacity"] = json!(2.0);
    assert_eq!(refusal_of(&later).0, DesignLoadFailureKind::NewerVersion);
    later["site_data"]["entries"][0]["opacity"] = json!(1.0);
    assert_eq!(
        read_newer_design(&later).map(|read| read.saved_by_version),
        Ok(12)
    );
}

/// 2.1-M482: the spread is above 0, refused at its own path, and a `scale` beside it is
/// not read; a rule past the schema names the file's v10 path, never the v9 one.
#[test]
fn canopi_cyqd_rules_past_the_schema_name_the_v10_path() {
    for spread in [json!(0.0), json!(-2.5)] {
        let mut value = v10();
        value["plants"][0]["canopy_spread_m"] = spread;
        assert_eq!(
            refusal_of(&value),
            (
                DesignLoadFailureKind::InvalidDocument,
                "$.plants[0].canopy_spread_m".to_owned()
            )
        );
    }
    let mut value = v10();
    value["site_data"]["entries"][1]["opacity"] = json!(1.5);
    assert_eq!(refusal_of(&value).1, "$.site_data.entries[1].opacity");
    let mut value = v10();
    value["plants"][0]["id"] = json!("");
    assert_eq!(refusal_of(&value).1, "$.plants[0].id");
}

#[test]
fn of_two_site_data_entries_with_one_id_the_lowest_order_is_kept() {
    let mut value = v10();
    value["site_data"]["entries"] = json!([
        { "id": "item-2", "name": "Later", "order": 5 },
        { "id": "item-2", "name": "Earlier", "order": 1, "reversed": true }
    ]);
    let entries = read_newer_design(&value)
        .expect("duplicates read")
        .view
        .lidar
        .expect("Site data")
        .entries;
    assert_eq!(entries.len(), 1);
    assert_eq!(
        (
            entries[0].name.as_str(),
            entries[0].order,
            entries[0].reversed
        ),
        ("Earlier", 1, true)
    );
}

#[test]
fn a_version_outside_the_read_is_refused_at_version() {
    for (version, kind) in [
        (json!(9), DesignLoadFailureKind::InvalidDocument),
        (json!("10"), DesignLoadFailureKind::InvalidDocument),
        (json!(10.5), DesignLoadFailureKind::InvalidDocument),
        (json!(1_u64 << 33), DesignLoadFailureKind::NewerVersion),
    ] {
        let mut value = v10();
        value["version"] = version;
        assert_eq!(refusal_of(&value), (kind, "$.version".to_owned()));
    }
    let mut missing = v10();
    missing.as_object_mut().expect("object").remove("version");
    assert_eq!(refusal_of(&missing).1, "$.version");
}

#[test]
fn the_read_schema_is_built_once() {
    let schema = crate::v10::read_schema().expect("the frozen read schema parses");
    assert!(crate::v10::read_schema().is_some_and(|again| std::ptr::eq(schema, again)));
    assert_eq!(schema["required"], json!(["version"]));
}

/// 2.1-M481: every v10 object reads from its identity and geometry alone, each other field
/// at the default the frozen schema documents, objects v10 leaves as v9 included.
#[test]
fn a_v10_object_of_only_its_identity_and_geometry_reads_with_every_default() {
    let camera = json!({
        "lon": 2.29, "lat": 48.85, "zoom": 19.0,
        "ground_size_m": { "width": 300.0, "height": 200.0 }
    });
    let value = json!({
        "version": 10,
        "layers": [{ "name": "plants" }],
        "annotations": [{ "id": "a1", "position": point(2.29, 48.85) }],
        "consortiums": [{ "target": { "kind": "species", "canonical_name": "Malus domestica" } }],
        "timeline": [{ "id": "t1" }],
        "views": [{ "id": "v1", "camera": camera, "text": [{ "kind": "paragraph" }, { "kind": "bullets" }] }],
        "stories": [{ "id": "s1", "steps": [{ "id": "st1", "view_id": "v1" }] }],
        "map_view": camera,
        "site_data": { "entries": [{ "id": "lyr-1", "name": "Terrain" }] },
        "groups": [{ "id": "g1" }],
        "budget": [{ "target": { "kind": "species", "canonical_name": "Malus domestica" } }]
    });
    let view = read_newer_design(&value)
        .expect("identity and geometry are enough")
        .view;
    let read = serde_json::to_value(&view).expect("the view serializes");
    assert_eq!(
        read["layers"][0],
        json!({ "name": "plants", "visible": true, "locked": false, "opacity": 1.0 })
    );
    let annotation = &read["annotations"][0];
    assert_eq!(
        (
            &annotation["annotation_type"],
            &annotation["text"],
            &annotation["font_size"]
        ),
        (&json!("text"), &json!(""), &json!(16.0))
    );
    let consortium = &read["consortiums"][0];
    assert_eq!(
        (
            &consortium["stratum"],
            &consortium["start_phase"],
            &consortium["end_phase"]
        ),
        (&json!("unassigned"), &json!(0), &json!(2))
    );
    let action = &read["timeline"][0];
    assert_eq!(
        (
            &action["action_type"],
            &action["description"],
            &action["completed"],
            &action["order"]
        ),
        (&json!("other"), &json!(""), &json!(false), &json!(0))
    );
    assert_eq!(action["targets"], json!([{ "kind": "manual" }]));
    let saved = &read["views"][0];
    assert_eq!(
        (&saved["name"], &saved["camera"]["bearing"]),
        (&json!(""), &json!(0.0))
    );
    assert_eq!(
        saved["highlighted"],
        json!({ "species": [], "objects": [] })
    );
    assert_eq!(
        saved["visible_layers"],
        json!({
            "background": { "kind": "none" },
            "terrain": { "contours": false, "hillshade": false },
            "scene_layers": ["zones", "plants", "measurement-guides", "annotations"],
            "site_data": []
        })
    );
    assert_eq!(
        saved["text"],
        json!([{ "kind": "paragraph", "spans": [] }, { "kind": "bullets", "items": [] }])
    );
    let story = &read["stories"][0];
    assert_eq!(
        (&story["name"], &story["steps"][0]["title"]),
        (&json!(""), &json!(""))
    );
    assert_eq!(read["map_view"]["bearing"], json!(0.0));
    assert_eq!(read["lidar"]["entries"][0]["opacity"], json!(1.0));
    assert_eq!(read["groups"][0]["members"], json!([]));
    assert_eq!(read["budget"][0]["unit_cost"], json!(0.0));
}

/// 2.1-M481, 2.1-M491: a species line's species is its identity, so a species line without
/// `canonical_name` is refused at its path, where a line whose target is not a species is
/// skipped.
#[test]
fn canopi_f47t_52_270_a_species_budget_line_without_its_species_is_refused_at_its_path() {
    let mut value = v10();
    value["budget"][0]["target"] = json!({ "kind": "species" });
    assert_eq!(
        refusal_of(&value),
        (
            DesignLoadFailureKind::InvalidDocument,
            "$.budget[0].target.canonical_name".to_owned()
        )
    );
    value["budget"][0]["target"] = json!({ "kind": "nursery_order" });
    let budget = read_newer_design(&value)
        .expect("an unknown line kind reads")
        .view
        .budget;
    assert!(
        budget.is_empty(),
        "a line that prices no species is skipped"
    );
}

/// 2.1-M31: the hand-made v10 read fixture reads to its expected read output, the view this
/// build shows: v10 names mapped back, every extension bag, unknown open literal and unknown
/// root key read without a refusal.
#[test]
fn the_v10_read_fixture_reads_to_its_expected_read_output() {
    let fixture = serde_json::from_str::<Value>(include_str!("../../spec/v10/read-fixture.canopi"))
        .expect("the fixture is JSON");
    let expected = serde_json::from_str::<Value>(include_str!("../../spec/v10/read-expected.json"))
        .expect("the expected output is JSON");
    let read = read_newer_design(&fixture).expect("the v10 read fixture reads");
    assert_eq!(
        serde_json::to_value(read).expect("the read serializes"),
        expected
    );
}
