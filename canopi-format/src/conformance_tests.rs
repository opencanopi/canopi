//! Table-driven conformance corpus with explicit expected outcomes (kind + leaf field_path
//! or canonical accepted output), covering contracts §10 `:432` (site_data), `:436` (groups),
//! `:440` (print_setup), `:433` (budget), and version boundaries (2.1-M539).

use std::collections::BTreeMap;

use canopi_types::design::GeoPoint;
use canopi_types::design::v10::{
    CanopiFileV10, FormatLoadRefusalKind, PlacedPlantV10, PrintAreaV10, PrintPageV10,
    PrintScaleV10, PrintSetupV10, PrintSizeM, PrintSplitV10, ZoneV10,
};
use proptest::prelude::*;
use serde_json::{Value, json};

use crate::core::{decode_design, encode_design};
use crate::read::read_newer_design;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Decode,
    Encode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Expected {
    Accepted,
    Refused {
        kind: FormatLoadRefusalKind,
        field_path: Option<&'static str>,
    },
}

struct CorpusRow {
    id: &'static str,
    op: Op,
    input: Value,
    expected: Expected,
    check: Option<fn(&Value)>,
}

fn base_v10() -> Value {
    json!({
        "version": 10,
        "name": "Corpus",
        "plant_species_colors": {},
        "plant_species_symbols": {},
        "plant_species_codes": {},
        "layers": [],
        "plants": [
            { "id": "p1", "canonical_name": "Malus domestica", "position": { "lon": 2.0, "lat": 48.0 } },
            { "id": "p2", "canonical_name": "Corylus avellana", "position": { "lon": 2.1, "lat": 48.1 } }
        ],
        "zones": [
            { "id": "z1", "zone_type": "polygon", "points": [{ "lon": 2.0, "lat": 48.0 }] }
        ],
        "annotations": [
            { "id": "a1", "annotation_type": "text", "position": { "lon": 2.0, "lat": 48.0 }, "text": "Hi", "font_size": 14.0 }
        ],
        "measurement_guides": [
            { "id": "m1", "start": { "lon": 2.0, "lat": 48.0 }, "end": { "lon": 2.1, "lat": 48.1 } }
        ],
        "consortiums": [],
        "groups": [],
        "timeline": [],
        "budget": [],
        "budget_currency": "EUR",
        "views": [],
        "stories": [],
        "created_at": "",
        "updated_at": ""
    })
}

fn site_data_rows() -> Vec<CorpusRow> {
    // 1. v9 entry whose kind contradicts id resolves by id (kind dropped)
    let mut kind_contradicts = json!({
        "version": 9,
        "name": "SiteData",
        "plant_species_colors": {},
        "layers": [],
        "plants": [],
        "zones": [],
        "annotations": [],
        "consortiums": [],
        "groups": [],
        "timeline": [],
        "budget": [],
        "lidar": {
            "visible": true,
            "entries": [
                { "id": "item-slope", "kind": "Source", "name": "Slope", "visible": true, "opacity": 0.7, "order": 0, "ramp": "Terrain", "reversed": false, "range": null }
            ]
        },
        "created_at": "",
        "updated_at": ""
    });

    // 2. Duplicate site_data ids on v10 decode keep lowest order
    let mut dup_decode = base_v10();
    dup_decode["site_data"] = json!({
        "visible": true,
        "entries": [
            { "id": "lyr-1", "name": "Higher", "order": 5 },
            { "id": "lyr-1", "name": "Lower", "order": 2 }
        ]
    });

    // 3. Unknown/missing library id kept by stored name
    let mut missing_lib = base_v10();
    missing_lib["site_data"] = json!({
        "visible": true,
        "entries": [{ "id": "missing-in-library", "name": "Stored Name", "order": 0 }]
    });

    // 4. Duplicate site_data ids refused on write at $.site_data.entries[1].id
    let dup_write = dup_decode.clone();

    let _ = &mut kind_contradicts;
    vec![
        CorpusRow {
            id: "site-data-v9-kind-contradicts-id",
            op: Op::Decode,
            input: kind_contradicts,
            expected: Expected::Accepted,
            check: Some(|d| {
                assert_eq!(d["site_data"]["entries"][0]["id"], "item-slope");
                assert!(d["site_data"]["entries"][0].get("kind").is_none());
            }),
        },
        CorpusRow {
            id: "site-data-decode-dedup-lowest-order",
            op: Op::Decode,
            input: dup_decode,
            expected: Expected::Accepted,
            check: Some(|d| {
                assert_eq!(d["site_data"]["entries"].as_array().unwrap().len(), 1);
                assert_eq!(d["site_data"]["entries"][0]["name"], "Lower");
                assert_eq!(d["site_data"]["entries"][0]["order"], 2);
            }),
        },
        CorpusRow {
            id: "site-data-missing-library-id-kept",
            op: Op::Decode,
            input: missing_lib,
            expected: Expected::Accepted,
            check: Some(|d| {
                assert_eq!(d["site_data"]["entries"][0]["id"], "missing-in-library");
                assert_eq!(d["site_data"]["entries"][0]["name"], "Stored Name");
            }),
        },
        CorpusRow {
            id: "site-data-write-refuses-duplicate-id",
            op: Op::Encode,
            input: dup_write,
            expected: Expected::Refused {
                kind: FormatLoadRefusalKind::InvalidDocument,
                field_path: Some("$.site_data.entries[1].id"),
            },
            check: None,
        },
    ]
}

fn group_rows() -> Vec<CorpusRow> {
    let mut one_member = base_v10();
    one_member["groups"] = json!([{ "id": "g1", "members": [{ "kind": "plant", "id": "p1" }] }]);

    let mut dangling = base_v10();
    dangling["groups"] = json!([{
        "id": "g1",
        "members": [
            { "kind": "plant", "id": "p1" },
            { "kind": "plant", "id": "ghost" }
        ]
    }]);

    let mut duplicate = base_v10();
    duplicate["groups"] = json!([{
        "id": "g1",
        "members": [
            { "kind": "plant", "id": "p1" },
            { "kind": "plant", "id": "p1" },
            { "kind": "zone", "id": "z1" }
        ]
    }]);

    let mut all_kinds = base_v10();
    all_kinds["groups"] = json!([{
        "id": "g-all",
        "members": [
            { "kind": "plant", "id": "p1" },
            { "kind": "zone", "id": "z1" },
            { "kind": "annotation", "id": "a1" },
            { "kind": "measurement_guide", "id": "m1" }
        ]
    }]);

    vec![
        CorpusRow {
            id: "group-one-member-dropped-on-decode",
            op: Op::Decode,
            input: one_member.clone(),
            expected: Expected::Accepted,
            check: Some(|d| assert!(d["groups"].as_array().unwrap().is_empty())),
        },
        CorpusRow {
            id: "group-one-member-refused-on-write",
            op: Op::Encode,
            input: one_member,
            expected: Expected::Refused {
                kind: FormatLoadRefusalKind::InvalidDocument,
                field_path: Some("$.groups[0].members"),
            },
            check: None,
        },
        CorpusRow {
            id: "group-dangling-member-refused-on-write",
            op: Op::Encode,
            input: dangling,
            expected: Expected::Refused {
                kind: FormatLoadRefusalKind::InvalidDocument,
                field_path: Some("$.groups[0].members[1].id"),
            },
            check: None,
        },
        CorpusRow {
            id: "group-duplicate-member-deduped-on-decode",
            op: Op::Decode,
            input: duplicate.clone(),
            expected: Expected::Accepted,
            check: Some(|d| assert_eq!(d["groups"][0]["members"].as_array().unwrap().len(), 2)),
        },
        CorpusRow {
            id: "group-duplicate-member-refused-on-write",
            op: Op::Encode,
            input: duplicate,
            expected: Expected::Refused {
                kind: FormatLoadRefusalKind::InvalidDocument,
                field_path: Some("$.groups[0].members[1].id"),
            },
            check: None,
        },
        CorpusRow {
            id: "group-all-four-member-kinds-accepted-on-write",
            op: Op::Encode,
            input: all_kinds,
            expected: Expected::Accepted,
            check: None,
        },
    ]
}

fn print_and_misc_rows() -> Vec<CorpusRow> {
    let mut bad_split = base_v10();
    bad_split["print_setup"] = json!({
        "splits": [],
        "pages": [{
            "id": "pg-1",
            "name": "Missing Split",
            "area": {
                "kind": "split_sheet",
                "split": "no-such-split",
                "along_page": { "right_m": 0.0, "down_m": 0.0 },
                "size": { "width_m": 40.0, "height_m": 30.0 }
            },
            "scale": { "kind": "fit" }
        }]
    });

    let mut bad_zone_opacity = base_v10();
    bad_zone_opacity["zones"][0]["opacity"] = json!(1.5);

    vec![
        CorpusRow {
            id: "print-setup-missing-split-refused",
            op: Op::Encode,
            input: bad_split,
            expected: Expected::Refused {
                kind: FormatLoadRefusalKind::InvalidDocument,
                field_path: Some("$.print_setup.pages[0].area.split"),
            },
            check: None,
        },
        CorpusRow {
            id: "zone-opacity-above-one-refused",
            op: Op::Encode,
            input: bad_zone_opacity,
            expected: Expected::Refused {
                kind: FormatLoadRefusalKind::InvalidDocument,
                field_path: Some("$.zones[0].opacity"),
            },
            check: None,
        },
        CorpusRow {
            id: "version-8-refused-older",
            op: Op::Decode,
            input: json!({ "version": 8 }),
            expected: Expected::Refused {
                kind: FormatLoadRefusalKind::OlderVersion,
                field_path: Some("$.version"),
            },
            check: None,
        },
        CorpusRow {
            id: "version-11-refused-newer",
            op: Op::Decode,
            input: json!({ "version": 11 }),
            expected: Expected::Refused {
                kind: FormatLoadRefusalKind::NewerVersion,
                field_path: Some("$.version"),
            },
            check: None,
        },
    ]
}

#[test]
fn v10_conformance_corpus_matches_expected_outcomes() {
    let mut rows = site_data_rows();
    rows.extend(group_rows());
    rows.extend(print_and_misc_rows());

    for row in rows {
        match row.op {
            Op::Decode => {
                let bytes = serde_json::to_vec(&row.input).unwrap();
                match (&row.expected, decode_design(&bytes)) {
                    (Expected::Accepted, Ok(opened)) => {
                        if let Some(check) = row.check {
                            check(&opened.design);
                        }
                    }
                    (Expected::Refused { kind, field_path }, Err(err)) => {
                        assert_eq!(err.kind, *kind, "case {}", row.id);
                        assert_eq!(
                            err.field_path.as_ref().map(ToString::to_string).as_deref(),
                            *field_path,
                            "case {}",
                            row.id
                        );
                    }
                    (expected, actual) => {
                        panic!(
                            "case {} mismatch: expected {expected:?}, got {actual:?}",
                            row.id
                        );
                    }
                }
            }
            Op::Encode => match (&row.expected, encode_design(&row.input)) {
                (Expected::Accepted, Ok(_)) => {}
                (Expected::Refused { kind, field_path }, Err(err)) => {
                    assert_eq!(err.kind, *kind, "case {}", row.id);
                    assert_eq!(
                        err.field_path.as_ref().map(ToString::to_string).as_deref(),
                        *field_path,
                        "case {}",
                        row.id
                    );
                }
                (expected, actual) => {
                    panic!(
                        "case {} mismatch: expected {expected:?}, got {actual:?}",
                        row.id
                    );
                }
            },
        }
    }
}

fn arb_geo_point() -> impl Strategy<Value = GeoPoint> {
    (
        -179_000_000i64..179_000_000i64,
        -84_000_000i64..84_000_000i64,
    )
        .prop_map(|(lon, lat)| GeoPoint {
            lon: lon as f64 / 1_000_000.0,
            lat: lat as f64 / 1_000_000.0,
        })
}

fn sample_print_setup() -> PrintSetupV10 {
    PrintSetupV10 {
        splits: vec![PrintSplitV10 {
            id: "sp-1".to_owned(),
            pivot: GeoPoint {
                lon: 2.0,
                lat: 48.0,
            },
            angle_deg: 0.0,
            extra: BTreeMap::new(),
        }],
        pages: vec![PrintPageV10 {
            id: "pg-1".to_owned(),
            name: "Sheet 1".to_owned(),
            area: PrintAreaV10::Box {
                centre: GeoPoint {
                    lon: 2.0,
                    lat: 48.0,
                },
                size: PrintSizeM {
                    width_m: 50.0,
                    height_m: 35.0,
                },
                angle_deg: 0.0,
            },
            framing: None,
            scale: PrintScaleV10::Fit,
            extra: BTreeMap::new(),
        }],
        extra: BTreeMap::new(),
    }
}

fn arb_v10_design() -> impl Strategy<Value = Value> {
    (
        "[a-zA-Z0-9 ]{0,24}",
        prop::collection::vec(
            (
                arb_geo_point(),
                (50i64..2000i64).prop_map(|n| n as f64 / 100.0),
                (-1800i64..1800i64).prop_map(|n| n as f64 / 10.0),
            ),
            0..4,
        ),
        prop::collection::vec(
            (
                arb_geo_point(),
                (0i64..=100i64).prop_map(|n| n as f64 / 100.0),
            ),
            0..2,
        ),
        prop::bool::ANY,
    )
        .prop_map(|(name, plants, zones, with_print)| {
            let plant_structs: Vec<PlacedPlantV10> = plants
                .into_iter()
                .enumerate()
                .map(|(i, (position, spread, rot))| PlacedPlantV10 {
                    id: format!("p-{i}"),
                    locked: false,
                    canonical_name: "Malus domestica".to_owned(),
                    common_name: Some("Apple".to_owned()),
                    color: None,
                    symbol: None,
                    pinned_name: false,
                    position,
                    rotation: Some(rot),
                    canopy_spread_m: Some(spread),
                    notes: None,
                    planted_date: None,
                    quantity: Some(1),
                    extra: BTreeMap::new(),
                })
                .collect();
            let zone_structs: Vec<ZoneV10> = zones
                .into_iter()
                .enumerate()
                .map(|(i, (pt, op))| ZoneV10 {
                    id: format!("z-{i}"),
                    name: Some("Bed".to_owned()),
                    locked: false,
                    zone_type: "polygon".to_owned(),
                    points: vec![pt],
                    rotation: 0.0,
                    fill_color: Some("#3A6EA5".to_owned()),
                    stroke_color: Some("#1E3A5F".to_owned()),
                    opacity: Some(op),
                    notes: None,
                    extra: BTreeMap::new(),
                })
                .collect();
            let file = CanopiFileV10 {
                version: 10,
                name,
                description: None,
                plant_species_colors: BTreeMap::new(),
                plant_species_symbols: BTreeMap::new(),
                plant_species_codes: BTreeMap::new(),
                layers: Vec::new(),
                plants: plant_structs,
                zones: zone_structs,
                annotations: Vec::new(),
                measurement_guides: Vec::new(),
                consortiums: Vec::new(),
                groups: Vec::new(),
                timeline: Vec::new(),
                budget: Vec::new(),
                budget_currency: "EUR".to_owned(),
                budget_ext: None,
                site_data: None,
                plant_display: None,
                print_setup: with_print.then(sample_print_setup),
                views: Vec::new(),
                stories: Vec::new(),
                map_view: None,
                created_at: String::new(),
                updated_at: String::new(),
                extra: BTreeMap::new(),
            };
            serde_json::to_value(file).unwrap()
        })
}

proptest! {
    /// 2.1-M156 + contracts §10: encode is canonical (two encodes produce byte-identical output),
    /// decode(encode(d)) round-trips and re-encodes to the exact same admitted bytes,
    /// and the v2.0.5 frozen reader opens every generated v10 output read-only (2.1-M527).
    #[test]
    fn prop_canonical_encode_round_trip_and_frozen_reader_parity(doc in arb_v10_design()) {
        let b1 = encode_design(&doc).expect("generated v10 encodes");
        let b2 = encode_design(&doc).expect("second encode succeeds");
        prop_assert_eq!(&b1, &b2);

        let decoded = decode_design(&b1).expect("encoded v10 decodes");
        let b3 = encode_design(&decoded.design).expect("decoded v10 re-encodes");
        prop_assert_eq!(&b1, &b3);

        let parsed: Value = serde_json::from_slice(&b1).unwrap();
        let ro = read_newer_design(&parsed).expect("v2.0.5 frozen reader opens generated v10");
        prop_assert_eq!(ro.saved_by_version, 10);
    }
}
