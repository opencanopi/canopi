//! The `.canopi` Design file: its version policy, fields and their owners
//! (`DESIGN_FILE_FIELDS`), and the shapes it stores. Positions are WGS84
//! lon/lat (ADR 0001).

use serde::{Deserialize, Serialize};
use specta::Type;

mod admission;
pub mod field_path;
pub use admission::{admit_design_identities_and_ranges, validate_design_geometry};

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
pub const CURRENT_CANOPI_FILE_VERSION: u32 = 9;
/// Missing versions are interpreted as the first public `.canopi` format.
pub const MISSING_CANOPI_FILE_VERSION: u32 = 1;
/// What the reader release does with a file newer than [`CURRENT_CANOPI_FILE_VERSION`] (the corpus fact
/// `future_version_policy`): it opens read-only, never written (2.1-M478, 2.1-M481; Step 2.0.4).
pub const FUTURE_CANOPI_FILE_VERSION_POLICY: &str = "newer_read_only";
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub const WEB_MERCATOR_MAX_LATITUDE_DEG: f64 = 85.051_128_779_806_6;

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
        owner: DesignFileFieldOwner::Scene,
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
        key: "lidar",
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
        owner: DesignFileFieldOwner::Scene,
    },
    DesignFileField {
        key: "created_at",
        owner: DesignFileFieldOwner::Document,
    },
    DesignFileField {
        key: "updated_at",
        owner: DesignFileFieldOwner::Scene,
    },
    DesignFileField {
        key: "extra",
        owner: DesignFileFieldOwner::Document,
    },
];

#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct CanopiFile {
    #[serde(deserialize_with = "deserialize_json_u32")]
    pub version: u32,
    pub name: String,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub description: Option<String>,
    pub plant_species_colors: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub plant_species_symbols: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub plant_species_codes: std::collections::HashMap<String, String>,
    pub layers: Vec<Layer>,
    pub plants: Vec<PlacedPlant>,
    pub zones: Vec<Zone>,
    pub annotations: Vec<Annotation>,
    #[serde(default)]
    pub measurement_guides: Vec<MeasurementGuide>,
    pub consortiums: Vec<Consortium>,
    pub groups: Vec<ObjectGroup>,
    pub timeline: Vec<TimelineAction>,
    pub budget: Vec<BudgetItem>,
    #[serde(default = "default_budget_currency")]
    pub budget_currency: String,
    // Ordered LiDAR presentation references owned by the shared library; the
    // document stores display settings only, never raster bytes or paths.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lidar: Option<crate::lidar::LidarPresentationSection>,
    // Named map views (ADR 0011).
    #[serde(default)]
    pub views: Vec<crate::views::SavedView>,
    // Ordered presentations of saved views (ADR 0011).
    #[serde(default)]
    pub stories: Vec<crate::views::Story>,
    // The view the Design was last saved with: opening it restores this view
    // by the saved-view rule. Absent in a Design saved before 2.0 wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_view: Option<crate::views::SavedViewCamera>,
    pub created_at: String,
    pub updated_at: String,
    /// Preserves unknown fields for forward compatibility — round-trips fields
    /// from newer file versions that this build doesn't know about yet.
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

#[expect(
    clippy::expect_used,
    reason = "schema serialization of an authored type cannot fail"
)]
#[cfg(feature = "design-schema")]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub fn canopi_file_json_schema() -> serde_json::Value {
    serde_json::to_value(schemars::schema_for!(CanopiFile))
        .expect("CanopiFile JSON Schema should serialize")
}

/// The JSON Schema keywords the generated `CanopiFile` schema may use: the Web decoder and
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

/// The number formats the generated `CanopiFile` schema may use, with the keywords above.
pub const CANOPI_SCHEMA_FORMATS: &[&str] = &["double", "float", "int32", "uint32"];

#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct Layer {
    pub name: String,
    pub visible: bool,
    pub locked: bool,
    pub opacity: f32,
}

#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct PlacedPlant {
    pub id: String,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub locked: bool,
    pub canonical_name: String,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub common_name: Option<String>,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub color: Option<String>,
    #[serde(default)]
    pub symbol: Option<String>,
    #[serde(default)]
    pub pinned_name: bool,
    pub position: GeoPoint,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub rotation: Option<f64>,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub scale: Option<f64>,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub notes: Option<String>,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub planted_date: Option<String>,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub quantity: Option<u32>,
}

#[derive(Deserialize)]
struct PlacedPlantInput {
    id: String,
    #[serde(default)]
    locked: bool,
    canonical_name: String,
    common_name: Option<String>,
    color: Option<String>,
    #[serde(default)]
    symbol: Option<String>,
    #[serde(default)]
    pinned_name: bool,
    position: GeoPoint,
    rotation: Option<f64>,
    scale: Option<f64>,
    notes: Option<String>,
    planted_date: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_json_u32")]
    quantity: Option<u32>,
}

impl<'de> Deserialize<'de> for PlacedPlant {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let input = PlacedPlantInput::deserialize(deserializer)?;
        Ok(Self {
            id: input.id,
            locked: input.locked,
            canonical_name: input.canonical_name,
            common_name: input.common_name,
            color: input.color,
            symbol: input.symbol,
            pinned_name: input.pinned_name,
            position: input.position,
            rotation: input.rotation,
            scale: input.scale,
            notes: input.notes,
            planted_date: input.planted_date,
            quantity: input.quantity,
        })
    }
}

// A WGS84 position in degrees. Every persisted design object position is a
// `GeoPoint`; metres exist only in the runtime's session plane.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct GeoPoint {
    #[cfg_attr(
        feature = "design-schema",
        schemars(range(min = -180.0, max = 180.0))
    )]
    pub lon: f64,
    #[cfg_attr(
        feature = "design-schema",
        schemars(range(min = -85.0511287798066, max = 85.0511287798066))
    )]
    pub lat: f64,
}

#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct Zone {
    // Stable identity: Calendar and Budget targets, groups and saved views
    // refer to it. Renaming a zone never changes it.
    pub id: String,
    // Display name the user gave; `None` until then, and the interface labels
    // the zone by its type and size.
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub name: Option<String>,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub locked: bool,
    pub zone_type: String,
    // Polygon and line zones list their vertices. Rectangle and ellipse zones
    // list opposite corners of their unrotated bounding box.
    pub points: Vec<GeoPoint>,
    // Degrees clockwise from true north, about the zone's centre.
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub rotation: f64,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub fill_color: Option<String>,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub notes: Option<String>,
}

#[derive(Deserialize)]
struct ZoneInput {
    id: String,
    name: Option<String>,
    #[serde(default)]
    locked: bool,
    zone_type: String,
    points: Vec<GeoPoint>,
    #[serde(default)]
    rotation: f64,
    fill_color: Option<String>,
    notes: Option<String>,
}

impl<'de> Deserialize<'de> for Zone {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let input = ZoneInput::deserialize(deserializer)?;
        Ok(Self {
            id: input.id,
            name: input.name,
            locked: input.locked,
            zone_type: input.zone_type,
            points: input.points,
            rotation: input.rotation,
            fill_color: input.fill_color,
            notes: input.notes,
        })
    }
}

#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct Annotation {
    pub id: String,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub locked: bool,
    pub annotation_type: String,
    pub position: GeoPoint,
    pub text: String,
    pub font_size: f64,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub rotation: Option<f64>,
}

#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct MeasurementGuide {
    pub id: String,
    #[serde(default)]
    pub locked: bool,
    pub start: GeoPoint,
    pub end: GeoPoint,
}

#[derive(Deserialize)]
struct AnnotationInput {
    id: String,
    #[serde(default)]
    locked: bool,
    annotation_type: String,
    position: GeoPoint,
    text: String,
    font_size: f64,
    rotation: Option<f64>,
}

impl<'de> Deserialize<'de> for Annotation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let input = AnnotationInput::deserialize(deserializer)?;
        Ok(Self {
            id: input.id,
            locked: input.locked,
            annotation_type: input.annotation_type,
            position: input.position,
            text: input.text,
            font_size: input.font_size,
            rotation: input.rotation,
        })
    }
}

#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct Consortium {
    pub target: SpeciesPanelTarget,
    pub stratum: String,
    #[serde(deserialize_with = "deserialize_json_u32")]
    pub start_phase: u32,
    #[serde(deserialize_with = "deserialize_json_u32")]
    pub end_phase: u32,
}

#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(tag = "kind")]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum PanelTarget {
    #[serde(rename = "placed_plant")]
    PlacedPlant { plant_id: String },
    #[serde(rename = "species")]
    Species { canonical_name: String },
    #[serde(rename = "zone")]
    Zone { zone_id: String },
    #[default]
    #[serde(rename = "manual")]
    Manual,
    #[serde(rename = "none")]
    None,
}

#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct SpeciesPanelTarget {
    pub kind: SpeciesPanelTargetKind,
    pub canonical_name: String,
}

#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum SpeciesPanelTargetKind {
    #[serde(rename = "species")]
    Species,
}

#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct TimelineAction {
    pub id: String,
    pub action_type: String,
    pub description: String,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub start_date: Option<String>,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub end_date: Option<String>,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub recurrence: Option<String>,
    #[serde(default = "default_manual_targets")]
    pub targets: Vec<PanelTarget>,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub depends_on: Option<Vec<String>>,
    pub completed: bool,
    #[serde(deserialize_with = "deserialize_json_i32")]
    pub order: i32,
}

#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct BudgetItem {
    #[serde(default = "default_manual_target")]
    pub target: PanelTarget,
    pub category: String,
    pub description: String,
    pub quantity: f64,
    pub unit_cost: f64,
    pub currency: String,
}

fn default_manual_target() -> PanelTarget {
    PanelTarget::Manual
}

fn default_manual_targets() -> Vec<PanelTarget> {
    vec![PanelTarget::Manual]
}

#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub fn default_budget_currency() -> String {
    DEFAULT_BUDGET_CURRENCY.to_owned()
}

#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind")]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum ObjectGroupMember {
    #[serde(rename = "plant")]
    Plant { id: String },
    #[serde(rename = "zone")]
    Zone { id: String },
    #[serde(rename = "annotation")]
    Annotation { id: String },
}

#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct ObjectGroup {
    pub id: String,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub locked: bool,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub name: Option<String>,
    pub members: Vec<ObjectGroupMember>,
}

#[derive(Deserialize)]
struct ObjectGroupSerdeInput {
    id: String,
    #[serde(default)]
    locked: bool,
    name: Option<String>,
    members: Vec<ObjectGroupMember>,
}

impl<'de> Deserialize<'de> for ObjectGroup {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let input = ObjectGroupSerdeInput::deserialize(deserializer)?;
        Ok(Self {
            id: input.id,
            locked: input.locked,
            name: input.name,
            members: input.members,
        })
    }
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
    /// Saved by a newer Canopi and read for the read-only view (2.1-Q316): the row is labelled
    /// "Read-only: saved by a newer Canopi", never "update Canopi to open it", with what the
    /// read view shows of it.
    ReadOnly {
        /// The format version the file was saved at, above [`CURRENT_CANOPI_FILE_VERSION`].
        saved_by_version: u32,
        plant_count: u32,
        zone_count: u32,
        /// `None` when the Design has no plants or zones yet.
        bounds: Option<DesignGroundBounds>,
        sketch: Option<DesignSketch>,
    },
    /// The file is larger than previews read; the row shows its name, and says it is
    /// read-only when a newer Canopi saved it and Open still reads it (2.1-Q316).
    TooLarge {
        /// Saved by a newer Canopi, within the size Open reads: Open shows it read-only.
        saved_by_newer: bool,
    },
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

/// A Design read from a file, with the fingerprint (SHA-256 of the file's
/// bytes) its next continuous save must still find on disk.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct LoadedDesign {
    pub file: CanopiFile,
    pub fingerprint: String,
}

/// A Design saved by a newer Canopi, read for the read-only view (contracts §11 Rollback, 2.1-M478, 2.1-M479):
/// `view` is its read projection in the in-memory shape this build draws, `saved_by_version` the file's format
/// version. A distinct type on purpose: no save, Draft or export API takes it or its `view`, so a v10 Design never
/// reaches 2.0 persistence (held by R1's type rule).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ReadOnlyDesign {
    /// The Design as the read view maps it onto this build's shape, shown and never written.
    pub view: CanopiFile,
    /// The format version the file was saved at, above [`CURRENT_CANOPI_FILE_VERSION`].
    pub saved_by_version: u32,
}

/// Why a Design file could not be opened. `kind` is what the interface maps
/// to a message; `message` is for logs and Problem Reports and never names a
/// path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct DesignLoadFailure {
    pub kind: DesignLoadFailureKind,
    pub message: String,
    /// The refused field when the file parsed and the Design was refused (`$.version` for a
    /// version this build does not open), for the failure ring and Problem Reports
    /// only: the refusal the user reads never names it (2.1-Q286, canopi-cyqd).
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub field_path: Option<field_path::FieldPath>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum DesignLoadFailureKind {
    /// Nothing is at the path.
    Missing,
    /// The file exists but could not be read (permissions, a folder, an I/O error).
    Unreadable,
    TooLarge,
    InvalidJson,
    /// Older than the current format (written before Canopi 2.0), which
    /// Canopi 2.0 and later do not open (ADR 0021).
    OlderVersion,
    /// Newer than this build.
    NewerVersion,
    InvalidDocument,
    /// The native side failed before it reached the file (an executor error).
    Internal,
}

/// The result of writing a Design to its file.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum DesignSaveOutcome {
    /// Written; `fingerprint` is what the next save must expect.
    Saved { path: String, fingerprint: String },
    /// The file changed outside Canopi since `expected_fingerprint`; nothing
    /// was written. `current_fingerprint` is `None` when the file is gone.
    Conflict { current_fingerprint: Option<String> },
}

/// A Design draft: an unsaved (Untitled) Design kept in app data until the
/// user saves it as a file or deletes it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct DesignDraftSummary {
    pub id: String,
    pub name: String,
    pub updated_at: String,
    /// Whether opening the Draft edits it, shows it read-only, or refuses it (2.1-Q316). Absent on
    /// the wire for an editable Draft, the common case; a newer Draft always carries it.
    #[serde(default, skip_serializing_if = "DesignDraftAccess::is_editable")]
    #[specta(optional)]
    pub access: DesignDraftAccess,
}

/// How a listed Draft opens (2.1-Q316). Only an `Editable` Draft is ever opened for editing or
/// deleted; the store refuses writes to the others (design check F7).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DesignDraftAccess {
    /// A current Draft: it opens for editing.
    #[default]
    Editable,
    /// Saved by a newer Canopi and read for the read-only view: listed as
    /// "Read-only: saved by a newer Canopi".
    ReadOnly,
    /// Saved by a newer Canopi whose read this build refuses: listed as unreadable, never
    /// hidden, and opening it says why.
    Unreadable,
}

impl DesignDraftAccess {
    /// Whether the Draft opens for editing; the wire omits `access` then.
    #[must_use]
    pub fn is_editable(&self) -> bool {
        *self == Self::Editable
    }
}

#[cfg(test)]
mod tests;
