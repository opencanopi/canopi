//! The `.canopi` Design file: its version policy, fields and their owners
//! (`DESIGN_FILE_FIELDS`), and the shapes it stores. Positions are WGS84
//! lon/lat (ADR 0001).

use serde::{Deserialize, Serialize};
use specta::Type;

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
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub const FUTURE_CANOPI_FILE_VERSION_POLICY: &str = "reject";
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

impl GeoPoint {
    #[expect(
        missing_docs,
        reason = "undocumented before 2.1-Q217; document when this file is next touched"
    )]
    pub fn is_valid(&self) -> bool {
        self.lon.is_finite()
            && (-180.0..=180.0).contains(&self.lon)
            && self.lat.is_finite()
            && (-WEB_MERCATOR_MAX_LATITUDE_DEG..=WEB_MERCATOR_MAX_LATITUDE_DEG).contains(&self.lat)
    }
}

/// Check every persisted position of an admitted Design. Serde accepts any
/// finite `f64`; the WGS84 and Web Mercator ranges are enforced here so native
/// admission matches the generated Web schema.
pub fn validate_design_geometry(file: &CanopiFile) -> Result<(), String> {
    let check = |point: &GeoPoint, path: String| {
        if point.is_valid() {
            Ok(())
        } else {
            Err(format!(
                "{path}: expected lon in [-180, 180] and a Web Mercator latitude"
            ))
        }
    };
    for (index, plant) in file.plants.iter().enumerate() {
        check(&plant.position, format!("$.plants[{index}].position"))?;
    }
    for (index, zone) in file.zones.iter().enumerate() {
        for (point_index, point) in zone.points.iter().enumerate() {
            check(point, format!("$.zones[{index}].points[{point_index}]"))?;
        }
        if !zone.rotation.is_finite() {
            return Err(format!(
                "$.zones[{index}].rotation: expected a finite number"
            ));
        }
    }
    for (index, annotation) in file.annotations.iter().enumerate() {
        check(
            &annotation.position,
            format!("$.annotations[{index}].position"),
        )?;
    }
    for (index, guide) in file.measurement_guides.iter().enumerate() {
        check(&guide.start, format!("$.measurement_guides[{index}].start"))?;
        check(&guide.end, format!("$.measurement_guides[{index}].end"))?;
    }
    Ok(())
}

/// Identities and ranges of an admitted Design, checked after version
/// admission. Plants, zones, annotations, measurement guides and groups need
/// unique, non-empty ids because targets, groups and saved views refer to
/// them; Canopi never invents a missing one. Opacities, scales and font sizes must be
/// finite and in range, and the LiDAR section must be the schema this build
/// writes, with named entries and any custom colour range a finite rising pair.
pub fn admit_design_identities_and_ranges(file: &CanopiFile) -> Result<(), String> {
    check_unique_ids("plants", file.plants.iter().map(|plant| plant.id.as_str()))?;
    for (index, plant) in file.plants.iter().enumerate() {
        if plant
            .scale
            .is_some_and(|scale| !(scale.is_finite() && scale > 0.0))
        {
            return Err(format!(
                "$.plants[{index}].scale: expected a finite number above 0"
            ));
        }
        if plant.rotation.is_some_and(|rotation| !rotation.is_finite()) {
            return Err(format!(
                "$.plants[{index}].rotation: expected a finite number"
            ));
        }
    }
    check_unique_ids(
        "measurement_guides",
        file.measurement_guides
            .iter()
            .map(|guide| guide.id.as_str()),
    )?;
    check_unique_ids("zones", file.zones.iter().map(|zone| zone.id.as_str()))?;
    check_unique_ids(
        "annotations",
        file.annotations
            .iter()
            .map(|annotation| annotation.id.as_str()),
    )?;
    check_unique_ids("groups", file.groups.iter().map(|group| group.id.as_str()))?;
    for (index, annotation) in file.annotations.iter().enumerate() {
        if !(annotation.font_size.is_finite() && annotation.font_size > 0.0) {
            return Err(format!(
                "$.annotations[{index}].font_size: expected a finite number above 0"
            ));
        }
        if annotation
            .rotation
            .is_some_and(|rotation| !rotation.is_finite())
        {
            return Err(format!(
                "$.annotations[{index}].rotation: expected a finite number"
            ));
        }
    }
    for (index, layer) in file.layers.iter().enumerate() {
        if !(layer.opacity.is_finite() && (0.0..=1.0).contains(&layer.opacity)) {
            return Err(format!(
                "$.layers[{index}].opacity: expected a number in [0, 1]"
            ));
        }
    }
    if let Some(lidar) = &file.lidar {
        for (index, entry) in lidar.entries.iter().enumerate() {
            if !(entry.opacity.is_finite() && (0.0..=1.0).contains(&entry.opacity)) {
                return Err(format!(
                    "$.lidar.entries[{index}].opacity: expected a number in [0, 1]"
                ));
            }
            if entry.name.trim().is_empty() {
                return Err(format!(
                    "$.lidar.entries[{index}].name: expected a non-empty name"
                ));
            }
            if let Some(crate::lidar::LidarColourRange::Custom { min, max }) = entry.range
                && !(min.is_finite() && max.is_finite() && min < max)
            {
                return Err(format!(
                    "$.lidar.entries[{index}].range: expected finite min and max with min below max"
                ));
            }
        }
    }
    Ok(())
}

fn check_unique_ids<'a>(key: &str, ids: impl Iterator<Item = &'a str>) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for (index, id) in ids.enumerate() {
        if id.is_empty() {
            return Err(format!("$.{key}[{index}].id: expected a non-empty id"));
        }
        if !seen.insert(id) {
            return Err(format!("$.{key}[{index}].id: duplicate id {id:?}"));
        }
    }
    Ok(())
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn geo_file(plants: serde_json::Value) -> CanopiFile {
        serde_json::from_value(json!({
            "version": 9,
            "name": "Geo",
            "plant_species_colors": {},
            "layers": [],
            "plants": plants,
            "zones": [],
            "annotations": [],
            "consortiums": [],
            "groups": [],
            "timeline": [],
            "budget": [],
            "created_at": "2026-09-25T00:00:00.000Z",
            "updated_at": "2026-09-25T00:00:00.000Z"
        }))
        .expect("current design should deserialize")
    }

    fn plant_at(lon: f64, lat: f64) -> serde_json::Value {
        json!({
            "id": "plant-1",
            "canonical_name": "Malus domestica",
            "position": { "lon": lon, "lat": lat }
        })
    }

    #[test]
    fn design_positions_are_lon_lat_and_round_trip_exactly() {
        let file = geo_file(json!([plant_at(2.294_481_234_5, 48.858_370_123_4)]));
        assert_eq!(
            file.plants[0].position,
            GeoPoint {
                lon: 2.294_481_234_5,
                lat: 48.858_370_123_4
            }
        );
        validate_design_geometry(&file).expect("in-range positions are valid");
        let value = serde_json::to_value(&file).expect("design should serialize");
        assert_eq!(
            value["plants"][0]["position"],
            json!({ "lon": 2.294_481_234_5, "lat": 48.858_370_123_4 })
        );
        assert!(value.get("spatial_frame").is_none());
    }

    #[test]
    fn design_geometry_rejects_out_of_range_positions() {
        for (lon, lat) in [(180.0001, 0.0), (-180.0001, 0.0), (0.0, 85.0511287798067)] {
            let file = geo_file(json!([plant_at(lon, lat)]));
            assert_eq!(
                validate_design_geometry(&file),
                Err(
                    "$.plants[0].position: expected lon in [-180, 180] and a Web Mercator latitude"
                        .to_owned()
                ),
            );
        }
    }

    #[test]
    fn design_positions_reject_local_metre_points() {
        let result = serde_json::from_value::<CanopiFile>(json!({
            "version": 9,
            "name": "Metres",
            "plant_species_colors": {},
            "layers": [],
            "plants": [{
                "id": "plant-1",
                "canonical_name": "Malus domestica",
                "position": { "x": 1.0, "y": 2.0 }
            }],
            "zones": [],
            "annotations": [],
            "consortiums": [],
            "groups": [],
            "timeline": [],
            "budget": [],
            "created_at": "2026-09-25T00:00:00.000Z",
            "updated_at": "2026-09-25T00:00:00.000Z"
        }));
        assert!(result.is_err(), "design positions must be lon/lat");
    }

    #[test]
    fn design_objects_missing_lock_state_load_unlocked_and_serialize_explicitly() {
        let file: CanopiFile = serde_json::from_value(json!({
            "version": 9,
            "name": "Implicit locks",
            "description": null,
            "plant_species_colors": {},
            "layers": [
                { "name": "plants", "visible": true, "locked": false, "opacity": 1.0 }
            ],
            "plants": [
                {
                    "id": "plant-1",
                    "canonical_name": "Malus domestica",
                    "common_name": "Apple",
                    "position": { "lon": 13.0, "lat": 23.0 },
                    "rotation": null,
                    "scale": null,
                    "notes": null,
                    "planted_date": null,
                    "quantity": 1
                }
            ],
            "zones": [
                {
                    "id": "zone-1",
                    "zone_type": "rect",
                    "points": [
                        { "lon": 13.0, "lat": 23.0 },
                        { "lon": 13.00001, "lat": 23.0 },
                        { "lon": 13.00001, "lat": 22.99999 }
                    ],
                    "fill_color": null,
                    "notes": null
                }
            ],
            "annotations": [
                {
                    "id": "annotation-1",
                    "annotation_type": "text",
                    "position": { "lon": 13.00002, "lat": 23.00003 },
                    "text": "Note",
                    "font_size": 16.0,
                    "rotation": null
                }
            ],
            "consortiums": [],
            "groups": [
                {
                    "id": "group-1",
                    "name": null,
                    "members": [
                        { "kind": "plant", "id": "plant-1" },
                        { "kind": "zone", "id": "zone-1" }
                    ]
                }
            ],
            "timeline": [],
            "budget": [],
            "budget_currency": "EUR",
            "created_at": "2026-04-02T00:00:00.000Z",
            "updated_at": "2026-04-02T00:00:00.000Z"
        }))
        .expect("design objects without locked fields should load");

        assert!(!file.plants[0].locked);
        assert!(!file.zones[0].locked);
        assert!(!file.annotations[0].locked);
        assert!(!file.groups[0].locked);
        assert_eq!(file.zones[0].rotation, 0.0);

        let value = serde_json::to_value(&file).expect("canopi file should serialize");
        assert_eq!(value["plants"][0]["locked"], json!(false));
        assert_eq!(value["zones"][0]["locked"], json!(false));
        assert_eq!(value["zones"][0]["rotation"], json!(0.0));
        assert_eq!(value["annotations"][0]["locked"], json!(false));
        assert_eq!(value["groups"][0]["locked"], json!(false));
    }

    fn admitted(value: serde_json::Value) -> Result<CanopiFile, String> {
        let file: CanopiFile = serde_json::from_value(value).map_err(|e| e.to_string())?;
        admit_design_identities_and_ranges(&file)?;
        Ok(file)
    }

    fn design_with(overrides: serde_json::Value) -> serde_json::Value {
        let mut value = json!({
            "version": 9,
            "name": "Admission",
            "plant_species_colors": {},
            "layers": [],
            "plants": [],
            "zones": [],
            "annotations": [],
            "consortiums": [],
            "groups": [],
            "timeline": [],
            "budget": [],
            "created_at": "2026-09-28T00:00:00.000Z",
            "updated_at": "2026-09-28T00:00:00.000Z"
        });
        for (key, override_value) in overrides.as_object().expect("object overrides") {
            value[key] = override_value.clone();
        }
        value
    }

    #[test]
    fn plants_and_guides_need_an_id_and_unique_non_empty_ids() {
        let plant = |id: Option<&str>| {
            let mut value = json!({ "canonical_name": "Malus domestica", "position": { "lon": 13.0, "lat": 23.0 } });
            if let Some(id) = id {
                value["id"] = json!(id);
            }
            value
        };
        let guide = |id: Option<&str>| {
            let mut value = json!({ "start": { "lon": 13.0, "lat": 23.0 }, "end": { "lon": 13.001, "lat": 23.0 } });
            if let Some(id) = id {
                value["id"] = json!(id);
            }
            value
        };
        // A hand-edited file missing an id is refused: Canopi never invents one.
        assert!(
            admitted(design_with(json!({ "plants": [plant(None)] })))
                .unwrap_err()
                .contains("missing field `id`")
        );
        assert!(
            admitted(design_with(json!({ "measurement_guides": [guide(None)] })))
                .unwrap_err()
                .contains("missing field `id`")
        );
        assert_eq!(
            admitted(design_with(json!({ "plants": [plant(Some(""))] }))).unwrap_err(),
            "$.plants[0].id: expected a non-empty id"
        );
        assert_eq!(
            admitted(design_with(
                json!({ "measurement_guides": [guide(Some(""))] })
            ))
            .unwrap_err(),
            "$.measurement_guides[0].id: expected a non-empty id"
        );
        assert_eq!(
            admitted(design_with(
                json!({ "plants": [plant(Some("plant-1")), plant(Some("plant-1"))] })
            ))
            .unwrap_err(),
            "$.plants[1].id: duplicate id \"plant-1\""
        );
        assert_eq!(
            admitted(design_with(
                json!({ "measurement_guides": [guide(Some("g")), guide(Some("g"))] })
            ))
            .unwrap_err(),
            "$.measurement_guides[1].id: duplicate id \"g\""
        );
        let file = admitted(design_with(json!({
            "plants": [plant(Some("plant-2")), plant(Some("plant-1"))],
            "measurement_guides": [guide(Some("guide-1"))]
        })))
        .expect("explicit ids are admitted as they are");
        assert_eq!(file.plants[0].id, "plant-2");
        assert_eq!(file.measurement_guides[0].id, "guide-1");
    }

    #[test]
    fn a_design_missing_a_list_canopi_always_writes_is_refused() {
        let complete = design_with(json!({}));
        admitted(complete.clone()).expect("a Design with every written list loads");
        for key in ["annotations", "consortiums", "groups", "timeline", "budget"] {
            let mut value = complete.clone();
            value.as_object_mut().expect("object").remove(key);
            let error = admitted(value).expect_err(key);
            assert!(error.contains(&format!("missing field `{key}`")), "{error}");
        }
    }

    #[test]
    fn zones_annotations_and_groups_need_unique_non_empty_ids() {
        let zone = |id: &str| json!({ "id": id, "zone_type": "rect", "points": [] });
        assert_eq!(
            admitted(design_with(json!({ "zones": [zone("bed"), zone("bed")] }))).unwrap_err(),
            "$.zones[1].id: duplicate id \"bed\""
        );
        assert_eq!(
            admitted(design_with(json!({ "zones": [zone("")] }))).unwrap_err(),
            "$.zones[0].id: expected a non-empty id"
        );
        let note = |id: &str| {
            json!({
                "id": id, "annotation_type": "text", "position": { "lon": 13.0, "lat": 23.0 },
                "text": "Note", "font_size": 14.0
            })
        };
        assert_eq!(
            admitted(design_with(
                json!({ "annotations": [note("n"), note("n")] })
            ))
            .unwrap_err(),
            "$.annotations[1].id: duplicate id \"n\""
        );
        let group = |id: &str| json!({ "id": id, "name": null, "members": [] });
        assert_eq!(
            admitted(design_with(json!({ "groups": [group("g"), group("g")] }))).unwrap_err(),
            "$.groups[1].id: duplicate id \"g\""
        );
    }

    #[test]
    fn ranges_are_checked_after_deserialization() {
        let plant = |scale: serde_json::Value| {
            json!({
                "id": "plant-1", "canonical_name": "Malus domestica",
                "position": { "lon": 13.0, "lat": 23.0 }, "scale": scale
            })
        };
        assert!(admitted(design_with(json!({ "plants": [plant(json!(0.0))] }))).is_err());
        assert!(admitted(design_with(json!({ "plants": [plant(json!(-1.0))] }))).is_err());
        assert!(admitted(design_with(json!({ "plants": [plant(json!(0.2))] }))).is_ok());
        assert!(
            admitted(design_with(
                json!({ "plants": [plant(serde_json::Value::Null)] })
            ))
            .is_ok()
        );
        assert!(admitted(design_with(json!({
            "annotations": [{ "id": "n", "annotation_type": "text", "position": { "lon": 13.0, "lat": 23.0 }, "text": "x", "font_size": 0.0 }]
        }))).is_err());
        assert!(
            admitted(design_with(json!({
                "layers": [{ "name": "plants", "visible": true, "locked": false, "opacity": 1.5 }]
            })))
            .is_err()
        );
        // The section has no version of its own: the file's version covers it,
        // and an older dev file's `schema_version` is dropped like any unknown key.
        assert!(
            admitted(design_with(json!({
                "lidar": { "visible": true, "entries": [] }
            })))
            .is_ok()
        );
        assert!(
            admitted(design_with(json!({
                "lidar": { "schema_version": 2, "visible": true, "entries": [] }
            })))
            .is_ok()
        );
        let lidar = |entry: serde_json::Value| {
            design_with(json!({
                "lidar": { "visible": true, "entries": [entry] }
            }))
        };
        let entry = |opacity: f64, name: &str, range: serde_json::Value| {
            json!({
                "kind": "Derived", "id": "slope", "name": name, "visible": true,
                "opacity": opacity, "order": 0, "ramp": "YellowRed", "reversed": true,
                "range": range
            })
        };
        assert!(admitted(lidar(entry(1.2, "Slope", serde_json::Value::Null))).is_err());
        assert!(admitted(lidar(entry(0.4, "Slope", serde_json::Value::Null))).is_ok());
        assert_eq!(
            admitted(lidar(entry(0.4, " ", serde_json::Value::Null))).unwrap_err(),
            "$.lidar.entries[0].name: expected a non-empty name"
        );
        let custom = |min: f64, max: f64| json!({ "mode": "Custom", "min": min, "max": max });
        assert!(admitted(lidar(entry(0.4, "Slope", custom(0.0, 30.0)))).is_ok());
        assert_eq!(
            admitted(lidar(entry(0.4, "Slope", custom(30.0, 30.0)))).unwrap_err(),
            "$.lidar.entries[0].range: expected finite min and max with min below max"
        );
        assert!(admitted(lidar(entry(0.4, "Slope", custom(40.0, 30.0)))).is_err());
    }

    #[test]
    fn a_custom_colour_range_must_be_finite_even_when_built_in_memory() {
        // JSON cannot carry a non-finite number, but a Design built in memory
        // can; admission refuses it before it is written.
        let mut file: CanopiFile = serde_json::from_value(design_with(json!({
            "lidar": { "visible": true, "entries": [{
                "kind": "Source", "id": "dem", "name": "Terrain model", "visible": true,
                "opacity": 1.0, "order": 0, "ramp": null, "reversed": false, "range": null
            }] }
        })))
        .expect("a Design with one LiDAR entry loads");
        file.lidar.as_mut().expect("lidar section").entries[0].range =
            Some(crate::lidar::LidarColourRange::Custom {
                min: f64::NAN,
                max: 30.0,
            });
        assert!(admit_design_identities_and_ranges(&file).is_err());
    }

    fn zone_file(zone: serde_json::Value) -> Result<CanopiFile, serde_json::Error> {
        serde_json::from_value(json!({
            "version": 9,
            "name": "Zones",
            "plant_species_colors": {},
            "layers": [],
            "plants": [],
            "zones": [zone],
            "annotations": [],
            "consortiums": [],
            "groups": [],
            "timeline": [],
            "budget": [],
            "created_at": "2026-09-27T00:00:00.000Z",
            "updated_at": "2026-09-27T00:00:00.000Z"
        }))
    }

    #[test]
    fn zones_keep_a_stable_id_beside_an_optional_display_name() {
        let named = zone_file(json!({
            "id": "zone-1",
            "name": "North bed",
            "zone_type": "rect",
            "points": []
        }))
        .expect("a named zone loads");
        assert_eq!(named.zones[0].id, "zone-1");
        assert_eq!(named.zones[0].name.as_deref(), Some("North bed"));

        let unnamed = zone_file(json!({ "id": "zone-2", "zone_type": "line", "points": [] }))
            .expect("an unnamed zone loads");
        assert_eq!(unnamed.zones[0].name, None);
        let value = serde_json::to_value(&unnamed).expect("design should serialize");
        assert_eq!(value["zones"][0]["id"], json!("zone-2"));
        assert_eq!(value["zones"][0]["name"], json!(null));

        // A v8 zone, whose name was its identity, has no id and is refused.
        assert!(
            zone_file(json!({ "name": "North bed", "zone_type": "rect", "points": [] })).is_err()
        );
    }

    #[test]
    fn general_deserialization_rejects_obsolete_object_group_shape() {
        let result = serde_json::from_value::<CanopiFile>(json!({
            "version": 9,
            "name": "Legacy groups require ingestion",
            "plant_species_colors": {},
            "layers": [],
            "plants": [{
                "id": "plant-1",
                "canonical_name": "Malus domestica",
                "position": { "lon": 13.0, "lat": 23.0 }
            }],
            "zones": [{
                "id": "zone-1",
                "zone_type": "rect",
                "points": []
            }],
            "annotations": [],
            "consortiums": [],
            "timeline": [],
            "budget": [],
            "groups": [{
                "id": "legacy",
                "member_ids": ["plant-1", "zone-1"]
            }],
            "created_at": "2026-07-15T00:00:00.000Z",
            "updated_at": "2026-07-15T00:00:00.000Z"
        }));

        assert!(
            result.is_err(),
            "obsolete Object Groups must not enter the runtime",
        );
    }
}
