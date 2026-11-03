use tauri::State;

use canopi_types::species::{
    CommonNameEntry, DynamicFilterOptions, FilterOptions, FlowerColorResolution, PaginatedResult,
    SpeciesDetail, SpeciesImage, SpeciesListItem, SpeciesSearchRequest,
};

/// Search species with optional full-text and structured filters.
///
/// Lock ordering: PlantDb is locked first, released before UserDb is locked.
/// Both locks are never held simultaneously.
#[tauri::command]
pub async fn search_species(
    plant_db: tauri::State<'_, crate::db::PlantDb>,
    user_db: tauri::State<'_, crate::db::UserDb>,
    executor: tauri::State<'_, crate::native_operation::NativeOperationExecutor>,
    search_cancellation: tauri::State<
        '_,
        crate::services::plant_browser::SpeciesSearchCancellation,
    >,
    request: SpeciesSearchRequest,
) -> Result<PaginatedResult<SpeciesListItem>, String> {
    let plant_db = plant_db.inner().clone();
    let cancellation = search_cancellation
        .inner()
        .begin_request(&request, plant_db.interrupt_handle());

    let user_db = user_db.inner().clone();
    if let Some(cancellation) = cancellation {
        crate::services::plant_browser::search_species_async_cancellable(
            executor.inner(),
            plant_db,
            user_db,
            request,
            Some(cancellation),
        )
        .await
    } else {
        crate::services::plant_browser::search_species_async(
            executor.inner(),
            plant_db,
            user_db,
            request,
        )
        .await
    }
}

#[tauri::command]
pub fn supersede_species_search(
    search_cancellation: State<'_, crate::services::plant_browser::SpeciesSearchCancellation>,
) {
    search_cancellation.inner().supersede_request();
}

/// Fetch the full detail record for a species and record it in recently viewed.
///
/// Lock ordering: PlantDb first, then UserDb — never simultaneously.
#[tauri::command]
pub async fn get_species_detail(
    executor: State<'_, crate::native_operation::NativeOperationExecutor>,
    plant_db: State<'_, crate::db::PlantDb>,
    user_db: State<'_, crate::db::UserDb>,
    canonical_name: String,
    locale: String,
) -> Result<SpeciesDetail, String> {
    let plant_db = plant_db.inner().clone();
    let user_db = user_db.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::Catalog,
            "species detail",
            move || {
                crate::services::plant_browser::get_species_detail(
                    &plant_db,
                    &user_db,
                    canonical_name,
                    locale,
                )
            },
        )
        .await
}

/// Batch lookup: returns common names for a list of canonical names in the given locale.
#[tauri::command]
pub async fn get_common_names(
    executor: State<'_, crate::native_operation::NativeOperationExecutor>,
    plant_db: State<'_, crate::db::PlantDb>,
    canonical_names: Vec<String>,
    locale: String,
) -> Result<std::collections::HashMap<String, String>, String> {
    let plant_db = plant_db.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::Catalog,
            "species common name batch",
            move || {
                crate::services::species_catalog::get_common_names(
                    &plant_db,
                    canonical_names,
                    locale,
                )
            },
        )
        .await
}

/// Batch lookup: returns the catalog habit (e.g. `Tree`) for each canonical name that has one.
#[tauri::command]
pub async fn get_species_habits(
    executor: State<'_, crate::native_operation::NativeOperationExecutor>,
    plant_db: State<'_, crate::db::PlantDb>,
    canonical_names: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let plant_db = plant_db.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::Catalog,
            "species habit batch",
            move || {
                crate::services::species_catalog::get_species_habits(&plant_db, canonical_names)
            },
        )
        .await
}

/// Batch-fetch detail records for multiple species by canonical name.
/// Used for canvas species metadata hydration — one IPC call for all placed plants.
#[tauri::command]
pub async fn get_species_batch(
    executor: State<'_, crate::native_operation::NativeOperationExecutor>,
    plant_db: State<'_, crate::db::PlantDb>,
    canonical_names: Vec<String>,
    locale: String,
) -> Result<Vec<SpeciesDetail>, String> {
    get_species_batch_with_executor(
        executor.inner(),
        plant_db.inner().clone(),
        canonical_names,
        locale,
    )
    .await
}

async fn get_species_batch_with_executor(
    executor: &crate::native_operation::NativeOperationExecutor,
    plant_db: crate::db::PlantDb,
    canonical_names: Vec<String>,
    locale: String,
) -> Result<Vec<SpeciesDetail>, String> {
    executor
        .run(
            crate::native_operation::NativeOperationClass::Catalog,
            "species detail batch",
            move || {
                crate::services::species_catalog::get_species_batch(
                    &plant_db,
                    canonical_names,
                    locale,
                )
            },
        )
        .await
}

#[tauri::command]
pub async fn get_flower_color_batch(
    executor: State<'_, crate::native_operation::NativeOperationExecutor>,
    plant_db: State<'_, crate::db::PlantDb>,
    canonical_names: Vec<String>,
) -> Result<Vec<FlowerColorResolution>, String> {
    let plant_db = plant_db.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::Catalog,
            "species flower color batch",
            move || {
                crate::services::species_catalog::get_flower_color_batch(&plant_db, canonical_names)
            },
        )
        .await
}

/// Returns all distinct values for populating filter UI dropdowns.
#[tauri::command]
pub async fn get_filter_options(
    executor: State<'_, crate::native_operation::NativeOperationExecutor>,
    plant_db: State<'_, crate::db::PlantDb>,
) -> Result<FilterOptions, String> {
    let plant_db = plant_db.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::Catalog,
            "species filter options",
            move || crate::services::species_catalog::get_filter_options(&plant_db),
        )
        .await
}

/// Returns dynamic filter options (distinct values, ranges) for requested fields.
#[tauri::command]
pub async fn get_dynamic_filter_options(
    executor: State<'_, crate::native_operation::NativeOperationExecutor>,
    plant_db: State<'_, crate::db::PlantDb>,
    fields: Vec<String>,
    locale: String,
) -> Result<Vec<DynamicFilterOptions>, String> {
    let plant_db = plant_db.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::Catalog,
            "species dynamic filter options",
            move || {
                crate::services::species_catalog::get_dynamic_filter_options(
                    &plant_db, fields, locale,
                )
            },
        )
        .await
}

/// Returns images for a species by canonical name.
#[tauri::command]
pub async fn get_species_images(
    executor: State<'_, crate::native_operation::NativeOperationExecutor>,
    plant_db: State<'_, crate::db::PlantDb>,
    canonical_name: String,
) -> Result<Vec<SpeciesImage>, String> {
    let plant_db = plant_db.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::Catalog,
            "species image metadata",
            move || crate::services::species_catalog::get_species_images(&plant_db, canonical_name),
        )
        .await
}

/// Returns all common names for a species in the given locale.
#[tauri::command]
pub async fn get_locale_common_names(
    executor: State<'_, crate::native_operation::NativeOperationExecutor>,
    plant_db: State<'_, crate::db::PlantDb>,
    canonical_name: String,
    locale: String,
) -> Result<Vec<CommonNameEntry>, String> {
    let plant_db = plant_db.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::Catalog,
            "species locale common names",
            move || {
                crate::services::species_catalog::get_locale_common_names(
                    &plant_db,
                    canonical_name,
                    locale,
                )
            },
        )
        .await
}

#[tauri::command]
pub async fn get_cached_image_path(
    cache: State<'_, crate::image_cache::ImageCache>,
    executor: State<'_, crate::native_operation::NativeOperationExecutor>,
    url: String,
) -> Result<String, String> {
    let cache = cache.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::Network,
            "image cache fetch",
            move || {
                cache
                    .fetch_and_cache(&url)
                    .map(|path| path.to_string_lossy().to_string())
                    .map_err(|error| error.to_string())
            },
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::get_species_batch_with_executor;
    use crate::{
        db::PlantDb,
        native_operation::{
            NativeOperationClass, NativeOperationClassLimits, NativeOperationExecutor,
            NativeOperationLimits,
        },
    };
    use std::{
        future::Future,
        sync::mpsc,
        task::{Context, Poll, Waker},
        time::Duration,
    };

    const WAIT_TIMEOUT: Duration = Duration::from_secs(2);

    fn catalog_test_executor(admitted: usize, running: usize) -> NativeOperationExecutor {
        let limits = NativeOperationClassLimits::new(admitted, running);
        NativeOperationExecutor::new(NativeOperationLimits::new(
            limits, limits, limits, limits, limits,
        ))
        .unwrap()
    }

    #[test]
    fn queued_species_batch_yields_until_catalog_capacity_is_available() {
        tauri::async_runtime::block_on(async {
            let executor = catalog_test_executor(2, 1);
            let (started_tx, started_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::sync_channel(1);
            let blocking_executor = executor.clone();
            let blocker = tauri::async_runtime::spawn(async move {
                blocking_executor
                    .run(
                        NativeOperationClass::Catalog,
                        "test catalog blocker",
                        move || {
                            started_tx.send(()).unwrap();
                            release_rx.recv().unwrap();
                            Ok(())
                        },
                    )
                    .await
            });
            started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

            let mut batch = Box::pin(get_species_batch_with_executor(
                &executor,
                crate::services::species_catalog_read::test_support::test_plant_db(),
                vec!["Missing species".to_owned()],
                "fr".to_owned(),
            ));
            {
                let mut context = Context::from_waker(Waker::noop());
                assert!(matches!(batch.as_mut().poll(&mut context), Poll::Pending));
            }

            release_tx.send(()).unwrap();
            blocker.await.unwrap().unwrap();
            let details = batch.await.unwrap();
            assert!(details.is_empty());
        });
    }

    #[test]
    fn busy_species_batch_is_distinct_from_catalog_unavailable() {
        tauri::async_runtime::block_on(async {
            let executor = catalog_test_executor(1, 1);
            let (started_tx, started_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::sync_channel(1);
            let blocking_executor = executor.clone();
            let blocker = tauri::async_runtime::spawn(async move {
                blocking_executor
                    .run(
                        NativeOperationClass::Catalog,
                        "test catalog blocker",
                        move || {
                            started_tx.send(()).unwrap();
                            release_rx.recv().unwrap();
                            Ok(())
                        },
                    )
                    .await
            });
            started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

            let error = get_species_batch_with_executor(
                &executor,
                PlantDb::corrupt(),
                vec!["Apple".to_owned()],
                "en".to_owned(),
            )
            .await
            .unwrap_err();

            assert_eq!(error, "Native catalog operations are busy; try again");
            release_tx.send(()).unwrap();
            blocker.await.unwrap().unwrap();

            let unavailable = get_species_batch_with_executor(
                &executor,
                PlantDb::corrupt(),
                vec!["Apple".to_owned()],
                "en".to_owned(),
            )
            .await
            .unwrap_err();
            assert!(unavailable.contains("Plant database unavailable"));
        });
    }
}
