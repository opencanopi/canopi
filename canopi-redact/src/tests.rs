//! The redaction corpus and properties (contracts §13 Redaction): the shared
//! cases through `Redactor::generic()`, the native-only cases through
//! `Redactor::with_roots(..)`, the named regressions and the properties
//! (idempotent, no planted path survives, never panics, input capped).

use super::{
    CREDENTIAL_NAMES, MAX_INPUT_BYTES, NamedFolder, PATH_TOKEN, REDACTED_TOKEN, RedactedText,
    Redactor, TRUNCATION_MARK,
};
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

/// The redactor that knows `roots`, keyed as the native-only corpus keys them.
fn redactor_for(roots: &BTreeMap<String, String>) -> Redactor {
    Redactor::with_roots(roots.iter().map(|(name, path)| {
        let folder = match name.as_str() {
            "home" => NamedFolder::Home,
            "app_data" => NamedFolder::AppData,
            "log" => NamedFolder::Log,
            "report" => NamedFolder::Report,
            other => panic!("the corpus names an unknown folder {other}"),
        };
        (folder, path.as_str())
    }))
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
fn redaction_corpus_shared_cases_redact_to_their_expected_text() {
    let corpus = shared();
    let wrong = mismatches(&corpus.cases, |_| Redactor::generic());
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
fn redaction_corpus_native_only_cases_redact_to_their_expected_text() {
    let corpus = native_only();
    let wrong = mismatches(&corpus.cases, |case| redactor_for(&case.roots));
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
fn the_shared_cases_redact_alike_when_the_redactor_knows_no_folder_they_name() {
    // A machine whose folders the shared inputs never name redacts them as the
    // generic redactor does: knowing roots never reveals a path.
    let elsewhere = Redactor::with_roots([
        (NamedFolder::Home, "/home/zoe"),
        (NamedFolder::AppData, "/home/zoe/.local/share/canopi"),
    ]);
    let wrong = mismatches(&shared().cases, |_| elsewhere.clone());
    let wrong: Vec<_> = wrong
        .into_iter()
        .filter(|line| !line.starts_with("tilde-home"))
        .collect();
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
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
        (
            "Fetching file://nas/shared/plan.canopi failed".to_owned(),
            format!("Fetching {PATH_TOKEN} failed"),
        ),
    ] {
        assert_eq!(redactor.redact(&input).as_str(), expected, "{input}");
    }
}

#[test]
fn a_named_folder_inside_a_verbatim_or_file_url_path_reads_as_its_folder() {
    let redactor = Redactor::with_roots([
        (NamedFolder::Home, r"C:\Users\ana"),
        (NamedFolder::Report, r"C:\Users\ana\Documents\Canopi"),
    ]);
    for (input, expected) in [
        (r"at \\?\C:\Users\ana\plan.canopi", "at <home-dir>"),
        ("at file:///c:/users/ana/plan.canopi", "at <home-dir>"),
        (
            r"at C:\Users\ana\Documents\Canopi\r.zip",
            "at <report-root>",
        ),
        (
            r#"{"path":"C:\\Users\\ana\\plan.canopi"}"#,
            r#"{"path":"<home-dir>"}"#,
        ),
        ("at ~/plan.canopi", "at <home-dir>"),
        (r"at C:\Users\anabel\plan.canopi", "at <path>"),
    ] {
        assert_eq!(redactor.redact(input).as_str(), expected, "{input}");
    }
}

#[test]
fn a_path_with_spaces_keeps_the_error_reason_after_it() {
    let redactor = Redactor::with_roots([(NamedFolder::Home, "/home/alice")]);
    for (input, expected) in [
        (
            "Failed to read /media/alice/USB Drive/Secret Orchard.canopi: No such file or directory (os error 2)",
            "Failed to read <path>: No such file or directory (os error 2)",
        ),
        (
            r"Failed to save C:\Users\alice\Secret Orchard.canopi: Access is denied.",
            "Failed to save <path>: Access is denied.",
        ),
        (
            "Loaded /home/alice/Secret Orchard.canopi: permission denied",
            "Loaded <home-dir>: permission denied",
        ),
        (
            "Copied /home/alice/a.tif to /mnt/backup/b.tif.",
            "Copied <home-dir> to <path>.",
        ),
    ] {
        assert_eq!(redactor.redact(input).as_str(), expected, "{input}");
    }
}

#[test]
fn a_word_ending_in_a_credential_name_is_no_parameter() {
    for kept in [
        "monkey=banana primary_key=id",
        "a sessionid=4 and keys=3",
        "Press the key to continue",
    ] {
        assert_eq!(Redactor::generic().redact(kept).as_str(), kept);
    }
}

#[test]
fn a_redacted_json_string_stays_valid_json() {
    let escaped = r#"{"message":"{\"path\":\"/home/ana/plan.canopi\"}"}"#;
    let redacted = Redactor::generic().redact(escaped);
    let value: serde_json::Value =
        serde_json::from_str(redacted.as_str()).expect("still JSON after redaction");
    assert_eq!(value["message"], r#"{"path":"<path>"}"#);
}

#[test]
fn very_long_input_is_capped_before_scanning_and_redacted_before_truncation() {
    // A credential and a path cut by the cap still leave no secret prefix.
    for tail in ["key=SECRETSECRETSECRET", "/home/ana/secret-orchard.canopi"] {
        let filler = "a".repeat(MAX_INPUT_BYTES - 12);
        let input = format!("{filler} {tail}");
        let redacted = Redactor::generic().redact(&input);
        let text = redacted.as_str();
        let end = &text[text.len().saturating_sub(40)..];
        assert!(text.ends_with(TRUNCATION_MARK), "the cut is marked: {end}");
        assert!(!text.contains("SECR"), "{end}");
        assert!(!text.contains("/home"), "{end}");
        assert!(text.len() <= MAX_INPUT_BYTES + REDACTED_TOKEN.len() + TRUNCATION_MARK.len());
    }
    // A multi-byte character astride the cap is never split.
    let input = format!("{}é tail", "a".repeat(MAX_INPUT_BYTES - 1));
    let redacted = Redactor::generic().redact(&input);
    let kept = redacted.as_str().strip_suffix(TRUNCATION_MARK);
    assert!(
        kept.is_some_and(|kept| kept.len() == MAX_INPUT_BYTES - 1 && !kept.contains('é')),
        "the cut falls before the character"
    );
    // Text under the cap is never marked.
    let short = "a".repeat(MAX_INPUT_BYTES);
    assert!(
        Redactor::generic().redact(&short).as_str() == short,
        "unmarked"
    );
}

#[test]
fn a_wire_string_decoded_as_redacted_text_is_redacted_again() {
    let decoded: RedactedText =
        serde_json::from_str(r#""Opening /home/ana/plan.canopi with session=abc failed""#)
            .expect("a string decodes");
    assert_eq!(
        decoded.as_str(),
        format!("Opening {PATH_TOKEN} with session={REDACTED_TOKEN} failed")
    );
    // Already redacted text round-trips unchanged, as a plain string.
    let wire = serde_json::to_string(&decoded).expect("it encodes");
    assert_eq!(
        wire,
        format!("\"Opening {PATH_TOKEN} with session={REDACTED_TOKEN} failed\"")
    );
    let again: RedactedText = serde_json::from_str(&wire).expect("it decodes");
    assert_eq!(again, decoded);
    // Anything but a string is refused.
    assert!(serde_json::from_str::<RedactedText>("42").is_err());
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
        "file:///home/",
        "\\\\?\\C:\\",
        "~/",
    ]);
    (roots, "[a-z]{3,10}", "[a-z]{3,10}").prop_map(|(root, folder, file)| {
        let separator = if root.contains('\\') { "\\" } else { "/" };
        let secret = format!("{folder}{separator}{file}secret.canopi");
        (format!("{root}{secret}"), secret)
    })
}

/// Text built from the characters the scanner treats specially, so the
/// properties reach its branches more often than arbitrary text would.
fn scanner_text() -> impl Strategy<Value = String> {
    proptest::string::string_regex(
        r#"([a-zA-Z0-9 /\\:"'=?&%~.,;{}()\n<>-]|key=|session=|file://|C:\\|\\\\){0,60}"#,
    )
    .expect("a valid regex")
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn redaction_is_idempotent(text in any::<String>()) {
        let once = Redactor::generic().redact(&text);
        prop_assert_eq!(Redactor::generic().redact(once.as_str()), once);
    }

    #[test]
    fn redaction_is_idempotent_on_text_the_scanner_reads(text in scanner_text()) {
        let redactor = Redactor::with_roots([(NamedFolder::Home, "/home/ana"), (NamedFolder::Log, r"C:\logs")]);
        let once = redactor.redact(&text);
        prop_assert_eq!(redactor.redact(once.as_str()), once);
    }

    #[test]
    fn no_planted_path_survives(prefix in plain_text(), (path, secret) in planted_path(), suffix in plain_text()) {
        let text = format!("{prefix} {path} {suffix}");
        let redacted = Redactor::generic().redact(&text);
        prop_assert!(!redacted.as_str().contains(&secret), "{} survived in {}", secret, redacted.as_str());
    }

    #[test]
    fn no_planted_credential_value_survives(prefix in plain_text(), name in prop::sample::select(CREDENTIAL_NAMES.to_vec()), value in "[A-Za-z0-9_-]{4,40}", suffix in plain_text()) {
        for text in [format!("{prefix} {name}={value} {suffix}"), format!("{prefix} {{\"{name}\": \"{value}\"}} {suffix}")] {
            let redacted = Redactor::generic().redact(&text);
            prop_assert!(!redacted.as_str().contains(&format!("{name}={value}")) && !redacted.as_str().contains(&format!("\"{value}\"")), "{} survived in {}", value, redacted.as_str());
        }
    }

    #[test]
    fn redaction_never_panics_on_arbitrary_utf8(text in any::<String>(), roots in prop::collection::vec(any::<String>(), 0..3)) {
        let redactor = Redactor::with_roots(roots.iter().map(|root| (NamedFolder::Home, root.as_str())));
        let _ = redactor.redact(&text);
        let _ = Redactor::generic().redact(&text);
    }
}

#[test]
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
