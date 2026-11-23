use super::*;

fn authored_contract_and_facts() -> (NormalizationContract, UnicodeFacts) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let read = |path: &str| std::fs::read_to_string(root.join(path)).unwrap();
    (
        serde_json::from_str(&read("canopi-types/species-search-normalization.json")).unwrap(),
        serde_json::from_str(&read("canopi-types/species-search-unicode-15.json")).unwrap(),
    )
}

#[test]
fn a_json_string_literal_escapes_quotes_backslashes_and_controls() {
    assert_eq!(
        json_string("say \"hi\"\\\n\u{1}é"),
        r#""say \"hi\"\\\n\u0001é""#
    );
}

#[test]
fn authored_normalization_contract_renders_versioned_typescript_facts() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let rendered =
        render_typescript_adapter(&root.join("canopi-types/species-search-normalization.json"))
            .unwrap();

    assert!(rendered.contains("SPECIES_SEARCH_NORMALIZATION_VERSION = 2"));
    assert!(rendered.contains("SPECIES_SEARCH_SINGLE_SCALAR_ADMITTED_SCALAR_RANGES"));
    assert!(rendered.contains("one-han-scalar"));
    assert!(rendered.contains("greek-final-sigma"));
    assert!(rendered.contains("σισυφοσ"));
}

#[test]
fn bindings_validation_rejects_property_ranges_outside_known_scalars() {
    let (authority, mut facts) = authored_contract_and_facts();
    facts.mark_scalar_ranges = vec![[0x10FFFF, 0x10FFFF]];

    let error = validate(&authority, &facts).unwrap_err().to_string();

    assert!(error.contains("known scalars"), "{error}");
}

#[test]
fn bindings_validation_rejects_single_scalar_ranges_outside_token_scalars() {
    let (authority, mut facts) = authored_contract_and_facts();
    // U+3000 is the ideographic space, not a token scalar.
    facts.single_scalar_admitted_scalar_ranges = vec![[0x3000, 0x3000]];

    let error = validate(&authority, &facts).unwrap_err().to_string();

    assert!(error.contains("only token scalars"), "{error}");
}

#[test]
fn bindings_validation_rejects_nonstandard_hangul_facts() {
    let (authority, mut facts) = authored_contract_and_facts();
    facts.hangul_decomposition.l_base = 1;

    let error = validate(&authority, &facts).unwrap_err().to_string();

    assert!(error.contains("standard Hangul"), "{error}");
}

#[test]
fn bindings_validation_rejects_property_range_spanning_unknown_gap() {
    let (authority, mut facts) = authored_contract_and_facts();
    facts.mark_scalar_ranges = vec![[887, 890]];

    let error = validate(&authority, &facts).unwrap_err().to_string();

    assert!(error.contains("known scalars"), "{error}");
}

#[test]
fn bindings_validation_requires_known_hangul_syllable_range() {
    let (authority, mut facts) = authored_contract_and_facts();
    facts
        .known_scalar_ranges
        .retain(|[start, end]| !(*start <= 0xAC00 && 0xAC00 <= *end));
    facts
        .token_scalar_ranges
        .retain(|[start, end]| !(*start <= 0xAC00 && 0xAC00 <= *end));

    let error = validate(&authority, &facts).unwrap_err().to_string();

    assert!(
        error.contains("Hangul") && error.contains("known"),
        "{error}"
    );
}
