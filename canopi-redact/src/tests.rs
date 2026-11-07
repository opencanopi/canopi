//! The redaction corpus and properties (contracts §13 Redaction). The corpus
//! cases and the named regressions are expected to fail on the commit-0
//! skeleton, which redacts every input whole; Phase 1's 1a-c3 builds the
//! redactor that turns them green and drops each `ignore`.

use super::{CREDENTIAL_NAMES, PATH_TOKEN, REDACTED_TOKEN, Redactor};
use proptest::prelude::*;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
struct Corpus {
    version: u32,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    shape: String,
    input: String,
    expected: String,
    #[serde(default)]
    roots: BTreeMap<String, String>,
}

fn corpus(text: &str) -> Corpus {
    let corpus: Corpus = serde_json::from_str(text).expect("the corpus parses");
    assert_eq!(corpus.version, 1);
    assert!(!corpus.cases.is_empty());
    corpus
}

fn shared() -> Corpus {
    corpus(include_str!(
        "../../canopi-types/fixtures/redaction/shared.json"
    ))
}

fn native_only() -> Corpus {
    corpus(include_str!(
        "../../canopi-types/fixtures/redaction/native_only.json"
    ))
}

/// The redactor that knows `roots` (home, app_data, log, report). 1a-c3:
/// `Redactor::with_roots(..)`; the skeleton has only the generic one.
fn redactor_for(roots: &BTreeMap<String, String>) -> Redactor {
    let _ = roots;
    Redactor::generic()
}

fn mismatches(cases: &[Case], redactor: impl Fn(&Case) -> Redactor) -> Vec<String> {
    cases
        .iter()
        .filter_map(|case| {
            let got = redactor(case).redact(&case.input);
            (got.as_str() != case.expected).then(|| {
                format!(
                    "{} ({}): expected {:?}, got {:?}",
                    case.id,
                    case.shape,
                    case.expected,
                    got.as_str()
                )
            })
        })
        .collect()
}

#[test]
fn the_corpus_names_every_path_shape_and_credential() {
    let corpus = shared();
    let shapes: std::collections::BTreeSet<_> =
        corpus.cases.iter().map(|c| c.shape.as_str()).collect();
    for shape in [
        "os-root",
        "unc",
        "verbatim",
        "file-url",
        "percent-encoded",
        "tilde",
        "json-escaped",
        "credential",
        "json-credential",
        "kept",
    ] {
        assert!(shapes.contains(shape), "no {shape} case in shared.json");
    }
    for name in CREDENTIAL_NAMES {
        assert!(
            corpus
                .cases
                .iter()
                .any(|c| c.input.to_ascii_lowercase().contains(&format!("{name}="))),
            "no case redacts {name}="
        );
    }
    assert!(native_only().cases.iter().all(|c| !c.roots.is_empty()));
}

#[test]
#[ignore = "expected-fail 1a-c3 canopi-f47t.52.37"]
fn redaction_corpus_shared_cases_redact_to_their_expected_text() {
    let corpus = shared();
    let wrong = mismatches(&corpus.cases, |_| Redactor::generic());
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
#[ignore = "expected-fail 1a-c3 canopi-f47t.52.37"]
fn redaction_corpus_native_only_cases_redact_to_their_expected_text() {
    let corpus = native_only();
    let wrong = mismatches(&corpus.cases, |case| redactor_for(&case.roots));
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
#[ignore = "expected-fail 1a-c3 canopi-f47t.52.78"]
fn nat_07_session_abc_becomes_session_redacted() {
    assert_eq!(
        Redactor::generic().redact("session=abc").as_str(),
        format!("session={REDACTED_TOKEN}")
    );
    assert_eq!(
        Redactor::generic()
            .redact("GET https://tile.example.com/v1/2dtiles/3/4/5?session=abc&key=xyz")
            .as_str(),
        format!(
            "GET https://tile.example.com/v1/2dtiles/3/4/5?session={REDACTED_TOKEN}&key={REDACTED_TOKEN}"
        )
    );
}

#[test]
#[ignore = "expected-fail 1a-c3 canopi-f47t.52.167"]
fn canopi_f47t_52_167_a_design_path_on_a_second_disk_or_share_never_reaches_the_report() {
    let redactor = redactor_for(&BTreeMap::from([(
        "home".to_owned(),
        r"C:\Users\ana".to_owned(),
    )]));
    for (input, expected) in [
        (
            r"Opening D:\Plans\plan.canopi failed".to_owned(),
            format!("Opening {PATH_TOKEN} failed"),
        ),
        (
            r"Opening \\nas\shared\plan.canopi failed".to_owned(),
            format!("Opening {PATH_TOKEN} failed"),
        ),
        (
            r"Opening \\?\UNC\nas\shared\plan.canopi failed".to_owned(),
            format!("Opening {PATH_TOKEN} failed"),
        ),
    ] {
        assert_eq!(redactor.redact(&input).as_str(), expected, "{input}");
    }
}

/// Text that holds no path, credential or secret shape: words, digits and
/// sentence punctuation.
fn plain_text() -> impl Strategy<Value = String> {
    proptest::string::string_regex("[A-Za-z0-9 ,.;!?()-]{0,80}").expect("a valid regex")
}

/// A path under an OS root, as a user's file would be written in an error.
fn planted_path() -> impl Strategy<Value = (String, String)> {
    let roots = prop::sample::select(vec![
        "/home/",
        "/Users/",
        "/mnt/",
        "/media/",
        "/Volumes/",
        "C:\\Users\\",
        "D:\\",
        "\\\\nas\\",
    ]);
    (roots, "[a-z]{3,10}", "[a-z]{3,10}").prop_map(|(root, folder, file)| {
        let separator = if root.contains('\\') { "\\" } else { "/" };
        let secret = format!("{folder}{separator}{file}secret.canopi");
        (format!("{root}{secret}"), secret)
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn redaction_is_idempotent(text in any::<String>()) {
        let once = Redactor::generic().redact(&text);
        prop_assert_eq!(Redactor::generic().redact(once.as_str()), once);
    }

    #[test]
    fn no_planted_path_survives(prefix in plain_text(), (path, secret) in planted_path(), suffix in plain_text()) {
        let text = format!("{prefix} {path} {suffix}");
        let redacted = Redactor::generic().redact(&text);
        prop_assert!(!redacted.as_str().contains(&secret), "{} survived in {}", secret, redacted.as_str());
    }
}

#[test]
#[ignore = "expected-fail 1a-c3 canopi-f47t.52.37"]
fn redaction_keeps_text_with_nothing_to_redact() {
    let mut runner = proptest::test_runner::TestRunner::new(ProptestConfig::with_cases(64));
    runner
        .run(&plain_text(), |text| {
            let redacted = Redactor::generic().redact(&text);
            prop_assert_eq!(redacted.as_str(), text.as_str());
            Ok(())
        })
        .expect("plain text comes back unchanged");
}
