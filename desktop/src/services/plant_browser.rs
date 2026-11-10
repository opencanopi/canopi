mod species_search_progress;

use canopi_types::species::{
    PaginatedResult, SpeciesDetail, SpeciesListItem, SpeciesSearchRequest,
};
use rusqlite::{Connection, InterruptHandle};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};

use crate::db::{self, PlantDb, UserDb};
use crate::services::species_catalog_read::SpeciesCatalogRead;

const SPECIES_SEARCH_CANCELLED: &str =
    "Species search cancelled because a newer query superseded it";
const SPECIES_SEARCH_PROGRESS_INTERVAL: i32 = 100;

#[derive(Clone, Default)]
pub struct SpeciesSearchCancellation {
    inner: Arc<SpeciesSearchCancellationInner>,
}

#[derive(Default)]
struct SpeciesSearchCancellationInner {
    next_generation: AtomicU64,
    active: Mutex<Option<ActiveSpeciesSearch>>,
    #[cfg(test)]
    before_interrupt: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    after_mark_running: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    after_search_success: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

struct ActiveSpeciesSearch {
    generation: u64,
    interrupt: Arc<InterruptHandle>,
    is_running: bool,
}

pub struct SpeciesSearchCancellationToken {
    cancellation: SpeciesSearchCancellation,
    generation: u64,
}

struct SpeciesSearchRunningGuard {
    cancellation: SpeciesSearchCancellation,
    generation: u64,
}

impl SpeciesSearchCancellation {
    pub fn begin_request(
        &self,
        request: &SpeciesSearchRequest,
        interrupt: Option<Arc<InterruptHandle>>,
    ) -> Option<SpeciesSearchCancellationToken> {
        if is_active_species_search_request(request)
            && let Some(interrupt) = interrupt
        {
            return Some(self.begin(interrupt));
        }

        self.supersede();
        None
    }

    fn begin(&self, interrupt: Arc<InterruptHandle>) -> SpeciesSearchCancellationToken {
        let generation = {
            let mut active = self.inner.active.lock().unwrap_or_else(|error| {
                tracing::warn!(
                    "Recovered poisoned Species Search cancellation lock while starting search"
                );
                error.into_inner()
            });
            let generation = self
                .inner
                .next_generation
                .fetch_add(1, Ordering::AcqRel)
                .wrapping_add(1);
            let previous = active.replace(ActiveSpeciesSearch {
                generation,
                interrupt,
                is_running: false,
            });
            self.interrupt_running_search(previous);
            generation
        };

        SpeciesSearchCancellationToken {
            cancellation: self.clone(),
            generation,
        }
    }

    fn supersede(&self) {
        let mut active = self.inner.active.lock().unwrap_or_else(|error| {
            tracing::warn!(
                "Recovered poisoned Species Search cancellation lock while superseding search"
            );
            error.into_inner()
        });
        self.inner.next_generation.fetch_add(1, Ordering::AcqRel);
        let previous = active.take();
        self.interrupt_running_search(previous);
    }

    pub fn supersede_request(&self) {
        self.supersede();
    }

    fn is_current(&self, generation: u64) -> bool {
        let active = self.inner.active.lock().unwrap_or_else(|error| {
            tracing::warn!(
                "Recovered poisoned Species Search cancellation lock while checking search"
            );
            error.into_inner()
        });
        active
            .as_ref()
            .is_some_and(|active| active.generation == generation)
    }

    fn mark_running(&self, generation: u64) -> Result<SpeciesSearchRunningGuard, String> {
        let mut active = self.inner.active.lock().unwrap_or_else(|error| {
            tracing::warn!(
                "Recovered poisoned Species Search cancellation lock while marking search running"
            );
            error.into_inner()
        });
        let Some(active) = active.as_mut() else {
            return Err(SPECIES_SEARCH_CANCELLED.to_owned());
        };
        if active.generation != generation {
            return Err(SPECIES_SEARCH_CANCELLED.to_owned());
        }
        active.is_running = true;
        Ok(SpeciesSearchRunningGuard {
            cancellation: self.clone(),
            generation,
        })
    }

    fn finish_running(&self, generation: u64) {
        let mut active = self.inner.active.lock().unwrap_or_else(|error| {
            tracing::warn!(
                "Recovered poisoned Species Search cancellation lock while marking search idle"
            );
            error.into_inner()
        });
        if let Some(active) = active.as_mut()
            && active.generation == generation
        {
            active.is_running = false;
        }
    }

    fn finish(&self, generation: u64) {
        let mut active = self.inner.active.lock().unwrap_or_else(|error| {
            tracing::warn!(
                "Recovered poisoned Species Search cancellation lock while finishing search"
            );
            error.into_inner()
        });
        if active
            .as_ref()
            .is_some_and(|active| active.generation == generation)
        {
            *active = None;
        }
    }

    fn interrupt_running_search(&self, search: Option<ActiveSpeciesSearch>) {
        if let Some(search) = search
            && search.is_running
        {
            #[cfg(test)]
            {
                let hook = self
                    .inner
                    .before_interrupt
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone();
                if let Some(hook) = hook {
                    hook();
                }
            }
            search.interrupt.interrupt();
        }
    }

    #[cfg(test)]
    fn set_before_interrupt_hook(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self
            .inner
            .before_interrupt
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(Arc::new(hook));
    }

    #[cfg(test)]
    fn set_after_mark_running_hook(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self
            .inner
            .after_mark_running
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(Arc::new(hook));
    }

    #[cfg(test)]
    fn run_after_mark_running_hook(&self) {
        let hook = self
            .inner
            .after_mark_running
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(hook) = hook {
            hook();
        }
    }

    #[cfg(test)]
    fn set_after_search_success_hook(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self
            .inner
            .after_search_success
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(Arc::new(hook));
    }

    #[cfg(test)]
    fn run_after_search_success_hook(&self) {
        let hook = self
            .inner
            .after_search_success
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(hook) = hook {
            hook();
        }
    }
}

impl SpeciesSearchCancellationToken {
    fn ensure_current(&self) -> Result<(), String> {
        self.cancellation
            .is_current(self.generation)
            .then_some(())
            .ok_or_else(|| SPECIES_SEARCH_CANCELLED.to_owned())
    }

    fn mark_running(&self) -> Result<SpeciesSearchRunningGuard, String> {
        self.cancellation.mark_running(self.generation)
    }
}

impl Drop for SpeciesSearchCancellationToken {
    fn drop(&mut self) {
        self.cancellation.finish(self.generation);
    }
}

impl Drop for SpeciesSearchRunningGuard {
    fn drop(&mut self) {
        self.cancellation.finish_running(self.generation);
    }
}

pub fn is_active_species_search_request(request: &SpeciesSearchRequest) -> bool {
    matches!(
        crate::db::species_search_normalization::species_search_admission(&request.text),
        crate::db::species_search_normalization::SpeciesSearchAdmission::ActiveText
    )
}

pub fn search_species(
    plant_db: &PlantDb,
    user_db: &UserDb,
    request: SpeciesSearchRequest,
) -> Result<PaginatedResult<SpeciesListItem>, String> {
    let mut result = {
        let conn = db::require_plant_db(plant_db)?;
        SpeciesCatalogRead::new(&conn).search(request)?
    };

    {
        hydrate_favorite_flags(user_db, &mut result.items)?;
    }

    Ok(result)
}

pub async fn search_species_async(
    executor: &crate::native_operation::NativeOperationExecutor,
    plant_db: PlantDb,
    user_db: UserDb,
    request: SpeciesSearchRequest,
) -> Result<PaginatedResult<SpeciesListItem>, String> {
    executor
        .run(
            crate::native_operation::NativeOperationClass::Catalog,
            "species search",
            move || search_species(&plant_db, &user_db, request),
        )
        .await
}

pub async fn search_species_async_cancellable(
    executor: &crate::native_operation::NativeOperationExecutor,
    plant_db: PlantDb,
    user_db: UserDb,
    request: SpeciesSearchRequest,
    cancellation: Option<SpeciesSearchCancellationToken>,
) -> Result<PaginatedResult<SpeciesListItem>, String> {
    executor
        .run(
            crate::native_operation::NativeOperationClass::Catalog,
            "species search",
            move || {
                if let Some(cancellation) = &cancellation {
                    cancellation.ensure_current()?;
                }

                let mut result = {
                    let plant_conn = db::require_plant_db(&plant_db)?;
                    let progress;
                    let conn = if let Some(cancellation) = &cancellation {
                        progress = cancellation.install_progress_handler(plant_conn)?;
                        &progress.connection
                    } else {
                        &plant_conn
                    };
                    let _running = cancellation
                        .as_ref()
                        .map(|cancellation| cancellation.mark_running())
                        .transpose()?;
                    #[cfg(test)]
                    if let Some(cancellation) = &cancellation {
                        cancellation.cancellation.run_after_mark_running_hook();
                    }
                    if let Some(cancellation) = &cancellation {
                        cancellation.ensure_current()?;
                    }
                    match SpeciesCatalogRead::new(conn).search(request) {
                        Ok(result) => {
                            #[cfg(test)]
                            if let Some(cancellation) = &cancellation {
                                cancellation.cancellation.run_after_search_success_hook();
                            }
                            result
                        }
                        Err(error) => {
                            if let Some(cancellation) = &cancellation {
                                cancellation.ensure_current()?;
                            }
                            return Err(error);
                        }
                    }
                };

                if let Some(cancellation) = &cancellation {
                    cancellation.ensure_current()?;
                }

                hydrate_favorite_flags(&user_db, &mut result.items)?;

                if let Some(cancellation) = &cancellation {
                    cancellation.ensure_current()?;
                }

                Ok(result)
            },
        )
        .await
}

pub(crate) fn hydrate_favorite_flags(
    user_db: &UserDb,
    items: &mut [SpeciesListItem],
) -> Result<(), String> {
    let conn = user_db.acquire();
    for item in items {
        item.is_favorite = crate::db::user_db::is_favorite(&conn, &item.canonical_name)
            .map_err(|e| format!("Failed to read favorites: {e}"))?;
    }
    Ok(())
}

pub fn get_species_detail(
    plant_db: &PlantDb,
    user_db: &UserDb,
    canonical_name: String,
    locale: String,
) -> Result<SpeciesDetail, String> {
    let detail = {
        let conn = db::require_plant_db(plant_db)?;
        SpeciesCatalogRead::new(&conn).detail_for_canonical_name(&canonical_name, &locale)?
    };

    {
        let conn = user_db.acquire();
        if let Err(error) = crate::db::user_db::record_recently_viewed(&conn, &canonical_name) {
            tracing::warn!(
                "Failed to record recently viewed for '{}': {error}",
                canonical_name
            );
        }
    }

    Ok(detail)
}

pub fn toggle_favorite(user_db: &UserDb, canonical_name: String) -> Result<bool, String> {
    let conn = user_db.acquire();
    crate::db::user_db::toggle_favorite(&conn, &canonical_name)
        .map_err(|e| format!("Failed to toggle favorite for '{canonical_name}': {e}"))
}

pub(crate) fn get_favorite_names(user_db: &UserDb) -> Result<Vec<String>, String> {
    let conn = user_db.acquire();
    crate::db::user_db::get_favorite_names(&conn)
        .map_err(|e| format!("Failed to read favorites: {e}"))
}

pub(crate) fn get_recently_viewed_names(
    user_db: &UserDb,
    limit: u32,
) -> Result<Vec<String>, String> {
    let conn = user_db.acquire();
    crate::db::user_db::get_recently_viewed_names(&conn, limit)
        .map_err(|e| format!("Failed to read recently viewed: {e}"))
}

pub(crate) fn project_personal_species_list_items(
    plant_db: &PlantDb,
    names: Vec<String>,
    locale: String,
) -> Result<Vec<SpeciesListItem>, String> {
    if names.is_empty() {
        return Ok(Vec::new());
    }

    let conn = db::require_plant_db(plant_db)?;
    SpeciesCatalogRead::new(&conn).list_items_for_canonical_names(&names, &locale)
}

#[cfg(test)]
pub fn get_favorites(
    user_db: &UserDb,
    plant_db: &PlantDb,
    locale: String,
) -> Result<Vec<SpeciesListItem>, String> {
    let names = get_favorite_names(user_db)?;
    let mut items = project_personal_species_list_items(plant_db, names, locale)?;
    for item in &mut items {
        item.is_favorite = true;
    }
    Ok(items)
}

#[cfg(test)]
pub fn get_recently_viewed(
    user_db: &UserDb,
    plant_db: &PlantDb,
    locale: String,
    limit: u32,
) -> Result<Vec<SpeciesListItem>, String> {
    let names = get_recently_viewed_names(user_db, limit)?;
    let mut items = project_personal_species_list_items(plant_db, names, locale)?;
    hydrate_favorite_flags(user_db, &mut items)?;

    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::{
        SpeciesSearchCancellation, get_favorites, get_recently_viewed,
        is_active_species_search_request, search_species, search_species_async,
        search_species_async_cancellable, toggle_favorite,
    };
    use crate::db::{self, PlantDb, UserDb};
    use crate::native_operation::NativeOperationExecutor;
    use canopi_types::species::{Sort, SpeciesFilter, SpeciesSearchRequest};
    use rusqlite::Connection;
    use std::{
        sync::{
            Arc, Barrier,
            atomic::{AtomicBool, Ordering},
            mpsc,
        },
        time::Duration,
    };

    fn test_plant_db() -> PlantDb {
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
                id, canonical_name, slug, common_name, family, genus,
                height_max_m, hardiness_zone_min, hardiness_zone_max,
                growth_rate, stratum, edibility_rating, medicinal_rating, width_max_m
            ) VALUES
                ('sp-1', 'Malus domestica', 'malus-domestica', 'Apple', 'Rosaceae', 'Malus', 4.0, 4, 8, 'Medium', 'Canopy', 5, 1, 3.0),
                ('sp-2', 'Lavandula angustifolia', 'lavandula-angustifolia', 'Lavender', 'Lamiaceae', 'Lavandula', 1.0, 5, 9, 'Slow', 'Low', 1, 1, 1.0);

            INSERT INTO best_common_names VALUES
                ('sp-1', 'fr', 'Pommier'),
                ('sp-2', 'fr', 'Lavande');

	            INSERT INTO species_common_names VALUES
	                ('sp-1', 'Apple', 'en', 1, 0),
	                ('sp-1', 'Pommier', 'fr', 1, 0),
	                ('sp-1', 'Pomme', 'fr', 0, 1),
	                ('sp-2', 'Lavender', 'en', 1, 0),
	                ('sp-2', 'Lavande', 'fr', 1, 0);

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

            INSERT INTO species_search_fts(species_search_fts) VALUES('rebuild');",
        )
        .unwrap();
        crate::db::plant_catalog_connection::stamp_expected_prepared_identity(&conn);
        PlantDb::available(conn)
    }

    fn test_user_db() -> UserDb {
        UserDb::initialize(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn test_executor() -> NativeOperationExecutor {
        NativeOperationExecutor::production()
    }

    fn search_request(
        text: &str,
        filters: SpeciesFilter,
        limit: u32,
        include_total: bool,
        locale: &str,
    ) -> SpeciesSearchRequest {
        SpeciesSearchRequest {
            text: text.to_owned(),
            filters,
            cursor: None,
            limit,
            sort: Sort::Name,
            locale: locale.to_owned(),
            include_total,
        }
    }

    #[test]
    fn search_returns_explicit_error_when_plant_db_missing() {
        let plant_db = PlantDb::missing();
        let user_db = test_user_db();

        let error = search_species(
            &plant_db,
            &user_db,
            search_request("Malus", SpeciesFilter::default(), 10, true, "en"),
        )
        .unwrap_err();

        assert!(error.contains("Plant database unavailable"));
    }

    #[test]
    fn search_marks_favorites_after_db_query() {
        let plant_db = test_plant_db();
        let user_db = test_user_db();

        toggle_favorite(&user_db, "Malus domestica".to_owned()).unwrap();

        let result = search_species(
            &plant_db,
            &user_db,
            search_request("Malus", SpeciesFilter::default(), 10, true, "en"),
        )
        .unwrap();

        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].canonical_name, "Malus domestica");
        assert_eq!(result.total_estimate, 1);
        assert!(result.items[0].is_favorite);
    }

    #[test]
    fn async_search_preserves_search_response_contract() {
        let plant_db = test_plant_db();
        let user_db = test_user_db();

        toggle_favorite(&user_db, "Malus domestica".to_owned()).unwrap();
        let executor = test_executor();

        let result = tauri::async_runtime::block_on(search_species_async(
            &executor,
            plant_db.clone(),
            user_db.clone(),
            search_request("Malus", SpeciesFilter::default(), 10, true, "en"),
        ))
        .unwrap();

        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].canonical_name, "Malus domestica");
        assert_eq!(result.total_estimate, 1);
        assert!(result.items[0].is_favorite);
    }

    #[test]
    fn newer_active_search_cancels_older_queued_search() {
        let plant_db = test_plant_db();
        let user_db = test_user_db();
        let cancellation = SpeciesSearchCancellation::default();
        let executor = test_executor();

        let first = cancellation.begin(plant_db.interrupt_handle().unwrap());
        let _second = cancellation.begin(plant_db.interrupt_handle().unwrap());

        let error = tauri::async_runtime::block_on(search_species_async_cancellable(
            &executor,
            plant_db,
            user_db,
            search_request("Malus", SpeciesFilter::default(), 10, true, "en"),
            Some(first),
        ))
        .unwrap_err();

        assert_eq!(
            error,
            "Species search cancelled because a newer query superseded it"
        );
    }

    #[test]
    fn superseding_after_mark_running_stops_the_catalog_query_before_completion() {
        let plant_db = test_plant_db();
        let user_db = test_user_db();
        let cancellation = SpeciesSearchCancellation::default();
        let token = cancellation.begin(plant_db.interrupt_handle().unwrap());
        let reached_query_gap = Arc::new(Barrier::new(2));
        let release_query = Arc::new(Barrier::new(2));
        let hook_reached_query_gap = Arc::clone(&reached_query_gap);
        let hook_release_query = Arc::clone(&release_query);
        cancellation.set_after_mark_running_hook(move || {
            hook_reached_query_gap.wait();
            hook_release_query.wait();
        });
        let query_completed = Arc::new(AtomicBool::new(false));
        let hook_query_completed = Arc::clone(&query_completed);
        cancellation.set_after_search_success_hook(move || {
            hook_query_completed.store(true, Ordering::SeqCst);
        });
        let executor = test_executor();

        let search = std::thread::spawn(move || {
            tauri::async_runtime::block_on(search_species_async_cancellable(
                &executor,
                plant_db,
                user_db,
                search_request("Malus", SpeciesFilter::default(), 10, true, "en"),
                Some(token),
            ))
        });

        reached_query_gap.wait();
        cancellation.supersede_request();
        release_query.wait();

        let error = search.join().unwrap().unwrap_err();
        assert_eq!(
            error,
            "Species search cancelled because a newer query superseded it"
        );
        assert!(
            !query_completed.load(Ordering::SeqCst),
            "the superseded search completed SQLite work after its interrupt was delivered too early"
        );
    }

    #[test]
    fn generation_progress_handler_aborts_an_interrupt_delivered_before_sqlite_starts() {
        let mut connection = Connection::open_in_memory().unwrap();
        let cancellation = SpeciesSearchCancellation::default();
        let token = cancellation.begin(Arc::new(connection.get_interrupt_handle()));
        let progress = token.install_progress_handler(&mut connection).unwrap();
        let running = token.mark_running().unwrap();

        cancellation.supersede_request();

        let error = progress
            .connection
            .query_row(
                "WITH RECURSIVE cnt(x) AS (
                     VALUES(0)
                     UNION ALL
                     SELECT x + 1 FROM cnt WHERE x < 100000
                 )
                 SELECT sum(x) FROM cnt",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_err();
        assert_eq!(
            error.sqlite_error_code(),
            Some(rusqlite::ffi::ErrorCode::OperationInterrupted)
        );

        drop(running);
        drop(progress);
        let sum = connection
            .query_row(
                "WITH RECURSIVE cnt(x) AS (
                     VALUES(0)
                     UNION ALL
                     SELECT x + 1 FROM cnt WHERE x < 1000
                 )
                 SELECT sum(x) FROM cnt",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(sum, 500_500);
    }

    #[test]
    fn non_active_search_intents_supersede_the_current_active_generation() {
        let plant_db = test_plant_db();

        for text in ["", " -- / () ", "e"] {
            let cancellation = SpeciesSearchCancellation::default();
            let active = cancellation.begin(plant_db.interrupt_handle().unwrap());
            let _running = active.mark_running().unwrap();
            let request = search_request(text, SpeciesFilter::default(), 10, false, "en");
            assert!(!is_active_species_search_request(&request));

            let passive = cancellation.begin_request(&request, plant_db.interrupt_handle());

            assert!(passive.is_none());
            assert_eq!(
                active.ensure_current().unwrap_err(),
                "Species search cancelled because a newer query superseded it",
                "{text:?} did not supersede the active search",
            );
        }
    }

    #[test]
    fn queued_active_search_cancellation_does_not_interrupt_unrelated_plant_read() {
        let plant_db = test_plant_db();
        let cancellation = SpeciesSearchCancellation::default();
        let reader_db = plant_db.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let release_read = Arc::new(AtomicBool::new(false));
        let release_reader = Arc::clone(&release_read);

        let reader = std::thread::spawn(move || {
            let mut conn = db::require_plant_db(&reader_db).unwrap();
            let mut started_tx = Some(started_tx);
            conn.progress_handler(
                1,
                Some(move || {
                    if let Some(started_tx) = started_tx.take() {
                        let _ = started_tx.send(());
                    }
                    while !release_reader.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    false
                }),
            )
            .unwrap();

            conn.query_row(
                "WITH RECURSIVE cnt(x) AS (
                     VALUES(0)
                     UNION ALL
                     SELECT x + 1 FROM cnt WHERE x < 1000
                 )
                 SELECT sum(x) FROM cnt",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
        });

        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("unrelated plant DB read should start");

        let _queued_search = cancellation.begin(plant_db.interrupt_handle().unwrap());
        let _newer_search = cancellation.begin(plant_db.interrupt_handle().unwrap());
        release_read.store(true, Ordering::SeqCst);

        let read_result = reader.join().unwrap();
        assert!(
            read_result.is_ok(),
            "queued active search cancellation interrupted an unrelated plant DB read: {read_result:?}"
        );
    }

    #[test]
    fn interrupt_handoff_keeps_the_old_search_connection_until_interrupt() {
        let plant_db = test_plant_db();
        let cancellation = SpeciesSearchCancellation::default();
        let active = cancellation.begin(plant_db.interrupt_handle().unwrap());
        let active_db = plant_db.clone();
        let release_active = Arc::new(AtomicBool::new(false));
        let release_active_thread = Arc::clone(&release_active);
        let (active_started_tx, active_started_rx) = mpsc::channel();
        let (active_released_tx, active_released_rx) = mpsc::channel();
        let active_thread = std::thread::spawn(move || {
            let conn = db::require_plant_db(&active_db).unwrap();
            let running = active.mark_running().unwrap();
            active_started_tx.send(()).unwrap();
            while !release_active_thread.load(Ordering::SeqCst) {
                std::thread::yield_now();
            }
            drop(running);
            drop(conn);
            active_released_tx.send(()).unwrap();
        });
        active_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("active search should own the PlantDb connection");

        let interrupt_entered = Arc::new(Barrier::new(2));
        let release_interrupt = Arc::new(Barrier::new(2));
        let hook_entered = Arc::clone(&interrupt_entered);
        let hook_release = Arc::clone(&release_interrupt);
        cancellation.set_before_interrupt_hook(move || {
            hook_entered.wait();
            hook_release.wait();
        });

        let reader_db = plant_db.clone();
        let release_reader = Arc::new(AtomicBool::new(false));
        let release_reader_thread = Arc::clone(&release_reader);
        let (reader_started_tx, reader_started_rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut conn = db::require_plant_db(&reader_db).unwrap();
            let mut reader_started_tx = Some(reader_started_tx);
            conn.progress_handler(
                1,
                Some(move || {
                    if let Some(started) = reader_started_tx.take() {
                        let _ = started.send(());
                    }
                    while !release_reader_thread.load(Ordering::SeqCst) {
                        std::thread::yield_now();
                    }
                    false
                }),
            )
            .unwrap();
            conn.query_row(
                "WITH RECURSIVE cnt(x) AS (
                     VALUES(0)
                     UNION ALL
                     SELECT x + 1 FROM cnt WHERE x < 1000
                 )
                 SELECT sum(x) FROM cnt",
                [],
                |_| Ok(()),
            )
            .map_err(|error| error.to_string())
        });

        let superseding_cancellation = cancellation.clone();
        let superseder = std::thread::spawn(move || superseding_cancellation.supersede());
        interrupt_entered.wait();
        release_active.store(true, Ordering::SeqCst);

        let active_released_during_handoff = active_released_rx
            .recv_timeout(Duration::from_millis(100))
            .is_ok();
        let reader_started_during_handoff = active_released_during_handoff
            && reader_started_rx
                .recv_timeout(Duration::from_secs(1))
                .is_ok();

        release_interrupt.wait();
        superseder.join().unwrap();
        if !active_released_during_handoff {
            active_released_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("active search should release after the interrupt handoff");
        }
        if !reader_started_during_handoff {
            reader_started_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("unrelated read should start after the interrupt handoff");
        }
        release_reader.store(true, Ordering::SeqCst);

        active_thread.join().unwrap();
        let read_result = reader.join().unwrap();
        assert!(
            !active_released_during_handoff,
            "active search released PlantDb before its interrupt was delivered"
        );
        assert!(
            !reader_started_during_handoff,
            "unrelated PlantDb read started inside the stale-interrupt handoff window"
        );
        assert!(
            read_result.is_ok(),
            "stale search interrupt aborted an unrelated PlantDb read: {read_result:?}"
        );
    }

    #[test]
    fn active_search_cancellation_policy_matches_two_character_search_ux() {
        assert!(is_active_species_search_request(&search_request(
            "Ma",
            SpeciesFilter::default(),
            10,
            false,
            "en",
        )));
        assert!(!is_active_species_search_request(&search_request(
            "M",
            SpeciesFilter::default(),
            10,
            false,
            "en",
        )));
        assert!(!is_active_species_search_request(&search_request(
            "",
            SpeciesFilter::default(),
            10,
            true,
            "en",
        )));
        assert!(!is_active_species_search_request(&search_request(
            "--",
            SpeciesFilter::default(),
            10,
            false,
            "en",
        )));
        assert!(!is_active_species_search_request(&search_request(
            "E\u{301}",
            SpeciesFilter::default(),
            10,
            false,
            "en",
        )));
        assert!(is_active_species_search_request(&search_request(
            "ß",
            SpeciesFilter::default(),
            10,
            false,
            "en",
        )));
    }

    #[test]
    fn search_request_can_skip_first_page_count() {
        let plant_db = test_plant_db();
        let user_db = test_user_db();

        let result = search_species(
            &plant_db,
            &user_db,
            search_request("Malus", SpeciesFilter::default(), 10, false, "en"),
        )
        .unwrap();

        assert_eq!(result.items.len(), 1);
        assert_eq!(result.total_estimate, 0);
    }

    #[test]
    fn favorites_hydration_skips_missing_species_and_uses_locale_names() {
        let plant_db = test_plant_db();
        let user_db = test_user_db();

        toggle_favorite(&user_db, "Malus domestica".to_owned()).unwrap();
        toggle_favorite(&user_db, "Missing species".to_owned()).unwrap();

        let items = get_favorites(&user_db, &plant_db, "fr".to_owned()).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].canonical_name, "Malus domestica");
        assert_eq!(items[0].common_name.as_deref(), Some("Pommier"));
        assert_eq!(items[0].common_name_2.as_deref(), Some("Pomme"));
        assert!(items[0].is_favorite);
    }

    #[test]
    fn recently_viewed_hydration_marks_favorites_after_hydration() {
        let plant_db = test_plant_db();
        let user_db = test_user_db();

        {
            let conn = user_db.acquire();
            crate::db::user_db::record_recently_viewed(&conn, "Malus domestica").unwrap();
            crate::db::user_db::record_recently_viewed(&conn, "Lavandula angustifolia").unwrap();
        }
        toggle_favorite(&user_db, "Lavandula angustifolia".to_owned()).unwrap();

        let items = get_recently_viewed(&user_db, &plant_db, "en".to_owned(), 10).unwrap();

        assert_eq!(items.len(), 2);
        let apple = items
            .iter()
            .find(|item| item.canonical_name == "Malus domestica")
            .unwrap();
        let lavender = items
            .iter()
            .find(|item| item.canonical_name == "Lavandula angustifolia")
            .unwrap();
        assert!(!apple.is_favorite);
        assert!(lavender.is_favorite);
    }
}
