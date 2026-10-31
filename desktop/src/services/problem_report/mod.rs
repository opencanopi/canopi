use common_types::health::SubsystemHealth;
use common_types::settings::Settings;
use common_types::support::{ProblemReportRequest, ProblemReportResult};
use std::path::{Path, PathBuf};

mod bundle;
mod folder_reveal;
mod redactions;
mod summary;
mod zip;

pub(crate) use folder_reveal::show_problem_report_folder;

use bundle::build_diagnostic_bundle;
use redactions::Redactions;
use summary::build_report_summary;

const SUMMARY_FILENAME: &str = "Report Summary.txt";
const BUNDLE_FILENAME: &str = "Diagnostic Bundle.zip";
const CURRENT_DESIGN_ATTACHMENT_FILENAME: &str = "current-design.canopi";

pub struct ProblemReportContext {
    pub output_root: PathBuf,
    pub log_dir: Option<PathBuf>,
    pub app_data_dir: Option<PathBuf>,
    pub timestamp_secs: u64,
    pub app_version: String,
    pub target: String,
    /// The webview's version, read by the shell (`tauri::webview_version`, 2.1-M82); `None` when it
    /// could not be read. A plain value, so this module names no tauri path.
    pub webview_version: Option<String>,
    pub settings: Option<Settings>,
    pub settings_error: Option<String>,
    pub health: SubsystemHealth,
}

pub fn create_problem_report(
    request: &ProblemReportRequest,
    context: ProblemReportContext,
) -> Result<ProblemReportResult, String> {
    create_problem_report_with_writer(request, context, |path, bytes| std::fs::write(path, bytes))
}

/// Create the report folder and its files. A failure after the folder exists
/// removes the folder, so no half-written report is left for the user to send.
fn create_problem_report_with_writer(
    request: &ProblemReportRequest,
    context: ProblemReportContext,
    write_file: impl Fn(&Path, &[u8]) -> std::io::Result<()>,
) -> Result<ProblemReportResult, String> {
    let timestamp_iso = crate::design::unix_to_iso8601(context.timestamp_secs);
    let folder_name = format!("Canopi Problem Report {}", folder_stamp(&timestamp_iso));
    let folder = create_unique_report_folder(&context.output_root, &folder_name)?;
    let redactions = Redactions::from_context(&context);

    let result = (|| {
        let summary = build_report_summary(request, &context, &timestamp_iso, &redactions);
        let summary_path = folder.join(SUMMARY_FILENAME);
        write_file(&summary_path, summary.as_bytes())
            .map_err(|error| format!("Failed to write the report summary: {error}"))?;

        let bundle =
            build_diagnostic_bundle(request, &context, &timestamp_iso, &summary, &redactions)?;
        let bundle_path = folder.join(BUNDLE_FILENAME);
        write_file(&bundle_path, &bundle)
            .map_err(|error| format!("Failed to write the diagnostic bundle: {error}"))?;

        Ok(ProblemReportResult {
            folder_path: folder.to_string_lossy().into_owned(),
            summary_path: summary_path.to_string_lossy().into_owned(),
            bundle_path: bundle_path.to_string_lossy().into_owned(),
            report_summary: summary,
        })
    })();

    if let Err(error) = &result
        && let Err(cleanup) = std::fs::remove_dir_all(&folder)
    {
        return Err(format!(
            "{error}; the incomplete report folder could not be removed: {cleanup}"
        ));
    }
    result
}

fn folder_stamp(timestamp_iso: &str) -> String {
    timestamp_iso
        .trim_end_matches('Z')
        .replace('T', " ")
        .replace(':', "-")
}

fn create_unique_report_folder(root: &Path, folder_name: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(root)
        .map_err(|error| format!("Failed to create report root {}: {error}", root.display()))?;

    for suffix in 0..100 {
        let candidate = if suffix == 0 {
            root.join(folder_name)
        } else {
            root.join(format!("{folder_name}-{suffix}"))
        };
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!(
                    "Failed to create report folder {}: {error}",
                    candidate.display()
                ));
            }
        }
    }

    Err(format!(
        "Failed to create report folder in {}: too many existing reports for {folder_name}",
        root.display()
    ))
}

#[cfg(test)]
mod tests {
    use crate::services::folder_reveal::recording::{RecordingRevealer, Shown};
    use crate::test_scratch::TestScratch;
    use common_types::health::{LidarLibraryStatus, PlantDbStatus, SubsystemHealth};
    use common_types::settings::Settings;
    use common_types::support::{
        FrontendDiagnosticEntry, ProblemReportRequest, ProblemReportSensitiveAttachments,
    };
    use std::path::Path;
    use std::path::PathBuf;

    struct TempProblemReportDir {
        root: TestScratch,
    }

    impl TempProblemReportDir {
        fn new(label: &str) -> Self {
            Self {
                root: TestScratch::new(&format!("problem-report-{label}")),
            }
        }
    }

    #[test]
    fn creates_report_summary_and_diagnostic_bundle_in_visible_folder() {
        let temp = TempProblemReportDir::new("bundle");
        let log_dir = temp.root.join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(
            log_dir.join("canopi.log"),
            "Loaded design from /home/alice/Garden Site.canopi\nCanopi starting\n",
        )
        .unwrap();

        let result = super::create_problem_report(
            &ProblemReportRequest {
                description: "Canvas froze after placing a species".to_owned(),
                frontend_diagnostics: vec![FrontendDiagnosticEntry {
                    level: "error".to_owned(),
                    source: "ErrorBoundary".to_owned(),
                    message: "Render failed at /home/alice/Garden Site.canopi".to_owned(),
                    timestamp_ms: 1_801_440_010_000.0,
                }],
                sensitive_attachments: ProblemReportSensitiveAttachments::default(),
            },
            super::ProblemReportContext {
                output_root: temp.root.join("Desktop"),
                log_dir: Some(log_dir.clone()),
                app_data_dir: Some(temp.root.join("app-data")),
                timestamp_secs: 1_801_440_000,
                app_version: "0.5.0".to_owned(),
                target: "test-os/test-arch".to_owned(),
                webview_version: Some("2.44.0".to_owned()),
                settings: Some(Settings {
                    plant_spacing_interval_m: 0.75,
                    // A recognizable fake credential: the diagnostic allowlist
                    // must never carry it, so the assertions below stay honest.
                    google_maps_api_key: Some("FAKE-GOOGLE-MAPS-KEY-DO-NOT-EXPORT".to_owned()),
                    ..Settings::default()
                }),
                settings_error: None,
                health: SubsystemHealth {
                    plant_db: PlantDbStatus::Available,
                    lidar_library: LidarLibraryStatus::Ready,
                    local_data: common_types::health::LocalDataStatus::Current,
                },
            },
        )
        .unwrap();

        let folder = PathBuf::from(&result.folder_path);
        assert!(folder.ends_with("Canopi Problem Report 2027-02-01 00-00-00"));
        assert!(folder.join("Report Summary.txt").exists());
        assert!(folder.join("Diagnostic Bundle.zip").exists());
        assert_eq!(
            PathBuf::from(&result.summary_path),
            folder.join("Report Summary.txt")
        );
        assert_eq!(
            PathBuf::from(&result.bundle_path),
            folder.join("Diagnostic Bundle.zip")
        );

        let summary = std::fs::read_to_string(folder.join("Report Summary.txt")).unwrap();
        assert!(summary.contains("Canvas froze after placing a species"));
        assert!(summary.contains("Canopi 0.5.0"));
        assert!(summary.contains("Webview: 2.44.0\n"));
        assert!(!summary.contains("/home/alice"));
        // The device-local Google key is a credential, not diagnostic content.
        assert!(!summary.contains("FAKE-GOOGLE-MAPS-KEY-DO-NOT-EXPORT"));

        let bundle = std::fs::read(folder.join("Diagnostic Bundle.zip")).unwrap();
        assert!(bundle.starts_with(b"PK\x03\x04"));
        assert!(bundle.windows(4).any(|window| window == b"PK\x05\x06"));
        let bundle_text = String::from_utf8_lossy(&bundle);
        assert!(bundle_text.contains("manifest.json"));
        assert!(bundle_text.contains("\"webview_version\": \"2.44.0\""));
        assert!(bundle_text.contains("backend-log.txt"));
        assert!(bundle_text.contains("frontend-diagnostics.json"));
        assert!(bundle_text.contains("Render failed"));
        assert!(bundle_text.contains("\"plant_spacing_interval_m\""));
        assert!(bundle_text.contains("0.75"));
        assert!(!bundle_text.contains("current-design.canopi"));
        assert!(!bundle_text.contains("/home/alice"));
        assert!(!bundle_text.contains("Garden Site.canopi"));
        // `settings_summary` is an explicit allowlist rather than a settings
        // dump, which is what keeps the credential out; the key must not appear
        // by name, by value, or in the manifest's own settings object.
        assert!(!bundle_text.contains("FAKE-GOOGLE-MAPS-KEY-DO-NOT-EXPORT"));
        assert!(!bundle_text.contains("google_maps_api_key"));
    }

    #[test]
    fn create_problem_report_includes_current_design_after_explicit_consent() {
        let temp = TempProblemReportDir::new("current-design");

        let result = super::create_problem_report(
            &ProblemReportRequest {
                description: "Budget panel failed after editing notes".to_owned(),
                frontend_diagnostics: Vec::new(),
                sensitive_attachments: ProblemReportSensitiveAttachments {
                    current_design: Some(
                        "{\n  \"name\": \"Secret Orchard\",\n  \"plants\": [{\"position\": {\"lat\": 48.8566, \"lon\": 2.3522}}]\n}\n"
                            .to_owned(),
                    ),
                },
            },
            super::ProblemReportContext {
                output_root: temp.root.join("Desktop"),
                log_dir: None,
                app_data_dir: Some(temp.root.join("app-data")),
                timestamp_secs: 1_801_440_000,
                app_version: "0.5.0".to_owned(),
                target: "test-os/test-arch".to_owned(),
                webview_version: None,
                settings: Some(Settings::default()),
                settings_error: None,
                health: SubsystemHealth {
                    plant_db: PlantDbStatus::Available,
                    lidar_library: LidarLibraryStatus::Ready,
                    local_data: common_types::health::LocalDataStatus::Current,
                },
            },
        )
        .unwrap();

        let summary = std::fs::read_to_string(&result.summary_path).unwrap();
        assert!(summary.contains("Current Design (.canopi) included by explicit consent"));

        let bundle = std::fs::read(&result.bundle_path).unwrap();
        let bundle_text = String::from_utf8_lossy(&bundle);
        assert!(bundle_text.contains("current-design.canopi"));
        assert!(bundle_text.contains("Secret Orchard"));
        assert!(bundle_text.contains("Current Design included by explicit user consent"));
        assert!(bundle_text.contains("\"includes_design_contents\": true"));
        assert!(
            !bundle_text.contains("precise_location"),
            "v2 has no Design location"
        );
        assert!(
            !bundle_text.contains("Precise Location"),
            "v2 has no Design location"
        );
    }

    fn minimal_context(
        output_root: PathBuf,
        log_dir: Option<PathBuf>,
    ) -> super::ProblemReportContext {
        super::ProblemReportContext {
            output_root,
            log_dir,
            app_data_dir: None,
            timestamp_secs: 1_801_440_000,
            app_version: "0.5.0".to_owned(),
            target: "test-os/test-arch".to_owned(),
            webview_version: None,
            settings: Some(Settings::default()),
            settings_error: None,
            health: SubsystemHealth {
                plant_db: PlantDbStatus::Available,
                lidar_library: LidarLibraryStatus::Ready,
                local_data: common_types::health::LocalDataStatus::Current,
            },
        }
    }

    fn request(description: &str) -> ProblemReportRequest {
        ProblemReportRequest {
            description: description.to_owned(),
            frontend_diagnostics: Vec::new(),
            sensitive_attachments: ProblemReportSensitiveAttachments::default(),
        }
    }

    #[test]
    fn a_saved_design_name_never_reaches_the_diagnostic_bundle() {
        let temp = TempProblemReportDir::new("design-name");
        let log_dir = temp.root.join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        let user_db =
            crate::db::UserDb::initialize(rusqlite::Connection::open_in_memory().unwrap()).unwrap();
        let design_path = temp.root.join("designs").join("orchard.canopi");
        std::fs::create_dir_all(design_path.parent().unwrap()).unwrap();
        let (_, logs) = crate::services::design_files::capture_logs(|| {
            crate::services::design_files::save_design(
                &user_db,
                design_path.to_string_lossy().into_owned(),
                crate::design::format::create_new_design(
                    "Secret Orchard of Alice",
                    "2026-07-02T00:00:00Z",
                ),
                None,
            )
            .unwrap();
        });
        assert!(logs.contains("Design saved"), "{logs}");
        std::fs::write(log_dir.join("canopi.log"), logs).unwrap();

        let result = super::create_problem_report(
            &request("Save felt slow"),
            minimal_context(temp.root.join("Desktop"), Some(log_dir)),
        )
        .unwrap();

        let bundle = std::fs::read(&result.bundle_path).unwrap();
        let bundle_text = String::from_utf8_lossy(&bundle);
        assert!(
            bundle_text.contains("Design saved"),
            "the log line is still reported"
        );
        assert!(!bundle_text.contains("Secret Orchard of Alice"));
        assert!(!bundle_text.contains("orchard.canopi"));
    }

    #[test]
    fn a_failed_bundle_write_leaves_no_report_folder() {
        let temp = TempProblemReportDir::new("failed-write");
        let output_root = temp.root.join("Desktop");

        let error = super::create_problem_report_with_writer(
            &request("Bundle write fails"),
            minimal_context(output_root.clone(), None),
            |path, bytes| {
                if path.ends_with(super::BUNDLE_FILENAME) {
                    Err(std::io::Error::other("disk full"))
                } else {
                    std::fs::write(path, bytes)
                }
            },
        )
        .unwrap_err();

        assert!(error.contains("disk full"), "{error}");
        assert_eq!(
            std::fs::read_dir(&output_root).unwrap().count(),
            0,
            "the half-written report folder must be removed"
        );
    }

    fn report_folder_in(root: &Path) -> PathBuf {
        let report_folder = root.join("Canopi Problem Report 2027-02-01 00-00-00");
        std::fs::create_dir_all(&report_folder).unwrap();
        std::fs::write(report_folder.join("Report Summary.txt"), "summary").unwrap();
        std::fs::write(report_folder.join("Diagnostic Bundle.zip"), b"bundle").unwrap();
        report_folder
    }

    #[test]
    fn show_problem_report_folder_reveals_the_new_bundle_in_its_folder() {
        let temp = TempProblemReportDir::new("show-folder");
        let report_folder = report_folder_in(&temp.root);
        let revealer = RecordingRevealer::default();

        super::show_problem_report_folder(&report_folder, &temp.root, &revealer).unwrap();

        assert_eq!(
            revealer.shown(),
            vec![Shown::Item(report_folder.join("Diagnostic Bundle.zip"))]
        );
    }

    #[test]
    fn show_problem_report_folder_opens_the_report_folder_when_the_file_manager_cannot_select_the_bundle()
     {
        let temp = TempProblemReportDir::new("show-folder-no-file-manager");
        let report_folder = report_folder_in(&temp.root);
        let revealer = RecordingRevealer::without_file_manager();

        super::show_problem_report_folder(&report_folder, &temp.root, &revealer).unwrap();

        assert_eq!(
            revealer.shown(),
            vec![
                Shown::Item(report_folder.join("Diagnostic Bundle.zip")),
                Shown::Folder(report_folder.clone()),
            ]
        );
    }

    #[test]
    fn show_problem_report_folder_refuses_a_deleted_report_before_revealing() {
        let temp = TempProblemReportDir::new("show-folder-deleted");
        let report_folder = report_folder_in(&temp.root);
        std::fs::remove_dir_all(&report_folder).unwrap();
        let revealer = RecordingRevealer::default();

        assert!(super::show_problem_report_folder(&report_folder, &temp.root, &revealer).is_err());
        assert!(revealer.shown().is_empty());
    }

    #[test]
    fn show_problem_report_folder_rejects_non_report_folders_before_revealing() {
        let temp = TempProblemReportDir::new("show-folder-invalid");
        let not_a_report = temp.root.join("Downloads");
        std::fs::create_dir_all(&not_a_report).unwrap();
        let revealer = RecordingRevealer::default();

        let error =
            super::show_problem_report_folder(&not_a_report, &temp.root, &revealer).unwrap_err();

        assert!(error.contains("is not a Canopi Problem Report folder"));
        assert!(revealer.shown().is_empty());
    }

    #[test]
    fn show_problem_report_folder_rejects_report_folders_outside_the_output_root() {
        let temp = TempProblemReportDir::new("show-folder-outside");
        let elsewhere = temp.root.join("elsewhere");
        let report_folder = report_folder_in(&elsewhere);
        let output_root = temp.root.join("Desktop");
        std::fs::create_dir_all(&output_root).unwrap();
        let revealer = RecordingRevealer::default();

        let error =
            super::show_problem_report_folder(&report_folder, &output_root, &revealer).unwrap_err();

        assert!(
            error.contains("is not a Canopi Problem Report folder"),
            "{error}"
        );
        assert!(revealer.shown().is_empty());
    }
}
