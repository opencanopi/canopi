use super::*;
use sha2::{Digest, Sha256};

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
fn authored_corpus_matches_rust_normalization_and_admission() {
    let corpus: CorpusContract = serde_json::from_str(CONTRACT_SOURCE).unwrap();

    for case in corpus.corpus {
        let normalized = normalize_species_search(&case.input);
        assert_eq!(normalized.text, case.normalized_text, "{} text", case.name);
        assert_eq!(normalized.tokens, case.tokens, "{} tokens", case.name);
        assert_eq!(
            species_search_query_tokens(&normalized),
            case.query_tokens,
            "{} query tokens",
            case.name
        );

        let admission = match case.admission.as_str() {
            "browse" => SpeciesSearchAdmission::Browse,
            "too-short" => SpeciesSearchAdmission::TooShort,
            "active-text" => SpeciesSearchAdmission::ActiveText,
            unexpected => panic!("unexpected corpus admission {unexpected:?}"),
        };
        assert_eq!(
            species_search_admission(&case.input),
            admission,
            "{} admission",
            case.name
        );
    }
}

#[test]
fn sqlite_normalization_function_uses_the_same_authority() {
    let connection = Connection::open_in_memory().unwrap();
    register_sqlite_function(&connection).unwrap();

    let normalized: Option<String> = connection
        .query_row(
            "SELECT canopi_normalize_species_search(?1)",
            [Some("Σίσυφος Straße")],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(normalized.as_deref(), Some("σισυφοσ strasse"));

    let normalized_null: Option<String> = connection
        .query_row("SELECT canopi_normalize_species_search(NULL)", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(normalized_null, None);
}

#[test]
fn runtime_authority_parser_rejects_unknown_semantic_fields() {
    let mut raw: serde_json::Value = serde_json::from_str(CONTRACT_SOURCE).unwrap();
    raw["algorithm"]["accidental_new_rule"] = serde_json::json!(true);

    let error =
        parse_contract(&serde_json::to_string(&raw).unwrap(), UNICODE_FACTS_SOURCE).unwrap_err();

    assert!(
        error.contains("unknown field `accidental_new_rule`"),
        "{error}"
    );
}

#[test]
fn runtime_authority_parser_rejects_nonstandard_hangul_facts() {
    let mut raw_facts: serde_json::Value = serde_json::from_str(UNICODE_FACTS_SOURCE).unwrap();
    raw_facts["hangul_decomposition"]["l_base"] = serde_json::json!(1);

    let error = parse_contract(CONTRACT_SOURCE, &raw_facts.to_string()).unwrap_err();

    assert!(error.contains("standard Hangul"), "{error}");
}

#[test]
fn runtime_authority_parser_rejects_property_ranges_outside_known_scalars() {
    let mut raw_facts: serde_json::Value = serde_json::from_str(UNICODE_FACTS_SOURCE).unwrap();
    raw_facts["mark_scalar_ranges"] = serde_json::json!([[0x10FFFF, 0x10FFFF]]);

    let error = parse_contract(CONTRACT_SOURCE, &raw_facts.to_string()).unwrap_err();

    assert!(error.contains("known scalars"), "{error}");
}

#[test]
fn runtime_authority_parser_rejects_single_scalar_ranges_outside_token_scalars() {
    let mut raw_facts: serde_json::Value = serde_json::from_str(UNICODE_FACTS_SOURCE).unwrap();
    // U+3000 is the ideographic space, not a token scalar.
    raw_facts["single_scalar_admitted_scalar_ranges"] = serde_json::json!([[0x3000, 0x3000]]);

    let error = parse_contract(CONTRACT_SOURCE, &raw_facts.to_string()).unwrap_err();

    assert!(error.contains("only token scalars"), "{error}");
}

#[test]
fn one_han_or_kana_scalar_is_an_admitted_query() {
    for query in ["栗", "桃", "か", "ｶ", "々"] {
        assert_eq!(
            species_search_admission(query),
            SpeciesSearchAdmission::ActiveText,
            "{query}"
        );
    }
    for query in ["É", "Ω", "я", "ー", "1"] {
        assert_eq!(
            species_search_admission(query),
            SpeciesSearchAdmission::TooShort,
            "{query}"
        );
    }
    assert_eq!(
        species_search_query_tokens(&normalize_species_search("栗 a")),
        ["栗"]
    );
}

#[test]
fn runtime_authority_parser_rejects_property_range_spanning_unknown_gap() {
    let mut raw_facts: serde_json::Value = serde_json::from_str(UNICODE_FACTS_SOURCE).unwrap();
    raw_facts["mark_scalar_ranges"] = serde_json::json!([[887, 890]]);

    let error = parse_contract(CONTRACT_SOURCE, &raw_facts.to_string()).unwrap_err();

    assert!(error.contains("known scalars"), "{error}");
}

#[test]
fn runtime_authority_parser_requires_known_hangul_syllable_range() {
    let mut raw_facts: serde_json::Value = serde_json::from_str(UNICODE_FACTS_SOURCE).unwrap();
    for key in ["known_scalar_ranges", "token_scalar_ranges"] {
        raw_facts[key]
            .as_array_mut()
            .unwrap()
            .retain(|scalar_range| {
                let start = scalar_range[0].as_u64().unwrap();
                let end = scalar_range[1].as_u64().unwrap();
                !(start <= 0xAC00 && 0xAC00 <= end)
            });
    }

    let error = parse_contract(CONTRACT_SOURCE, &raw_facts.to_string()).unwrap_err();

    assert!(
        error.contains("Hangul") && error.contains("known"),
        "{error}"
    );
}

#[test]
fn rust_and_python_compilers_fingerprint_the_same_canonical_json() {
    let authority: serde_json::Value = serde_json::from_str(CONTRACT_SOURCE).unwrap();
    let unicode_facts: serde_json::Value = serde_json::from_str(UNICODE_FACTS_SOURCE).unwrap();
    let semantic_source = serde_json::json!({
        "authority": authority,
        "unicode_facts": unicode_facts,
    });
    let rust_fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&semantic_source).unwrap())
    );

    assert_eq!(
        rust_fingerprint,
        crate::db::schema_contract::SPECIES_SEARCH_NORMALIZATION_FINGERPRINT
    );
}
