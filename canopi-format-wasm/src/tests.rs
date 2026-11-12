use super::probe;

#[test]
fn the_probe_answers_the_current_version_and_the_redacted_text() {
    let answer: serde_json::Value =
        serde_json::from_str(&probe("/home/ana/plan.canopi")).unwrap_or_default();
    assert_eq!(
        answer,
        serde_json::json!({
            "current_version": canopi_types::design::CURRENT_CANOPI_FILE_VERSION,
            "redacted": canopi_redact::PATH_TOKEN,
        })
    );
}
