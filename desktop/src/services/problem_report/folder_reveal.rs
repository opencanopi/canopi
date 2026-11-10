//! Show a saved report again: the frontend names it by its file name, never a path, and only a
//! report directly inside the "Problem reports" folder is shown, selected (2.1-Q276, 2.1-Q227).

use std::path::Path;

use canopi_types::failure::{Failure, FailureCode, IoFailureKind};

use super::{NAME_PREFIX, NAME_SUFFIX};
use crate::services::folder_reveal::FolderRevealer;

/// The dotted op of `show_problem_report_folder`.
pub const SHOW_OP: &str = canopi_types::failure::ops::PROBLEM_REPORT_SHOW;

/// Show `file_name`, a report in `reports_folder`, selected in its folder (the folder opens when
/// the file manager cannot select it).
pub(crate) fn show_problem_report(
    file_name: &str,
    reports_folder: &Path,
    revealer: &impl FolderRevealer,
) -> Result<(), Failure> {
    let is_report_name = file_name.starts_with(NAME_PREFIX)
        && file_name.ends_with(NAME_SUFFIX)
        && Path::new(file_name).file_name() == Some(file_name.as_ref());
    if !is_report_name {
        return Err(Failure::new(FailureCode::Invalid, SHOW_OP)
            .with_english("the name given is not a problem report's file name"));
    }
    let report = reports_folder.join(file_name);
    if !report.is_file() {
        return Err(Failure::new(
            FailureCode::Io {
                io: IoFailureKind::NotFound,
            },
            SHOW_OP,
        )
        .with_english("the problem report is no longer in the problem reports folder"));
    }
    revealer.show_item(&report).map_err(|error| {
        Failure::new(
            FailureCode::Io {
                io: IoFailureKind::Other,
            },
            SHOW_OP,
        )
        .with_english(&error)
    })
}

#[cfg(test)]
mod tests {
    use super::show_problem_report;
    use crate::services::folder_reveal::recording::{RecordingRevealer, Shown};
    use crate::test_scratch::TestScratch;
    use canopi_types::failure::{FailureCode, IoFailureKind};

    const NAME: &str = "canopi-report-20270201-000000.zip";

    fn reports_folder(label: &str) -> (TestScratch, std::path::PathBuf) {
        let scratch = TestScratch::new(&format!("problem-report-show-{label}"));
        let folder = scratch.join("Problem reports");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join(NAME), b"PK").unwrap();
        (scratch, folder)
    }

    #[test]
    fn show_problem_report_folder_reveals_the_new_bundle_in_its_folder() {
        let (_scratch, folder) = reports_folder("reveal");
        let revealer = RecordingRevealer::default();
        show_problem_report(NAME, &folder, &revealer).unwrap();
        assert_eq!(revealer.shown(), vec![Shown::Item(folder.join(NAME))]);
    }

    #[test]
    fn show_problem_report_folder_opens_the_report_folder_when_the_file_manager_cannot_select_the_bundle()
     {
        let (_scratch, folder) = reports_folder("no-file-manager");
        let revealer = RecordingRevealer::without_file_manager();
        show_problem_report(NAME, &folder, &revealer).unwrap();
        assert_eq!(
            revealer.shown(),
            vec![
                Shown::Item(folder.join(NAME)),
                Shown::Folder(folder.clone())
            ]
        );
    }

    #[test]
    fn show_problem_report_folder_refuses_a_deleted_report_before_revealing() {
        let (_scratch, folder) = reports_folder("deleted");
        std::fs::remove_file(folder.join(NAME)).unwrap();
        let revealer = RecordingRevealer::default();
        let failure = show_problem_report(NAME, &folder, &revealer).unwrap_err();
        assert_eq!(
            failure.code,
            FailureCode::Io {
                io: IoFailureKind::NotFound
            }
        );
        assert!(revealer.shown().is_empty());
    }

    #[test]
    fn show_problem_report_folder_refuses_a_name_that_is_no_report_before_revealing() {
        let (_scratch, folder) = reports_folder("not-a-report");
        std::fs::write(folder.join("notes.txt"), b"").unwrap();
        let revealer = RecordingRevealer::default();
        for name in ["notes.txt", "canopi-report-20270201-000000.txt", ""] {
            let failure = show_problem_report(name, &folder, &revealer).unwrap_err();
            assert_eq!(failure.code, FailureCode::Invalid, "{name}");
        }
        assert!(revealer.shown().is_empty());
    }

    #[test]
    fn show_problem_report_folder_rejects_report_folders_outside_the_output_root() {
        let (scratch, folder) = reports_folder("outside");
        std::fs::write(scratch.join(NAME), b"PK").unwrap();
        let revealer = RecordingRevealer::default();
        for name in [
            "../canopi-report-20270201-000000.zip",
            "canopi-report-x/../../canopi-report-20270201-000000.zip",
        ] {
            let failure = show_problem_report(name, &folder, &revealer).unwrap_err();
            assert_eq!(failure.code, FailureCode::Invalid, "{name}");
        }
        assert!(revealer.shown().is_empty());
    }

    #[test]
    fn a_reveal_the_file_manager_refuses_settles_as_io_without_the_path() {
        let (_scratch, folder) = reports_folder("refused");
        let failure = show_problem_report(NAME, &folder, &RecordingRevealer::refusing_everything())
            .unwrap_err();
        assert_eq!(
            failure.code,
            FailureCode::Io {
                io: IoFailureKind::Other
            }
        );
        let detail = failure.detail.unwrap();
        assert!(!detail.as_str().contains("Problem reports"), "{detail:?}");
    }
}
