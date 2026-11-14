//! Opening a catalogue that cannot simply be opened (ADR 0021).
//!
//! An older or corrupt `lidar-library.sqlite` is set aside, byte for byte,
//! under `lidar-library.set-aside/` and a fresh catalogue is rebuilt from the
//! originals and their `meta.json`. Rebuilt items carry their authored facts
//! and a failed import job whose saved selection is the managed originals, so
//! Retry prepares them again on demand; analysis definitions come back with
//! their outputs unpublished, so Retry runs them again once their inputs are
//! ready. Only damage SQLite or Canopi names (`catalogue::UnreadCatalogue`)
//! counts as corrupt; a catalogue that cannot be read or opened for any other
//! reason is left as it is, unavailable. A newer catalogue is read and never
//! written: the library lists its items read-only (`catalogue_reader.rs`).
//! Nothing here ever deletes an original.

use super::catalogue::{self, new_id, now_iso};
use super::paths::LidarPaths;
use super::source_meta::{self, AnalysisMeta, SourceMeta};
use canopi_types::failure::{FailureCode, LibraryReadOnlyReason};
use canopi_types::health::StoreOpenStatus;
use rusqlite::Connection;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Directory under the library root that keeps catalogues set aside.
pub const SET_ASIDE_DIR: &str = "lidar-library.set-aside";

/// Quantity of an original nothing describes: ground elevation in metres.
const DEFAULT_QUANTITY_KEY: &str = canopi_types::library::RasterQuantity::GroundElevation.key();

/// What the catalogue file at the library root is, before it is opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogueState {
    Missing,
    Current,
    Older(i32),
    Newer(i32),
    /// SQLite could not read the file for a reason that is not damage: a write it would need first (a hot journal,
    /// a WAL it cannot index), another process's lock, a failing filesystem or memory. The version or integrity is
    /// unknown, so nothing is touched: no set-aside, rebuild or directory (2.1-M480, 2.1-M488).
    Unreadable(String),
    Corrupt(String),
}

pub fn inspect(path: &Path) -> CatalogueState {
    let Ok(metadata) = std::fs::metadata(path) else {
        return CatalogueState::Missing;
    };
    match catalogue::stored_version(path) {
        Err(catalogue::UnreadCatalogue::Unavailable(reason)) => CatalogueState::Unreadable(reason),
        Err(catalogue::UnreadCatalogue::Damaged(reason)) => CatalogueState::Corrupt(reason),
        // SQLite leaves a zero-length file behind when a catalogue was
        // opened but never created; that is an empty library, not damage.
        Ok(None) if metadata.len() == 0 => CatalogueState::Missing,
        Ok(None) => CatalogueState::Corrupt("the file has no catalogue version".to_string()),
        Ok(Some(version)) if version == catalogue::CATALOGUE_VERSION => {
            match catalogue::quick_check(path) {
                Ok(()) => CatalogueState::Current,
                Err(catalogue::UnreadCatalogue::Unavailable(reason)) => {
                    CatalogueState::Unreadable(reason)
                }
                Err(catalogue::UnreadCatalogue::Damaged(reason)) => CatalogueState::Corrupt(reason),
            }
        }
        Ok(Some(version)) if version < catalogue::CATALOGUE_VERSION => {
            CatalogueState::Older(version)
        }
        Ok(Some(version)) => CatalogueState::Newer(version),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryReason {
    OlderVersion(i32),
    Corrupt(String),
}

/// How the library opened. Everything but `Ready` is worth showing the user.
#[derive(Debug, Clone, PartialEq)]
pub enum LibraryOpenStatus {
    Ready,
    /// The catalogue was set aside and rebuilt from the originals.
    Recovered {
        reason: RecoveryReason,
        set_aside: PathBuf,
        /// Items rebuilt from their `meta.json`.
        items: usize,
        /// Originals without a `meta.json`, listed under a generated name.
        generated: usize,
    },
    /// Written by a newer Canopi: `items` listed, nothing written (2.1-M488).
    NewerReadOnly {
        found: i32,
        items: super::catalogue_reader::NewerItems,
    },
    /// The catalogue could be neither opened nor rebuilt; the library is empty
    /// and read-only, and the files are left as they are.
    Unavailable {
        reason: String,
    },
}

impl LibraryOpenStatus {
    /// The state as the frontend sees it in `SubsystemHealth`: no paths or
    /// reasons, only what the user can act on.
    pub fn health(&self) -> StoreOpenStatus {
        match self {
            Self::Ready => StoreOpenStatus::Ready,
            Self::Recovered {
                items, generated, ..
            } => StoreOpenStatus::Recovered {
                items: u32::try_from(*items).unwrap_or(u32::MAX),
                generated: u32::try_from(*generated).unwrap_or(u32::MAX),
            },
            Self::NewerReadOnly { .. } => StoreOpenStatus::NewerReadOnly,
            Self::Unavailable { .. } => StoreOpenStatus::Unavailable {
                code: FailureCode::LibraryReadOnly {
                    reason: LibraryReadOnlyReason::Unavailable,
                },
            },
        }
    }

    /// Why a mutation is refused while the library is read-only; a newer catalogue's is the silent `store_read_only`.
    pub fn refusal(&self) -> Option<String> {
        match self {
            Self::Ready | Self::Recovered { .. } => None,
            Self::NewerReadOnly { .. } => Some("store_read_only".to_string()),
            Self::Unavailable { reason } => {
                Some(format!("The Data library could not be opened: {reason}"))
            }
        }
    }
}

pub struct OpenedCatalogue {
    pub connection: Connection,
    pub status: LibraryOpenStatus,
}

/// Open the catalogue under `paths`, found in `state`; only an in-memory one failing errs.
pub fn open_catalogue(
    paths: &LidarPaths,
    state: CatalogueState,
) -> Result<OpenedCatalogue, String> {
    let path = paths.catalogue_path();
    match state {
        CatalogueState::Missing | CatalogueState::Current => match catalogue::open(&path) {
            Ok(connection) => Ok(OpenedCatalogue {
                connection,
                status: LibraryOpenStatus::Ready,
            }),
            // Read as current or absent, so a failing read-write open (a lock, a filesystem) is no proof of damage.
            Err(reason) => in_memory(LibraryOpenStatus::Unavailable { reason }),
        },
        CatalogueState::Older(version) => recover(paths, RecoveryReason::OlderVersion(version)),
        CatalogueState::Corrupt(reason) => recover(paths, RecoveryReason::Corrupt(reason)),
        CatalogueState::Newer(found) => in_memory(match catalogue::newer_items(&path) {
            Ok(items) => LibraryOpenStatus::NewerReadOnly { found, items },
            Err(reason) => LibraryOpenStatus::Unavailable { reason },
        }),
        CatalogueState::Unreadable(reason) => in_memory(LibraryOpenStatus::Unavailable { reason }),
    }
}

fn recover(paths: &LidarPaths, reason: RecoveryReason) -> Result<OpenedCatalogue, String> {
    let attempt = (|| -> Result<(Connection, PathBuf, RebuildReport), String> {
        let set_aside = set_aside(paths)?;
        let connection = catalogue::open(&paths.catalogue_path())?;
        let report = rebuild(&connection, paths)?;
        Ok((connection, set_aside, report))
    })();
    match attempt {
        Ok((connection, set_aside, report)) => Ok(OpenedCatalogue {
            connection,
            status: LibraryOpenStatus::Recovered {
                reason,
                set_aside,
                items: report.items,
                generated: report.generated,
            },
        }),
        Err(reason) => in_memory(LibraryOpenStatus::Unavailable { reason }),
    }
}

fn in_memory(status: LibraryOpenStatus) -> Result<OpenedCatalogue, String> {
    Ok(OpenedCatalogue {
        connection: catalogue::open_in_memory()?,
        status,
    })
}

/// Move the catalogue file and its WAL sidecars under the set-aside folder,
/// all or nothing: a sidecar that cannot follow returns the catalogue to its
/// place and fails, so no catalogue is rebuilt beside an old log.
/// Returns the new place of the main file.
pub fn set_aside(paths: &LidarPaths) -> Result<PathBuf, String> {
    let directory = paths.set_aside_dir();
    std::fs::create_dir_all(&directory)
        .map_err(|e| format!("Failed to create {}: {e}", directory.display()))?;
    let stamp = utc_stamp(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    );
    let candidates = (0u32..=10_000).map(|attempt| match attempt {
        0 => directory.join(format!("{stamp}.sqlite")),
        n => directory.join(format!("{stamp}-{n}.sqlite")),
    });
    let source = paths.catalogue_path();
    crate::db::move_aside(&source, candidates, &["-wal", "-shm"]).map_err(|e| {
        format!(
            "Failed to set aside {} under {}: {e}",
            source.display(),
            directory.display()
        )
    })
}

/// `YYYYMMDDTHHMMSSZ` for a Unix time, without a date crate (proleptic
/// Gregorian, days-to-civil by H. Hinnant).
pub fn utc_stamp(unix_seconds: u64) -> String {
    let days = (unix_seconds / 86_400) as i64;
    let seconds = unix_seconds % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        seconds / 3_600,
        (seconds % 3_600) / 60,
        seconds % 60
    )
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RebuildReport {
    pub items: usize,
    pub generated: usize,
}

/// Fill a fresh catalogue from the originals on disk.
///
/// Every published item known to a `meta.json` comes back with its name,
/// quantity, units and member order and a failed import over its managed
/// originals, ready for Retry. An original no meta names is listed as its own
/// ground-elevation item under a generated name. Analyses come back as
/// definitions with unpublished outputs, in dependency order.
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
pub fn rebuild(connection: &Connection, paths: &LidarPaths) -> Result<RebuildReport, String> {
    let sources_dir = paths.root().join("sources");
    let mut names: Vec<String> = match std::fs::read_dir(&sources_dir) {
        Ok(entries) => entries
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(format!("Failed to list {}: {error}", sources_dir.display())),
    };
    names.sort();
    let mut metas: Vec<SourceMeta> = Vec::new();
    let mut unknown: Vec<(String, u64)> = Vec::new();
    for sha256 in names {
        let original = paths.source_original(&sha256);
        let Ok(metadata) = std::fs::metadata(&original) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        match source_meta::read(&paths.source_meta(&sha256)) {
            Some(meta) if meta.sha256 == sha256 => metas.push(meta),
            _ => unknown.push((sha256, metadata.len())),
        }
    }
    let facts: HashMap<&str, &SourceMeta> = metas
        .iter()
        .map(|meta| (meta.sha256.as_str(), meta))
        .collect();
    let items = source_meta::distinct_items(&metas);
    let now = now_iso();

    let transaction = connection
        .unchecked_transaction()
        .map_err(|e| format!("Failed to start the catalogue rebuild: {e}"))?;
    let mut report = RebuildReport::default();
    let mut known_items: HashSet<String> = HashSet::new();
    let mut analyses: Vec<AnalysisMeta> = Vec::new();
    let mut seen_definitions: BTreeSet<String> = BTreeSet::new();
    for item in &items {
        let present: Vec<&str> = item
            .members
            .iter()
            .map(String::as_str)
            .filter(|sha256| paths.source_original(sha256).is_file())
            .collect();
        if present.is_empty() {
            continue;
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
                    now.clone(),
                ),
            };
            insert_source(&transaction, sha256, &filename, size, &imported_at)?;
        }
        insert_recovered_item(
            &transaction,
            paths,
            &item.id,
            &item.name,
            quantity,
            &units,
            &item.created_at,
            &present,
            &now,
        )?;
        known_items.insert(item.id.clone());
        report.items += 1;
        for analysis in &item.analyses {
            if seen_definitions.insert(analysis.definition_id.clone()) {
                analyses.push(analysis.clone());
            }
        }
    }
    for (sha256, size) in &unknown {
        insert_source(&transaction, sha256, "original", *size, &now)?;
        let id = new_id("lyr");
        insert_recovered_item(
            &transaction,
            paths,
            &id,
            &generated_name(sha256),
            DEFAULT_QUANTITY_KEY,
            "m",
            &now,
            &[sha256.as_str()],
            &now,
        )?;
        known_items.insert(id);
        report.generated += 1;
    }

    // Definitions in dependency order: one is recorded once every input it
    // reads exists again, so a chain over a result comes back whole and a
    // definition over a lost item is dropped rather than left dangling.
    analyses
        .sort_by(|a, b| (&a.created_at, &a.definition_id).cmp(&(&b.created_at, &b.definition_id)));
    let mut pending: Vec<AnalysisMeta> = analyses;
    loop {
        let (ready, waiting): (Vec<_>, Vec<_>) = pending.into_iter().partition(|analysis| {
            analysis
                .inputs
                .iter()
                .all(|input| known_items.contains(&input.item_id))
        });
        if ready.is_empty() {
            break;
        }
        for analysis in ready {
            if insert_definition(&transaction, &analysis)? {
                for item in &analysis.items {
                    known_items.insert(item.id.clone());
                }
            }
        }
        pending = waiting;
    }
    transaction
        .commit()
        .map_err(|e| format!("Failed to commit the catalogue rebuild: {e}"))?;
    Ok(report)
}

/// The item's quantity and units when they are still importable, else the
/// ground-elevation default.
fn admitted_quantity<'a>(quantity: &'a str, units: &str) -> (&'a str, String) {
    match super::analyses::parse_quantity(quantity) {
        Ok(parsed) if parsed.is_importable() && !units.trim().is_empty() => {
            (quantity, units.to_string())
        }
        _ => (DEFAULT_QUANTITY_KEY, "m".to_string()),
    }
}

fn generated_name(sha256: &str) -> String {
    let short: String = sha256.chars().take(8).collect();
    format!("Recovered raster {short}")
}

fn insert_source(
    connection: &Connection,
    sha256: &str,
    filename: &str,
    size_bytes: u64,
    imported_at: &str,
) -> Result<(), String> {
    // `probe_json` is measured from the file at import and read by nothing
    // afterwards; a retry re-probes the original.
    connection
        .execute(
            "INSERT INTO lidar_sources(sha256, original_filename, size_bytes, probe_json, imported_at)
             VALUES(?1, ?2, ?3, '{}', ?4) ON CONFLICT(sha256) DO NOTHING",
            rusqlite::params![sha256, filename, size_bytes as i64, imported_at],
        )
        .map_err(|e| format!("Failed to record a recovered source: {e}"))?;
    Ok(())
}

#[expect(
    clippy::too_many_arguments,
    reason = "ratcheted before 2.1-M188; group the arguments when this function next changes"
)]
fn insert_recovered_item(
    connection: &Connection,
    paths: &LidarPaths,
    layer_id: &str,
    name: &str,
    quantity: &str,
    units: &str,
    created_at: &str,
    members: &[&str],
    now: &str,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO lidar_source_layers(id, name, item_kind, quantity, units, created_at)
             VALUES(?1, ?2, 'raster', ?3, ?4, ?5)",
            rusqlite::params![layer_id, name, quantity, units, created_at],
        )
        .map_err(|e| format!("Failed to record a recovered item: {e}"))?;
    let selection: Vec<PathBuf> = members
        .iter()
        .map(|sha256| paths.source_original(sha256))
        .collect();
    let request = super::import_request_json(&selection)?;
    connection
        .execute(
            // A failed import to retry; the Data library's banner says why.
            "INSERT INTO lidar_import_jobs(id, layer_id, state, request_json, created_at, updated_at)
             VALUES(?1, ?2, 'failed', ?3, ?4, ?4)",
            rusqlite::params![new_id("imp"), layer_id, request, now],
        )
        .map_err(|e| format!("Failed to record a recovered import: {e}"))?;
    Ok(())
}

/// Record one definition with its inputs and unpublished outputs. Returns
/// false when an output quantity is not one this Canopi knows.
fn insert_definition(connection: &Connection, analysis: &AnalysisMeta) -> Result<bool, String> {
    if analysis
        .items
        .iter()
        .any(|item| super::analyses::parse_quantity(&item.quantity).is_err())
    {
        return Ok(false);
    }
    connection
        .execute(
            "INSERT INTO lidar_analysis_definitions(id, analysis_id, parameters_json, outputs_json, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                analysis.definition_id,
                analysis.analysis_id,
                analysis.parameters.to_string(),
                analysis.outputs.to_string(),
                analysis.created_at,
            ],
        )
        .map_err(|e| format!("Failed to record a recovered analysis: {e}"))?;
    for input in &analysis.inputs {
        connection
            .execute(
                "INSERT INTO lidar_analysis_inputs(definition_id, input_key, item_id) VALUES(?1, ?2, ?3)",
                rusqlite::params![analysis.definition_id, input.input_key, input.item_id],
            )
            .map_err(|e| format!("Failed to record a recovered analysis input: {e}"))?;
    }
    for item in &analysis.items {
        connection
            .execute(
                "INSERT INTO lidar_derived_items(id, definition_id, output_key, item_kind, quantity, units, name, created_at)
                 VALUES(?1, ?2, ?3, 'raster', ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    item.id,
                    analysis.definition_id,
                    item.output_key,
                    item.quantity,
                    item.units,
                    item.name,
                    item.created_at,
                ],
            )
            .map_err(|e| format!("Failed to record a recovered result: {e}"))?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests;
