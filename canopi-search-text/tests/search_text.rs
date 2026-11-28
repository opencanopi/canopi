use canopi_search_text::{
    CONTRACT_SOURCE, NormalizeOptions, SearchAdmission, UNICODE_FACTS_SOURCE, admission,
    admission_with_options, fold_kana_char, normalization_version, normalize,
    normalize_with_options, query_tokens, validate_contract,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct CorpusContract {
    corpus: Vec<CorpusCase>,
}

#[derive(Deserialize)]
struct CorpusCase {
    name: String,
    input: String,
    normalized_text: String,
    tokens: Vec<String>,
    query_tokens: Vec<String>,
    admission: String,
}

#[test]
fn authored_contract_parses_cleanly() {
    let version = validate_contract(CONTRACT_SOURCE, UNICODE_FACTS_SOURCE).unwrap();
    assert_eq!(version, normalization_version());
    assert!(version >= 2);
}

#[test]
fn v2_authored_corpus_matches_v2_compat_mode() {
    let corpus: CorpusContract = serde_json::from_str(CONTRACT_SOURCE).unwrap();
    for case in corpus.corpus {
        let normalized = normalize_with_options(&case.input, NormalizeOptions::V2_COMPAT);
        assert_eq!(normalized.text, case.normalized_text, "{} text", case.name);
        assert_eq!(normalized.tokens, case.tokens, "{} tokens", case.name);
        assert_eq!(
            query_tokens(&normalized),
            case.query_tokens,
            "{} query tokens",
            case.name
        );
        let expected_admission = match case.admission.as_str() {
            "browse" => SearchAdmission::Browse,
            "too-short" => SearchAdmission::TooShort,
            "active-text" => SearchAdmission::ActiveText,
            unexpected => panic!("unexpected corpus admission {unexpected:?}"),
        };
        assert_eq!(
            admission_with_options(&case.input, NormalizeOptions::V2_COMPAT),
            expected_admission,
            "{} admission",
            case.name
        );
    }
}

#[test]
fn q51_kana_folding_unifies_hiragana_katakana_halfwidth_and_voiced_forms() {
    // Core 2.1-Q51 contract: hiragana folds to katakana (`りんご` finds `リンゴ`).
    let hiragana = normalize("りんご");
    let katakana = normalize("リンゴ");
    let halfwidth = normalize("ﾘﾝｺﾞ");
    assert_eq!(hiragana.text, "リンコ");
    assert_eq!(hiragana, katakana);
    assert_eq!(hiragana, halfwidth);

    // Sakura, grape, and small kana equivalence.
    assert_eq!(normalize("さくら").text, normalize("サクラ").text);
    assert_eq!(normalize("さくら").text, normalize("ｻｸﾗ").text);
    assert_eq!(normalize("ぶどう").text, normalize("ブドウ").text);
    assert_eq!(normalize("ぁぃぅぇぉゃゅょっ").text, "ァィゥェォャュョッ");
    assert_eq!(normalize("ゔ").text, normalize("ヴ").text);
    assert_eq!(normalize("ゕゖ").text, "ヵヶ");
    assert_eq!(normalize("ゟ").text, "ヨリ");
    assert_eq!(normalize("か").text, "カ");
    assert_eq!(normalize("ｶ").text, "カ");
    assert_eq!(normalize("が").text, "カ");
    assert_eq!(normalize("ガ").text, "カ");

    // Iteration marks fold too.
    assert_eq!(fold_kana_char('ゝ'), 'ヽ');
    assert_eq!(fold_kana_char('ゞ'), 'ヾ');
    assert_eq!(fold_kana_char('栗'), '栗');
    assert_eq!(fold_kana_char('a'), 'a');

    // Prolonged sound mark stays intact in multi-scalar tokens and is not single-scalar admitted.
    assert_eq!(normalize("コーヒー").text, "コーヒー");
    assert_eq!(admission("ー"), SearchAdmission::TooShort);
    assert_eq!(admission("か"), SearchAdmission::ActiveText);
    assert_eq!(admission("ｶ"), SearchAdmission::ActiveText);
    assert_eq!(admission("栗"), SearchAdmission::ActiveText);
}

#[test]
fn latin_diacritics_sharp_s_greek_cyrillic_and_ligatures_fold_consistently() {
    // Latin diacritics (composed & decomposed)
    assert_eq!(
        normalize("Café cafe\u{0301} Érable").text,
        "cafe cafe erable"
    );
    assert_eq!(normalize("Chêne pédonculé").text, "chene pedoncule");
    assert_eq!(normalize("Árbol español ñandú").text, "arbol espanol nandu");

    // German ß / ẞ
    assert_eq!(normalize("Straße ẞ").text, "strasse ss");
    assert_eq!(normalize("Weißdorn").text, "weissdorn");

    // Greek final sigma and tonic accents
    assert_eq!(normalize("Σίσυφος").text, "σισυφοσ");
    assert_eq!(admission("Ω"), SearchAdmission::TooShort);

    // Cyrillic case folding
    assert_eq!(normalize("РОЗА Яблоня").text, "роза яблоня");

    // Compatibility ligatures
    assert_eq!(normalize("oﬃce ﬆyle").text, "office style");
}

#[test]
fn punctuation_word_start_tokenizing_and_admission_rules() {
    let parsed = normalize("Carleton's soap/pod — snake_case (malus)");
    assert_eq!(
        parsed.tokens,
        vec!["carleton", "s", "soap", "pod", "snake_case", "malus"]
    );
    assert_eq!(
        query_tokens(&parsed),
        vec!["carleton", "soap", "pod", "snake_case", "malus"]
    );
    assert_eq!(admission(" -- / () "), SearchAdmission::Browse);
    assert_eq!(admission("a"), SearchAdmission::TooShort);
    assert_eq!(admission("A/B"), SearchAdmission::ActiveText);
    assert_eq!(query_tokens(&normalize("A/B")), vec!["a", "b"]);
    assert_eq!(query_tokens(&normalize("栗 a")), vec!["栗"]);
    assert_eq!(query_tokens(&normalize("か a")), vec!["カ"]);
}

#[test]
fn hangul_syllables_decompose_cleanly_without_panicking() {
    let normalized = normalize("사과");
    assert_eq!(normalized.tokens.len(), 1);
    assert_eq!(admission("사과"), SearchAdmission::ActiveText);
    // Single Hangul syllable decomposes to >= 2 jamo scalars, so it is admitted.
    assert_eq!(admission("사"), SearchAdmission::ActiveText);
}

#[test]
fn contract_validator_rejects_malformed_inputs() {
    let mut raw: serde_json::Value = serde_json::from_str(CONTRACT_SOURCE).unwrap();
    raw["algorithm"]["accidental_new_rule"] = serde_json::json!(true);
    let err =
        validate_contract(&serde_json::to_string(&raw).unwrap(), UNICODE_FACTS_SOURCE).unwrap_err();
    assert!(err.contains("unknown field `accidental_new_rule`"), "{err}");

    let mut raw_facts: serde_json::Value = serde_json::from_str(UNICODE_FACTS_SOURCE).unwrap();
    raw_facts["hangul_decomposition"]["l_base"] = serde_json::json!(1);
    let err = validate_contract(CONTRACT_SOURCE, &raw_facts.to_string()).unwrap_err();
    assert!(err.contains("standard Hangul"), "{err}");

    let mut bad_mark: serde_json::Value = serde_json::from_str(UNICODE_FACTS_SOURCE).unwrap();
    bad_mark["mark_scalar_ranges"] = serde_json::json!([[0x10FFFF, 0x10FFFF]]);
    let err = validate_contract(CONTRACT_SOURCE, &bad_mark.to_string()).unwrap_err();
    assert!(err.contains("known scalars"), "{err}");

    let mut bad_single: serde_json::Value = serde_json::from_str(UNICODE_FACTS_SOURCE).unwrap();
    bad_single["single_scalar_admitted_scalar_ranges"] = serde_json::json!([[0x3000, 0x3000]]);
    let err = validate_contract(CONTRACT_SOURCE, &bad_single.to_string()).unwrap_err();
    assert!(err.contains("only token scalars"), "{err}");
}
