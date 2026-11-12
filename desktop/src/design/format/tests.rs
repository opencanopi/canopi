//! Reading a `.canopi` file: version admission, refusals and the read-only open of a
//! newer Design. Saving, exporting and round trips are `format::write_tests`.

use super::write_tests::map_view_value;
use super::*;
use crate::test_scratch::TestScratch;

pub(super) fn create_default() -> CanopiFile {
    create_new_design("Untitled", "2026-07-02T00:00:00Z")
}

/// canopi-cyqd: the shared corpus decodes natively as on the Web: each accepted case to
/// its document (and back), and each refusal with its kind and the typed field path the
/// Web names (`error_path`), with no native exception (`native_error_path`) left.
#[test]
fn canopi_cyqd_every_corpus_refusal_names_its_field_path() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../canopi-types/canopi-design-conformance.json"
    ))
    .expect("shared Canopi conformance corpus should be valid JSON");
    assert_eq!(corpus["contract_version"], serde_json::json!(1));
    let kinds = CanopiDesignIngestionErrorKind::ALL
        .iter()
        .map(|kind| kind.as_str());
    assert_eq!(
        corpus["facts"],
        serde_json::json!({
            "current_version": CURRENT_CANOPI_FILE_VERSION,
            "missing_version": MISSING_CANOPI_FILE_VERSION,
            "future_version_policy": canopi_types::design::FUTURE_CANOPI_FILE_VERSION_POLICY,
            "error_kinds": kinds.collect::<Vec<_>>(),
        }),
    );
    let mut wrong = Vec::new();
    for case in corpus["cases"].as_array().expect("conformance cases") {
        let id = case["id"].as_str().expect("case id should be a string");
        assert!(case.get("native_error_path").is_none(), "{id}");
        if let Some(expected_name) = case.get("accepted").and_then(|value| value.as_str()) {
            let expected = &corpus["accepted_documents"][expected_name];
            let file = decode_design_value(case["input"].clone())
                .unwrap_or_else(|error| panic!("{id}: ingestion failed: {error}"));
            assert_eq!(&conformance_document_value(&file), expected, "{id}");
            let wire = serde_json::to_value(file).expect("an accepted Design serializes");
            let round_tripped = decode_design_value(wire)
                .unwrap_or_else(|error| panic!("{id}: round trip failed: {error}"));
            let round_tripped = conformance_document_value(&round_tripped);
            assert_eq!(&round_tripped, expected, "{id}: round trip");
            continue;
        }
        let expected_path = case["error_path"]
            .as_str()
            .expect("a refusal names its path");
        match decode_design_value(case["input"].clone()) {
            Ok(_) => wrong.push(format!("{id}: accepted")),
            Err(error) => {
                let (kind, path) = (error.kind.as_str(), error.refusal.field_path.to_string());
                if (kind, path.as_str())
                    != (case["error_kind"].as_str().unwrap_or(""), expected_path)
                {
                    wrong.push(format!("{id}: {error}, not {expected_path}"));
                }
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

fn conformance_document_value(file: &CanopiFile) -> serde_json::Value {
    let mut wire = serde_json::to_value(file).expect("normalized Design should serialize");
    let object = wire
        .as_object_mut()
        .expect("normalized Design should serialize as an object");
    let known = canopi_types::design::DESIGN_FILE_FIELDS
        .iter()
        .map(|field| field.key)
        .filter(|key| *key != "extra")
        .collect::<std::collections::HashSet<_>>();
    let mut extra = serde_json::Map::new();
    for key in object
        .keys()
        .filter(|key| !known.contains(key.as_str()))
        .cloned()
        .collect::<Vec<_>>()
    {
        let value = object.remove(&key).expect("collected key should exist");
        extra.insert(key, value);
    }
    object.insert("extra".to_owned(), serde_json::Value::Object(extra));
    wire
}

pub(super) fn unique_dir(label: &str) -> TestScratch {
    TestScratch::new(&format!("format-{label}"))
}

#[test]
fn a_root_extra_key_is_refused_not_flattened() {
    let mut value = serde_json::to_value(create_default()).expect("serialize");
    value["extra"] = serde_json::json!({ "future_field": true });

    let error = decode_design_value(value).expect_err("root extra must be refused");

    assert_eq!(error.kind, CanopiDesignIngestionErrorKind::InvalidDocument);
    assert!(error.refusal.to_string().starts_with("$.extra:"), "{error}");
}

/// Canopi 2.0 breaks stored data (ADR 0021): the 2.0 previews' formats
/// (v7, v8) are refused as older, with the message naming the one
/// version this build opens, and nothing is upgraded in memory.
#[test]
fn designs_written_before_2_0_are_refused_as_older() {
    for version in [
        CURRENT_CANOPI_FILE_VERSION - 2,
        CURRENT_CANOPI_FILE_VERSION - 1,
    ] {
        let mut value = serde_json::to_value(create_default()).expect("serialize");
        value["version"] = serde_json::json!(version);

        let error = decode_design_value(value).expect_err("an earlier format is refused");

        assert_eq!(
            error.kind,
            CanopiDesignIngestionErrorKind::UnsupportedVersion
        );
        assert!(error.is_older_than_supported(), "v{version}");
        assert_eq!(
            error.refusal.to_string(),
            format!(
                "$.version: unsupported Canopi Design version {version}; Canopi 2.0 and later open only version {CURRENT_CANOPI_FILE_VERSION}"
            ),
        );
    }
}

#[test]
fn a_newer_version_is_refused_and_told_apart_from_an_older_one() {
    let mut value = serde_json::to_value(create_default()).expect("serialize");
    value["version"] = serde_json::json!(CURRENT_CANOPI_FILE_VERSION + 1);

    let error = decode_design_value(value).expect_err("newer Designs are refused");

    assert_eq!(
        error.kind,
        CanopiDesignIngestionErrorKind::UnsupportedVersion
    );
    assert!(!error.is_older_than_supported());
}

/// A Canopi 1.2 file (format v6, local metres under a `spatial_frame`) is
/// below the floor: it is refused as an older version, never as damaged,
/// and nothing about it is read past its version.
#[test]
fn a_canopi_1_2_design_is_refused_as_an_older_version() {
    let dir = unique_dir("older_version");
    let path = dir.join("canopi-1.2.canopi");
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&serde_json::json!({
            "version": 6,
            "spatial_frame": {
                "anchor_longitude_deg": 2.3522,
                "anchor_latitude_deg": 48.8566,
                "north_bearing_deg": 0.0,
                "placement_status": "confirmed"
            },
            "name": "Canopi 1.2 garden",
            "plant_species_colors": {},
            "layers": [],
            "plants": [{
                "id": "plant-1",
                "canonical_name": "Malus domestica",
                "position": { "x": 10.0, "y": -10.0 }
            }],
            "zones": [],
            "created_at": "2026-07-15T00:00:00.000Z",
            "updated_at": "2026-07-15T00:00:00.000Z"
        }))
        .unwrap(),
    )
    .unwrap();

    let error = load_from_file(&path).expect_err("a v6 Design is below the floor");
    let failure = error.failure();
    assert_eq!(failure.kind, DesignLoadFailureKind::OlderVersion);
    assert!(
        failure
            .message
            .contains("unsupported Canopi Design version 6"),
        "{}",
        failure.message
    );
    assert!(
        !failure.message.contains("canopi-1.2"),
        "no paths: {}",
        failure.message
    );
    assert!(load_with_fingerprint(&path).is_err());
}

/// Open the user's own Designs: every `.canopi` in
/// `CANOPI_REAL_DESIGNS_DIR` either opens at the current version or is
/// refused as older (ADR 0021). Run with `--ignored`; the files are
/// private and never enter the repository.
#[test]
#[ignore = "local fixture: the user's Designs in CANOPI_REAL_DESIGNS_DIR"]
fn real_designs_open_or_are_refused_as_older() {
    let Ok(dir) = std::env::var("CANOPI_REAL_DESIGNS_DIR") else {
        panic!("set CANOPI_REAL_DESIGNS_DIR");
    };
    let mut checked = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("canopi") {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        match load_from_file(&path) {
            Ok(file) => {
                assert_eq!(file.version, CURRENT_CANOPI_FILE_VERSION, "{name}");
                eprintln!(
                    "{name}: opens with {} plants, {} zones",
                    file.plants.len(),
                    file.zones.len()
                );
            }
            Err(error) => {
                assert_eq!(
                    error.failure().kind,
                    DesignLoadFailureKind::OlderVersion,
                    "{name}: {error}"
                );
                eprintln!("{name}: refused as older");
            }
        }
        checked += 1;
    }
    assert!(checked > 0, "no Designs found in {dir}");
}

#[test]
fn load_failures_name_a_kind_and_never_the_path() {
    let dir = unique_dir("failures");
    let missing = dir.join("missing.canopi");
    let error = load_from_file(&missing).expect_err("missing file");
    assert_eq!(error.failure().kind, DesignLoadFailureKind::Missing);
    assert!(!error.to_string().contains("missing.canopi"), "{error}");

    let garbage = dir.join("garbage.canopi");
    std::fs::write(&garbage, "not json").unwrap();
    let failure = load_from_file(&garbage).unwrap_err().failure();
    assert_eq!(failure.kind, DesignLoadFailureKind::InvalidJson);
    assert_eq!(
        failure.field_path, None,
        "only a refused Design names a field"
    );

    let invalid = dir.join("invalid.canopi");
    std::fs::write(&invalid, r#"{"version": 9, "plants": 3}"#).unwrap();
    assert_eq!(
        load_from_file(&invalid).unwrap_err().failure().kind,
        DesignLoadFailureKind::InvalidDocument
    );

    let old = dir.join("old.canopi");
    std::fs::write(&old, r#"{"version": 4, "name": "Canopi 1.1"}"#).unwrap();
    let error = load_from_file(&old).unwrap_err();
    assert_eq!(error.failure().kind, DesignLoadFailureKind::OlderVersion);
    assert!(!error.failure().message.contains("old.canopi"));

    // canopi-f47t.52.270: a stamp import's read refuses even a newer Design the view reads.
    let newer = dir.join("newer.canopi");
    let v10 = include_str!("../../../../canopi-format/spec/v10/read-fixture.canopi");
    std::fs::write(&newer, v10).unwrap();
    assert_eq!(
        load_from_file(&newer).unwrap_err().failure().kind,
        DesignLoadFailureKind::NewerVersion
    );

    let folder = dir.join("folder.canopi");
    std::fs::create_dir(&folder).unwrap();
    assert_eq!(
        load_from_file(&folder).unwrap_err().failure().kind,
        DesignLoadFailureKind::Unreadable
    );
}

/// canopi-cyqd: a refused Design's failure carries the refused field, typed.
#[test]
fn canopi_cyqd_a_refused_design_failure_carries_its_field_path() {
    let dir = unique_dir("field-path");
    let refused = dir.join("refused.canopi");
    let mut value = serde_json::to_value(create_default()).expect("serialize");
    value["map_view"] = map_view_value();
    value["map_view"]["zoom"] = serde_json::json!(27.5);
    std::fs::write(&refused, value.to_string()).expect("write");
    let failure = load_from_file(&refused).unwrap_err().failure();
    assert_eq!(failure.kind, DesignLoadFailureKind::InvalidDocument);
    let path = failure.field_path.map(|path| path.to_string());
    assert_eq!(path.as_deref(), Some("$.map_view.zoom"));
}

#[test]
fn opening_a_design_over_the_size_limit_is_refused() {
    let dir = unique_dir("too_large");
    let path = dir.join("huge.canopi");
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(MAX_CANOPI_FILE_BYTES + 1).unwrap();
    drop(file);

    let error = load_from_file(&path).expect_err("oversized Design must be refused");

    assert!(matches!(error, DesignLoadError::TooLarge { .. }), "{error}");
    assert!(error.to_string().contains("64 MiB"), "{error}");
}
