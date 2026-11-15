//! Tests for `read`'s version admission (`read_version`, `saved_by_newer`): the version a
//! file reads at, is refused at, or is kept from being replaced at; split from
//! `read/tests.rs` for the file-size limit.

use super::read_newer_design;
use super::tests::{refusal_of, v10};
use canopi_types::design::DesignLoadFailureKind;
use serde_json::json;

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

#[test]
fn a_version_outside_the_read_is_refused_at_version() {
    for (version, kind) in [
        (json!(9), DesignLoadFailureKind::InvalidDocument),
        (json!("10"), DesignLoadFailureKind::InvalidDocument),
        (json!(10.5), DesignLoadFailureKind::InvalidDocument),
        // A fractional version above 10 is no version, never read as 11 and `newer_version`.
        (json!(11.5), DesignLoadFailureKind::InvalidDocument),
        (json!(1_u64 << 33), DesignLoadFailureKind::NewerVersion),
    ] {
        let mut value = v10();
        value["version"] = version;
        assert_eq!(refusal_of(&value), (kind, "$.version".to_owned()));
    }
    let mut missing = v10();
    missing.as_object_mut().expect("object").remove("version");
    assert_eq!(refusal_of(&missing).1, "$.version");
    let mut negative = v10();
    negative["version"] = json!(-10.0);
    let refused = read_newer_design(&negative).expect_err("a negative version is no version");
    assert_eq!(
        refused.refusal.expected,
        "expected an integer version of 10 or later"
    );
}

/// canopi-f47t.52.270: a store's write accessor asks whether the bytes it would replace or
/// delete hold a Design saved by a newer Canopi (2.1-M410): only the root `version` decides,
/// read past any value before it, and bytes no Canopi reads as a Design hold none.
#[test]
fn canopi_f47t_52_270_saved_by_newer_reads_only_the_root_version() {
    let newer = |text: &str| super::saved_by_newer(text.as_bytes()).expect("bytes read");
    let current = canopi_types::design::CURRENT_CANOPI_FILE_VERSION;
    assert!(newer(&v10().to_string()));
    let late = r#"{"plants": [{"id": "p", "version": 1}], "name": "Late", "version": 11.0}"#;
    assert!(
        newer(late),
        "a version after other values, as an integral float"
    );
    for held in [
        format!(r#"{{"version": {current}, "name": "Current"}}"#),
        r#"{"version": 4, "name": "Canopi 1.1"}"#.to_owned(),
        r#"{"name": "No version"}"#.to_owned(),
        r#"{"version": "10"}"#.to_owned(),
        r#"{"version": 10.5}"#.to_owned(),
        r#"[{"version": 10}]"#.to_owned(),
        r#"{"version": 10"#.to_owned(),
        "not json".to_owned(),
        String::new(),
    ] {
        assert!(!newer(&held), "{held}");
    }
}

/// canopi-f47t.52.270: a read that fails is no answer, so the caller writes nothing.
#[test]
fn canopi_f47t_52_270_saved_by_newer_passes_a_read_error_on() {
    struct Failing;
    impl std::io::Read for Failing {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        }
    }
    let error = super::saved_by_newer(Failing).expect_err("the read failed");
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
}
