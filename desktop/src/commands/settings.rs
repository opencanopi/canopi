use crate::{
    db::UserDb,
    native_operation::{NativeOperationClass, NativeOperationExecutor},
};
use canopi_types::settings::Settings;
use tauri::State;

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
}
