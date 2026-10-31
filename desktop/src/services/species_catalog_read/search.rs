use common_types::species::{PaginatedResult, SpeciesListItem, SpeciesSearchRequest};
use rusqlite::{Connection, params_from_iter};

use crate::db::PlantDbConnectionGuard;
use crate::db::query_builder::{BrowsePosition, SpeciesSearchPlan, SpeciesSearchPlanRequest};
use crate::db::species_search_normalization::{SpeciesSearchAdmission, species_search_admission};

use super::list_projection::map_species_list_row;

/// Searches species using FTS5, structured filters, or both.
///
/// Returns a paginated result. Pass the `next_cursor` from a previous result
/// to fetch the next page.
fn search_connection(
    conn: &Connection,
    request: SpeciesSearchRequest,
) -> Result<PaginatedResult<SpeciesListItem>, String> {
    if species_search_admission(&request.text) == SpeciesSearchAdmission::TooShort {
        return Err("Species search text is too short after normalization.".to_owned());
    }

    let limit = request.limit;
    let plan = SpeciesSearchPlan::build(SpeciesSearchPlanRequest {
        search: request,
        use_common_name_token_index: supports_common_name_token_index(conn),
        use_search_name_entry_index: supports_search_name_entry_index(conn),
    });

    let total_estimate = if let Some(count) = plan.count() {
        conn.query_row(count.sql(), params_from_iter(count.params()), |row| {
            row.get::<_, u32>(0)
        })
        .map_err(|e| format!("Failed to count species search results: {e}"))?
    } else {
        0
    };

    let list = plan.list();
    let mut stmt = conn
        .prepare(list.sql())
        .map_err(|e| format!("Failed to prepare species search: {e}"))?;

    let browse = plan.is_browse();
    let mut rows: Vec<(SpeciesListItem, Option<BrowsePosition>)> = stmt
        .query_map(params_from_iter(list.params()), |row| {
            let item = map_species_list_row(row)?;
            let position = browse.then(|| BrowsePosition::from_row(row)).transpose()?;
            Ok((item, position))
        })
        .map_err(|e| format!("Failed to execute species search: {e}"))?
        .filter_map(|result| match result {
            Ok(row) => Some(row),
            Err(error) => {
                tracing::warn!("Skipped species search row: {error}");
                None
            }
        })
        .collect();

    let has_next = rows.len() as u32 > limit;
    rows.truncate(limit as usize);
    let last_position = rows.last().and_then(|(_, position)| *position);
    let items: Vec<SpeciesListItem> = rows.into_iter().map(|(item, _)| item).collect();
    let next_cursor = plan.next_cursor(&items, last_position.as_ref(), has_next);

    Ok(PaginatedResult {
        items,
        next_cursor,
        total_estimate,
    })
}

pub(super) fn read_projection(
    conn: &PlantDbConnectionGuard<'_>,
    request: SpeciesSearchRequest,
) -> Result<PaginatedResult<SpeciesListItem>, String> {
    search_connection(conn, request)
}

#[cfg(test)]
fn search(
    conn: &Connection,
    request: SpeciesSearchRequest,
) -> Result<PaginatedResult<SpeciesListItem>, String> {
    crate::db::plant_catalog_connection::ensure_search_initialized(conn)?;
    search_connection(conn, request)
}

fn supports_common_name_token_index(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master
         WHERE type = 'table' AND name = 'species_search_common_name_tokens'",
        [],
        |_| Ok(()),
    )
    .is_ok()
}

fn supports_search_name_entry_index(conn: &Connection) -> bool {
    let entry_table_exists = conn
        .query_row(
            "SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'species_search_name_entries'",
            [],
            |_| Ok(()),
        )
        .is_ok();
    let token_table_exists = conn
        .query_row(
            "SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'species_search_name_entry_tokens'",
            [],
            |_| Ok(()),
        )
        .is_ok();

    let entry_kind_supported = conn
        .prepare("SELECT entry_kind FROM species_search_name_entries LIMIT 0")
        .is_ok();

    entry_table_exists && token_table_exists && entry_kind_supported
}

#[cfg(test)]
mod tests {
    use super::{search, supports_search_name_entry_index};
    use crate::db::query_builder::{SpeciesSearchPlan, SpeciesSearchPlanRequest};
    use common_types::species::{Sort, SpeciesFilter, SpeciesSearchRequest};
    use rusqlite::{Connection, OpenFlags, params_from_iter};
    use std::{env, path::PathBuf, time::Duration, time::Instant};

    fn search_request(
        text: Option<&str>,
        filters: SpeciesFilter,
        cursor: Option<String>,
        sort: Sort,
        limit: u32,
        include_total: bool,
        locale: &str,
    ) -> SpeciesSearchRequest {
        SpeciesSearchRequest {
            text: text.unwrap_or("").to_owned(),
            filters,
            cursor,
            limit,
            sort,
            locale: locale.to_owned(),
            include_total,
        }
    }

    #[expect(
        clippy::too_many_lines,
        reason = "ratcheted before 2.1-M188; split when this function next changes"
    )]
    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE species (
                id INTEGER PRIMARY KEY,
                canonical_name TEXT NOT NULL,
                slug TEXT NOT NULL,
                common_name TEXT,
                family TEXT,
                genus TEXT,
                height_max_m REAL,
                hardiness_zone_min INTEGER,
                hardiness_zone_max INTEGER,
                growth_rate TEXT,
                stratum TEXT,
                habit TEXT,
                climate_zones TEXT DEFAULT '[]',
                is_annual INTEGER DEFAULT 0,
                is_biennial INTEGER DEFAULT 0,
                is_perennial INTEGER DEFAULT 0,
                edibility_rating INTEGER,
                medicinal_rating INTEGER,
                width_max_m REAL
            );
            CREATE TABLE species_search_text (
                species_rowid INTEGER PRIMARY KEY,
                canonical_name TEXT NOT NULL DEFAULT '',
                common_names TEXT NOT NULL DEFAULT '',
                family_genus TEXT NOT NULL DEFAULT '',
                uses_text TEXT NOT NULL DEFAULT '',
                other_text TEXT NOT NULL DEFAULT ''
            );
            CREATE VIRTUAL TABLE species_search_fts USING fts5(
                canonical_name,
                common_names,
                family_genus,
                uses_text,
                other_text,
                content='species_search_text',
                content_rowid='species_rowid',
                tokenize=\"unicode61 remove_diacritics 2 tokenchars '_'\"
            );
            CREATE TABLE species_search_common_name_tokens (
                species_id INTEGER NOT NULL,
                language TEXT NOT NULL,
                token TEXT NOT NULL,
                first_token_position INTEGER NOT NULL,
                PRIMARY KEY (species_id, language, token)
            );
            CREATE TABLE best_common_names (
                species_id INTEGER NOT NULL,
                language TEXT NOT NULL,
                common_name TEXT NOT NULL,
                PRIMARY KEY (species_id, language)
            );
            CREATE TABLE species_common_names (
                species_id INTEGER NOT NULL,
                common_name TEXT NOT NULL,
                language TEXT NOT NULL,
                is_primary INTEGER NOT NULL DEFAULT 0,
                display_order INTEGER NOT NULL DEFAULT 0
            );

            INSERT INTO species (
                id,
                canonical_name, slug, common_name, family, genus,
                height_max_m, hardiness_zone_min, hardiness_zone_max,
                growth_rate, stratum, edibility_rating, medicinal_rating, width_max_m
            ) VALUES
                (1, 'Lavandula alpha', 'lavandula-alpha', 'Lavender Alpha', 'Lamiaceae', 'Lavandula', 1.0, 5, 9, 'Slow', 'Low', 1, 1, 1.0),
                (2, 'Lavandula beta', 'lavandula-beta', 'Lavender Beta', 'Lamiaceae', 'Lavandula', 1.2, 5, 9, 'Slow', 'Low', 1, 1, 1.1);

            INSERT INTO best_common_names VALUES
                (1, 'en', 'Lavender Alpha'),
                (2, 'en', 'Lavender Beta'),
                (1, 'fr', 'Lavande Alpha');

            INSERT INTO species_common_names VALUES
                (1, 'Lavandula alpha', 'fr', 1, 0),
                (1, 'Lavande Alpha', 'fr', 0, 1),
                (1, 'Lavande vraie', 'fr', 0, 2);

            INSERT INTO species_search_text (
                species_rowid, canonical_name, common_names, family_genus, uses_text, other_text
            )
            SELECT s.rowid,
                s.canonical_name,
                TRIM(COALESCE(s.common_name, '') || ' ' || COALESCE(cn.all_names, '')),
                TRIM(COALESCE(s.family, '') || ' ' || COALESCE(s.genus, '')),
                '',
                ''
            FROM species s
            LEFT JOIN (
                SELECT species_id, GROUP_CONCAT(common_name, ' ') AS all_names
                FROM species_common_names
                GROUP BY species_id
            ) cn ON cn.species_id = s.id;

            INSERT INTO species_search_common_name_tokens VALUES
                (1, 'en', 'lavender', 0),
                (1, 'en', 'alpha', 1),
                (1, 'fr', 'lavandula', 0),
                (1, 'fr', 'lavande', 0),
                (1, 'fr', 'alpha', 1),
                (1, 'fr', 'vraie', 1),
                (2, 'en', 'lavender', 0),
                (2, 'en', 'beta', 1);

            INSERT INTO species_search_fts(species_search_fts) VALUES('rebuild');",
        )
        .unwrap();
        crate::db::plant_catalog_connection::initialize_search_connection(&conn).unwrap();
        conn
    }

    #[test]
    fn rejects_too_short_text_instead_of_broadening_to_a_browse() {
        let error = search(
            &test_db(),
            search_request(
                Some("e"),
                SpeciesFilter::default(),
                None,
                Sort::Name,
                20,
                false,
                "en",
            ),
        )
        .unwrap_err();

        assert!(error.contains("too short"), "unexpected error: {error}");
    }

    #[test]
    fn search_rejects_connections_without_search_initialization() {
        let connection = Connection::open_in_memory().unwrap();

        let error = search(
            &connection,
            search_request(
                Some("malus"),
                SpeciesFilter::default(),
                None,
                Sort::Relevance,
                20,
                false,
                "en",
            ),
        )
        .unwrap_err();

        assert!(
            error.contains("not initialized"),
            "unexpected error: {error}"
        );
    }

    #[expect(
        clippy::too_many_lines,
        reason = "ratcheted before 2.1-M188; split when this function next changes"
    )]
    fn relevance_fixture_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE species (
                id TEXT PRIMARY KEY,
                canonical_name TEXT NOT NULL,
                slug TEXT NOT NULL,
                common_name TEXT,
                family TEXT,
                genus TEXT,
                height_max_m REAL,
                hardiness_zone_min INTEGER,
                hardiness_zone_max INTEGER,
                growth_rate TEXT,
                stratum TEXT,
                habit TEXT,
                climate_zones TEXT DEFAULT '[]',
                is_annual INTEGER DEFAULT 0,
                is_biennial INTEGER DEFAULT 0,
                is_perennial INTEGER DEFAULT 0,
                edibility_rating INTEGER,
                medicinal_rating INTEGER,
                width_max_m REAL
            );
            CREATE TABLE species_search_text (
                species_rowid INTEGER PRIMARY KEY,
                canonical_name TEXT NOT NULL DEFAULT '',
                common_names TEXT NOT NULL DEFAULT '',
                family_genus TEXT NOT NULL DEFAULT '',
                uses_text TEXT NOT NULL DEFAULT '',
                other_text TEXT NOT NULL DEFAULT ''
            );
            CREATE VIRTUAL TABLE species_search_fts USING fts5(
                canonical_name,
                common_names,
                family_genus,
                uses_text,
                other_text,
                content='species_search_text',
                content_rowid='species_rowid',
                tokenize=\"unicode61 remove_diacritics 2 tokenchars '_'\"
            );
            CREATE TABLE species_search_common_name_tokens (
                species_id TEXT NOT NULL,
                language TEXT NOT NULL,
                token TEXT NOT NULL,
                first_token_position INTEGER NOT NULL,
                PRIMARY KEY (species_id, language, token)
            );
            CREATE INDEX idx_species_search_common_name_tokens_language_token
                ON species_search_common_name_tokens(language, token, species_id);
            CREATE TABLE best_common_names (
                species_id TEXT NOT NULL,
                language TEXT NOT NULL,
                common_name TEXT NOT NULL,
                PRIMARY KEY (species_id, language)
            );
            CREATE TABLE species_common_names (
                species_id TEXT NOT NULL,
                common_name TEXT NOT NULL,
                language TEXT NOT NULL,
                is_primary INTEGER NOT NULL DEFAULT 0,
                display_order INTEGER NOT NULL DEFAULT 0
            );

            INSERT INTO species (
                id,
                canonical_name, slug, common_name, family, genus,
                height_max_m, hardiness_zone_min, hardiness_zone_max,
                growth_rate, stratum, edibility_rating, medicinal_rating, width_max_m
            ) VALUES
                ('linum-usitatissimum', 'Linum usitatissimum', 'linum-usitatissimum', 'Common flax', 'Linaceae', 'Linum', 1.2, 5, 9, 'Fast', 'Low', 4, 1, 0.3),
                ('linum-bienne', 'Linum bienne', 'linum-bienne', 'Pale flax', 'Linaceae', 'Linum', 0.8, 6, 9, 'Medium', 'Low', 1, 0, 0.2),
                ('linum-leonii', 'Linum leonii', 'linum-leonii', 'Leon flax', 'Linaceae', 'Linum', 0.5, 6, 9, 'Medium', 'Low', 1, 0, 0.2),
                ('linum-communis', 'Linum communis', 'linum-communis', 'False flax', 'Linaceae', 'Linum', 0.7, 6, 9, 'Medium', 'Low', 1, 0, 0.2),
                ('communia-linensis', 'Communia linensis', 'communia-linensis', 'Commun flax', 'Linaceae', 'Communia', 0.6, 6, 9, 'Medium', 'Low', 1, 0, 0.2),
                ('fallback-lin', 'Acmella fallback', 'acmella-fallback', 'Lin fallback', 'Asteraceae', 'Acmella', 0.4, 8, 10, 'Medium', 'Low', 1, 0, 0.2),
                ('lindleya-mespiloides', 'Lindleya mespiloides', 'lindleya-mespiloides', 'Lindleya', 'Rosaceae', 'Lindleya', 3.0, 7, 10, 'Medium', 'Shrub', 0, 0, 2.0),
                ('malus-domestica', 'Malus domestica', 'malus-domestica', 'Apple', 'Rosaceae', 'Malus', 4.0, 4, 8, 'Medium', 'Canopy', 5, 1, 3.0),
                ('mentha-suaveolens', 'Mentha suaveolens', 'mentha-suaveolens', 'Apple mint', 'Lamiaceae', 'Mentha', 0.6, 5, 9, 'Fast', 'Low', 3, 2, 0.8),
                ('melissa-officinalis', 'Melissa officinalis', 'melissa-officinalis', 'Lemon balm', 'Lamiaceae', 'Melissa', 0.7, 4, 9, 'Fast', 'Low', 4, 5, 0.7),
                ('clinopodium-alpinum', 'Clinopodium alpinum', 'clinopodium-alpinum', 'Alpine savory', 'Lamiaceae', 'Clinopodium', 0.4, 5, 8, 'Medium', 'Low', 1, 2, 0.5),
                ('clinopodium-nepeta', 'Clinopodium nepeta', 'clinopodium-nepeta', 'Lesser calamint', 'Lamiaceae', 'Clinopodium', 0.5, 5, 9, 'Medium', 'Low', 2, 2, 0.6),
                ('viola-melissifolia', 'Viola melissifolia', 'viola-melissifolia', 'Violet', 'Violaceae', 'Viola', 0.2, 5, 8, 'Medium', 'Low', 0, 0, 0.2),
                ('moluccella-laevis', 'Moluccella laevis', 'moluccella-laevis', 'Bells of Ireland', 'Lamiaceae', 'Moluccella', 0.9, 7, 10, 'Medium', 'Low', 0, 0, 0.4);

            INSERT INTO species_common_names VALUES
                ('linum-usitatissimum', 'Common flax', 'en', 1, 0),
                ('linum-usitatissimum', 'Lin commun', 'fr', 1, 0),
                ('linum-bienne', 'Pale flax', 'en', 1, 0),
                ('linum-bienne', 'Lin bisannuel', 'fr', 1, 0),
                ('linum-leonii', 'Leon flax', 'en', 1, 0),
                ('linum-leonii', 'Lin de Léon', 'fr', 1, 0),
                ('linum-communis', 'False flax', 'en', 1, 0),
                ('linum-communis', 'Faux lin', 'fr', 1, 0),
                ('communia-linensis', 'Commun flax', 'en', 1, 0),
                ('communia-linensis', 'Commun Lin', 'fr', 1, 0),
                ('fallback-lin', 'Lin fallback', 'en', 1, 0),
                ('lindleya-mespiloides', 'Lindleya', 'en', 1, 0),
                ('malus-domestica', 'Apple', 'en', 1, 0),
                ('malus-domestica', 'Pommier', 'fr', 1, 0),
                ('mentha-suaveolens', 'Apple mint', 'en', 1, 0),
                ('melissa-officinalis', 'Lemon balm', 'en', 1, 0),
                ('melissa-officinalis', 'Mélisse', 'fr', 1, 0),
                ('clinopodium-alpinum', 'Alpine savory', 'en', 1, 0),
                ('clinopodium-alpinum', 'Mélisse alpine', 'fr', 1, 0),
                ('clinopodium-nepeta', 'Lesser calamint', 'en', 1, 0),
                ('clinopodium-nepeta', 'Mélisse des champs', 'fr', 1, 0),
                ('viola-melissifolia', 'Violet', 'en', 1, 0),
                ('viola-melissifolia', 'Violette à feuilles de mélisse', 'fr', 1, 0),
                ('moluccella-laevis', 'Bells of Ireland', 'en', 1, 0),
                ('moluccella-laevis', 'Clochette d''Irlande', 'fr', 1, 0),
                ('moluccella-laevis', 'Moluque verte', 'fr', 0, 1),
                ('moluccella-laevis', 'Mélisse des Moluques', 'fr', 0, 2);

            INSERT INTO best_common_names VALUES
                ('linum-usitatissimum', 'en', 'Common flax'),
                ('linum-usitatissimum', 'fr', 'Lin commun'),
                ('linum-bienne', 'en', 'Pale flax'),
                ('linum-bienne', 'fr', 'Lin bisannuel'),
                ('linum-leonii', 'en', 'Leon flax'),
                ('linum-leonii', 'fr', 'Lin de Léon'),
                ('linum-communis', 'en', 'False flax'),
                ('linum-communis', 'fr', 'Faux lin'),
                ('communia-linensis', 'en', 'Commun flax'),
                ('communia-linensis', 'fr', 'Commun Lin'),
                ('fallback-lin', 'en', 'Lin fallback'),
                ('lindleya-mespiloides', 'en', 'Lindleya'),
                ('malus-domestica', 'en', 'Apple'),
                ('malus-domestica', 'fr', 'Pommier'),
                ('mentha-suaveolens', 'en', 'Apple mint'),
                ('melissa-officinalis', 'en', 'Lemon balm'),
                ('melissa-officinalis', 'fr', 'Mélisse'),
                ('clinopodium-alpinum', 'en', 'Alpine savory'),
                ('clinopodium-alpinum', 'fr', 'Mélisse alpine'),
                ('clinopodium-nepeta', 'en', 'Lesser calamint'),
                ('clinopodium-nepeta', 'fr', 'Mélisse des champs'),
                ('viola-melissifolia', 'en', 'Violet'),
                ('viola-melissifolia', 'fr', 'Violette à feuilles de mélisse'),
                ('moluccella-laevis', 'en', 'Bells of Ireland'),
                ('moluccella-laevis', 'fr', 'Clochette d''Irlande');

            INSERT INTO species_search_text (
                species_rowid, canonical_name, common_names, family_genus, uses_text, other_text
            )
            SELECT s.rowid,
                s.canonical_name,
                TRIM(COALESCE(s.common_name, '') || ' ' || COALESCE(cn.all_names, '')),
                TRIM(COALESCE(s.family, '') || ' ' || COALESCE(s.genus, '')),
                '',
                ''
            FROM species s
            LEFT JOIN (
                SELECT species_id, GROUP_CONCAT(common_name, ' ') AS all_names
                FROM species_common_names
                GROUP BY species_id
            ) cn ON cn.species_id = s.id;

            INSERT INTO species_search_fts(species_search_fts) VALUES('rebuild');

            INSERT INTO species_search_common_name_tokens VALUES
                ('linum-usitatissimum', 'en', 'common', 0),
                ('linum-usitatissimum', 'en', 'flax', 1),
                ('linum-usitatissimum', 'fr', 'lin', 0),
                ('linum-usitatissimum', 'fr', 'commun', 1),
                ('linum-bienne', 'en', 'pale', 0),
                ('linum-bienne', 'en', 'flax', 1),
                ('linum-bienne', 'fr', 'lin', 0),
                ('linum-bienne', 'fr', 'bisannuel', 1),
                ('linum-leonii', 'en', 'leon', 0),
                ('linum-leonii', 'en', 'flax', 1),
                ('linum-leonii', 'fr', 'lin', 0),
                ('linum-leonii', 'fr', 'de', 1),
                ('linum-leonii', 'fr', 'leon', 2),
                ('linum-communis', 'en', 'false', 0),
                ('linum-communis', 'en', 'flax', 1),
                ('linum-communis', 'fr', 'faux', 0),
                ('linum-communis', 'fr', 'lin', 1),
                ('communia-linensis', 'en', 'commun', 0),
                ('communia-linensis', 'en', 'flax', 1),
                ('communia-linensis', 'fr', 'commun', 0),
                ('communia-linensis', 'fr', 'lin', 1),
                ('fallback-lin', 'en', 'lin', 0),
                ('fallback-lin', 'en', 'fallback', 1),
                ('lindleya-mespiloides', 'en', 'lindleya', 0),
                ('malus-domestica', 'en', 'apple', 0),
                ('malus-domestica', 'fr', 'pomme', 0),
                ('malus-domestica', 'fr', 'pommier', 0),
                ('mentha-suaveolens', 'en', 'apple', 0),
                ('mentha-suaveolens', 'en', 'mint', 1),
                ('melissa-officinalis', 'en', 'lemon', 0),
                ('melissa-officinalis', 'en', 'balm', 1),
                ('melissa-officinalis', 'fr', 'melisse', 0),
                ('clinopodium-alpinum', 'en', 'alpine', 0),
                ('clinopodium-alpinum', 'en', 'savory', 1),
                ('clinopodium-alpinum', 'fr', 'melisse', 0),
                ('clinopodium-alpinum', 'fr', 'alpine', 1),
                ('clinopodium-nepeta', 'en', 'lesser', 0),
                ('clinopodium-nepeta', 'en', 'calamint', 1),
                ('clinopodium-nepeta', 'fr', 'melisse', 0),
                ('clinopodium-nepeta', 'fr', 'des', 1),
                ('clinopodium-nepeta', 'fr', 'champs', 2),
                ('viola-melissifolia', 'en', 'violet', 0),
                ('viola-melissifolia', 'fr', 'violette', 0),
                ('viola-melissifolia', 'fr', 'feuilles', 2),
                ('viola-melissifolia', 'fr', 'de', 3),
                ('viola-melissifolia', 'fr', 'melisse', 4),
                ('moluccella-laevis', 'en', 'bells', 0),
                ('moluccella-laevis', 'en', 'ireland', 2),
                ('moluccella-laevis', 'fr', 'clochette', 0),
                ('moluccella-laevis', 'fr', 'irlande', 2),
                ('moluccella-laevis', 'fr', 'moluque', 0),
                ('moluccella-laevis', 'fr', 'verte', 1),
                ('moluccella-laevis', 'fr', 'melisse', 0),
                ('moluccella-laevis', 'fr', 'des', 1),
                ('moluccella-laevis', 'fr', 'moluques', 2);",
        )
        .unwrap();
        crate::db::plant_catalog_connection::initialize_search_connection(&conn).unwrap();
        conn
    }

    fn indexed_relevance_fixture_without_legacy_tokens() -> Connection {
        let conn = relevance_fixture_db();
        conn.execute_batch(
            "DROP TABLE species_search_common_name_tokens;
            CREATE TABLE species_search_name_entries (
                entry_id INTEGER PRIMARY KEY,
                species_id TEXT NOT NULL,
                language TEXT NOT NULL,
                entry_kind TEXT NOT NULL,
                common_name TEXT NOT NULL,
                normalized_name TEXT NOT NULL,
                is_display_name INTEGER NOT NULL DEFAULT 0,
                is_primary INTEGER NOT NULL DEFAULT 0,
	                display_order INTEGER NOT NULL DEFAULT 0,
                name_length INTEGER NOT NULL
            );
            CREATE TABLE species_search_name_entry_tokens (
                entry_id INTEGER NOT NULL,
                species_id TEXT NOT NULL,
                language TEXT NOT NULL,
                token TEXT NOT NULL,
                first_token_position INTEGER NOT NULL,
                PRIMARY KEY (entry_id, token)
            );
            CREATE INDEX idx_species_search_name_entries_language_norm
                ON species_search_name_entries(language, normalized_name, species_id);
            CREATE INDEX idx_species_search_name_entries_species_lang
                ON species_search_name_entries(species_id, language);
            CREATE INDEX idx_species_search_name_entry_tokens_language_token
                ON species_search_name_entry_tokens(language, token, species_id, entry_id);

            INSERT INTO species_search_name_entries (
                entry_id, species_id, language, entry_kind, common_name, normalized_name,
	                is_display_name, is_primary, display_order, name_length
            ) VALUES
                (1, 'melissa-officinalis', 'fr', 'common_name', 'Mélisse', 'melisse', 1, 1, 1, 7),
                (2, 'clinopodium-alpinum', 'fr', 'common_name', 'Mélisse alpine', 'melisse alpine', 1, 1, 1, 14),
                (3, 'clinopodium-nepeta', 'fr', 'common_name', 'Mélisse des champs', 'melisse des champs', 1, 1, 1, 18),
                (4, 'viola-melissifolia', 'fr', 'common_name', 'Violette à feuilles de mélisse', 'violette a feuilles de melisse', 1, 1, 1, 28),
                (5, 'moluccella-laevis', 'fr', 'common_name', 'Clochette d''Irlande', 'clochette d irlande', 1, 1, 1, 20),
                (6, 'moluccella-laevis', 'fr', 'common_name', 'Mélisse des Moluques', 'melisse des moluques', 0, 0, 1, 20),
                (7, 'lindleya-mespiloides', '__canonical__', 'canonical', 'Lindleya mespiloides', 'lindleya mespiloides', 0, 0, 2, 20);

            INSERT INTO species_search_name_entry_tokens VALUES
                (1, 'melissa-officinalis', 'fr', 'melisse', 0),
                (2, 'clinopodium-alpinum', 'fr', 'melisse', 0),
                (2, 'clinopodium-alpinum', 'fr', 'alpine', 1),
                (3, 'clinopodium-nepeta', 'fr', 'melisse', 0),
                (3, 'clinopodium-nepeta', 'fr', 'des', 1),
                (3, 'clinopodium-nepeta', 'fr', 'champs', 2),
                (4, 'viola-melissifolia', 'fr', 'violette', 0),
                (4, 'viola-melissifolia', 'fr', 'a', 1),
                (4, 'viola-melissifolia', 'fr', 'feuilles', 2),
                (4, 'viola-melissifolia', 'fr', 'de', 3),
                (4, 'viola-melissifolia', 'fr', 'melisse', 4),
                (5, 'moluccella-laevis', 'fr', 'clochette', 0),
                (5, 'moluccella-laevis', 'fr', 'd', 1),
                (5, 'moluccella-laevis', 'fr', 'irlande', 2),
                (6, 'moluccella-laevis', 'fr', 'melisse', 0),
                (6, 'moluccella-laevis', 'fr', 'des', 1),
                (6, 'moluccella-laevis', 'fr', 'moluques', 2),
                (7, 'lindleya-mespiloides', '__canonical__', 'lindleya', 0),
                (7, 'lindleya-mespiloides', '__canonical__', 'mespiloides', 1);",
        )
        .unwrap();
        conn
    }

    fn run_bundled_species_search_latency_harness() -> Result<(), String> {
        let Some(path) = bundled_species_search_db_path() else {
            eprintln!(
                "skipping species search latency harness: no bundled database found; \
                 run `python3 scripts/prepare-db.py` or set CANOPI_PLANT_DB_PATH"
            );
            return Ok(());
        };
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| {
            format!(
                "Failed to open Species Catalog database at {}: {error}",
                path.display()
            )
        })?;
        crate::db::plant_catalog_connection::initialize_search_connection(&conn)?;

        eprintln!("species_search_latency db={}", path.display());
        for case in species_search_latency_cases() {
            report_species_search_latency_case(&conn, case)?;
        }
        for sort in [Sort::Recommended, Sort::Name, Sort::Height, Sort::Edibility] {
            report_species_browse_latency(&conn, sort, "en")?;
        }
        report_species_browse_latency(&conn, Sort::Recommended, "fr")?;

        Ok(())
    }

    const BROWSE_LATENCY_PAGE_SIZE: u32 = 50;
    /// Page 100 stays in Recommended's rated phase; page 250 is past it.
    const BROWSE_LATENCY_REPORTED_PAGES: &[usize] = &[1, 100, 250];

    /// Times the first browse page and deep pages reached by following
    /// cursors (cold and warm), and prints each reported page's query plan.
    fn report_species_browse_latency(
        conn: &Connection,
        sort: Sort,
        locale: &str,
    ) -> Result<(), String> {
        let mut cursor = None;
        let last_page = BROWSE_LATENCY_REPORTED_PAGES.last().copied().unwrap_or(1);
        for page_number in 1..=last_page {
            let request = search_request(
                None,
                SpeciesFilter::default(),
                cursor.clone(),
                sort.clone(),
                BROWSE_LATENCY_PAGE_SIZE,
                false,
                locale,
            );
            let started = Instant::now();
            let page = search(conn, request.clone())?;
            let elapsed = started.elapsed();
            if BROWSE_LATENCY_REPORTED_PAGES.contains(&page_number) {
                let warm_started = Instant::now();
                search(conn, request.clone())?;
                let warm_elapsed = warm_started.elapsed();
                eprintln!(
                    "species_browse_latency sort={sort:?} locale={locale} page={page_number} \
                     list_ms={} warm_ms={} first={:?} plan=[{}]",
                    millis(elapsed),
                    millis(warm_elapsed),
                    page.items.first().map(|item| item.canonical_name.as_str()),
                    species_search_query_plan(conn, request)?,
                );
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        Ok(())
    }

    fn species_search_query_plan(
        conn: &Connection,
        request: SpeciesSearchRequest,
    ) -> Result<String, String> {
        let plan = SpeciesSearchPlan::build(SpeciesSearchPlanRequest {
            search: request,
            use_common_name_token_index: true,
            use_search_name_entry_index: supports_search_name_entry_index(conn),
        });
        let list = plan.list();
        let mut stmt = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {}", list.sql()))
            .map_err(|error| format!("Failed to prepare query plan: {error}"))?;
        let details = stmt
            .query_map(params_from_iter(list.params()), |row| {
                row.get::<_, String>(3)
            })
            .map_err(|error| format!("Failed to read query plan: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read query plan row: {error}"))?;
        Ok(details.join(" | "))
    }

    #[derive(Clone, Copy)]
    struct SpeciesSearchLatencyCase {
        label: &'static str,
        locale: &'static str,
        query: &'static str,
        include_total: bool,
    }

    fn species_search_latency_cases() -> &'static [SpeciesSearchLatencyCase] {
        &[
            SpeciesSearchLatencyCase {
                label: "en-ap",
                locale: "en",
                query: "ap",
                include_total: false,
            },
            SpeciesSearchLatencyCase {
                label: "fr-me",
                locale: "fr",
                query: "me",
                include_total: false,
            },
            SpeciesSearchLatencyCase {
                label: "fr-po",
                locale: "fr",
                query: "po",
                include_total: false,
            },
            SpeciesSearchLatencyCase {
                label: "fr-lin",
                locale: "fr",
                query: "lin",
                include_total: false,
            },
            SpeciesSearchLatencyCase {
                label: "fr-lin-commun",
                locale: "fr",
                query: "lin commun",
                include_total: false,
            },
            SpeciesSearchLatencyCase {
                label: "fr-lind",
                locale: "fr",
                query: "lind",
                include_total: false,
            },
            SpeciesSearchLatencyCase {
                label: "en-apple",
                locale: "en",
                query: "apple",
                include_total: false,
            },
            SpeciesSearchLatencyCase {
                label: "en-broad-a-count-probe",
                locale: "en",
                query: "a",
                include_total: true,
            },
        ]
    }

    fn run_bundled_species_search_relevance_examples() -> Result<(), String> {
        let Some(path) = bundled_species_search_db_path() else {
            eprintln!(
                "skipping species search relevance harness: no bundled database found; \
                 run `python3 scripts/prepare-db.py` or set CANOPI_PLANT_DB_PATH"
            );
            return Ok(());
        };
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| {
            format!(
                "Failed to open Species Catalog database at {}: {error}",
                path.display()
            )
        })?;
        crate::db::plant_catalog_connection::initialize_search_connection(&conn)?;

        eprintln!("species_search_relevance db={}", path.display());
        for case in [
            ("en-apple", "en", "apple"),
            ("en-appl", "en", "appl"),
            ("fr-melisse", "fr", "melisse"),
            ("fr-melis", "fr", "melis"),
        ] {
            report_species_search_relevance_case(&conn, case)?;
        }

        Ok(())
    }

    fn bundled_species_search_db_path() -> Option<PathBuf> {
        if let Ok(path) = env::var("CANOPI_PLANT_DB_PATH") {
            let path = PathBuf::from(path);
            return path.exists().then_some(path);
        }

        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("canopi-core.db");
        path.exists().then_some(path)
    }

    fn report_species_search_latency_case(
        conn: &Connection,
        case: &SpeciesSearchLatencyCase,
    ) -> Result<(), String> {
        let plan = SpeciesSearchPlan::build(SpeciesSearchPlanRequest {
            search: search_request(
                Some(case.query),
                SpeciesFilter::default(),
                None,
                Sort::Relevance,
                20,
                case.include_total,
                case.locale,
            ),
            use_common_name_token_index: true,
            use_search_name_entry_index: supports_search_name_entry_index(conn),
        });
        let list_started = Instant::now();
        let list_rows = execute_species_search_list(conn, &plan)?;
        let list_elapsed = list_started.elapsed();

        let count = if case.include_total {
            let count_started = Instant::now();
            let total_estimate = execute_species_search_count(conn, &plan)?;
            let count_elapsed = count_started.elapsed();
            (millis(count_elapsed), total_estimate.to_string())
        } else {
            ("skipped".to_owned(), "skipped".to_owned())
        };

        eprintln!(
            "species_search_latency case={} locale={} query={:?} \
             list_ms={} count_ms={} rows={} total_estimate={}",
            case.label,
            case.locale,
            case.query,
            millis(list_elapsed),
            count.0,
            list_rows,
            count.1
        );
        Ok(())
    }

    fn report_species_search_relevance_case(
        conn: &Connection,
        (label, locale, query): (&str, &str, &str),
    ) -> Result<(), String> {
        let result = search(
            conn,
            search_request(
                Some(query),
                SpeciesFilter::default(),
                None,
                Sort::Relevance,
                10,
                false,
                locale,
            ),
        )?;
        let rows = result
            .items
            .iter()
            .take(6)
            .map(|item| {
                format!(
                    "{} [{} | {} | matched={}]",
                    item.canonical_name,
                    item.common_name.as_deref().unwrap_or(""),
                    item.common_name_2.as_deref().unwrap_or(""),
                    item.matched_common_name.as_deref().unwrap_or(""),
                )
            })
            .collect::<Vec<_>>();

        eprintln!(
            "species_search_relevance case={label} locale={locale} query={query:?} rows={rows:?}"
        );
        Ok(())
    }

    fn execute_species_search_list(
        conn: &Connection,
        plan: &SpeciesSearchPlan,
    ) -> Result<usize, String> {
        let list = plan.list();
        let mut stmt = conn
            .prepare(list.sql())
            .map_err(|error| format!("Failed to prepare Species Catalog list query: {error}"))?;
        let mut rows = stmt
            .query(params_from_iter(list.params()))
            .map_err(|error| format!("Failed to execute Species Catalog list query: {error}"))?;
        let mut count = 0;
        while rows
            .next()
            .map_err(|error| format!("Failed to read Species Catalog list row: {error}"))?
            .is_some()
        {
            count += 1;
        }
        Ok(count)
    }

    fn execute_species_search_count(
        conn: &Connection,
        plan: &SpeciesSearchPlan,
    ) -> Result<u32, String> {
        let count = plan
            .count()
            .ok_or_else(|| "Species Catalog count plan was not built".to_owned())?;
        conn.query_row(count.sql(), params_from_iter(count.params()), |row| {
            row.get::<_, u32>(0)
        })
        .map_err(|error| format!("Failed to execute Species Catalog count query: {error}"))
    }

    fn millis(duration: Duration) -> String {
        format!("{:.3}", duration.as_secs_f64() * 1000.0)
    }

    #[test]
    fn relevance_pagination_uses_offset_cursor_without_duplicates() {
        let conn = test_db();

        let first = search(
            &conn,
            search_request(
                Some("lavender"),
                SpeciesFilter::default(),
                None,
                Sort::Relevance,
                1,
                true,
                "en",
            ),
        )
        .unwrap();

        assert_eq!(first.items.len(), 1);
        assert_eq!(first.total_estimate, 2);
        assert_eq!(first.next_cursor.as_deref(), Some("offset:1"));

        let second = search(
            &conn,
            search_request(
                Some("lavender"),
                SpeciesFilter::default(),
                first.next_cursor.clone(),
                Sort::Relevance,
                1,
                false,
                "en",
            ),
        )
        .unwrap();

        assert_eq!(second.items.len(), 1);
        assert_eq!(second.total_estimate, 0);
        assert_ne!(
            first.items[0].canonical_name,
            second.items[0].canonical_name
        );
        assert_eq!(second.next_cursor, None);
    }

    #[test]
    fn locale_common_names_and_fallback() {
        let conn = test_db();

        let result = search(
            &conn,
            search_request(
                None,
                SpeciesFilter::default(),
                None,
                Sort::Name,
                10,
                true,
                "fr",
            ),
        )
        .unwrap();

        assert_eq!(result.items.len(), 2);
        assert_eq!(result.total_estimate, 2);

        // Species 1 has French names -> locale name + secondary, no fallback
        let alpha = result
            .items
            .iter()
            .find(|i| i.canonical_name == "Lavandula alpha")
            .unwrap();
        assert_eq!(alpha.common_name.as_deref(), Some("Lavande Alpha"));
        assert_eq!(alpha.common_name_2.as_deref(), Some("Lavande vraie"));
        assert!(!alpha.is_name_fallback);

        // Species 2 has no French names -> no Common Name fallback, no secondary
        let beta = result
            .items
            .iter()
            .find(|i| i.canonical_name == "Lavandula beta")
            .unwrap();
        assert_eq!(beta.common_name, None);
        assert_eq!(beta.common_name_2, None);
        assert!(!beta.is_name_fallback);
    }

    #[test]
    fn total_estimate_reflects_text_filter() {
        let conn = test_db();

        let result = search(
            &conn,
            search_request(
                Some("alpha"),
                SpeciesFilter::default(),
                None,
                Sort::Name,
                10,
                true,
                "en",
            ),
        )
        .unwrap();

        assert_eq!(result.total_estimate, 1);
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].canonical_name, "Lavandula alpha");
    }

    #[test]
    fn blank_relevance_search_falls_back_to_name_cursor_pagination() {
        let conn = test_db();

        let first = search(
            &conn,
            search_request(
                Some("\" () + -"),
                SpeciesFilter::default(),
                None,
                Sort::Relevance,
                1,
                true,
                "en",
            ),
        )
        .unwrap();

        assert_eq!(first.total_estimate, 2);
        assert_eq!(first.items.len(), 1);
        let next_cursor = first.next_cursor.clone().expect("expected cursor");
        assert!(!next_cursor.starts_with("offset:"));

        let second = search(
            &conn,
            search_request(
                Some("\" () + -"),
                SpeciesFilter::default(),
                Some(next_cursor),
                Sort::Relevance,
                1,
                false,
                "en",
            ),
        )
        .unwrap();

        assert_eq!(second.items.len(), 1);
        assert_eq!(second.total_estimate, 0);
        assert_ne!(
            first.items[0].canonical_name,
            second.items[0].canonical_name
        );
        assert_eq!(second.next_cursor, None);
    }

    #[test]
    fn relevance_fixture_covers_common_name_search_examples() {
        let conn = relevance_fixture_db();

        for (locale, query, expected_names) in [
            (
                "fr",
                "lin",
                vec![
                    "Linum usitatissimum",
                    "Linum bienne",
                    "Lindleya mespiloides",
                ],
            ),
            ("fr", "lin commun", vec!["Linum usitatissimum"]),
            ("fr", "lind", vec!["Lindleya mespiloides"]),
            ("en", "apple", vec!["Malus domestica"]),
            ("en", "appl", vec!["Malus domestica"]),
        ] {
            let result = search(
                &conn,
                search_request(
                    Some(query),
                    SpeciesFilter::default(),
                    None,
                    Sort::Relevance,
                    10,
                    true,
                    locale,
                ),
            )
            .unwrap();

            for expected_name in expected_names {
                assert!(
                    result
                        .items
                        .iter()
                        .any(|item| item.canonical_name == expected_name),
                    "expected {locale} query {query:?} to include {expected_name}; got {:?}",
                    result
                        .items
                        .iter()
                        .map(|item| item.canonical_name.as_str())
                        .collect::<Vec<_>>()
                );
            }
        }
    }

    #[test]
    fn relevance_prefers_short_displayed_common_name_prefixes() {
        let conn = relevance_fixture_db();

        for query in ["apple", "appl"] {
            let result = search(
                &conn,
                search_request(
                    Some(query),
                    SpeciesFilter::default(),
                    None,
                    Sort::Relevance,
                    10,
                    true,
                    "en",
                ),
            )
            .unwrap();
            let names = result
                .items
                .iter()
                .map(|item| item.canonical_name.as_str())
                .collect::<Vec<_>>();

            assert_eq!(
                names.first().copied(),
                Some("Malus domestica"),
                "expected Apple before longer Apple Common Names for {query:?}; got {names:?}"
            );
            assert_eq!(result.items[0].matched_common_name, None);
            assert!(
                names
                    .iter()
                    .position(|name| *name == "Malus domestica")
                    .unwrap()
                    < names
                        .iter()
                        .position(|name| *name == "Mentha suaveolens")
                        .unwrap(),
                "expected Apple before Apple mint for {query:?}; got {names:?}"
            );
        }
    }

    #[test]
    fn relevance_prefix_token_matches_return_each_species_once() {
        let conn = relevance_fixture_db();

        let result = search(
            &conn,
            search_request(
                Some("po"),
                SpeciesFilter::default(),
                None,
                Sort::Relevance,
                10,
                false,
                "fr",
            ),
        )
        .unwrap();
        let malus_count = result
            .items
            .iter()
            .filter(|item| item.canonical_name == "Malus domestica")
            .count();

        assert_eq!(
            malus_count,
            1,
            "expected a Species with multiple matching prefix tokens once; got {:?}",
            result
                .items
                .iter()
                .map(|item| item.canonical_name.as_str())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn relevance_orders_french_melisse_results_by_displayed_match_strength() {
        let conn = relevance_fixture_db();

        for query in ["melis", "melisse"] {
            let result = search(
                &conn,
                search_request(
                    Some(query),
                    SpeciesFilter::default(),
                    None,
                    Sort::Relevance,
                    10,
                    true,
                    "fr",
                ),
            )
            .unwrap();
            let names = result
                .items
                .iter()
                .map(|item| item.canonical_name.as_str())
                .collect::<Vec<_>>();
            let index_of = |needle: &str| {
                names
                    .iter()
                    .position(|name| *name == needle)
                    .unwrap_or_else(|| panic!("expected {needle} in {names:?} for {query:?}"))
            };

            assert_eq!(
                names.first().copied(),
                Some("Melissa officinalis"),
                "expected short displayed Mélisse result first for {query:?}; got {names:?}"
            );
            assert_eq!(result.items[0].matched_common_name, None);
            assert!(index_of("Clinopodium alpinum") < index_of("Viola melissifolia"));
            assert!(index_of("Clinopodium nepeta") < index_of("Viola melissifolia"));
            assert!(index_of("Viola melissifolia") < index_of("Moluccella laevis"));

            let moluccella = result
                .items
                .iter()
                .find(|item| item.canonical_name == "Moluccella laevis")
                .unwrap();
            assert_eq!(
                moluccella.common_name.as_deref(),
                Some("Clochette d'Irlande")
            );
            assert_eq!(moluccella.common_name_2.as_deref(), Some("Moluque verte"));
            assert_eq!(
                moluccella.matched_common_name.as_deref(),
                Some("Mélisse des Moluques")
            );
        }
    }

    #[test]
    fn active_search_uses_generated_name_entry_index_without_legacy_token_table() {
        let conn = indexed_relevance_fixture_without_legacy_tokens();

        let result = search(
            &conn,
            search_request(
                Some("melis"),
                SpeciesFilter::default(),
                None,
                Sort::Relevance,
                10,
                false,
                "fr",
            ),
        )
        .unwrap();
        let names = result
            .items
            .iter()
            .map(|item| item.canonical_name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            &names[..5],
            &[
                "Melissa officinalis",
                "Clinopodium alpinum",
                "Clinopodium nepeta",
                "Viola melissifolia",
                "Moluccella laevis",
            ],
            "expected generated search-entry index to preserve French relevance ordering; got {names:?}",
        );
        assert_eq!(
            result.items[4].matched_common_name.as_deref(),
            Some("Mélisse des Moluques")
        );
    }

    #[test]
    fn indexed_active_search_keeps_canonical_name_matches_without_english_common_name_fallback() {
        let conn = indexed_relevance_fixture_without_legacy_tokens();

        let result = search(
            &conn,
            search_request(
                Some("lind"),
                SpeciesFilter::default(),
                None,
                Sort::Relevance,
                10,
                false,
                "fr",
            ),
        )
        .unwrap();
        let names = result
            .items
            .iter()
            .map(|item| item.canonical_name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["Lindleya mespiloides"]);
        assert!(result.items[0].matched_common_name.is_none());
        assert!(result.items[0].common_name.is_none());
    }

    #[test]
    fn indexed_active_search_preserves_broader_fts_only_matches() {
        let conn = indexed_relevance_fixture_without_legacy_tokens();
        conn.execute(
            "UPDATE species_search_text
             SET uses_text = 'pollinator habitat'
             WHERE species_rowid = (
                 SELECT rowid FROM species WHERE id = 'linum-bienne'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO species_search_fts(species_search_fts) VALUES('rebuild')",
            [],
        )
        .unwrap();

        let result = search(
            &conn,
            search_request(
                Some("pollinator"),
                SpeciesFilter::default(),
                None,
                Sort::Relevance,
                10,
                true,
                "en",
            ),
        )
        .unwrap();

        assert_eq!(result.total_estimate, 1);
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].canonical_name, "Linum bienne");
    }

    #[test]
    fn relevance_prefers_displayed_locale_common_name_prefixes() {
        let conn = relevance_fixture_db();

        let result = search(
            &conn,
            search_request(
                Some("lin"),
                SpeciesFilter::default(),
                None,
                Sort::Relevance,
                10,
                true,
                "fr",
            ),
        )
        .unwrap();
        let names = result
            .items
            .iter()
            .map(|item| item.canonical_name.as_str())
            .collect::<Vec<_>>();

        for displayed_prefix_match in ["Linum usitatissimum", "Linum bienne", "Linum leonii"] {
            let position = names
                .iter()
                .position(|name| *name == displayed_prefix_match)
                .unwrap_or_else(|| panic!("expected {displayed_prefix_match} in {names:?}"));
            assert!(
                position < 3,
                "expected displayed Common Name prefix matches first; got {names:?}"
            );
        }
        assert!(
            names
                .iter()
                .position(|name| *name == "Linum bienne")
                .unwrap()
                < names
                    .iter()
                    .position(|name| *name == "Lindleya mespiloides")
                    .unwrap(),
            "expected Linum bienne before Lindleya mespiloides; got {names:?}"
        );
    }

    #[test]
    fn relevance_ignores_english_common_name_fallbacks_for_non_english_searches() {
        let conn = relevance_fixture_db();

        let result = search(
            &conn,
            search_request(
                Some("lin"),
                SpeciesFilter::default(),
                None,
                Sort::Relevance,
                10,
                true,
                "fr",
            ),
        )
        .unwrap();
        let names = result
            .items
            .iter()
            .map(|item| item.canonical_name.as_str())
            .collect::<Vec<_>>();
        let index_of = |needle: &str| {
            names
                .iter()
                .position(|name| *name == needle)
                .unwrap_or_else(|| panic!("expected {needle} in {names:?}"))
        };

        assert!(
            !names.contains(&"Acmella fallback"),
            "expected French search to ignore English-only Common Name fallback; got {names:?}"
        );
        for active_locale_match in [
            "Linum usitatissimum",
            "Linum bienne",
            "Linum leonii",
            "Linum communis",
            "Communia linensis",
        ] {
            index_of(active_locale_match);
        }
    }

    #[test]
    fn relevance_prefers_active_locale_common_name_exact_phrase() {
        let conn = relevance_fixture_db();

        let result = search(
            &conn,
            search_request(
                Some("lin commun"),
                SpeciesFilter::default(),
                None,
                Sort::Relevance,
                10,
                true,
                "fr",
            ),
        )
        .unwrap();
        let names = result
            .items
            .iter()
            .map(|item| item.canonical_name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names.first().copied(),
            Some("Linum usitatissimum"),
            "expected exact Common Name phrase before reversed all-token match; got {names:?}"
        );
        assert!(
            names
                .iter()
                .position(|name| *name == "Linum usitatissimum")
                .unwrap()
                < names
                    .iter()
                    .position(|name| *name == "Communia linensis")
                    .unwrap(),
            "expected exact phrase before all-token match; got {names:?}"
        );
        assert!(
            names
                .iter()
                .position(|name| *name == "Communia linensis")
                .unwrap()
                < names
                    .iter()
                    .position(|name| *name == "Linum communis")
                    .unwrap(),
            "expected all-token Common Name match before taxonomy-only prefix match; got {names:?}"
        );
    }

    #[test]
    fn relevance_common_name_tokens_match_diacritic_queries() {
        let conn = relevance_fixture_db();

        let result = search(
            &conn,
            search_request(
                Some("lin léon"),
                SpeciesFilter::default(),
                None,
                Sort::Relevance,
                10,
                true,
                "fr",
            ),
        )
        .unwrap();

        assert_eq!(
            result
                .items
                .first()
                .map(|item| item.canonical_name.as_str()),
            Some("Linum leonii")
        );
    }

    #[test]
    fn legacy_like_search_treats_normalized_underscores_as_literals() {
        let conn = relevance_fixture_db();
        conn.execute_batch(
            "INSERT INTO species (
                id, canonical_name, slug, common_name, family, genus,
                height_max_m, hardiness_zone_min, hardiness_zone_max,
                growth_rate, stratum, edibility_rating, medicinal_rating, width_max_m
             ) VALUES
                ('literal-double', 'Exact double token', 'exact-double-token', '__', 'Literalaceae', 'Exacta', 1, 1, 1, 'Slow', 'Low', 0, 0, 1),
                ('wild-double', 'Wildcard double token', 'wildcard-double-token', 'ab', 'Literalaceae', 'Wilda', 1, 1, 1, 'Slow', 'Low', 0, 0, 1),
                ('literal-snake', 'Exact snake token', 'exact-snake-token', 'snake_case', 'Literalaceae', 'Exacta', 1, 1, 1, 'Slow', 'Low', 0, 0, 1),
                ('wild-snake', 'Wildcard snake token', 'wildcard-snake-token', 'snakeXcase', 'Literalaceae', 'Wilda', 1, 1, 1, 'Slow', 'Low', 0, 0, 1);

             INSERT INTO species_common_names VALUES
                ('literal-double', '__', 'en', 1, 0),
                ('wild-double', 'ab', 'en', 1, 0),
                ('literal-snake', 'snake_case', 'en', 1, 0),
                ('wild-snake', 'snakeXcase', 'en', 1, 0);

             INSERT INTO best_common_names VALUES
                ('literal-double', 'en', '__'),
                ('wild-double', 'en', 'ab'),
                ('literal-snake', 'en', 'snake_case'),
                ('wild-snake', 'en', 'snakeXcase');

             INSERT INTO species_search_text (
                species_rowid, canonical_name, common_names, family_genus, uses_text, other_text
             )
             SELECT rowid,
                    canopi_normalize_species_search(canonical_name),
                    canopi_normalize_species_search(common_name),
                    canopi_normalize_species_search(family || ' ' || genus),
                    '',
                    ''
             FROM species
             WHERE id IN ('literal-double', 'wild-double', 'literal-snake', 'wild-snake');

             INSERT INTO species_search_common_name_tokens VALUES
                ('literal-double', 'en', '__', 0),
                ('wild-double', 'en', 'ab', 0),
                ('literal-snake', 'en', 'snake_case', 0),
                ('wild-snake', 'en', 'snakexcase', 0);

             INSERT INTO species_search_fts(species_search_fts) VALUES('rebuild');",
        )
        .unwrap();

        for sort in [Sort::Name, Sort::Relevance] {
            for (query, expected) in [
                ("__", "Exact double token"),
                ("snake_case", "Exact snake token"),
            ] {
                let result = search(
                    &conn,
                    search_request(
                        Some(query),
                        SpeciesFilter::default(),
                        None,
                        sort.clone(),
                        20,
                        true,
                        "en",
                    ),
                )
                .unwrap();
                let names = result
                    .items
                    .iter()
                    .map(|item| item.canonical_name.as_str())
                    .collect::<Vec<_>>();

                assert_eq!(names, vec![expected], "query {query:?}, sort {sort:?}");
                assert_eq!(result.total_estimate, 1, "query {query:?}, sort {sort:?}");
            }
        }
    }

    #[test]
    fn latency_harness_covers_first_active_prefixes_without_counts() {
        for (label, locale, query) in [
            ("en-ap", "en", "ap"),
            ("fr-me", "fr", "me"),
            ("fr-po", "fr", "po"),
        ] {
            let case = species_search_latency_cases()
                .iter()
                .find(|case| case.label == label && case.locale == locale && case.query == query)
                .unwrap_or_else(|| panic!("missing latency harness case {label}"));

            assert!(
                !case.include_total,
                "first-active latency case {label} should match production active search"
            );
        }
    }

    #[test]
    #[ignore = "manual latency harness; run with --ignored --nocapture"]
    fn bundled_species_search_latency_harness_reports_list_and_count_timings() {
        run_bundled_species_search_latency_harness().unwrap();
    }

    #[test]
    #[ignore = "manual bundled database relevance check; run with --ignored --nocapture"]
    fn bundled_species_search_relevance_examples_report_ordering() {
        run_bundled_species_search_relevance_examples().unwrap();
    }

    #[test]
    fn count_query_errors_are_returned() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE species (
                id INTEGER PRIMARY KEY,
                canonical_name TEXT NOT NULL,
                slug TEXT NOT NULL,
                common_name TEXT,
                family TEXT,
                genus TEXT,
                height_max_m REAL,
                hardiness_zone_min INTEGER,
                hardiness_zone_max INTEGER,
                growth_rate TEXT,
                stratum TEXT,
                habit TEXT,
                climate_zones TEXT DEFAULT '[]',
                is_annual INTEGER DEFAULT 0,
                is_biennial INTEGER DEFAULT 0,
                is_perennial INTEGER DEFAULT 0,
                edibility_rating INTEGER,
                medicinal_rating INTEGER,
                width_max_m REAL
            );
            CREATE TABLE best_common_names (
                species_id INTEGER NOT NULL,
                language TEXT NOT NULL,
                common_name TEXT NOT NULL,
                PRIMARY KEY (species_id, language)
            );
            CREATE TABLE species_common_names (
                species_id INTEGER NOT NULL,
                common_name TEXT NOT NULL,
                language TEXT NOT NULL,
                is_primary INTEGER NOT NULL DEFAULT 0,
	                display_order INTEGER NOT NULL DEFAULT 0
            );",
        )
        .unwrap();
        crate::db::plant_catalog_connection::initialize_search_connection(&conn).unwrap();

        let error = search(
            &conn,
            search_request(
                Some("lavender"),
                SpeciesFilter::default(),
                None,
                Sort::Relevance,
                10,
                true,
                "en",
            ),
        )
        .unwrap_err();

        assert!(error.contains("Failed to count species search results"));
    }
    fn browse_fixture_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE species (
                id INTEGER PRIMARY KEY,
                canonical_name TEXT NOT NULL,
                slug TEXT NOT NULL,
                common_name TEXT,
                family TEXT,
                genus TEXT,
                height_max_m REAL,
                hardiness_zone_min INTEGER,
                hardiness_zone_max INTEGER,
                growth_rate TEXT,
                stratum TEXT,
                habit TEXT,
                climate_zones TEXT DEFAULT '[]',
                is_annual INTEGER DEFAULT 0,
                is_biennial INTEGER DEFAULT 0,
                is_perennial INTEGER DEFAULT 0,
                edibility_rating INTEGER,
                other_uses_rating INTEGER,
                medicinal_rating INTEGER,
                width_max_m REAL
            );
            CREATE INDEX idx_species_canonical ON species(canonical_name);
            CREATE INDEX idx_species_height_max ON species(height_max_m);
            CREATE INDEX idx_species_edibility ON species(edibility_rating);
            CREATE TABLE best_common_names (
                species_id INTEGER NOT NULL,
                language TEXT NOT NULL,
                common_name TEXT NOT NULL,
                PRIMARY KEY (species_id, language)
            );
            CREATE TABLE species_common_names (
                species_id INTEGER NOT NULL,
                common_name TEXT NOT NULL,
                language TEXT NOT NULL,
                is_primary INTEGER NOT NULL DEFAULT 0,
                display_order INTEGER NOT NULL DEFAULT 0
            );

            INSERT INTO species (
                id, canonical_name, slug, family, height_max_m,
                edibility_rating, other_uses_rating, medicinal_rating
            ) VALUES
                (1, 'Allium cepa', 'allium-cepa', 'Amaryllidaceae', 0.5, 5, 2, 3),
                (2, 'Malus domestica', 'malus-domestica', 'Rosaceae', 4.0, 5, 3, 1),
                (3, 'Rubus idaeus', 'rubus-idaeus', 'Rosaceae', 1.2, 5, 3, 1),
                (4, 'Urtica dioica', 'urtica-dioica', 'Urticaceae', 1.2, 3, NULL, 5),
                (5, 'Quercus robur', 'quercus-robur', 'Fagaceae', 30.0, 0, 4, 2),
                (6, 'Taxus baccata', 'taxus-baccata', 'Taxaceae', 15.0, 0, NULL, NULL),
                (7, 'Aerides odorata', 'aerides-odorata', 'Orchidaceae', NULL, NULL, 5, 5),
                (8, 'Bulbophyllum lobbii', 'bulbophyllum-lobbii', 'Orchidaceae', 0.1, NULL, NULL, NULL),
                (9, 'Crataegus monogyna', 'crataegus-monogyna', 'Rosaceae', 8.0, NULL, 4, 4),
                (10, 'Dendrobium nobile', 'dendrobium-nobile', 'Orchidaceae', NULL, NULL, NULL, NULL),
                (11, 'Prunus spinosa', 'prunus-spinosa', 'Rosaceae', NULL, 4, 3, 3);

            INSERT INTO best_common_names VALUES
                (1, 'en', 'Onion'),
                (2, 'en', 'Apple'),
                (2, 'fr', 'Pommier'),
                (3, 'en', 'Raspberry'),
                (4, 'en', 'Stinging nettle'),
                (4, 'fr', 'Ortie'),
                (5, 'en', 'English oak'),
                (6, 'en', 'Yew'),
                (8, 'fr', 'Bulbophylle'),
                (9, 'en', 'Hawthorn'),
                (10, 'en', 'Noble dendrobium'),
                (11, 'en', 'Blackthorn');",
        )
        .unwrap();
        crate::db::plant_catalog_connection::initialize_search_connection(&conn).unwrap();
        conn
    }

    /// Pages through a browse with `limit`, checking every page's cursor.
    fn browse_all(
        conn: &Connection,
        sort: Sort,
        filters: SpeciesFilter,
        locale: &str,
        limit: u32,
    ) -> Vec<String> {
        let mut names = Vec::new();
        let mut cursor = None;
        for _ in 0..50 {
            let page = search(
                conn,
                search_request(
                    None,
                    filters.clone(),
                    cursor.clone(),
                    sort.clone(),
                    limit,
                    false,
                    locale,
                ),
            )
            .unwrap();
            assert!(page.items.len() <= limit as usize);
            names.extend(page.items.into_iter().map(|item| item.canonical_name));
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => return names,
            }
        }
        panic!("browse did not terminate: {names:?}");
    }

    fn assert_browse_order(
        conn: &Connection,
        sort: Sort,
        filters: SpeciesFilter,
        locale: &str,
        expected: &[&str],
    ) {
        for limit in [1, 2, 3, 4, 20] {
            let names = browse_all(conn, sort.clone(), filters.clone(), locale, limit);
            assert_eq!(
                names, expected,
                "{sort:?} locale={locale} limit={limit} filters={filters:?}"
            );
        }
    }

    #[test]
    fn recommended_browse_orders_rated_then_named_in_locale_then_rest() {
        let conn = browse_fixture_db();

        assert_browse_order(
            &conn,
            Sort::Recommended,
            SpeciesFilter::default(),
            "en",
            &[
                "Malus domestica",
                "Rubus idaeus",
                "Allium cepa",
                "Prunus spinosa",
                "Urtica dioica",
                "Quercus robur",
                "Taxus baccata",
                "Crataegus monogyna",
                "Dendrobium nobile",
                "Aerides odorata",
                "Bulbophyllum lobbii",
            ],
        );
    }

    #[test]
    fn recommended_browse_named_phase_follows_the_ui_locale() {
        let conn = browse_fixture_db();

        assert_browse_order(
            &conn,
            Sort::Recommended,
            SpeciesFilter::default(),
            "fr",
            &[
                "Malus domestica",
                "Rubus idaeus",
                "Allium cepa",
                "Prunus spinosa",
                "Urtica dioica",
                "Quercus robur",
                "Taxus baccata",
                "Bulbophyllum lobbii",
                "Aerides odorata",
                "Crataegus monogyna",
                "Dendrobium nobile",
            ],
        );
    }

    #[test]
    fn name_browse_orders_by_canonical_name() {
        let conn = browse_fixture_db();
        let mut expected = [
            "Aerides odorata",
            "Allium cepa",
            "Bulbophyllum lobbii",
            "Crataegus monogyna",
            "Dendrobium nobile",
            "Malus domestica",
            "Prunus spinosa",
            "Quercus robur",
            "Rubus idaeus",
            "Taxus baccata",
            "Urtica dioica",
        ];
        expected.sort();

        assert_browse_order(&conn, Sort::Name, SpeciesFilter::default(), "en", &expected);
        assert_browse_order(
            &conn,
            Sort::Relevance,
            SpeciesFilter::default(),
            "en",
            &expected,
        );
    }

    #[test]
    fn height_browse_orders_tallest_first_with_unknown_heights_last() {
        let conn = browse_fixture_db();

        assert_browse_order(
            &conn,
            Sort::Height,
            SpeciesFilter::default(),
            "en",
            &[
                "Quercus robur",
                "Taxus baccata",
                "Crataegus monogyna",
                "Malus domestica",
                "Rubus idaeus",
                "Urtica dioica",
                "Allium cepa",
                "Bulbophyllum lobbii",
                "Aerides odorata",
                "Dendrobium nobile",
                "Prunus spinosa",
            ],
        );
    }

    #[test]
    fn edibility_browse_orders_best_rated_first_with_unrated_last() {
        let conn = browse_fixture_db();

        assert_browse_order(
            &conn,
            Sort::Edibility,
            SpeciesFilter::default(),
            "en",
            &[
                "Allium cepa",
                "Malus domestica",
                "Rubus idaeus",
                "Prunus spinosa",
                "Urtica dioica",
                "Quercus robur",
                "Taxus baccata",
                "Aerides odorata",
                "Bulbophyllum lobbii",
                "Crataegus monogyna",
                "Dendrobium nobile",
            ],
        );
    }

    #[test]
    fn browse_sorts_apply_filters_in_every_phase() {
        let conn = browse_fixture_db();
        let rosaceae = SpeciesFilter {
            family: Some("Rosaceae".to_owned()),
            ..SpeciesFilter::default()
        };

        for (sort, expected) in [
            (
                Sort::Recommended,
                [
                    "Malus domestica",
                    "Rubus idaeus",
                    "Prunus spinosa",
                    "Crataegus monogyna",
                ],
            ),
            (
                Sort::Name,
                [
                    "Crataegus monogyna",
                    "Malus domestica",
                    "Prunus spinosa",
                    "Rubus idaeus",
                ],
            ),
            (
                Sort::Height,
                [
                    "Crataegus monogyna",
                    "Malus domestica",
                    "Rubus idaeus",
                    "Prunus spinosa",
                ],
            ),
            (
                Sort::Edibility,
                [
                    "Malus domestica",
                    "Rubus idaeus",
                    "Prunus spinosa",
                    "Crataegus monogyna",
                ],
            ),
        ] {
            assert_browse_order(&conn, sort, rosaceae.clone(), "en", &expected);
        }

        let count = search(
            &conn,
            search_request(None, rosaceae, None, Sort::Recommended, 2, true, "en"),
        )
        .unwrap();
        assert_eq!(count.total_estimate, 4);
    }

    #[test]
    fn sorted_text_search_keeps_the_fts_predicate() {
        let conn = test_db();

        let result = search(
            &conn,
            search_request(
                Some("lavender"),
                SpeciesFilter::default(),
                None,
                Sort::Height,
                1,
                true,
                "en",
            ),
        )
        .unwrap();
        assert_eq!(result.total_estimate, 2);
        assert_eq!(result.items[0].canonical_name, "Lavandula beta");

        let next = search(
            &conn,
            search_request(
                Some("lavender"),
                SpeciesFilter::default(),
                result.next_cursor,
                Sort::Height,
                1,
                false,
                "en",
            ),
        )
        .unwrap();
        assert_eq!(next.items.len(), 1);
        assert_eq!(next.items[0].canonical_name, "Lavandula alpha");
        assert_eq!(next.next_cursor, None);
    }
}
