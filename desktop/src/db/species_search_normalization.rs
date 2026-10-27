use rusqlite::{Connection, functions::FunctionFlags};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const CONTRACT_SOURCE: &str =
    include_str!("../../../common-types/species-search-normalization.json");
const UNICODE_FACTS_SOURCE: &str =
    include_str!("../../../common-types/species-search-unicode-15.json");
const UNICODE_FACTS_FILENAME: &str = "species-search-unicode-15.json";
const SQLITE_FUNCTION_NAME: &str = "canopi_normalize_species_search";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NormalizationContract {
    contract_format_version: u32,
    normalization_version: u32,
    unicode_data: UnicodeDataReference,
    algorithm: NormalizationAlgorithm,
    corpus: Vec<CorpusCase>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnicodeDataReference {
    version: String,
    facts_file: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnicodeFacts {
    facts_format_version: u32,
    unicode_data_version: String,
    known_scalar_ranges: Vec<[u32; 2]>,
    mark_scalar_ranges: Vec<[u32; 2]>,
    token_scalar_ranges: Vec<[u32; 2]>,
    hangul_decomposition: HangulDecomposition,
    compatibility_decomposition_mappings: Vec<(u32, String)>,
    lowercase_mappings: Vec<(u32, String)>,
}

#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct HangulDecomposition {
    s_base: u32,
    l_base: u32,
    v_base: u32,
    t_base: u32,
    l_count: u32,
    v_count: u32,
    t_count: u32,
}

const STANDARD_HANGUL_DECOMPOSITION: HangulDecomposition = HangulDecomposition {
    s_base: 0xAC00,
    l_base: 0x1100,
    v_base: 0x1161,
    t_base: 0x11A7,
    l_count: 19,
    v_count: 21,
    t_count: 28,
};

#[derive(Debug)]
struct LoadedNormalizationContract {
    authority: NormalizationContract,
    unicode_facts: UnicodeFacts,
    decomposition_by_scalar: HashMap<u32, String>,
    lowercase_by_scalar: HashMap<u32, String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NormalizationAlgorithm {
    compatibility_decomposition: String,
    stripped_general_categories: Vec<String>,
    token_character_classes: Vec<String>,
    case_folds: Vec<CaseFold>,
    minimum_admitted_scalar_count: usize,
    query_token_policy: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CaseFold {
    from: String,
    to: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CorpusCase {
    name: String,
    input: String,
    normalized_text: String,
    tokens: Vec<String>,
    query_tokens: Vec<String>,
    admission: String,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct NormalizedSpeciesSearch {
    pub(crate) text: String,
    pub(crate) tokens: Vec<String>,
    pub(crate) scalar_count: usize,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum SpeciesSearchAdmission {
    Browse,
    TooShort,
    ActiveText,
}

#[expect(
    clippy::expect_used,
    reason = "the normalization contract is an authored constant checked by tests"
)]
fn contract() -> &'static LoadedNormalizationContract {
    static CONTRACT: OnceLock<LoadedNormalizationContract> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        let contract = parse_contract(CONTRACT_SOURCE, UNICODE_FACTS_SOURCE)
            .expect("authored Species Search normalization contract must be valid");
        assert_eq!(
            contract.authority.normalization_version,
            crate::db::schema_contract::SPECIES_SEARCH_NORMALIZATION_VERSION,
            "storage and Species Search normalization versions must match"
        );
        contract
    })
}

#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn parse_contract(
    source: &str,
    unicode_facts_source: &str,
) -> Result<LoadedNormalizationContract, String> {
    let authority: NormalizationContract =
        serde_json::from_str(source).map_err(|error| error.to_string())?;
    let unicode_facts: UnicodeFacts =
        serde_json::from_str(unicode_facts_source).map_err(|error| error.to_string())?;
    if authority.contract_format_version != 1 {
        return Err("contract format version must equal 1".to_owned());
    }
    if authority.normalization_version == 0 {
        return Err("normalization version must be positive".to_owned());
    }
    if authority.unicode_data.version.is_empty()
        || authority.unicode_data.facts_file != UNICODE_FACTS_FILENAME
        || unicode_facts.facts_format_version != 2
        || unicode_facts.unicode_data_version != authority.unicode_data.version
    {
        return Err("Unicode facts do not match the normalization authority".to_owned());
    }
    validate_scalar_ranges("known", &unicode_facts.known_scalar_ranges)?;
    validate_scalar_ranges("mark", &unicode_facts.mark_scalar_ranges)?;
    validate_scalar_ranges("token", &unicode_facts.token_scalar_ranges)?;
    for ranges in [
        &unicode_facts.mark_scalar_ranges,
        &unicode_facts.token_scalar_ranges,
    ] {
        for [start, end] in ranges {
            if !scalar_range_is_covered(&unicode_facts.known_scalar_ranges, *start, *end) {
                return Err("Unicode property ranges must contain only known scalars".to_owned());
            }
        }
    }
    let hangul = &unicode_facts.hangul_decomposition;
    if hangul != &STANDARD_HANGUL_DECOMPOSITION {
        return Err("Unicode facts must contain the standard Hangul decomposition".to_owned());
    }
    let hangul_scalar_count = hangul
        .l_count
        .checked_mul(hangul.v_count)
        .and_then(|count| count.checked_mul(hangul.t_count))
        .ok_or("Hangul decomposition scalar count overflowed")?;
    let hangul_end = hangul
        .s_base
        .checked_add(hangul_scalar_count)
        .ok_or("Hangul decomposition range overflowed")?;
    if [
        hangul.s_base,
        hangul.l_base,
        hangul.v_base,
        hangul.t_base,
        hangul.l_count,
        hangul.v_count,
        hangul.t_count,
    ]
    .contains(&0)
        || hangul_end > char::MAX as u32 + 1
        || !scalar_range_is_covered(
            &unicode_facts.known_scalar_ranges,
            hangul.s_base,
            hangul_end - 1,
        )
    {
        return Err("Hangul syllable range must contain only known scalars".to_owned());
    }
    let decomposition_by_scalar = validate_mappings(
        "compatibility decomposition",
        &unicode_facts.compatibility_decomposition_mappings,
        &unicode_facts.known_scalar_ranges,
    )?;
    let lowercase_by_scalar = validate_mappings(
        "lowercase",
        &unicode_facts.lowercase_mappings,
        &unicode_facts.known_scalar_ranges,
    )?;
    if authority.algorithm.compatibility_decomposition != "NFKD"
        || authority.algorithm.stripped_general_categories != ["Mn", "Mc", "Me"]
        || authority.algorithm.token_character_classes != ["Letter", "Number", "Underscore"]
        || authority.algorithm.minimum_admitted_scalar_count == 0
        || authority.algorithm.query_token_policy != "unique-admitted-or-all-when-active"
    {
        return Err("normalization algorithm uses unsupported semantics".to_owned());
    }
    let mut fold_sources = HashSet::new();
    for case_fold in &authority.algorithm.case_folds {
        if case_fold.from.is_empty()
            || case_fold.to.is_empty()
            || !fold_sources.insert(case_fold.from.as_str())
        {
            return Err("case-fold sources must be nonempty and unique".to_owned());
        }
    }
    let mut corpus_names = HashSet::new();
    for case in &authority.corpus {
        if case.name.is_empty()
            || !corpus_names.insert(case.name.as_str())
            || case.tokens.iter().any(String::is_empty)
            || case.query_tokens.iter().any(String::is_empty)
            || !matches!(
                case.admission.as_str(),
                "browse" | "too-short" | "active-text"
            )
        {
            return Err("normalization corpus is malformed".to_owned());
        }
        let _semantic_case_fields = (&case.input, &case.normalized_text);
    }
    if authority.corpus.is_empty() {
        return Err("normalization corpus must not be empty".to_owned());
    }
    Ok(LoadedNormalizationContract {
        authority,
        unicode_facts,
        decomposition_by_scalar,
        lowercase_by_scalar,
    })
}

fn validate_mappings(
    label: &str,
    mappings: &[(u32, String)],
    known_ranges: &[[u32; 2]],
) -> Result<HashMap<u32, String>, String> {
    if mappings.is_empty() {
        return Err(format!("Unicode {label} mappings must not be empty"));
    }
    let mut by_scalar = HashMap::new();
    let mut previous_scalar = None;
    for (scalar, target) in mappings {
        if target.is_empty()
            || previous_scalar.is_some_and(|previous| *scalar <= previous)
            || !scalar_in_ranges(known_ranges, *scalar)
            || target
                .chars()
                .any(|character| !scalar_in_ranges(known_ranges, character as u32))
            || by_scalar.insert(*scalar, target.clone()).is_some()
        {
            return Err(format!(
                "Unicode {label} mappings must be ordered known scalars"
            ));
        }
        previous_scalar = Some(*scalar);
    }
    Ok(by_scalar)
}

fn validate_scalar_ranges(label: &str, ranges: &[[u32; 2]]) -> Result<(), String> {
    if ranges.is_empty() {
        return Err(format!("Unicode {label} scalar ranges must not be empty"));
    }
    let mut previous_end = None;
    for [start, end] in ranges {
        if start > end
            || *end > char::MAX as u32
            || previous_end.is_some_and(|previous| *start <= previous)
            || (*start <= 0xDFFF && *end >= 0xD800)
        {
            return Err(format!(
                "Unicode {label} scalar ranges must be ordered, disjoint scalar values"
            ));
        }
        previous_end = Some(*end);
    }
    Ok(())
}

fn scalar_in_ranges(ranges: &[[u32; 2]], scalar: u32) -> bool {
    let insertion = ranges.partition_point(|[_start, end]| *end < scalar);
    ranges
        .get(insertion)
        .is_some_and(|[start, end]| *start <= scalar && scalar <= *end)
}

fn scalar_range_is_covered(ranges: &[[u32; 2]], start: u32, end: u32) -> bool {
    let mut next_required = start;
    for [range_start, range_end] in ranges {
        if *range_end < next_required {
            continue;
        }
        if *range_start > next_required {
            return false;
        }
        if *range_end >= end {
            return true;
        }
        next_required = *range_end + 1;
    }
    false
}

#[expect(
    clippy::expect_used,
    reason = "Hangul scalars are computed from validated syllable offsets"
)]
pub(crate) fn normalize_species_search(raw: &str) -> NormalizedSpeciesSearch {
    let contract = contract();
    let mut decomposed = String::with_capacity(raw.len());
    let hangul = &contract.unicode_facts.hangul_decomposition;
    let hangul_scalar_count = hangul.l_count * hangul.v_count * hangul.t_count;
    for character in raw.chars() {
        let scalar = character as u32;
        if !scalar_in_ranges(&contract.unicode_facts.known_scalar_ranges, scalar) {
            decomposed.push(' ');
        } else if let Some(replacement) = contract.decomposition_by_scalar.get(&scalar) {
            decomposed.push_str(replacement);
        } else if let Some(hangul_index) = scalar
            .checked_sub(hangul.s_base)
            .filter(|index| *index < hangul_scalar_count)
        {
            let trailing_index = hangul_index % hangul.t_count;
            let vowel_index = (hangul_index / hangul.t_count) % hangul.v_count;
            let leading_index = hangul_index / (hangul.v_count * hangul.t_count);
            decomposed.push(
                char::from_u32(hangul.l_base + leading_index)
                    .expect("validated Hangul leading scalar"),
            );
            decomposed.push(
                char::from_u32(hangul.v_base + vowel_index).expect("validated Hangul vowel scalar"),
            );
            if trailing_index != 0 {
                decomposed.push(
                    char::from_u32(hangul.t_base + trailing_index)
                        .expect("validated Hangul trailing scalar"),
                );
            }
        } else {
            decomposed.push(character);
        }
    }

    let mut folded = String::with_capacity(decomposed.len());
    for character in decomposed.chars() {
        let scalar = character as u32;
        if scalar_in_ranges(&contract.unicode_facts.mark_scalar_ranges, scalar) {
            continue;
        }
        match contract.lowercase_by_scalar.get(&scalar) {
            Some(replacement) => folded.push_str(replacement),
            None => folded.push(character),
        }
    }
    for replacement in &contract.authority.algorithm.case_folds {
        folded = folded.replace(&replacement.from, &replacement.to);
    }

    let mut tokens = Vec::new();
    let mut token = String::new();
    for character in folded.chars() {
        if character == '_'
            || scalar_in_ranges(
                &contract.unicode_facts.token_scalar_ranges,
                character as u32,
            )
        {
            token.push(character);
        } else if !token.is_empty() {
            tokens.push(std::mem::take(&mut token));
        }
    }
    if !token.is_empty() {
        tokens.push(token);
    }

    let scalar_count = tokens.iter().map(|token| token.chars().count()).sum();
    NormalizedSpeciesSearch {
        text: tokens.join(" "),
        tokens,
        scalar_count,
    }
}

pub(crate) fn species_search_query_tokens(normalized: &NormalizedSpeciesSearch) -> Vec<String> {
    let minimum = contract().authority.algorithm.minimum_admitted_scalar_count;
    if normalized.scalar_count < minimum {
        return Vec::new();
    }
    let mut unique_tokens = Vec::new();
    for token in &normalized.tokens {
        if !unique_tokens.contains(token) {
            unique_tokens.push(token.clone());
        }
    }
    let admitted_tokens = unique_tokens
        .iter()
        .filter(|token| token.chars().count() >= minimum)
        .cloned()
        .collect::<Vec<_>>();
    if admitted_tokens.is_empty() {
        unique_tokens
    } else {
        admitted_tokens
    }
}

pub(crate) fn species_search_admission(raw: &str) -> SpeciesSearchAdmission {
    match normalize_species_search(raw).scalar_count {
        0 => SpeciesSearchAdmission::Browse,
        count if count < contract().authority.algorithm.minimum_admitted_scalar_count => {
            SpeciesSearchAdmission::TooShort
        }
        _ => SpeciesSearchAdmission::ActiveText,
    }
}

pub(super) fn register_sqlite_function(connection: &Connection) -> rusqlite::Result<()> {
    connection.create_scalar_function(
        SQLITE_FUNCTION_NAME,
        1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |context| {
            let raw = context.get::<Option<String>>(0)?;
            Ok(raw.map(|value| normalize_species_search(&value).text))
        },
    )
}

pub(crate) fn normalized_species_search_sql(expression: &str) -> String {
    format!("{SQLITE_FUNCTION_NAME}({expression})")
}

#[cfg(test)]
mod tests {
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

        let error = parse_contract(&serde_json::to_string(&raw).unwrap(), UNICODE_FACTS_SOURCE)
            .unwrap_err();

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
}
