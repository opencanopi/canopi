//! Host file dialogs: what each native Open or Save dialog is for, and what it answers
//! (2.1-M81, contracts §7). The webview never builds a dialog itself: it names a [`DialogKind`]
//! and the host shows the system's dialog, with the system's own title (2.1-Q241).

use serde::{Deserialize, Serialize};
use specta::Type;

/// One purpose a host file dialog serves; one row per call site, so a start-folder rule
/// attaches to a purpose. Closed: a new dialog is a new row here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum DialogKind {
    /// File › Open: one Design, starting in the folder of the last Design loaded or saved.
    DesignOpen,
    /// File › Save and Save As: a Design file, defaulting to the last Design folder.
    DesignSave,
    /// Saved stamps › Import: one `.canopi` file holding a stamp; no start folder.
    StampImport,
    /// Saved stamps › Export: a `.canopi` file for one stamp; no start folder.
    StampExport,
    /// GeoJSON import: one file the host reads itself; its path never reaches the page.
    GeojsonImport,
    /// GeoJSON export: the written GeoJSON file.
    GeojsonExport,
    /// Canvas PDF export.
    PdfExport,
    /// Budget › Export as CSV.
    BudgetCsvExport,
    /// Data library › Import: one or more GeoTIFF files.
    LidarGeotiffImport,
}

/// Whether a dialog kind opens files, saves one, or opens one the host reads itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogPurpose {
    /// An Open dialog whose chosen paths go back to the page.
    Open,
    /// A Save dialog whose chosen path goes back to the page.
    Save,
    /// An Open dialog the host answers by reading the file; the page gets the contents only.
    HostRead,
}

impl DialogKind {
    /// Every kind, in declaration order.
    pub const ALL: [Self; 9] = [
        Self::DesignOpen,
        Self::DesignSave,
        Self::StampImport,
        Self::StampExport,
        Self::GeojsonImport,
        Self::GeojsonExport,
        Self::PdfExport,
        Self::BudgetCsvExport,
        Self::LidarGeotiffImport,
    ];

    /// The wire spelling, as TypeScript sees it.
    pub const fn literal(self) -> &'static str {
        match self {
            Self::DesignOpen => "design-open",
            Self::DesignSave => "design-save",
            Self::StampImport => "stamp-import",
            Self::StampExport => "stamp-export",
            Self::GeojsonImport => "geojson-import",
            Self::GeojsonExport => "geojson-export",
            Self::PdfExport => "pdf-export",
            Self::BudgetCsvExport => "budget-csv-export",
            Self::LidarGeotiffImport => "lidar-geotiff-import",
        }
    }

    /// Whether the dialog opens files, saves one, or opens one the host reads.
    pub const fn purpose(self) -> DialogPurpose {
        match self {
            Self::DesignOpen | Self::StampImport | Self::LidarGeotiffImport => DialogPurpose::Open,
            Self::GeojsonImport => DialogPurpose::HostRead,
            Self::DesignSave
            | Self::StampExport
            | Self::GeojsonExport
            | Self::PdfExport
            | Self::BudgetCsvExport => DialogPurpose::Save,
        }
    }

    /// The extensions the dialog's filter offers, without dots; a Save appends the first when
    /// the chosen name has none of them.
    pub const fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::DesignOpen | Self::DesignSave | Self::StampImport | Self::StampExport => {
                &["canopi"]
            }
            Self::GeojsonImport | Self::GeojsonExport => &["geojson", "json"],
            Self::PdfExport => &["pdf"],
            Self::BudgetCsvExport => &["csv"],
            Self::LidarGeotiffImport => &["tif", "tiff"],
        }
    }

    /// The filter's label: a format name, never translated.
    pub const fn filter_label(self) -> &'static str {
        match self {
            Self::DesignOpen | Self::DesignSave | Self::StampImport | Self::StampExport => {
                "Canopi Design"
            }
            Self::GeojsonImport | Self::GeojsonExport => "GeoJSON",
            Self::PdfExport => "PDF",
            Self::BudgetCsvExport => "CSV",
            Self::LidarGeotiffImport => "GeoTIFF",
        }
    }

    /// Whether the Open dialog lets the user choose several files.
    pub const fn allows_multiple(self) -> bool {
        matches!(self, Self::LidarGeotiffImport)
    }

    /// Whether the dialog starts in the folder of the last Design loaded or saved.
    pub const fn starts_in_design_folder(self) -> bool {
        matches!(self, Self::DesignOpen | Self::DesignSave)
    }
}

/// What a host Open dialog answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PickOpenOutcome {
    /// The user closed the dialog without choosing, or its window went away.
    Cancelled,
    /// The chosen files: exactly one unless the kind allows several.
    Picked {
        /// Absolute paths, in the order the dialog gave them.
        paths: Vec<String>,
    },
}

/// What a host Save dialog answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PickSaveOutcome {
    /// The user closed the dialog without choosing, or its window went away.
    Cancelled,
    /// The chosen file, ending in one of the kind's extensions.
    Picked {
        /// The absolute path.
        path: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_kind_serialises_as_its_literal_and_reads_back() {
        for kind in DialogKind::ALL {
            let wire = serde_json::to_value(kind).unwrap_or_default();
            assert_eq!(wire, serde_json::json!(kind.literal()));
            let back: Option<DialogKind> = serde_json::from_value(wire).ok();
            assert_eq!(back, Some(kind));
            assert!(
                !kind.extensions().is_empty(),
                "{kind:?} offers no extension"
            );
        }
    }

    #[test]
    fn only_open_dialogs_allow_several_files() {
        for kind in DialogKind::ALL {
            if kind.allows_multiple() {
                assert_eq!(kind.purpose(), DialogPurpose::Open, "{kind:?}");
            }
        }
    }

    #[test]
    fn outcomes_carry_a_kind_tag() {
        let picked = PickOpenOutcome::Picked {
            paths: vec!["/a.tif".to_string()],
        };
        assert_eq!(
            serde_json::to_value(picked).unwrap_or_default(),
            serde_json::json!({ "kind": "picked", "paths": ["/a.tif"] })
        );
        assert_eq!(
            serde_json::to_value(PickSaveOutcome::Cancelled).unwrap_or_default(),
            serde_json::json!({ "kind": "cancelled" })
        );
    }
}
