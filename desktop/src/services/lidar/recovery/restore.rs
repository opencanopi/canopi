//! Items restored from the originals' `meta.json` into a catalogue: one way for both callers.
//!
//! The rebuild restores every item a meta names into an empty catalogue, in one transaction, and lists each original
//! no meta describes under a generated name. The startup relist (canopi-kc9q) restores into the current catalogue
//! each item the catalogue lacks that the meta of an original no row claims names, one transaction per group of items
//! over shared originals: an empty current catalogue that 2.0.3 left behind its failed rebuild lists those originals again. It never lists an
//! original without a readable meta of its own (it could be a cancelled import's) and never rebuilds the whole
//! catalogue, so a second start, or metas that disagree, write nothing more.
//!
//! The SQL stays with the catalogue's other recovery writes in `recovery.rs`; the reads go through the repository.

use super::super::catalogue::{self, now_iso};
use super::super::paths::LidarPaths;
use super::super::source_meta::{self, AnalysisMeta, ItemMeta, SourceMeta};
use super::{
    Connection, DEFAULT_QUANTITY_KEY, RecoveredItem, insert_definition, insert_recovered_item,
    insert_source,
};
use std::collections::{HashMap, HashSet};

/// What `sources/` holds: each original's own meta (its digest matches its folder), and each original without one,
/// with its size, in folder order.
pub(super) struct Originals {
    pub metas: Vec<SourceMeta>,
    pub unknown: Vec<(String, u64)>,
}

/// Read every original on disk with its meta; an unlistable `sources/` is an error, a missing one is empty.
pub(super) fn scan(paths: &LidarPaths) -> Result<Originals, String> {
    let sources_dir = paths.root().join("sources");
    let mut names: Vec<String> = match std::fs::read_dir(&sources_dir) {
        Ok(entries) => entries
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(format!("Failed to list the library's originals: {error}")),
    };
    names.sort();
    let mut originals = Originals {
        metas: Vec::new(),
        unknown: Vec::new(),
    };
    for sha256 in names {
        let Ok(metadata) = std::fs::metadata(paths.source_original(&sha256)) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        match source_meta::read(&paths.source_meta(&sha256)) {
            Some(meta) if meta.sha256 == sha256 => originals.metas.push(meta),
            _ => originals.unknown.push((sha256, metadata.len())),
        }
    }
    Ok(originals)
}

/// Item and definition ids a catalogue holds, and the analyses restored items carry that wait for their inputs.
#[derive(Clone)]
pub(super) struct Restoration {
    known_items: HashSet<String>,
    seen_definitions: HashSet<String>,
    pending: Vec<AnalysisMeta>,
}

impl Restoration {
    pub fn new(known_items: HashSet<String>, known_definitions: HashSet<String>) -> Self {
        Self {
            known_items,
            seen_definitions: known_definitions,
            pending: Vec::new(),
        }
    }

    /// Record a source item listed under a generated name, which no analysis reads.
    pub fn record_generated(&mut self, item_id: String) {
        self.known_items.insert(item_id);
    }

    /// Record `item` over its members still on disk, with its authored facts and a failed import over those managed
    /// originals, ready for Retry; its analyses wait for [`Self::restore_ready_analyses`]. False, and nothing
    /// written, when no member is on disk.
    pub fn restore_item(
        &mut self,
        connection: &Connection,
        paths: &LidarPaths,
        facts: &HashMap<&str, &SourceMeta>,
        item: &ItemMeta,
        now: &str,
    ) -> Result<bool, String> {
        let present: Vec<&str> = item
            .members
            .iter()
            .map(String::as_str)
            .filter(|sha256| paths.source_original(sha256).is_file())
            .collect();
        if present.is_empty() {
            return Ok(false);
        }
        let (quantity, units) = admitted_quantity(&item.quantity, &item.units);
        for sha256 in &present {
            let (filename, size, imported_at) = match facts.get(sha256) {
                Some(meta) => (
                    meta.original_filename.clone(),
                    meta.size_bytes,
                    meta.imported_at.clone(),
                ),
                None => (
                    "original".to_string(),
                    std::fs::metadata(paths.source_original(sha256))
                        .map(|m| m.len())
                        .unwrap_or(0),
                    now.to_string(),
                ),
            };
            insert_source(connection, sha256, &filename, size, &imported_at)?;
        }
        insert_recovered_item(
            connection,
            paths,
            RecoveredItem {
                layer_id: &item.id,
                name: &item.name,
                quantity,
                units: &units,
                created_at: &item.created_at,
            },
            &present,
            now,
        )?;
        self.known_items.insert(item.id.clone());
        for analysis in &item.analyses {
            if self.seen_definitions.insert(analysis.definition_id.clone()) {
                self.pending.push(analysis.clone());
            }
        }
        Ok(true)
    }

    /// Record each waiting definition once every input it reads exists, in dependency order, so a chain over a
    /// result comes back whole; one over a lost item keeps waiting and is never left dangling.
    pub fn restore_ready_analyses(&mut self, connection: &Connection) -> Result<(), String> {
        self.pending.sort_by(|a, b| {
            (&a.created_at, &a.definition_id).cmp(&(&b.created_at, &b.definition_id))
        });
        loop {
            let (ready, waiting): (Vec<_>, Vec<_>) = std::mem::take(&mut self.pending)
                .into_iter()
                .partition(|analysis| {
                    analysis
                        .inputs
                        .iter()
                        .all(|input| self.known_items.contains(&input.item_id))
                });
            self.pending = waiting;
            if ready.is_empty() {
                return Ok(());
            }
            for analysis in ready {
                if insert_definition(connection, &analysis)? {
                    for item in &analysis.items {
                        self.known_items.insert(item.id.clone());
                    }
                }
            }
        }
    }
}

/// List again each item the catalogue lacks that the meta of an original no `lidar_sources` row claims names, with
/// the analyses it carries (canopi-kc9q). Items over a shared original, or named by one item's original's meta, list
/// together in one transaction or not at all ([`groups`]): a group whose inserts or commit fail is rolled back whole
/// and left, with its originals and metas, for the next start; the failures come back together.
///
/// Startup only, after `recover_interrupted_jobs` failed every job the previous run left running, so the
/// `jobs_in_flight` guard is defensive, as in the other startup steps: a live caller would race an import's own
/// `lidar_sources` and meta writes.
pub(crate) fn relist_unlisted_originals(
    connection: &Connection,
    paths: &LidarPaths,
) -> Result<(), String> {
    if catalogue::jobs_in_flight(connection)? {
        return Ok(());
    }
    let listed: HashSet<String> = catalogue::list_layers(connection)?
        .into_iter()
        .map(|layer| layer.id)
        .chain(
            catalogue::list_derived_items(connection)?
                .into_iter()
                .map(|item| item.id),
        )
        .collect();
    let metas = scan(paths)?.metas;
    // A library whose every named item is listed, the usual one, reads nothing more.
    if metas
        .iter()
        .flat_map(|meta| &meta.items)
        .all(|item| listed.contains(&item.id))
    {
        return Ok(());
    }
    let claimed: HashSet<String> = catalogue::source_sha256s(connection)?.into_iter().collect();
    let metas: Vec<SourceMeta> = metas
        .into_iter()
        .filter(|meta| !claimed.contains(&meta.sha256))
        .collect();
    let items: Vec<ItemMeta> = source_meta::distinct_items(&metas)
        .into_iter()
        .filter(|item| !listed.contains(&item.id))
        .collect();
    let mut defined = HashSet::new();
    for analysis in items.iter().flat_map(|item| &item.analyses) {
        if catalogue::get_definition(connection, &analysis.definition_id)?.is_some() {
            defined.insert(analysis.definition_id.clone());
        }
    }
    let facts: HashMap<&str, &SourceMeta> = metas
        .iter()
        .map(|meta| (meta.sha256.as_str(), meta))
        .collect();
    let now = now_iso();
    let mut restoration = Restoration::new(listed, defined);
    let (mut relisted, mut failures) = (0, Vec::new());
    for group in groups(&items, &metas) {
        let before = restoration.clone();
        let restored = (|| {
            let transaction = connection
                .unchecked_transaction()
                .map_err(|e| format!("Failed to start relisting an item: {e}"))?;
            let mut restored = 0;
            for item in &group {
                restored += usize::from(restoration.restore_item(
                    &transaction,
                    paths,
                    &facts,
                    item,
                    &now,
                )?);
            }
            restoration.restore_ready_analyses(&transaction)?;
            transaction
                .commit()
                .map_err(|e| format!("Failed to commit a relisted item: {e}"))?;
            Ok::<_, String>(restored)
        })();
        match restored {
            Ok(restored) => relisted += restored,
            Err(error) => {
                restoration = before;
                failures.push(error);
            }
        }
    }
    if relisted > 0 {
        tracing::info!(relisted, "listed the items of unlisted originals again");
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

/// `items` split into the groups that list together, each in creation order, the groups in the order of their first
/// item. Two items join when they share a member or one's original's meta names the other. Listing part of a group
/// would claim an original whose meta is a failed item's record; the meta refresh that ends the start then rewrites
/// that meta from the catalogue, and the failed item, its record gone, would never list again.
fn groups<'a>(items: &'a [ItemMeta], metas: &[SourceMeta]) -> Vec<Vec<&'a ItemMeta>> {
    fn root(parent: &mut [usize], mut index: usize) -> usize {
        while parent[index] != index {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }
        index
    }
    let position: HashMap<&str, usize> = items
        .iter()
        .enumerate()
        .map(|(index, item)| (item.id.as_str(), index))
        .collect();
    let mut touches: Vec<(&str, usize)> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        touches.extend(item.members.iter().map(|sha256| (sha256.as_str(), index)));
    }
    for meta in metas {
        for item in &meta.items {
            if let Some(&index) = position.get(item.id.as_str()) {
                touches.push((meta.sha256.as_str(), index));
            }
        }
    }
    let mut parent: Vec<usize> = (0..items.len()).collect();
    let mut first_toucher: HashMap<&str, usize> = HashMap::new();
    for (sha256, index) in touches {
        let first = *first_toucher.entry(sha256).or_insert(index);
        let (a, b) = (root(&mut parent, first), root(&mut parent, index));
        parent[a.max(b)] = a.min(b);
    }
    let mut groups: Vec<Vec<&ItemMeta>> = Vec::new();
    let mut slot: HashMap<usize, usize> = HashMap::new();
    for (index, item) in items.iter().enumerate() {
        let group = root(&mut parent, index);
        let at = *slot.entry(group).or_insert_with(|| {
            groups.push(Vec::new());
            groups.len() - 1
        });
        groups[at].push(item);
    }
    groups
}

/// The item's quantity and units when they are still importable, else the ground-elevation default.
fn admitted_quantity<'a>(quantity: &'a str, units: &str) -> (&'a str, String) {
    match super::super::analyses::parse_quantity(quantity) {
        Ok(parsed) if parsed.is_importable() && !units.trim().is_empty() => {
            (quantity, units.to_string())
        }
        _ => (DEFAULT_QUANTITY_KEY, "m".to_string()),
    }
}
