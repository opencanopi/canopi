use canopi_types::design::{DesignLoadFailureKind, GeoPoint};
use canopi_types::store_chain::Admission;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::chain::{
    CANOPI_CURRENT, CANOPI_FLOOR, CanopiStep, PreUpgradeCopyDecision, StepFailure,
    admit_canopi_version, canonical_fingerprint, mark_copy_blocked, migrate_v9_to_v10,
    pre_upgrade_copy_name, release_label, run_steps_with,
};
use crate::core::{
    FORMAT_CORE_VERSION, MAX_CANOPI_FILE_BYTES, NewDesignInput, decode_design, draft_summary,
    encode_design, new_design,
};
use crate::read::read_newer_design;
use crate::spec_emit::{emit_v10_spec_files, v10_full_fixture};
use crate::stamps::{
    MAX_STAMP_PAYLOAD_BYTES, SavedObjectStampPayloadV3, StampAnnotationV3, StampBudgetLineV3,
    StampCareActionV3, StampConsortiumV3, StampGroupMemberV3, StampGroupV3, StampGuideV3,
    StampPayloadRefusal, StampPlantV3, StampPoint, StampZoneV3, canopi_file_to_stamp,
    decode_stamp_payload, encode_stamp_payload, stamp_to_canopi_file,
};

fn sample_v9_design() -> Value {
    json!({
        "version": 9,
        "name": "Legacy Orchard",
        "description": "Saved by Canopi 2.0",
        "plant_species_colors": { "Malus domestica": "#5E8B7E" },
        "layers": [{ "name": "plants", "visible": true, "locked": false, "opacity": 1.0 }],
        "plants": [
            {
                "id": "p1",
                "locked": false,
                "canonical_name": "Malus domestica",
                "common_name": "Apple",
                "color": null,
                "position": { "lon": 2.2945, "lat": 48.8584 },
                "rotation": 10.0,
                "scale": 3.5,
                "notes": "Young tree",
                "planted_date": "2026-04-01",
                "quantity": 1
            },
            {
                "id": "p2",
                "locked": false,
                "canonical_name": "Corylus avellana",
                "common_name": "Hazel",
                "color": null,
                "position": { "lon": 2.2949, "lat": 48.8586 },
                "rotation": null,
                "scale": null,
                "notes": null,
                "planted_date": null,
                "quantity": 1
            }
        ],
        "zones": [],
        "annotations": [],
        "measurement_guides": [],
        "consortiums": [],
        "groups": [
            { "id": "g-lone", "locked": false, "name": "Lone", "members": [{ "kind": "plant", "id": "p1" }] },
            {
                "id": "g-ok",
                "locked": false,
                "name": "Pair",
                "members": [
                    { "kind": "plant", "id": "p1" },
                    { "kind": "plant", "id": "p1" },
                    { "kind": "zone", "id": "missing" },
                    { "kind": "plant", "id": "p2" }
                ]
            }
        ],
        "timeline": [],
        "budget": [
            {
                "target": { "kind": "species", "canonical_name": "Malus domestica" },
                "category": "plants",
                "description": "Apple trees",
                "quantity": 2,
                "unit_cost": 25.0,
                "currency": "USD"
            },
            {
                "target": { "kind": "manual" },
                "category": "fencing",
                "description": "Deer fence",
                "quantity": 1,
                "unit_cost": 800.0,
                "currency": "EUR"
            }
        ],
        "budget_currency": "EUR",
        "lidar": {
            "visible": true,
            "entries": [
                { "id": "item-1", "kind": "Derived", "name": "Later", "visible": true, "opacity": 0.9, "order": 5, "reversed": false },
                { "id": "item-1", "kind": "Source", "name": "Earlier", "visible": true, "opacity": 0.7, "order": 1, "reversed": true }
            ]
        },
        "extra": {
            "plant_display": { "color_by": "species", "labels": "names", "symbol_scale": 1.2 },
            "other_unknown": 42
        },
        "views": [],
        "stories": [],
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-06-01T00:00:00Z"
    })
}

#[test]
fn v9_to_v10_migration_upgrades_all_fields_and_passes_v2_0_5_frozen_reader_oracle() {
    let raw = serde_json::to_vec(&sample_v9_design()).unwrap();
    let opened = decode_design(&raw).expect("v9 design migrates cleanly to v10");
    assert_eq!(opened.migrated_from, Some(9));
    assert_eq!(opened.release_label.as_deref(), Some("2.0"));
    assert_eq!(
        opened.copy_decision,
        PreUpgradeCopyDecision::Required {
            from_version: 9,
            release_label: "2.0".to_owned(),
            suggested_name: Some("Legacy Orchard (Canopi 2.0).canopi".to_owned()),
        }
    );

    let d = &opened.design;
    assert_eq!(d["version"], json!(10));
    assert_eq!(d["plants"][0]["canopy_spread_m"], json!(3.5));
    assert!(d["plants"][0].get("scale").is_none());
    assert!(d.get("lidar").is_none());
    assert_eq!(d["site_data"]["entries"].as_array().unwrap().len(), 1);
    assert_eq!(d["site_data"]["entries"][0]["name"], json!("Earlier"));
    assert!(d["site_data"]["entries"][0].get("kind").is_none());
    assert_eq!(d["plant_display"]["symbol_scale"], json!(1.2));
    assert_eq!(d["extra"]["other_unknown"], json!(42));
    assert!(d["extra"].get("plant_display").is_none());
    // Budget split: species plant line keeps dropped fields in ext, non-plant in budget_ext.
    assert_eq!(d["budget"].as_array().unwrap().len(), 1);
    assert_eq!(d["budget"][0]["ext"]["currency"], json!("USD"));
    assert_eq!(
        d["budget_ext"]["non_plant_lines"].as_array().unwrap().len(),
        1
    );
    // Groups normalised on decode: lone dropped, duplicate + dangling stripped.
    assert_eq!(d["groups"].as_array().unwrap().len(), 1);
    assert_eq!(d["groups"][0]["id"], json!("g-ok"));
    assert_eq!(d["groups"][0]["members"].as_array().unwrap().len(), 2);

    // Re-encoding succeeds and is canonically byte-identical on repeat (2.1-M156).
    let enc1 = encode_design(d).expect("migrated v10 design passes write admission");
    let enc2 = encode_design(d).expect("canonical encode is deterministic");
    assert_eq!(enc1, enc2);

    // Frozen-reader oracle parity (2.1-M527, reader=v2.0.5): read_newer_design opens it read-only.
    let parsed: Value = serde_json::from_slice(&enc1).unwrap();
    let ro =
        read_newer_design(&parsed).expect("v2.0.5 frozen reader must open migrated v10 output");
    assert_eq!(ro.saved_by_version, 10);
    assert_eq!(ro.view.plants.len(), 2);
}

#[test]
fn version_admission_refuses_older_and_newer_and_planted_failing_step_reports_from() {
    assert_eq!(CANOPI_FLOOR, 9);
    assert_eq!(CANOPI_CURRENT, 10);
    assert_eq!(release_label(9), Some("2.0"));
    assert_eq!(release_label(10), Some("2.1"));
    assert_eq!(
        admit_canopi_version(Some(11)),
        Admission::RefusedNewer {
            version: 11,
            max_supported: 10
        }
    );

    let older = decode_design(br#"{"version": 8}"#).unwrap_err();
    assert_eq!(older.kind, DesignLoadFailureKind::OlderVersion);

    // From 2.1.0, newer versions are refused unchanged (2.1-Q347).
    let newer = decode_design(br#"{"version": 11, "name": "Future"}"#).unwrap_err();
    assert_eq!(newer.kind, DesignLoadFailureKind::NewerVersion);

    let bad_json = decode_design(b"{\"version\": 10,").unwrap_err();
    assert_eq!(bad_json.kind, DesignLoadFailureKind::InvalidJson);

    // Planted failing step (contracts §10).
    let planted = &[CanopiStep {
        from: 9,
        run: |_| {
            Err(StepFailure {
                from: 9,
                reason: "planted step failure".to_owned(),
            })
        },
    }];
    let err = run_steps_with(planted, 9, json!({"version": 9}), 9).unwrap_err();
    assert_eq!(err.from, 9);

    // Pre-upgrade copy naming and CopyBlocked metadata (2.1-Q35r).
    assert_eq!(
        pre_upgrade_copy_name("Garden", 9, 0).as_deref(),
        Some("Garden (Canopi 2.0).canopi")
    );
    assert_eq!(
        pre_upgrade_copy_name("Garden", 9, 1).as_deref(),
        Some("Garden (Canopi 2.0) (2).canopi")
    );
    assert_eq!(
        mark_copy_blocked(9, "Designs"),
        PreUpgradeCopyDecision::CopyBlocked {
            folder: "Designs".to_owned(),
            from_version: 9,
            release_label: "2.0".to_owned(),
        }
    );
}

#[test]
fn write_admission_refuses_dangling_groups_duplicate_site_data_and_missing_print_split() {
    let mut base = v10_full_fixture();
    assert!(encode_design(&base).is_ok());

    // Duplicate site_data id refused on write.
    base["site_data"]["entries"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "id": "lyr-terrain", "name": "Dup", "order": 1 }));
    let err = encode_design(&base).unwrap_err();
    assert_eq!(err.kind, DesignLoadFailureKind::InvalidDocument);
    assert_eq!(
        err.field_path.as_ref().map(|p| p.to_string()).as_deref(),
        Some("$.site_data.entries[1].id")
    );

    // Dangling group member refused on write.
    let mut bad_group = v10_full_fixture();
    bad_group["groups"][0]["members"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "kind": "zone", "id": "no-such-zone" }));
    let err = encode_design(&bad_group).unwrap_err();
    assert_eq!(err.kind, DesignLoadFailureKind::InvalidDocument);

    // Missing print_setup split refused on write.
    let mut bad_split = v10_full_fixture();
    bad_split["print_setup"]["pages"][1]["area"]["split"] = json!("missing-split");
    let err = encode_design(&bad_split).unwrap_err();
    assert_eq!(
        err.field_path.as_ref().map(|p| p.to_string()).as_deref(),
        Some("$.print_setup.pages[1].area.split")
    );

    // Zone opacity out of [0, 1] refused.
    let mut bad_opacity = v10_full_fixture();
    bad_opacity["zones"][0]["opacity"] = json!(1.5);
    let err = encode_design(&bad_opacity).unwrap_err();
    assert_eq!(
        err.field_path.as_ref().map(|p| p.to_string()).as_deref(),
        Some("$.zones[0].opacity")
    );
}

#[test]
fn new_design_and_draft_summary_and_size_cap_behave_as_specified() {
    let created = new_design(&NewDesignInput {
        name: String::new(),
        plant_display: Some(json!({ "color_by": "species", "labels": "common" })),
        created_at: "2026-11-25T05:00:00Z".to_owned(),
    });
    let bytes = encode_design(&created).expect("new_design must pass write admission");
    let summary = draft_summary(&bytes, "2026-11-25T05:01:00Z");
    assert!(summary.readable);
    assert_eq!(summary.name, "");
    assert_eq!(summary.refusal_kind, None);

    let unreadable = draft_summary(b"{not-json", "2026-11-25T05:01:00Z");
    assert!(!unreadable.readable);
    assert_eq!(
        unreadable.refusal_kind,
        Some(DesignLoadFailureKind::InvalidJson)
    );

    // Oversized file refused as too_large.
    let huge = vec![b' '; (MAX_CANOPI_FILE_BYTES as usize) + 1];
    let err = decode_design(&huge).unwrap_err();
    assert_eq!(err.kind, DesignLoadFailureKind::TooLarge);
    assert!(!FORMAT_CORE_VERSION.is_empty());
}

#[test]
fn migration_steps_frozen_pins_v9_to_v10_output_fingerprint() {
    let migrated = migrate_v9_to_v10(sample_v9_design()).expect("v9 step succeeds");
    let fp1 = canonical_fingerprint(&migrated);
    let fp2 = canonical_fingerprint(&migrate_v9_to_v10(sample_v9_design()).unwrap());
    assert_eq!(fp1, fp2);
    assert_ne!(fp1, 0);
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
}

fn sample_stamp_v3() -> SavedObjectStampPayloadV3 {
    let mut colors = BTreeMap::new();
    colors.insert("Malus domestica".to_owned(), "#5E8B7E".to_owned());
    let mut symbols = BTreeMap::new();
    symbols.insert("Malus domestica".to_owned(), "apple".to_owned());
    let mut codes = BTreeMap::new();
    codes.insert("Malus domestica".to_owned(), "MD".to_owned());

    SavedObjectStampPayloadV3 {
        version: 3,
        anchor: StampPoint { x: 0.0, y: 0.0 },
        plants: vec![StampPlantV3 {
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
        }],
        zones: vec![StampZoneV3 {
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
        }],
        annotations: vec![StampAnnotationV3 {
            id: "a1".to_owned(),
            locked: true,
            annotation_type: "text".to_owned(),
            position: StampPoint { x: 1.0, y: 1.0 },
            text: "Guild".to_owned(),
            font_size: 14.0,
            rotation_deg: Some(0.0),
        }],
        measurement_guides: vec![StampGuideV3 {
            id: "g1".to_owned(),
            locked: true,
            start: StampPoint { x: 0.0, y: 0.0 },
            end: StampPoint { x: 4.0, y: 0.0 },
        }],
        groups: vec![StampGroupV3 {
            id: "grp-1".to_owned(),
            locked: false,
            name: Some("All".to_owned()),
            members: vec![
                StampGroupMemberV3::Plant {
                    id: "p1".to_owned(),
                },
                StampGroupMemberV3::MeasurementGuide {
                    id: "g1".to_owned(),
                },
            ],
        }],
        plant_species_colors: colors,
        plant_species_symbols: symbols,
        plant_species_codes: codes,
        consortiums: vec![StampConsortiumV3 {
            canonical_name: "Malus domestica".to_owned(),
            stratum: "high".to_owned(),
            start_phase: 1,
            end_phase: 3,
        }],
        budget: vec![StampBudgetLineV3 {
            canonical_name: "Malus domestica".to_owned(),
            unit_cost: 29.0,
        }],
        timeline: vec![StampCareActionV3 {
            id: "care-1".to_owned(),
            action_type: "pruning".to_owned(),
            description: "Winter prune".to_owned(),
            offset_days: Some(90),
            recurrence: None,
            targets: vec![json!({ "kind": "placed_plant", "plant_id": "p1" })],
        }],
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
fn emitted_spec_v10_files_match_checked_in_spec_and_pass_frozen_reader_oracle() {
    let spec_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("spec/v10");
    for file in emit_v10_spec_files() {
        let path = spec_dir.join(file.relative_path);
        let on_disk = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("missing spec/v10/{}: {e}", file.relative_path));
        assert_eq!(
            on_disk, file.content,
            "spec/v10/{} is stale — regenerate via spec emitter",
            file.relative_path
        );
    }

    // Frozen-reader oracle (2.1-M527): v2.0.5 read_newer_design opens spec/v10/fixture.canopi.
    let fixture = v10_full_fixture();
    let ro = read_newer_design(&fixture).expect("v2.0.5 reader opens spec/v10/fixture.canopi");
    assert_eq!(ro.saved_by_version, 10);
    assert_eq!(ro.view.plants.len(), 2);
}
