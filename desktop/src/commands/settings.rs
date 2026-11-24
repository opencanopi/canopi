use crate::{
    db::UserDb,
    native_operation::{NativeOperationClass, NativeOperationExecutor},
};
use canopi_types::{
    failure::{Failure, FailureCode, ops},
    health::StoreId,
    settings::Settings,
};
use tauri::State;

/// Keys readable through the opaque settings-row command (Stage 2 E1, ADR 0024, 2.1-M206).
const ALLOWED_READ_SETTING_KEYS: &[&str] = &["settings", "updater.check_at_launch"];
/// Only the updater launch-check key is writable through the opaque settings-row command (2.1-M206):
/// the `"settings"` record must go through `set_settings` validation and set-aside.
const UPDATER_CHECK_AT_LAUNCH_KEY: &str = "updater.check_at_launch";

#[tauri::command]
pub async fn get_settings(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
) -> Result<Settings, String> {
    get_settings_with_executor(executor.inner(), user_db.inner().clone()).await
}

#[tauri::command]
pub async fn set_settings(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    settings: Settings,
) -> Result<(), String> {
    set_settings_with_executor(executor.inner(), user_db.inner().clone(), settings).await
}

/// Reads an opaque string row from the `settings` key-value table (Stage 2 E1, ADR 0024).
#[tauri::command]
pub async fn get_setting_row(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    key: String,
) -> Result<Option<String>, Failure> {
    get_setting_row_with_executor(executor.inner(), user_db.inner().clone(), key).await
}

/// Writes an opaque string row to the `settings` key-value table, refusing when settings are
/// read-only (Stage 2 E1, ADR 0024, 2.1-M487).
#[tauri::command]
pub async fn set_setting_row(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    key: String,
    value: String,
) -> Result<(), Failure> {
    set_setting_row_with_executor(executor.inner(), user_db.inner().clone(), key, value).await
}

async fn get_setting_row_with_executor(
    executor: &NativeOperationExecutor,
    user_db: UserDb,
    key: String,
) -> Result<Option<String>, Failure> {
    if !ALLOWED_READ_SETTING_KEYS.contains(&key.as_str()) {
        return Err(Failure::new(FailureCode::Invalid, ops::SETTINGS_GET_ROW)
            .with_english("the requested setting row key is not allowlisted"));
    }
    executor
        .run_typed(
            NativeOperationClass::UserData,
            ops::SETTINGS_GET_ROW,
            move || {
                let conn = user_db.acquire();
                crate::db::user_db::get_setting(&conn, &key).map_err(|_| {
                    Failure::new(FailureCode::Internal, ops::SETTINGS_GET_ROW)
                        .with_english("the setting row could not be read")
                })
            },
        )
        .await
}

async fn set_setting_row_with_executor(
    executor: &NativeOperationExecutor,
    user_db: UserDb,
    key: String,
    value: String,
) -> Result<(), Failure> {
    if key != UPDATER_CHECK_AT_LAUNCH_KEY || (value != "true" && value != "false") {
        return Err(Failure::new(FailureCode::Invalid, ops::SETTINGS_SET_ROW)
            .with_english("only updater.check_at_launch boolean values may be written"));
    }
    executor
        .run_typed(
            NativeOperationClass::UserData,
            ops::SETTINGS_SET_ROW,
            move || {
                if crate::services::settings::record_is_newer(&user_db) {
                    return Err(Failure::new(
                        FailureCode::StoreReadOnly {
                            store: StoreId::Settings,
                        },
                        ops::SETTINGS_SET_ROW,
                    )
                    .with_english("the settings refuse writes for this session"));
                }
                let conn = user_db.acquire_writable().ok_or_else(|| {
                    Failure::new(
                        FailureCode::StoreReadOnly {
                            store: StoreId::Settings,
                        },
                        ops::SETTINGS_SET_ROW,
                    )
                    .with_english("the settings refuse writes for this session")
                })?;
                crate::db::user_db::set_setting(&conn, &key, &value).map_err(|_| {
                    Failure::new(FailureCode::Internal, ops::SETTINGS_SET_ROW)
                        .with_english("the setting row could not be written")
                })
            },
        )
        .await
}

async fn get_settings_with_executor(
    executor: &NativeOperationExecutor,
    user_db: UserDb,
) -> Result<Settings, String> {
    executor
        .run(NativeOperationClass::UserData, "settings read", move || {
            crate::services::settings::get_settings(&user_db)
        })
        .await
}

async fn set_settings_with_executor(
    executor: &NativeOperationExecutor,
    user_db: UserDb,
    settings: Settings,
) -> Result<(), String> {
    executor
        .run(
            NativeOperationClass::UserData,
            "settings write",
            move || crate::services::settings::set_settings(&user_db, settings),
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::{get_settings_with_executor, set_settings_with_executor};
    use crate::{
        db::UserDb,
        native_operation::{
            NativeOperationClass, NativeOperationClassLimits, NativeOperationExecutor,
            NativeOperationLimits,
        },
    };
    use canopi_types::settings::{Locale, Settings};
    use std::{
        future::Future,
        sync::mpsc,
        task::{Context, Poll, Waker},
        time::Duration,
    };

    const WAIT_TIMEOUT: Duration = Duration::from_secs(2);

    fn test_user_db() -> UserDb {
        UserDb::initialize(rusqlite::Connection::open_in_memory().unwrap()).unwrap()
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

            let mut settings_read = Box::pin(get_settings_with_executor(&executor, test_user_db()));
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
            assert_eq!(settings_read.await.unwrap().locale, Locale::En);
        });
    }

    #[test]
    fn busy_settings_write_rejects_without_mutating_persisted_settings() {
        tauri::async_runtime::block_on(async {
            let executor = user_data_test_executor(1, 1);
            let user_db = test_user_db();
            let initial = Settings {
                locale: Locale::Fr,
                ..Settings::default()
            };
            crate::services::settings::set_settings(&user_db, initial).unwrap();

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

            let replacement = Settings {
                locale: Locale::De,
                ..Settings::default()
            };
            let error = set_settings_with_executor(&executor, user_db.clone(), replacement)
                .await
                .unwrap_err();

            assert_eq!(error, "Native user-data operations are busy; try again");
            assert_eq!(
                crate::services::settings::get_settings(&user_db)
                    .unwrap()
                    .locale,
                Locale::Fr
            );

            release_tx.send(()).unwrap();
            blocker.await.unwrap().unwrap();
        });
    }

    #[test]
    fn setting_row_reads_and_writes_opaque_values_and_refuses_under_newer_settings_record() {
        use super::{get_setting_row_with_executor, set_setting_row_with_executor};
        use canopi_types::{failure::FailureCode, health::StoreId};
        tauri::async_runtime::block_on(async {
            let executor = NativeOperationExecutor::production();
            let user_db = test_user_db();
            assert_eq!(
                get_setting_row_with_executor(
                    &executor,
                    user_db.clone(),
                    "updater.check_at_launch".to_owned(),
                )
                .await
                .unwrap(),
                None
            );
            set_setting_row_with_executor(
                &executor,
                user_db.clone(),
                "updater.check_at_launch".to_owned(),
                "false".to_owned(),
            )
            .await
            .unwrap();
            assert_eq!(
                get_setting_row_with_executor(
                    &executor,
                    user_db.clone(),
                    "updater.check_at_launch".to_owned(),
                )
                .await
                .unwrap(),
                Some("false".to_owned())
            );

            // Under settings record 2, raw row writes are refused with StoreReadOnly{Settings}
            // while reads still return the raw JSON row for TS parsing (Stage 2 E1, 2.1-M480).
            let record = r#"{"version":2,"check_updates_at_launch":false}"#;
            crate::db::user_db::set_setting(&user_db.acquire(), "settings", record).unwrap();
            assert_eq!(
                get_setting_row_with_executor(&executor, user_db.clone(), "settings".to_owned(),)
                    .await
                    .unwrap(),
                Some(record.to_owned())
            );
            let refused = set_setting_row_with_executor(
                &executor,
                user_db.clone(),
                "updater.check_at_launch".to_owned(),
                "true".to_owned(),
            )
            .await
            .unwrap_err();
            assert_eq!(
                refused.code,
                FailureCode::StoreReadOnly {
                    store: StoreId::Settings
                }
            );
            assert_eq!(refused.op, canopi_types::failure::ops::SETTINGS_SET_ROW);
        });
    }

    #[test]
    fn setting_row_refuses_non_allowlisted_keys_and_non_boolean_values() {
        use super::{get_setting_row_with_executor, set_setting_row_with_executor};
        use canopi_types::failure::{FailureCode, ops};
        tauri::async_runtime::block_on(async {
            let executor = NativeOperationExecutor::production();
            let user_db = test_user_db();

            // Writing directly to "settings" or "settings.set-aside" is refused (2.1-M206).
            for forbidden_key in ["settings", "settings.set-aside", "arbitrary.key"] {
                let err = set_setting_row_with_executor(
                    &executor,
                    user_db.clone(),
                    forbidden_key.to_owned(),
                    "true".to_owned(),
                )
                .await
                .unwrap_err();
                assert_eq!(err.code, FailureCode::Invalid);
                assert_eq!(err.op, ops::SETTINGS_SET_ROW);
            }

            // Non-boolean values for updater.check_at_launch are refused.
            let bad_val = set_setting_row_with_executor(
                &executor,
                user_db.clone(),
                "updater.check_at_launch".to_owned(),
                "yes".to_owned(),
            )
            .await
            .unwrap_err();
            assert_eq!(bad_val.code, FailureCode::Invalid);
            assert_eq!(bad_val.op, ops::SETTINGS_SET_ROW);

            // Reading non-allowlisted keys is refused.
            let bad_read = get_setting_row_with_executor(
                &executor,
                user_db.clone(),
                "settings.set-aside".to_owned(),
            )
            .await
            .unwrap_err();
            assert_eq!(bad_read.code, FailureCode::Invalid);
            assert_eq!(bad_read.op, ops::SETTINGS_GET_ROW);
        });
    }
}
