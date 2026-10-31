use crate::{
    AppHealth,
    db::UserDb,
    native_operation::{NativeOperationClass, NativeOperationExecutor},
};
use common_types::support::{ProblemReportRequest, ProblemReportResult};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub async fn create_problem_report(
    app: AppHandle,
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    health: State<'_, AppHealth>,
    request: ProblemReportRequest,
) -> Result<ProblemReportResult, String> {
    let output_root = report_output_root(&app)?;
    let app_data_dir = app.path().app_data_dir().ok();
    let log_dir = app.path().app_log_dir().ok();
    let timestamp_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let health = crate::services::health::get_health(&health);
    let (settings, settings_error) =
        read_problem_report_settings(executor.inner(), user_db.inner().clone()).await?;

    create_problem_report_with_executor(
        executor.inner(),
        request,
        crate::services::problem_report::ProblemReportContext {
            output_root,
            log_dir,
            app_data_dir,
            timestamp_secs,
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            target: format!("{}/{}", std::env::consts::OS, std::env::consts::ARCH),
            webview_version: tauri::webview_version().ok(),
            settings,
            settings_error,
            health,
        },
    )
    .await
}

async fn read_problem_report_settings(
    executor: &NativeOperationExecutor,
    user_db: UserDb,
) -> Result<(Option<common_types::settings::Settings>, Option<String>), String> {
    executor
        .run(
            NativeOperationClass::UserData,
            "problem report settings read",
            move || {
                Ok(match crate::services::settings::get_settings(&user_db) {
                    Ok(settings) => (Some(settings), None),
                    Err(error) => (None, Some(error)),
                })
            },
        )
        .await
}

async fn create_problem_report_with_executor(
    executor: &NativeOperationExecutor,
    request: ProblemReportRequest,
    context: crate::services::problem_report::ProblemReportContext,
) -> Result<ProblemReportResult, String> {
    executor
        .run(
            NativeOperationClass::Local,
            "problem report creation",
            move || crate::services::problem_report::create_problem_report(&request, context),
        )
        .await
}

#[tauri::command]
pub async fn show_problem_report_folder(
    app: AppHandle,
    executor: State<'_, NativeOperationExecutor>,
    path: String,
) -> Result<(), String> {
    let output_root = report_output_root(&app)?;
    executor
        .run(
            NativeOperationClass::Local,
            "problem report folder reveal",
            move || {
                let revealer = crate::services::folder_reveal::SystemFolderRevealer;
                crate::services::problem_report::show_problem_report_folder(
                    Path::new(&path),
                    &output_root,
                    &revealer,
                )
            },
        )
        .await
}

fn report_output_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(desktop_dir) = app.path().desktop_dir() {
        return Ok(desktop_dir);
    }

    app.path()
        .app_data_dir()
        .map(|path| path.join("Problem Reports"))
        .map_err(|error| format!("Failed to resolve a report output folder: {error}"))
}

#[cfg(test)]
mod tests {
    use super::create_problem_report_with_executor;
    use crate::test_scratch::TestScratch;
    use crate::{
        native_operation::{
            NativeOperationClass, NativeOperationClassLimits, NativeOperationExecutor,
            NativeOperationLimits,
        },
        services::problem_report::ProblemReportContext,
    };
    use common_types::{
        health::{LidarLibraryStatus, PlantDbStatus, SubsystemHealth},
        support::{ProblemReportRequest, ProblemReportSensitiveAttachments},
    };
    use std::{sync::mpsc, time::Duration};

    const WAIT_TIMEOUT: Duration = Duration::from_secs(2);

    struct TempReportRoot {
        root: TestScratch,
    }

    impl TempReportRoot {
        fn new() -> Self {
            Self {
                root: TestScratch::new("problem-report-command"),
            }
        }
    }

    fn local_test_executor() -> NativeOperationExecutor {
        let limits = NativeOperationClassLimits::new(1, 1);
        NativeOperationExecutor::new(NativeOperationLimits::new(
            limits, limits, limits, limits, limits,
        ))
        .unwrap()
    }

    #[test]
    fn busy_problem_report_rejects_before_publishing_a_folder() {
        tauri::async_runtime::block_on(async {
            let executor = local_test_executor();
            let (started_tx, started_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::sync_channel(1);
            let blocking_executor = executor.clone();
            let blocker = tauri::async_runtime::spawn(async move {
                blocking_executor
                    .run(
                        NativeOperationClass::Local,
                        "test report blocker",
                        move || {
                            started_tx.send(()).unwrap();
                            release_rx.recv().unwrap();
                            Ok(())
                        },
                    )
                    .await
            });
            started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

            let temp = TempReportRoot::new();
            let output_root = temp.root.join("reports");
            let error = create_problem_report_with_executor(
                &executor,
                ProblemReportRequest {
                    description: "must not be published".to_owned(),
                    frontend_diagnostics: Vec::new(),
                    sensitive_attachments: ProblemReportSensitiveAttachments::default(),
                },
                ProblemReportContext {
                    output_root: output_root.clone(),
                    log_dir: None,
                    app_data_dir: None,
                    timestamp_secs: 1_801_440_000,
                    app_version: "test".to_owned(),
                    target: "test/test".to_owned(),
                    webview_version: None,
                    settings: None,
                    settings_error: None,
                    health: SubsystemHealth {
                        plant_db: PlantDbStatus::Available,
                        lidar_library: LidarLibraryStatus::Ready,
                        local_data: common_types::health::LocalDataStatus::Current,
                    },
                },
            )
            .await
            .unwrap_err();

            assert_eq!(error, "Native local operations are busy; try again");
            assert!(!output_root.exists());
            release_tx.send(()).unwrap();
            blocker.await.unwrap().unwrap();
        });
    }
}
