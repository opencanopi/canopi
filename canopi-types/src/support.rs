//! Problem reports (ADR 0025 "A problem report carries", contracts §13): the
//! sections the frontend fills, the Design attached by consent, and the
//! saved zip named by its file name, never a path (2.1-Q276 to 2.1-Q278).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::failure::RedactedText;
use crate::report::ReportSectionId;

/// What the frontend sends to save a report on Desktop: the sections the one
/// TS builder fills, each redacted by TS and again when decoded, and the
/// current Design, only when the user ticked its checkbox. Desktop adds its
/// native sections and the manifest, and zips (2.1-M412, 2.1-M422).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProblemReportRequest {
    /// The frontend's sections: what the user wrote, the frontend ring and the
    /// failure the report was opened from; each id at most once.
    pub sections: Vec<ReportSectionText>,
    /// The current Design's `.canopi` text, attached only by consent
    /// (`ReportConsent::CurrentDesign`, 2.1-Q278).
    #[serde(default)]
    pub current_design: Option<String>,
}

/// One frontend section's content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ReportSectionText {
    /// The section.
    pub id: ReportSectionId,
    /// Its content, redacted.
    pub text: RedactedText,
}

/// A saved report: its file name in the "Problem reports" folder, never a
/// path (2.1-Q276, 2.1-M299). Writing shows nothing: the frontend shows the
/// zip selected only while the user still wants the report (canopi-f47t.52.36).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ProblemReportResult {
    /// `canopi-report-YYYYMMDD-HHMMSS.zip`, with `-2` and on for a second
    /// report in the same second (2.1-Q281).
    pub file_name: String,
}

/// The level of a frontend diagnostics ring entry (contracts §13 Failure
/// report).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FrontendDiagnosticLevel {
    /// Lost work or a failed action.
    Error,
    /// A degraded or repaired state.
    Warning,
    /// A record kept for the report only.
    Info,
}
