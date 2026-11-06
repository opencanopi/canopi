use canopi_types::species::{SpeciesDetail, SpeciesImage, SpeciesUse};
use rusqlite::{Connection, OptionalExtension};

use super::common_names::{get_common_name, translate_composite_value, translate_value};
use super::detail_projection::{detail_query_sql, translate_projected_text_fields};
use super::detail_row_map::map_detail_row;

/// Parse a JSON array string (e.g. `["China", "India"]`) into a
/// comma-separated display string. Returns `None` for empty arrays,
/// passes through non-JSON strings unchanged.
fn parse_json_array_to_display(json_str: &str) -> Option<String> {
    match serde_json::from_str::<Vec<String>>(json_str) {
        Ok(items) if !items.is_empty() => Some(items.join(", ")),
        Ok(_) => None,
        Err(_) => Some(json_str.to_owned()),
    }
}

fn parse_json_array_to_translated_display(
    conn: &Connection,
    field: &str,
    json_str: &str,
    locale: &str,
) -> Option<String> {
    match serde_json::from_str::<Vec<String>>(json_str) {
        Ok(items) if !items.is_empty() => Some(
            items
                .iter()
                .map(|item| translate_value(conn, field, item, locale))
                .collect::<Vec<_>>()
                .join(", "),
        ),
        Ok(_) => None,
        Err(_) => Some(translate_composite_value(conn, field, json_str, locale)),
    }
}

pub fn get_detail(
    conn: &Connection,
    canonical_name: &str,
    locale: &str,
) -> Result<SpeciesDetail, String> {
    let mut stmt = conn
        .prepare(detail_query_sql())
        .map_err(|e| format!("Failed to prepare species detail query: {e}"))?;

    let (species_id, mut detail) = stmt
        .query_row([canonical_name], map_detail_row)
        .map_err(|e| format!("Failed to fetch species detail for '{canonical_name}': {e}"))?;

    detail.common_name = get_common_name(conn, &species_id, locale);

    // Parse distribution JSON arrays into readable comma-separated text
    detail.native_distribution = detail
        .native_distribution
        .as_deref()
        .and_then(parse_json_array_to_display);
    detail.introduced_distribution = detail
        .introduced_distribution
        .as_deref()
        .and_then(parse_json_array_to_display);
    detail.climate_zones = detail.climate_zones.as_deref().and_then(|value| {
        parse_json_array_to_translated_display(conn, "climate_zone", value, locale)
    });

    translate_projected_text_fields(conn, &mut detail, locale)?;

    detail.uses = load_uses(conn, &species_id, locale)?;

    Ok(detail)
}

pub(super) fn read_detail_projection(
    conn: &Connection,
    canonical_name: &str,
    locale: &str,
) -> Result<SpeciesDetail, String> {
    get_detail(conn, canonical_name, locale)
}

/// Names one detail batch resolves at most; each costs a full detail
/// projection on the single Catalog lane.
pub(crate) const MAX_DETAIL_BATCH_NAMES: usize = 500;

pub(super) fn read_detail_projections(
    conn: &Connection,
    canonical_names: &[String],
    locale: &str,
) -> Result<Vec<SpeciesDetail>, String> {
    if canonical_names.len() > MAX_DETAIL_BATCH_NAMES {
        return Err(format!(
            "Batch size exceeds maximum of {MAX_DETAIL_BATCH_NAMES} names"
        ));
    }
    let mut results = Vec::with_capacity(canonical_names.len());
    for name in canonical_names {
        if resolve_species_id(conn, name)?.is_none() {
            tracing::warn!("details_for_canonical_names: skipping missing species '{name}'");
            continue;
        }
        results.push(read_detail_projection(conn, name, locale)?);
    }
    Ok(results)
}

pub fn resolve_species_id(
    conn: &Connection,
    canonical_name: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id FROM species WHERE canonical_name = ?1 LIMIT 1",
        [canonical_name],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("Failed to look up species id for '{canonical_name}': {e}"))
}

pub fn get_species_images(
    conn: &Connection,
    canonical_name: &str,
) -> Result<Vec<SpeciesImage>, String> {
    let Some(species_id) = resolve_species_id(conn, canonical_name)? else {
        return Ok(vec![]);
    };

    let mut stmt = conn
        .prepare(
            "SELECT id, species_id, url, sort_order
	             FROM species_images
	             WHERE species_id = ?1
	             ORDER BY sort_order",
        )
        .map_err(|e| format!("Failed to prepare species images query: {e}"))?;

    Ok(stmt
        .query_map([&species_id], |row| {
            Ok(SpeciesImage {
                id: row.get(0)?,
                species_id: row.get(1)?,
                url: row.get(2)?,
                sort_order: row.get(3)?,
            })
        })
        .map_err(|e| format!("Failed to fetch species images: {e}"))?
        .filter_map(|result| match result {
            Ok(item) => Some(item),
            Err(error) => {
                tracing::warn!("Skipped species image row: {error}");
                None
            }
        })
        .collect())
}

fn load_uses(conn: &Connection, species_id: &str, locale: &str) -> Result<Vec<SpeciesUse>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT use_category, use_description
             FROM species_uses
             WHERE species_id = ?1
             ORDER BY use_category",
        )
        .map_err(|e| format!("Failed to prepare uses query: {e}"))?;

    let rows: Vec<SpeciesUse> = stmt
        .query_map([species_id], |row| {
            Ok(SpeciesUse {
                use_category: row.get(0)?,
                use_description: row.get(1)?,
            })
        })
        .map_err(|e| format!("Failed to fetch uses: {e}"))?
        .filter_map(|result| match result {
            Ok(item) => Some(item),
            Err(error) => {
                tracing::warn!("Skipped uses row: {error}");
                None
            }
        })
        .collect();

    Ok(rows
        .into_iter()
        .map(|mut item| {
            let field = format!("use:{}", item.use_category.replace(' ', "_"));
            if let Some(ref description) = item.use_description {
                item.use_description = Some(translate_value(conn, &field, description, locale));
            }
            item
        })
        .collect())
}
