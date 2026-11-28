use canopi_search_text::{NormalizeOptions, admission_with_options, normalize_with_options};
use rusqlite::{Connection, functions::FunctionFlags};

pub(crate) use canopi_search_text::{
    NormalizedSearchText as NormalizedSpeciesSearch, SearchAdmission as SpeciesSearchAdmission,
    query_tokens as species_search_query_tokens,
};

const SQLITE_FUNCTION_NAME: &str = "canopi_normalize_species_search";

/// Normalizes search text for the desktop v2 SQLite catalog.
///
/// Delegates to [`canopi_search_text`] in `V2_COMPAT` mode until Phase 3 N4 rebuilds the
/// catalog with `2.1-Q51` kana folding enabled by default.
pub(crate) fn normalize_species_search(raw: &str) -> NormalizedSpeciesSearch {
    normalize_with_options(raw, NormalizeOptions::V2_COMPAT)
}

pub(crate) fn species_search_admission(raw: &str) -> SpeciesSearchAdmission {
    admission_with_options(raw, NormalizeOptions::V2_COMPAT)
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
mod tests;
