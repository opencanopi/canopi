//! Host file dialogs: what each native Open or Save dialog is for, and what it answers
//! (2.1-M81, contracts §7). The webview never builds a dialog itself: it names a [`DialogKind`]
//! and the host shows the system's dialog, with the system's own title (2.1-Q241).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::design_home::FileHomeGrant;
use crate::ids::FileGrantId;

/// One file format kind shared by FileDelivery rows, native dialog filters and Web accept strings
/// (contracts §16, 2.1-M522).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum FileKind {
    /// A `.canopi` Design or saved-stamp file.
    Canopi,
    /// A GeoJSON file (`.geojson`, `.json`).
    Geojson,
    /// A PDF document (`.pdf`).
    Pdf,
    /// A UTF-8 CSV spreadsheet (`.csv`).
    Csv,
    /// A GeoTIFF raster (`.tif`, `.tiff`).
    Geotiff,
    /// A ZIP archive (`.zip`), including problem report bundles.
    Zip,
}

impl FileKind {
    /// Every file kind, in declaration order.
    pub const ALL: [Self; 6] = [
        Self::Canopi,
        Self::Geojson,
        Self::Pdf,
        Self::Csv,
        Self::Geotiff,
        Self::Zip,
    ];

    /// The wire spelling, as TypeScript sees it.
    pub const fn literal(self) -> &'static str {
        match self {
            Self::Canopi => "canopi",
            Self::Geojson => "geojson",
            Self::Pdf => "pdf",
            Self::Csv => "csv",
            Self::Geotiff => "geotiff",
            Self::Zip => "zip",
        }
    }

    /// Parse a wire literal into a [`FileKind`].
    pub fn from_literal(literal: &str) -> Option<Self> {
        match literal {
            "canopi" => Some(Self::Canopi),
            "geojson" => Some(Self::Geojson),
            "pdf" => Some(Self::Pdf),
            "csv" => Some(Self::Csv),
            "geotiff" => Some(Self::Geotiff),
            "zip" => Some(Self::Zip),
            _ => None,
        }
    }

    /// The allowed file extensions, without dots; the first is the default suffix appended on Save.
    pub const fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::Canopi => &["canopi"],
            Self::Geojson => &["geojson", "json"],
            Self::Pdf => &["pdf"],
            Self::Csv => &["csv"],
            Self::Geotiff => &["tif", "tiff"],
            Self::Zip => &["zip"],
        }
    }

    /// The MIME type used for Web Blob downloads.
    pub const fn mime_type(self) -> &'static str {
        match self {
            Self::Canopi => "application/json",
            Self::Geojson => "application/geo+json",
            Self::Pdf => "application/pdf",
            Self::Csv => "text/csv;charset=utf-8",
            Self::Geotiff => "image/tiff",
            Self::Zip => "application/zip",
        }
    }

    /// The filter's label: a format name, never translated.
    pub const fn filter_label(self) -> &'static str {
        match self {
            Self::Canopi => "Canopi Design",
            Self::Geojson => "GeoJSON",
            Self::Pdf => "PDF",
            Self::Csv => "CSV",
            Self::Geotiff => "GeoTIFF",
            Self::Zip => "ZIP",
        }
    }
}

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
    /// Data library › Export: a GeoTIFF file.
    LidarGeotiffExport,
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
    pub const ALL: [Self; 10] = [
        Self::DesignOpen,
        Self::DesignSave,
        Self::StampImport,
        Self::StampExport,
        Self::GeojsonImport,
        Self::GeojsonExport,
        Self::PdfExport,
        Self::BudgetCsvExport,
        Self::LidarGeotiffImport,
        Self::LidarGeotiffExport,
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
            Self::LidarGeotiffExport => "lidar-geotiff-export",
        }
    }

    /// The [`FileKind`] backing this dialog's extensions and filter label.
    pub const fn file_kind(self) -> FileKind {
        match self {
            Self::DesignOpen | Self::DesignSave | Self::StampImport | Self::StampExport => {
                FileKind::Canopi
            }
            Self::GeojsonImport | Self::GeojsonExport => FileKind::Geojson,
            Self::PdfExport => FileKind::Pdf,
            Self::BudgetCsvExport => FileKind::Csv,
            Self::LidarGeotiffImport | Self::LidarGeotiffExport => FileKind::Geotiff,
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
            | Self::BudgetCsvExport
            | Self::LidarGeotiffExport => DialogPurpose::Save,
        }
    }

    /// The extensions the dialog's filter offers, without dots; a Save appends the first when
    /// the chosen name has none of them.
    pub const fn extensions(self) -> &'static [&'static str] {
        self.file_kind().extensions()
    }

    /// The filter's label: a format name, never translated.
    pub const fn filter_label(self) -> &'static str {
        self.file_kind().filter_label()
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
        /// Host-issued file grants for picked Design files (`home_read` / `home_write`, 2b-4).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        grants: Vec<FileGrantId>,
        /// Full file-home identities (`{ grant, display_name, recent_id }`) for picked Design files.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        file_homes: Vec<FileHomeGrant>,
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
        /// Host-issued file grant for a Design save target (`home_read` / `home_write`, 2b-4).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        grant: Option<FileGrantId>,
        /// Full file-home identity (`{ grant, display_name, recent_id }`) for a Design save target.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_home: Option<FileHomeGrant>,
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
            grants: Vec::new(),
            file_homes: Vec::new(),
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
