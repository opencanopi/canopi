//! Pure-Rust, `wasm32-unknown-unknown`-clean search text normaliser (ADR 0023, ADR 0027, 2.1-Q51).
//!
//! Reads the pinned Unicode 15.0.0 facts and authored normalization contract from
//! `canopi-types/species-search-normalization.json` and adds hiragana-to-katakana folding
//! (`2.1-Q51`) so hiragana, fullwidth katakana, halfwidth katakana, and voiced/semi-voiced
//! kana forms fold to one canonical katakana key (`りんご` == `リンゴ` == `ﾘﾝｺﾞ`).

#![deny(missing_docs)]

mod contract;

use contract::{LoadedNormalizationContract, parse_contract, scalar_in_ranges};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

pub use contract::{CONTRACT_SOURCE, UNICODE_FACTS_FILENAME, UNICODE_FACTS_SOURCE};

/// Distance between the Unicode Hiragana (`U+3041..=U+3096`, `U+309D..=U+309E`) and
/// Katakana (`U+30A1..=U+30F6`, `U+30FD..=U+30FE`) blocks.
const KANA_BLOCK_OFFSET: u32 = 0x0060;

/// Options controlling search text normalization.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct NormalizeOptions {
    /// Fold hiragana scalars to their katakana counterparts (`2.1-Q51`).
    ///
    /// Enabled by default (`NormalizeOptions::DEFAULT`). Disabled only via
    /// [`NormalizeOptions::V2_COMPAT`] for the pre-N4 v2 SQLite catalog compatibility shim.
    pub fold_kana: bool,
}

impl NormalizeOptions {
    /// Default N4 / `2.1-Q51` normalization (includes kana folding).
    pub const DEFAULT: Self = Self { fold_kana: true };

    /// Pre-N4 v2 contract compatibility mode (omits kana folding so v2 stored names match).
    pub const V2_COMPAT: Self = Self { fold_kana: false };
}

impl Default for NormalizeOptions {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// Result of normalizing raw search input into space-joined tokens.
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct NormalizedSearchText {
    /// Space-joined normalized tokens.
    pub text: String,
    /// Individual normalized tokens in order.
    pub tokens: Vec<String>,
    /// Total Unicode scalar count across all tokens.
    pub scalar_count: usize,
}

/// Whether a raw search query triggers browse mode, is too short, or runs active text search.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SearchAdmission {
    /// Empty or punctuation/mark-only query: show browse ordering.
    Browse,
    /// Non-empty query below the minimum admitted scalar count (and not a single Han/kana scalar).
    TooShort,
    /// Admitted query ready for active text search.
    ActiveText,
}

fn loaded_contract() -> &'static LoadedNormalizationContract {
    static CONTRACT: OnceLock<LoadedNormalizationContract> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        parse_contract(CONTRACT_SOURCE, UNICODE_FACTS_SOURCE)
            .unwrap_or_else(|_| LoadedNormalizationContract::empty())
    })
}

/// Returns the `normalization_version` declared in the embedded normalization contract.
pub fn normalization_version() -> u32 {
    loaded_contract().authority.normalization_version
}

/// Validates a normalization contract JSON string against a Unicode facts JSON string.
///
/// Returns the contract's `normalization_version` on success, or an error description.
pub fn validate_contract(source: &str, unicode_facts_source: &str) -> Result<u32, String> {
    parse_contract(source, unicode_facts_source)
        .map(|loaded| loaded.authority.normalization_version)
}

/// Folds a single Hiragana character to its corresponding Katakana character (`2.1-Q51`).
///
/// Covers `U+3041..=U+3096` (`ぁ`..=`ゖ` -> `ァ`..=`ヶ`) and the iteration marks
/// `U+309D..=U+309E` (`ゝ`, `ゞ` -> `ヽ`, `ヾ`). All other characters are returned unchanged.
pub fn fold_kana_char(character: char) -> char {
    let scalar = u32::from(character);
    if matches!(scalar, 0x3041..=0x3096 | 0x309D..=0x309E) {
        char::from_u32(scalar + KANA_BLOCK_OFFSET).unwrap_or(character)
    } else {
        character
    }
}

/// Normalizes raw search text using the default `2.1-Q51` rules (NFKD, combining-mark strip,
/// lowercase + case folds, kana folding, and Letter/Number/Underscore tokenizing).
pub fn normalize(raw: &str) -> NormalizedSearchText {
    normalize_with_options(raw, NormalizeOptions::DEFAULT)
}

/// Normalizes raw search text using explicit [`NormalizeOptions`].
pub fn normalize_with_options(raw: &str, options: NormalizeOptions) -> NormalizedSearchText {
    let contract = loaded_contract();
    let decomposed = decompose_nfkd(raw, contract);
    let folded = fold_decomposed(&decomposed, contract, options);
    tokenize(&folded, contract)
}

fn decompose_nfkd(raw: &str, contract: &LoadedNormalizationContract) -> String {
    let mut decomposed = String::with_capacity(raw.len());
    let hangul = &contract.unicode_facts.hangul_decomposition;
    let hangul_scalar_count = hangul.l_count * hangul.v_count * hangul.t_count;
    for character in raw.chars() {
        let scalar = u32::from(character);
        if !scalar_in_ranges(&contract.unicode_facts.known_scalar_ranges, scalar) {
            decomposed.push(' ');
        } else if let Some(replacement) = contract.decomposition_by_scalar.get(&scalar) {
            decomposed.push_str(replacement);
        } else if let Some(hangul_index) = scalar
            .checked_sub(hangul.s_base)
            .filter(|index| *index < hangul_scalar_count)
        {
            push_hangul_jamo(&mut decomposed, hangul, hangul_index);
        } else {
            decomposed.push(character);
        }
    }
    decomposed
}

fn push_hangul_jamo(out: &mut String, hangul: &contract::HangulDecomposition, hangul_index: u32) {
    let trailing_index = hangul_index % hangul.t_count;
    let vowel_index = (hangul_index / hangul.t_count) % hangul.v_count;
    let leading_index = hangul_index / (hangul.v_count * hangul.t_count);
    if let Some(leading) = char::from_u32(hangul.l_base + leading_index) {
        out.push(leading);
    }
    if let Some(vowel) = char::from_u32(hangul.v_base + vowel_index) {
        out.push(vowel);
    }
    if trailing_index != 0
        && let Some(trailing) = char::from_u32(hangul.t_base + trailing_index)
    {
        out.push(trailing);
    }
}

fn fold_decomposed(
    decomposed: &str,
    contract: &LoadedNormalizationContract,
    options: NormalizeOptions,
) -> String {
    let mut folded = String::with_capacity(decomposed.len());
    for character in decomposed.chars() {
        let scalar = u32::from(character);
        if scalar_in_ranges(&contract.unicode_facts.mark_scalar_ranges, scalar) {
            continue;
        }
        match contract.lowercase_by_scalar.get(&scalar) {
            Some(replacement) => {
                if options.fold_kana {
                    for lowered in replacement.chars() {
                        folded.push(fold_kana_char(lowered));
                    }
                } else {
                    folded.push_str(replacement);
                }
            }
            None => folded.push(if options.fold_kana {
                fold_kana_char(character)
            } else {
                character
            }),
        }
    }
    for replacement in &contract.authority.algorithm.case_folds {
        folded = folded.replace(&replacement.from, &replacement.to);
    }
    folded
}

fn tokenize(folded: &str, contract: &LoadedNormalizationContract) -> NormalizedSearchText {
    let mut tokens = Vec::new();
    let mut token = String::new();
    for character in folded.chars() {
        if character == '_'
            || scalar_in_ranges(
                &contract.unicode_facts.token_scalar_ranges,
                u32::from(character),
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
    let scalar_count = tokens.iter().map(|entry| entry.chars().count()).sum();
    NormalizedSearchText {
        text: tokens.join(" "),
        tokens,
        scalar_count,
    }
}

/// A token of the minimum length, or one Han or kana scalar (`2.1-Q369`).
fn token_is_admitted(token: &str) -> bool {
    let loaded = loaded_contract();
    let scalar_count = token.chars().count();
    scalar_count >= loaded.authority.algorithm.minimum_admitted_scalar_count
        || (scalar_count == 1
            && token.chars().next().is_some_and(|scalar| {
                scalar_in_ranges(
                    &loaded.unicode_facts.single_scalar_admitted_scalar_ranges,
                    u32::from(scalar),
                )
            }))
}

fn query_is_admitted(normalized: &NormalizedSearchText) -> bool {
    normalized.scalar_count
        >= loaded_contract()
            .authority
            .algorithm
            .minimum_admitted_scalar_count
        || normalized
            .tokens
            .iter()
            .any(|token| token_is_admitted(token))
}

/// Returns the deduplicated query tokens for an admitted normalized query, or empty when
/// the query is not admitted (`Browse` or `TooShort`).
pub fn query_tokens(normalized: &NormalizedSearchText) -> Vec<String> {
    if !query_is_admitted(normalized) {
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
        .filter(|token| token_is_admitted(token))
        .cloned()
        .collect::<Vec<_>>();
    if admitted_tokens.is_empty() {
        unique_tokens
    } else {
        admitted_tokens
    }
}

/// Classifies a raw search query using the default `2.1-Q51` normalization.
pub fn admission(raw: &str) -> SearchAdmission {
    admission_with_options(raw, NormalizeOptions::DEFAULT)
}

/// Classifies a raw search query using explicit [`NormalizeOptions`].
pub fn admission_with_options(raw: &str, options: NormalizeOptions) -> SearchAdmission {
    let normalized = normalize_with_options(raw, options);
    if normalized.scalar_count == 0 {
        SearchAdmission::Browse
    } else if query_is_admitted(&normalized) {
        SearchAdmission::ActiveText
    } else {
        SearchAdmission::TooShort
    }
}
