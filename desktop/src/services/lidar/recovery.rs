//! Opening a catalogue that cannot simply be opened (ADR 0021).
//!
//! An older or corrupt `lidar-library.sqlite`, or a missing or zero-length
//! one beside originals nothing released, is rebuilt from the originals and
//! their `meta.json` in a staging folder; only once that rebuild commits is
//! the old file copied, byte for byte, under `lidar-library.set-aside/` and
//! replaced by the rebuilt one in one rename (`install.rs`, canopi-uidt). A
//! rebuild that fails leaves the old catalogue where it was, so the next start
//! recovers again. Rebuilt items carry their authored facts
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
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

mod install;
mod restore;
use install::REBUILD_STAGING_DIR;
pub(crate) use restore::relist_unlisted_originals;

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
    /// A catalogue recovery would replace (missing, older or corrupt) beside originals it must not rebuild from: an
    /// original's meta a newer Canopi wrote, or a `sources/` entry it cannot read. Nothing is touched, as for
    /// `Unreadable` (newer data is never written, 2.1-M480; canopi-uidt).
    Withheld(String),
}

impl CatalogueState {
    /// Whether the library writes nothing in this state: no directory, display cache, recovery or sweep (2.1-M488).
    pub fn writes_nothing(&self) -> bool {
        matches!(
            self,
            Self::Newer(_) | Self::Unreadable(_) | Self::Withheld(_)
        )
    }
}

/// The catalogue's state, and whether recovery may act on it: `inspect`, then [`withhold_recovery`].
pub fn inspect_library(paths: &LidarPaths) -> CatalogueState {
    withhold_recovery(paths, inspect(&paths.catalogue_path()))
}

/// `state`, or `Withheld` when it would be recovered beside originals recovery must not rebuild from.
pub fn withhold_recovery(paths: &LidarPaths, state: CatalogueState) -> CatalogueState {
    match state {
        CatalogueState::Missing | CatalogueState::Older(_) | CatalogueState::Corrupt(_) => {
            match source_meta::survey(paths) {
                Ok(survey) if survey.newer => CatalogueState::Withheld(
                    "An original's meta was written by a newer Canopi".to_string(),
                ),
                Ok(_) => state,
                Err(reason) => CatalogueState::Withheld(reason),
            }
        }
        other => other,
    }
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
    /// No catalogue, or a zero-length one, beside originals nothing released.
    Missing,
}

/// How the library opened. Everything but `Ready` is worth showing the user.
#[derive(Debug, Clone, PartialEq)]
pub enum LibraryOpenStatus {
    Ready,
    /// The catalogue was rebuilt from the originals.
    Recovered {
        reason: RecoveryReason,
        /// Where the replaced catalogue file went; none when there was no file.
        set_aside: Option<PathBuf>,
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
    match withhold_recovery(paths, state) {
        CatalogueState::Current => {
            discard_staging(paths);
            open_in_place(&path)
        }
        // A lost catalogue beside originals is rebuilt from them: opened empty, it would list none of them again.
        CatalogueState::Missing => {
            discard_staging(paths);
            match source_meta::survey(paths) {
                Ok(survey) if !survey.unreleased => {
                    match install::set_aside_strays(&path, &paths.set_aside_dir(), &now_stamp()) {
                        Ok(()) => open_in_place(&path),
                        Err(reason) => in_memory(LibraryOpenStatus::Unavailable { reason }),
                    }
                }
                Ok(_) => recover(paths, RecoveryReason::Missing),
                Err(reason) => in_memory(LibraryOpenStatus::Unavailable { reason }),
            }
        }
        CatalogueState::Older(version) => recover(paths, RecoveryReason::OlderVersion(version)),
        CatalogueState::Corrupt(reason) => recover(paths, RecoveryReason::Corrupt(reason)),
        CatalogueState::Newer(found) => in_memory(match catalogue::newer_items(&path) {
            Ok(items) => LibraryOpenStatus::NewerReadOnly { found, items },
            Err(reason) => LibraryOpenStatus::Unavailable { reason },
        }),
        CatalogueState::Unreadable(reason) | CatalogueState::Withheld(reason) => {
            in_memory(LibraryOpenStatus::Unavailable { reason })
        }
    }
}

fn open_in_place(path: &Path) -> Result<OpenedCatalogue, String> {
    match catalogue::open(path) {
        Ok(connection) => Ok(OpenedCatalogue {
            connection,
            status: LibraryOpenStatus::Ready,
        }),
        // Read as current or absent, so a failing read-write open (a lock, a filesystem) is no proof of damage.
        Err(reason) => in_memory(LibraryOpenStatus::Unavailable { reason }),
    }
}

/// Rebuild into the staging folder, commit and close, then replace the old catalogue (`install.rs`). Until that
/// rename the old catalogue stays at its path, so any failure leaves it for the next start to recover again.
fn recover(paths: &LidarPaths, reason: RecoveryReason) -> Result<OpenedCatalogue, String> {
    discard_staging(paths);
    let rebuilt = (|| {
        let staged = install::free_staging_file(&paths.root().join(REBUILD_STAGING_DIR))?;
        let connection = catalogue::open(&staged)?;
        let report = rebuild(&connection, paths)?;
        // The last connection to close checkpoints the log and removes it with the shared-memory file.
        connection
            .close()
            .map_err(|(_, e)| format!("Failed to close the rebuilt catalogue: {e}"))?;
        let catalogue_path = paths.catalogue_path();
        let set_aside = install::install(
            &staged,
            &catalogue_path,
            &paths.set_aside_dir(),
            &now_stamp(),
        )?;
        // Once in place the rebuild is complete on disk: a failing open leaves it for the next start.
        Ok((catalogue::open(&catalogue_path)?, set_aside, report))
    })();
    discard_staging(paths);
    match rebuilt {
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

/// Best effort: a staging folder that cannot be removed now goes at a later start, and never blocks one (a rebuild
/// stages under a free name beside what stays).
fn discard_staging(paths: &LidarPaths) {
    let _ = super::import::remove_dir_if_present(&paths.root().join(REBUILD_STAGING_DIR));
}

fn now_stamp() -> String {
    utc_stamp(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    )
}

fn in_memory(status: LibraryOpenStatus) -> Result<OpenedCatalogue, String> {
    Ok(OpenedCatalogue {
        connection: catalogue::open_in_memory()?,
        status,
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

/// Fill a fresh catalogue from the originals on disk (`restore.rs`).
///
/// Every published item known to a `meta.json` comes back with its name,
/// quantity, units and member order and a failed import over its managed
/// originals, ready for Retry. An original no meta names is listed as its own
/// ground-elevation item under a generated name. Analyses come back as
/// definitions with unpublished outputs, in dependency order.
pub fn rebuild(connection: &Connection, paths: &LidarPaths) -> Result<RebuildReport, String> {
    let restore::Originals { metas, unknown } = restore::scan(paths)?;
    let facts: HashMap<&str, &SourceMeta> = metas
        .iter()
        .map(|meta| (meta.sha256.as_str(), meta))
        .collect();
    let now = now_iso();

    let transaction = connection
        .unchecked_transaction()
        .map_err(|e| format!("Failed to start the catalogue rebuild: {e}"))?;
    let mut report = RebuildReport::default();
    let mut restoration = restore::Restoration::new(HashSet::new(), HashSet::new());
    for item in &source_meta::distinct_items(&metas) {
        if restoration.restore_item(&transaction, paths, &facts, item, &now)? {
            report.items += 1;
        }
    }
    for (sha256, size) in &unknown {
        insert_source(&transaction, sha256, "original", *size, &now)?;
        let id = new_id("lyr");
        insert_recovered_item(
            &transaction,
            paths,
            RecoveredItem {
                layer_id: &id,
                name: &generated_name(sha256),
                quantity: DEFAULT_QUANTITY_KEY,
                units: "m",
                created_at: &now,
            },
            &[sha256.as_str()],
            &now,
        )?;
        restoration.record_generated(id);
        report.generated += 1;
    }
    restoration.restore_ready_analyses(&transaction)?;
    transaction
        .commit()
        .map_err(|e| format!("Failed to commit the catalogue rebuild: {e}"))?;
    Ok(report)
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

/// The authored facts of one source item.
struct RecoveredItem<'a> {
    pub layer_id: &'a str,
    pub name: &'a str,
    pub quantity: &'a str,
    pub units: &'a str,
    pub created_at: &'a str,
}

fn insert_recovered_item(
    connection: &Connection,
    paths: &LidarPaths,
    item: RecoveredItem<'_>,
    members: &[&str],
    now: &str,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO lidar_source_layers(id, name, item_kind, quantity, units, created_at)
             VALUES(?1, ?2, 'raster', ?3, ?4, ?5)",
            rusqlite::params![
                item.layer_id,
                item.name,
                item.quantity,
                item.units,
                item.created_at
            ],
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
            rusqlite::params![new_id("imp"), item.layer_id, request, now],
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
mod failed_rebuild_tests;
#[cfg(test)]
mod install_tests;
#[cfg(test)]
mod relist_tests;
#[cfg(test)]
mod tests;
