use super::read_newer_design;
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
