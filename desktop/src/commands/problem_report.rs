//! The problem report commands (2.1-Q276): write one report zip into the "Problem reports"
//! folder of Canopi's local data folder, and show a saved report again by its file name. Both
//! settle as `Failure` (2.1-M420), naming a path only as `UserPath`'s placeholder.

use crate::{
    AppHealth,
    db::UserDb,
    native_operation::{NativeOperationClass, NativeOperationExecutor},
    services::lidar::LidarLibrary,
    services::problem_report::{CREATE_OP, ProblemReportContext, SHOW_OP},
};
use canopi_types::failure::{Failure, FailureCode, Lane};
use canopi_types::support::{ProblemReportRequest, ProblemReportResult};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

/// The settings read the report's settings summary comes from.
const SETTINGS_READ_OP: &str = "problem_report.read_settings";

#[tauri::command]
pub async fn create_problem_report(
    app: AppHandle,
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    health: State<'_, AppHealth>,
    library: State<'_, LidarLibrary>,
    request: ProblemReportRequest,
) -> Result<ProblemReportResult, Failure> {
    let app_data_dir = app.path().app_data_dir().ok();
    let reports_folder = reports_folder(&app, CREATE_OP)?;
    let timestamp_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let user_db = user_db.inner().clone();
    let settings = executor
        .run_typed(
            NativeOperationClass::UserData,
            SETTINGS_READ_OP,
            move || Ok::<_, Failure>(crate::services::settings::get_settings(&user_db)),
        )
        .await?;
    let context = ProblemReportContext {
        reports_folder,
        log_dir: app.path().app_log_dir().ok(),
        app_data_dir,
        timestamp_secs,
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        target: format!("{}/{}", std::env::consts::OS, std::env::consts::ARCH),
        webview_version: tauri::webview_version().ok(),
        settings,
        health: crate::services::health::get_health(&health),
        settlements: crate::logging::recent_failures(),
        library: Err(String::new()),
        library_disk_bytes: Err(String::new()),
    };
    create_problem_report_with_executor(
        executor.inner(),
        request,
        context,
        Some(library.inner().clone()),
    )
    .await
}

/// Gather the Data library's sections and write the report, on the local lane: refused at once,
/// with no output, when the lane is busy.
async fn create_problem_report_with_executor(
    executor: &NativeOperationExecutor,
    request: ProblemReportRequest,
    mut context: ProblemReportContext,
    library: Option<LidarLibrary>,
) -> Result<ProblemReportResult, Failure> {
    executor
        .run_typed(NativeOperationClass::Local, CREATE_OP, move || {
            if let Some(library) = library {
                context.library = library.library_snapshot();
                context.library_disk_bytes = library.disk_usage();
            }
            crate::services::problem_report::create_problem_report(&request, &context)
                .inspect_err(|failure| crate::logging::log_failure(failure, Some(Lane::Local)))
        })
        .await
}

/// Show `file_name`, a saved report, selected in the "Problem reports" folder.
#[tauri::command]
pub async fn show_problem_report_folder(
    app: AppHandle,
    executor: State<'_, NativeOperationExecutor>,
    file_name: String,
) -> Result<(), Failure> {
    let reports_folder = reports_folder(&app, SHOW_OP)?;
    executor
        .run_typed(NativeOperationClass::Local, SHOW_OP, move || {
            let revealer = crate::services::folder_reveal::SystemFolderRevealer;
            crate::services::problem_report::show_problem_report(
                &file_name,
                &reports_folder,
                &revealer,
            )
            .inspect_err(|failure| crate::logging::log_failure(failure, Some(Lane::Local)))
        })
        .await
}

/// The "Problem reports" folder inside Canopi's local data folder (2.1-Q276): never the Desktop,
/// which a cloud sync may upload before the user decides to share a report.
fn reports_folder<R: tauri::Runtime>(
    app: &AppHandle<R>,
    op: &'static str,
) -> Result<PathBuf, Failure> {
    app.path()
        .app_data_dir()
        .map(|app_data_dir| crate::services::app_folders::problem_reports_folder(&app_data_dir))
        .map_err(|_| {
            Failure::new(FailureCode::Internal, op)
                .with_english("Canopi's local data folder could not be resolved")
        })
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
    use canopi_types::failure::{FailureCode, Lane};
    use canopi_types::support::ProblemReportRequest;
    use std::{sync::mpsc, time::Duration};

    const WAIT_TIMEOUT: Duration = Duration::from_secs(2);

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

            let scratch = TestScratch::new("problem-report-command");
            let reports_folder = scratch.join("Problem reports");
            let failure = create_problem_report_with_executor(
                &executor,
                ProblemReportRequest {
                    sections: Vec::new(),
                    current_design: None,
                },
                ProblemReportContext {
                    reports_folder: reports_folder.clone(),
                    log_dir: None,
                    app_data_dir: None,
                    timestamp_secs: 1_801_440_000,
                    app_version: "test".to_owned(),
                    target: "test/test".to_owned(),
                    webview_version: None,
                    settings: Err(String::new()),
                    health: crate::services::health::all_ready(),
                    settlements: Vec::new(),
                    library: Err(String::new()),
                    library_disk_bytes: Err(String::new()),
                },
                None,
            )
            .await
            .unwrap_err();

            assert_eq!(failure.code, FailureCode::Busy { lane: Lane::Local });
            assert!(!reports_folder.exists());
            release_tx.send(()).unwrap();
            blocker.await.unwrap().unwrap();
        });
    }

    /// The report folder is "Problem reports" in Canopi's local data folder (2.1-Q276), never the
    /// Desktop, which a cloud sync may upload before the user decides to share the report.
    #[test]
    fn canopi_f47t_52_168_a_report_is_written_under_the_chosen_report_folder() {
        use tauri::Manager as _;
        let app = tauri::test::mock_app();
        let root = super::reports_folder(app.handle(), super::CREATE_OP)
            .expect("a report folder resolves");
        let app_data_dir = app.path().app_data_dir().unwrap();
        assert_eq!(root, app_data_dir.join("Problem reports"));
        if let Ok(desktop) = app.path().desktop_dir() {
            assert!(
                !root.starts_with(&desktop) || app_data_dir.starts_with(&desktop),
                "{}",
                root.display()
            );
        }
    }
}
