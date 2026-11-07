//! The report zip's entries, one per `REPORT_SECTIONS` row (ADR 0025, 2.1-M421): the frontend's
//! sections as sent, the native sections redacted by the report's redactor, the Design only by
//! consent, and `manifest.json` first, listing every other entry with its status (2.1-M436).
//! A section with nothing to say keeps its entry, marked: empty, unreadable or "not collected
//! before Phase 3".

use canopi_redact::Redactor;
use canopi_types::failure::{Failure, FailureCode};
use canopi_types::library::{AnalysisJobState, LibrarySnapshot};
use canopi_types::lidar::LidarImportJobState;
use canopi_types::report::{
    MANIFEST_FILE, NOT_COLLECTED_NOTE, REPORT_SECTIONS, ReportManifest, ReportManifestEntry,
    ReportSectionId, ReportSectionStatus,
};
use canopi_types::support::ProblemReportRequest;
use serde_json::{Value, json};

use super::zip::{ZipEntry, create_stored_zip};
use super::{CREATE_OP, ProblemReportContext};

/// The manifest's format, read by whoever opens a report.
const MANIFEST_FORMAT: &str = "canopi-problem-report-2";

/// How many log lines the tail keeps.
const LOG_TAIL_LINES: usize = 400;

/// The zip: the manifest, then every section's entry in report order.
pub(super) fn report_zip(
    request: &ProblemReportRequest,
    context: &ProblemReportContext,
    created_at: &str,
    redactor: &Redactor,
) -> Result<Vec<u8>, Failure> {
    let mut listed = Vec::new();
    let mut entries = Vec::new();
    for row in &REPORT_SECTIONS {
        let (status, bytes) = match row.id {
            ReportSectionId::Design => match &request.current_design {
                Some(design) => (ReportSectionStatus::Included, design.clone().into_bytes()),
                None => continue,
            },
            ReportSectionId::Description
            | ReportSectionId::FrontendRing
            | ReportSectionId::OriginatingFailure => frontend_section(request, row.id),
            native => {
                let (status, text) = native_section(native, context, created_at, redactor);
                (status, redactor.redact(&text).as_str().as_bytes().to_vec())
            }
        };
        listed.push(ReportManifestEntry {
            section: row.id,
            file: row.file,
            status,
        });
        entries.push(ZipEntry::new(row.file, bytes));
    }
    let manifest = ReportManifest {
        format: MANIFEST_FORMAT,
        created_at: created_at.to_owned(),
        entries: listed,
    };
    let manifest = serde_json::to_vec_pretty(&manifest).map_err(|error| internal(&error))?;
    entries.insert(0, ZipEntry::new(MANIFEST_FILE, manifest));
    create_stored_zip(&entries).map_err(|error| internal(&error))
}

fn internal(error: &impl std::fmt::Display) -> Failure {
    Failure::new(FailureCode::Internal, CREATE_OP)
        .with_english(&format!("Building the problem report failed: {error}"))
}

/// A frontend section as the frontend redacted it, or its empty marker.
fn frontend_section(
    request: &ProblemReportRequest,
    id: ReportSectionId,
) -> (ReportSectionStatus, Vec<u8>) {
    match request.sections.iter().find(|section| section.id == id) {
        Some(section) if !section.text.as_str().trim().is_empty() => (
            ReportSectionStatus::Included,
            section.text.as_str().as_bytes().to_vec(),
        ),
        _ => (ReportSectionStatus::Empty, b"empty\n".to_vec()),
    }
}

/// A native section's status and text, before redaction.
fn native_section(
    id: ReportSectionId,
    context: &ProblemReportContext,
    created_at: &str,
    redactor: &Redactor,
) -> (ReportSectionStatus, String) {
    let included = |value: Value| (ReportSectionStatus::Included, pretty(&value));
    let unreadable = |error: &str| {
        let value = json!({"status": "unreadable", "error": error});
        (ReportSectionStatus::Unreadable, pretty(&value))
    };
    match id {
        ReportSectionId::Build => included(json!({
            "app": "Canopi",
            "version": context.app_version,
            "target": context.target,
            "webview_version": context.webview_version,
            "created_at": created_at,
        })),
        ReportSectionId::Health => included(json!({"stores": context.health})),
        ReportSectionId::NativeSettlements if context.settlements.is_empty() => (
            ReportSectionStatus::Empty,
            pretty(&json!({"settlements": []})),
        ),
        ReportSectionId::NativeSettlements => included(json!({"settlements": context.settlements})),
        ReportSectionId::Jobs => match &context.library {
            Ok(library) => included(jobs(library)),
            Err(error) => unreadable(error),
        },
        ReportSectionId::LibraryDisk => match &context.library_disk_bytes {
            Ok(bytes) => included(json!({"bytes": bytes, "janitor": NOT_COLLECTED_NOTE})),
            Err(error) => unreadable(error),
        },
        ReportSectionId::SettingsSummary => match &context.settings {
            Ok(settings) => included(json!({
                "locale": settings.locale,
                "theme": settings.theme,
                "basemap_style": settings.basemap_style,
                "basemap_visible": settings.basemap_visible,
                "satellite_visible": settings.satellite_visible,
                "contour_visible": settings.contour_visible,
                "hillshade_visible": settings.hillshade_visible,
                "plant_spacing_interval_m": settings.plant_spacing_interval_m,
            })),
            Err(error) => unreadable(error),
        },
        ReportSectionId::LogTail => log_tail(context, redactor),
        // Queues, waits, the oldest running op: no source on today's executor (2.1-M421).
        _ => {
            let value = json!({"status": "not_collected", "note": NOT_COLLECTED_NOTE});
            (ReportSectionStatus::NotCollected, pretty(&value))
        }
    }
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default() + "\n"
}

/// The log's last lines; a file gone or locked since the listing marks the section unreadable
/// and keeps what was read.
fn log_tail(context: &ProblemReportContext, redactor: &Redactor) -> (ReportSectionStatus, String) {
    let Some(log_dir) = &context.log_dir else {
        return (
            ReportSectionStatus::Unreadable,
            "unreadable: no log folder\n".to_owned(),
        );
    };
    let (lines, unreadable) = crate::logging::log_tail(log_dir, redactor, LOG_TAIL_LINES);
    let mut text: String = lines
        .iter()
        .map(|line| format!("{}\n", line.as_str()))
        .collect();
    if unreadable > 0 {
        text.insert_str(
            0,
            &format!("unreadable: {unreadable} log file(s) could not be read\n"),
        );
        (ReportSectionStatus::Unreadable, text)
    } else if lines.is_empty() {
        (ReportSectionStatus::Empty, "empty\n".to_owned())
    } else {
        (ReportSectionStatus::Included, text)
    }
}

/// Job counts by kind and state over each item's latest job, and the failed ones by kind and
/// item role: no item name, message or path (the section's privacy line).
fn jobs(library: &LibrarySnapshot) -> Value {
    let mut counts = std::collections::BTreeMap::<String, u64>::new();
    let mut failures = Vec::new();
    for item in &library.items {
        let latest = [
            item.import_job.as_ref().map(|job| {
                (
                    "import",
                    json!(job.state),
                    job.state == LidarImportJobState::Failed,
                )
            }),
            item.run.as_ref().map(|run| {
                (
                    "analysis",
                    json!(run.state),
                    run.state == AnalysisJobState::Failed,
                )
            }),
        ];
        for (kind, state, failed) in latest.into_iter().flatten() {
            let state = state.as_str().unwrap_or("unknown").to_lowercase();
            *counts.entry(format!("{kind}.{state}")).or_default() += 1;
            if failed {
                failures.push(json!({"kind": kind, "role": item.role}));
            }
        }
    }
    json!({"latest_job_counts": counts, "recent_failures": failures})
}
