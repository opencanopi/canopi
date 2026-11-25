//! A Saved Object Stamp: a named, ordered payload of placed objects kept in
//! the user database for reuse across Designs (contracts §11; ADR 0026; 2.1-Q155, 2.1-M88).
//!
//! **Casing note (2.1-M88):** Legacy v2 stamp payloads (`SavedObjectStampPayloadV2`) use
//! camelCase field names (`canonicalName`, `rotationDeg`, `zoneType`, `fillColor`,
//! `annotationType`, `fontSize`) as originally written by the Web/Desktop 2.0 TS codec.
//! v3 stamp payloads (`SavedObjectStampPayload`) intentionally standardise on snake_case
//! (`canonical_name`, `rotation_deg`, `zone_type`, etc.) to align with `.canopi` v10 and
//! generated Rust/TS contracts; every v3 struct also carries an `extra` extension bag
//! (`2.1-Q69`) so unknown keys from future additions round-trip cleanly.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

/// Lowest saved-stamp payload version migrated by this build (Canopi 2.0).
pub const STAMP_PAYLOAD_FLOOR: u32 = 2;

/// Current saved-stamp payload version written by Canopi 2.1 (`2.1-M88`).
pub const STAMP_PAYLOAD_CURRENT: u32 = 3;

/// Maximum serialized byte size for a saved-stamp payload (`stamp_too_large{limit}`, contracts §11).
pub const MAX_STAMP_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;

/// A Saved Object Stamp row in the user database.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct SavedObjectStamp {
    pub id: String,
    pub name: String,
    pub payload_json: String,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
    /// The payload is newer than this build reads (above v2): listed as needing a newer Canopi, never placed,
    /// renamed, reordered or deleted (2.1-M88). Computed by the owner's listing query; absent reads as false.
    #[serde(default)]
    #[specta(optional)]
    pub needs_newer: bool,
}

/// Relative metre point in a saved-stamp arrangement (ADR 0001).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
pub struct StampPoint {
    /// East offset in ground metres from the stamp anchor.
    pub x: f64,
    /// North offset in ground metres from the stamp anchor.
    pub y: f64,
}

/// One placed plant inside a v3 saved-stamp payload.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct StampPlant {
    /// Plant id within the stamp.
    pub id: String,
    /// Botanical species name.
    pub canonical_name: String,
    /// Optional common name.
    #[serde(default)]
    pub common_name: Option<String>,
    /// Optional colour override.
    #[serde(default)]
    pub color: Option<String>,
    /// Optional symbol override.
    #[serde(default)]
    pub symbol: Option<String>,
    /// Whether the plant's name label is pinned.
    #[serde(default)]
    pub pinned_name: bool,
    /// Whether the plant is locked.
    #[serde(default)]
    pub locked: bool,
    /// Relative metre position.
    pub position: StampPoint,
    /// Optional clockwise rotation in degrees.
    #[serde(default)]
    pub rotation_deg: Option<f64>,
    /// Optional canopy spread in metres (> 0).
    #[serde(default)]
    pub canopy_spread_m: Option<f64>,
    /// Optional notes.
    #[serde(default)]
    pub notes: Option<String>,
    /// Extension bag for unknown plant keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// One zone inside a v3 saved-stamp payload.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct StampZone {
    /// Zone id within the stamp.
    pub id: String,
    /// Optional zone name.
    #[serde(default)]
    pub name: Option<String>,
    /// Whether the zone is locked.
    #[serde(default)]
    pub locked: bool,
    /// Zone geometry kind.
    pub zone_type: String,
    /// Relative metre vertices.
    pub points: Vec<StampPoint>,
    /// Clockwise rotation in degrees.
    #[serde(default)]
    pub rotation_deg: f64,
    /// Optional fill colour.
    #[serde(default)]
    pub fill_color: Option<String>,
    /// Optional stroke colour (v10 addition).
    #[serde(default)]
    pub stroke_color: Option<String>,
    /// Optional combined opacity in `[0, 1]` (v10 addition).
    #[serde(default)]
    pub opacity: Option<f64>,
    /// Optional notes.
    #[serde(default)]
    pub notes: Option<String>,
    /// Extension bag for unknown zone keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// One annotation inside a v3 saved-stamp payload.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct StampAnnotation {
    /// Annotation id within the stamp.
    pub id: String,
    /// Whether the annotation is locked.
    #[serde(default)]
    pub locked: bool,
    /// Annotation kind (`text`, etc.).
    pub annotation_type: String,
    /// Relative metre position.
    pub position: StampPoint,
    /// Annotation text.
    pub text: String,
    /// Font size in points (> 0).
    pub font_size: f64,
    /// Optional clockwise rotation in degrees.
    #[serde(default)]
    pub rotation_deg: Option<f64>,
    /// Extension bag for unknown annotation keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// One measurement guide inside a v3 saved-stamp payload (`2.1-M88`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct StampGuide {
    /// Measurement guide id within the stamp.
    pub id: String,
    /// Whether the guide is locked.
    #[serde(default)]
    pub locked: bool,
    /// Start point in relative metres.
    pub start: StampPoint,
    /// End point in relative metres.
    pub end: StampPoint,
    /// Extension bag for unknown guide keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Member reference inside a v3 stamp group.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StampGroupMember {
    /// Plant member.
    Plant {
        /// Referenced plant id.
        id: String,
    },
    /// Zone member.
    Zone {
        /// Referenced zone id.
        id: String,
    },
    /// Annotation member.
    Annotation {
        /// Referenced annotation id.
        id: String,
    },
    /// Measurement guide member (`2.1-Q154`).
    MeasurementGuide {
        /// Referenced guide id.
        id: String,
    },
}

/// One object group inside a v3 saved-stamp payload.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct StampGroup {
    /// Group id within the stamp.
    pub id: String,
    /// Whether the group is locked.
    #[serde(default)]
    pub locked: bool,
    /// Optional group name.
    #[serde(default)]
    pub name: Option<String>,
    /// Group members.
    pub members: Vec<StampGroupMember>,
    /// Extension bag for unknown group keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Species consortium entry carried inside a v3 stamp (`2.1-Q155`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct StampConsortium {
    /// Canonical species name.
    pub canonical_name: String,
    /// Stratum name.
    pub stratum: String,
    /// Start phase.
    pub start_phase: i32,
    /// End phase.
    pub end_phase: i32,
    /// Extension bag for unknown consortium keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Species unit cost carried inside a v3 stamp (`2.1-Q155`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct StampBudgetLine {
    /// Canonical species name.
    pub canonical_name: String,
    /// Unit cost in the destination Design's currency.
    pub unit_cost: f64,
    /// Extension bag for unknown budget-line keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Care action carried inside a v3 stamp (`2.1-Q155`, `2.1-Q36`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct StampCareAction {
    /// Care action id within the stamp.
    pub id: String,
    /// Action type.
    pub action_type: String,
    /// Action description.
    pub description: String,
    /// Optional day offset from placement (v10 `TimelineAction.offset_days` addition).
    #[serde(default)]
    pub offset_days: Option<i32>,
    /// Optional recurrence rule.
    #[serde(default)]
    pub recurrence: Option<String>,
    /// Target references remapped at placement.
    #[serde(default)]
    pub targets: Vec<crate::design::PanelTarget>,
    /// Extension bag for unknown care-action keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Saved Object Stamp payload v3 (contracts §11; `2.1-M88`, `2.1-Q155`).
///
/// Uses snake_case keys (unlike v2's camelCase) and carries `extra` extension bags (`2.1-Q69`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SavedObjectStampPayload {
    /// Payload version (`3`).
    pub version: u32,
    /// Relative anchor point in metres.
    pub anchor: StampPoint,
    /// Placed plants.
    #[serde(default)]
    pub plants: Vec<StampPlant>,
    /// Zones.
    #[serde(default)]
    pub zones: Vec<StampZone>,
    /// Annotations.
    #[serde(default)]
    pub annotations: Vec<StampAnnotation>,
    /// Measurement guides (`2.1-M88`).
    #[serde(default)]
    pub measurement_guides: Vec<StampGuide>,
    /// Object groups.
    #[serde(default)]
    pub groups: Vec<StampGroup>,
    /// Species colour overrides (`2.1-Q155`).
    #[serde(default)]
    pub plant_species_colors: BTreeMap<String, String>,
    /// Species symbol overrides (`2.1-Q155`).
    #[serde(default)]
    pub plant_species_symbols: BTreeMap<String, String>,
    /// Species code overrides (`2.1-Q155`).
    #[serde(default)]
    pub plant_species_codes: BTreeMap<String, String>,
    /// Species consortium strata (`2.1-Q155`).
    #[serde(default)]
    pub consortiums: Vec<StampConsortium>,
    /// Species unit-cost lines (`2.1-Q155`).
    #[serde(default)]
    pub budget: Vec<StampBudgetLine>,
    /// Care actions with relative offset / recurrence (`2.1-Q155`).
    #[serde(default)]
    pub timeline: Vec<StampCareAction>,
    /// Extension bag for unknown root keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Legacy v2 saved-stamp plant shape (camelCase, Canopi 2.0) used to emit the frozen v2 schema.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StampPlantV2 {
    /// Plant id.
    pub id: String,
    /// Botanical species name.
    pub canonical_name: String,
    /// Optional common name.
    #[serde(default)]
    pub common_name: Option<String>,
    /// Optional colour.
    #[serde(default)]
    pub color: Option<String>,
    /// Optional symbol.
    #[serde(default)]
    pub symbol: Option<String>,
    /// Relative metre position.
    pub position: StampPoint,
    /// Optional rotation in degrees.
    #[serde(default)]
    pub rotation_deg: Option<f64>,
    /// Optional scale (renamed to `canopy_spread_m` in v3).
    #[serde(default)]
    pub scale: Option<f64>,
}

/// Legacy v2 saved-stamp zone shape (camelCase, Canopi 2.0).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StampZoneV2 {
    /// Zone id.
    pub id: String,
    /// Optional zone name.
    #[serde(default)]
    pub name: Option<String>,
    /// Zone type.
    pub zone_type: String,
    /// Relative metre points.
    pub points: Vec<StampPoint>,
    /// Rotation in degrees.
    #[serde(default)]
    pub rotation_deg: f64,
    /// Optional fill colour.
    #[serde(default)]
    pub fill_color: Option<String>,
}

/// Legacy v2 saved-stamp annotation shape (camelCase, Canopi 2.0).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StampAnnotationV2 {
    /// Annotation id.
    pub id: String,
    /// Annotation type.
    pub annotation_type: String,
    /// Relative metre position.
    pub position: StampPoint,
    /// Text content.
    pub text: String,
    /// Font size in points.
    pub font_size: f64,
    /// Optional rotation in degrees.
    #[serde(default)]
    pub rotation_deg: Option<f64>,
}

/// Legacy v2 saved-stamp payload shape (camelCase, Canopi 2.0) used to emit `spec/stamps/v2/schema.json`.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedObjectStampPayloadV2 {
    /// Payload version (`2`).
    pub version: u32,
    /// Relative anchor point.
    pub anchor: StampPoint,
    /// Placed plants.
    #[serde(default)]
    pub plants: Vec<StampPlantV2>,
    /// Zones.
    #[serde(default)]
    pub zones: Vec<StampZoneV2>,
    /// Annotations.
    #[serde(default)]
    pub annotations: Vec<StampAnnotationV2>,
    /// Object groups.
    #[serde(default)]
    pub groups: Vec<serde_json::Value>,
}

/// Emits the frozen v2 saved-stamp payload JSON Schema (`contracts.md` §11).
#[cfg(feature = "design-schema")]
#[must_use]
pub fn stamp_payload_v2_json_schema() -> serde_json::Value {
    serde_json::to_value(schemars::schema_for!(SavedObjectStampPayloadV2)).unwrap_or_default()
}

/// Emits the v3 saved-stamp payload JSON Schema (`contracts.md` §11).
#[cfg(feature = "design-schema")]
#[must_use]
pub fn stamp_payload_v3_json_schema() -> serde_json::Value {
    serde_json::to_value(schemars::schema_for!(SavedObjectStampPayload)).unwrap_or_default()
}
