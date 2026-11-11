//! Desktop's problem report writer (ADR 0025 "A problem report carries"; 2.1-Q276 to 2.1-Q278,
//! 2.1-Q281): the frontend's sections and the native ones, one zip in the "Problem reports"
//! folder of Canopi's local data folder. Writing shows nothing: the frontend shows the zip selected
//! (`show_problem_report`) only while the user still wants it, so a report cancelled during its
//! write never opens the file manager (canopi-f47t.52.36).
//!
//! - **Sections.** One entry per `REPORT_SECTIONS` row, even when its source has nothing to say
//!   (`bundle.rs`); the frontend sends only its own sections, and Desktop fills the rest. The
//!   manifest lists every entry but itself with its status; the Design is an entry only by consent.
//! - **Privacy.** Every entry but the consented Design is redacted text: a path reads as its
//!   folder's token or `<path>`, never the path, whatever the consent (2.1-Q278).
//! - **Writing.** `canopi-report-YYYYMMDD-HHMMSS.zip` (UTC), `-2` and on for a second report in
//!   the same second, created new so no report is overwritten; a failed write removes the
//!   partial file, so the folder holds whole reports only.
//! - **Failures.** A `Failure` whose detail names a path only as `UserPath`'s placeholder; the
//!   result names the zip by its file name, never a path (2.1-M299).

use canopi_redact::{NamedFolder, Redactor};
use canopi_types::failure::{Failure, FailureCode, IoFailureKind};
use canopi_types::health::SubsystemHealth;
use canopi_types::library::LibrarySnapshot;
use canopi_types::report::ReportSectionId;
use canopi_types::sensitive::UserPath;
use canopi_types::settings::Settings;
use canopi_types::support::{ProblemReportRequest, ProblemReportResult};
use std::collections::BTreeSet;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use crate::logging::SettledFailure;

mod bundle;
mod folder_reveal;
mod zip;

pub(crate) use folder_reveal::{SHOW_OP, show_problem_report};

/// The dotted op of `create_problem_report`.
pub const CREATE_OP: &str = canopi_types::failure::ops::PROBLEM_REPORT_CREATE;

/// A report's file name before its stamp, and after.
const NAME_PREFIX: &str = "canopi-report-";
const NAME_SUFFIX: &str = ".zip";

/// How many reports may share one second before the write gives up.
const MAX_SAME_SECOND: usize = 100;

/// The sections the frontend fills; Desktop fills every other but the Design.
const FRONTEND_SECTIONS: [ReportSectionId; 3] = [
    ReportSectionId::Description,
    ReportSectionId::FrontendRing,
    ReportSectionId::OriginatingFailure,
];

/// What the native sections read, gathered by the command.
pub struct ProblemReportContext {
    /// The "Problem reports" folder, created if missing.
    pub reports_folder: PathBuf,
    pub log_dir: Option<PathBuf>,
    pub app_data_dir: Option<PathBuf>,
    pub timestamp_secs: u64,
    pub app_version: String,
    pub target: String,
    /// The webview's version, read by the shell (`tauri::webview_version`, 2.1-M82); `None` when it
    /// could not be read. A plain value, so this module names no tauri path.
    pub webview_version: Option<String>,
    pub settings: Result<Settings, String>,
    pub health: SubsystemHealth,
    /// The last native failure settlements (`logging::recent_failures`).
    pub settlements: Vec<SettledFailure>,
    /// The Data library's items with their latest jobs, read for job counts and failures.
    pub library: Result<LibrarySnapshot, String>,
    /// Bytes the Data library folder occupies.
    pub library_disk_bytes: Result<u64, String>,
}

/// Write the report; nothing is shown.
pub fn create_problem_report(
    request: &ProblemReportRequest,
    context: &ProblemReportContext,
) -> Result<ProblemReportResult, Failure> {
    create_problem_report_with_writer(request, context, |file, bytes| {
        file.write_all(bytes)?;
        file.sync_all()
    })
}

fn create_problem_report_with_writer(
    request: &ProblemReportRequest,
    context: &ProblemReportContext,
    write: impl Fn(&mut std::fs::File, &[u8]) -> std::io::Result<()>,
) -> Result<ProblemReportResult, Failure> {
    admit(request)?;
    let created_at = crate::design::unix_to_iso8601(context.timestamp_secs);
    let zip = bundle::report_zip(request, context, &created_at, &report_redactor(context))?;
    let folder = &context.reports_folder;
    std::fs::create_dir_all(folder)
        .map_err(|error| io_failure(&error, "Creating the problem reports folder", folder))?;
    let (path, mut file) = create_unique(folder, &file_stem(&created_at))?;
    if let Err(error) = write(&mut file, &zip) {
        drop(file);
        // A partial zip is removed; a removal that fails too is named in the detail.
        let removal = std::fs::remove_file(&path).err();
        let what = match removal {
            None => "Writing the problem report",
            Some(_) => "Writing the problem report (its partial file was not removed)",
        };
        return Err(io_failure(&error, what, folder));
    }
    drop(file);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_owned();
    Ok(ProblemReportResult { file_name })
}

/// The request's sections are the frontend's own, each once.
fn admit(request: &ProblemReportRequest) -> Result<(), Failure> {
    let mut seen = BTreeSet::new();
    for section in &request.sections {
        if !FRONTEND_SECTIONS.contains(&section.id) || !seen.insert(section.id) {
            return Err(Failure::new(FailureCode::Invalid, CREATE_OP)
                .with_english("a problem report section is not the frontend's or is sent twice"));
        }
    }
    Ok(())
}

/// `canopi-report-YYYYMMDD-HHMMSS` from an ISO 8601 UTC stamp (2.1-Q281).
fn file_stem(created_at: &str) -> String {
    let digits: String = created_at.chars().filter(char::is_ascii_digit).collect();
    let (date, time) = digits.split_at(digits.len().min(8));
    format!("{NAME_PREFIX}{date}-{}", time.get(..6).unwrap_or(time))
}

/// Create `stem.zip`, or `stem-2.zip` and on when taken: never an existing report.
fn create_unique(folder: &Path, stem: &str) -> Result<(PathBuf, std::fs::File), Failure> {
    for attempt in 1..=MAX_SAME_SECOND {
        let name = if attempt == 1 {
            format!("{stem}{NAME_SUFFIX}")
        } else {
            format!("{stem}-{attempt}{NAME_SUFFIX}")
        };
        let path = folder.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(io_failure(&error, "Creating the problem report", folder)),
        }
    }
    Err(Failure::new(
        FailureCode::Io {
            io: IoFailureKind::Other,
        },
        CREATE_OP,
    )
    .with_english(&format!(
        "Creating the problem report in {} failed: {MAX_SAME_SECOND} reports share its second",
        UserPath::from(folder)
    )))
}

/// A file failure of `what` in `folder`: its io kind, the folder only as `<path>`.
fn io_failure(error: &std::io::Error, what: &str, folder: &Path) -> Failure {
    Failure::new(
        FailureCode::Io {
            io: error.kind().into(),
        },
        CREATE_OP,
    )
    .with_english(&format!(
        "{what} in {} failed: {error}",
        UserPath::from(folder)
    ))
}

/// The redactor that names this machine's folders in the report (contracts §13): the reports,
/// log and local data folders and the home folder; any other path reads `<path>` (2.1-Q278).
fn report_redactor(context: &ProblemReportContext) -> Redactor {
    let homes = ["HOME", "USERPROFILE"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(|home| (NamedFolder::Home, PathBuf::from(home)));
    Redactor::with_roots(
        [
            Some((NamedFolder::Report, context.reports_folder.clone())),
            context.log_dir.clone().map(|dir| (NamedFolder::Log, dir)),
            context
                .app_data_dir
                .clone()
                .map(|dir| (NamedFolder::AppData, dir)),
        ]
        .into_iter()
        .flatten()
        .chain(homes),
    )
}

#[cfg(test)]
mod tests;
