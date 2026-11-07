use super::*;
use serde_json::json;

#[test]
fn a_code_tags_its_kind_and_nests_its_sub_kind_under_its_name() {
    let cases = [
        (
            FailureCode::Busy {
                lane: Lane::Library,
            },
            json!({ "kind": "busy", "lane": "library" }),
        ),
        (FailureCode::Cancelled, json!({ "kind": "cancelled" })),
        (
            FailureCode::Io {
                io: IoFailureKind::NoSpace,
            },
            json!({ "kind": "io", "io": "no_space" }),
        ),
        (
            FailureCode::Network {
                network: NetworkFailureKind::HostNotAllowed,
            },
            json!({ "kind": "network", "network": "host_not_allowed" }),
        ),
        (
            FailureCode::PlantDbUnavailable {
                cause: PlantCatalogCause::OpenFailed,
            },
            json!({ "kind": "plant_db_unavailable", "cause": "open_failed" }),
        ),
        (
            FailureCode::TileSourceFailed {
                layer: "satellite".to_owned(),
            },
            json!({ "kind": "tile_source_failed", "layer": "satellite" }),
        ),
    ];
    for (code, expected) in cases {
        assert_eq!(serde_json::to_value(&code).unwrap(), expected);
        assert_eq!(
            serde_json::from_value::<FailureCode>(expected).unwrap(),
            code
        );
    }
}

/// The op every fixture's failure names.
const FIXTURE_OP: &str = "fixtures.example";

fn fixture_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/failures")
}

fn wire_kind(code: &FailureCode) -> String {
    serde_json::to_value(code).unwrap()["kind"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn every_row_names_its_codes_wire_kind_once() {
    let examples = FailureCode::examples();
    assert_eq!(examples.len(), FailureCode::ROWS.len());
    for (example, row) in examples.iter().zip(FailureCode::ROWS) {
        assert_eq!(wire_kind(example), row.kind);
        assert_eq!(example.row(), row, "{}", row.kind);
    }
    let mut kinds: Vec<_> = FailureCode::ROWS.iter().map(|row| row.kind).collect();
    kinds.sort_unstable();
    kinds.dedup();
    assert_eq!(kinds.len(), FailureCode::ROWS.len(), "a kind has two rows");
}

#[test]
fn a_silent_row_is_recorded_and_never_shown() {
    let silent: Vec<_> = FailureCode::ROWS
        .iter()
        .filter(|row| row.silent)
        .map(|row| row.kind)
        .collect();
    assert_eq!(
        silent,
        [
            "cancelled",
            "dialog_already_open",
            "style_failed",
            "tile_source_failed"
        ]
    );
    assert_eq!(
        FailureCode::DialogAlreadyOpen.row().level,
        FailureLogLevel::Info
    );
}

#[test]
fn a_failure_takes_its_retry_offer_from_its_row() {
    let busy = Failure::new(
        FailureCode::Busy {
            lane: Lane::Network,
        },
        "dialog.pick_open",
    );
    let panicked = Failure::new(FailureCode::Panicked, "dialog.pick_open");
    assert!(busy.user_may_retry);
    assert!(!panicked.user_may_retry);
    assert_eq!((busy.operation, busy.detail), (None, None));
}

#[test]
fn an_io_error_kind_maps_onto_the_catalogues_io_kinds() {
    use std::io::ErrorKind;
    let cases = [
        (ErrorKind::NotFound, IoFailureKind::NotFound),
        (ErrorKind::PermissionDenied, IoFailureKind::PermissionDenied),
        (ErrorKind::ReadOnlyFilesystem, IoFailureKind::ReadOnly),
        (ErrorKind::StorageFull, IoFailureKind::NoSpace),
        (ErrorKind::QuotaExceeded, IoFailureKind::NoSpace),
        (ErrorKind::FileTooLarge, IoFailureKind::TooLarge),
        (ErrorKind::InvalidData, IoFailureKind::Other),
        (ErrorKind::Interrupted, IoFailureKind::Other),
    ];
    for (kind, expected) in cases {
        assert_eq!(IoFailureKind::from(kind), expected, "{kind:?}");
    }
}

/// Fixtures are hand-written, read by Rust here and by the frontend (contracts §2): a
/// code with no fixture, a fixture for no code, or a fixture that drifted from its
/// code's wire shape and row fails naming the code.
#[test]
fn every_code_has_a_fixture() {
    let dir = fixture_dir();
    let mut stale: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    for code in FailureCode::examples() {
        let kind = code.row().kind;
        let file = format!("{kind}.json");
        stale.retain(|name| name != &file);
        let text = std::fs::read_to_string(dir.join(&file))
            .unwrap_or_else(|_| panic!("{kind} has no fixture {file}"));
        let fixture: serde_json::Value = serde_json::from_str(&text)
            .unwrap_or_else(|error| panic!("{kind}: its fixture is not JSON: {error}"));
        let expected = serde_json::to_value(Failure::new(code, FIXTURE_OP)).unwrap();
        assert_eq!(fixture, expected, "{kind}: its fixture drifted");
    }
    assert!(stale.is_empty(), "fixtures for no code: {stale:?}");
}

#[test]
fn every_op_is_a_unique_dotted_lower_snake_case_name() {
    let part =
        |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
    for op in ops::ALL {
        let shaped = op
            .split_once('.')
            .is_some_and(|(area, action)| part(area) && part(action));
        assert!(shaped, "{op} is not <area>.<action>");
    }
    let mut sorted = ops::ALL.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), ops::ALL.len(), "an op is named twice");
}

#[test]
fn a_system_id_is_minted_fresh_and_parses_back() {
    let first = OperationId::system();
    let second = OperationId::system();
    assert!(first.as_str().starts_with("s-"), "{}", first.as_str());
    assert_ne!(first, second);
    assert_eq!(OperationId::parse(first.as_str()), Ok(first.clone()));
    let wire = serde_json::to_value(&first).unwrap();
    assert_eq!(wire, json!(first.as_str()));
    assert_eq!(serde_json::from_value::<OperationId>(wire).unwrap(), first);
}

#[test]
fn a_user_id_parses() {
    let text = "u-3f2a8c1e-5b7d-4e2f-9a1c-0d6e8b4f2a71";
    assert_eq!(
        OperationId::parse(text).map(|id| id.as_str().to_owned()),
        Ok(text.to_owned())
    );
}

#[test]
fn a_malformed_operation_id_is_invalid_and_its_text_is_never_shown() {
    let refused = [
        "",
        "u-",
        "x-3f2a8c1e-5b7d-4e2f-9a1c-0d6e8b4f2a71",
        "3f2a8c1e-5b7d-4e2f-9a1c-0d6e8b4f2a71",
        "u-3F2A8C1E-5B7D-4E2F-9A1C-0D6E8B4F2A71",
        "u-3f2a8c1e5b7d4e2f9a1c0d6e8b4f2a71",
        "u-{3f2a8c1e-5b7d-4e2f-9a1c-0d6e8b4f2a71}",
        "u-3f2a8c1e-5b7d-1e2f-9a1c-0d6e8b4f2a71",
        "u-3f2a8c1e-5b7d-4e2f-1a1c-0d6e8b4f2a71",
        "u-3f2a8c1e-5b7d-4e2f-9a1c-0d6e8b4f2a71 ",
        "s-/home/ana/My Gardens/garden.canopi",
    ];
    for text in refused {
        let error = OperationId::parse(text).unwrap_err();
        assert_eq!(FailureCode::from(error), FailureCode::Invalid, "{text:?}");
        let decoded = serde_json::from_value::<OperationId>(json!(text)).unwrap_err();
        for shown in [error.to_string(), format!("{error:?}"), decoded.to_string()] {
            assert!(
                text.len() < 3 || !shown.contains(&text[2..]),
                "{shown} shows the refused id"
            );
        }
    }
}

#[test]
fn an_operation_id_is_never_logged_raw() {
    let id = OperationId::system();
    let failure =
        Failure::new(FailureCode::Internal, "dialog.pick_open").with_operation(id.clone());
    let logged = format!("{id:?} {failure:?}");
    assert!(!logged.contains(&id.as_str()[2..]), "{logged}");
    assert!(logged.contains("OperationId(s-…)"), "{logged}");
}

#[test]
fn a_failure_crosses_the_seam_with_every_wire_field() {
    let failure = Failure {
        code: FailureCode::Busy {
            lane: Lane::UserData,
        },
        user_may_retry: true,
        op: "settings.load",
        operation: None,
        detail: None,
    };
    assert_eq!(
        serde_json::to_value(&failure).unwrap(),
        json!({
            "code": { "kind": "busy", "lane": "user_data" },
            "user_may_retry": true,
            "op": "settings.load",
            "operation": null,
            "detail": null,
        })
    );
}
