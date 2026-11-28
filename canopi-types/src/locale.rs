//! Single-source-of-truth locale registry (L6, contracts §14).
//!
//! Every supported UI and catalog locale is declared once in [`LOCALES`].
//! `bindings-gen` emits the TypeScript locale registry and static
//! `translate_value` SQL queries from this table.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::settings::Locale;

/// Fallback first weekday when `Intl.Locale` week info is unavailable
/// (older WebKit), matching `Date.getDay()` numbering (`0` Sunday, `1` Monday).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum WeekStart {
    /// Sunday (`0`).
    Sunday,
    /// Monday (`1`).
    Monday,
}

impl WeekStart {
    /// First weekday as a JS `Date.getDay()` number (`0` Sunday, `1` Monday).
    #[must_use]
    pub const fn js_day(self) -> u8 {
        match self {
            Self::Sunday => 0,
            Self::Monday => 1,
        }
    }
}

/// CLDR cardinal plural category for a locale, matching `Intl.PluralRules`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum PluralCategory {
    /// Zero form.
    Zero,
    /// Singular form.
    One,
    /// Dual form.
    Two,
    /// Few form (e.g. Russian 2–4).
    Few,
    /// Many form (e.g. French/Spanish/Portuguese/Italian 1M+, Russian 5+).
    Many,
    /// General/other form.
    Other,
}

impl PluralCategory {
    /// Lowercase CLDR / `Intl.PluralRules` category name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Zero => "zero",
            Self::One => "one",
            Self::Two => "two",
            Self::Few => "few",
            Self::Many => "many",
            Self::Other => "other",
        }
    }
}

/// Metadata for one supported Canopi locale (contracts §14, L6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocaleSpec {
    /// Closed `Locale` enum variant.
    pub locale: Locale,
    /// Lowercase primary language subtag (e.g. `"en"`, `"fr"`).
    pub code: &'static str,
    /// Canonical BCP-47 language tag passed to `Intl` APIs.
    pub bcp47: &'static str,
    /// Native language name shown in the Settings language picker.
    pub endonym: &'static str,
    /// Column name in the species catalog `translated_values` table (`value_*`).
    pub catalog_column: &'static str,
    /// Fallback first day of the week when `Intl.Locale` lacks week info.
    pub week_start_fallback: WeekStart,
    /// Cardinal plural categories required for counted i18n strings.
    pub plural_categories: &'static [PluralCategory],
    /// Display order in the Settings language picker (Latin, Cyrillic, CJK).
    pub picker_rank: u8,
}

const PLURALS_ONE_OTHER: &[PluralCategory] = &[PluralCategory::One, PluralCategory::Other];
const PLURALS_ONE_MANY_OTHER: &[PluralCategory] = &[
    PluralCategory::One,
    PluralCategory::Many,
    PluralCategory::Other,
];
const PLURALS_OTHER_ONLY: &[PluralCategory] = &[PluralCategory::Other];
const PLURALS_RUSSIAN: &[PluralCategory] = &[
    PluralCategory::One,
    PluralCategory::Few,
    PluralCategory::Many,
    PluralCategory::Other,
];

/// Every supported Canopi locale in canonical order, matching [`Locale::ALL`].
pub const LOCALES: &[LocaleSpec] = &[
    LocaleSpec {
        locale: Locale::En,
        code: "en",
        bcp47: "en",
        endonym: "English",
        catalog_column: "value_en",
        week_start_fallback: WeekStart::Sunday,
        plural_categories: PLURALS_ONE_OTHER,
        picker_rank: 0,
    },
    LocaleSpec {
        locale: Locale::Fr,
        code: "fr",
        bcp47: "fr",
        endonym: "Français",
        catalog_column: "value_fr",
        week_start_fallback: WeekStart::Monday,
        plural_categories: PLURALS_ONE_MANY_OTHER,
        picker_rank: 1,
    },
    LocaleSpec {
        locale: Locale::Es,
        code: "es",
        bcp47: "es",
        endonym: "Español",
        catalog_column: "value_es",
        week_start_fallback: WeekStart::Monday,
        plural_categories: PLURALS_ONE_MANY_OTHER,
        picker_rank: 2,
    },
    LocaleSpec {
        locale: Locale::Pt,
        code: "pt",
        bcp47: "pt",
        endonym: "Português",
        catalog_column: "value_pt",
        week_start_fallback: WeekStart::Sunday,
        plural_categories: PLURALS_ONE_MANY_OTHER,
        picker_rank: 3,
    },
    LocaleSpec {
        locale: Locale::It,
        code: "it",
        bcp47: "it",
        endonym: "Italiano",
        catalog_column: "value_it",
        week_start_fallback: WeekStart::Monday,
        plural_categories: PLURALS_ONE_MANY_OTHER,
        picker_rank: 4,
    },
    LocaleSpec {
        locale: Locale::Zh,
        code: "zh",
        bcp47: "zh",
        endonym: "中文",
        catalog_column: "value_zh",
        week_start_fallback: WeekStart::Monday,
        plural_categories: PLURALS_OTHER_ONLY,
        picker_rank: 8,
    },
    LocaleSpec {
        locale: Locale::De,
        code: "de",
        bcp47: "de",
        endonym: "Deutsch",
        catalog_column: "value_de",
        week_start_fallback: WeekStart::Monday,
        plural_categories: PLURALS_ONE_OTHER,
        picker_rank: 5,
    },
    LocaleSpec {
        locale: Locale::Ja,
        code: "ja",
        bcp47: "ja",
        endonym: "日本語",
        catalog_column: "value_ja",
        week_start_fallback: WeekStart::Sunday,
        plural_categories: PLURALS_OTHER_ONLY,
        picker_rank: 9,
    },
    LocaleSpec {
        locale: Locale::Ko,
        code: "ko",
        bcp47: "ko",
        endonym: "한국어",
        catalog_column: "value_ko",
        week_start_fallback: WeekStart::Sunday,
        plural_categories: PLURALS_OTHER_ONLY,
        picker_rank: 10,
    },
    LocaleSpec {
        locale: Locale::Nl,
        code: "nl",
        bcp47: "nl",
        endonym: "Nederlands",
        catalog_column: "value_nl",
        week_start_fallback: WeekStart::Monday,
        plural_categories: PLURALS_ONE_OTHER,
        picker_rank: 6,
    },
    LocaleSpec {
        locale: Locale::Ru,
        code: "ru",
        bcp47: "ru",
        endonym: "Русский",
        catalog_column: "value_ru",
        week_start_fallback: WeekStart::Monday,
        plural_categories: PLURALS_RUSSIAN,
        picker_rank: 7,
    },
];

/// Returns the registry entry for `locale`.
///
/// Exhaustive over [`Locale`] so adding a variant requires a matching row in
/// [`LOCALES`].
#[must_use]
pub const fn spec_for(locale: Locale) -> &'static LocaleSpec {
    let index = match locale {
        Locale::En => 0,
        Locale::Fr => 1,
        Locale::Es => 2,
        Locale::Pt => 3,
        Locale::It => 4,
        Locale::Zh => 5,
        Locale::De => 6,
        Locale::Ja => 7,
        Locale::Ko => 8,
        Locale::Nl => 9,
        Locale::Ru => 10,
    };
    &LOCALES[index]
}

/// Looks up a locale by its exact lowercase primary code (e.g. `"fr"`).
#[must_use]
pub fn from_code(code: &str) -> Option<Locale> {
    LOCALES
        .iter()
        .find(|spec| spec.code == code)
        .map(|spec| spec.locale)
}

/// First-run language matcher (contracts §14, 2.1-Q345).
///
/// Takes an ordered list of BCP-47 / POSIX locale tags (e.g. `[sys_locale]` on
/// Desktop or `navigator.languages` on Web) and returns the first tag whose
/// primary language subtag (ASCII case-folded, split on `-`, `_`, or `.`) is a
/// registered locale code.
#[must_use]
pub fn match_locale<'a>(tags: impl IntoIterator<Item = &'a str>) -> Option<Locale> {
    for tag in tags {
        let primary = tag
            .trim()
            .split(['-', '_', '.'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if let Some(locale) = from_code(&primary) {
            return Some(locale);
        }
    }
    None
}

/// Like [`match_locale`], falling back to [`Locale::En`] when no tag matches.
#[must_use]
pub fn match_locale_or_default<'a>(tags: impl IntoIterator<Item = &'a str>) -> Locale {
    match_locale(tags).unwrap_or(Locale::En)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use serde::Deserialize;

    use super::{LOCALES, from_code, match_locale, match_locale_or_default, spec_for};
    use crate::settings::Locale;

    #[derive(Deserialize)]
    struct MatchCorpusCase {
        tags: Vec<String>,
        expected: Option<String>,
    }

    #[test]
    fn registry_covers_every_locale_in_order_with_valid_metadata() {
        assert_eq!(LOCALES.len(), Locale::ALL.len());
        let mut codes = HashSet::new();
        let mut ranks = HashSet::new();
        for (spec, expected) in LOCALES.iter().zip(Locale::ALL.iter()) {
            assert_eq!(spec.locale, *expected);
            assert_eq!(spec_for(*expected), spec);
            assert_eq!(from_code(spec.code), Some(*expected));
            assert!(codes.insert(spec.code), "duplicate code {}", spec.code);
            assert!(
                ranks.insert(spec.picker_rank),
                "duplicate picker_rank {}",
                spec.picker_rank
            );
            assert!(
                usize::from(spec.picker_rank) < LOCALES.len(),
                "picker_rank {} out of range",
                spec.picker_rank
            );
            assert_eq!(spec.catalog_column, format!("value_{}", spec.code));
            assert!(!spec.endonym.is_empty());
            assert!(!spec.bcp47.is_empty());
            assert!(!spec.plural_categories.is_empty());
        }
    }

    #[test]
    fn match_locale_handles_shared_tag_corpus() {
        let cases: Vec<MatchCorpusCase> =
            serde_json::from_str(include_str!("../fixtures/locale-match-corpus.json"))
                .expect("locale-match-corpus.json must deserialize");
        assert!(!cases.is_empty());
        for case in &cases {
            let expected = case.expected.as_deref().and_then(from_code);
            let tags = case.tags.iter().map(String::as_str);
            assert_eq!(
                match_locale(tags.clone()),
                expected,
                "match_locale({:?})",
                case.tags
            );
            assert_eq!(
                match_locale_or_default(tags),
                expected.unwrap_or(Locale::En),
                "match_locale_or_default({:?})",
                case.tags
            );
        }
    }
}
