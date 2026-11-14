//! `sources/<sha256>/meta.json`: the authored facts about one imported
//! original, kept beside it so a catalogue can be rebuilt from the files.
//!
//! The catalogue stays the authority; this file is a derived record rewritten
//! from the catalogue after every publication, rename, analysis definition or
//! deletion. It carries what no raster read can recover: the item's name,
//! quantity and units, the order of its member originals, and the analyses
//! defined over it. Everything measured from pixels (COGs, chunks, ranges,
//! results) is left out and recomputed on demand after a rebuild.
//!
//! An item is recorded while it is published, and also while it is
//! unpublished with a saved import over managed originals only (a recovered
//! item waiting for Retry), so a second rebuild before the Retry loses nothing.
//! A meta whose `items` is empty says the original belongs to no such item; a
//! missing meta says nothing is known, and recovery lists such an original
//! under a generated name rather than losing it.

use super::catalogue;
use super::paths::LidarPaths;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;

pub const META_FILE: &str = "meta.json";
pub const META_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceMeta {
    pub version: u32,
    pub sha256: String,
    pub original_filename: String,
    pub size_bytes: u64,
    pub imported_at: String,
    /// Items this original is a member of, in creation order: published ones
    /// and unpublished ones whose saved import names only managed originals.
    pub items: Vec<ItemMeta>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ItemMeta {
    pub id: String,
    pub name: String,
    /// `RasterQuantity::key` of an importable quantity.
    pub quantity: String,
    pub units: String,
    pub created_at: String,
    /// Member originals in priority order (sha256 each); position 0 is topmost.
    pub members: Vec<String>,
    /// Analyses reading this item or an item derived from it.
    pub analyses: Vec<AnalysisMeta>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnalysisMeta {
    pub definition_id: String,
    pub analysis_id: String,
    pub parameters: serde_json::Value,
    pub outputs: serde_json::Value,
    pub created_at: String,
    pub inputs: Vec<AnalysisInputMeta>,
    pub items: Vec<DerivedItemMeta>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnalysisInputMeta {
    pub input_key: String,
    pub item_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DerivedItemMeta {
    pub id: String,
    pub output_key: String,
    pub quantity: String,
    pub units: String,
    pub name: Option<String>,
    pub created_at: String,
}

/// Derive the meta of every recorded original from the catalogue.
pub fn derive_all(connection: &Connection, paths: &LidarPaths) -> Result<Vec<SourceMeta>, String> {
    let mut metas: BTreeMap<String, SourceMeta> = {
        let mut statement = connection
            .prepare(
                "SELECT sha256, original_filename, size_bytes, imported_at
                 FROM lidar_sources ORDER BY sha256",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(SourceMeta {
                    version: META_VERSION,
                    sha256: row.get(0)?,
                    original_filename: row.get(1)?,
                    size_bytes: row.get::<_, i64>(2)?.max(0) as u64,
                    imported_at: row.get(3)?,
                    items: Vec::new(),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows.into_iter()
            .map(|meta| (meta.sha256.clone(), meta))
            .collect()
    };
    let analyses = all_analyses(connection)?;

    let mut layers = connection
        .prepare(
            "SELECT id, name, quantity, units, created_at
             FROM lidar_source_layers ORDER BY created_at, id",
        )
        .map_err(|e| e.to_string())?;
    let layer_rows = layers
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for (id, name, quantity, units, created_at) in layer_rows {
        let members = match catalogue::head_generation(connection, &id)? {
            Some(head) => {
                let mut members = Vec::new();
                for member in catalogue::collection_members(connection, &head.id)? {
                    let sha256: String = connection
                        .query_row(
                            "SELECT source_sha256 FROM lidar_interpretations WHERE id = ?1",
                            [&member.interpretation_id],
                            |row| row.get(0),
                        )
                        .map_err(|e| format!("Failed to read a member's source: {e}"))?;
                    members.push(sha256);
                }
                members
            }
            None => match unpublished_members(connection, paths, &id, &metas)? {
                Some(members) => members,
                None => continue,
            },
        };
        let item = ItemMeta {
            id: id.clone(),
            name,
            quantity,
            units,
            created_at,
            members: members.clone(),
            analyses: analyses_over(&id, &analyses),
        };
        let mut seen = HashSet::new();
        for sha256 in members {
            if !seen.insert(sha256.clone()) {
                continue;
            }
            if let Some(meta) = metas.get_mut(&sha256) {
                meta.items.push(item.clone());
            }
        }
    }
    Ok(metas.into_values().collect())
}

/// The member originals of an unpublished item, from its latest saved import
/// selection, when every selected path is a recorded managed original.
///
/// A recovered item waits for Retry in exactly this state; an import still
/// selecting files outside the library is left out, as before publication.
fn unpublished_members(
    connection: &Connection,
    paths: &LidarPaths,
    layer_id: &str,
    recorded: &BTreeMap<String, SourceMeta>,
) -> Result<Option<Vec<String>>, String> {
    let request: Option<Option<String>> = connection
        .query_row(
            "SELECT request_json FROM lidar_import_jobs WHERE layer_id = ?1
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [layer_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read an item's saved import: {e}"))?;
    let Some(Some(request)) = request else {
        return Ok(None);
    };
    let Ok(selection) = super::parse_import_request(&request) else {
        return Ok(None);
    };
    let mut members = Vec::with_capacity(selection.len());
    for path in selection {
        let managed = path
            .parent()
            .and_then(|dir| dir.file_name())
            .and_then(|name| name.to_str())
            .filter(|sha256| recorded.contains_key(*sha256))
            .filter(|sha256| paths.source_original(sha256) == path);
        match managed {
            Some(sha256) => members.push(sha256.to_string()),
            None => return Ok(None),
        }
    }
    Ok((!members.is_empty()).then_some(members))
}

fn all_analyses(connection: &Connection) -> Result<Vec<AnalysisMeta>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, analysis_id, parameters_json, outputs_json, created_at
             FROM lidar_analysis_definitions ORDER BY created_at, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut analyses = Vec::with_capacity(rows.len());
    for (definition_id, analysis_id, parameters_json, outputs_json, created_at) in rows {
        let inputs = catalogue::definition_inputs(connection, &definition_id)?
            .into_iter()
            .map(|input| AnalysisInputMeta {
                input_key: input.input_key,
                item_id: input.item_id,
            })
            .collect();
        let mut items_statement = connection
            .prepare(
                "SELECT id, output_key, quantity, units, name, created_at
                 FROM lidar_derived_items WHERE definition_id = ?1 ORDER BY output_key",
            )
            .map_err(|e| e.to_string())?;
        let items = items_statement
            .query_map([&definition_id], |row| {
                Ok(DerivedItemMeta {
                    id: row.get(0)?,
                    output_key: row.get(1)?,
                    quantity: row.get(2)?,
                    units: row.get(3)?,
                    name: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        analyses.push(AnalysisMeta {
            definition_id,
            analysis_id,
            parameters: serde_json::from_str(&parameters_json)
                .unwrap_or(serde_json::Value::Array(Vec::new())),
            outputs: serde_json::from_str(&outputs_json)
                .unwrap_or(serde_json::Value::Array(Vec::new())),
            created_at,
            inputs,
            items,
        });
    }
    Ok(analyses)
}

/// The analyses reachable from `item_id`: those reading it, then those
/// reading their outputs, in definition order.
fn analyses_over(item_id: &str, analyses: &[AnalysisMeta]) -> Vec<AnalysisMeta> {
    let mut known: BTreeSet<String> = BTreeSet::from([item_id.to_string()]);
    let mut taken = vec![false; analyses.len()];
    let mut result = Vec::new();
    loop {
        let mut grew = false;
        for (index, analysis) in analyses.iter().enumerate() {
            if taken[index]
                || !analysis
                    .inputs
                    .iter()
                    .any(|input| known.contains(&input.item_id))
            {
                continue;
            }
            taken[index] = true;
            grew = true;
            for item in &analysis.items {
                known.insert(item.id.clone());
            }
            result.push(analysis.clone());
        }
        if !grew {
            break;
        }
    }
    result
}

/// Write every original's meta beside it; an original no longer on disk is
/// skipped. Returns how many files changed. A meta that cannot be written
/// stays stale alone: the rest are still written, and the failures come back
/// together, each naming its file.
pub fn refresh(connection: &Connection, paths: &LidarPaths) -> Result<usize, String> {
    let mut written = 0;
    let mut failures = Vec::new();
    for meta in derive_all(connection, paths)? {
        if !paths.source_original(&meta.sha256).is_file() {
            continue;
        }
        match write(&paths.source_meta(&meta.sha256), &meta) {
            Ok(true) => written += 1,
            Ok(false) => {}
            Err(error) => failures.push(error),
        }
    }
    if failures.is_empty() {
        Ok(written)
    } else {
        Err(failures.join("; "))
    }
}

/// Mark one original released before the catalogue commit that drops its
/// rows: its meta then names no item, so a catalogue rebuild never lists it
/// again, and the startup sweep removes its folder if the removal that
/// follows the commit never happens. An original already gone needs no mark.
pub fn release(paths: &LidarPaths, sha256: &str) -> Result<(), String> {
    let Ok(original) = std::fs::metadata(paths.source_original(sha256)) else {
        return Ok(());
    };
    let path = paths.source_meta(sha256);
    let known = read(&path).unwrap_or_else(|| SourceMeta {
        version: META_VERSION,
        sha256: String::new(),
        original_filename: "original".to_string(),
        size_bytes: original.len(),
        imported_at: String::new(),
        items: Vec::new(),
    });
    let released = SourceMeta {
        sha256: sha256.to_string(),
        items: Vec::new(),
        ..known
    };
    write(&path, &released).map(|_| ())
}

/// Whether something marked this original released ([`release`]): its own meta reads and names no item. The only
/// proof the startup sweep accepts before it deletes an original (canopi-uidt); a missing or unreadable meta is none.
pub fn is_released(paths: &LidarPaths, sha256: &str) -> bool {
    read(&paths.source_meta(sha256))
        .is_some_and(|meta| meta.sha256 == sha256 && meta.items.is_empty())
}

/// Write `meta` to `path` atomically; unchanged content is left alone.
/// Returns whether the file changed.
pub fn write(path: &Path, meta: &SourceMeta) -> Result<bool, String> {
    let json = serde_json::to_string_pretty(meta)
        .map_err(|e| format!("Failed to encode source meta: {e}"))?;
    if let Ok(existing) = std::fs::read_to_string(path)
        && existing == json
    {
        return Ok(false);
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, json.as_bytes())
        .map_err(|e| format!("Failed to write {}: {e}", temporary.display()))?;
    std::fs::rename(&temporary, path).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        format!("Failed to publish {}: {e}", path.display())
    })?;
    Ok(true)
}

/// Read one original's meta; `None` when absent or unreadable (recovery then
/// treats the original as unknown).
pub fn read(path: &Path) -> Option<SourceMeta> {
    let json = std::fs::read_to_string(path).ok()?;
    let meta: SourceMeta = serde_json::from_str(&json).ok()?;
    (meta.version == META_VERSION).then_some(meta)
}

/// Item metas across a set of source metas, one per item id, in creation order.
pub fn distinct_items(metas: &[SourceMeta]) -> Vec<ItemMeta> {
    let mut by_id: HashMap<String, ItemMeta> = HashMap::new();
    for meta in metas {
        for item in &meta.items {
            by_id.entry(item.id.clone()).or_insert_with(|| item.clone());
        }
    }
    let mut items: Vec<ItemMeta> = by_id.into_values().collect();
    items.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
    items
}

#[cfg(test)]
pub(crate) mod test_support {
    use rusqlite::Connection;

    /// Catalogue rows of one published source item over `members`
    /// (sha256, filename), in priority order, without any raster on disk.
    pub(crate) fn seed_published_item(
        connection: &Connection,
        layer_id: &str,
        name: &str,
        quantity: &str,
        units: &str,
        members: &[(&str, &str)],
    ) {
        connection
            .execute(
                "INSERT INTO lidar_source_layers(id, name, item_kind, quantity, units, created_at)
                 VALUES(?1, ?2, 'raster', ?3, ?4, ?1)",
                rusqlite::params![layer_id, name, quantity, units],
            )
            .unwrap();
        let generation_id = format!("gen-{layer_id}");
        connection
            .execute(
                "INSERT INTO lidar_layer_generations(id, layer_id, created_at, manifest_json, bounds_3857, crs_class)
                 VALUES(?1, ?2, '1', '{}', '[0,0,1,1]', 'projected-metre')",
                rusqlite::params![generation_id, layer_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO lidar_layer_heads(layer_id, generation_id) VALUES(?1, ?2)",
                rusqlite::params![layer_id, generation_id],
            )
            .unwrap();
        for (position, (sha256, filename)) in members.iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO lidar_sources(sha256, original_filename, size_bytes, probe_json, imported_at)
                     VALUES(?1, ?2, 3, '{}', '1') ON CONFLICT(sha256) DO NOTHING",
                    rusqlite::params![sha256, filename],
                )
                .unwrap();
            let interpretation_id = format!("interp-{layer_id}-{sha256}");
            connection
                .execute(
                    "INSERT INTO lidar_interpretations(
                        id, source_sha256, band_index, quantity, units, scale, offset, crs_ref,
                        vertical_ref, geotransform, width, height, interp_hash, valid_cells)
                     VALUES(?1, ?2, 1, ?3, ?4, 1, 0, 'EPSG:2154', 'unspecified', '0,1,0,0,0,-1', 1, 1, ?1, 1)",
                    rusqlite::params![interpretation_id, sha256, quantity, units],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO lidar_collection_members(generation_id, member_id, position, interpretation_id, created_at)
                     VALUES(?1, ?2, ?3, ?4, '1')",
                    rusqlite::params![
                        generation_id,
                        format!("mem-{layer_id}-{position}"),
                        position as i64,
                        interpretation_id
                    ],
                )
                .unwrap();
        }
    }
}

#[cfg(test)]
mod tests;
