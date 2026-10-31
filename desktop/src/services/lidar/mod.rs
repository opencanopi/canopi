//! Local LiDAR raster library service.
//!
//! The subsystem owns files, jobs, engines and caches; the map host owns map
//! lifetime and documents own presentation references. Library mutations
//! never dirty a Design, and no catalogue lock is held during raster
//! computation.

#[cfg(test)]
mod acceptance_hooks;
pub mod admission;
pub(crate) mod analyses;
mod analysis_registry_generated;
pub mod catalogue;
mod collection;
mod coverage;
mod display_cog;
#[cfg(test)]
mod e2e;
pub mod engine;
#[cfg(test)]
mod gdal_engine;
mod generation;
mod geolibre;
pub mod grid;
pub mod import;
mod inspection;
#[cfg(test)]
mod measurement;
pub mod paths;
mod prepared_raster;
pub mod presentation;
mod process;
mod raster_assets;
pub(crate) mod recovery;
pub(crate) mod rust_engine;
pub(crate) mod source_meta;

use catalogue::{new_id, now_iso};
use common_types::library::{
    AnalysisReceipt, AnalysisRequest, LibraryDeleteImpact, LibraryItemRole, ProcessingHistoryPage,
    ProcessingRun, ProcessingRunOutput, RasterQuantity,
};
use common_types::lidar::{
    LidarImportJob, LidarImportJobState, LidarImportProgress, LidarImportProgressPhase,
    LidarImportRefusal, LidarImportRefusalReason,
};
use engine::RasterEngine;
use paths::LidarPaths;
use rusqlite::{Connection, OptionalExtension as _};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::MutexGuard;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub type LidarSnapshot = common_types::library::LibrarySnapshot;

#[derive(Clone)]
pub struct LidarLibrary {
    pub(crate) inner: Arc<LidarLibraryInner>,
}

/// The executor class LiDAR's raster work runs on: import, analysis and display
/// preparation (U50(1)). Not Local, so a heavy job and a display plan never fill
/// the Local slots that saves, loads and Site data sampling need.
pub(crate) const RASTER_WORK: crate::native_operation::NativeOperationClass =
    crate::native_operation::NativeOperationClass::Raster;

pub(crate) struct LidarLibraryInner {
    pub(crate) paths: LidarPaths,
    catalogue: Mutex<Connection>,
    /// How the catalogue opened; anything but `Ready` is a diagnostic, and a
    /// refused library takes no mutation.
    status: recovery::LibraryOpenStatus,
    display_cache: Mutex<Connection>,
    pub(crate) engine: Box<dyn RasterEngine>,
    /// The pinned GeoLibre CLI sidecar every registered analysis runs on.
    pub(crate) geolibre: geolibre::GeolibreEngine,
    /// Each running job's flag, set when the job is cancelled or, for an
    /// import, once its work is done and it only settles; the entry goes
    /// once the job has settled and let go of the heavy lease.
    cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    executor: Mutex<Option<crate::native_operation::NativeOperationExecutor>>,
    /// One exclusive heavy raster job at a time, library-wide. Import and
    /// analysis jobs hold it.
    heavy_job: Mutex<Option<String>>,
    /// One sampling turn library-wide (architecture review finding 3), taken
    /// before a Local slot: hover, pin and profile reads never hold more than
    /// one of Local's running slots, so a save is always admitted beside them.
    sampling: Arc<tokio::sync::Semaphore>,
    /// What sampling keeps between requests (the unreadable targets already
    /// logged).
    sample_memo: Mutex<inspection::SampleMemo>,
    /// One lane preparing display derivatives, separate from numeric jobs.
    display_preparation: Mutex<display_cog::DisplayPreparation>,
}

/// The display basis a stored label names.
///
/// An unrecognised or absent label is read as `Exact`: that is the conservative
/// reading, because a range presented as measured never claims more than it is.
/// Total size of the regular files under `root`; symbolic links are not
/// followed, and a file removed during the walk is skipped.
fn directory_size(root: &std::path::Path) -> std::io::Result<u64> {
    let mut total = 0u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok(total)
}

pub(crate) fn display_range_basis(
    stored: Option<&str>,
) -> common_types::lidar::LidarDisplayRangeBasis {
    match stored {
        Some("source-envelope") => common_types::lidar::LidarDisplayRangeBasis::SourceEnvelope,
        _ => common_types::lidar::LidarDisplayRangeBasis::Exact,
    }
}

/// The stored label for one display basis.
pub(crate) fn display_basis_label(
    basis: common_types::lidar::LidarDisplayRangeBasis,
) -> &'static str {
    match basis {
        common_types::lidar::LidarDisplayRangeBasis::Exact => "exact",
        common_types::lidar::LidarDisplayRangeBasis::SourceEnvelope => "source-envelope",
    }
}

/// Exclusive ownership of the library's heavy raster work.
///
/// The lease is held for exactly as long as the work runs and released when
/// the guard drops, so a queued submission is refused promptly instead of
/// creating running work that would compete for the same disk, memory and
/// in-process raster buffers. Its key only tells holders apart: Import takes
/// it before its item and job exist, so nothing is recorded on a busy library.
/// What a committed Delete leaves to free: the item's own jobs, which must
/// let go first, and the candidates nothing else may still claim.
#[derive(Debug)]
pub(crate) struct DeletedItem {
    pub(crate) job_ids: Vec<String>,
    originals: Vec<String>,
    assets: Vec<String>,
    generations: Vec<String>,
}

/// The key prefix of a lease held only to free files.
const FREEING_LEASE: &str = "free";

pub(crate) struct HeavyJobLease {
    inner: Arc<LidarLibraryInner>,
    job_id: String,
}

impl HeavyJobLease {
    fn acquire(library: &LidarLibrary, job_id: &str) -> Result<Self, String> {
        let mut holder = library
            .inner
            .heavy_job
            .lock()
            .map_err(|_| "LiDAR heavy job lease poisoned".to_string())?;
        if holder.as_deref().is_some_and(|current| current != job_id) {
            return Err(
                "another raster job is already running; retry when it finishes".to_string(),
            );
        }
        *holder = Some(job_id.to_string());
        Ok(Self {
            inner: library.inner.clone(),
            job_id: job_id.to_string(),
        })
    }
}

impl HeavyJobLease {
    /// The lease Delete and Dismiss free files under.
    fn acquire_for_freeing(library: &LidarLibrary) -> Result<Self, String> {
        Self::acquire(library, &new_id(FREEING_LEASE))
    }
}

impl Drop for HeavyJobLease {
    fn drop(&mut self) {
        if let Ok(mut holder) = self.inner.heavy_job.lock()
            && holder.as_deref() == Some(self.job_id.as_str())
        {
            *holder = None;
        }
    }
}

impl LidarLibrary {
    /// Open the library under the app data directory.
    ///
    /// A bad catalogue never stops the app: an older or corrupt one is set
    /// aside and rebuilt from the originals, a newer one is refused and the
    /// library runs empty in memory (`recovery.rs`). The display cache and the
    /// startup sweep are best effort too. Only the managed directories failing
    /// to exist is an error.
    pub fn open(app_data_dir: &std::path::Path) -> Result<Self, String> {
        let paths = LidarPaths::open(app_data_dir)?;
        let recovery::OpenedCatalogue {
            connection: catalogue,
            status,
        } = recovery::open_catalogue(&paths)?;
        match &status {
            recovery::LibraryOpenStatus::Ready => {}
            recovery::LibraryOpenStatus::Recovered {
                reason,
                set_aside,
                items,
                generated,
            } => tracing::warn!(
                ?reason,
                set_aside = %set_aside.display(),
                items,
                generated,
                "LiDAR catalogue set aside and rebuilt from the originals"
            ),
            recovery::LibraryOpenStatus::RefusedNewer { found, supported } => tracing::warn!(
                found,
                supported,
                "LiDAR catalogue written by a newer Canopi; the library is empty and read-only"
            ),
            recovery::LibraryOpenStatus::Unavailable { reason } => tracing::error!(
                %reason,
                "LiDAR catalogue could not be opened or rebuilt; the library is empty and read-only"
            ),
        }
        let display_cache = open_display_cache_or_recreate(&paths.display_cache_path())?;
        let engine_logs = paths.engine_log_dir();
        let library = Self {
            inner: Arc::new(LidarLibraryInner {
                paths,
                catalogue: Mutex::new(catalogue),
                status,
                display_cache: Mutex::new(display_cache),
                engine: Box::new(rust_engine::RustRasterEngine),
                geolibre: geolibre::GeolibreEngine::in_dir(engine_logs),
                cancel_flags: Mutex::new(HashMap::new()),
                executor: Mutex::new(None),
                heavy_job: Mutex::new(None),
                sampling: Arc::new(tokio::sync::Semaphore::new(1)),
                sample_memo: Mutex::new(inspection::SampleMemo::default()),
                display_preparation: Mutex::new(display_cog::DisplayPreparation::default()),
            }),
        };
        // A library that does not own its catalogue file sweeps nothing: the
        // files belong to the catalogue that was refused.
        if library.inner.status.refusal().is_some() {
            return Ok(library);
        }
        // Recovery: interrupted jobs fail explicitly; published results and
        // immutable originals are unaffected.
        {
            let connection = library.catalogue()?;
            analyses::recover_interrupted_jobs(&connection)?;
        }
        library.prune_transient_artifacts();
        library.refresh_source_meta();
        Ok(library)
    }

    /// How the catalogue opened at startup.
    pub fn open_status(&self) -> &recovery::LibraryOpenStatus {
        &self.inner.status
    }

    /// Refuse a mutation while the library does not own its catalogue file.
    fn ensure_writable(&self) -> Result<(), String> {
        match self.inner.status.refusal() {
            Some(reason) => Err(reason),
            None => Ok(()),
        }
    }

    /// Rewrite every original's `meta.json` from the catalogue, best effort:
    /// the catalogue stays the authority and a failed write is only logged.
    /// Never called while a catalogue guard is held.
    fn refresh_source_meta(&self) {
        let result = self
            .catalogue()
            .and_then(|connection| source_meta::refresh(&connection, &self.inner.paths));
        if let Err(error) = result {
            tracing::warn!(%error, "failed to refresh LiDAR source meta files");
        }
    }

    /// Attach the managed Native Operation Executor so queued calculations run
    /// through the same bounded admission as command work.
    pub fn attach_executor(&self, executor: crate::native_operation::NativeOperationExecutor) {
        if let Ok(mut slot) = self.inner.executor.lock() {
            *slot = Some(executor);
        }
        // Nothing is enqueued here: a saved result is a fixed library item and
        // no analysis runs merely because the library reopened.
    }

    fn executor(&self) -> Result<crate::native_operation::NativeOperationExecutor, String> {
        self.inner
            .executor
            .lock()
            .map_err(|_| "LiDAR executor slot poisoned".to_string())?
            .clone()
            .ok_or_else(|| "LiDAR executor is not attached".to_string())
    }

    pub(crate) fn catalogue(&self) -> Result<CatalogueGuard<'_>, String> {
        Ok(CatalogueGuard(self.inner.catalogue.lock().map_err(
            |_| "LiDAR catalogue lock poisoned".to_string(),
        )?))
    }

    pub(crate) fn display(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.inner
            .display_cache
            .lock()
            .map_err(|_| "LiDAR display cache lock poisoned".to_string())
    }

    /// Remove analysis scratch that no running job owns.
    ///
    /// A job removes its own scratch when it settles; a crash leaves it. Only
    /// a job still `preparing` keeps its directory, and startup recovery has
    /// already failed every job the previous run left preparing.
    fn prune_analysis_scratch(&self) -> Result<(), String> {
        let prepared = self.inner.paths.prepared_dir();
        let entries = match std::fs::read_dir(&prepared) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(format!("Failed to list {}: {error}", prepared.display()));
            }
        };
        let connection = self.catalogue()?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(job_id) = name.strip_prefix(paths::ANALYSIS_SCRATCH_PREFIX) else {
                continue;
            };
            let running = connection
                .query_row(
                    "SELECT 1 FROM lidar_analysis_jobs WHERE id = ?1 AND state = 'preparing'",
                    [job_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .is_some();
            if running {
                continue;
            }
            if let Err(error) = std::fs::remove_dir_all(entry.path()) {
                tracing::warn!(job_id, %error, "failed to remove settled analysis scratch");
            }
        }
        Ok(())
    }

    /// Best-effort bounded cleanup at startup: job roots of settled jobs,
    /// released originals, unregistered display derivatives, settled analysis
    /// scratch, leftover engine output, unpublished chunk rows, unreferenced
    /// assets and the derivatives of assets and generations now gone. Each
    /// step that fails is logged and left for the next start; none stops the
    /// library.
    fn prune_transient_artifacts(&self) {
        type Step = fn(&LidarLibrary) -> Result<(), String>;
        let steps: [(&str, Step); 8] = [
            ("settled job roots", Self::prune_settled_job_roots),
            ("released originals", Self::prune_released_originals),
            // Display derivatives nobody registered, and interrupted writes,
            // can go now: no WebView reader exists before the library opens.
            (
                "display derivatives",
                display_cog::prune_display_derivatives,
            ),
            ("analysis scratch", Self::prune_analysis_scratch),
            ("engine output", Self::prune_leftover_engine_logs),
            (
                "unpublished chunk rows",
                Self::discard_unpublished_chunk_rows,
            ),
            ("unreferenced assets", Self::prune_unreferenced_assets),
            (
                "orphaned display derivatives",
                Self::prune_orphaned_derivatives,
            ),
        ];
        for (step, prune) in steps {
            if let Err(error) = prune(self) {
                tracing::warn!(step, %error, "startup cleanup step failed; kept until the next start");
            }
        }
    }

    /// Every import job root no running job owns: a settled job's, and one
    /// whose import a cancel withdrew before its job settled. Each frees the
    /// files its job wrote that no item claims.
    fn prune_settled_job_roots(&self) -> Result<(), String> {
        let running: std::collections::HashSet<String> = {
            let connection = self.catalogue()?;
            let mut statement = connection
                .prepare(
                    "SELECT id FROM lidar_import_jobs
                     WHERE state = 'staging' OR state = 'applying'",
                )
                .map_err(|e| e.to_string())?;
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?
        };
        for entry in std::fs::read_dir(self.inner.paths.jobs_dir())
            .into_iter()
            .flatten()
            .flatten()
        {
            let job_id = entry.file_name().to_string_lossy().into_owned();
            if !running.contains(&job_id) {
                self.discard_import_job_files(&job_id);
            }
        }
        Ok(())
    }

    /// Release each original no item and no saved import selection claims,
    /// then remove each `sources/<sha256>/` folder nothing claims: no
    /// catalogue row names it and its `meta.json` names no item. Dismiss and
    /// Delete release an original's meta and rows, then remove its folder; a
    /// stop or a failed removal between the two, or a Delete while another
    /// raster job ran, leaves the rest for this step.
    fn prune_released_originals(&self) -> Result<(), String> {
        let sources = self.inner.paths.root().join("sources");
        let entries = match std::fs::read_dir(&sources) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("Failed to list {}: {error}", sources.display())),
        };
        let connection = self.catalogue()?;
        if catalogue::jobs_in_flight(&connection)? {
            return Ok(());
        }
        {
            let known: Vec<String> = {
                let mut statement = connection
                    .prepare("SELECT sha256 FROM lidar_sources")
                    .map_err(|e| e.to_string())?;
                statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<_, _>>()
                    .map_err(|e| e.to_string())?
            };
            let transaction = connection
                .unchecked_transaction()
                .map_err(|e| e.to_string())?;
            import::release_unclaimed_originals(&transaction, &self.inner.paths, known)?;
            transaction.commit().map_err(|e| e.to_string())?;
        }
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let sha256 = entry.file_name().to_string_lossy().into_owned();
            let claimed: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM lidar_sources WHERE sha256 = ?1)
                     OR EXISTS(
                         SELECT 1 FROM lidar_import_jobs WHERE instr(request_json, ?1) > 0)",
                    [&sha256],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if claimed
                || source_meta::read(&self.inner.paths.source_meta(&sha256))
                    .is_some_and(|meta| !meta.items.is_empty())
            {
                continue;
            }
            if let Err(error) = import::remove_original_dirs(self, &[sha256]) {
                tracing::warn!(%error, "a released original was kept until the next start");
            }
        }
        Ok(())
    }

    /// Output files of engine children an earlier process never reaped.
    fn prune_leftover_engine_logs(&self) -> Result<(), String> {
        let removed = process::prune_engine_logs(&self.inner.paths.engine_log_dir())?;
        if removed > 0 {
            tracing::info!(removed, "removed leftover engine output files");
        }
        Ok(())
    }

    /// A job that crashed before its publish transaction left chunk rows that
    /// were never readable. Removing them cannot revoke an accepted
    /// generation; the files they named are swept with the other unreferenced
    /// assets afterwards.
    fn discard_unpublished_chunk_rows(&self) -> Result<(), String> {
        let connection = self.catalogue()?;
        let discarded = catalogue::discard_unpublished_chunks(&connection)?;
        if discarded > 0 {
            tracing::info!(discarded, "discarded unpublished raster chunk rows");
        }
        Ok(())
    }

    /// Forget each registered display derivative whose asset no catalogue
    /// row references and whose generation is gone, with its file: those of
    /// an item deleted while another raster job ran, or prepared by a plan
    /// that was already running when its item was deleted. Runs after the
    /// unreferenced assets go, and not while a job is in flight.
    fn prune_orphaned_derivatives(&self) -> Result<(), String> {
        let (referenced, generations) = {
            let connection = self.catalogue()?;
            if catalogue::jobs_in_flight(&connection)? {
                return Ok(());
            }
            let mut statement = connection
                .prepare(
                    "SELECT id FROM lidar_derived_generations
                     UNION SELECT id FROM lidar_layer_generations",
                )
                .map_err(|e| e.to_string())?;
            let generations: Vec<String> = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            (
                catalogue::referenced_asset_digests(&connection)?,
                generations,
            )
        };
        let owners: Vec<String> = referenced
            .iter()
            .map(|sha256| display_cog::asset_prefix(sha256))
            .chain(generations.iter().map(|id| display_cog::gen_prefix(id)))
            .collect();
        let mut forgotten = 0usize;
        for key in display_cog::registered_derivative_keys(self)? {
            if !owners.iter().any(|owner| key.starts_with(owner.as_str())) {
                display_cog::forget_derivatives(self, &key)?;
                forgotten += 1;
            }
        }
        if forgotten > 0 {
            tracing::info!(forgotten, "forgot display derivatives of deleted items");
        }
        Ok(())
    }

    /// Delete asset directories and metadata rows no catalogue reference owns.
    ///
    /// Files reach the store before the transaction that references them, so a
    /// crash or failure between the two leaves unreferenced files; they are
    /// removed here. A digest a source interpretation or any chunk row names is
    /// never touched, and nothing is swept while an import or calculation is
    /// in flight, because its files may not be referenced yet. Startup
    /// recovery has already failed every job the previous run left running.
    fn prune_unreferenced_assets(&self) -> Result<(), String> {
        let connection = self.catalogue()?;
        if catalogue::jobs_in_flight(&connection)? {
            return Ok(());
        }
        let referenced = catalogue::referenced_asset_digests(&connection)?;
        let asset_root = self.inner.paths.root().join("assets");
        let entries = std::fs::read_dir(&asset_root)
            .map_err(|e| format!("Failed to list {}: {e}", asset_root.display()))?;
        let mut removed = 0usize;
        for entry in entries.flatten() {
            if referenced.contains(entry.file_name().to_string_lossy().as_ref()) {
                continue;
            }
            let path = entry.path();
            let result = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            match result {
                Ok(()) => removed += 1,
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "failed to remove an unreferenced asset");
                }
            }
        }
        catalogue::discard_unreferenced_asset_rows(&connection)?;
        if removed > 0 {
            tracing::info!(removed, "removed unreferenced raster assets");
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn engine_status(&self) -> common_types::lidar::LidarEngineStatus {
        match self.inner.engine.version() {
            Ok(version) => common_types::lidar::LidarEngineStatus {
                available: true,
                version: Some(version),
                detail: None,
            },
            Err(error) => common_types::lidar::LidarEngineStatus {
                available: false,
                version: None,
                detail: Some(error),
            },
        }
    }

    /// Import › "Covers your site": the WGS84 box around the chosen files.
    /// Reads metadata only; nothing is copied or recorded.
    pub fn import_coverage(
        &self,
        paths: &[std::path::PathBuf],
    ) -> Result<common_types::lidar::LidarImportCoverage, String> {
        coverage::import_coverage(self.inner.engine.as_ref(), paths)
    }

    /// Bytes the Data library folder occupies on this device: sources,
    /// prepared data, results, display files and the catalogue.
    pub fn disk_usage(&self) -> Result<u64, String> {
        directory_size(self.inner.paths.root())
            .map_err(|error| format!("Canopi could not measure the Data library: {error}"))
    }

    pub fn library_snapshot(&self) -> Result<LidarSnapshot, String> {
        let geolibre = self.inner.geolibre.discover();
        let connection = self.catalogue()?;
        presentation::library_snapshot(&connection, self.inner.engine.as_ref(), &geolibre)
    }

    /// The native cell under each point of each target (spec §1.10), in
    /// target and point order; one call serves hover, the pin and a profile.
    pub fn sample_points(
        &self,
        request: &common_types::lidar::LidarSamplePointsRequest,
    ) -> Result<Vec<common_types::lidar::LidarSampleSeries>, String> {
        inspection::sample_points(self, self.inner.engine.as_ref(), request)
    }

    /// Test support: an empty item row, before any import job is recorded.
    #[cfg(test)]
    pub fn create_layer(
        &self,
        name: &str,
        quantity: RasterQuantity,
        unit_label: Option<&str>,
        unit_unknown: bool,
    ) -> Result<String, String> {
        self.ensure_writable()?;
        let name = name.trim();
        if name.is_empty() {
            return Err("Layer name must not be empty".to_string());
        }
        let id = new_id("lyr");
        let units = resolve_units(quantity, unit_label, unit_unknown)?;
        let connection = self.catalogue()?;
        connection
            .execute(
                "INSERT INTO lidar_source_layers(id, name, item_kind, quantity, units, created_at)
                 VALUES(?1, ?2, 'raster', ?3, ?4, ?5)",
                rusqlite::params![id, name, quantity.key(), units, now_iso()],
            )
            .map_err(|e| format!("Failed to create layer: {e}"))?;
        Ok(id)
    }

    /// Rename one library item. The name is library metadata: values, inputs
    /// and identity are unchanged, and nothing becomes out of date.
    pub fn rename_item(&self, item_id: &str, name: &str) -> Result<(), String> {
        self.ensure_writable()?;
        let name = name.trim();
        if name.is_empty() {
            return Err("Name must not be empty".to_string());
        }
        let connection = self.catalogue()?;
        let mut changed = 0;
        for sql in [
            "UPDATE lidar_source_layers SET name = ?2 WHERE id = ?1",
            "UPDATE lidar_derived_items SET name = ?2 WHERE id = ?1",
        ] {
            changed += connection
                .execute(sql, rusqlite::params![item_id, name])
                .map_err(|e| format!("Failed to rename: {e}"))?;
        }
        if changed == 0 {
            return Err(format!("Item {item_id} does not exist"));
        }
        drop(connection);
        self.refresh_source_meta();
        Ok(())
    }

    /// What deleting one item would affect: the derived items calculated
    /// from it, which must be deleted first.
    pub fn delete_impact(&self, item_id: &str) -> Result<LibraryDeleteImpact, String> {
        let connection = self.catalogue()?;
        if analyses::item_facts(&connection, item_id)?.is_none() {
            return Err(format!("Item {item_id} does not exist"));
        }
        Ok(LibraryDeleteImpact {
            dependent_item_ids: catalogue::dependent_items(&connection, item_id)?,
        })
    }

    /// Test support: Delete as `lidar_delete_item` runs it, without waiting
    /// for the item's own cancelled jobs before freeing its files.
    #[cfg(test)]
    pub(crate) fn delete_item(&self, item_id: &str) -> Result<(), String> {
        let deleted = self.delete_item_rows(item_id)?;
        self.free_deleted_item(&deleted);
        Ok(())
    }

    /// Delete one library item: cancel its jobs, delete its rows in one
    /// committed transaction and drop its queued display plans. Returns what
    /// [`Self::free_deleted_item`] frees once those jobs have let go.
    ///
    /// Refused while results were calculated from it: they keep their meaning
    /// only while their input exists, so they are deleted explicitly first and
    /// there is no cascade. A derived item takes its generations with it, and
    /// its definition, runs and history go with the definition's last item.
    #[expect(
        clippy::too_many_lines,
        reason = "ratcheted before 2.1-M188; split when this function next changes"
    )]
    pub(crate) fn delete_item_rows(&self, item_id: &str) -> Result<DeletedItem, String> {
        self.ensure_writable()?;
        let (kind, job_ids) = {
            let connection = self.catalogue()?;
            refuse_dependents(&connection, item_id)?;
            if catalogue::get_layer(&connection, item_id)?.is_some() {
                let jobs = string_column(
                    &connection,
                    "SELECT id FROM lidar_import_jobs WHERE layer_id = ?1",
                    item_id,
                )?;
                (LibraryItemRole::Source, jobs)
            } else if let Some(item) = catalogue::get_derived_item(&connection, item_id)? {
                let jobs =
                    if catalogue::definition_items(&connection, &item.definition_id)?.len() == 1 {
                        string_column(
                            &connection,
                            "SELECT id FROM lidar_analysis_jobs WHERE definition_id = ?1",
                            &item.definition_id,
                        )?
                    } else {
                        Vec::new()
                    };
                (LibraryItemRole::Derived, jobs)
            } else {
                return Err(format!("Item {item_id} does not exist"));
            }
        };
        for job_id in &job_ids {
            self.cancel_job(job_id);
        }
        let connection = self.catalogue()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        // Recheck inside the transaction: a result created meanwhile keeps its
        // input.
        refuse_dependents(&transaction, item_id)?;
        let deleted = match kind {
            LibraryItemRole::Source => {
                let mut originals = string_column(
                    &transaction,
                    "SELECT DISTINCT interpretation.source_sha256
                     FROM lidar_collection_members AS member
                     JOIN lidar_interpretations AS interpretation
                       ON interpretation.id = member.interpretation_id
                     JOIN lidar_layer_generations AS generation
                       ON generation.id = member.generation_id
                     WHERE generation.layer_id = ?1",
                    item_id,
                )?;
                for sha256 in self.saved_managed_originals(&transaction, item_id)? {
                    if !originals.contains(&sha256) {
                        originals.push(sha256);
                    }
                }
                let assets = string_column(
                    &transaction,
                    "SELECT DISTINCT cog.asset_sha256
                     FROM lidar_collection_members AS member
                     JOIN lidar_interpretation_cogs AS cog
                       ON cog.interpretation_id = member.interpretation_id
                     JOIN lidar_layer_generations AS generation
                       ON generation.id = member.generation_id
                     WHERE generation.layer_id = ?1
                     UNION
                     SELECT chunk.asset_sha256 FROM lidar_generation_chunks AS chunk
                     JOIN lidar_layer_generations AS generation
                       ON generation.id = chunk.generation_id
                     WHERE generation.layer_id = ?1",
                    item_id,
                )?;
                let generations = string_column(
                    &transaction,
                    "SELECT id FROM lidar_layer_generations WHERE layer_id = ?1",
                    item_id,
                )?;
                delete_source_rows(&transaction, item_id)?;
                DeletedItem {
                    job_ids,
                    originals,
                    assets,
                    generations,
                }
            }
            LibraryItemRole::Derived => {
                let assets = string_column(
                    &transaction,
                    "SELECT DISTINCT chunk.asset_sha256 FROM lidar_generation_chunks AS chunk
                     JOIN lidar_derived_generations AS generation
                       ON generation.id = chunk.generation_id
                     WHERE generation.item_id = ?1",
                    item_id,
                )?;
                let generations = string_column(
                    &transaction,
                    "SELECT id FROM lidar_derived_generations WHERE item_id = ?1",
                    item_id,
                )?;
                delete_derived_rows(&transaction, item_id)?;
                DeletedItem {
                    job_ids,
                    originals: Vec::new(),
                    assets,
                    generations,
                }
            }
        };
        transaction.commit().map_err(|e| e.to_string())?;
        drop(connection);
        if let Err(error) = self.forget_entity_plans(kind, item_id) {
            tracing::warn!(item_id, %error, "a deleted item's display plans were kept");
        }
        self.refresh_source_meta();
        Ok(deleted)
    }

    /// Free what a committed Delete left: the managed originals and source
    /// COGs no other item claims, the chunks of its generations, their display
    /// derivatives (relief included) and its settled jobs' folders.
    ///
    /// Runs under the heavy lease, as Dismiss does, so no import stages the
    /// same content meanwhile; while another raster job holds it, or a removal
    /// fails, the files stay and the next start frees them. Never fails.
    pub(crate) fn free_deleted_item(&self, deleted: &DeletedItem) {
        let Ok(_lease) = HeavyJobLease::acquire_for_freeing(self) else {
            tracing::info!(
                "a raster job is running; a deleted item's files are freed at the next start"
            );
            return;
        };
        if let Err(error) = self.release_deleted_files(deleted) {
            tracing::warn!(%error, "a deleted item's files were kept until the next start");
        }
    }

    fn release_deleted_files(&self, deleted: &DeletedItem) -> Result<(), String> {
        let (originals, referenced) = {
            let connection = self.catalogue()?;
            let transaction = connection
                .unchecked_transaction()
                .map_err(|e| e.to_string())?;
            let originals = import::release_unclaimed_originals(
                &transaction,
                &self.inner.paths,
                deleted.originals.clone(),
            )?;
            transaction.commit().map_err(|e| e.to_string())?;
            (originals, catalogue::referenced_asset_digests(&connection)?)
        };
        let mut kept = Vec::new();
        if let Err(error) = import::remove_original_dirs(self, &originals) {
            kept.push(error);
        }
        for sha256 in deleted
            .assets
            .iter()
            .filter(|sha| !referenced.contains(*sha))
        {
            // The row first: an asset left without one is swept at start.
            if let Err(error) = self.catalogue().and_then(|connection| {
                connection
                    .execute(
                        "DELETE FROM lidar_raster_assets WHERE sha256 = ?1",
                        [sha256],
                    )
                    .map_err(|e| e.to_string())
            }) {
                kept.push(error);
                continue;
            }
            for freed in [
                import::remove_dir_if_present(&self.inner.paths.asset_dir(sha256)),
                display_cog::forget_asset_derivatives(self, sha256),
            ] {
                if let Err(error) = freed {
                    kept.push(error);
                }
            }
        }
        for generation_id in &deleted.generations {
            if let Err(error) =
                display_cog::forget_derivatives(self, &display_cog::gen_prefix(generation_id))
            {
                kept.push(error);
            }
        }
        // Under the lease every job of the item has let go of its folder.
        for job_id in &deleted.job_ids {
            if let Err(error) = import::remove_job_root(self, job_id) {
                kept.push(error);
            }
        }
        if kept.is_empty() {
            Ok(())
        } else {
            Err(kept.join("; "))
        }
    }

    /// One bounded page of a definition's runs, newest first.
    pub fn processing_history(
        &self,
        definition_id: &str,
        cursor: Option<&str>,
    ) -> Result<ProcessingHistoryPage, String> {
        let before = cursor
            .map(|cursor| {
                cursor
                    .split_once(':')
                    .map(|(created_at, id)| (created_at.to_string(), id.to_string()))
                    .ok_or_else(|| "invalid processing history cursor".to_string())
            })
            .transpose()?;
        let connection = self.catalogue()?;
        if catalogue::get_definition(&connection, definition_id)?.is_none() {
            return Err(format!("Analysis {definition_id} does not exist"));
        }
        let page = common_types::library::PROCESSING_HISTORY_PAGE;
        let mut jobs = catalogue::analysis_job_page(
            &connection,
            definition_id,
            before
                .as_ref()
                .map(|(created_at, id)| (created_at.as_str(), id.as_str())),
            page + 1,
        )?;
        let has_more = jobs.len() as i64 > page;
        jobs.truncate(usize::try_from(page).unwrap_or(usize::MAX));
        let next_cursor = match (has_more, jobs.last()) {
            (true, Some(last)) => Some(format!("{}:{}", last.created_at, last.id)),
            _ => None,
        };
        let runs = jobs
            .into_iter()
            .map(|job| {
                let outputs = catalogue::job_generations(&connection, &job.id)?
                    .into_iter()
                    .map(|generation| ProcessingRunOutput {
                        item_id: generation.item_id,
                        generation_id: generation.id,
                        coverage_cells: generation
                            .coverage_cells
                            .and_then(|cells| u64::try_from(cells).ok()),
                    })
                    .collect();
                Ok(ProcessingRun {
                    state: analyses::parse_job_state(&job.state),
                    message: job.message,
                    recipe_version: u32::try_from(job.recipe_version).unwrap_or(0),
                    tool: analyses::parse_tool(job.tool_provenance.as_deref()),
                    inputs: analyses::parse_pinned_inputs(&job.input_generations_json)?,
                    created_at: job.created_at,
                    finished_at: job.finished_at,
                    outputs,
                    job_id: job.id,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(ProcessingHistoryPage {
            definition_id: definition_id.to_string(),
            runs,
            next_cursor,
        })
    }

    /// The ordered composition of one Data Layer, one bounded member page at a
    /// time.
    ///
    /// Membership and order are library data, so the Design is never dirtied by
    /// a reorder and every referencing Design sees the same list. A member page
    /// is bound to the immutable snapshot it was requested from: a late page of
    /// a different head is refused by name rather than mixed into its list.
    pub fn layer_collection(
        &self,
        layer_id: &str,
        cursor: Option<&str>,
    ) -> Result<common_types::lidar::LidarLayerCollection, String> {
        let (cursor_head, after_position) = match cursor {
            Some(cursor) => {
                let (head, position) = collection::decode_member_cursor(cursor)?;
                (Some(head), Some(position))
            }
            None => (None, None),
        };
        let connection = self.catalogue()?;
        let head_id = catalogue::head_generation(&connection, layer_id)?.map(|row| row.id);
        let (member_rows, member_count) = match head_id.as_deref() {
            Some(head) => {
                if let Some(cursor_head) = cursor_head.as_deref()
                    && cursor_head != head
                {
                    return Err(
                        "the layer changed since this page was requested; refresh and try again"
                            .to_string(),
                    );
                }
                let rows = catalogue::collection_members_page(
                    &connection,
                    head,
                    after_position,
                    common_types::lidar::LAYER_MEMBER_PAGE,
                )?;
                let count = catalogue::collection_member_count(&connection, head)?;
                (rows, count)
            }
            None => (Vec::new(), 0),
        };
        let last_position = member_rows.last().map(|row| row.position);
        let sources = member_rows
            .iter()
            .map(|member| {
                let id = member.interpretation_id.as_str();
                let interpretation = catalogue::get_interpretation(&connection, id)?
                    .ok_or_else(|| format!("missing interpretation {id}"))?;
                let (coverage_cells, min_value, max_value) =
                    catalogue::interpretation_coverage(&connection, id)?;
                let filename = catalogue::interpretation_filename(&connection, id)?
                    .ok_or_else(|| format!("missing source of interpretation {id}"))?;
                let width = u32::try_from(interpretation.width.max(0)).unwrap_or(u32::MAX);
                let height = u32::try_from(interpretation.height.max(0)).unwrap_or(u32::MAX);
                let pixel_size_m = import::parse_geotransform(&interpretation.geotransform)
                    .map(|transform| transform[1].abs())
                    .unwrap_or(0.0);
                Ok(common_types::lidar::LidarLayerSource {
                    member_id: member.member_id.clone(),
                    filename,
                    interpretation_id: member.interpretation_id.clone(),
                    width,
                    height,
                    pixel_size_m,
                    coverage_cells: coverage_cells.max(0) as u64,
                    value_range: [min_value.unwrap_or(0.0), max_value.unwrap_or(0.0)],
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let has_more = sources.len() as i64 == common_types::lidar::LAYER_MEMBER_PAGE
            && (after_position.unwrap_or(-1) + sources.len() as i64) < member_count;
        let next_member_cursor = match (&head_id, last_position, has_more) {
            (Some(head), Some(position), true) => {
                Some(collection::encode_member_cursor(head, position))
            }
            _ => None,
        };
        Ok(common_types::lidar::LidarLayerCollection {
            layer_id: layer_id.to_string(),
            head_generation_id: head_id,
            member_count: u32::try_from(member_count.max(0)).unwrap_or(u32::MAX),
            sources,
            next_member_cursor,
        })
    }

    /// Wait for the library's one sampling turn; a request over the generated
    /// caps is refused first, so it never waits or holds the turn.
    pub(crate) async fn sampling_turn(
        &self,
        request: &common_types::lidar::LidarSamplePointsRequest,
    ) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
        inspection::check_sample_caps(request)?;
        Arc::clone(&self.inner.sampling)
            .acquire_owned()
            .await
            .map_err(|_| "the LiDAR sampler is closed".to_string())
    }

    #[cfg(test)]
    pub fn get_import_job(&self, job_id: &str) -> Result<Option<LidarImportJob>, String> {
        let connection = self.catalogue()?;
        import_job_summary(&connection, job_id)
    }

    pub(crate) fn record_import_progress(
        &self,
        job_id: &str,
        phase: LidarImportProgressPhase,
        percent: u8,
    ) {
        let result = self.catalogue().and_then(|connection| {
            catalogue::update_import_progress(
                &connection,
                job_id,
                import_progress_phase_key(phase),
                percent,
            )
            .map(|_| ())
        });
        if let Err(error) = result {
            tracing::warn!(job_id, error, "LiDAR import progress update failed");
        }
    }

    // ------------------------------------------------------------------
    // Job orchestration
    // ------------------------------------------------------------------

    fn register_cancel(&self, job_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut flags) = self.inner.cancel_flags.lock() {
            flags.insert(job_id.to_string(), Arc::clone(&flag));
        }
        flag
    }

    fn settle_cancel(&self, job_id: &str) {
        if let Ok(mut flags) = self.inner.cancel_flags.lock() {
            flags.remove(job_id);
        }
    }

    /// Cancel a calculation from the UI. Sets the job's flag on the caller's
    /// thread, a bounded in-memory step, and moves the row update onto the
    /// executor's `UserData` lane: the synchronous cancel command must never
    /// wait for the catalogue lock a running import or deletion holds. The
    /// flag is registered before a job's receipt is returned, so a job that
    /// has not started yet finds it set; the job settles its own row either
    /// way.
    pub fn signal_cancel(&self, job_id: &str) {
        self.set_cancel_flag(job_id);
        let Ok(executor) = self.executor() else {
            return;
        };
        let library = self.clone();
        let job_id = job_id.to_string();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = executor
                .run(
                    crate::native_operation::NativeOperationClass::UserData,
                    "lidar cancel job",
                    move || {
                        library.mark_job_cancelled(&job_id);
                        Ok(())
                    },
                )
                .await
            {
                tracing::warn!(error = %error, "cancelled job row left to the job's own settlement");
            }
        });
    }

    /// Cancel from inside library work that already runs on the executor
    /// (deleting an item): flag and rows together.
    pub fn cancel_job(&self, job_id: &str) {
        self.set_cancel_flag(job_id);
        self.mark_job_cancelled(job_id);
    }

    /// Cancel one import (user, 2026-10-09): the job stops at its next step
    /// and its import is withdrawn at once (`withdraw_cancelled_import`); the
    /// job's settlement removes the files it wrote that nothing claims. The
    /// withdrawal and a publication are each one catalogue transaction, so an
    /// import that published first keeps its finished item.
    pub fn cancel_import(&self, job_id: &str) -> Result<(), String> {
        self.set_cancel_flag(job_id);
        self.withdraw_cancelled_import(job_id)
    }

    /// Withdraw one cancelled import that has not published. A Retry's job
    /// row goes, so the item reads Failed again under its earlier import,
    /// with Retry and Dismiss, and its saved selection still names its
    /// originals and their `meta.json` the item; a first import's item goes
    /// with its job, so the same file imports again under its default name.
    /// A published item, a job that already settled (its failure stays on
    /// the item) or one the catalogue no longer has is left alone.
    fn withdraw_cancelled_import(&self, job_id: &str) -> Result<(), String> {
        let withdrawn = {
            let connection = self.catalogue()?;
            let layer_id: Option<String> = connection
                .query_row(
                    "SELECT layer_id FROM lidar_import_jobs
                     WHERE id = ?1 AND state IN ('staging', 'applying')",
                    [job_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let Some(layer_id) = layer_id else {
                return Ok(());
            };
            let transaction = connection
                .unchecked_transaction()
                .map_err(|e| e.to_string())?;
            let withdrawn = withdraw_import_rows(&transaction, &layer_id, job_id)?;
            transaction.commit().map_err(|e| e.to_string())?;
            withdrawn
        };
        if withdrawn {
            // The originals' meta follows the item, kept or deleted.
            self.refresh_source_meta();
        }
        Ok(())
    }

    /// Remove what one unpublished import job wrote (`import::discard_job_files`),
    /// best effort: a step that fails is logged, and startup tries again.
    pub(super) fn discard_import_job_files(&self, job_id: &str) {
        if let Err(error) = import::discard_job_files(self, job_id) {
            tracing::warn!(job_id, %error, "an unpublished import kept files until the next start");
        }
    }

    pub(crate) fn set_cancel_flag(&self, job_id: &str) {
        // The running job observes the flag between steps and kills its
        // engine processes.
        if let Ok(flags) = self.inner.cancel_flags.lock()
            && let Some(flag) = flags.get(job_id)
        {
            flag.store(true, Ordering::Relaxed);
        }
    }

    fn mark_job_cancelled(&self, job_id: &str) {
        if let Ok(connection) = self.catalogue() {
            let _ = connection.execute(
                "UPDATE lidar_analysis_jobs
                 SET state = 'cancelled', message = NULL, finished_at = ?2,
                     updated_at = ?2
                 WHERE id = ?1 AND state = 'preparing'",
                rusqlite::params![job_id, now_iso()],
            );
        }
    }

    /// Record one import as a new fixed library item and its first job.
    ///
    /// Picking files creates nothing; submitting them creates exactly one item
    /// and one job, together. The saved request keeps the selection order,
    /// which is the item's source priority, so Retry resubmits it unchanged.
    pub fn record_import_item(
        &self,
        name: &str,
        quantity: RasterQuantity,
        unit_label: Option<&str>,
        unit_unknown: bool,
        paths: &[PathBuf],
    ) -> Result<(String, String), String> {
        self.ensure_writable()?;
        if paths.is_empty() {
            return Err("no files were selected for import".to_string());
        }
        let name = name.trim();
        if name.is_empty() {
            return Err("Layer name must not be empty".to_string());
        }
        let units = resolve_units(quantity, unit_label, unit_unknown)?;
        let request = import_request_json(paths)?;
        let layer_id = new_id("lyr");
        let job_id = new_id("imp");
        let connection = self.catalogue()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|e| format!("Failed to start the import record: {e}"))?;
        let now = now_iso();
        transaction
            .execute(
                "INSERT INTO lidar_source_layers(id, name, item_kind, quantity, units, created_at)
                 VALUES(?1, ?2, 'raster', ?3, ?4, ?5)",
                rusqlite::params![layer_id, name, quantity.key(), units, now],
            )
            .map_err(|e| format!("Failed to create the library item: {e}"))?;
        transaction
            .execute(
                "INSERT INTO lidar_import_jobs(id, layer_id, state, request_json, created_at, updated_at)
                 VALUES(?1, ?2, 'staging', ?3, ?4, ?4)",
                rusqlite::params![job_id, layer_id, request, now],
            )
            .map_err(|e| format!("Failed to record the import: {e}"))?;
        transaction
            .commit()
            .map_err(|e| format!("Failed to record the import: {e}"))?;
        Ok((layer_id, job_id))
    }

    /// Record a new job for an unpublished item whose import failed, reusing
    /// the item identity and its saved request.
    pub fn record_import_retry(
        &self,
        layer_id: &str,
    ) -> Result<(String, String, Vec<PathBuf>), String> {
        self.ensure_writable()?;
        let connection = self.catalogue()?;
        let SavedRetry { request, paths, .. } = saved_retry(&connection, layer_id)?;
        let job_id = new_id("imp");
        connection
            .execute(
                "INSERT INTO lidar_import_jobs(id, layer_id, state, request_json, created_at, updated_at)
                 VALUES(?1, ?2, 'staging', ?3, ?4, ?4)",
                rusqlite::params![job_id, layer_id, request, now_iso()],
            )
            .map_err(|e| format!("Failed to record the import retry: {e}"))?;
        Ok((layer_id.to_string(), job_id, paths))
    }

    /// Remove an unpublished item whose import failed.
    ///
    /// Only that operation's own metadata and files go; a published item is
    /// deleted through the library deletion guard instead. A rebuilt item's
    /// saved selection names managed originals: those no other item claims
    /// go with it, under the heavy lease as a settling import frees its own,
    /// so Dismiss is refused while another raster job runs.
    pub fn dismiss_import(&self, layer_id: &str) -> Result<(), String> {
        {
            let (_lease, originals) = self.release_dismissed_item(layer_id)?;
            // Still under the lease, so no import stages this content meanwhile.
            if let Err(error) = import::remove_original_dirs(self, &originals) {
                tracing::warn!(layer_id, %error, "a dismissed item's original was not removed");
            }
        }
        // A failed import freed the files it created as it settled; one it
        // kept goes at the next start.
        self.refresh_source_meta();
        Ok(())
    }

    /// Dismiss's catalogue step: delete the failed item's rows with those of
    /// the managed originals no other item claims, in one committed
    /// transaction, and return those originals with the lease their removal
    /// must stay under.
    fn release_dismissed_item(
        &self,
        layer_id: &str,
    ) -> Result<(Option<HeavyJobLease>, Vec<String>), String> {
        self.ensure_writable()?;
        let connection = self.catalogue()?;
        let running: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM lidar_import_jobs WHERE layer_id = ?1
                 AND state IN ('staging', 'applying'))",
                [layer_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if running {
            return Err("this import is still running; cancel it first".to_string());
        }
        let managed = self.saved_managed_originals(&connection, layer_id)?;
        let lease = if managed.is_empty() {
            None
        } else {
            Some(HeavyJobLease::acquire_for_freeing(self)?)
        };
        let transaction = connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        if !delete_unpublished_item_rows(&transaction, layer_id)? {
            return Err("this item is published; delete it from the library instead".to_string());
        }
        let originals =
            import::release_unclaimed_originals(&transaction, &self.inner.paths, managed)?;
        transaction.commit().map_err(|e| e.to_string())?;
        Ok((lease, originals))
    }

    /// The managed originals (`sources/<sha256>/original`) any saved import
    /// selection of `layer_id` names.
    fn saved_managed_originals(
        &self,
        connection: &Connection,
        layer_id: &str,
    ) -> Result<Vec<String>, String> {
        let mut managed = Vec::new();
        for request in string_column(
            connection,
            "SELECT request_json FROM lidar_import_jobs
             WHERE layer_id = ?1 AND request_json IS NOT NULL",
            layer_id,
        )? {
            for path in parse_import_request(&request).unwrap_or_default() {
                let sha256 = path
                    .parent()
                    .and_then(|dir| dir.file_name())
                    .and_then(|sha256| sha256.to_str())
                    .filter(|sha256| self.inner.paths.source_original(sha256) == path);
                if let Some(sha256) = sha256
                    && !managed.iter().any(|known| known == sha256)
                {
                    managed.push(sha256.to_string());
                }
            }
        }
        Ok(managed)
    }

    /// Record and start one import as a new library item. A file Canopi
    /// cannot place, or a raster job already running, is refused here, in the
    /// import dialog, before any item or job exists (canopi-try2, U31, U32);
    /// only headers are read. Every refusal carries its kind; one that is
    /// only text (a failed catalogue write) is `Internal`.
    pub fn import_item(
        &self,
        name: &str,
        quantity: RasterQuantity,
        unit_label: Option<&str>,
        unit_unknown: bool,
        paths: Vec<PathBuf>,
    ) -> Result<common_types::lidar::LidarImportReceipt, LidarImportRefusal> {
        self.admit_writes()?;
        import::validate_selection(&paths, &admission::source_name)?;
        admission::check_sources_placeable(
            self.inner.engine.as_ref(),
            &paths,
            &admission::source_name,
        )?;
        let lease = self.admit_heavy_job()?;
        let (layer_id, job_id) =
            self.record_import_item(name, quantity, unit_label, unit_unknown, &paths)?;
        Ok(self.start_recorded_import(lease, &layer_id, &job_id, paths)?)
    }

    /// Import's and Retry's writable check: a library opened read-only or not
    /// at all refuses as `LibraryUnavailable`.
    fn admit_writes(&self) -> Result<(), LidarImportRefusal> {
        self.ensure_writable().map_err(|detail| {
            admission::refusal(LidarImportRefusalReason::LibraryUnavailable, detail)
        })
    }

    /// The heavy lease of a new import; another raster job holding it
    /// refuses as `JobRunning`.
    fn admit_heavy_job(&self) -> Result<HeavyJobLease, LidarImportRefusal> {
        HeavyJobLease::acquire(self, &new_id("imp"))
            .map_err(|detail| admission::refusal(LidarImportRefusalReason::JobRunning, detail))
    }

    /// Retry a failed unpublished import with its saved request.
    ///
    /// The saved files are checked as Import checks them before a job is
    /// recorded. A refusal adds no job: it becomes the latest import's
    /// failure, so the reason stays on the item's row. A raster job already
    /// running refuses Retry too, but is not the item's failure.
    pub fn retry_import(
        &self,
        layer_id: &str,
    ) -> Result<common_types::lidar::LidarImportReceipt, LidarImportRefusal> {
        self.admit_writes()?;
        let SavedRetry {
            latest_job, paths, ..
        } = saved_retry(&*self.catalogue()?, layer_id)?;
        let checked = self
            .saved_source_names(&paths)
            .map_err(LidarImportRefusal::from)
            .and_then(|names| {
                let name_of = |path: &std::path::Path| {
                    names
                        .get(path)
                        .cloned()
                        .unwrap_or_else(|| admission::source_name(path))
                };
                import::validate_selection(&paths, &name_of)?;
                admission::check_sources_placeable(self.inner.engine.as_ref(), &paths, &name_of)
            });
        if let Err(refusal) = checked {
            self.refuse_retry(&latest_job, &refusal);
            return Err(refusal);
        }
        let lease = self.admit_heavy_job()?;
        let (layer_id, job_id, paths) = self.record_import_retry(layer_id)?;
        Ok(self.start_recorded_import(lease, &layer_id, &job_id, paths)?)
    }

    /// The file names a saved selection's managed originals were imported
    /// under, so a refusal never calls one "original" (a rebuilt item's saved
    /// selection holds only managed originals). A user's file is absent and
    /// keeps its own name.
    pub(super) fn saved_source_names(
        &self,
        paths: &[PathBuf],
    ) -> Result<HashMap<PathBuf, String>, String> {
        let connection = self.catalogue()?;
        let mut names = HashMap::new();
        for path in paths {
            let Some(sha256) = path
                .parent()
                .and_then(|dir| dir.file_name())
                .and_then(|sha256| sha256.to_str())
            else {
                continue;
            };
            if *path != self.inner.paths.source_original(sha256) {
                continue;
            }
            let name: Option<String> = connection
                .query_row(
                    "SELECT original_filename FROM lidar_sources WHERE sha256 = ?1",
                    [sha256],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to read the source name: {e}"))?;
            if let Some(name) = name {
                names.insert(path.clone(), name);
            }
        }
        Ok(names)
    }

    fn start_recorded_import(
        &self,
        lease: HeavyJobLease,
        layer_id: &str,
        job_id: &str,
        paths: Vec<PathBuf>,
    ) -> Result<common_types::lidar::LidarImportReceipt, String> {
        if let Err(error) = self.begin_import_sources(lease, job_id, layer_id, paths) {
            // A job that could not start is an honest failed operation.
            self.fail_import_job(job_id, &error);
            return Err(error);
        }
        Ok(common_types::lidar::LidarImportReceipt {
            layer_id: layer_id.to_string(),
            job_id: job_id.to_string(),
        })
    }

    /// A refused Retry, kept as the failure of the item's latest import
    /// instead of a new job row; the job keeps the English detail for
    /// diagnostics (the row shows Import failed). Best effort: the caller
    /// returns the refusal whatever happens to this write.
    fn refuse_retry(&self, latest_job: &str, refusal: &LidarImportRefusal) {
        let written = self.catalogue().and_then(|connection| {
            connection
                .execute(
                    "UPDATE lidar_import_jobs SET state = 'failed', message = ?2, updated_at = ?3
                     WHERE id = ?1 AND state = 'failed'",
                    rusqlite::params![latest_job, refusal.detail, now_iso()],
                )
                .map_err(|e| e.to_string())
        });
        if let Err(error) = written {
            tracing::warn!(job_id = latest_job, %error, "a refused retry's reason was not kept on its item");
        }
    }

    /// Mark an import failed. Its row reads only Import failed, so the reason
    /// goes to the log a problem report carries.
    fn fail_import_job(&self, job_id: &str, message: &str) {
        tracing::warn!(job_id, error = %message, "LiDAR import failed");
        if let Ok(connection) = self.catalogue() {
            let _ = connection.execute(
                "UPDATE lidar_import_jobs
                 SET state = 'failed', message = ?2, progress_phase = NULL,
                     progress_percent = NULL, updated_at = ?3
                 WHERE id = ?1 AND state IN ('staging', 'applying')",
                rusqlite::params![job_id, message, now_iso()],
            );
        }
    }

    /// Record the import job row (short catalogue write; called through the
    /// executor from the command).
    #[cfg(test)]
    pub fn record_import_job(&self, layer_id: &str) -> Result<String, String> {
        let job_id = new_id("imp");
        let connection = self.catalogue()?;
        connection
            .execute(
                "INSERT INTO lidar_import_jobs(id, layer_id, state, created_at, updated_at)
                 VALUES(?1, ?2, 'staging', ?3, ?3)",
                rusqlite::params![job_id, layer_id, now_iso()],
            )
            .map_err(|e| format!("Failed to record import job: {e}"))?;
        Ok(job_id)
    }

    /// Prepare and publish a new item's sources in one job.
    ///
    /// Each selected source is prepared and validated in order under the
    /// caller's heavy-job lease, taken before the job was recorded, and the
    /// batch is published atomically as the item's only generation. A
    /// pre-commit failure or cancellation publishes nothing.
    fn begin_import_sources(
        &self,
        lease: HeavyJobLease,
        job_id: &str,
        layer_id: &str,
        source_paths: Vec<PathBuf>,
    ) -> Result<(), String> {
        {
            // A published item's content is fixed. Refusing here, before any
            // lease or job work, also stops a stale caller that still thinks
            // it can append to an item.
            let connection = self.catalogue()?;
            if catalogue::head_generation(&connection, layer_id)?.is_some() {
                return Err(
                    "this item is already published and its content is fixed; import the files as a new item"
                        .to_string(),
                );
            }
        }
        let executor = self.executor()?;
        let flag = self.register_cancel(job_id);
        let library = self.clone();
        let layer_for_stage = layer_id.to_string();
        let job_id_for_stage = job_id.to_string();
        let job_id_clone = job_id.to_string();
        tauri::async_runtime::spawn(async move {
            let library_for_work = library.clone();
            let ran = executor
                .run(RASTER_WORK, "lidar import sources", move || {
                    let outcome = library_for_work.stage_and_publish(
                        &job_id_for_stage,
                        &layer_for_stage,
                        &source_paths,
                        &flag,
                    );
                    // Settled on this lane with the lease held, so the files
                    // a failed or cancelled job frees are removed inside the
                    // executor's admission and no other import stages that
                    // content meanwhile.
                    library_for_work.finish_import_sources(&job_id_for_stage, outcome);
                    drop(lease);
                    Ok(())
                })
                .await;
            if let Err(error) = ran {
                // The lane refused the work or it panicked; the lease went with
                // it, and startup frees any files the job wrote.
                library.fail_import_job(&job_id_clone, &error);
            }
            library.settle_cancel(&job_id_clone);
        });
        Ok(())
    }

    /// Prepare, validate and publish one import's staged sources; the caller
    /// settles the job with the outcome.
    fn stage_and_publish(
        &self,
        job_id: &str,
        layer_id: &str,
        source_paths: &[PathBuf],
        flag: &AtomicBool,
    ) -> Result<(), String> {
        // The head is captured inside staging, before preparation begins,
        // and carried by the staged payload.
        import::stage_import(self, job_id, layer_id, source_paths, flag)?;
        let staging = import::read_staged_import(self, job_id)?;
        // Every occurrence is compatible and validated before anything
        // becomes visible; a partial batch is never published as a success.
        import::ensure_whole_batch_compatible(&staging)?;
        // Display derivatives are staged under the same job, so the item can
        // be drawn as soon as it is published.
        self.prepare_staged_display(&staging, flag)?;
        // Publication refuses an item that already has a head: items are
        // fixed once published.
        import::apply_import(self, &staging, flag).map(|outcome| {
            tracing::info!(summary = outcome.summary(), "LiDAR import published");
        })
    }

    /// Record the outcome of a one-step import.
    ///
    /// Import publishes a new fixed item; it never touches another item or
    /// enqueues analysis.
    fn finish_import_sources(&self, job_id: &str, outcome: Result<(), String>) {
        // From here the job only settles: flagged, it is waited for by
        // Import, Retry and Dismiss (`await_stopping_jobs`) rather than
        // refusing them once its item reads Failed or published.
        self.set_cancel_flag(job_id);
        if let Ok(connection) = self.catalogue() {
            match outcome {
                Ok(()) => {
                    let _ = connection.execute(
                        "UPDATE lidar_import_jobs
                         SET state = 'complete', message = NULL,
                             updated_at = ?2
                         WHERE id = ?1 AND state IN ('staging', 'applying')",
                        rusqlite::params![job_id, now_iso()],
                    );
                    // Publication reports its own finalising progress as it
                    // commits, so the settled job's phase is cleared here
                    // whether or not the guarded state update above matched.
                    let _ = connection.execute(
                        "UPDATE lidar_import_jobs
                         SET progress_phase = NULL, progress_percent = NULL
                         WHERE id = ?1",
                        [job_id],
                    );
                    drop(connection);
                    // The published item is now what the originals' meta
                    // must describe.
                    self.refresh_source_meta();
                }
                Err(error) if error == "cancelled" => {
                    // Cancel withdraws the import; a job that stopped before
                    // the cancel's own withdrawal ran withdraws it here.
                    drop(connection);
                    if let Err(error) = self.withdraw_cancelled_import(job_id) {
                        tracing::warn!(job_id, %error, "a cancelled import was not withdrawn");
                    }
                    self.discard_import_job_files(job_id);
                }
                Err(error) => {
                    // A failed item stays for Retry, which reads the user's
                    // files again, so none of its own are kept.
                    drop(connection);
                    self.fail_import_job(job_id, &error);
                    self.discard_import_job_files(job_id);
                }
            }
        }
    }

    /// Wait until every stopping job has settled and let go of the heavy
    /// lease: a cancelled one, or an import whose work is done. Cancel
    /// returns once its import is withdrawn, and a failed import reads Failed
    /// as it starts settling, while the job may still be stopping or freeing
    /// its files, so Import, Retry and Dismiss wait here, with no executor
    /// permit held, instead of refusing work the library no longer shows.
    /// They wait the same way while Delete or Dismiss frees files under the
    /// lease, so no import or calculation is named when none runs. A running
    /// job nobody cancelled still refuses them.
    pub async fn await_stopping_jobs(&self) {
        loop {
            let stopping = self
                .inner
                .cancel_flags
                .lock()
                .is_ok_and(|flags| flags.values().any(|flag| flag.load(Ordering::Relaxed)));
            let freeing = self.inner.heavy_job.lock().is_ok_and(|holder| {
                holder
                    .as_deref()
                    .is_some_and(|key| key.starts_with(&format!("{FREEING_LEASE}-")))
            });
            if !stopping && !freeing {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// Wait until each of `job_ids` has settled and let go of the heavy lease,
    /// with no executor permit held: Delete frees a deleted item's files once
    /// its own cancelled jobs stop, never waiting on another item's job.
    pub async fn await_jobs_settled(&self, job_ids: &[String]) {
        loop {
            let settling = self
                .inner
                .cancel_flags
                .lock()
                .is_ok_and(|flags| job_ids.iter().any(|job_id| flags.contains_key(job_id)));
            if !settling {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// Wait for the library-wide heavy lease without holding an executor
    /// permit: a queued calculation must never occupy a permit while another
    /// heavy job runs, and one cancelled or deleted meanwhile stops waiting.
    async fn await_heavy_lease(&self, job_id: &str) -> Option<HeavyJobLease> {
        loop {
            match HeavyJobLease::acquire(self, job_id) {
                Ok(lease) => return Some(lease),
                Err(_) => {
                    // Only a job still preparing keeps waiting.
                    let queued = self.catalogue().ok().is_some_and(|connection| {
                        connection
                            .query_row(
                                "SELECT state FROM lidar_analysis_jobs WHERE id = ?1",
                                [job_id],
                                |row| row.get::<_, String>(0),
                            )
                            .is_ok_and(|state| state == "preparing")
                    });
                    if !queued {
                        return None;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        }
    }

    /// Run one recorded analysis job to its settled state.
    async fn run_analysis(self, job_id: String) {
        let Some(lease) = self.await_heavy_lease(&job_id).await else {
            return;
        };
        let Ok(executor) = self.executor() else {
            return;
        };
        let flag = self.register_cancel(&job_id);
        let library = self.clone();
        let job = job_id.clone();
        let outcome = executor
            .run(RASTER_WORK, "lidar analysis", move || {
                let _lease = lease;
                analyses::run_job(&library, &job, &flag)
            })
            .await;
        match outcome {
            Ok(outcome) => {
                tracing::info!(
                    job_id,
                    summary = outcome.summary(),
                    "LiDAR analysis published"
                );
            }
            Err(error) => self.fail_analysis_job(&job_id, &error),
        }
        self.settle_cancel(&job_id);
    }

    /// Settle an analysis job that published nothing, as cancelled or failed.
    /// A failed row reads only Calculation failed, so the reason goes to the
    /// log a problem report carries.
    fn fail_analysis_job(&self, job_id: &str, error: &str) {
        if error != "cancelled" {
            tracing::warn!(job_id, error, "LiDAR analysis failed");
        }
        if let Ok(connection) = self.catalogue() {
            analyses::settle_unpublished(&connection, job_id, error);
        }
    }

    fn start_analysis(&self, job_id: &str) {
        let library = self.clone();
        let job_id = job_id.to_string();
        tauri::async_runtime::spawn(async move {
            library.run_analysis(job_id).await;
        });
    }

    /// Create a definition of a registered analysis and start its first run.
    ///
    /// The request is validated against the registry and the inputs' stored
    /// facts; a missing GeoLibre engine refuses creation by name.
    pub fn create_analysis(&self, request: &AnalysisRequest) -> Result<AnalysisReceipt, String> {
        self.ensure_writable()?;
        let engine = self.inner.geolibre.discover();
        let receipt = {
            let connection = self.catalogue()?;
            analyses::record_definition(&connection, request, Some(&engine))?
        };
        self.refresh_source_meta();
        self.start_analysis(&receipt.job_id);
        Ok(receipt)
    }

    /// Run a definition again with its saved settings and current inputs:
    /// Retry before a first result, Refresh after one. A refresh updates the
    /// definition's items in place; the earlier run stays in its history.
    pub fn rerun_analysis(&self, definition_id: &str) -> Result<AnalysisReceipt, String> {
        self.ensure_writable()?;
        let engine = self.inner.geolibre.discover();
        let receipt = {
            let connection = self.catalogue()?;
            analyses::record_rerun(&connection, definition_id, Some(&engine))?
        };
        self.start_analysis(&receipt.job_id);
        Ok(receipt)
    }
}

/// Refuse to delete an item other results were calculated from.
fn refuse_dependents(connection: &Connection, item_id: &str) -> Result<(), String> {
    let dependents = catalogue::dependent_items(connection, item_id)?.len();
    if dependents == 0 {
        return Ok(());
    }
    let name = catalogue::get_layer(connection, item_id)?
        .map(|layer| layer.name)
        .or(catalogue::get_derived_item(connection, item_id)?.and_then(|item| item.name))
        .unwrap_or_else(|| item_id.to_string());
    Err(format!(
        "{name} has {dependents} saved result{} calculated from it; delete {} first",
        if dependents == 1 { "" } else { "s" },
        if dependents == 1 {
            "that result"
        } else {
            "those results"
        }
    ))
}

fn string_column(connection: &Connection, sql: &str, key: &str) -> Result<Vec<String>, String> {
    let mut statement = connection.prepare(sql).map_err(|e| e.to_string())?;
    statement
        .query_map([key], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Withdraw one unpublished import job: the job alone when the item has an
/// earlier import (a Retry), else the whole item; false, changing nothing,
/// once the item is published.
fn withdraw_import_rows(
    connection: &Connection,
    layer_id: &str,
    job_id: &str,
) -> Result<bool, String> {
    let retried: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM lidar_import_jobs WHERE layer_id = ?1 AND id <> ?2)",
            [layer_id, job_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !retried {
        return delete_unpublished_item_rows(connection, layer_id);
    }
    if catalogue::head_generation(connection, layer_id)?.is_some() {
        return Ok(false);
    }
    connection
        .execute("DELETE FROM lidar_import_jobs WHERE id = ?1", [job_id])
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Delete an unpublished item and its import jobs; false, deleting nothing,
/// once the item is published.
fn delete_unpublished_item_rows(connection: &Connection, layer_id: &str) -> Result<bool, String> {
    if catalogue::head_generation(connection, layer_id)?.is_some() {
        return Ok(false);
    }
    for sql in [
        "DELETE FROM lidar_import_jobs WHERE layer_id = ?1",
        "DELETE FROM lidar_source_layers WHERE id = ?1",
    ] {
        connection
            .execute(sql, [layer_id])
            .map_err(|e| e.to_string())?;
    }
    Ok(true)
}

fn delete_source_rows(connection: &Connection, layer_id: &str) -> Result<(), String> {
    // Ordered snapshots keep their own member rows, which reference the
    // generations deleted below. Chunk rows carry no foreign key to their
    // generation (they are inserted before it commits), so they are revoked
    // with it explicitly.
    for sql in [
        "DELETE FROM lidar_collection_members WHERE generation_id IN
         (SELECT id FROM lidar_layer_generations WHERE layer_id = ?1)",
        "DELETE FROM lidar_generation_chunks WHERE generation_id IN
         (SELECT id FROM lidar_layer_generations WHERE layer_id = ?1)",
        "DELETE FROM lidar_layer_heads WHERE layer_id = ?1",
        "DELETE FROM lidar_import_jobs WHERE layer_id = ?1",
        "DELETE FROM lidar_layer_generations WHERE layer_id = ?1",
        "DELETE FROM lidar_source_layers WHERE id = ?1",
    ] {
        connection
            .execute(sql, [layer_id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn delete_derived_rows(connection: &Connection, item_id: &str) -> Result<(), String> {
    let item = catalogue::get_derived_item(connection, item_id)?
        .ok_or_else(|| format!("Item {item_id} does not exist"))?;
    for sql in [
        "DELETE FROM lidar_generation_chunks WHERE generation_id IN
         (SELECT id FROM lidar_derived_generations WHERE item_id = ?1)",
        "DELETE FROM lidar_derived_heads WHERE item_id = ?1",
        "DELETE FROM lidar_derived_generations WHERE item_id = ?1",
        "DELETE FROM lidar_derived_items WHERE id = ?1",
    ] {
        connection
            .execute(sql, [item_id])
            .map_err(|e| e.to_string())?;
    }
    if catalogue::definition_items(connection, &item.definition_id)?.is_empty() {
        for sql in [
            "DELETE FROM lidar_analysis_jobs WHERE definition_id = ?1",
            "DELETE FROM lidar_analysis_inputs WHERE definition_id = ?1",
            "DELETE FROM lidar_analysis_definitions WHERE id = ?1",
        ] {
            connection
                .execute(sql, [&item.definition_id])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(crate) struct CatalogueGuard<'a>(std::sync::MutexGuard<'a, Connection>);

impl std::ops::Deref for CatalogueGuard<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        &self.0
    }
}

/// Open the display cache, best effort: it only indexes regenerable display
/// derivatives, so a file that cannot be opened or initialised is removed and
/// recreated, and when that fails too the cache runs in memory for this run.
/// Derivatives the lost index named are swept at startup as unregistered.
fn open_display_cache_or_recreate(path: &std::path::Path) -> Result<Connection, String> {
    match open_display_cache(path) {
        Ok(connection) => return Ok(connection),
        Err(error) => {
            tracing::warn!(%error, "LiDAR display cache is unusable; recreating it");
        }
    }
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let file = std::path::PathBuf::from(format!("{}{suffix}", path.display()));
        if let Err(error) = std::fs::remove_file(&file)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(path = %file.display(), %error, "failed to remove the display cache");
        }
    }
    match open_display_cache(path) {
        Ok(connection) => Ok(connection),
        Err(error) => {
            tracing::error!(%error, "LiDAR display cache could not be recreated; using memory");
            let connection = Connection::open_in_memory()
                .map_err(|e| format!("Failed to open an in-memory display cache: {e}"))?;
            init_display_cache(&connection)?;
            Ok(connection)
        }
    }
}

fn open_display_cache(path: &std::path::Path) -> Result<Connection, String> {
    let connection = Connection::open(path)
        .map_err(|e| format!("Failed to open display cache {}: {e}", path.display()))?;
    init_display_cache(&connection)?;
    Ok(connection)
}

fn init_display_cache(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS display_cogs (
                key TEXT PRIMARY KEY,
                file TEXT NOT NULL,
                bytes INTEGER NOT NULL,
                west REAL NOT NULL,
                south REAL NOT NULL,
                east REAL NOT NULL,
                north REAL NOT NULL,
                created_at TEXT NOT NULL
            );",
        )
        .map_err(|e| format!("Failed to init display cache: {e}"))?;
    Ok(())
}

/// One import job as the UI reads it.
pub(crate) fn import_job_summary(
    connection: &Connection,
    job_id: &str,
) -> Result<Option<LidarImportJob>, String> {
    let Some(row) = catalogue::get_import_job(connection, job_id)? else {
        return Ok(None);
    };
    let progress = row
        .progress_phase
        .as_deref()
        .and_then(parse_import_progress_phase)
        .zip(row.progress_percent)
        .and_then(|(phase, percent)| {
            u8::try_from(percent)
                .ok()
                .filter(|percent| *percent <= 100)
                .map(|percent| LidarImportProgress { phase, percent })
        });
    Ok(Some(LidarImportJob {
        job_id: row.id,
        layer_id: row.layer_id,
        state: parse_import_state(&row.state),
        message: row.message,
        progress,
    }))
}

struct SavedRetry {
    latest_job: String,
    request: String,
    paths: Vec<PathBuf>,
}

/// The latest import of an unpublished item that may be retried, with its
/// saved selection: refused for a published item, a running import or an
/// import recorded before its selection was saved.
fn saved_retry(connection: &Connection, layer_id: &str) -> Result<SavedRetry, String> {
    catalogue::get_layer(connection, layer_id)?
        .ok_or_else(|| format!("Layer {layer_id} does not exist"))?;
    if catalogue::head_generation(connection, layer_id)?.is_some() {
        return Err("this item is already published; import new files as a new item".to_string());
    }
    let latest: Option<(String, String, Option<String>)> = connection
        .query_row(
            "SELECT id, state, request_json FROM lidar_import_jobs WHERE layer_id = ?1
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [layer_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("Failed to read the import: {e}"))?;
    let Some((latest_job, state, request)) = latest else {
        return Err("this item has no saved import to retry".to_string());
    };
    if state != "failed" {
        return Err("this import is still running".to_string());
    }
    let request = request.ok_or_else(|| {
        "this import was recorded before its selection was saved; choose the files again"
            .to_string()
    })?;
    let paths = parse_import_request(&request)?;
    Ok(SavedRetry {
        latest_job,
        request,
        paths,
    })
}

/// The saved selection of one import, in priority order.
pub(crate) fn import_request_json(paths: &[PathBuf]) -> Result<String, String> {
    let paths: Vec<String> = paths
        .iter()
        .map(|path| {
            path.to_str()
                .map(str::to_string)
                .ok_or_else(|| format!("{} is not a valid file path", path.display()))
        })
        .collect::<Result<_, _>>()?;
    serde_json::to_string(&serde_json::json!({ "paths": paths }))
        .map_err(|e| format!("Failed to save the import selection: {e}"))
}

fn parse_import_request(json: &str) -> Result<Vec<PathBuf>, String> {
    #[derive(serde::Deserialize)]
    struct Request {
        paths: Vec<String>,
    }
    let request: Request = serde_json::from_str(json)
        .map_err(|e| format!("The saved import selection is unreadable: {e}"))?;
    Ok(request.paths.into_iter().map(PathBuf::from).collect())
}

fn parse_import_state(raw: &str) -> LidarImportJobState {
    match raw {
        "applying" => LidarImportJobState::Applying,
        "complete" => LidarImportJobState::Complete,
        "failed" => LidarImportJobState::Failed,
        _ => LidarImportJobState::Staging,
    }
}

fn import_progress_phase_key(phase: LidarImportProgressPhase) -> &'static str {
    match phase {
        LidarImportProgressPhase::ComposingLayer => "composing_layer",
        LidarImportProgressPhase::PreparingRaster => "preparing_raster",
        LidarImportProgressPhase::RenderingMap => "rendering_map",
        LidarImportProgressPhase::Finalizing => "finalizing",
    }
}

fn parse_import_progress_phase(raw: &str) -> Option<LidarImportProgressPhase> {
    match raw {
        "composing_layer" => Some(LidarImportProgressPhase::ComposingLayer),
        "preparing_raster" => Some(LidarImportProgressPhase::PreparingRaster),
        "rendering_map" => Some(LidarImportProgressPhase::RenderingMap),
        "finalizing" => Some(LidarImportProgressPhase::Finalizing),
        _ => None,
    }
}

/// The unit label for a new source, or a refusal when none was declared.
///
/// Elevation and height have an inherent unit, so their label is fixed and a
/// caller cannot contradict it. An "other continuous" dataset has no inherent
/// unit, so its author must either supply one or state that it is unknown:
/// silently storing a label such as `unitless` would assert the values are
/// dimensionless, which is a measurement claim nobody made. Derived quantities
/// are never imported.
fn resolve_units(
    quantity: RasterQuantity,
    unit_label: Option<&str>,
    unit_unknown: bool,
) -> Result<String, String> {
    if !quantity.is_importable() {
        return Err(format!(
            "{} is calculated by an analysis and cannot be imported",
            quantity.key()
        ));
    }
    match quantity {
        RasterQuantity::OtherContinuous => {
            let label = unit_label.map(str::trim).filter(|value| !value.is_empty());
            match (label, unit_unknown) {
                (Some(_), true) => Err(
                    "Declare either a unit label or that the unit is unknown, not both".to_string(),
                ),
                (Some(label), false) => Ok(label.to_string()),
                (None, true) => Ok(common_types::lidar::LIDAR_UNITS_UNKNOWN.to_string()),
                (None, false) => Err(
                    "An other continuous dataset must declare a unit label or that its unit is unknown"
                        .to_string(),
                ),
            }
        }
        _ => {
            if unit_label.is_some() || unit_unknown {
                return Err(format!(
                    "A {} dataset is measured in metres; its unit is not selectable",
                    quantity.key()
                ));
            }
            Ok("m".to_string())
        }
    }
}

#[cfg(test)]
mod fixed_library_tests;

#[cfg(test)]
mod tests {
    #[test]
    fn the_library_size_counts_files_in_every_folder() {
        let root = crate::test_scratch::TestScratch::new("canopi-library-size");
        std::fs::create_dir_all(root.join("sources").join("abc")).unwrap();
        std::fs::write(root.join("lidar-library.sqlite"), vec![0u8; 100]).unwrap();
        std::fs::write(
            root.join("sources").join("abc").join("original.tif"),
            vec![0u8; 23],
        )
        .unwrap();
        assert_eq!(super::directory_size(&root).unwrap(), 123);
        assert_eq!(
            super::directory_size(&root.join("absent")).unwrap(),
            0,
            "a library never used has nothing on disk"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    use super::*;

    /// The UI cancel path is what the synchronous cancel commands call: it
    /// must return while a job holds the catalogue, or Cancel would block the
    /// main thread behind the very work it is trying to stop.
    #[test]
    fn signalling_a_cancel_never_waits_for_the_catalogue_lock() {
        let root = crate::test_scratch::TestScratch::new("canopi-cancel-signal");
        let library = LidarLibrary::open(&root).unwrap();
        library.attach_executor(crate::native_operation::NativeOperationExecutor::production());
        let flag = library.register_cancel("job-held");

        let held = library.catalogue().unwrap();
        let (done, signalled) = std::sync::mpsc::channel();
        let signaller = library.clone();
        std::thread::spawn(move || {
            signaller.signal_cancel("job-held");
            let _ = done.send(());
        });
        assert!(
            signalled
                .recv_timeout(std::time::Duration::from_secs(5))
                .is_ok(),
            "signal_cancel blocked on the catalogue lock"
        );
        assert!(
            flag.load(Ordering::Relaxed),
            "the job's flag is set at once"
        );
        drop(held);

        let _ = std::fs::remove_dir_all(root);
    }

    fn row_count(connection: &Connection, table: &str) -> i64 {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn seed_analysis(connection: &Connection, layer_id: &str, item_id: &str) {
        analyses::test_support::seed_published_slope(
            connection,
            layer_id,
            "source-gen",
            &format!("adef-{item_id}"),
            item_id,
            &format!("dgen-{item_id}"),
            None,
        );
    }

    /// An "other continuous" dataset must declare its unit.
    ///
    /// Elevation and height are measured in metres, so their label is fixed and
    /// a caller cannot contradict it. A continuous dataset that is neither has
    /// no inherent unit, and the three states must stay distinguishable: a real
    /// label, an explicit unknown, and undeclared. Undeclared is refused rather
    /// than stored, because a label like `unitless` would assert the values are
    /// dimensionless — a measurement claim nobody made.
    #[test]
    fn an_other_continuous_layer_must_declare_its_unit() {
        // A real label is stored as given, trimmed.
        assert_eq!(
            resolve_units(RasterQuantity::OtherContinuous, Some("  mg/kg "), false).unwrap(),
            "mg/kg"
        );
        // An explicit unknown is stored as the sentinel, not as a label the
        // author never chose.
        assert_eq!(
            resolve_units(RasterQuantity::OtherContinuous, None, true).unwrap(),
            common_types::lidar::LIDAR_UNITS_UNKNOWN
        );
        // Undeclared is refused.
        assert!(
            resolve_units(RasterQuantity::OtherContinuous, None, false).is_err(),
            "an undeclared unit must not be stored"
        );
        // Whitespace is not a label.
        assert!(
            resolve_units(RasterQuantity::OtherContinuous, Some("   "), false).is_err(),
            "a blank label is undeclared, not a unit"
        );
        // Claiming both is contradictory.
        assert!(
            resolve_units(RasterQuantity::OtherContinuous, Some("mg/kg"), true).is_err(),
            "a label and an explicit unknown cannot both hold"
        );

        // Elevation and height are always metres and refuse both declarations,
        // so a caller cannot relabel a measurement that has an inherent unit.
        for kind in [
            RasterQuantity::GroundElevation,
            RasterQuantity::SurfaceElevation,
            RasterQuantity::AboveGroundHeight,
        ] {
            assert_eq!(resolve_units(kind, None, false).unwrap(), "m");
            assert!(
                resolve_units(kind, Some("ft"), false).is_err(),
                "{} must not accept a substitute unit",
                kind.key()
            );
            assert!(
                resolve_units(kind, None, true).is_err(),
                "{} is not of unknown unit",
                kind.key()
            );
        }
        // A derived quantity only ever comes from an analysis.
        let error = resolve_units(RasterQuantity::Slope, None, false).unwrap_err();
        assert!(error.contains("cannot be imported"), "{error}");
    }

    #[test]
    fn deleting_a_derived_item_removes_its_complete_row_graph() {
        let root = crate::test_scratch::TestScratch::new("lidar-delete-analysis-test");
        let library = LidarLibrary::open(&root).unwrap();
        let layer_id = library
            .create_layer(
                "Delete analysis fixture",
                RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        {
            let connection = library.catalogue().unwrap();
            seed_analysis(&connection, &layer_id, "item-1");
        }

        library.delete_item("item-1").unwrap();
        let connection = library.catalogue().unwrap();
        for table in [
            "lidar_derived_heads",
            "lidar_derived_generations",
            "lidar_derived_items",
            "lidar_analysis_jobs",
            "lidar_analysis_inputs",
            "lidar_analysis_definitions",
        ] {
            assert_eq!(row_count(&connection, table), 0, "{table}");
        }
        assert_eq!(row_count(&connection, "lidar_source_layers"), 1);
        drop(connection);
        assert!(
            library.delete_item("item-1").is_err(),
            "a deleted item is gone"
        );
        drop(library);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// P1-1: a public collection read must not re-acquire its own catalogue
    /// lock.
    ///
    /// `layer_collection` holds the catalogue connection while it reads the
    /// layer's members. Calling a public method that takes the same mutex again
    /// deadlocks the whole library, and an empty layer — the case a user hits
    /// first — took exactly that path. The read runs on its own thread with a
    /// deadline so a regression fails instead of hanging the suite.
    #[test]
    fn a_public_collection_read_does_not_re_acquire_the_catalogue_lock() {
        let root = crate::test_scratch::TestScratch::new("canopi-collection-lock");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).expect("library opens");
        let layer_id = library
            .create_layer("Empty", RasterQuantity::GroundElevation, None, false)
            .unwrap();

        let read = |name: &'static str, library: LidarLibrary, layer_id: String| {
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let page = library.layer_collection(&layer_id, None);
                let _ = sender.send(page);
            });
            receiver
                .recv_timeout(std::time::Duration::from_secs(20))
                .unwrap_or_else(|_| {
                    panic!("{name} deadlocked on the catalogue lock it already holds")
                })
        };

        let page = read(
            "a collection read of an empty layer",
            library.clone(),
            layer_id.clone(),
        );
        let page = page.expect("the summary reads");
        assert_eq!(page.layer_id, layer_id);
        assert_eq!(page.member_count, 0, "an empty layer has no occurrences");
        assert!(page.sources.is_empty());
        assert!(page.head_generation_id.is_none());

        let page = read(
            "a paged read of an empty layer",
            library.clone(),
            layer_id.clone(),
        );
        assert!(page.expect("the paged summary reads").sources.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[expect(
        clippy::too_many_lines,
        reason = "ratcheted before 2.1-M188; split when this function next changes"
    )]
    fn deleting_a_source_removes_all_referencing_rows_with_foreign_keys_enabled() {
        let root = crate::test_scratch::TestScratch::new("lidar-delete-layer-test");
        let library = LidarLibrary::open(&root).unwrap();
        let layer_id = library
            .create_layer(
                "Delete layer fixture",
                RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        {
            let connection = library.catalogue().unwrap();
            connection
                .execute(
                    "INSERT INTO lidar_sources
                 (sha256, original_filename, size_bytes, probe_json, imported_at)
                 VALUES ('sha-delete', 'source', 1, '{}', '0')",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO lidar_interpretations
                 (id, source_sha256, band_index, quantity, units, scale, offset,
                  crs_ref, vertical_ref, nodata, geotransform, width, height, interp_hash,
                  valid_cells)
                 VALUES ('interp-delete', 'sha-delete', 1, 'ground-elevation', 'm', 1, 0,
                         'test', 'unknown', -9999, '[0,1,0,1,0,-1]', 1, 1, 'hash-delete', 1)",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO lidar_layer_generations
                 (id, layer_id, created_at, manifest_json,
                  coverage_cells, min_value, max_value, bounds_3857, crs_class)
                 VALUES ('source-gen', ?1, '0', '{}', 1, 0, 1, '[0,0,1,1]', 'projected-metre')",
                    [&layer_id],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO lidar_collection_members
                 (generation_id, member_id, position, interpretation_id, created_at)
                 VALUES ('source-gen', 'member-delete', 0, 'interp-delete', '0')",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO lidar_layer_heads(layer_id, generation_id)
                 VALUES (?1, 'source-gen')",
                    [&layer_id],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO lidar_import_jobs
                 (id, layer_id, state, created_at, updated_at)
                 VALUES ('import-delete', ?1, 'complete', '0', '0')",
                    [&layer_id],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO lidar_raster_assets
                        (sha256, rel_path, bytes, profile, width, height, geotransform,
                         crs_ref, nodata, created_at)
                     VALUES ('sha-asset-delete', 'assets/sha-asset-delete/cog.tif', 4,
                             'cog-f32-t256-raw-v1', 1, 1, '[0,1,0,1,0,-1]', 'test', NULL, '0')",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO lidar_generation_chunks
                        (generation_id, role, chunk_x, chunk_y, asset_sha256,
                         valid_cells, min_value, max_value, sum_value, state)
                     VALUES ('source-gen', 'result', 0, 0, 'sha-asset-delete', 1, 1, 1, 1,
                             'published')",
                    [],
                )
                .unwrap();
            seed_analysis(&connection, &layer_id, "item-delete");
        }

        // A saved result is deleted explicitly first; the source then removes
        // every row that references it.
        let refused = library.delete_item(&layer_id).unwrap_err();
        assert!(refused.contains("1 saved result"), "{refused}");
        assert_eq!(
            library.delete_impact(&layer_id).unwrap().dependent_item_ids,
            ["item-delete"]
        );
        library.delete_item("item-delete").unwrap();
        library.delete_item(&layer_id).unwrap();
        let connection = library.catalogue().unwrap();
        for table in [
            "lidar_source_layers",
            "lidar_layer_heads",
            "lidar_layer_generations",
            "lidar_collection_members",
            "lidar_import_jobs",
            "lidar_derived_heads",
            "lidar_analysis_jobs",
            "lidar_derived_generations",
            "lidar_analysis_inputs",
            "lidar_analysis_definitions",
            "lidar_generation_chunks",
            // The original and the asset no other item claims go with it
            // (canopi-44vf).
            "lidar_interpretations",
            "lidar_sources",
            "lidar_raster_assets",
        ] {
            assert_eq!(row_count(&connection, table), 0, "{table}");
        }
        drop(connection);
        drop(library);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn heavy_raster_lease_is_exclusive_and_released_on_every_path() {
        let root = crate::test_scratch::TestScratch::new("lidar-heavy-lease-test");
        std::fs::create_dir_all(&root).unwrap();
        let library = LidarLibrary::open(&root).unwrap();
        let layer_id = library
            .create_layer(
                "Lease fixture",
                RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        let holding = library.record_import_job(&layer_id).unwrap();
        let competing = library.record_import_job(&layer_id).unwrap();

        // One heavy job holds the library-wide lease, so a competing
        // submission is refused promptly instead of creating running work.
        let lease = HeavyJobLease::acquire(&library, &holding).unwrap();
        let error = HeavyJobLease::acquire(&library, &competing)
            .err()
            .expect("a competing heavy submission must be refused");
        assert!(error.contains("already running"), "{error}");

        // Releasing admits the next holder, and an early failure releases the
        // lease it was handed instead of wedging the library for the rest of
        // the session.
        drop(lease);
        let lease = HeavyJobLease::acquire(&library, &competing).unwrap();
        assert!(
            library
                .begin_import_sources(lease, &competing, &layer_id, Vec::new())
                .is_err(),
            "no executor is attached in this fixture"
        );
        drop(HeavyJobLease::acquire(&library, &holding).unwrap());

        drop(library);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The one-step import route prepares, validates and publishes in one job.
    ///
    /// The amendment's flow is: the Import action *is* the commit intent, so
    /// there is no review state and no second decision. This drives the same
    /// calls the orchestration makes, in the same order, and asserts the
    /// properties that flow depends on — including that a batch with an
    /// unusable file publishes nothing and names the file.
    #[test]
    #[expect(
        clippy::too_many_lines,
        reason = "ratcheted before 2.1-M188; split when this function next changes"
    )]
    fn one_step_import_publishes_without_review_and_refuses_an_invalid_batch() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let root = crate::test_scratch::TestScratch::new("canopi-one-step-import");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // Two four-by-four planes over the same lattice: the second starts one
        // column east so the batch has uncovered coverage to add.
        let plane = |name: &str, value: f32, origin_x: f64| -> std::path::PathBuf {
            let values = vec![value; 16];
            let raw = root.join(format!("{name}.raw"));
            import::write_f32_raw(&raw, &values).expect("raw plane");
            let tif = root.join(format!("{name}.tif"));
            let grid = grid::RasterGrid {
                width: 4,
                height: 4,
                geotransform: [origin_x, 1.0, 0.0, 4.0, 0.0, -1.0],
            };
            import::raw_to_tif(&engine, &cancel, &raw, &tif, &grid, "EPSG:3857", -9999.0)
                .expect("plane converts");
            tif
        };
        let west = plane("west", 5.0, 0.0);
        let east = plane("east", 9.0, 3.0);

        let library = LidarLibrary::open(&root).expect("library opens");
        let layer_id = library
            .create_layer("one step", RasterQuantity::GroundElevation, None, false)
            .expect("layer created");

        // The production sequence, without the spawned wrapper around it.
        let job_id = library.record_import_job(&layer_id).expect("job recorded");
        import::stage_import(
            &library,
            &job_id,
            &layer_id,
            &[west.clone(), east.clone()],
            &cancel,
        )
        .expect("staging succeeds");
        // Preparation ends by moving the validated batch to publishing, so the
        // job never rests in a state that waits for a person.
        let job = library
            .get_import_job(&job_id)
            .unwrap()
            .expect("job exists");
        assert_eq!(
            format!("{:?}", job.state),
            "Applying",
            "the one-step route does not stop for review"
        );
        let staging = import::read_staged_import(&library, &job_id).expect("staged payload");
        import::ensure_whole_batch_compatible(&staging).expect("every source is compatible");
        import::apply_import(&library, &staging, &cancel).expect("apply publishes");
        library.finish_import_sources(&job_id, Ok(()));

        let job = library
            .get_import_job(&job_id)
            .unwrap()
            .expect("job exists");
        assert_eq!(format!("{:?}", job.state), "Complete");
        assert_eq!(
            format!("{:?}", job.progress),
            "None",
            "progress is cleared once the job settles"
        );

        // Two occurrences published as one generation, and the batch is visible.
        let connection = library.catalogue().unwrap();
        let head = catalogue::head_generation(&connection, &layer_id)
            .unwrap()
            .expect("a head was published");
        assert_eq!(
            catalogue::collection_member_count(&connection, &head.id).unwrap(),
            2
        );
        drop(connection);

        // A published item is fixed: a further import into it is refused.
        let again = library.record_import_job(&layer_id).expect("job recorded");
        let refused = import::stage_import(
            &library,
            &again,
            &layer_id,
            std::slice::from_ref(&east),
            &cancel,
        )
        .expect_err("a published item accepts no further sources");
        assert!(refused.contains("published"), "{refused}");

        // A batch whose second file cannot be used publishes nothing and names
        // the file.
        let broken = root.join("broken.tif");
        std::fs::write(&broken, b"not a raster").expect("broken file");
        let other = library
            .create_layer("broken batch", RasterQuantity::GroundElevation, None, false)
            .expect("layer created");
        let second_job = library.record_import_job(&other).expect("job recorded");
        let failure = import::stage_import(
            &library,
            &second_job,
            &other,
            &[east.clone(), broken.clone()],
            &cancel,
        )
        .expect_err("an unusable source refuses the batch");
        assert!(
            failure.contains("broken.tif"),
            "the refusal names the file: {failure}"
        );
        assert!(
            catalogue::head_generation(&library.catalogue().unwrap(), &other)
                .unwrap()
                .is_none(),
            "a refused batch publishes nothing"
        );

        drop(library);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Startup removes analysis scratch that no running job owns.
    #[test]
    fn startup_sweeps_settled_analysis_scratch_and_keeps_a_running_jobs() {
        let root = crate::test_scratch::TestScratch::new("lidar-analysis-scratch-sweep");
        let library = LidarLibrary::open(&root).unwrap();
        let layer_id = library
            .create_layer(
                "Scratch fixture",
                RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        {
            let connection = library.catalogue().unwrap();
            seed_analysis(&connection, &layer_id, "item-1");
            connection
                .execute(
                    "INSERT INTO lidar_analysis_jobs
                 (id, definition_id, state, recipe_version, input_generations_json,
                  created_at, updated_at)
                 VALUES ('ajob-running', 'adef-item-1', 'preparing', 1, '[]', '3', '3')",
                    [],
                )
                .unwrap();
        }
        let prepared = library.inner.paths.prepared_dir();
        let scratch = |job: &str| prepared.join(format!("scratch-analysis-{job}"));
        for job in ["adef-item-1-job", "ajob-running", "ajob-unknown"] {
            std::fs::create_dir_all(scratch(job)).unwrap();
            std::fs::write(scratch(job).join("window.tif"), b"partial").unwrap();
        }
        library.prune_transient_artifacts();
        assert!(
            !scratch("adef-item-1-job").exists(),
            "a settled job's scratch is swept"
        );
        assert!(
            !scratch("ajob-unknown").exists(),
            "an unowned scratch is swept"
        );
        assert!(
            scratch("ajob-running").exists(),
            "a running job keeps its scratch"
        );
        drop(library);
        // Reopening fails the interrupted job, so its scratch goes too.
        let reopened = LidarLibrary::open(&root).unwrap();
        assert!(!scratch("ajob-running").exists());
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Startup deletes asset directories no catalogue row references, never a
    /// referenced one, and leaves the store alone while any job is in flight.
    #[test]
    fn startup_sweeps_unreferenced_assets_and_keeps_referenced_ones() {
        let root = crate::test_scratch::TestScratch::new("lidar-asset-sweep");
        let library = LidarLibrary::open(&root).unwrap();
        let layer_id = library
            .create_layer(
                "Asset fixture",
                RasterQuantity::GroundElevation,
                None,
                false,
            )
            .unwrap();
        {
            let connection = library.catalogue().unwrap();
            seed_analysis(&connection, &layer_id, "item-1");
            for sha in ["referenced", "orphan"] {
                connection
                    .execute(
                        "INSERT INTO lidar_raster_assets(sha256, rel_path, bytes, profile,
                            width, height, geotransform, crs_ref, nodata, created_at)
                         VALUES(?1, ?2, 1, 'test', 1, 1, '0,1,0,0,0,-1', '', NULL, '0')",
                        rusqlite::params![sha, format!("assets/{sha}/cog.tif")],
                    )
                    .unwrap();
            }
            connection
                .execute(
                    "INSERT INTO lidar_generation_chunks(generation_id, role, chunk_x, chunk_y,
                        asset_sha256, valid_cells, state)
                     VALUES('dgen-item-1', 'result', 0, 0, 'referenced', 1, 'published')",
                    [],
                )
                .unwrap();
        }
        let asset = |sha: &str| library.inner.paths.asset_cog(sha);
        for sha in ["referenced", "orphan", "unrecorded"] {
            std::fs::create_dir_all(asset(sha).parent().unwrap()).unwrap();
            std::fs::write(asset(sha), b"cog").unwrap();
        }
        let in_flight = library.record_import_job(&layer_id).unwrap();
        library.prune_unreferenced_assets().unwrap();
        for sha in ["referenced", "orphan", "unrecorded"] {
            assert!(
                asset(sha).exists(),
                "nothing is swept while {in_flight} runs"
            );
        }
        drop(library);
        // Reopening fails the interrupted job, so the sweep runs.
        let reopened = LidarLibrary::open(&root).unwrap();
        let asset = |sha: &str| reopened.inner.paths.asset_cog(sha);
        assert!(
            asset("referenced").exists(),
            "referenced data is never deleted"
        );
        assert!(!asset("orphan").exists(), "an unreferenced asset is swept");
        assert!(!asset("unrecorded").exists(), "a file with no row is swept");
        let connection = reopened.catalogue().unwrap();
        let rows: Vec<String> = connection
            .prepare("SELECT sha256 FROM lidar_raster_assets ORDER BY sha256")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec!["referenced".to_string()],
            "orphan metadata goes too"
        );
        drop(connection);
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Engine output files live under the library root, and startup removes
    /// the ones an earlier process left; this process's are never touched.
    #[test]
    fn startup_sweeps_engine_logs_left_by_an_earlier_process() {
        let root = crate::test_scratch::TestScratch::new("lidar-engine-log-sweep");
        let library = LidarLibrary::open(&root).unwrap();
        let logs = library.inner.paths.engine_log_dir();
        assert!(logs.starts_with(library.inner.paths.root()));
        let stale = logs.join("0-0-1-out.log");
        let own = logs.join(format!("{}-999999-err.log", process::process_log_tag()));
        std::fs::write(&stale, b"left by a crash").unwrap();
        std::fs::write(&own, b"a live child").unwrap();
        drop(library);
        let reopened = LidarLibrary::open(&root).unwrap();
        assert!(!stale.exists(), "an earlier process's output is swept");
        assert!(own.exists(), "this process's output is never swept");
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The display cache and the startup sweep are best effort: a display
    /// cache that is not a database is replaced, and a scratch directory the
    /// sweep cannot list is left for the next start. Neither stops the app.
    #[cfg(unix)]
    #[test]
    fn a_damaged_display_cache_or_unreadable_scratch_never_stops_the_library() {
        use std::os::unix::fs::PermissionsExt;
        let root = crate::test_scratch::TestScratch::new("lidar-best-effort-open");
        let library = LidarLibrary::open(&root).unwrap();
        let cache = library.inner.paths.display_cache_path();
        let prepared = library.inner.paths.prepared_dir();
        drop(library);
        std::fs::write(&cache, b"definitely not a sqlite display cache").unwrap();
        std::fs::set_permissions(&prepared, std::fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = std::fs::read_dir(&prepared).is_err();

        let opened = LidarLibrary::open(&root);
        std::fs::set_permissions(&prepared, std::fs::Permissions::from_mode(0o755)).unwrap();
        let library = opened.expect("a damaged cache or sweep never fails the open");
        assert!(
            unreadable,
            "the scratch directory was unreadable during the open"
        );
        assert_eq!(*library.open_status(), recovery::LibraryOpenStatus::Ready);
        library
            .display()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM display_cogs", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("the display cache was recreated");
        drop(library);
        std::fs::remove_dir_all(root).unwrap();
    }

    // -- Catalogue recovery (ADR 0021) -------------------------------------

    fn write_original(
        lidar: &std::path::Path,
        sha256: &str,
        meta: Option<&source_meta::SourceMeta>,
    ) {
        let dir = lidar.join("sources").join(sha256);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("original"), format!("bytes of {sha256}")).unwrap();
        if let Some(meta) = meta {
            source_meta::write(&dir.join(source_meta::META_FILE), meta).unwrap();
        }
    }

    fn single_item_meta(
        sha256: &str,
        item_id: &str,
        name: &str,
        quantity: &str,
        units: &str,
    ) -> source_meta::SourceMeta {
        source_meta::SourceMeta {
            version: source_meta::META_VERSION,
            sha256: sha256.to_string(),
            original_filename: format!("{name}.tif"),
            size_bytes: 3,
            imported_at: "10".to_string(),
            items: vec![source_meta::ItemMeta {
                id: item_id.to_string(),
                name: name.to_string(),
                quantity: quantity.to_string(),
                units: units.to_string(),
                created_at: item_id.to_string(),
                members: vec![sha256.to_string()],
                analyses: Vec::new(),
            }],
        }
    }

    fn write_catalogue_with_version(path: &std::path::Path, version: &str) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(&format!(
                "CREATE TABLE lidar_catalogue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO lidar_catalogue_meta VALUES ('schema_version', '{version}');
                 CREATE TABLE lidar_source_layers (id TEXT PRIMARY KEY);"
            ))
            .unwrap();
    }

    fn set_aside_files(lidar: &std::path::Path) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = std::fs::read_dir(lidar.join(recovery::SET_ASIDE_DIR))
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default();
        files.sort();
        files
    }

    fn saved_selection(library: &LidarLibrary, layer_id: &str) -> Vec<PathBuf> {
        let request: String = library
            .catalogue()
            .unwrap()
            .query_row(
                "SELECT request_json FROM lidar_import_jobs WHERE layer_id = ?1",
                [layer_id],
                |row| row.get(0),
            )
            .unwrap();
        parse_import_request(&request).unwrap()
    }

    /// An older catalogue is set aside byte for byte and rebuilt from the
    /// originals' meta: both items come back named, typed and retryable over
    /// their managed originals; the analysis defined over one comes back with
    /// its result unpublished. A second open finds a current catalogue.
    #[test]
    #[expect(
        clippy::too_many_lines,
        reason = "ratcheted before 2.1-M188; split when this function next changes"
    )]
    fn an_older_catalogue_is_set_aside_and_rebuilt_from_the_originals() {
        let root = crate::test_scratch::TestScratch::new("lidar-older-library");
        let lidar = paths::library_root(&root);
        std::fs::create_dir_all(&lidar).unwrap();
        write_original(
            &lidar,
            "sha-1",
            Some(&single_item_meta(
                "sha-1",
                "lyr-1",
                "Orchard",
                RasterQuantity::GroundElevation.key(),
                "m",
            )),
        );
        let mut second = single_item_meta(
            "sha-2",
            "lyr-2",
            "Canopy",
            RasterQuantity::OtherContinuous.key(),
            "index",
        );
        second.items[0].analyses.push(source_meta::AnalysisMeta {
            definition_id: "adef-1".into(),
            analysis_id: "terrain.slope".into(),
            parameters: serde_json::json!([{"key":"unit","value":{"Choice":"degrees"}}]),
            outputs: serde_json::json!(["slope"]),
            created_at: "11".into(),
            inputs: vec![source_meta::AnalysisInputMeta {
                input_key: "dem".into(),
                item_id: "lyr-2".into(),
            }],
            items: vec![source_meta::DerivedItemMeta {
                id: "item-slope".into(),
                output_key: "slope".into(),
                quantity: "slope".into(),
                units: "°".into(),
                name: Some("Steepness".into()),
                created_at: "11".into(),
            }],
        });
        write_original(&lidar, "sha-2", Some(&second));
        let catalogue_path = lidar.join(paths::CATALOGUE_FILE);
        write_catalogue_with_version(&catalogue_path, "20");
        let older_bytes = std::fs::read(&catalogue_path).unwrap();

        let library = LidarLibrary::open(&root).unwrap();
        match library.open_status() {
            recovery::LibraryOpenStatus::Recovered {
                reason,
                items,
                generated,
                ..
            } => {
                assert_eq!(*reason, recovery::RecoveryReason::OlderVersion(20));
                assert_eq!((*items, *generated), (2, 0));
            }
            other => panic!("expected a recovered library, got {other:?}"),
        }
        let set_aside = set_aside_files(&lidar);
        assert_eq!(set_aside.len(), 1, "{set_aside:?}");
        assert!(set_aside[0].extension().is_some_and(|ext| ext == "sqlite"));
        assert_eq!(
            std::fs::read(&set_aside[0]).unwrap(),
            older_bytes,
            "set aside byte for byte"
        );
        assert_eq!(
            catalogue::stored_version(&catalogue_path).unwrap(),
            Some(catalogue::CATALOGUE_VERSION)
        );
        for sha256 in ["sha-1", "sha-2"] {
            assert_eq!(
                std::fs::read(lidar.join("sources").join(sha256).join("original")).unwrap(),
                format!("bytes of {sha256}").into_bytes(),
                "originals are never touched"
            );
        }

        let snapshot = library.library_snapshot().unwrap();
        let names: Vec<(String, common_types::library::LibraryItemRole)> = snapshot
            .items
            .iter()
            .map(|item| (item.name.clone().unwrap_or_default(), item.role))
            .collect();
        assert_eq!(
            names,
            vec![
                (
                    "Orchard".to_string(),
                    common_types::library::LibraryItemRole::Source
                ),
                (
                    "Canopy".to_string(),
                    common_types::library::LibraryItemRole::Source
                ),
                (
                    "Steepness".to_string(),
                    common_types::library::LibraryItemRole::Derived
                ),
            ]
        );
        let canopy = &snapshot.items[1];
        assert_eq!(canopy.id, "lyr-2");
        assert_eq!(canopy.units, "index");
        assert_eq!(canopy.state, common_types::lidar::LidarResultState::Failed);
        let job = canopy.import_job.as_ref().expect("a retryable import");
        assert_eq!(job.state, LidarImportJobState::Failed);
        assert_eq!(job.message, None, "the Data library's banner says why");
        assert_eq!(
            saved_selection(&library, "lyr-2"),
            vec![library.inner.paths.source_original("sha-2")]
        );
        let slope = &snapshot.items[2];
        assert_eq!(slope.state, common_types::lidar::LidarResultState::Failed);
        assert_eq!(slope.units, "°");
        assert_eq!(
            library.delete_impact("lyr-2").unwrap().dependent_item_ids,
            vec!["item-slope"]
        );

        drop(library);
        let reopened = LidarLibrary::open(&root).unwrap();
        assert_eq!(*reopened.open_status(), recovery::LibraryOpenStatus::Ready);
        assert_eq!(reopened.library_snapshot().unwrap().items.len(), 3);
        assert_eq!(
            set_aside_files(&lidar).len(),
            1,
            "a current catalogue is not set aside"
        );
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A catalogue that is not a database at all takes the same road.
    #[test]
    fn a_corrupt_catalogue_is_set_aside_and_rebuilt() {
        let root = crate::test_scratch::TestScratch::new("lidar-corrupt-library");
        let lidar = paths::library_root(&root);
        write_original(
            &lidar,
            "sha-9",
            Some(&single_item_meta(
                "sha-9",
                "lyr-9",
                "Ridge",
                RasterQuantity::GroundElevation.key(),
                "m",
            )),
        );
        let garbage = b"definitely not sqlite".to_vec();
        std::fs::write(lidar.join(paths::CATALOGUE_FILE), &garbage).unwrap();

        let library = LidarLibrary::open(&root).unwrap();
        assert!(
            matches!(
                library.open_status(),
                recovery::LibraryOpenStatus::Recovered {
                    reason: recovery::RecoveryReason::Corrupt(_),
                    items: 1,
                    ..
                }
            ),
            "{:?}",
            library.open_status()
        );
        let set_aside = set_aside_files(&lidar);
        assert_eq!(std::fs::read(&set_aside[0]).unwrap(), garbage);
        assert_eq!(
            library.library_snapshot().unwrap().items[0].name.as_deref(),
            Some("Ridge")
        );
        drop(library);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// An original nothing describes is still listed, under a generated name
    /// with the default quantity, so it can be prepared or deleted by the user.
    #[test]
    fn an_original_without_meta_is_listed_under_a_generated_name() {
        let root = crate::test_scratch::TestScratch::new("lidar-orphan-original");
        let lidar = paths::library_root(&root);
        write_original(&lidar, "0123456789abcdef", None);
        write_catalogue_with_version(&lidar.join(paths::CATALOGUE_FILE), "20");

        let library = LidarLibrary::open(&root).unwrap();
        assert!(matches!(
            library.open_status(),
            recovery::LibraryOpenStatus::Recovered {
                items: 0,
                generated: 1,
                ..
            }
        ));
        let snapshot = library.library_snapshot().unwrap();
        assert_eq!(snapshot.items.len(), 1);
        let item = &snapshot.items[0];
        assert_eq!(item.name.as_deref(), Some("Recovered raster 01234567"));
        assert_eq!(
            item.item_type,
            common_types::library::LibraryItemType::Raster {
                quantity: RasterQuantity::GroundElevation
            }
        );
        assert_eq!(item.units, "m");
        assert_eq!(
            saved_selection(&library, &item.id),
            vec![library.inner.paths.source_original("0123456789abcdef")]
        );
        assert!(lidar.join("sources/0123456789abcdef/original").is_file());
        drop(library);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A recovered library that is rebuilt again before anything was retried
    /// keeps every item: the metas the first recovered open rewrites still
    /// describe the unpublished items, their member order and their analyses,
    /// and an original first listed under a generated name keeps that item.
    #[test]
    fn a_second_rebuild_before_any_retry_keeps_every_item() {
        let root = crate::test_scratch::TestScratch::new("lidar-double-rebuild");
        let lidar = paths::library_root(&root);
        let mut orchard = single_item_meta(
            "sha-1",
            "lyr-1",
            "Orchard",
            RasterQuantity::GroundElevation.key(),
            "m",
        );
        orchard.items[0].analyses.push(source_meta::AnalysisMeta {
            definition_id: "adef-1".into(),
            analysis_id: "terrain.slope".into(),
            parameters: serde_json::json!([{"key":"unit","value":{"Choice":"degrees"}}]),
            outputs: serde_json::json!(["slope"]),
            created_at: "11".into(),
            inputs: vec![source_meta::AnalysisInputMeta {
                input_key: "dem".into(),
                item_id: "lyr-1".into(),
            }],
            items: vec![source_meta::DerivedItemMeta {
                id: "item-slope".into(),
                output_key: "slope".into(),
                quantity: "slope".into(),
                units: "°".into(),
                name: Some("Steepness".into()),
                created_at: "11".into(),
            }],
        });
        write_original(&lidar, "sha-1", Some(&orchard));
        write_original(&lidar, "0123456789abcdef", None);
        let catalogue_path = lidar.join(paths::CATALOGUE_FILE);
        write_catalogue_with_version(&catalogue_path, "20");

        let items_of = |library: &LidarLibrary| -> Vec<(String, String, String)> {
            library
                .library_snapshot()
                .unwrap()
                .items
                .iter()
                .map(|item| {
                    (
                        item.id.clone(),
                        item.name.clone().unwrap_or_default(),
                        item.units.clone(),
                    )
                })
                .collect()
        };
        let library = LidarLibrary::open(&root).unwrap();
        let first = items_of(&library);
        assert_eq!(first.len(), 3, "{first:?}");
        drop(library);

        // A second rebuild, before any Retry: the catalogue is older again.
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", catalogue_path.display()));
        }
        write_catalogue_with_version(&catalogue_path, "20");
        let reopened = LidarLibrary::open(&root).unwrap();
        assert!(
            matches!(
                reopened.open_status(),
                recovery::LibraryOpenStatus::Recovered { .. }
            ),
            "{:?}",
            reopened.open_status()
        );
        assert_eq!(items_of(&reopened), first, "no item is lost");
        assert_eq!(
            saved_selection(&reopened, "lyr-1"),
            vec![reopened.inner.paths.source_original("sha-1")]
        );
        assert_eq!(
            reopened.delete_impact("lyr-1").unwrap().dependent_item_ids,
            vec!["item-slope"],
            "the analysis over the item survives"
        );
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Member order is the item's source priority and survives the rebuild.
    #[test]
    fn a_rebuilt_item_keeps_its_member_order() {
        let root = crate::test_scratch::TestScratch::new("lidar-member-order");
        let lidar = paths::library_root(&root);
        let mut meta_b = single_item_meta(
            "sha-b",
            "lyr-ab",
            "Pair",
            RasterQuantity::GroundElevation.key(),
            "m",
        );
        meta_b.items[0].members = vec!["sha-b".into(), "sha-a".into()];
        let mut meta_a = meta_b.clone();
        meta_a.sha256 = "sha-a".into();
        write_original(&lidar, "sha-a", Some(&meta_a));
        write_original(&lidar, "sha-b", Some(&meta_b));
        write_catalogue_with_version(&lidar.join(paths::CATALOGUE_FILE), "20");

        let library = LidarLibrary::open(&root).unwrap();
        assert_eq!(library.library_snapshot().unwrap().items.len(), 1);
        let paths = &library.inner.paths;
        assert_eq!(
            saved_selection(&library, "lyr-ab"),
            vec![
                paths.source_original("sha-b"),
                paths.source_original("sha-a")
            ]
        );
        drop(library);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A newer catalogue belongs to a newer Canopi: it is refused and nothing
    /// under the library is moved, written or swept. The app still starts with
    /// an empty, read-only library that names the refusal.
    #[test]
    fn a_newer_catalogue_is_refused_without_touching_files() {
        let root = crate::test_scratch::TestScratch::new("lidar-newer-library");
        let lidar = paths::library_root(&root);
        write_original(
            &lidar,
            "sha-n",
            Some(&single_item_meta(
                "sha-n",
                "lyr-n",
                "Future",
                RasterQuantity::GroundElevation.key(),
                "m",
            )),
        );
        std::fs::create_dir_all(lidar.join("assets/unreferenced")).unwrap();
        std::fs::write(lidar.join("assets/unreferenced/cog.tif"), b"kept").unwrap();
        let catalogue_path = lidar.join(paths::CATALOGUE_FILE);
        write_catalogue_with_version(&catalogue_path, "99");
        let newer_bytes = std::fs::read(&catalogue_path).unwrap();

        let library = LidarLibrary::open(&root).expect("the app starts");
        assert_eq!(
            *library.open_status(),
            recovery::LibraryOpenStatus::RefusedNewer {
                found: 99,
                supported: catalogue::CATALOGUE_VERSION
            }
        );
        assert!(library.library_snapshot().unwrap().items.is_empty());
        let refused = library
            .record_import_item(
                "Later",
                RasterQuantity::GroundElevation,
                None,
                false,
                &[root.join("a.tif")],
            )
            .unwrap_err();
        assert!(refused.contains("newer version of Canopi"), "{refused}");
        assert!(
            library
                .rename_item("lyr-n", "x")
                .unwrap_err()
                .contains("newer version")
        );
        assert_eq!(
            std::fs::read(&catalogue_path).unwrap(),
            newer_bytes,
            "left byte for byte"
        );
        assert!(!lidar.join(recovery::SET_ASIDE_DIR).exists());
        assert!(
            lidar.join("assets/unreferenced/cog.tif").is_file(),
            "nothing is swept"
        );
        assert!(lidar.join("sources/sha-n/original").is_file());
        drop(library);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The meta the library writes after publication is what a rebuild reads:
    /// a published item with a result, set aside, comes back as the same items
    /// in the same order.
    #[test]
    fn the_meta_a_library_writes_rebuilds_its_own_items() {
        let root = crate::test_scratch::TestScratch::new("lidar-meta-roundtrip");
        let lidar = paths::library_root(&root);
        let library = LidarLibrary::open(&root).unwrap();
        for sha256 in ["sha-x", "sha-y"] {
            write_original(&lidar, sha256, None);
        }
        {
            let connection = library.catalogue().unwrap();
            source_meta::test_support::seed_published_item(
                &connection,
                "lyr-xy",
                "Valley",
                RasterQuantity::GroundElevation.key(),
                "m",
                &[("sha-y", "y.tif"), ("sha-x", "x.tif")],
            );
            seed_analysis(&connection, "lyr-xy", "item-v");
        }
        library.rename_item("item-v", "Valley slope").unwrap();
        let meta =
            source_meta::read(&library.inner.paths.source_meta("sha-x")).expect("meta written");
        assert_eq!(meta.original_filename, "x.tif");
        assert_eq!(meta.items[0].members, vec!["sha-y", "sha-x"]);
        assert_eq!(
            meta.items[0].analyses[0].items[0].name.as_deref(),
            Some("Valley slope")
        );
        drop(library);

        // The same files under a catalogue from another Canopi.
        std::fs::remove_file(lidar.join(paths::CATALOGUE_FILE)).unwrap();
        write_catalogue_with_version(&lidar.join(paths::CATALOGUE_FILE), "1");
        let rebuilt = LidarLibrary::open(&root).unwrap();
        assert!(matches!(
            rebuilt.open_status(),
            recovery::LibraryOpenStatus::Recovered {
                items: 1,
                generated: 0,
                ..
            }
        ));
        let snapshot = rebuilt.library_snapshot().unwrap();
        let listed: Vec<(String, Option<String>)> = snapshot
            .items
            .iter()
            .map(|item| (item.id.clone(), item.name.clone()))
            .collect();
        assert_eq!(
            listed,
            vec![
                ("lyr-xy".to_string(), Some("Valley".to_string())),
                ("item-v".to_string(), Some("Valley slope".to_string())),
            ]
        );
        let paths = &rebuilt.inner.paths;
        assert_eq!(
            saved_selection(&rebuilt, "lyr-xy"),
            vec![
                paths.source_original("sha-y"),
                paths.source_original("sha-x")
            ]
        );
        drop(rebuilt);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A real import writes the meta a rebuild needs, and Retry on
    /// the rebuilt item prepares it again from the managed originals alone,
    /// under the same item id, with the same members in the same order.
    #[test]
    #[expect(
        clippy::too_many_lines,
        reason = "ratcheted before 2.1-M188; split when this function next changes"
    )]
    fn a_rebuilt_item_is_prepared_again_from_its_managed_originals() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let root = crate::test_scratch::TestScratch::new("canopi-rebuild-retry");
        std::fs::create_dir_all(&root).unwrap();
        let plane = |name: &str, value: f32, origin_x: f64| -> PathBuf {
            let raw = root.join(format!("{name}.raw"));
            import::write_f32_raw(&raw, &[value; 16]).expect("raw plane");
            let tif = root.join(format!("{name}.tif"));
            let grid = grid::RasterGrid {
                width: 4,
                height: 4,
                geotransform: [origin_x, 1.0, 0.0, 4.0, 0.0, -1.0],
            };
            import::raw_to_tif(&engine, &cancel, &raw, &tif, &grid, "EPSG:3857", -9999.0)
                .expect("plane converts");
            tif
        };
        let west = plane("west", 5.0, 0.0);
        let east = plane("east", 9.0, 3.0);
        let lidar = paths::library_root(&root);

        let library = LidarLibrary::open(&root).unwrap();
        let (layer_id, job_id) = library
            .record_import_item(
                "Two planes",
                RasterQuantity::GroundElevation,
                None,
                false,
                &[east.clone(), west.clone()],
            )
            .unwrap();
        import::stage_and_publish(&library, &job_id, &layer_id, &[east, west], &cancel)
            .expect("the batch publishes");
        library.finish_import_sources(&job_id, Ok(()));
        let members: Vec<String> = {
            let connection = library.catalogue().unwrap();
            let head = catalogue::head_generation(&connection, &layer_id)
                .unwrap()
                .expect("published");
            catalogue::collection_members(&connection, &head.id)
                .unwrap()
                .iter()
                .map(|member| {
                    connection
                        .query_row(
                            "SELECT source_sha256 FROM lidar_interpretations WHERE id = ?1",
                            [&member.interpretation_id],
                            |row| row.get(0),
                        )
                        .unwrap()
                })
                .collect()
        };
        assert_eq!(members.len(), 2);
        for sha256 in &members {
            let meta = source_meta::read(&library.inner.paths.source_meta(sha256))
                .expect("meta written after publication");
            assert_eq!(meta.items[0].id, layer_id);
            assert_eq!(meta.items[0].name, "Two planes");
            assert_eq!(meta.items[0].members, members);
        }
        assert_eq!(
            source_meta::read(&library.inner.paths.source_meta(&members[0]))
                .unwrap()
                .original_filename,
            "east.tif"
        );
        drop(library);

        std::fs::remove_file(lidar.join(paths::CATALOGUE_FILE)).unwrap();
        write_catalogue_with_version(&lidar.join(paths::CATALOGUE_FILE), "1");
        let rebuilt = LidarLibrary::open(&root).unwrap();
        assert!(matches!(
            rebuilt.open_status(),
            recovery::LibraryOpenStatus::Recovered {
                items: 1,
                generated: 0,
                ..
            }
        ));
        let listed = &rebuilt.library_snapshot().unwrap().items[0];
        assert_eq!(listed.id, layer_id);
        assert_eq!(listed.state, common_types::lidar::LidarResultState::Failed);

        // Retry, as the command does it, minus the spawned wrapper.
        let (retry_layer, retry_job, selection) = rebuilt.record_import_retry(&layer_id).unwrap();
        assert_eq!(retry_layer, layer_id);
        assert!(
            selection
                .iter()
                .all(|path| path.starts_with(lidar.join("sources")))
        );
        import::stage_and_publish(&rebuilt, &retry_job, &layer_id, &selection, &cancel)
            .expect("the managed originals publish again");
        rebuilt.finish_import_sources(&retry_job, Ok(()));
        let snapshot = rebuilt.library_snapshot().unwrap();
        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(
            snapshot.items[0].state,
            common_types::lidar::LidarResultState::Ready
        );
        let collection = rebuilt.layer_collection(&layer_id, None).unwrap();
        let again: Vec<String> = collection
            .sources
            .iter()
            .map(|member| member.filename.clone())
            .collect();
        assert_eq!(
            again,
            vec!["east.tif", "west.tif"],
            "order and filenames survive"
        );
        drop(rebuilt);
        std::fs::remove_dir_all(root).unwrap();
    }
}
