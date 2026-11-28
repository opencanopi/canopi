//! The `.canopi` Design file: its version policy, fields and their owners
//! (`DESIGN_FILE_FIELDS`), and the shapes it stores. Positions are WGS84
//! lon/lat (ADR 0001).

use serde::{Deserialize, Serialize};
use specta::Type;

mod admission;
pub mod field_path;
pub mod v10;
mod v10_io;
mod v10_nested;
mod v10_print;
mod v10_views;
pub use admission::{V10AdmissionMode, admit_design_v10, normalise_v10_on_decode};

#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub const DEFAULT_BUDGET_CURRENCY: &str = "EUR";
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub const DEFAULT_PLANT_SYMBOL_ID: &str = "round";
/// Current `.canopi` format version shared by native loading and generated Web facts.
pub const CURRENT_CANOPI_FILE_VERSION: u32 = 10;
/// Missing versions are interpreted as the first public `.canopi` format.
pub const MISSING_CANOPI_FILE_VERSION: u32 = 1;
/// What Canopi 2.1 does with a file newer than [`CURRENT_CANOPI_FILE_VERSION`] (the corpus fact
/// `future_version_policy`): refused unchanged (2.1-Q347; read-only view deleted at 2b-5).
pub const FUTURE_CANOPI_FILE_VERSION_POLICY: &str = "refuse_newer";
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub const WEB_MERCATOR_MAX_LATITUDE_DEG: f64 = 85.051_128_779_806_6;
/// WGS84 ellipsoid semi-major axis in metres (ADR 0001, contracts §20).
pub const WGS84_SEMI_MAJOR_AXIS_M: f64 = 6_378_137.0;
/// WGS84 ellipsoid flattening `1 / 298.257223563` (ADR 0001, contracts §20).
pub const WGS84_FLATTENING: f64 = 1.0 / 298.257_223_563;

fn deserialize_json_u32<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    json_u32(&value).ok_or_else(|| serde::de::Error::custom("expected an unsigned 32-bit integer"))
}

fn deserialize_optional_json_u32<'de, D>(deserializer: D) -> Result<Option<u32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    value
        .as_ref()
        .map(|value| {
            json_u32(value)
                .ok_or_else(|| serde::de::Error::custom("expected an unsigned 32-bit integer"))
        })
        .transpose()
}

fn deserialize_json_i32<'de, D>(deserializer: D) -> Result<i32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    json_i32(&value).ok_or_else(|| serde::de::Error::custom("expected a signed 32-bit integer"))
}

fn json_u32(value: &serde_json::Value) -> Option<u32> {
    value
        .as_u64()
        .and_then(|value| value.try_into().ok())
        .or_else(|| {
            value.as_f64().and_then(|value| {
                (value.is_finite()
                    && value.fract() == 0.0
                    && value >= u32::MIN as f64
                    && value <= u32::MAX as f64)
                    .then_some(value as u32)
            })
        })
}

fn json_i32(value: &serde_json::Value) -> Option<i32> {
    value
        .as_i64()
        .and_then(|value| value.try_into().ok())
        .or_else(|| {
            value.as_f64().and_then(|value| {
                (value.is_finite()
                    && value.fract() == 0.0
                    && value >= i32::MIN as f64
                    && value <= i32::MAX as f64)
                    .then_some(value as i32)
            })
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum CanopiDesignIngestionErrorKind {
    InvalidVersion,
    UnsupportedVersion,
    InvalidDocument,
}

impl CanopiDesignIngestionErrorKind {
    #[expect(
        missing_docs,
        reason = "undocumented before 2.1-Q217; document when this file is next touched"
    )]
    pub const ALL: &[Self] = &[
        Self::InvalidVersion,
        Self::UnsupportedVersion,
        Self::InvalidDocument,
    ];

    #[expect(
        missing_docs,
        reason = "undocumented before 2.1-Q217; document when this file is next touched"
    )]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidVersion => "invalid_version",
            Self::UnsupportedVersion => "unsupported_version",
            Self::InvalidDocument => "invalid_document",
        }
    }
}
/// Plant forms, what a plant gives, what it does, then abstract marks.
pub const PLANT_SYMBOL_IDS: &[&str] = &[
    "canopy",
    "conifer",
    "palm",
    "shrub",
    "herb",
    "grass",
    "bamboo",
    "fern",
    "climber",
    "groundcover",
    "rosette",
    "cactus",
    "apple",
    "nut",
    "berry",
    "grape",
    "flower",
    "pod",
    "carrot",
    "grain",
    "chili",
    "medicinal",
    "bee",
    "biomass",
    "timber",
    "fodder",
    "windbreak",
    "soil",
    "mushroom",
    "round",
    "square",
    "triangle",
    "cross",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum DesignFileFieldOwner {
    Document,
    Scene,
    Format,
}

impl DesignFileFieldOwner {
    #[expect(
        missing_docs,
        reason = "undocumented before 2.1-Q217; document when this file is next touched"
    )]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Document => "document",
            Self::Scene => "scene",
            Self::Format => "format",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct DesignFileField {
    pub key: &'static str,
    pub owner: DesignFileFieldOwner,
}

#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub const DESIGN_FILE_FIELDS: &[DesignFileField] = &[
    DesignFileField {
        key: "version",
        owner: DesignFileFieldOwner::Format,
    },
    DesignFileField {
        key: "name",
        owner: DesignFileFieldOwner::Document,
    },
    DesignFileField {
        key: "description",
        owner: DesignFileFieldOwner::Document,
    },
    DesignFileField {
        key: "plant_species_colors",
        owner: DesignFileFieldOwner::Scene,
    },
    DesignFileField {
        key: "plant_species_codes",
        owner: DesignFileFieldOwner::Scene,
    },
    DesignFileField {
        key: "plant_species_symbols",
        owner: DesignFileFieldOwner::Scene,
    },
    DesignFileField {
        key: "layers",
        owner: DesignFileFieldOwner::Scene,
    },
    DesignFileField {
        key: "plants",
        owner: DesignFileFieldOwner::Scene,
    },
    DesignFileField {
        key: "zones",
        owner: DesignFileFieldOwner::Scene,
    },
    DesignFileField {
        key: "annotations",
        owner: DesignFileFieldOwner::Scene,
    },
    DesignFileField {
        key: "measurement_guides",
        owner: DesignFileFieldOwner::Scene,
    },
    DesignFileField {
        key: "consortiums",
        owner: DesignFileFieldOwner::Document,
    },
    DesignFileField {
        key: "groups",
        owner: DesignFileFieldOwner::Scene,
    },
    DesignFileField {
        key: "timeline",
        owner: DesignFileFieldOwner::Document,
    },
    DesignFileField {
        key: "budget",
        owner: DesignFileFieldOwner::Document,
    },
    DesignFileField {
        key: "budget_currency",
        owner: DesignFileFieldOwner::Document,
    },
    DesignFileField {
        key: "budget_ext",
        owner: DesignFileFieldOwner::Document,
    },
    DesignFileField {
        key: "site_data",
        owner: DesignFileFieldOwner::Document,
    },
    DesignFileField {
        key: "plant_display",
        owner: DesignFileFieldOwner::Document,
    },
    DesignFileField {
        key: "print_setup",
        owner: DesignFileFieldOwner::Document,
    },
    DesignFileField {
        key: "views",
        owner: DesignFileFieldOwner::Document,
    },
    DesignFileField {
        key: "stories",
        owner: DesignFileFieldOwner::Document,
    },
    DesignFileField {
        key: "map_view",
        owner: DesignFileFieldOwner::Format,
    },
    DesignFileField {
        key: "created_at",
        owner: DesignFileFieldOwner::Document,
    },
    DesignFileField {
        key: "updated_at",
        owner: DesignFileFieldOwner::Format,
    },
];

/// The JSON Schema keywords the generated `CanopiFileV10` schema may use: the Web decoder and
/// the native admission walker interpret exactly these, and bindings-gen refuses any other.
/// Ungated, unlike the schema itself, so the format crate reads them without schemars and the
/// Web format worker's module carries none (canopi-f47t.52.270).
pub const CANOPI_SCHEMA_KEYWORDS: &[&str] = &[
    "$defs",
    "$ref",
    "$schema",
    "additionalProperties",
    "anyOf",
    "const",
    "default",
    "enum",
    "format",
    "items",
    "maximum",
    "minimum",
    "oneOf",
    "properties",
    "required",
    "title",
    "type",
];

/// The number formats the generated `CanopiFileV10` schema may use, with the keywords above.
pub const CANOPI_SCHEMA_FORMATS: &[&str] = &["double", "float", "int32", "uint32"];

/// Default ISO currency code for a Design's budget.
pub fn default_budget_currency() -> String {
    DEFAULT_BUDGET_CURRENCY.to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct DesignSummary {
    pub path: String,
    pub name: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<crate::ids::FileGrantId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recent_id: Option<String>,
}

/// Longest side of a [`DesignSketch`] frame, in sketch units.
pub const DESIGN_SKETCH_GRID: u16 = 1000;
/// At most this many plants are drawn in a sketch; larger Designs are sampled evenly.
pub const DESIGN_SKETCH_MAX_PLANTS: usize = 2000;
/// At most this many zone outline points are drawn in a sketch, across all zones.
pub const DESIGN_SKETCH_MAX_ZONE_POINTS: usize = 2000;

/// A north-up WGS84 box around a Design's plants and zones. `west == east` or
/// `south == north` when they sit on one line or point.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct DesignGroundBounds {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

/// One zone of a [`DesignSketch`]: `points` are flat `x, y` pairs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct DesignSketchZone {
    /// False for a line zone, which is drawn open.
    pub closed: bool,
    pub points: Vec<u16>,
}

/// A symbolic mini-map of a Design: zones as outlines and plants as dots over
/// its ground bounds, north up. Coordinates are sketch units in a
/// `width` × `height` frame whose longer side is [`DESIGN_SKETCH_GRID`]; `x`
/// grows east and `y` grows south, as on screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct DesignSketch {
    pub width: u16,
    pub height: u16,
    /// Flat `x, y` pairs, one per drawn plant.
    pub plants: Vec<u16>,
    pub zones: Vec<DesignSketchZone>,
}

/// What a Recent Design's file says about it, read when the list is shown.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum RecentDesignPreview {
    Read {
        plant_count: u32,
        zone_count: u32,
        /// `None` when the Design has no plants or zones yet.
        bounds: Option<DesignGroundBounds>,
        sketch: Option<DesignSketch>,
    },
    /// The file is larger than previews read; the row shows its name only.
    TooLarge,
    /// The file cannot be opened, and why when that is known.
    Unreadable {
        reason: RecentDesignUnreadableReason,
    },
}

/// Why a Recent Design's file cannot be opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RecentDesignUnreadableReason {
    /// Nothing is at the path any more: the file was moved, renamed or deleted.
    Missing,
    /// A Design older than the current format (written before Canopi 2.0),
    /// which Canopi 2.0 and later do not open (ADR 0021).
    OlderVersion,
    /// A Design from a newer file version than this build knows.
    NewerVersion,
    /// The file is not a valid Design (not JSON, or not a valid document).
    Damaged,
    /// The file exists but could not be read (permissions, a folder, an I/O error).
    Unknown,
}

/// A Recent Design's preview, keyed by its path on the list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct RecentDesignSummary {
    pub path: String,
    pub preview: RecentDesignPreview,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct DesignNotebookSection {
    pub id: String,
    pub name: String,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct DesignNotebookEntry {
    pub path: String,
    pub name: String,
    pub updated_at: String,
    pub plant_count: u32,
    pub section_id: Option<String>,
    pub sort_order: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct DesignNotebookSnapshot {
    pub entries: Vec<DesignNotebookEntry>,
    pub sections: Vec<DesignNotebookSection>,
}

mod session;
pub use session::{
    DesignDraftAccess, DesignDraftSummary, DesignLoadFailure, DesignLoadFailureKind,
    DesignSaveOutcome, LoadedDesign,
};

#[cfg(test)]
mod tests;
