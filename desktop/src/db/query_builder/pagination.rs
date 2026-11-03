use canopi_types::species::{Sort, SpeciesListItem};
use rusqlite::Row;
use rusqlite::types::Value;

use super::cursor::{decode_cursor, encode_cursor};
use super::sql::SqlBuilder;

#[derive(Debug, Clone)]
pub(super) enum SpeciesSearchPagePlan {
    RelevanceOffset { current_offset: u32 },
    Browse(BrowsePlan),
}

impl SpeciesSearchPagePlan {
    pub(super) fn for_request(sort: &Sort, cursor: Option<&str>, has_search_term: bool) -> Self {
        if matches!(sort, Sort::Relevance) && has_search_term {
            return Self::RelevanceOffset {
                current_offset: decode_relevance_offset(cursor).unwrap_or(0),
            };
        }

        Self::Browse(BrowsePlan::for_request(sort, cursor))
    }

    pub(super) fn limit_clause(&self, limit: u32, sql_builder: &mut SqlBuilder) -> String {
        let limit_placeholder = sql_builder.bind_integer((limit + 1) as i64);
        let offset_clause = match self {
            Self::RelevanceOffset { current_offset } if *current_offset > 0 => {
                let offset_placeholder = sql_builder.bind_integer(*current_offset as i64);
                format!(" OFFSET {offset_placeholder}")
            }
            _ => String::new(),
        };
        format!("LIMIT {limit_placeholder}{offset_clause}")
    }

    pub(super) fn result_window_end(&self, limit: u32) -> u32 {
        let offset = match self {
            Self::RelevanceOffset { current_offset } => *current_offset,
            Self::Browse(_) => 0,
        };
        offset.saturating_add(limit).saturating_add(1)
    }

    pub(super) fn is_browse(&self) -> bool {
        matches!(self, Self::Browse(_))
    }

    pub(super) fn next_cursor(
        &self,
        items: &[SpeciesListItem],
        last_position: Option<&BrowsePosition>,
        has_next: bool,
    ) -> Option<String> {
        if !has_next {
            return None;
        }

        match self {
            Self::RelevanceOffset { current_offset } => {
                Some(format!("offset:{}", current_offset + items.len() as u32))
            }
            Self::Browse(_) => {
                let last = items.last()?;
                let position = last_position?;
                let sort_key = position.sort_key.map(BrowseKeyValue::to_cursor_text);
                Some(encode_cursor(
                    position.phase,
                    sort_key.as_deref(),
                    &last.canonical_name,
                ))
            }
        }
    }
}

/// Where a browse row sits in its plan: the phase index and the phase's sort
/// key. Browse list statements expose both as `page_phase` and `page_sort_key`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BrowsePosition {
    phase: usize,
    sort_key: Option<BrowseKeyValue>,
}

impl BrowsePosition {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let phase = row.get::<_, i64>("page_phase")?;
        let sort_key = match row.get::<_, Value>("page_sort_key")? {
            Value::Null => None,
            Value::Integer(value) => Some(BrowseKeyValue::Integer(value)),
            Value::Real(value) => Some(BrowseKeyValue::Real(value)),
            other => {
                return Err(rusqlite::Error::InvalidColumnType(
                    0,
                    "page_sort_key".to_owned(),
                    other.data_type(),
                ));
            }
        };
        Ok(Self {
            phase: usize::try_from(phase)
                .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, phase))?,
            sort_key,
        })
    }

    #[cfg(test)]
    pub(crate) fn new(phase: usize, sort_key: Option<BrowseKeyValue>) -> Self {
        Self { phase, sort_key }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BrowseKeyValue {
    Integer(i64),
    Real(f64),
}

impl BrowseKeyValue {
    fn to_cursor_text(self) -> String {
        match self {
            Self::Integer(value) => value.to_string(),
            Self::Real(value) => value.to_string(),
        }
    }
}

/// Numeric browse keys, always sorted descending with Canonical Name as the
/// ascending tiebreaker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrowseKey {
    /// Edibility, then other uses, then medicinal (each rated 0-5).
    RecommendedScore,
    Edibility,
    Height,
}

impl BrowseKey {
    fn sql(self) -> &'static str {
        match self {
            Self::RecommendedScore => {
                "(s.edibility_rating * 36 + COALESCE(s.other_uses_rating, 0) * 6 + COALESCE(s.medicinal_rating, 0))"
            }
            Self::Edibility => "s.edibility_rating",
            Self::Height => "s.height_max_m",
        }
    }

    fn parse(self, text: &str) -> Option<BrowseKeyValue> {
        match self {
            Self::RecommendedScore | Self::Edibility => {
                text.parse::<i64>().ok().map(BrowseKeyValue::Integer)
            }
            Self::Height => text
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .map(BrowseKeyValue::Real),
        }
    }
}

/// Phase membership. The unary `+` on the IS NULL phases keeps SQLite off the
/// rating/height index so it walks `idx_species_canonical` in name order;
/// `>= 0` (not IS NOT NULL) lets it range-scan `idx_species_edibility`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PhaseFilter {
    All,
    EdibilityRated,
    EdibilityUnrated,
    EdibilityUnratedNamed,
    EdibilityUnratedUnnamed,
    HeightKnown,
    HeightUnknown,
}

impl PhaseFilter {
    fn sql(self, locale_placeholder: &str) -> Option<String> {
        let named = format!(
            "EXISTS (SELECT 1 FROM best_common_names b \
             WHERE b.species_id = s.id AND b.language = {locale_placeholder})"
        );
        match self {
            Self::All => None,
            Self::EdibilityRated => Some("s.edibility_rating >= 0".to_owned()),
            Self::EdibilityUnrated => Some("+s.edibility_rating IS NULL".to_owned()),
            Self::EdibilityUnratedNamed => Some(format!("+s.edibility_rating IS NULL AND {named}")),
            Self::EdibilityUnratedUnnamed => {
                Some(format!("+s.edibility_rating IS NULL AND NOT {named}"))
            }
            Self::HeightKnown => Some("s.height_max_m IS NOT NULL".to_owned()),
            Self::HeightUnknown => Some("+s.height_max_m IS NULL".to_owned()),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct BrowsePhase {
    filter: PhaseFilter,
    key: Option<BrowseKey>,
}

impl BrowsePhase {
    const fn by_name(filter: PhaseFilter) -> Self {
        Self { filter, key: None }
    }

    const fn by_key(filter: PhaseFilter, key: BrowseKey) -> Self {
        Self {
            filter,
            key: Some(key),
        }
    }

    pub(super) fn predicate_sql(&self, locale_placeholder: &str) -> Option<String> {
        self.filter.sql(locale_placeholder)
    }

    pub(super) fn key_sql(&self) -> &'static str {
        self.key.map(BrowseKey::sql).unwrap_or("NULL")
    }

    pub(super) fn order_by_sql(&self) -> String {
        match self.key {
            Some(key) => format!("ORDER BY {} DESC, s.canonical_name", key.sql()),
            None => "ORDER BY s.canonical_name".to_owned(),
        }
    }
}

const NAME_PHASES: &[BrowsePhase] = &[BrowsePhase::by_name(PhaseFilter::All)];

const RECOMMENDED_PHASES: &[BrowsePhase] = &[
    BrowsePhase::by_key(PhaseFilter::EdibilityRated, BrowseKey::RecommendedScore),
    BrowsePhase::by_name(PhaseFilter::EdibilityUnratedNamed),
    BrowsePhase::by_name(PhaseFilter::EdibilityUnratedUnnamed),
];

const HEIGHT_PHASES: &[BrowsePhase] = &[
    BrowsePhase::by_key(PhaseFilter::HeightKnown, BrowseKey::Height),
    BrowsePhase::by_name(PhaseFilter::HeightUnknown),
];

const EDIBILITY_PHASES: &[BrowsePhase] = &[
    BrowsePhase::by_key(PhaseFilter::EdibilityRated, BrowseKey::Edibility),
    BrowsePhase::by_name(PhaseFilter::EdibilityUnrated),
];

#[derive(Debug, Clone)]
struct BrowseStart {
    phase: usize,
    sort_key: Option<BrowseKeyValue>,
    canonical_name: String,
}

/// A keyset browse: ordered phases, each an index-friendly subquery. A cursor
/// resumes inside its phase; earlier phases are skipped.
#[derive(Debug, Clone)]
pub(super) struct BrowsePlan {
    phases: &'static [BrowsePhase],
    start: Option<BrowseStart>,
}

impl BrowsePlan {
    fn for_request(sort: &Sort, cursor: Option<&str>) -> Self {
        let phases = match sort {
            Sort::Recommended => RECOMMENDED_PHASES,
            Sort::Height => HEIGHT_PHASES,
            Sort::Edibility => EDIBILITY_PHASES,
            Sort::Name | Sort::Relevance => NAME_PHASES,
        };
        let start = cursor.and_then(|cursor| decode_start(phases, cursor));
        Self { phases, start }
    }

    pub(super) fn remaining_phases(&self) -> impl Iterator<Item = (usize, &BrowsePhase)> {
        let first = self.start.as_ref().map_or(0, |start| start.phase);
        self.phases.iter().enumerate().skip(first)
    }

    /// The keyset restriction for `phase`, when the cursor points into it.
    pub(super) fn cursor_clause(
        &self,
        phase: usize,
        sql_builder: &mut SqlBuilder,
    ) -> Option<String> {
        let start = self.start.as_ref().filter(|start| start.phase == phase)?;
        let name_placeholder = sql_builder.bind_text(start.canonical_name.clone());
        let Some((key, value)) = self.phases[phase].key.zip(start.sort_key) else {
            return Some(format!("s.canonical_name > {name_placeholder}"));
        };
        let value_placeholder = match value {
            BrowseKeyValue::Integer(value) => sql_builder.bind_integer(value),
            BrowseKeyValue::Real(value) => sql_builder.bind_real(value),
        };
        let key_sql = key.sql();
        // `K <= v AND (K < v OR name > n)` keeps the index range scan; a
        // row-value or `K = v AND` form falls back to a full sort.
        Some(format!(
            "{key_sql} <= {value_placeholder} \
             AND ({key_sql} < {value_placeholder} OR s.canonical_name > {name_placeholder})"
        ))
    }
}

/// A cursor that does not fit this plan's phases starts the browse over.
fn decode_start(phases: &[BrowsePhase], cursor: &str) -> Option<BrowseStart> {
    let (phase, sort_key, canonical_name) = decode_cursor(cursor)?;
    let sort_key = match (phases.get(phase)?.key, sort_key) {
        (Some(key), Some(text)) => Some(key.parse(&text)?),
        (None, None) => None,
        _ => return None,
    };
    Some(BrowseStart {
        phase,
        sort_key,
        canonical_name,
    })
}

fn decode_relevance_offset(cursor: Option<&str>) -> Option<u32> {
    let raw = cursor?;
    raw.strip_prefix("offset:")
        .unwrap_or(raw)
        .parse::<u32>()
        .ok()
}
