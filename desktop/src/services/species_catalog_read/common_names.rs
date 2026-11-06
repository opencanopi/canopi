use std::collections::HashMap;

use canopi_types::species::CommonNameEntry;
use rusqlite::{Connection, OptionalExtension, types::ToSql};

/// Returns the best common name for the given locale only (no fallback).
pub fn get_locale_best_common_name(
    conn: &Connection,
    species_id: &str,
    locale: &str,
) -> Option<String> {
    conn.query_row(
        "SELECT common_name FROM best_common_names
         WHERE species_id = ?1 AND language = ?2
         LIMIT 1",
        [species_id, locale],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn get_common_name(conn: &Connection, species_id: &str, locale: &str) -> Option<String> {
    let best = get_locale_best_common_name(conn, species_id, locale);
    if best.is_some() {
        return best;
    }

    let primary_local: Option<String> = conn
        .query_row(
            "SELECT common_name FROM species_common_names
	             WHERE species_id = ?1 AND language = ?2 AND is_primary = 1
	             ORDER BY display_order ASC,
	                      LENGTH(common_name) ASC,
	                      common_name ASC
	             LIMIT 1",
            [species_id, locale],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    if primary_local.is_some() {
        return primary_local;
    }

    if locale != "en" {
        return None;
    }

    conn.query_row(
        "SELECT common_name FROM species
         WHERE id = ?1
         LIMIT 1",
        [species_id],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn get_locale_common_names(
    conn: &Connection,
    canonical_name: &str,
    locale: &str,
) -> Result<Vec<CommonNameEntry>, String> {
    let Some(species_id) = super::detail::resolve_species_id(conn, canonical_name)? else {
        return Ok(vec![]);
    };

    let mut stmt = conn
        .prepare(
            "SELECT common_name, is_primary
	             FROM species_common_names
	             WHERE species_id = ?1 AND language = ?2
	             ORDER BY display_order ASC,
	                      is_primary DESC,
	                      LENGTH(common_name) ASC,
	                      common_name ASC
	             LIMIT 10",
        )
        .map_err(|e| format!("Failed to prepare locale common names query: {e}"))?;

    let rows = stmt
        .query_map([&species_id, &locale.to_string()], |row| {
            Ok(CommonNameEntry {
                name: row.get(0)?,
                is_primary: row.get::<_, i32>(1).unwrap_or(0) == 1,
            })
        })
        .map_err(|e| format!("Failed to query locale common names: {e}"))?
        .filter_map(|result| match result {
            Ok(entry) => Some(entry),
            Err(error) => {
                tracing::warn!("Skipped common name row: {error}");
                None
            }
        })
        .collect();

    Ok(rows)
}

pub(super) fn locale_common_names_for_canonical_name(
    conn: &Connection,
    canonical_name: &str,
    locale: &str,
) -> Result<Vec<CommonNameEntry>, String> {
    get_locale_common_names(conn, canonical_name, locale)
}

pub fn get_common_names_batch(
    conn: &Connection,
    canonical_names: &[String],
    locale: &str,
) -> Result<HashMap<String, String>, String> {
    if canonical_names.is_empty() {
        return Ok(HashMap::new());
    }
    if canonical_names.len() > 500 {
        return Err("Batch size exceeds maximum of 500 names".into());
    }

    let placeholders: Vec<String> = (2..=canonical_names.len() + 1)
        .map(|index| format!("?{index}"))
        .collect();
    let sql = format!(
        "SELECT s.canonical_name,
                COALESCE(
                    bcn_loc.common_name,
                    scn_loc.common_name,
                    CASE WHEN ?1 = 'en' THEN s.common_name ELSE NULL END
                ) AS resolved_name
         FROM species s
         LEFT JOIN best_common_names bcn_loc
           ON bcn_loc.species_id = s.id AND bcn_loc.language = ?1
         LEFT JOIN species_common_names scn_loc
           ON scn_loc.species_id = s.id AND scn_loc.language = ?1 AND scn_loc.is_primary = 1
         WHERE s.canonical_name IN ({})",
        placeholders.join(", "),
    );

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare batch common name query: {e}"))?;

    let mut params: Vec<Box<dyn ToSql>> = Vec::with_capacity(canonical_names.len() + 1);
    params.push(Box::new(locale.to_string()));
    for name in canonical_names {
        params.push(Box::new(name.clone()));
    }
    let param_refs: Vec<&dyn ToSql> = params.iter().map(|value| value.as_ref()).collect();

    let rows = stmt
        .query_map(&*param_refs, |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| format!("Batch common name query failed: {e}"))?;

    let mut result = HashMap::new();
    for row in rows {
        if let Ok((canonical, Some(name))) = row
            && !name.is_empty()
        {
            result.insert(canonical, name);
        }
    }

    Ok(result)
}

pub(super) fn localized_names_for_canonical_names(
    conn: &Connection,
    canonical_names: &[String],
    locale: &str,
) -> Result<HashMap<String, String>, String> {
    get_common_names_batch(conn, canonical_names, locale)
}

/// Translate a value that may contain canonical comma-separated parts
/// (e.g. "Blue, Purple") or legacy slash-separated parts (e.g. "Blue/Purple").
/// Each part is translated individually and rejoined with the original separator style.
pub fn translate_composite_value(
    conn: &Connection,
    field: &str,
    value_en: &str,
    locale: &str,
) -> String {
    let (parts, joiner): (Vec<&str>, &str) = if value_en.contains(", ") {
        (value_en.split(", ").collect(), ", ")
    } else if value_en.contains('/') {
        (value_en.split('/').map(str::trim).collect(), "/")
    } else if value_en.contains(',') {
        (value_en.split(',').map(str::trim).collect(), ", ")
    } else {
        return translate_value(conn, field, value_en, locale);
    };

    if parts.len() <= 1 {
        return translate_value(conn, field, value_en, locale);
    }

    parts
        .into_iter()
        .filter(|part| !part.is_empty())
        .map(|part| translate_value(conn, field, part, locale))
        .collect::<Vec<_>>()
        .join(joiner)
}

pub fn translate_value(conn: &Connection, field: &str, value_en: &str, locale: &str) -> String {
    let column = match locale {
        "fr" => "value_fr",
        "es" => "value_es",
        "pt" => "value_pt",
        "it" => "value_it",
        "zh" => "value_zh",
        "de" => "value_de",
        "ja" => "value_ja",
        "ko" => "value_ko",
        "nl" => "value_nl",
        "ru" => "value_ru",
        _ => return value_en.to_owned(),
    };

    let sql = format!(
        "SELECT COALESCE({column}, value_en) FROM translated_values \
         WHERE field_name = ?1 AND value_en = ?2 LIMIT 1"
    );

    conn.prepare_cached(&sql)
        .and_then(|mut stmt| {
            stmt.query_row([field, value_en], |row| row.get::<_, String>(0))
                .optional()
        })
        .ok()
        .flatten()
        .unwrap_or_else(|| value_en.to_owned())
}
