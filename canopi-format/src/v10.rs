//! The `.canopi` v10 read shape (contracts §10, 2.1-M481, 2.1-M482, 2.1-M491, 2.1-M493): the
//! form a reader-release build reads a v10 or later file by, and the schema the read admission
//! walks ([`read_schema`]), which schemars emitted once from these types into
//! `spec/v10/read-schema.json` and Step 2.0.4 froze (2.1-M31): serde reads by these types,
//! the walker by the frozen file.
//!
//! v10's names and shapes beside v9 (2.1-Q314, 2.1-M482): `plants[].canopy_spread_m` (v9
//! `scale`; above 0, refused at its path, and a `scale` beside it is ignored); the root
//! `site_data` (v9 `lidar`), whose entry `kind` is ignored and resolved by id (2.1-M493); a
//! guide group member `{"kind": "measurement_guide", "id"}`; `plant_display` typed at its
//! root key, its `color_by` and `labels` open strings; a budget line `{target: {kind,
//! canonical_name}, unit_cost, ext?}` whose `target.kind` is an open string, a line whose
//! target is not a species being skipped (2.1-M491) and a species line without its
//! `canonical_name` refused at that path. An unknown key is ignored anywhere, the
//! root included. Only identity and geometry are required (2.1-M481): every other field
//! is optional with the default the frozen schema documents beside it. Objects v10 leaves as
//! v9 read by their v9 types, which require more: the read sets each absent field to its
//! documented default ([`crate::schema::fill_defaults`]) before serde reads it.

use canopi_types::design::{
    Annotation, Consortium, GeoPoint, Layer, MeasurementGuide, TimelineAction, Zone,
};
use canopi_types::lidar::LidarColourRange;
use canopi_types::views::{SavedView, SavedViewCamera, Story};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

// A `.canopi` file of version 10 or later, as the reader release reads it.
#[derive(Debug, Serialize, Deserialize)]
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
#[derive(Debug, Serialize, Deserialize)]
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
#[derive(Debug, Serialize, Deserialize)]
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
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum GroupMemberRead {
    Plant { id: String },
    Zone { id: String },
    Annotation { id: String },
    MeasurementGuide { id: String },
}

// One budget line (2.1-M482): a species' unit cost; any other line is skipped (2.1-M491).
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct BudgetLineRead {
    pub(crate) target: BudgetTargetRead,
    // In the Design's `budget_currency`. Default: 0.
    #[serde(default)]
    pub(crate) unit_cost: f64,
}

// What a budget line prices: `kind` an open string, `species` naming `canonical_name`.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct BudgetTargetRead {
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) canonical_name: Option<String>,
}

// The Site data section (v9 `lidar`).
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct SiteDataRead {
    // The Site data eye in Layers. Default: on.
    #[serde(default = "on")]
    pub(crate) visible: bool,
    #[serde(default)]
    pub(crate) entries: Vec<SiteDataEntryRead>,
}

// One Site data entry, a library item by id; its v9 `kind` is ignored, any value read
// (2.1-M493), and the item resolves by id alone.
#[derive(Debug, Serialize, Deserialize)]
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
#[derive(Debug, Serialize, Deserialize)]
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

/// The frozen v10 read schema the read admission walks (`spec/v10/read-schema.json`), parsed
/// once; `None` only if the file built in were no JSON, which a test rules out.
pub fn read_schema() -> Option<&'static serde_json::Value> {
    static SCHEMA: std::sync::OnceLock<Option<serde_json::Value>> = std::sync::OnceLock::new();
    SCHEMA
        .get_or_init(|| serde_json::from_str(FROZEN_READ_SCHEMA).ok())
        .as_ref()
}

/// The v10 read schema as Step 2.0.4 froze it: emitted once by schemars from this read
/// shape, then frozen (2.1-M31); it never changes, a later v10 field going in `additions/`.
const FROZEN_READ_SCHEMA: &str = include_str!("../spec/v10/read-schema.json");

#[cfg(test)]
mod tests {
    use super::read_schema;

    /// FNV-1a, 64 bits, of the schema's compact form (keys sorted, so line endings and
    /// layout do not count): enough to notice an edit, with no dependency.
    fn fingerprint(schema: &serde_json::Value) -> u64 {
        schema
            .to_string()
            .bytes()
            .fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
                (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
            })
    }

    #[test]
    fn the_frozen_read_schema_parses_and_the_walker_interprets_it() {
        let schema = read_schema().expect("the frozen read schema parses");
        assert_eq!(crate::schema::unsupported_keyword(schema), None);
    }

    /// Each object schema of the frozen read schema, named `Def` or `Def[i]` for a `oneOf`
    /// variant, with the root as `CanopiFile`.
    fn objects(schema: &serde_json::Value) -> Vec<(String, &serde_json::Value)> {
        let mut named = vec![("CanopiFile".to_owned(), schema)];
        for (name, def) in schema["$defs"].as_object().into_iter().flatten() {
            match def["oneOf"].as_array() {
                Some(variants) => named.extend(
                    variants
                        .iter()
                        .enumerate()
                        .map(|(index, variant)| (format!("{name}[{index}]"), variant)),
                ),
                None => named.push((name.clone(), def)),
            }
        }
        named.retain(|(_, object)| object.get("properties").is_some());
        named
    }

    /// 2.1-M481 (A12): the v10 read schema requires only identity and geometry; every other
    /// field is optional with the default the schema documents, so a later optional drop
    /// needs no reader release. A variant's `kind` or `mode` names what it is.
    #[test]
    fn the_v10_read_schema_requires_only_identity_and_geometry() {
        let schema = read_schema().expect("the frozen read schema parses");
        let identity_and_geometry: &[(&str, &[&str])] = &[
            ("CanopiFile", &["version"]),
            ("Annotation", &["id", "position"]),
            ("BudgetLine", &["target"]),
            ("BudgetTarget", &["kind"]),
            ("Consortium", &["target"]),
            ("GeoPoint", &["lat", "lon"]),
            ("Layer", &["name"]),
            ("LidarColourRange[0]", &["mode"]),
            ("LidarColourRange[1]", &["mode"]),
            ("LidarColourRange[2]", &["max", "min", "mode"]),
            ("MeasurementGuide", &["end", "id", "start"]),
            ("ObjectGroup", &["id"]),
            ("ObjectGroupMember[0]", &["id", "kind"]),
            ("ObjectGroupMember[1]", &["id", "kind"]),
            ("ObjectGroupMember[2]", &["id", "kind"]),
            ("ObjectGroupMember[3]", &["id", "kind"]),
            ("PanelTarget[0]", &["kind", "plant_id"]),
            ("PanelTarget[1]", &["canonical_name", "kind"]),
            ("PanelTarget[2]", &["kind", "zone_id"]),
            ("PanelTarget[3]", &["kind"]),
            ("PanelTarget[4]", &["kind"]),
            ("PlacedPlant", &["canonical_name", "id", "position"]),
            ("PlantDisplay", &[]),
            ("RichTextBlock[0]", &["kind"]),
            ("RichTextBlock[1]", &["kind"]),
            ("RichTextListItem", &[]),
            ("RichTextSpan", &[]),
            ("SavedView", &["camera", "id"]),
            ("SavedViewBackground[0]", &["kind", "style"]),
            ("SavedViewBackground[1]", &["kind"]),
            ("SavedViewBackground[2]", &["kind"]),
            ("SavedViewCamera", &["ground_size_m", "lat", "lon", "zoom"]),
            ("SavedViewGroundSize", &["height", "width"]),
            ("SavedViewHighlight", &[]),
            ("SavedViewLayers", &[]),
            ("SavedViewObject[0]", &["id", "kind"]),
            ("SavedViewObject[1]", &["id", "kind"]),
            ("SavedViewObject[2]", &["id", "kind"]),
            ("SavedViewObject[3]", &["id", "kind"]),
            ("SavedViewObject[4]", &["id", "kind"]),
            ("SavedViewTerrain", &[]),
            ("SiteData", &[]),
            ("SiteDataEntry", &["id", "name"]),
            ("SpeciesPanelTarget", &["canonical_name", "kind"]),
            ("Story", &["id"]),
            ("StoryImage", &["src"]),
            ("StoryStep", &["id", "view_id"]),
            ("TimelineAction", &["id"]),
            ("Zone", &["id", "points", "zone_type"]),
        ];
        let mut found = Vec::new();
        for (name, object) in objects(schema) {
            let mut required = object["required"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>();
            required.sort_unstable();
            for (key, property) in object["properties"].as_object().into_iter().flatten() {
                let documented =
                    required.contains(&key.as_str()) || property.get("default").is_some();
                assert!(
                    documented,
                    "{name}.{key} is optional with no documented default"
                );
            }
            found.push((name, required));
        }
        let expected = identity_and_geometry
            .iter()
            .map(|(name, required)| ((*name).to_owned(), required.to_vec()))
            .collect::<Vec<_>>();
        assert_eq!(found, expected);
    }

    /// 2.1-M31: the reader release's v10 read schema is frozen; an edit here is a format
    /// change a released reader cannot follow.
    #[test]
    fn the_v10_read_schema_is_frozen() {
        assert_eq!(
            fingerprint(read_schema().expect("the frozen read schema parses")),
            1_526_076_181_921_967_706,
            "spec/v10/read-schema.json changed"
        );
    }
}
