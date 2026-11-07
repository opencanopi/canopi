//! The problem report's sections (ADR 0025 "A problem report carries",
//! contracts §13 Failure report; 2.1-M412, 2.1-M421): one table feeding the
//! one TS builder in `app/problem-report/` on both editions. Every section is
//! declared even when it has no source yet; the same ids exist on both
//! editions, and each edition's adapter fills a section or marks it "not on
//! this edition" (no editions column). The report is one zip whose manifest
//! lists every entry but itself (2.1-Q277, 2.1-M436), each entry with its
//! [`ReportSectionStatus`].

use serde::{Deserialize, Serialize};
use specta::Type;

/// A section's id.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "snake_case")]
pub enum ReportSectionId {
    /// The build: app version, platform, webview or browser.
    Build,
    /// Each store's open status at report time, with causes.
    Health,
    /// Queue depths, wait times and the oldest running op.
    Queues,
    /// The last 50 native error settlements.
    NativeSettlements,
    /// The frontend ring: rejected invokes and window errors.
    FrontendRing,
    /// Data library job counts and recent failures.
    Jobs,
    /// Data library disk use and janitor state.
    LibraryDisk,
    /// The end of the app log.
    LogTail,
    /// The settings summary (a hand list until 2e).
    SettingsSummary,
    /// What the user wrote in the dialog.
    Description,
    /// The failure the report was opened from: its code and operation.
    OriginatingFailure,
    /// The current Design, by consent only.
    Design,
}

/// What a section's entry holds, as the manifest lists it: a section with
/// nothing to say still has its entry, marked (ADR 0025, 2.1-M421).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReportSectionStatus {
    /// The section's content.
    Included,
    /// The source had nothing to say: no failure opened the report, no text was written.
    Empty,
    /// The source exists but could not be read in full; what was read is kept.
    Unreadable,
    /// No source yet: "not collected before Phase 3".
    NotCollected,
    /// This edition has no source for the section (F13).
    NotOnThisEdition,
}

/// The line an entry with no source yet reads (ADR 0025, 2.1-M421).
pub const NOT_COLLECTED_NOTE: &str = "not collected before Phase 3";

/// The manifest's entry name: listed by no section, and listing every entry but itself.
pub const MANIFEST_FILE: &str = "manifest.json";

/// A report's `manifest.json`: every entry of the zip but itself, in report order, each with
/// its section and status; the Design is an entry only by consent (2.1-Q277, 2.1-M436).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct ReportManifest {
    /// The manifest's format name.
    pub format: &'static str,
    /// When the report was made, ISO 8601 UTC.
    pub created_at: String,
    /// The zip's other entries.
    pub entries: Vec<ReportManifestEntry>,
}

/// One entry the manifest lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct ReportManifestEntry {
    /// Its section.
    pub section: ReportSectionId,
    /// Its name in the zip, the section's `file`.
    pub file: &'static str,
    /// What it holds.
    pub status: ReportSectionStatus,
}

/// When a section is included.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReportConsent {
    /// Always: the section holds no user content beyond redacted text.
    Always,
    /// Only when the user ticks the current Design's checkbox.
    CurrentDesign,
}

/// One row of `REPORT_SECTIONS`: its id, its entry in the zip, its consent and
/// the privacy line the dialog lists (2.1-Q280).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub struct ReportSection {
    /// The section's id.
    pub id: ReportSectionId,
    /// Its entry's name in the zip.
    pub file: &'static str,
    /// When it is included.
    pub consent: ReportConsent,
    /// What it holds, in one English line.
    pub privacy: &'static str,
}

const fn row(
    id: ReportSectionId,
    file: &'static str,
    consent: ReportConsent,
    privacy: &'static str,
) -> ReportSection {
    ReportSection {
        id,
        file,
        consent,
        privacy,
    }
}

/// Every section of a problem report, in report order.
pub const REPORT_SECTIONS: [ReportSection; 12] = [
    row(
        ReportSectionId::OriginatingFailure,
        "failure.json",
        ReportConsent::Always,
        "The failure you reported from, by its code and operation.",
    ),
    row(
        ReportSectionId::Description,
        "description.txt",
        ReportConsent::Always,
        "What you wrote above.",
    ),
    row(
        ReportSectionId::Build,
        "build.json",
        ReportConsent::Always,
        "Canopi's version, your operating system and its web view or browser.",
    ),
    row(
        ReportSectionId::Health,
        "health.json",
        ReportConsent::Always,
        "How each data store opened, without file paths.",
    ),
    row(
        ReportSectionId::Queues,
        "queues.json",
        ReportConsent::Always,
        "Waiting and running background work, by count and time.",
    ),
    row(
        ReportSectionId::NativeSettlements,
        "native-failures.json",
        ReportConsent::Always,
        "The last 50 failed background operations, with paths and keys removed.",
    ),
    row(
        ReportSectionId::FrontendRing,
        "app-failures.json",
        ReportConsent::Always,
        "Recent errors in the app window, with paths and keys removed.",
    ),
    row(
        ReportSectionId::Jobs,
        "jobs.json",
        ReportConsent::Always,
        "Data library job counts and recent job failures, without item names.",
    ),
    row(
        ReportSectionId::LibraryDisk,
        "library.json",
        ReportConsent::Always,
        "Data library disk use and clean-up state, without item names.",
    ),
    row(
        ReportSectionId::LogTail,
        "log-tail.txt",
        ReportConsent::Always,
        "The end of Canopi's log, with paths and keys removed.",
    ),
    row(
        ReportSectionId::SettingsSummary,
        "settings.json",
        ReportConsent::Always,
        "Your language, theme and display settings; never your Maps key.",
    ),
    row(
        ReportSectionId::Design,
        "design.canopi",
        ReportConsent::CurrentDesign,
        "The current Design, only if you tick it: its objects, map coordinates, notes, timeline and budget.",
    ),
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_section_has_one_row_and_one_zip_entry() {
        let ids: HashSet<_> = REPORT_SECTIONS.iter().map(|s| s.id).collect();
        let files: HashSet<_> = REPORT_SECTIONS.iter().map(|s| s.file).collect();
        assert_eq!(ids.len(), REPORT_SECTIONS.len());
        assert_eq!(files.len(), REPORT_SECTIONS.len());
        assert!(!files.contains(MANIFEST_FILE), "the manifest is no section");
        let consented: Vec<_> = REPORT_SECTIONS
            .iter()
            .filter(|s| s.consent == ReportConsent::CurrentDesign)
            .map(|s| s.id)
            .collect();
        assert_eq!(consented, [ReportSectionId::Design]);
    }
}
