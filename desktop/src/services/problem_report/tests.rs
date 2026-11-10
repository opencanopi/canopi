//! The report writer's behaviour: one zip, every section, a manifest of every other entry,
//! nothing private, and the failure states of contracts §13.

use super::{ProblemReportContext, create_problem_report, create_problem_report_with_writer};
use crate::test_scratch::TestScratch;
use canopi_redact::Redactor;
use canopi_types::failure::{FailureCode, IoFailureKind};
use canopi_types::library::LibrarySnapshot;
use canopi_types::report::{MANIFEST_FILE, REPORT_SECTIONS, ReportSectionId};
use canopi_types::settings::Settings;
use canopi_types::support::{ProblemReportRequest, ReportSectionText};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// 2027-02-01T00:00:00Z.
const STAMP: u64 = 1_801_440_000;
const FIRST_NAME: &str = "canopi-report-20270201-000000.zip";

fn context(scratch: &TestScratch, log_dir: Option<PathBuf>) -> ProblemReportContext {
    ProblemReportContext {
        reports_folder: scratch.join("app-data").join("Problem reports"),
        log_dir,
        app_data_dir: Some(scratch.join("app-data")),
        timestamp_secs: STAMP,
        app_version: "0.5.0".to_owned(),
        target: "test-os/test-arch".to_owned(),
        webview_version: None,
        settings: Ok(Settings::default()),
        health: crate::services::health::all_ready(),
        settlements: Vec::new(),
        library: Ok(LibrarySnapshot {
            items: Vec::new(),
            engines: Default::default(),
        }),
        library_disk_bytes: Ok(0),
    }
}

fn request(description: &str) -> ProblemReportRequest {
    ProblemReportRequest {
        sections: vec![ReportSectionText {
            id: ReportSectionId::Description,
            text: Redactor::generic().redact(description),
        }],
        current_design: None,
    }
}

fn logs_with(scratch: &TestScratch, text: &str) -> PathBuf {
    let log_dir = scratch.join("logs");
    std::fs::create_dir_all(&log_dir).unwrap();
    std::fs::write(log_dir.join("canopi.2027-02-01"), text).unwrap();
    log_dir
}

/// The entries of a stored zip, in order, read from its local headers.
fn entries(zip: &[u8]) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut at = 0;
    while zip.get(at..at + 4) == Some(b"PK\x03\x04") {
        let u16_at = |offset: usize| {
            usize::from(u16::from_le_bytes([zip[at + offset], zip[at + offset + 1]]))
        };
        let size = u32::from_le_bytes(zip[at + 18..at + 22].try_into().unwrap()) as usize;
        let (name_len, extra_len) = (u16_at(26), u16_at(28));
        let name = &zip[at + 30..at + 30 + name_len];
        let data = at + 30 + name_len + extra_len;
        found.push((
            String::from_utf8_lossy(name).into_owned(),
            String::from_utf8_lossy(&zip[data..data + size]).into_owned(),
        ));
        at = data + size;
    }
    found
}

fn report(folder: &Path, name: &str) -> Vec<(String, String)> {
    entries(&std::fs::read(folder.join(name)).unwrap())
}

fn entry<'a>(entries: &'a [(String, String)], file: &str) -> &'a str {
    &entries
        .iter()
        .find(|(name, _)| name == file)
        .unwrap_or_else(|| panic!("no {file}"))
        .1
}

fn manifest_files(entries: &[(String, String)]) -> Vec<String> {
    let manifest: Value = serde_json::from_str(entry(entries, MANIFEST_FILE)).unwrap();
    manifest["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["file"].as_str().unwrap().to_owned())
        .collect()
}

fn status_of(entries: &[(String, String)], file: &str) -> String {
    let manifest: Value = serde_json::from_str(entry(entries, MANIFEST_FILE)).unwrap();
    let listed = manifest["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["file"] == file);
    listed.unwrap()["status"].as_str().unwrap().to_owned()
}

#[test]
fn a_report_is_one_zip_in_the_problem_reports_folder_named_by_its_file_name() {
    let scratch = TestScratch::new("problem-report-one-zip");
    let log_dir = logs_with(
        &scratch,
        "Loaded design from /home/alice/Garden Site.canopi\nCanopi starting\n",
    );
    let mut context = context(&scratch, Some(log_dir));
    context.webview_version = Some("2.44.0".to_owned());
    context.settings = Ok(Settings {
        plant_spacing_interval_m: 0.75,
        // A recognizable fake credential: the settings hand list must never carry it.
        google_maps_api_key: Some("FAKE-GOOGLE-MAPS-KEY-DO-NOT-EXPORT".to_owned()),
        ..Settings::default()
    });

    let result =
        create_problem_report(&request("Canvas froze after placing a species"), &context).unwrap();

    assert_eq!(
        result.file_name, FIRST_NAME,
        "a file name, never a path (2.1-M299)"
    );
    let folder = &context.reports_folder;
    let names: Vec<_> = std::fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(
        names,
        [FIRST_NAME],
        "one zip, no folder and no summary.txt (2.1-Q277)"
    );
    let entries = report(folder, FIRST_NAME);
    assert_eq!(
        entry(&entries, "description.txt"),
        "Canvas froze after placing a species"
    );
    assert!(entry(&entries, "build.json").contains("\"webview_version\": \"2.44.0\""));
    assert!(entry(&entries, "settings.json").contains("0.75"));
    assert!(entry(&entries, "log-tail.txt").contains("Canopi starting"));
    let all: String = entries.iter().map(|(_, text)| text.as_str()).collect();
    assert!(
        !all.contains("/home/alice") && !all.contains("Garden Site.canopi"),
        "{all}"
    );
    assert!(
        !all.contains("FAKE-GOOGLE-MAPS-KEY-DO-NOT-EXPORT") && !all.contains("google_maps_api_key")
    );
}

#[test]
fn create_problem_report_includes_current_design_after_explicit_consent() {
    let scratch = TestScratch::new("problem-report-current-design");
    let context = context(&scratch, None);
    let mut request = request("Budget panel failed after editing notes");
    request.current_design = Some("{\"name\": \"Secret Orchard\"}\n".to_owned());

    create_problem_report(&request, &context).unwrap();

    let entries = report(&context.reports_folder, FIRST_NAME);
    assert_eq!(
        entry(&entries, "design.canopi"),
        "{\"name\": \"Secret Orchard\"}\n"
    );
    assert_eq!(status_of(&entries, "design.canopi"), "included");
}

#[test]
fn problem_report_always_carries_every_section() {
    let scratch = TestScratch::new("problem-report-every-section");
    // No log folder, no settings, no library and no frontend section: each still has its entry.
    let mut context = context(&scratch, None);
    context.settings = Err("the settings store is closed".to_owned());
    context.library = Err("the library is closed".to_owned());
    context.library_disk_bytes = Err("the library is closed".to_owned());
    let empty = ProblemReportRequest {
        sections: Vec::new(),
        current_design: None,
    };

    create_problem_report(&empty, &context).unwrap();

    let entries = report(&context.reports_folder, FIRST_NAME);
    let files: Vec<_> = entries.iter().map(|(name, _)| name.as_str()).collect();
    let mut expected = vec![MANIFEST_FILE];
    expected.extend(
        REPORT_SECTIONS
            .iter()
            .filter(|row| row.id != ReportSectionId::Design)
            .map(|row| row.file),
    );
    assert_eq!(files, expected);
    assert_eq!(status_of(&entries, "description.txt"), "empty");
    assert_eq!(status_of(&entries, "settings.json"), "unreadable");
    assert_eq!(status_of(&entries, "jobs.json"), "unreadable");
    assert_eq!(status_of(&entries, "queues.json"), "not_collected");
    assert!(entry(&entries, "queues.json").contains("not collected before Phase 3"));
}

#[test]
fn the_manifest_lists_every_zip_entry_but_itself_with_and_without_the_design() {
    for design in [None, Some("{}".to_owned())] {
        let scratch = TestScratch::new("problem-report-manifest");
        let context = context(&scratch, None);
        let mut request = request("Manifest");
        request.current_design = design.clone();
        create_problem_report(&request, &context).unwrap();
        let entries = report(&context.reports_folder, FIRST_NAME);
        let others: Vec<_> = entries
            .iter()
            .map(|(name, _)| name.clone())
            .filter(|name| name != MANIFEST_FILE)
            .collect();
        assert_eq!(manifest_files(&entries), others, "design {design:?}");
        assert_eq!(
            others.contains(&"design.canopi".to_owned()),
            design.is_some()
        );
    }
}

#[test]
fn a_section_the_frontend_does_not_own_or_sends_twice_is_refused_before_any_output() {
    let scratch = TestScratch::new("problem-report-admission");
    let context = context(&scratch, None);
    let text = Redactor::generic().redact("x");
    for ids in [
        vec![ReportSectionId::LogTail],
        vec![ReportSectionId::Description, ReportSectionId::Description],
    ] {
        let sections = ids
            .into_iter()
            .map(|id| ReportSectionText {
                id,
                text: text.clone(),
            })
            .collect();
        let request = ProblemReportRequest {
            sections,
            current_design: None,
        };
        let failure = create_problem_report(&request, &context).unwrap_err();
        assert_eq!(failure.code, FailureCode::Invalid);
    }
    assert!(!context.reports_folder.exists());
}

#[test]
fn a_log_folder_that_cannot_be_read_marks_the_log_tail_unreadable_never_omitted() {
    let scratch = TestScratch::new("problem-report-log-unreadable");
    let context = context(&scratch, Some(scratch.join("logs-gone")));
    create_problem_report(&request("Logs"), &context).unwrap();
    let entries = report(&context.reports_folder, FIRST_NAME);
    assert_eq!(status_of(&entries, "log-tail.txt"), "unreadable");
    assert!(entry(&entries, "log-tail.txt").starts_with("unreadable: 1 log file(s)"));
}

/// A daily file locked (here, unreadable) after the listing: the entry is marked and keeps the other files' lines.
#[cfg(unix)]
#[test]
fn a_locked_log_file_marks_the_log_tail_unreadable_and_keeps_the_other_lines() {
    use std::os::unix::fs::PermissionsExt as _;
    let scratch = TestScratch::new("problem-report-log-locked");
    let log_dir = logs_with(&scratch, "older line\n");
    let locked = log_dir.join("canopi.2027-02-02");
    std::fs::copy(log_dir.join("canopi.2027-02-01"), &locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::File::open(&locked).is_ok() {
        return; // Run as root, nothing is locked.
    }
    let context = context(&scratch, Some(log_dir));

    create_problem_report(&request("Logs"), &context).unwrap();

    let entries = report(&context.reports_folder, FIRST_NAME);
    assert_eq!(status_of(&entries, "log-tail.txt"), "unreadable");
    assert_eq!(
        entry(&entries, "log-tail.txt"),
        "unreadable: 1 log file(s) could not be read\nolder line\n"
    );
}

#[test]
fn a_saved_design_name_never_reaches_the_diagnostic_bundle() {
    let scratch = TestScratch::new("problem-report-design-name");
    let user_db =
        crate::db::UserDb::initialize(rusqlite::Connection::open_in_memory().unwrap()).unwrap();
    let design_path = scratch.join("designs").join("orchard.canopi");
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
    let context = context(&scratch, Some(logs_with(&scratch, &logs)));

    create_problem_report(&request("Save felt slow"), &context).unwrap();

    let tail = report(&context.reports_folder, FIRST_NAME);
    let tail = entry(&tail, "log-tail.txt");
    assert!(
        tail.contains("Design saved"),
        "the log line is still reported"
    );
    assert!(
        !tail.contains("Secret Orchard of Alice") && !tail.contains("orchard.canopi"),
        "{tail}"
    );
}

#[test]
fn nat_07_a_session_value_or_share_path_in_the_log_tail_never_reaches_the_report() {
    let scratch = TestScratch::new("problem-report-log-redaction");
    let log_dir = scratch.join("logs");
    let line = format!(
        "GET https://tile.googleapis.com/v1/2dtiles/3/4/5?session=SESSION-SECRET failed\n\
         Opening \\\\nas\\shared\\Secret Orchard.canopi failed\nRotated {}\n",
        log_dir.join("canopi.2027-01-31").display()
    );
    let context = context(&scratch, Some(logs_with(&scratch, &line)));

    create_problem_report(&request("Tiles stopped loading"), &context).unwrap();

    let entries = report(&context.reports_folder, FIRST_NAME);
    let tail = entry(&entries, "log-tail.txt");
    assert!(tail.contains("?session=<redacted> failed"), "{tail}");
    assert!(tail.contains("Opening <path> failed"), "{tail}");
    assert!(tail.contains("Rotated <log-dir>"), "{tail}");
    assert!(!tail.contains("SESSION-SECRET") && !tail.contains("Secret Orchard"));
}

#[test]
fn a_report_root_that_cannot_be_created_fails_without_naming_its_path() {
    let scratch = TestScratch::new("problem-report-root-blocked");
    let blocker = scratch.join("Secret Orchard");
    std::fs::write(&blocker, b"a file where the reports folder would go").unwrap();
    let mut context = context(&scratch, None);
    context.reports_folder = blocker.join("Problem reports");

    let failure = create_problem_report(&request("Blocked"), &context).unwrap_err();

    assert!(
        matches!(failure.code, FailureCode::Io { .. }),
        "{failure:?}"
    );
    let detail = failure.detail.unwrap();
    assert!(
        detail
            .as_str()
            .starts_with("Creating the problem reports folder in <path> failed"),
        "{detail:?}"
    );
    assert!(!detail.as_str().contains("Secret Orchard"), "{detail:?}");
}

#[test]
fn a_disk_full_write_settles_as_no_space_and_leaves_no_half_written_zip() {
    let scratch = TestScratch::new("problem-report-disk-full");
    let context = context(&scratch, None);

    let failure =
        create_problem_report_with_writer(&request("Disk full"), &context, |file, bytes| {
            std::io::Write::write_all(file, &bytes[..bytes.len() / 2])?;
            Err(std::io::ErrorKind::StorageFull.into())
        })
        .unwrap_err();

    assert_eq!(
        failure.code,
        FailureCode::Io {
            io: IoFailureKind::NoSpace
        }
    );
    assert!(!failure.detail.unwrap().as_str().contains("Problem reports"));
    assert_eq!(
        std::fs::read_dir(&context.reports_folder).unwrap().count(),
        0,
        "the partial zip is removed"
    );
}

#[test]
fn a_second_report_in_the_same_second_gets_a_suffix_and_never_overwrites() {
    let scratch = TestScratch::new("problem-report-same-second");
    let context = context(&scratch, None);
    let first = create_problem_report(&request("First"), &context).unwrap();
    let second = create_problem_report(&request("Second"), &context).unwrap();

    assert_eq!(first.file_name, FIRST_NAME);
    assert_eq!(second.file_name, "canopi-report-20270201-000000-2.zip");
    let folder = &context.reports_folder;
    assert_eq!(
        entry(&report(folder, FIRST_NAME), "description.txt"),
        "First"
    );
    assert_eq!(
        entry(&report(folder, &second.file_name), "description.txt"),
        "Second"
    );
}
