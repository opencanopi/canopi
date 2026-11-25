//! The `.canopi` v10 typed Design model (contracts §10, ADR 0026; 2.1-Q36, 2.1-Q69,
//! 2.1-Q314, 2.1-M31, 2.1-M90, 2.1-M94, 2.1-M161, 2.1-M481, 2.1-M482, 2.1-M491, 2.1-M493,
//! 2.1-Q355, 2.1-Q356).
//!
//! `CanopiFileV10` is the single typed authority for v10 `.canopi` files, `spec/v10/schema.json`,
//! `spec/v10/fields.json`, and `spec/v10/additions/`. Every nested object keeps unknown keys in
//! its `extra` extension bag (`2.1-Q69`) so forward-compatible fields round-trip without loss.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::design::{
    Consortium, DesignFileField, DesignFileFieldOwner, GeoPoint, Layer, PanelTarget,
    default_budget_currency, deserialize_json_i32, deserialize_json_u32,
    deserialize_optional_json_u32,
};
use crate::lidar::LidarColourRange;
use crate::views::{SavedView, SavedViewCamera, Story};

/// Format version written by Canopi 2.1's Format Core.
pub const CANOPI_V10_VERSION: u32 = 10;

const fn v10_field(key: &'static str, owner: DesignFileFieldOwner) -> DesignFileField {
    DesignFileField { key, owner }
}

/// Every v10 root field and its authority owner (`2.1-M31`, contracts §10).
pub const DESIGN_FILE_FIELDS_V10: &[DesignFileField] = &[
    v10_field("version", DesignFileFieldOwner::Scene),
    v10_field("name", DesignFileFieldOwner::Document),
    v10_field("description", DesignFileFieldOwner::Document),
    v10_field("plant_species_colors", DesignFileFieldOwner::Scene),
    v10_field("plant_species_symbols", DesignFileFieldOwner::Scene),
    v10_field("plant_species_codes", DesignFileFieldOwner::Scene),
    v10_field("layers", DesignFileFieldOwner::Scene),
    v10_field("plants", DesignFileFieldOwner::Scene),
    v10_field("zones", DesignFileFieldOwner::Scene),
    v10_field("annotations", DesignFileFieldOwner::Scene),
    v10_field("measurement_guides", DesignFileFieldOwner::Scene),
    v10_field("consortiums", DesignFileFieldOwner::Document),
    v10_field("groups", DesignFileFieldOwner::Scene),
    v10_field("timeline", DesignFileFieldOwner::Document),
    v10_field("budget", DesignFileFieldOwner::Document),
    v10_field("budget_currency", DesignFileFieldOwner::Document),
    v10_field("budget_ext", DesignFileFieldOwner::Document),
    v10_field("site_data", DesignFileFieldOwner::Document),
    v10_field("plant_display", DesignFileFieldOwner::Document),
    v10_field("print_setup", DesignFileFieldOwner::Document),
    v10_field("views", DesignFileFieldOwner::Document),
    v10_field("stories", DesignFileFieldOwner::Document),
    v10_field("map_view", DesignFileFieldOwner::Scene),
    v10_field("created_at", DesignFileFieldOwner::Document),
    v10_field("updated_at", DesignFileFieldOwner::Scene),
    v10_field("extra", DesignFileFieldOwner::Document),
];

/// Structured refusal kind returned by the v10 Format Core (`contracts.md` §2 `:67`, §10 `:423`).
///
/// Tagged on the wire as `{"kind":"migration_failed","from":9}` for failed migration steps, and
/// `{"kind":"<variant>"}` for all other refusals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FormatLoadRefusalKind {
    /// File exceeded the 64 MiB admission cap.
    TooLarge,
    /// Input bytes were not valid UTF-8 JSON.
    InvalidJson,
    /// Format version is below the 2.0 floor (v9).
    OlderVersion,
    /// Format version is above the highest version this build writes (v10; `2.1-Q347`).
    NewerVersion,
    /// A pure migration step failed on its input (`design_load{migration_failed{from}}`).
    MigrationFailed {
        /// The format version the failing step was migrating from.
        from: u32,
    },
    /// Schema or semantic admission refused the document.
    InvalidDocument,
}

/// Typed v10 `.canopi` Design document (contracts §10, 2.1-M481, 2.1-M482).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CanopiFileV10 {
    /// Format version (`10`).
    #[serde(deserialize_with = "deserialize_json_u32")]
    pub version: u32,
    /// User-assigned Design name.
    #[serde(default)]
    pub name: String,
    /// Optional free-form Design description.
    #[serde(default)]
    pub description: Option<String>,
    /// Per-species colour overrides keyed by canonical species name.
    #[serde(default)]
    pub plant_species_colors: BTreeMap<String, String>,
    /// Per-species symbol overrides keyed by canonical species name.
    #[serde(default)]
    pub plant_species_symbols: BTreeMap<String, String>,
    /// Per-species short code overrides keyed by canonical species name.
    #[serde(default)]
    pub plant_species_codes: BTreeMap<String, String>,
    /// Scene layer visibility, lock, and opacity state.
    #[serde(default)]
    pub layers: Vec<Layer>,
    /// Placed plants in WGS84 coordinates.
    #[serde(default)]
    pub plants: Vec<PlacedPlantV10>,
    /// Zones in WGS84 coordinates.
    #[serde(default)]
    pub zones: Vec<ZoneV10>,
    /// Map annotations in WGS84 coordinates.
    #[serde(default)]
    pub annotations: Vec<AnnotationV10>,
    /// Measurement guides in WGS84 coordinates.
    #[serde(default)]
    pub measurement_guides: Vec<MeasurementGuideV10>,
    /// Plant consortiums.
    #[serde(default)]
    pub consortiums: Vec<Consortium>,
    /// Named object groups (plants, zones, annotations, measurement guides).
    #[serde(default)]
    pub groups: Vec<ObjectGroupV10>,
    /// Planned timeline care actions.
    #[serde(default)]
    pub timeline: Vec<TimelineActionV10>,
    /// Plant-only species budget lines (`2.1-Q96`, `2.1-M482`).
    #[serde(default)]
    pub budget: Vec<BudgetLineV10>,
    /// ISO currency code for the Design budget (default `EUR`).
    #[serde(default = "default_budget_currency")]
    pub budget_currency: String,
    /// Optional root extension bag for non-plant budget lines preserved by v9→v10 (`2.1-Q162`, `2.1-M491`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_ext: Option<BudgetExtV10>,
    /// Optional Site data presentation section (v9 `lidar`, `2.1-Q314`, `2.1-M493`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site_data: Option<SiteDataSectionV10>,
    /// Optional typed plant display preferences (promoted from v9 `extra.plant_display`, `2.1-Q69`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plant_display: Option<PlantDisplayV10>,
    /// Optional PDF print setup (v10 addition, `2.1-Q36`, `2.1-M90`, `2.1-M161`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub print_setup: Option<PrintSetupV10>,
    /// Named saved map views.
    #[serde(default)]
    pub views: Vec<SavedView>,
    /// Ordered presentations of saved views.
    #[serde(default)]
    pub stories: Vec<Story>,
    /// Last saved camera view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_view: Option<SavedViewCamera>,
    /// ISO-8601 creation timestamp.
    #[serde(default)]
    pub created_at: String,
    /// ISO-8601 last-update timestamp.
    #[serde(default)]
    pub updated_at: String,
    /// Forward-compatibility extension bag for unknown root fields (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Placed plant in v10 (`canopy_spread_m` replaces v9 `scale`, `2.1-Q314`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PlacedPlantV10 {
    /// Stable object id.
    pub id: String,
    /// Whether editing is locked.
    #[serde(default)]
    pub locked: bool,
    /// Botanical species name.
    pub canonical_name: String,
    /// Optional common name.
    #[serde(default)]
    pub common_name: Option<String>,
    /// Optional per-plant colour override.
    #[serde(default)]
    pub color: Option<String>,
    /// Optional per-plant symbol override.
    #[serde(default)]
    pub symbol: Option<String>,
    /// Whether the plant's label is pinned visible.
    #[serde(default)]
    pub pinned_name: bool,
    /// WGS84 position.
    pub position: GeoPoint,
    /// Optional clockwise rotation in degrees.
    #[serde(default)]
    pub rotation: Option<f64>,
    /// Canopy spread in metres (> 0, replaces v9 `scale`).
    #[serde(default)]
    pub canopy_spread_m: Option<f64>,
    /// Optional plant notes.
    #[serde(default)]
    pub notes: Option<String>,
    /// Optional ISO planting date.
    #[serde(default)]
    pub planted_date: Option<String>,
    /// Optional plant quantity.
    #[serde(default, deserialize_with = "deserialize_optional_json_u32")]
    pub quantity: Option<u32>,
    /// Extension bag for unknown plant keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Zone in v10, with optional `stroke_color` and `opacity` additions (`2.1-Q36`, `2.1-Q355`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ZoneV10 {
    /// Stable object id.
    pub id: String,
    /// Optional user-assigned name.
    #[serde(default)]
    pub name: Option<String>,
    /// Whether editing is locked.
    #[serde(default)]
    pub locked: bool,
    /// Zone geometry type (`polygon`, `line`, `rectangle`, `ellipse`).
    pub zone_type: String,
    /// WGS84 vertices or bounding corners.
    pub points: Vec<GeoPoint>,
    /// Clockwise rotation in degrees.
    #[serde(default)]
    pub rotation: f64,
    /// Optional fill colour.
    #[serde(default)]
    pub fill_color: Option<String>,
    /// Optional stroke colour (v10 addition, `2.1-Q355`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_color: Option<String>,
    /// Optional combined fill+stroke opacity in `[0, 1]` (v10 addition, `2.1-Q355`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    /// Optional zone notes.
    #[serde(default)]
    pub notes: Option<String>,
    /// Extension bag for unknown zone keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Annotation in v10 with extension bag (`2.1-Q69`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AnnotationV10 {
    /// Stable object id.
    pub id: String,
    /// Whether editing is locked.
    #[serde(default)]
    pub locked: bool,
    /// Annotation type (`text`, etc.).
    pub annotation_type: String,
    /// WGS84 anchor position.
    pub position: GeoPoint,
    /// Annotation text.
    #[serde(default)]
    pub text: String,
    /// Font size in points (> 0).
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    /// Optional clockwise rotation in degrees.
    #[serde(default)]
    pub rotation: Option<f64>,
    /// Extension bag for unknown annotation keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Measurement guide in v10 with extension bag (`2.1-Q69`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MeasurementGuideV10 {
    /// Stable object id.
    pub id: String,
    /// Whether editing is locked.
    #[serde(default)]
    pub locked: bool,
    /// WGS84 start point.
    pub start: GeoPoint,
    /// WGS84 end point.
    pub end: GeoPoint,
    /// Extension bag for unknown measurement guide keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Group member in v10, including `measurement_guide` (`2.1-Q154`, `2.1-M94`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ObjectGroupMemberV10 {
    /// Plant member by id.
    Plant {
        /// Referenced plant id.
        id: String,
    },
    /// Zone member by id.
    Zone {
        /// Referenced zone id.
        id: String,
    },
    /// Annotation member by id.
    Annotation {
        /// Referenced annotation id.
        id: String,
    },
    /// Measurement guide member by id (`2.1-Q154`).
    MeasurementGuide {
        /// Referenced measurement guide id.
        id: String,
    },
}

/// Named group of objects in v10 (`2.1-Q154`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ObjectGroupV10 {
    /// Stable group id.
    pub id: String,
    /// Whether editing is locked.
    #[serde(default)]
    pub locked: bool,
    /// Optional group name.
    #[serde(default)]
    pub name: Option<String>,
    /// Ordered group members.
    #[serde(default)]
    pub members: Vec<ObjectGroupMemberV10>,
    /// Extension bag for unknown group keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Timeline care action in v10 with optional `offset_days` addition (`2.1-Q36`, `2.1-Q155`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TimelineActionV10 {
    /// Stable action id.
    pub id: String,
    /// Action kind (`planting`, `pruning`, etc.).
    pub action_type: String,
    /// Action description.
    #[serde(default)]
    pub description: String,
    /// Optional ISO start date.
    #[serde(default)]
    pub start_date: Option<String>,
    /// Optional ISO end date.
    #[serde(default)]
    pub end_date: Option<String>,
    /// Optional day offset from stamp placement (v10 addition, `2.1-Q36`, `2.1-Q155`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_days: Option<i32>,
    /// Optional recurrence rule.
    #[serde(default)]
    pub recurrence: Option<String>,
    /// Referenced targets (default `[manual]`).
    #[serde(default = "default_manual_targets_v10")]
    pub targets: Vec<PanelTarget>,
    /// Optional dependency action ids.
    #[serde(default)]
    pub depends_on: Option<Vec<String>>,
    /// Completion state.
    #[serde(default)]
    pub completed: bool,
    /// Sort order.
    #[serde(default, deserialize_with = "deserialize_json_i32")]
    pub order: i32,
    /// Extension bag for unknown timeline keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Budget line target in v10 (`kind` is an open string, `2.1-M482`, `2.1-M491`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BudgetTargetV10 {
    /// Open target kind (`species` for plant lines).
    pub kind: String,
    /// Required non-empty canonical species name when `kind == "species"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_name: Option<String>,
    /// Extension bag for unknown target keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Plant budget line in v10 (`2.1-Q96`, `2.1-M482`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BudgetLineV10 {
    /// Target species (or future open-kind target).
    pub target: BudgetTargetV10,
    /// Unit cost in `budget_currency` (or `ext.currency` when foreign).
    #[serde(default)]
    pub unit_cost: f64,
    /// Extension bag holding v9 dropped fields (`category`, `description`, `quantity`, foreign `currency`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(skip)]
    pub ext: Option<serde_json::Value>,
    /// Extension bag for unknown budget-line keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Root budget extension bag holding non-plant lines preserved from v9 (`2.1-Q162`, `2.1-M491`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct BudgetExtV10 {
    /// Non-plant v9 budget lines kept unshown in 2.1.
    #[serde(default)]
    #[specta(skip)]
    pub non_plant_lines: Vec<serde_json::Value>,
    /// Extension bag for future budget extensions (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Site data presentation section in v10 (v9 `lidar`, `2.1-Q314`, `2.1-M493`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SiteDataSectionV10 {
    /// Master visibility toggle.
    #[serde(default = "default_true")]
    pub visible: bool,
    /// Ordered library presentation entries.
    #[serde(default)]
    pub entries: Vec<SiteDataEntryV10>,
    /// Extension bag for unknown site_data keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// One Site data presentation entry in v10 (`kind` dropped; resolved by `id`, `2.1-M493`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SiteDataEntryV10 {
    /// Library item id.
    pub id: String,
    /// Stored display name (shown when library lacks the item).
    pub name: String,
    /// Visibility toggle.
    #[serde(default = "default_true")]
    pub visible: bool,
    /// Opacity in `[0, 1]`.
    #[serde(default = "default_opaque")]
    pub opacity: f32,
    /// Draw order (lower draws further back).
    #[serde(default, deserialize_with = "deserialize_json_u32")]
    pub order: u32,
    /// Open colour ramp string (`2.1-Q69`).
    #[serde(default)]
    pub ramp: Option<String>,
    /// Whether the colour ramp is reversed.
    #[serde(default)]
    pub reversed: bool,
    /// Optional colour range.
    #[serde(default)]
    pub range: Option<LidarColourRange>,
    /// Extension bag for unknown entry keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Typed plant display preferences in v10 (`color_by` and `labels` are open strings, `2.1-Q69`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct PlantDisplayV10 {
    /// Open string naming colour-by mode.
    #[serde(default)]
    pub color_by: Option<String>,
    /// Open string naming label mode.
    #[serde(default)]
    pub labels: Option<String>,
    /// Optional symbol scale multiplier.
    #[serde(default)]
    pub symbol_scale: Option<f64>,
    /// Optional outline toggle.
    #[serde(default)]
    pub outline: Option<bool>,
    /// Extension bag for unknown plant_display keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

pub use super::v10_print::{
    AlongPageM, PrintAreaV10, PrintBoxFallback, PrintFramingV10, PrintPageV10, PrintScaleV10,
    PrintSetupV10, PrintSizeM, PrintSplitV10,
};

/// Emits the full v10 JSON Schema directly from [`CanopiFileV10`] (`2.1-M31`), stripped of
/// doc-only `description` keys so every keyword stays within [`crate::design::CANOPI_SCHEMA_KEYWORDS`].
#[cfg(feature = "design-schema")]
#[must_use]
pub fn canopi_file_v10_json_schema() -> serde_json::Value {
    let mut schema = serde_json::to_value(schemars::schema_for!(CanopiFileV10)).unwrap_or_default();
    strip_schema_descriptions(&mut schema);
    schema
}

/// Emits the typed `print_setup` JSON Schema directly from [`PrintSetupV10`] (`2.1-M161`).
#[cfg(feature = "design-schema")]
#[must_use]
pub fn print_setup_v10_json_schema() -> serde_json::Value {
    let mut schema = serde_json::to_value(schemars::schema_for!(PrintSetupV10)).unwrap_or_default();
    strip_schema_descriptions(&mut schema);
    schema
}

#[cfg(feature = "design-schema")]
fn strip_schema_descriptions(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            map.remove("description");
            for (key, v) in map.iter_mut() {
                if key == "properties" || key == "$defs" || key == "definitions" {
                    if let serde_json::Value::Object(entries) = v {
                        for entry in entries.values_mut() {
                            strip_schema_descriptions(entry);
                        }
                    }
                } else {
                    strip_schema_descriptions(v);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                strip_schema_descriptions(item);
            }
        }
        _ => {}
    }
}

fn default_font_size() -> f64 {
    14.0
}

fn default_true() -> bool {
    true
}

fn default_opaque() -> f32 {
    1.0
}

fn default_manual_targets_v10() -> Vec<PanelTarget> {
    vec![PanelTarget::Manual]
}
