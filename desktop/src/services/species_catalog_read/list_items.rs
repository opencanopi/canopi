use canopi_types::species::SpeciesListItem;
use rusqlite::{Connection, OptionalExtension, params};

use crate::db::query_builder::{species_list_common_name_join_sql, species_list_select_sql};

use super::list_projection::map_species_list_row;

fn hydrate_species_list_items(
    conn: &Connection,
    canonical_names: &[String],
    locale: &str,
) -> Result<Vec<SpeciesListItem>, String> {
    let mut items = Vec::with_capacity(canonical_names.len());
    let select_sql = species_list_select_sql("?1");
    let common_name_join = species_list_common_name_join_sql("?1");
    let sql = format!(
        "{select_sql}
         FROM species s
         {common_name_join}
         WHERE s.canonical_name = ?2
         LIMIT 1"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare species list item projection: {e}"))?;

    for canonical_name in canonical_names {
        let row: Option<SpeciesListItem> = stmt
            .query_row(params![locale, canonical_name], map_species_list_row)
            .optional()
            .map_err(|e| format!("Failed to hydrate species '{canonical_name}': {e}"))?;

        if let Some(item) = row {
            items.push(item);
        }
    }

    Ok(items)
}

pub(super) fn read_projection(
    conn: &Connection,
    canonical_names: &[String],
    locale: &str,
) -> Result<Vec<SpeciesListItem>, String> {
    hydrate_species_list_items(conn, canonical_names, locale)
}
