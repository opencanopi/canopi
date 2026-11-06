use std::collections::HashMap;

use canopi_types::species::FlowerColorResolution;
use rusqlite::{Connection, params_from_iter};

struct SpeciesFlowerSeed {
    canonical_name: String,
    genus: Option<String>,
    family: Option<String>,
    flower_color: Option<String>,
}

pub fn get_flower_color_batch(
    conn: &Connection,
    canonical_names: &[String],
) -> Result<Vec<FlowerColorResolution>, String> {
    if canonical_names.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = repeat_vars(canonical_names.len());
    let sql = format!(
        "SELECT canonical_name, genus, family, flower_color
         FROM species
         WHERE canonical_name IN ({placeholders})"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare flower color seed query: {e}"))?;
    let seeds = stmt
        .query_map(params_from_iter(canonical_names.iter()), |row| {
            Ok(SpeciesFlowerSeed {
                canonical_name: row.get(0)?,
                genus: row.get(1)?,
                family: row.get(2)?,
                flower_color: row.get(3)?,
            })
        })
        .map_err(|e| format!("Failed to query flower color seeds: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read flower color seeds: {e}"))?;

    let unresolved_genera = seeds
        .iter()
        .filter(|seed| seed.flower_color.is_none())
        .filter_map(|seed| seed.genus.clone())
        .collect::<Vec<_>>();
    let unresolved_families = seeds
        .iter()
        .filter(|seed| seed.flower_color.is_none())
        .filter_map(|seed| seed.family.clone())
        .collect::<Vec<_>>();

    let genus_colors = collect_group_dominant_colors(conn, "genus", &unresolved_genera, 3, 0.5)?;
    let family_colors =
        collect_group_dominant_colors(conn, "family", &unresolved_families, 10, 0.4)?;

    Ok(seeds
        .into_iter()
        .map(|seed| {
            let direct = normalize_primary_flower_color(seed.flower_color.as_deref());
            let genus = seed
                .genus
                .as_ref()
                .and_then(|genus| genus_colors.get(genus))
                .cloned();
            let family = seed
                .family
                .as_ref()
                .and_then(|family| family_colors.get(family))
                .cloned();

            let (flower_color, source) = if direct.is_some() {
                (direct, "species")
            } else if genus.is_some() {
                (genus, "genus")
            } else if family.is_some() {
                (family, "family")
            } else {
                (None, "none")
            };

            FlowerColorResolution {
                canonical_name: seed.canonical_name,
                flower_color,
                source: source.to_string(),
            }
        })
        .collect())
}

pub(super) fn read_projection(
    conn: &Connection,
    canonical_names: &[String],
) -> Result<Vec<FlowerColorResolution>, String> {
    get_flower_color_batch(conn, canonical_names)
}

fn collect_group_dominant_colors(
    conn: &Connection,
    field_name: &str,
    values: &[String],
    min_samples: usize,
    threshold: f32,
) -> Result<HashMap<String, String>, String> {
    let unique_values = dedupe(values);
    if unique_values.is_empty() {
        return Ok(HashMap::new());
    }

    let sql = format!(
        "SELECT {field_name}, flower_color
         FROM species
         WHERE {field_name} IN ({}) AND flower_color IS NOT NULL",
        repeat_vars(unique_values.len())
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare {field_name} flower color query: {e}"))?;
    let rows = stmt
        .query_map(params_from_iter(unique_values.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("Failed to query {field_name} flower colors: {e}"))?;

    let mut counts: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for row in rows {
        let (group_value, flower_color) =
            row.map_err(|e| format!("Failed to read {field_name} flower color row: {e}"))?;
        let Some(normalized_color) = normalize_primary_flower_color(Some(&flower_color)) else {
            continue;
        };
        *counts
            .entry(group_value)
            .or_default()
            .entry(normalized_color)
            .or_default() += 1;
    }

    Ok(counts
        .into_iter()
        .filter_map(|(group_value, color_counts)| {
            let total: usize = color_counts.values().sum();
            if total < min_samples {
                return None;
            }

            let dominant = color_counts
                .iter()
                .max_by(|left, right| left.1.cmp(right.1).then_with(|| right.0.cmp(left.0)))?;
            let ratio = *dominant.1 as f32 / total as f32;
            if ratio < threshold {
                return None;
            }

            Some((group_value, dominant.0.clone()))
        })
        .collect())
}

fn normalize_primary_flower_color(value: Option<&str>) -> Option<String> {
    value
        .and_then(|color| color.split([',', '/']).next())
        .map(str::trim)
        .filter(|color| !color.is_empty())
        .map(ToOwned::to_owned)
}

fn repeat_vars(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(",")
}

fn dedupe(values: &[String]) -> Vec<String> {
    let mut unique = values.to_vec();
    unique.sort();
    unique.dedup();
    unique
}
