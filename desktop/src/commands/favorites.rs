use crate::native_operation::{NativeOperationClass, NativeOperationExecutor};
use tauri::State;

#[tauri::command]
pub async fn toggle_favorite(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, crate::db::UserDb>,
    canonical_name: String,
) -> Result<bool, String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "favorite toggle",
            move || crate::services::plant_browser::toggle_favorite(&user_db, canonical_name),
        )
        .await
}

#[tauri::command]
pub async fn get_favorites(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, crate::db::UserDb>,
    plant_db: State<'_, crate::db::PlantDb>,
    locale: String,
) -> Result<Vec<canopi_types::species::SpeciesListItem>, String> {
    get_favorites_with_executor(
        executor.inner(),
        user_db.inner().clone(),
        plant_db.inner().clone(),
        locale,
    )
    .await
}

#[tauri::command]
pub async fn get_recently_viewed(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, crate::db::UserDb>,
    plant_db: State<'_, crate::db::PlantDb>,
    locale: String,
    limit: u32,
) -> Result<Vec<canopi_types::species::SpeciesListItem>, String> {
    get_recently_viewed_with_executor(
        executor.inner(),
        user_db.inner().clone(),
        plant_db.inner().clone(),
        locale,
        limit,
    )
    .await
}

async fn get_favorites_with_executor(
    executor: &NativeOperationExecutor,
    user_db: crate::db::UserDb,
    plant_db: crate::db::PlantDb,
    locale: String,
) -> Result<Vec<canopi_types::species::SpeciesListItem>, String> {
    let names_user_db = user_db.clone();
    let names = executor
        .run(
            NativeOperationClass::UserData,
            "favorites read",
            move || crate::services::plant_browser::get_favorite_names(&names_user_db),
        )
        .await?;
    if names.is_empty() {
        return Ok(Vec::new());
    }

    executor
        .run(
            NativeOperationClass::Catalog,
            "favorite species projection",
            move || {
                let mut items =
                    crate::services::plant_browser::project_personal_species_list_items(
                        &plant_db, names, locale,
                    )?;
                for item in &mut items {
                    item.is_favorite = true;
                }
                Ok(items)
            },
        )
        .await
}

async fn get_recently_viewed_with_executor(
    executor: &NativeOperationExecutor,
    user_db: crate::db::UserDb,
    plant_db: crate::db::PlantDb,
    locale: String,
    limit: u32,
) -> Result<Vec<canopi_types::species::SpeciesListItem>, String> {
    let names_user_db = user_db.clone();
    let names = executor
        .run(
            NativeOperationClass::UserData,
            "recently viewed read",
            move || {
                crate::services::plant_browser::get_recently_viewed_names(&names_user_db, limit)
            },
        )
        .await?;
    if names.is_empty() {
        return Ok(Vec::new());
    }

    let mut items = executor
        .run(
            NativeOperationClass::Catalog,
            "recently viewed species projection",
            move || {
                crate::services::plant_browser::project_personal_species_list_items(
                    &plant_db, names, locale,
                )
            },
        )
        .await?;
    if items.is_empty() {
        return Ok(items);
    }

    executor
        .run(
            NativeOperationClass::UserData,
            "recently viewed favorite hydration",
            move || {
                crate::services::plant_browser::hydrate_favorite_flags(&user_db, &mut items)?;
                Ok(items)
            },
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::get_favorites_with_executor;
    use crate::{
        db::UserDb,
        native_operation::{
            NativeOperationClass, NativeOperationClassLimits, NativeOperationExecutor,
            NativeOperationLimits,
        },
    };
    use std::{sync::mpsc, time::Duration};

    const WAIT_TIMEOUT: Duration = Duration::from_secs(2);

    fn test_user_db() -> UserDb {
        UserDb::initialize(rusqlite::Connection::open_in_memory().unwrap()).unwrap()
    }

    fn test_executor() -> NativeOperationExecutor {
        let limits = NativeOperationClassLimits::new(1, 1);
        NativeOperationExecutor::new(NativeOperationLimits::new(
            limits, limits, limits, limits, limits,
        ))
        .unwrap()
    }

    #[test]
    fn favorite_listing_reads_user_data_before_catalog_projection() {
        tauri::async_runtime::block_on(async {
            let executor = test_executor();
            let user_db = test_user_db();
            crate::services::plant_browser::toggle_favorite(&user_db, "Apple".to_owned()).unwrap();

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

            let plant_db = crate::services::species_catalog_read::test_support::test_plant_db();
            let error = get_favorites_with_executor(
                &executor,
                user_db.clone(),
                plant_db.clone(),
                "fr".to_owned(),
            )
            .await
            .unwrap_err();
            assert_eq!(error, "Native catalog operations are busy; try again");

            release_tx.send(()).unwrap();
            blocker.await.unwrap().unwrap();

            let favorites =
                get_favorites_with_executor(&executor, user_db, plant_db, "fr".to_owned())
                    .await
                    .unwrap();
            assert_eq!(favorites.len(), 1);
            assert_eq!(favorites[0].canonical_name, "Apple");
            assert!(favorites[0].is_favorite);
        });
    }
}
