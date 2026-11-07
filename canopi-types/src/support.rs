//! Problem reports: the user-initiated request, its result and the
//! diagnostics and attachments it may carry.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct ProblemReportRequest {
    pub description: String,
    #[serde(default)]
    pub frontend_diagnostics: Vec<FrontendDiagnosticEntry>,
    #[serde(default)]
    pub sensitive_attachments: ProblemReportSensitiveAttachments,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct ProblemReportResult {
    pub folder_path: String,
    pub summary_path: String,
    pub bundle_path: String,
    pub report_summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct FrontendDiagnosticEntry {
    pub level: String,
    pub source: String,
    pub message: String,
    pub timestamp_ms: f64,
}

/// The level of a frontend diagnostics ring entry (contracts §13 Failure
/// report). Phase 1's 1a-c6 types `FrontendDiagnosticEntry::level` with it.
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct ProblemReportSensitiveAttachments {
    #[serde(default)]
    pub current_design: Option<String>,
}
