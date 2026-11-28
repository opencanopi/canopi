use crate::{
    native_operation::{NativeOperationClass, NativeOperationExecutor},
    services::settings::{DesktopSettingsStore, SettingsRecordSnapshot, SettingsWriteError},
};
use canopi_types::{
    failure::{Failure, FailureCode, ops},
    health::StoreId,
};
use serde_json::{Map, Value};
use tauri::State;

/// Reads the Desktop settings record 2 snapshot (`settings.json`, migrating once from SQLite
/// when absent; `2e-2`, ADR 0024, ADR 0026).
#[tauri::command]
pub async fn get_settings_record(
    executor: State<'_, NativeOperationExecutor>,
    settings_store: State<'_, DesktopSettingsStore>,
) -> Result<SettingsRecordSnapshot, Failure> {
    get_settings_record_with_executor(executor.inner(), settings_store.inner().clone()).await
}

/// Merges `patch` into Desktop `settings.json` (preserving untouched fields and unknown keys),
/// refusing with `StoreReadOnly { store: StoreId::Settings }` when newer-read-only (`2e-2`).
#[tauri::command]
pub async fn patch_settings_record(
    executor: State<'_, NativeOperationExecutor>,
    settings_store: State<'_, DesktopSettingsStore>,
    patch: Map<String, Value>,
) -> Result<(), Failure> {
    patch_settings_record_with_executor(executor.inner(), settings_store.inner().clone(), patch)
        .await
}

async fn get_settings_record_with_executor(
    executor: &NativeOperationExecutor,
    settings_store: DesktopSettingsStore,
) -> Result<SettingsRecordSnapshot, Failure> {
    executor
        .run_typed(
            NativeOperationClass::UserData,
            ops::SETTINGS_GET_RECORD,
            move || {
                settings_store.get_settings_record().map_err(|_| {
                    Failure::new(FailureCode::Internal, ops::SETTINGS_GET_RECORD)
                        .with_english("the settings record could not be read")
                })
            },
        )
        .await
}

async fn patch_settings_record_with_executor(
    executor: &NativeOperationExecutor,
    settings_store: DesktopSettingsStore,
    patch: Map<String, Value>,
) -> Result<(), Failure> {
    executor
        .run_typed(
            NativeOperationClass::UserData,
            ops::SETTINGS_PATCH_RECORD,
            move || {
                settings_store
                    .patch_settings_record(patch)
                    .map_err(|err| match err {
                        SettingsWriteError::ReadOnly => Failure::new(
                            FailureCode::StoreReadOnly {
                                store: StoreId::Settings,
                            },
                            ops::SETTINGS_PATCH_RECORD,
                        )
                        .with_english("the settings refuse writes for this session"),
                        SettingsWriteError::Failed(_) => {
                            Failure::new(FailureCode::Internal, ops::SETTINGS_PATCH_RECORD)
                                .with_english("the settings record could not be written")
                        }
                    })
            },
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::{get_settings_record_with_executor, patch_settings_record_with_executor};
    use crate::{
        db::UserDb,
        native_operation::{
            NativeOperationClass, NativeOperationClassLimits, NativeOperationExecutor,
            NativeOperationLimits,
        },
        services::settings::DesktopSettingsStore,
        test_scratch::TestScratch,
    };
    use canopi_types::{
        failure::{FailureCode, Lane, ops},
        health::StoreId,
    };
    use serde_json::{Map, Value};
    use std::{
        future::Future,
        sync::mpsc,
        task::{Context, Poll, Waker},
        time::Duration,
    };

    const WAIT_TIMEOUT: Duration = Duration::from_secs(2);

    fn test_store(name: &str) -> (TestScratch, DesktopSettingsStore) {
        let scratch = TestScratch::new(name);
        let user_db = UserDb::initialize(rusqlite::Connection::open_in_memory().unwrap()).unwrap();
        let store = DesktopSettingsStore::new(scratch.path(), user_db);
        (scratch, store)
    }

    fn user_data_test_executor(admitted: usize, running: usize) -> NativeOperationExecutor {
        let limits = NativeOperationClassLimits::new(admitted, running);
        NativeOperationExecutor::new(NativeOperationLimits::new(
            limits, limits, limits, limits, limits,
        ))
        .unwrap()
    }

    #[test]
    fn queued_settings_read_yields_without_blocking_an_unrelated_class() {
        tauri::async_runtime::block_on(async {
            let executor = user_data_test_executor(2, 1);
            let (_scratch, store) = test_store("cmd-settings-queued");
            let (started_tx, started_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::sync_channel(1);
            let blocking_executor = executor.clone();
            let blocker = tauri::async_runtime::spawn(async move {
                blocking_executor
                    .run(
                        NativeOperationClass::UserData,
                        "test user data blocker",
                        move || {
                            started_tx.send(()).unwrap();
                            release_rx.recv().unwrap();
                            Ok(())
                        },
                    )
                    .await
            });
            started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

            let mut settings_read = Box::pin(get_settings_record_with_executor(&executor, store));
            {
                let mut context = Context::from_waker(Waker::noop());
                assert!(matches!(
                    settings_read.as_mut().poll(&mut context),
                    Poll::Pending
                ));
            }

            let unrelated = executor
                .run(NativeOperationClass::Local, "test unrelated local", || {
                    Ok(42)
                })
                .await
                .unwrap();
            assert_eq!(unrelated, 42);

            release_tx.send(()).unwrap();
            blocker.await.unwrap().unwrap();
            assert_eq!(settings_read.await.unwrap().record["version"], 2);
        });
    }

    #[test]
    fn busy_settings_write_rejects_without_mutating_persisted_settings() {
        tauri::async_runtime::block_on(async {
            let executor = user_data_test_executor(1, 1);
            let (_scratch, store) = test_store("cmd-settings-busy");
            let mut initial = Map::new();
            initial.insert("locale".to_owned(), Value::String("fr".to_owned()));
            store.patch_settings_record(initial).unwrap();

            let (started_tx, started_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::sync_channel(1);
            let blocking_executor = executor.clone();
            let blocker = tauri::async_runtime::spawn(async move {
                blocking_executor
                    .run(
                        NativeOperationClass::UserData,
                        "test user data blocker",
                        move || {
                            started_tx.send(()).unwrap();
                            release_rx.recv().unwrap();
                            Ok(())
                        },
                    )
                    .await
            });
            started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

            let mut replacement = Map::new();
            replacement.insert("locale".to_owned(), Value::String("de".to_owned()));
            let error = patch_settings_record_with_executor(&executor, store.clone(), replacement)
                .await
                .unwrap_err();

            assert_eq!(
                error.code,
                FailureCode::Busy {
                    lane: Lane::UserData
                }
            );
            assert_eq!(store.get_settings_record().unwrap().record["locale"], "fr");

            release_tx.send(()).unwrap();
            blocker.await.unwrap().unwrap();
        });
    }

    #[test]
    fn settings_record_commands_round_trip_and_refuse_newer_v3_with_store_read_only() {
        tauri::async_runtime::block_on(async {
            let executor = NativeOperationExecutor::production();
            let (_scratch, store) = test_store("cmd-settings-record");

            let initial = get_settings_record_with_executor(&executor, store.clone())
                .await
                .unwrap();
            assert_eq!(initial.record["version"], 2);
            assert!(!initial.newer_read_only);

            let mut patch = Map::new();
            patch.insert(
                "unit_system".to_owned(),
                Value::String("us_customary".to_owned()),
            );
            patch.insert("launch_check".to_owned(), Value::Bool(false));
            patch.insert(
                "last_open_home".to_owned(),
                Value::String("draft:home-1".to_owned()),
            );
            patch_settings_record_with_executor(&executor, store.clone(), patch)
                .await
                .unwrap();

            let after = get_settings_record_with_executor(&executor, store.clone())
                .await
                .unwrap();
            assert_eq!(after.record["unit_system"], "us_customary");
            assert_eq!(after.record["launch_check"], false);
            assert_eq!(after.record["last_open_home"], "draft:home-1");

            // Newer v3 record refuses patch writes with StoreReadOnly { Settings }.
            std::fs::write(store.settings_path(), r#"{"version":3,"theme":"dark"}"#).unwrap();
            let mut blocked = Map::new();
            blocked.insert("theme".to_owned(), Value::String("light".to_owned()));
            let err = patch_settings_record_with_executor(&executor, store, blocked)
                .await
                .unwrap_err();
            assert_eq!(
                err.code,
                FailureCode::StoreReadOnly {
                    store: StoreId::Settings
                }
            );
            assert_eq!(err.op, ops::SETTINGS_PATCH_RECORD);
        });
    }
}
