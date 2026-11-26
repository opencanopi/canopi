//! Nested v10 `.canopi` structs with Q69 extension bags (`#[serde(flatten)] extra`) and
//! M481 defaults matching `canopi-format/spec/v10/read-schema.json` (`2.1-Q69`, `2.1-M481`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::design::deserialize_json_u32;

/// Target kind literal (`"species"`) for [`SpeciesPanelTargetV10`].
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum SpeciesPanelTargetKind {
    /// Species target.
    #[serde(rename = "species")]
    Species,
}

/// WGS84 point in v10 with Q69 extension bag (`2.1-Q69`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct GeoPointV10 {
    /// Longitude in degrees `[-180, 180]`.
    #[cfg_attr(
        feature = "design-schema",
        schemars(range(min = -180.0, max = 180.0))
    )]
    pub lon: f64,
    /// Latitude in degrees `[-85.0511287798066, 85.0511287798066]`.
    #[cfg_attr(
        feature = "design-schema",
        schemars(range(min = -85.0511287798066, max = 85.0511287798066))
    )]
    pub lat: f64,
    /// Extension bag for unknown point keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Design layer in v10 with M481 defaults and Q69 extension bag.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct LayerV10 {
    /// Layer name.
    pub name: String,
    /// Whether the layer is visible (default `true`).
    #[serde(default = "default_true")]
    pub visible: bool,
    /// Whether the layer is locked (default `false`).
    #[serde(default)]
    pub locked: bool,
    /// Layer opacity in `[0, 1]` (default `1.0`).
    #[serde(default = "default_opaque")]
    pub opacity: f64,
    /// Extension bag for unknown layer keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Species panel target in v10 with Q69 extension bag.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SpeciesPanelTargetV10 {
    /// Target kind (`"species"`).
    pub kind: SpeciesPanelTargetKind,
    /// Canonical species name.
    pub canonical_name: String,
    /// Extension bag for unknown target keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Consortium row in v10 with M481 defaults and Q69 extension bag.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ConsortiumV10 {
    /// Target species.
    pub target: SpeciesPanelTargetV10,
    /// Stratum name (default `"unassigned"`).
    #[serde(default = "default_stratum")]
    pub stratum: String,
    /// Start phase (default `0`).
    #[serde(default, deserialize_with = "deserialize_json_u32")]
    pub start_phase: u32,
    /// End phase (default `2`).
    #[serde(
        default = "default_end_phase",
        deserialize_with = "deserialize_json_u32"
    )]
    pub end_phase: u32,
    /// Extension bag for unknown consortium keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Panel target in v10 with Q69 extension bags on every variant.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PanelTargetV10 {
    /// Targets a placed plant by id.
    PlacedPlant {
        /// Plant id.
        plant_id: String,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// Targets a species by canonical name.
    Species {
        /// Canonical species name.
        canonical_name: String,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// Targets a zone by id.
    Zone {
        /// Zone id.
        zone_id: String,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// Manual target.
    Manual {
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// Untargeted.
    None {
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
}

/// LiDAR colour range in v10 with Q69 extension bags on every variant.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "mode")]
pub enum LidarColourRangeV10 {
    /// Full data range.
    Data {
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// Trimmed outlier range.
    CutOutliers {
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// Explicit min/max range.
    Custom {
        /// Minimum value.
        min: f64,
        /// Maximum value.
        max: f64,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
}

fn default_true() -> bool {
    true
}

fn default_opaque() -> f64 {
    1.0
}

fn default_stratum() -> String {
    "unassigned".to_owned()
}

fn default_end_phase() -> u32 {
    2
}
