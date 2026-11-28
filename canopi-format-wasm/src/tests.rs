//! Native vs `canopi-format-wasm` wrapper-parity conformance suite (contracts §10; 2.1-M539).
//!
//! Asserts that every wasm wrapper export returns the exact same structured outcome (`kind`,
//! `field_path`, or canonical output) as `canopi-format`'s native entry points. (The real
//! browser worker run lives with the TS DesignCore switch.)

use canopi_format::core::{
    FORMAT_CORE_VERSION, decode_design as native_decode, encode_design as native_encode,
};
use canopi_format::stamps::decode_stamp_payload as native_decode_stamp;
use serde_json::{Value, json};

use crate::{
    decode_design as wasm_decode, decode_stamp_payload as wasm_decode_stamp,
    draft_summary as wasm_draft_summary, encode_design as wasm_encode, format_core_version,
    new_design as wasm_new_design,
};

#[test]
fn wrapper_reports_crate_version() {
    assert_eq!(format_core_version(), FORMAT_CORE_VERSION);
}

struct ParityCase {
    id: &'static str,
    input: Value,
    expected_err: Option<(&'static str, Option<&'static str>)>,
}

fn parity_decode_cases() -> Vec<ParityCase> {
    vec![
        ParityCase {
            id: "v10-minimal-accepted",
            input: json!({
                "version": 10,
                "name": "Parity",
                "plant_species_colors": {},
                "layers": [],
                "plants": [],
                "zones": [],
                "annotations": [],
                "measurement_guides": [],
                "consortiums": [],
                "groups": [],
                "timeline": [],
                "budget": [],
                "budget_currency": "EUR",
                "views": [],
                "stories": [],
                "created_at": "",
                "updated_at": ""
            }),
            expected_err: None,
        },
        ParityCase {
            id: "v9-migrated-accepted",
            input: json!({
                "version": 9,
                "name": "Migrated",
                "plant_species_colors": {},
                "layers": [],
                "plants": [{ "id": "p1", "canonical_name": "Malus domestica", "position": { "lon": 2.0, "lat": 48.0 }, "scale": 3.5 }],
                "zones": [],
                "annotations": [],
                "consortiums": [],
                "groups": [],
                "timeline": [],
                "budget": [],
                "created_at": "",
                "updated_at": ""
            }),
            expected_err: None,
        },
        ParityCase {
            id: "v8-refused-older",
            input: json!({ "version": 8 }),
            expected_err: Some(("older_version", Some("$.version"))),
        },
        ParityCase {
            id: "v11-refused-newer",
            input: json!({ "version": 11 }),
            expected_err: Some(("newer_version", Some("$.version"))),
        },
        ParityCase {
            id: "v9-non-object-budget-refused",
            input: json!({
                "version": 9,
                "name": "BadBudget",
                "plant_species_colors": {},
                "layers": [],
                "plants": [],
                "zones": [],
                "annotations": [],
                "consortiums": [],
                "groups": [],
                "timeline": [],
                "budget": ["bad"],
                "created_at": "",
                "updated_at": ""
            }),
            expected_err: Some(("invalid_document", Some("$.budget[0]"))),
        },
        ParityCase {
            id: "v10-bad-zone-opacity-refused",
            input: json!({
                "version": 10,
                "name": "BadZone",
                "zones": [{ "id": "z1", "zone_type": "polygon", "points": [{ "lon": 2.0, "lat": 48.0 }], "opacity": 2.0 }]
            }),
            expected_err: Some(("invalid_document", Some("$.zones[0].opacity"))),
        },
    ]
}

#[test]
fn wrapper_parity_decode_corpus_matches_expected_kinds_and_paths() {
    for ParityCase {
        id,
        input,
        expected_err,
    } in parity_decode_cases()
    {
        let text = serde_json::to_string(&input).unwrap();
        let native = native_decode(text.as_bytes());
        let wrapped: Value = serde_json::from_str(&wasm_decode(&text)).unwrap();

        match (expected_err, native) {
            (None, Ok(opened)) => {
                assert_eq!(
                    wrapped["ok"],
                    serde_json::to_value(&opened).unwrap(),
                    "case {id}"
                );
            }
            (Some((exp_kind, exp_path)), Err(refusal)) => {
                assert_eq!(wrapped["err"]["kind"], exp_kind, "case {id}");
                assert_eq!(wrapped["err"]["field_path"].as_str(), exp_path, "case {id}");
                assert_eq!(
                    wrapped["err"],
                    serde_json::to_value(&refusal).unwrap(),
                    "case {id}"
                );
            }
            (exp, act) => panic!("case {id} mismatch: expected {exp:?}, got {act:?}"),
        }
    }
}

#[test]
fn wrapper_parity_encode_and_stamps() {
    let created: Value = serde_json::from_str(&wasm_new_design(
        r#"{"name":"Fresh","created_at":"2026-11-25T00:00:00Z"}"#,
    ))
    .unwrap();
    let native_bytes = native_encode(&created).expect("native encode succeeds");
    let wrapped: Value = serde_json::from_str(&wasm_encode(&created.to_string())).unwrap();
    assert_eq!(
        wrapped["ok"].as_str().unwrap(),
        std::str::from_utf8(&native_bytes).unwrap()
    );

    let summary: Value = serde_json::from_str(&wasm_draft_summary(
        r#"{"version":11}"#,
        "2026-11-25T00:00:00Z",
    ))
    .unwrap();
    assert_eq!(summary["readable"], false);
    assert_eq!(summary["refusal_kind"]["kind"], "newer_version");

    let stamp_v2 = r#"{"version":2,"anchor":{"x":0,"y":0},"plants":[],"zones":[],"annotations":[],"groups":[]}"#;
    let native_stamp = native_decode_stamp(stamp_v2.as_bytes()).expect("native v2 stamp");
    let wrapped_stamp: Value = serde_json::from_str(&wasm_decode_stamp(stamp_v2)).unwrap();
    assert_eq!(
        wrapped_stamp["ok"],
        serde_json::to_value(&native_stamp).unwrap()
    );
}
