use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt::Write as _;
use std::path::Path;

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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NormalizationAlgorithm {
    compatibility_decomposition: String,
    stripped_general_categories: Vec<String>,
    token_character_classes: Vec<String>,
    case_folds: Vec<CaseFold>,
    minimum_admitted_scalar_count: u32,
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

pub(crate) fn render_typescript_adapter(
    authority_path: &Path,
) -> Result<String, Box<dyn std::error::Error>> {
    let source = std::fs::read_to_string(authority_path)?;
    let raw: serde_json::Value = serde_json::from_str(&source)?;
    let contract: NormalizationContract = serde_json::from_value(raw.clone())?;
    let facts_path = authority_path
        .parent()
        .ok_or("Species Search authority must have a parent directory")?
        .join(&contract.unicode_data.facts_file);
    let facts_source = std::fs::read_to_string(&facts_path)?;
    let raw_facts: serde_json::Value = serde_json::from_str(&facts_source)?;
    let unicode_facts: UnicodeFacts = serde_json::from_value(raw_facts.clone())?;
    validate(&contract, &unicode_facts)?;

    let canonical = serde_json::to_vec(&serde_json::json!({
        "authority": raw,
        "unicode_facts": raw_facts,
    }))?;
    let fingerprint = format!("{:x}", Sha256::digest(canonical));
    Ok(render_typescript(&contract, &unicode_facts, &fingerprint)?)
}

fn validate(
    contract: &NormalizationContract,
    unicode_facts: &UnicodeFacts,
) -> Result<(), Box<dyn std::error::Error>> {
    if contract.contract_format_version != 1 {
        return Err(format!(
            "unsupported Species Search normalization contract format {}",
            contract.contract_format_version
        )
        .into());
    }
    if contract.normalization_version == 0 {
        return Err("Species Search normalization version must be positive".into());
    }
    if contract.unicode_data.version.is_empty()
        || contract.unicode_data.facts_file.is_empty()
        || Path::new(&contract.unicode_data.facts_file).file_name()
            != Some(contract.unicode_data.facts_file.as_ref())
        || unicode_facts.facts_format_version != 2
        || unicode_facts.unicode_data_version != contract.unicode_data.version
    {
        return Err("Species Search Unicode facts do not match the authority".into());
    }
    validate_scalar_ranges("known", &unicode_facts.known_scalar_ranges)?;
    validate_scalar_ranges("mark", &unicode_facts.mark_scalar_ranges)?;
    validate_scalar_ranges("token", &unicode_facts.token_scalar_ranges)?;
    for (label, ranges) in [
        ("mark", &unicode_facts.mark_scalar_ranges),
        ("token", &unicode_facts.token_scalar_ranges),
    ] {
        for [start, end] in ranges {
            if !scalar_range_is_covered(&unicode_facts.known_scalar_ranges, *start, *end) {
                return Err(format!(
                    "Species Search {label} ranges must contain only known scalars"
                )
                .into());
            }
        }
    }
    let hangul = &unicode_facts.hangul_decomposition;
    if hangul != &STANDARD_HANGUL_DECOMPOSITION {
        return Err("Species Search facts must contain the standard Hangul decomposition".into());
    }
    let hangul_scalar_count = hangul
        .l_count
        .checked_mul(hangul.v_count)
        .and_then(|count| count.checked_mul(hangul.t_count))
        .ok_or("Species Search Hangul decomposition scalar count overflowed")?;
    let hangul_end = hangul
        .s_base
        .checked_add(hangul_scalar_count)
        .ok_or("Species Search Hangul decomposition range overflowed")?;
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
        return Err("Species Search Hangul syllable range must contain only known scalars".into());
    }
    validate_mappings(
        "compatibility decomposition",
        &unicode_facts.compatibility_decomposition_mappings,
        &unicode_facts.known_scalar_ranges,
    )?;
    validate_mappings(
        "lowercase",
        &unicode_facts.lowercase_mappings,
        &unicode_facts.known_scalar_ranges,
    )?;
    let algorithm = &contract.algorithm;
    if algorithm.compatibility_decomposition != "NFKD" {
        return Err("Species Search normalization decomposition must be NFKD".into());
    }
    if algorithm.stripped_general_categories != ["Mn", "Mc", "Me"] {
        return Err("Species Search normalization stripped categories must be Mn, Mc, Me".into());
    }
    if algorithm.token_character_classes != ["Letter", "Number", "Underscore"] {
        return Err(
            "Species Search normalization token classes must be Letter, Number, Underscore".into(),
        );
    }
    if algorithm.minimum_admitted_scalar_count == 0 {
        return Err("Species Search admission scalar count must be positive".into());
    }
    if algorithm.query_token_policy != "unique-admitted-or-all-when-active" {
        return Err("Species Search query-token policy is unsupported".into());
    }

    let mut fold_sources = HashSet::new();
    for case_fold in &algorithm.case_folds {
        if case_fold.from.is_empty() || case_fold.to.is_empty() {
            return Err("Species Search case folds must contain nonempty text".into());
        }
        if !fold_sources.insert(case_fold.from.as_str()) {
            return Err(format!(
                "duplicate Species Search case-fold source {:?}",
                case_fold.from
            )
            .into());
        }
    }

    let mut corpus_names = HashSet::new();
    for case in &contract.corpus {
        if case.name.is_empty() || !corpus_names.insert(case.name.as_str()) {
            return Err(format!(
                "Species Search corpus case names must be nonempty and unique: {:?}",
                case.name
            )
            .into());
        }
        if !matches!(
            case.admission.as_str(),
            "browse" | "too-short" | "active-text"
        ) {
            return Err(format!(
                "Species Search corpus case {:?} has invalid admission {:?}",
                case.name, case.admission
            )
            .into());
        }
    }
    Ok(())
}

fn validate_mappings(
    label: &str,
    mappings: &[(u32, String)],
    known_ranges: &[[u32; 2]],
) -> Result<(), Box<dyn std::error::Error>> {
    if mappings.is_empty() {
        return Err(format!("Species Search {label} mappings must not be empty").into());
    }
    let mut previous_mapping = None;
    for (scalar, target) in mappings {
        if target.is_empty()
            || previous_mapping.is_some_and(|previous| *scalar <= previous)
            || !scalar_in_ranges(known_ranges, *scalar)
            || target
                .chars()
                .any(|character| !scalar_in_ranges(known_ranges, character as u32))
        {
            return Err(
                format!("Species Search {label} mappings must be ordered known scalars").into(),
            );
        }
        previous_mapping = Some(*scalar);
    }
    Ok(())
}

fn validate_scalar_ranges(
    label: &str,
    ranges: &[[u32; 2]],
) -> Result<(), Box<dyn std::error::Error>> {
    if ranges.is_empty() {
        return Err(format!("Species Search {label} scalar ranges must not be empty").into());
    }
    let mut previous_end = None;
    for [start, end] in ranges {
        if start > end
            || *end > char::MAX as u32
            || previous_end.is_some_and(|previous| *start <= previous)
            || (*start <= 0xDFFF && *end >= 0xD800)
        {
            return Err(format!(
                "Species Search {label} scalar ranges must be ordered scalar values"
            )
            .into());
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

fn render_typescript(
    contract: &NormalizationContract,
    unicode_facts: &UnicodeFacts,
    fingerprint: &str,
) -> Result<String, std::fmt::Error> {
    let mut output = String::from(concat!(
        "// Generated by `cd desktop/web && npm run gen:types`.\n",
        "// Do not edit by hand.\n\n",
        "export type SpeciesSearchAdmission = 'browse' | 'too-short' | 'active-text'\n\n",
        "export interface SpeciesSearchNormalizationCorpusCase {\n",
        "  readonly name: string\n",
        "  readonly input: string\n",
        "  readonly normalizedText: string\n",
        "  readonly tokens: readonly string[]\n",
        "  readonly queryTokens: readonly string[]\n",
        "  readonly admission: SpeciesSearchAdmission\n",
        "}\n\n",
    ));
    writeln!(
        output,
        "export const SPECIES_SEARCH_NORMALIZATION_VERSION = {} as const",
        contract.normalization_version
    )?;
    writeln!(
        output,
        "export const SPECIES_SEARCH_NORMALIZATION_FINGERPRINT = {} as const",
        json_string(fingerprint)
    )?;
    writeln!(
        output,
        "export const SPECIES_SEARCH_UNICODE_DATA_VERSION = {} as const\n",
        json_string(&unicode_facts.unicode_data_version)
    )?;
    writeln!(
        output,
        "export const SPECIES_SEARCH_MINIMUM_ADMITTED_SCALAR_COUNT = {} as const\n",
        contract.algorithm.minimum_admitted_scalar_count
    )?;
    writeln!(
        output,
        "export const SPECIES_SEARCH_QUERY_TOKEN_POLICY = {} as const\n",
        json_string(&contract.algorithm.query_token_policy)
    )?;

    output.push_str("export const SPECIES_SEARCH_CASE_FOLDS = [\n");
    for case_fold in &contract.algorithm.case_folds {
        writeln!(
            output,
            "  {{ from: {}, to: {} }},",
            json_string(&case_fold.from),
            json_string(&case_fold.to),
        )?;
    }
    output.push_str("] as const\n\n");

    render_scalar_ranges(
        &mut output,
        "SPECIES_SEARCH_KNOWN_SCALAR_RANGES",
        &unicode_facts.known_scalar_ranges,
    )?;
    render_scalar_ranges(
        &mut output,
        "SPECIES_SEARCH_MARK_SCALAR_RANGES",
        &unicode_facts.mark_scalar_ranges,
    )?;
    render_scalar_ranges(
        &mut output,
        "SPECIES_SEARCH_TOKEN_SCALAR_RANGES",
        &unicode_facts.token_scalar_ranges,
    )?;
    let hangul = &unicode_facts.hangul_decomposition;
    writeln!(
        output,
        "export const SPECIES_SEARCH_HANGUL_DECOMPOSITION = {{"
    )?;
    writeln!(output, "  sBase: {},", hangul.s_base)?;
    writeln!(output, "  lBase: {},", hangul.l_base)?;
    writeln!(output, "  vBase: {},", hangul.v_base)?;
    writeln!(output, "  tBase: {},", hangul.t_base)?;
    writeln!(output, "  lCount: {},", hangul.l_count)?;
    writeln!(output, "  vCount: {},", hangul.v_count)?;
    writeln!(output, "  tCount: {},", hangul.t_count)?;
    output.push_str("} as const\n\n");
    render_scalar_mappings(
        &mut output,
        "SPECIES_SEARCH_COMPATIBILITY_DECOMPOSITION_MAPPINGS",
        &unicode_facts.compatibility_decomposition_mappings,
    )?;
    render_scalar_mappings(
        &mut output,
        "SPECIES_SEARCH_LOWERCASE_MAPPINGS",
        &unicode_facts.lowercase_mappings,
    )?;

    output.push_str("export const SPECIES_SEARCH_NORMALIZATION_CORPUS = [\n");
    for case in &contract.corpus {
        writeln!(output, "  {{")?;
        writeln!(output, "    name: {},", json_string(&case.name))?;
        writeln!(output, "    input: {},", json_string(&case.input))?;
        writeln!(
            output,
            "    normalizedText: {},",
            json_string(&case.normalized_text)
        )?;
        writeln!(output, "    tokens: {},", render_string_array(&case.tokens))?;
        writeln!(
            output,
            "    queryTokens: {},",
            render_string_array(&case.query_tokens)
        )?;
        writeln!(output, "    admission: {},", json_string(&case.admission))?;
        writeln!(output, "  }},")?;
    }
    output.push_str("] as const satisfies readonly SpeciesSearchNormalizationCorpusCase[]\n");
    Ok(output)
}

fn render_scalar_mappings(
    output: &mut String,
    name: &str,
    mappings: &[(u32, String)],
) -> Result<(), std::fmt::Error> {
    writeln!(output, "export const {name} = [")?;
    for (scalar, target) in mappings {
        writeln!(output, "  [{scalar}, {}],", json_string(target))?;
    }
    output.push_str("] as const satisfies readonly (readonly [number, string])[]\n\n");
    Ok(())
}

fn render_scalar_ranges(
    output: &mut String,
    name: &str,
    ranges: &[[u32; 2]],
) -> Result<(), std::fmt::Error> {
    writeln!(output, "export const {name} = [")?;
    for [start, end] in ranges {
        writeln!(output, "  [{start}, {end}],")?;
    }
    output.push_str("] as const satisfies readonly (readonly [number, number])[]\n\n");
    Ok(())
}

/// `value` as a JSON string literal; serialising a `&str` cannot fail.
fn json_string(value: &str) -> String {
    serde_json::Value::from(value).to_string()
}

fn render_string_array(values: &[String]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(|value| json_string(value))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
            render_typescript_adapter(&root.join("common-types/species-search-normalization.json"))
                .unwrap();

        assert!(rendered.contains("SPECIES_SEARCH_NORMALIZATION_VERSION = 1"));
        assert!(rendered.contains("greek-final-sigma"));
        assert!(rendered.contains("σισυφοσ"));
    }

    #[test]
    fn bindings_validation_rejects_property_ranges_outside_known_scalars() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let authority: NormalizationContract = serde_json::from_str(
            &std::fs::read_to_string(root.join("common-types/species-search-normalization.json"))
                .unwrap(),
        )
        .unwrap();
        let mut facts: UnicodeFacts = serde_json::from_str(
            &std::fs::read_to_string(root.join("common-types/species-search-unicode-15.json"))
                .unwrap(),
        )
        .unwrap();
        facts.mark_scalar_ranges = vec![[0x10FFFF, 0x10FFFF]];

        let error = validate(&authority, &facts).unwrap_err().to_string();

        assert!(error.contains("known scalars"), "{error}");
    }

    #[test]
    fn bindings_validation_rejects_nonstandard_hangul_facts() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let authority: NormalizationContract = serde_json::from_str(
            &std::fs::read_to_string(root.join("common-types/species-search-normalization.json"))
                .unwrap(),
        )
        .unwrap();
        let mut facts: UnicodeFacts = serde_json::from_str(
            &std::fs::read_to_string(root.join("common-types/species-search-unicode-15.json"))
                .unwrap(),
        )
        .unwrap();
        facts.hangul_decomposition.l_base = 1;

        let error = validate(&authority, &facts).unwrap_err().to_string();

        assert!(error.contains("standard Hangul"), "{error}");
    }

    #[test]
    fn bindings_validation_rejects_property_range_spanning_unknown_gap() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let authority: NormalizationContract = serde_json::from_str(
            &std::fs::read_to_string(root.join("common-types/species-search-normalization.json"))
                .unwrap(),
        )
        .unwrap();
        let mut facts: UnicodeFacts = serde_json::from_str(
            &std::fs::read_to_string(root.join("common-types/species-search-unicode-15.json"))
                .unwrap(),
        )
        .unwrap();
        facts.mark_scalar_ranges = vec![[887, 890]];

        let error = validate(&authority, &facts).unwrap_err().to_string();

        assert!(error.contains("known scalars"), "{error}");
    }

    #[test]
    fn bindings_validation_requires_known_hangul_syllable_range() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let authority: NormalizationContract = serde_json::from_str(
            &std::fs::read_to_string(root.join("common-types/species-search-normalization.json"))
                .unwrap(),
        )
        .unwrap();
        let mut facts: UnicodeFacts = serde_json::from_str(
            &std::fs::read_to_string(root.join("common-types/species-search-unicode-15.json"))
                .unwrap(),
        )
        .unwrap();
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
}
