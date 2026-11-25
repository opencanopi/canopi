//! Unit, M31 schema-compatibility, frozen-reader oracle, and proptest suites for the
//! v10 Format Core (ADR 0026, contracts §10-11; 2.1-M31, 2.1-M156, 2.1-M527, 2.1-M539).

use std::collections::BTreeMap;

use canopi_types::design::GeoPoint;
use canopi_types::design::v10::{
    FormatLoadRefusalKind, canopi_file_v10_json_schema, print_setup_v10_json_schema,
};
use canopi_types::saved_object_stamps::{
    MAX_STAMP_PAYLOAD_BYTES, SavedObjectStampPayload, StampAnnotation, StampBudgetLine,
    StampCareAction, StampConsortium, StampGroup, StampGroupMember, StampGuide, StampPlant,
    StampPoint, StampZone,
};
use serde_json::{Value, json};

use crate::chain::{
    CANOPI_CURRENT, CANOPI_FLOOR, CANOPI_STEPS, CanopiStep, PreUpgradeCopyDecision,
    canonical_fingerprint, migrate_v9_to_v10, pre_upgrade_copy_decision, pre_upgrade_copy_name,
    release_label,
};
use crate::core::{
    MAX_CANOPI_FILE_BYTES, NewDesignInput, decode_design, decode_design_value_with_steps,
    draft_summary, encode_design, new_design, v9_schema, v10_schema,
};
use crate::read::read_newer_design;
use crate::schema::unsupported_keyword;
use crate::spec_emit::emit_v10_spec_files;
use crate::stamps::{
    StampPayloadRefusal, canopi_file_to_stamp, decode_stamp_payload, encode_stamp_payload,
    stamp_to_canopi_file, stamp_v2_schema,
};
use crate::v10::read_schema;

fn valid_v9_fixture() -> Value {
    serde_json::from_str(include_str!("../spec/v9/fixture.canopi")).expect("frozen v9 fixture")
}

#[test]
fn v9_frozen_fixture_migrates_to_hand_written_golden_and_opens_in_frozen_v2_0_5_reader() {
    let opened = decode_design(include_bytes!("../spec/v9/fixture.canopi"))
        .expect("frozen v9 fixture must migrate cleanly");

    assert_eq!(opened.migrated_from, Some(9));
    assert_eq!(opened.migrated_from_release.as_deref(), Some("2.0"));

    // B9: compare migrated output byte-for-byte against the hand-written golden.
    let expected: Value =
        serde_json::from_str(include_str!("../spec/v9/expected_v10.json")).unwrap();
    assert_eq!(opened.design, expected);

    let encoded = encode_design(&opened.design).expect("migrated v10 passes write admission");
    let encoded_again = encode_design(&opened.design).expect("second encode succeeds");
    assert_eq!(
        encoded, encoded_again,
        "canonical encode must be deterministic"
    );

    let parsed: Value = serde_json::from_slice(&encoded).unwrap();
    let ro = read_newer_design(&parsed).expect("v2.0.5 frozen reader must open migrated v10");
    assert_eq!(ro.saved_by_version, 10);
    assert_eq!(ro.view.plants.len(), 2);
}

#[test]
fn v9_non_object_budget_line_refused_by_v9_schema_and_step_failure() {
    let mut bad_v9 = valid_v9_fixture();
    bad_v9["budget"] = json!(["not-an-object"]);
    let bytes = serde_json::to_vec(&bad_v9).unwrap();

    // Decode walks frozen spec/v9/schema.json before stepping and refuses at $.budget[0].
    let err = decode_design(&bytes).expect_err("non-object v9 budget line must be refused");
    assert_eq!(err.kind, FormatLoadRefusalKind::InvalidDocument);
    assert_eq!(err.field_path.as_deref(), Some("$.budget[0]"));

    // Calling the step directly also returns StepFailure (never silently drops).
    let step_err = migrate_v9_to_v10(bad_v9).expect_err("step must return StepFailure");
    assert_eq!(step_err.from, 9);
}

#[test]
fn planted_failing_step_reports_flat_migration_failed_end_to_end() {
    fn always_fail(_: Value) -> Result<Value, crate::chain::StepFailure> {
        Err(crate::chain::StepFailure {
            from: 9,
            reason: "planted failure".to_owned(),
        })
    }
    let steps = [CanopiStep {
        from: 9,
        run: always_fail,
    }];
    let refusal = decode_design_value_with_steps(valid_v9_fixture(), &steps, 9)
        .expect_err("planted failing step must refuse decode");
    assert_eq!(
        refusal.kind,
        FormatLoadRefusalKind::MigrationFailed { from: 9 }
    );
    // B10: FormatRefusal serialises flat on the wire (no nested {"kind":{"kind":...}}).
    let wire = serde_json::to_value(&refusal).expect("serializes");
    assert_eq!(wire["kind"], "migration_failed");
    assert_eq!(wire["from"], 9);
    assert_eq!(wire["field_path"], "$");
}

#[test]
fn version_boundaries_size_cap_and_draft_summary() {
    let v8 = serde_json::to_vec(&json!({ "version": 8 })).unwrap();
    assert_eq!(
        decode_design(&v8).unwrap_err().kind,
        FormatLoadRefusalKind::OlderVersion
    );

    let v11 = serde_json::to_vec(&json!({ "version": 11 })).unwrap();
    assert_eq!(
        decode_design(&v11).unwrap_err().kind,
        FormatLoadRefusalKind::NewerVersion
    );

    let summary = draft_summary(&v11, "2026-11-25T00:00:00Z");
    assert!(!summary.readable);
    assert_eq!(
        summary.refusal_kind,
        Some(FormatLoadRefusalKind::NewerVersion)
    );

    let v9_bytes = serde_json::to_vec(&valid_v9_fixture()).unwrap();
    let ok_summary = draft_summary(&v9_bytes, "fallback");
    assert!(ok_summary.readable);
    assert_eq!(ok_summary.name, "Frozen v9 Orchard");
    assert_eq!(ok_summary.migrated_from, Some(9));

    assert_eq!(MAX_CANOPI_FILE_BYTES, 64 * 1024 * 1024);
}

#[test]
fn pre_upgrade_copy_decision_is_pure_host_helper() {
    assert_eq!(release_label(9), Some("2.0"));
    assert_eq!(release_label(10), Some("2.1"));
    assert_eq!(release_label(99), None);
    assert_eq!(
        pre_upgrade_copy_name("Garden", 9, 0).as_deref(),
        Some("Garden (Canopi 2.0).canopi")
    );
    assert_eq!(
        pre_upgrade_copy_name("Garden", 9, 1).as_deref(),
        Some("Garden (Canopi 2.0) (2).canopi")
    );
    assert_eq!(
        pre_upgrade_copy_decision(None, Some("Garden")),
        PreUpgradeCopyDecision::NotNeeded
    );
    assert_eq!(
        pre_upgrade_copy_decision(Some(9), Some("Garden")),
        PreUpgradeCopyDecision::Required {
            from_version: 9,
            release_label: "2.0".to_owned(),
            suggested_name: Some("Garden (Canopi 2.0).canopi".to_owned()),
        }
    );
}

fn resolve_schema_node<'a>(root: &'a Value, node: &'a Value) -> &'a Value {
    if let Some(ref_path) = node.get("$ref").and_then(Value::as_str)
        && let Some(def_name) = ref_path.strip_prefix("#/$defs/")
    {
        return &root["$defs"][def_name];
    }
    node
}

fn assert_schema_compat(
    read_root: &Value,
    emitted_root: &Value,
    read_node: &Value,
    emitted_node: &Value,
    path: &str,
) {
    let r = resolve_schema_node(read_root, read_node);
    let e = resolve_schema_node(emitted_root, emitted_node);
    if let (Some(r_props), Some(e_props)) = (
        r.get("properties").and_then(Value::as_object),
        e.get("properties").and_then(Value::as_object),
    ) {
        let r_req: Vec<&str> = r["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        for req_key in e["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            assert!(
                r_req.contains(&req_key),
                "B8/M481 violation at {path}: emitted schema requires '{req_key}' which frozen read-schema marks optional"
            );
        }
        for (k, r_sub) in r_props {
            let e_sub = e_props
                .get(k)
                .unwrap_or_else(|| panic!("emitted v10 schema missing property {path}.{k}"));
            assert_schema_compat(
                read_root,
                emitted_root,
                r_sub,
                e_sub,
                &format!("{path}.{k}"),
            );
        }
    }
    if let (Some(r_items), Some(e_items)) = (r.get("items"), e.get("items")) {
        assert_schema_compat(
            read_root,
            emitted_root,
            r_items,
            e_items,
            &format!("{path}[]"),
        );
    }
    if let (Some(r_any), Some(e_any)) = (
        r.get("anyOf").and_then(Value::as_array),
        e.get("anyOf").and_then(Value::as_array),
    ) {
        for r_branch in r_any
            .iter()
            .filter(|b| b.get("type") != Some(&json!("null")))
        {
            if let Some(e_branch) = e_any.iter().find(|b| b.get("type") != Some(&json!("null"))) {
                assert_schema_compat(read_root, emitted_root, r_branch, e_branch, path);
            }
        }
    }
}

#[test]
fn m31_emitted_v10_schema_matches_typed_model_and_frozen_read_schema_deeply() {
    let emitted_v10 = v10_schema().expect("emitted spec/v10/schema.json parses");
    let frozen_v9 = v9_schema().expect("frozen spec/v9/schema.json parses");
    let frozen_stamp_v2 = stamp_v2_schema().expect("frozen spec/stamps/v2/schema.json parses");
    assert_eq!(unsupported_keyword(emitted_v10), None);
    assert_eq!(unsupported_keyword(frozen_v9), None);
    assert_eq!(unsupported_keyword(frozen_stamp_v2), None);

    // Emitted v10 schema must match schemars::schema_for!(CanopiFileV10) directly (B2).
    let live_v10 = canopi_file_v10_json_schema();
    assert_eq!(
        crate::chain::canonicalize_json(&live_v10),
        crate::chain::canonicalize_json(emitted_v10)
    );

    // Deep B8/M31/M481 compatibility check across root and every nested definition.
    let frozen = read_schema().expect("frozen read-schema.json");
    assert_schema_compat(frozen, emitted_v10, frozen, emitted_v10, "$");
    let frozen_props = frozen["properties"].as_object().unwrap();
    let emitted_props = emitted_v10["properties"].as_object().unwrap();
    let allowed_additions = ["print_setup", "budget_ext"];
    for key in emitted_props.keys() {
        assert!(
            frozen_props.contains_key(key) || allowed_additions.contains(&key.as_str()),
            "emitted v10 schema has undeclared root property {key}"
        );
    }

    // M481 behavioral probe: decode both read-fixture.canopi and a minimal identity-only file.
    decode_design(include_bytes!("../spec/v10/read-fixture.canopi"))
        .expect("2.1 decode must accept frozen read-fixture.canopi");
    let minimal_identity_only = json!({
        "version": 10,
        "layers": [{ "name": "plants" }],
        "annotations": [{ "id": "a1", "position": { "lon": 2.0, "lat": 48.0 } }],
        "consortiums": [{ "target": { "kind": "species", "canonical_name": "Malus domestica" } }],
        "timeline": [{ "id": "t1" }],
        "views": [{
            "id": "v1",
            "camera": { "lon": 2.0, "lat": 48.0, "zoom": 15.0, "ground_size_m": { "width": 100.0, "height": 80.0 } },
            "text": [{ "kind": "paragraph", "spans": [{}] }, { "kind": "bullets", "items": [{}] }]
        }],
        "stories": [{ "id": "s1", "steps": [{ "id": "st1", "view_id": "v1" }] }]
    });
    decode_design(&serde_json::to_vec(&minimal_identity_only).unwrap())
        .expect("2.1 decode must accept minimal M481 identity-only v10 file");

    // B9: spec/v10/fixture.canopi decodes byte-for-byte to hand-written spec/v10/expected.json.
    let ps_schema = print_setup_v10_json_schema();
    let files = emit_v10_spec_files(&live_v10, &ps_schema);
    assert_eq!(files.len(), 7);
    let opened = decode_design(include_bytes!("../spec/v10/fixture.canopi"))
        .expect("spec/v10/fixture.canopi decodes");
    let expected: Value = serde_json::from_str(include_str!("../spec/v10/expected.json")).unwrap();
    assert_eq!(opened.design, expected);
    let ro = read_newer_design(&opened.design).expect("v2.0.5 frozen reader opens spec fixture");
    assert_eq!(ro.saved_by_version, 10);
}

#[test]
fn frozen_historical_schemas_and_migration_chain_are_pinned() {
    assert_eq!(CANOPI_FLOOR, 9);
    assert_eq!(CANOPI_CURRENT, 10);
    assert_eq!(CANOPI_STEPS.len(), 1);
    let v9_fp = canonical_fingerprint(v9_schema().expect("frozen v9 schema"));
    let stamp_v2_fp = canonical_fingerprint(stamp_v2_schema().expect("frozen stamp v2 schema"));
    assert_eq!(
        v9_fp, 1_402_960_563_917_306_534,
        "frozen spec/v9/schema.json changed"
    );
    assert_eq!(
        stamp_v2_fp, 2_874_861_502_608_891_289,
        "frozen spec/stamps/v2/schema.json changed"
    );
}

#[test]
fn stamp_payload_v2_migrates_to_v3() {
    let v2 = json!({
        "version": 2,
        "anchor": { "x": 0.0, "y": 0.0 },
        "plants": [{
            "id": "p1",
            "canonicalName": "Malus domestica",
            "commonName": "Apple",
            "color": "#5E8B7E",
            "symbol": "apple",
            "position": { "x": 2.0, "y": 3.0 },
            "rotationDeg": 15.0,
            "scale": 4.0
        }],
        "zones": [{
            "id": "z1",
            "name": "Bed",
            "zoneType": "polygon",
            "points": [{ "x": 0.0, "y": 0.0 }, { "x": 5.0, "y": 0.0 }],
            "rotationDeg": 0.0,
            "fillColor": "#3A6EA5"
        }],
        "annotations": [{
            "id": "a1",
            "annotationType": "text",
            "position": { "x": 1.0, "y": 1.0 },
            "text": "North",
            "fontSize": 14.0,
            "rotationDeg": 0.0
        }],
        "groups": []
    });
    let migrated = decode_stamp_payload(&serde_json::to_vec(&v2).unwrap()).expect("v2 -> v3");
    assert_eq!(migrated.version, 3);
    assert_eq!(migrated.plants[0].canopy_spread_m, Some(4.0));
    assert!(!migrated.plants[0].pinned_name);

    assert_eq!(
        decode_stamp_payload(br#"{"version": 4}"#).unwrap_err(),
        StampPayloadRefusal::NeedsNewer { version: 4 }
    );
    assert_eq!(
        decode_stamp_payload(br#"{"version": 1}"#).unwrap_err(),
        StampPayloadRefusal::BeforeFloor { version: 1 }
    );
    let oversized = vec![b' '; MAX_STAMP_PAYLOAD_BYTES + 1];
    assert_eq!(
        decode_stamp_payload(&oversized).unwrap_err(),
        StampPayloadRefusal::TooLarge {
            limit: MAX_STAMP_PAYLOAD_BYTES
        }
    );
    // N5: malformed v2 stamp payload is refused by the frozen v2 schema walk before stepping.
    let bad_v2 =
        json!({ "version": 2, "anchor": { "x": 0.0, "y": 0.0 }, "plants": ["not-an-object"] });
    assert!(matches!(
        decode_stamp_payload(&serde_json::to_vec(&bad_v2).unwrap()),
        Err(StampPayloadRefusal::InvalidPayload { field_path, .. }) if field_path == "$.plants[0]"
    ));
}

fn sample_stamp_v3() -> SavedObjectStampPayload {
    let mut colors = BTreeMap::new();
    colors.insert("Malus domestica".to_owned(), "#5E8B7E".to_owned());
    let mut symbols = BTreeMap::new();
    symbols.insert("Malus domestica".to_owned(), "apple".to_owned());
    let mut codes = BTreeMap::new();
    codes.insert("Malus domestica".to_owned(), "MD".to_owned());

    SavedObjectStampPayload {
        version: 3,
        anchor: StampPoint { x: 0.0, y: 0.0 },
        plants: vec![StampPlant {
            id: "p1".to_owned(),
            canonical_name: "Malus domestica".to_owned(),
            common_name: Some("Apple".to_owned()),
            color: Some("#5E8B7E".to_owned()),
            symbol: Some("apple".to_owned()),
            pinned_name: true,
            locked: true,
            position: StampPoint { x: 4.0, y: -2.0 },
            rotation_deg: Some(20.0),
            canopy_spread_m: Some(4.5),
            notes: Some("Espalier".to_owned()),
            extra: BTreeMap::new(),
        }],
        zones: vec![StampZone {
            id: "z1".to_owned(),
            name: Some("Guild Bed".to_owned()),
            locked: false,
            zone_type: "polygon".to_owned(),
            points: vec![StampPoint { x: 0.0, y: 0.0 }, StampPoint { x: 6.0, y: 0.0 }],
            rotation_deg: 0.0,
            fill_color: Some("#3A6EA5".to_owned()),
            stroke_color: Some("#1E3A5F".to_owned()),
            opacity: Some(0.5),
            notes: Some("Mulched".to_owned()),
            extra: BTreeMap::new(),
        }],
        annotations: vec![StampAnnotation {
            id: "a1".to_owned(),
            locked: true,
            annotation_type: "text".to_owned(),
            position: StampPoint { x: 1.0, y: 1.0 },
            text: "Guild".to_owned(),
            font_size: 14.0,
            rotation_deg: Some(0.0),
            extra: BTreeMap::new(),
        }],
        measurement_guides: vec![StampGuide {
            id: "g1".to_owned(),
            locked: true,
            start: StampPoint { x: 0.0, y: 0.0 },
            end: StampPoint { x: 4.0, y: 0.0 },
            extra: BTreeMap::new(),
        }],
        groups: vec![StampGroup {
            id: "grp-1".to_owned(),
            locked: false,
            name: Some("All".to_owned()),
            members: vec![
                StampGroupMember::Plant {
                    id: "p1".to_owned(),
                },
                StampGroupMember::MeasurementGuide {
                    id: "g1".to_owned(),
                },
            ],
            extra: BTreeMap::new(),
        }],
        plant_species_colors: colors,
        plant_species_symbols: symbols,
        plant_species_codes: codes,
        consortiums: vec![StampConsortium {
            canonical_name: "Malus domestica".to_owned(),
            stratum: "high".to_owned(),
            start_phase: 1,
            end_phase: 3,
            extra: BTreeMap::new(),
        }],
        budget: vec![StampBudgetLine {
            canonical_name: "Malus domestica".to_owned(),
            unit_cost: 29.0,
            extra: BTreeMap::new(),
        }],
        timeline: vec![StampCareAction {
            id: "care-1".to_owned(),
            action_type: "pruning".to_owned(),
            description: "Winter prune".to_owned(),
            offset_days: Some(90),
            recurrence: None,
            targets: vec![canopi_types::design::PanelTarget::PlacedPlant {
                plant_id: "p1".to_owned(),
            }],
            extra: BTreeMap::new(),
        }],
        extra: BTreeMap::new(),
    }
}

#[test]
fn stamp_payload_v3_round_trips_through_canopi_file() {
    let v3 = sample_stamp_v3();
    let encoded = encode_stamp_payload(&v3).expect("v3 stamp encodes");
    let decoded = decode_stamp_payload(&encoded).expect("v3 stamp decodes");
    assert_eq!(decoded, v3);

    let origin = GeoPoint {
        lon: 2.2945,
        lat: 48.8584,
    };
    let canopi_doc = stamp_to_canopi_file(&v3, "Apple Guild", origin);
    let doc_bytes = encode_design(&canopi_doc).expect("stamp .canopi file passes write admission");
    let parsed: Value = serde_json::from_slice(&doc_bytes).unwrap();
    read_newer_design(&parsed).expect("v2.0.5 frozen reader opens stamp .canopi file");

    let round_tripped = canopi_file_to_stamp(&parsed, origin).expect("file -> stamp");
    assert_eq!(round_tripped.plant_species_colors, v3.plant_species_colors);
    assert_eq!(round_tripped.consortiums, v3.consortiums);
    assert_eq!(round_tripped.budget, v3.budget);
    assert_eq!(round_tripped.timeline, v3.timeline);
    assert_eq!(round_tripped.measurement_guides.len(), 1);
    assert!((round_tripped.plants[0].position.x - 4.0).abs() < 1e-6);
    assert!((round_tripped.plants[0].position.y + 2.0).abs() < 1e-6);
}

#[test]
fn new_design_builds_canonical_v10_document() {
    let doc = new_design(&NewDesignInput {
        name: "Meadow".to_owned(),
        plant_display: Some(json!({ "color_by": "species", "labels": "common" })),
        created_at: "2026-11-25T00:00:00Z".to_owned(),
    });
    assert_eq!(doc["version"], 10);
    assert_eq!(doc["name"], "Meadow");
    assert_eq!(doc["plant_display"]["color_by"], "species");
    encode_design(&doc).expect("new_design output passes write admission");
}
