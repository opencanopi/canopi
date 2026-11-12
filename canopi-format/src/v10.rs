//! The `.canopi` v10 read shape (contracts §10, 2.1-M481, 2.1-M482, 2.1-M491, 2.1-M493): the
//! form a reader-release build reads a v10 or later file by, and the schema the read admission
//! walks ([`read_schema`]). Step 2.0.4 R1-3 emits this schema once into `spec/v10/` and
//! freezes it; until then it is built from these types.
//!
//! v10's names and shapes beside v9 (2.1-Q314, 2.1-M482): `plants[].canopy_spread_m` (v9
//! `scale`; above 0, refused at its path, and a `scale` beside it is ignored); the root
//! `site_data` (v9 `lidar`), whose entry `kind` is ignored and resolved by id (2.1-M493); a
//! guide group member `{"kind": "measurement_guide", "id"}`; `plant_display` typed at its
//! root key, its `color_by` and `labels` open strings; a budget line `{target: {kind,
//! canonical_name}, unit_cost, ext?}` whose `target.kind` is an open string, a line whose
//! target is not a species being skipped (2.1-M491). An unknown key is ignored anywhere, the
//! root included. Every root field but `version` is optional with the default named beside
//! it. Objects v10 leaves as v9 read by their v9 types (R1-3's freeze sweeps their required
//! fields down to identity and geometry, 2.1-M481).
//!
//! Field comments are `//`, never `///`: schemars would emit a doc comment as a
//! `description` keyword, which `CANOPI_SCHEMA_KEYWORDS` leaves out.

use canopi_types::design::{
    Annotation, Consortium, GeoPoint, Layer, MeasurementGuide, TimelineAction, Zone,
};
use canopi_types::lidar::LidarColourRange;
use canopi_types::views::{SavedView, SavedViewCamera, Story};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

// A `.canopi` file of version 10 or later, as the reader release reads it.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(title = "CanopiFileRead")]
pub(crate) struct FileRead {
    // The format version the file was saved at.
    #[serde(deserialize_with = "json_u32")]
    pub(crate) version: u32,
    // Default: empty.
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) plant_species_colors: HashMap<String, String>,
    #[serde(default)]
    pub(crate) plant_species_symbols: HashMap<String, String>,
    #[serde(default)]
    pub(crate) plant_species_codes: HashMap<String, String>,
    // Each list defaults to empty.
    #[serde(default)]
    pub(crate) layers: Vec<Layer>,
    #[serde(default)]
    pub(crate) plants: Vec<PlantRead>,
    #[serde(default)]
    pub(crate) zones: Vec<Zone>,
    #[serde(default)]
    pub(crate) annotations: Vec<Annotation>,
    #[serde(default)]
    pub(crate) measurement_guides: Vec<MeasurementGuide>,
    #[serde(default)]
    pub(crate) consortiums: Vec<Consortium>,
    #[serde(default)]
    pub(crate) groups: Vec<GroupRead>,
    #[serde(default)]
    pub(crate) timeline: Vec<TimelineAction>,
    #[serde(default)]
    pub(crate) budget: Vec<BudgetLineRead>,
    // Default: EUR (`DEFAULT_BUDGET_CURRENCY`).
    #[serde(default = "canopi_types::design::default_budget_currency")]
    pub(crate) budget_currency: String,
    // v9 `lidar`. Default: none.
    #[serde(default)]
    pub(crate) site_data: Option<SiteDataRead>,
    // v9 `extra.plant_display`. Default: none, every option at its default.
    #[serde(default)]
    pub(crate) plant_display: Option<PlantDisplayRead>,
    #[serde(default)]
    pub(crate) views: Vec<SavedView>,
    #[serde(default)]
    pub(crate) stories: Vec<Story>,
    #[serde(default)]
    pub(crate) map_view: Option<SavedViewCamera>,
    // Default: empty.
    #[serde(default)]
    pub(crate) created_at: String,
    #[serde(default)]
    pub(crate) updated_at: String,
}

// A placed plant: identity, species and position required.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub(crate) struct PlantRead {
    pub(crate) id: String,
    pub(crate) canonical_name: String,
    pub(crate) position: GeoPoint,
    #[serde(default)]
    pub(crate) locked: bool,
    #[serde(default)]
    pub(crate) common_name: Option<String>,
    #[serde(default)]
    pub(crate) color: Option<String>,
    #[serde(default)]
    pub(crate) symbol: Option<String>,
    #[serde(default)]
    pub(crate) pinned_name: bool,
    #[serde(default)]
    pub(crate) rotation: Option<f64>,
    // v9 `scale`, in metres; above 0. Default: none, the species' own spread.
    #[serde(default)]
    pub(crate) canopy_spread_m: Option<f64>,
    #[serde(default)]
    pub(crate) notes: Option<String>,
    #[serde(default)]
    pub(crate) planted_date: Option<String>,
    #[serde(default, deserialize_with = "optional_json_u32")]
    pub(crate) quantity: Option<u32>,
}

// A named group of objects.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub(crate) struct GroupRead {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) locked: bool,
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) members: Vec<GroupMemberRead>,
}

// A group member by kind and id; v10 adds measurement guides (2.1-Q154, 2.1-M94).
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum GroupMemberRead {
    Plant { id: String },
    Zone { id: String },
    Annotation { id: String },
    MeasurementGuide { id: String },
}

// One budget line (2.1-M482): a species' unit cost; any other line is skipped (2.1-M491).
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub(crate) struct BudgetLineRead {
    pub(crate) target: BudgetTargetRead,
    // In the Design's `budget_currency`. Default: 0.
    #[serde(default)]
    pub(crate) unit_cost: f64,
}

// What a budget line prices: `kind` an open string, `species` naming `canonical_name`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub(crate) struct BudgetTargetRead {
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) canonical_name: Option<String>,
}

// The Site data section (v9 `lidar`).
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub(crate) struct SiteDataRead {
    // The Site data eye in Layers. Default: on.
    #[serde(default = "on")]
    pub(crate) visible: bool,
    #[serde(default)]
    pub(crate) entries: Vec<SiteDataEntryRead>,
}

// One Site data entry, a library item by id; its v9 `kind` is ignored, any value read
// (2.1-M493), and the item resolves by id alone.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub(crate) struct SiteDataEntryRead {
    pub(crate) id: String,
    // The item's stored name, shown when the library lacks it.
    pub(crate) name: String,
    // Default: on.
    #[serde(default = "on")]
    pub(crate) visible: bool,
    // Default: 1.
    #[serde(default = "opaque")]
    pub(crate) opacity: f32,
    // Lower draws further back. Default: 0.
    #[serde(default, deserialize_with = "json_u32")]
    pub(crate) order: u32,
    // An open string: a ramp this build does not know reads as the item's default.
    #[serde(default)]
    pub(crate) ramp: Option<String>,
    #[serde(default)]
    pub(crate) reversed: bool,
    // Default: none, the item's default range.
    #[serde(default)]
    pub(crate) range: Option<LidarColourRange>,
}

// Display on the map, typed at its root key (v9 `extra.plant_display`); `color_by` and
// `labels` are open strings, an unknown literal read as its default.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub(crate) struct PlantDisplayRead {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) color_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) one_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) symbol_scale: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) outline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) labels: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) stratum_colors: Option<HashMap<String, String>>,
}

fn on() -> bool {
    true
}

fn opaque() -> f32 {
    1.0
}

/// An unsigned 32-bit integer, written as JSON integer or integral float, as the schema
/// admits it.
fn json_u32<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    as_u32(&value).ok_or_else(|| serde::de::Error::custom("expected an unsigned 32-bit integer"))
}

fn optional_json_u32<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u32>, D::Error> {
    match Option::<serde_json::Value>::deserialize(deserializer)? {
        None => Ok(None),
        Some(value) => as_u32(&value)
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("expected an unsigned 32-bit integer")),
    }
}

fn as_u32(value: &serde_json::Value) -> Option<u32> {
    if let Some(integer) = value.as_u64() {
        return u32::try_from(integer).ok();
    }
    let float = value.as_f64()?;
    let integral = float.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&float);
    // Integral and within u32, so the cast is exact.
    integral.then_some(float as u32)
}

/// The v10 read schema the read admission walks, built once from the read shape; in tests a
/// keyword the walker does not interpret panics here.
pub fn read_schema() -> &'static serde_json::Value {
    static SCHEMA: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(|| {
        let schema = serde_json::Value::from(schemars::schema_for!(FileRead));
        #[cfg(test)]
        assert_eq!(crate::schema::unsupported_keyword(&schema), None);
        schema
    })
}
