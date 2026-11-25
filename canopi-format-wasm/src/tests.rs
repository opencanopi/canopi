use super::{
    decode_design, decode_stamp_payload, draft_summary, encode_design, encode_stamp_payload,
    format_core_version, new_design, read_newer_design,
};
use canopi_format::core::{
    FORMAT_CORE_VERSION, decode_design as native_decode, draft_summary as native_draft_summary,
    encode_design as native_encode,
};
use canopi_format::spec_emit::v10_full_fixture;
use canopi_format::stamps::decode_stamp_payload as native_decode_stamp;
use serde_json::{Value, json};

fn answer(text: &str) -> Value {
    serde_json::from_str(&read_newer_design(text)).unwrap_or_default()
}

#[test]
fn canopi_f47t_52_270_the_frozen_v10_fixture_reads_into_the_view_desktop_shows() {
    let fixture = include_str!("../../canopi-format/spec/v10/read-fixture.canopi");
    let value: Value = serde_json::from_str(fixture).unwrap_or_default();
    let native = canopi_format::read::read_newer_design(&value).map(|design| json!(design));
    let read = answer(fixture);
    assert_eq!(read.get("read"), native.as_ref().ok());
    assert_eq!(read["read"]["saved_by_version"], json!(10));
}

#[test]
fn canopi_f47t_52_270_a_refused_newer_design_names_its_field_and_kind() {
    let read = answer(r#"{"version": 11, "name": "Later", "plants": [{"id": "p1"}]}"#);
    assert_eq!(read["refused"]["kind"], json!("newer_version"));
    assert_eq!(
        read["refused"]["field_path"],
        json!("$.plants[0].canonical_name")
    );
    let damaged = answer(r#"{"version": 10, "name": "Ten", "plants": [{"id": "p1"}]}"#);
    assert_eq!(damaged["refused"]["kind"], json!("invalid_document"));
}

#[test]
fn canopi_f47t_52_270_text_that_is_no_json_is_refused_as_invalid_json() {
    let read = answer("{\"version\": 10,");
    assert_eq!(read["refused"]["kind"], json!("invalid_json"));
    assert_eq!(read["refused"]["field_path"], json!("$"));
}

#[test]
fn format_core_version_matches_canopi_format_crate_version() {
    assert_eq!(format_core_version(), FORMAT_CORE_VERSION);
}

#[test]
fn native_and_wasm_decode_encode_and_draft_summary_match_across_conformance_corpus() {
    let corpus: &[&str] = &[
        include_str!("../../canopi-format/spec/v10/read-fixture.canopi"),
        r#"{"version": 9, "name": "V9", "plants": [{"id":"p1","canonical_name":"Malus domestica","position":{"lon":2.29,"lat":48.85},"scale":3.0}], "lidar": {"visible": true, "entries": [{"id":"lyr-1","kind":"Source","name":"DEM","order":0}]}}"#,
        r#"{"version": 8, "name": "Pre2"}"#,
        r#"{"version": 11, "name": "Future"}"#,
        r#"{"version": 10, "plants": [{"id":"p1","canonical_name":"Malus domestica","position":{"lon":2.29,"lat":89.0}}]}"#,
        r#"{"version": 10,"#,
    ];

    for raw in corpus {
        let wasm_dec: Value = serde_json::from_str(&decode_design(raw)).unwrap();
        match native_decode(raw.as_bytes()) {
            Ok(native_ok) => {
                assert_eq!(wasm_dec["ok"], json!(native_ok));
            }
            Err(native_err) => {
                assert_eq!(wasm_dec["err"], json!(native_err));
            }
        }

        let wasm_sum: Value =
            serde_json::from_str(&draft_summary(raw, "2026-11-25T05:00:00Z")).unwrap();
        let native_sum = native_draft_summary(raw.as_bytes(), "2026-11-25T05:00:00Z");
        assert_eq!(wasm_sum, json!(native_sum));
    }

    // Full v10 fixture canonical encode parity between native and wasm.
    let fixture = v10_full_fixture();
    let fixture_text = serde_json::to_string(&fixture).unwrap();
    let wasm_enc: Value = serde_json::from_str(&encode_design(&fixture_text)).unwrap();
    let native_bytes = native_encode(&fixture).expect("native encode succeeds");
    assert_eq!(
        wasm_enc["ok"].as_str().unwrap().as_bytes(),
        native_bytes.as_slice()
    );

    // new_design produces a v10 Design admitted by encode_design.
    let created = new_design(r#"{"name":"Test","created_at":"2026-11-25T05:00:00Z"}"#);
    let enc_created: Value = serde_json::from_str(&encode_design(&created)).unwrap();
    assert!(enc_created.get("ok").is_some());
}

#[test]
fn native_and_wasm_stamp_payload_v2_to_v3_and_encode_match() {
    let v2 = r#"{"version":2,"anchor":{"x":0,"y":0},"plants":[{"id":"p1","canonicalName":"Malus domestica","commonName":null,"color":null,"position":{"x":1,"y":2},"rotationDeg":null,"scale":3.5}],"zones":[],"annotations":[],"groups":[]}"#;
    let wasm_dec: Value = serde_json::from_str(&decode_stamp_payload(v2)).unwrap();
    let native_dec = native_decode_stamp(v2.as_bytes()).expect("native v2->v3");
    assert_eq!(wasm_dec["ok"], json!(native_dec));

    let v3_text = serde_json::to_string(&native_dec).unwrap();
    let wasm_enc: Value = serde_json::from_str(&encode_stamp_payload(&v3_text)).unwrap();
    assert!(wasm_enc.get("ok").is_some());

    let newer: Value = serde_json::from_str(&decode_stamp_payload(r#"{"version":4}"#)).unwrap();
    assert_eq!(newer["err"]["kind"], json!("needs_newer"));
}
