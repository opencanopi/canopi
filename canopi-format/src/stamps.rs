//! Saved Object Stamp payload v2 → v3 chain and `.canopi` stamp file round-trip
//! (contracts §10, §11; ADR 0026; 2.1-Q155, 2.1-M88).
//!
//! Payloads are relative metre arrangements (ADR 0001). Version admission uses
//! [`canopi_types::store_chain::admit_form_version`] with floor 2, current 3,
//! and `max_readable = Some(3)` so newer payloads settle [`StampPayloadRefusal::NeedsNewer`].

use canopi_types::store_chain::{Admission, admit_form_version};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

use crate::chain::canonical_json_string;

/// Lowest saved-stamp payload version migrated by this build (Canopi 2.0).
pub const STAMP_PAYLOAD_FLOOR: u32 = 2;

/// Current saved-stamp payload version written by Canopi 2.1 (2.1-M88).
pub const STAMP_PAYLOAD_CURRENT: u32 = 3;

/// Maximum serialized byte size for a saved-stamp payload (`stamp_too_large{limit}`, contracts §11).
pub const MAX_STAMP_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;

/// Relative metre point in a saved-stamp arrangement.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct StampPoint {
    /// East offset in ground metres from the stamp anchor.
    pub x: f64,
    /// North offset in ground metres from the stamp anchor.
    pub y: f64,
}

/// One placed plant inside a v3 saved-stamp payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StampPlantV3 {
    /// Stable local id within the stamp (remapped on placement).
    pub id: String,
    /// Botanical canonical name.
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
    /// Whether the plant's label is pinned (2.1-M88).
    #[serde(default)]
    pub pinned_name: bool,
    /// Lock state preserved across stamp capture/placement (2.1-M88).
    #[serde(default)]
    pub locked: bool,
    /// Position in ground metres relative to the stamp anchor.
    pub position: StampPoint,
    /// Rotation in degrees.
    #[serde(default)]
    pub rotation_deg: Option<f64>,
    /// Canopy spread in metres (v2 `scale`).
    #[serde(default)]
    pub canopy_spread_m: Option<f64>,
    /// Plant notes (2.1-M88).
    #[serde(default)]
    pub notes: Option<String>,
}

/// One zone inside a v3 saved-stamp payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StampZoneV3 {
    /// Stable local id within the stamp.
    pub id: String,
    /// Optional zone display name.
    #[serde(default)]
    pub name: Option<String>,
    /// Lock state (2.1-M88).
    #[serde(default)]
    pub locked: bool,
    /// Zone type literal.
    pub zone_type: String,
    /// Vertices in ground metres relative to the stamp anchor.
    pub points: Vec<StampPoint>,
    /// Rotation in degrees.
    #[serde(default)]
    pub rotation_deg: f64,
    /// Optional fill colour.
    #[serde(default)]
    pub fill_color: Option<String>,
    /// Optional stroke colour (v10 addition, 2.1-Q355).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_color: Option<String>,
    /// Optional opacity in `[0, 1]` applying to fill and stroke together (2.1-Q355).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    /// Zone notes (2.1-M88).
    #[serde(default)]
    pub notes: Option<String>,
}

/// One text annotation inside a v3 saved-stamp payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StampAnnotationV3 {
    /// Stable local id within the stamp.
    pub id: String,
    /// Lock state (2.1-M88).
    #[serde(default)]
    pub locked: bool,
    /// Annotation type literal.
    pub annotation_type: String,
    /// Position in ground metres relative to the stamp anchor.
    pub position: StampPoint,
    /// Annotation text.
    pub text: String,
    /// Font size (> 0).
    pub font_size: f64,
    /// Optional rotation in degrees.
    #[serde(default)]
    pub rotation_deg: Option<f64>,
}

/// One measurement guide inside a v3 saved-stamp payload (2.1-M88).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StampGuideV3 {
    /// Stable local id within the stamp.
    pub id: String,
    /// Lock state.
    #[serde(default)]
    pub locked: bool,
    /// Start point in ground metres.
    pub start: StampPoint,
    /// End point in ground metres.
    pub end: StampPoint,
}

/// One group member inside a v3 saved-stamp payload (includes measurement guides, 2.1-Q154).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StampGroupMemberV3 {
    /// Plant member by local id.
    Plant {
        /// Local plant id.
        id: String,
    },
    /// Zone member by local id.
    Zone {
        /// Local zone id.
        id: String,
    },
    /// Annotation member by local id.
    Annotation {
        /// Local annotation id.
        id: String,
    },
    /// Measurement guide member by local id.
    MeasurementGuide {
        /// Local guide id.
        id: String,
    },
}

/// One object group inside a v3 saved-stamp payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StampGroupV3 {
    /// Stable local id within the stamp.
    pub id: String,
    /// Lock state.
    #[serde(default)]
    pub locked: bool,
    /// Optional group name.
    #[serde(default)]
    pub name: Option<String>,
    /// Group members.
    pub members: Vec<StampGroupMemberV3>,
}

/// One species consortium row carried by a v3 stamp payload (2.1-Q155).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StampConsortiumV3 {
    /// Target species canonical name.
    pub canonical_name: String,
    /// Stratum name.
    pub stratum: String,
    /// Starting phase.
    pub start_phase: i32,
    /// Ending phase.
    pub end_phase: i32,
}

/// One species unit-cost row carried by a v3 stamp payload (2.1-Q155).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StampBudgetLineV3 {
    /// Target species canonical name.
    pub canonical_name: String,
    /// Unit cost in the Design's currency.
    pub unit_cost: f64,
}

/// One care action carried by a v3 stamp payload (2.1-Q155, v10 `offset_days` addition).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StampCareActionV3 {
    /// Action id.
    pub id: String,
    /// Action type literal (e.g. `"planting"`, `"pruning"`).
    pub action_type: String,
    /// Action description.
    pub description: String,
    /// Optional day offset from placement date (v10 addition, contracts §10).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_days: Option<i32>,
    /// Optional recurrence rule JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence: Option<Value>,
    /// Targets (`placed_plant` ids are remapped at placement).
    #[serde(default)]
    pub targets: Vec<Value>,
}

/// Saved Object Stamp payload v3 (2.1-Q155, 2.1-M88, ADR 0026).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedObjectStampPayloadV3 {
    /// Format version (`3`).
    pub version: u32,
    /// Anchor point in ground metres.
    pub anchor: StampPoint,
    /// Plants in the stamp.
    #[serde(default)]
    pub plants: Vec<StampPlantV3>,
    /// Zones in the stamp.
    #[serde(default)]
    pub zones: Vec<StampZoneV3>,
    /// Annotations in the stamp.
    #[serde(default)]
    pub annotations: Vec<StampAnnotationV3>,
    /// Measurement guides in the stamp (2.1-M88).
    #[serde(default)]
    pub measurement_guides: Vec<StampGuideV3>,
    /// Object groups in the stamp.
    #[serde(default)]
    pub groups: Vec<StampGroupV3>,
    /// Species colour overrides (2.1-Q155).
    #[serde(default)]
    pub plant_species_colors: BTreeMap<String, String>,
    /// Species symbol overrides (2.1-Q155).
    #[serde(default)]
    pub plant_species_symbols: BTreeMap<String, String>,
    /// Species code overrides (2.1-Q155).
    #[serde(default)]
    pub plant_species_codes: BTreeMap<String, String>,
    /// Species consortium rows (2.1-Q155).
    #[serde(default)]
    pub consortiums: Vec<StampConsortiumV3>,
    /// Species unit-cost rows (2.1-Q155).
    #[serde(default)]
    pub budget: Vec<StampBudgetLineV3>,
    /// Care actions / timeline entries (2.1-Q155).
    #[serde(default)]
    pub timeline: Vec<StampCareActionV3>,
}

/// Typed refusal returned by [`decode_stamp_payload`] and [`encode_stamp_payload`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StampPayloadRefusal {
    /// Payload exceeds [`MAX_STAMP_PAYLOAD_BYTES`] (`stamp_too_large{limit}`).
    TooLarge {
        /// Maximum allowed bytes.
        limit: usize,
    },
    /// Payload bytes are not valid JSON.
    InvalidJson,
    /// Payload version is below [`STAMP_PAYLOAD_FLOOR`] (pre-2.0).
    BeforeFloor {
        /// Stored version found.
        version: u32,
    },
    /// Payload version is above [`STAMP_PAYLOAD_CURRENT`]: listed as needing a newer Canopi.
    NeedsNewer {
        /// Stored version found.
        version: u32,
    },
    /// Payload failed structural or numeric admission.
    InvalidPayload {
        /// Field path where validation failed.
        field_path: String,
        /// Redacted English diagnostic.
        message: String,
    },
}

/// Decodes a v2 or v3 saved-stamp payload, migrating v2 → v3 in place (2.1-M88).
///
/// # Errors
///
/// Returns [`StampPayloadRefusal`] on cap violation, invalid JSON, unsupported version, or
/// invalid coordinates/fields.
pub fn decode_stamp_payload(
    bytes: &[u8],
) -> Result<SavedObjectStampPayloadV3, StampPayloadRefusal> {
    if bytes.len() > MAX_STAMP_PAYLOAD_BYTES {
        return Err(StampPayloadRefusal::TooLarge {
            limit: MAX_STAMP_PAYLOAD_BYTES,
        });
    }
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| StampPayloadRefusal::InvalidJson)?;
    let version = value
        .get("version")
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| StampPayloadRefusal::InvalidPayload {
            field_path: "$.version".to_owned(),
            message: "expected integer stamp payload version".to_owned(),
        })?;

    let payload =
        match admit_form_version(
            STAMP_PAYLOAD_FLOOR,
            STAMP_PAYLOAD_CURRENT,
            Some(STAMP_PAYLOAD_CURRENT),
            Some(version),
        ) {
            Admission::Absent | Admission::BeforeFloor { .. } => {
                return Err(StampPayloadRefusal::BeforeFloor { version });
            }
            Admission::RefusedNewer { .. } | Admission::NewerReadable { .. } => {
                return Err(StampPayloadRefusal::NeedsNewer { version });
            }
            Admission::Migratable { from: 2 } => migrate_stamp_v2_to_v3(&value)?,
            Admission::Migratable { from } => {
                return Err(StampPayloadRefusal::InvalidPayload {
                    field_path: "$.version".to_owned(),
                    message: format!("no stamp migration step from v{from}"),
                });
            }
            Admission::Current => serde_json::from_value::<SavedObjectStampPayloadV3>(value)
                .map_err(|_| StampPayloadRefusal::InvalidPayload {
                    field_path: "$".to_owned(),
                    message: "invalid v3 stamp payload shape".to_owned(),
                })?,
        };

    validate_stamp_payload(&payload)?;
    Ok(payload)
}

/// Validates and canonically encodes a v3 saved-stamp payload, enforcing [`MAX_STAMP_PAYLOAD_BYTES`].
///
/// # Errors
///
/// Returns [`StampPayloadRefusal`] on invalid version/fields or when encoded bytes exceed the cap.
pub fn encode_stamp_payload(
    payload: &SavedObjectStampPayloadV3,
) -> Result<Vec<u8>, StampPayloadRefusal> {
    if payload.version != STAMP_PAYLOAD_CURRENT {
        return Err(StampPayloadRefusal::InvalidPayload {
            field_path: "$.version".to_owned(),
            message: format!("expected stamp payload version {STAMP_PAYLOAD_CURRENT}"),
        });
    }
    validate_stamp_payload(payload)?;
    let value = serde_json::to_value(payload).map_err(|_| StampPayloadRefusal::InvalidJson)?;
    let bytes = canonical_json_string(&value).into_bytes();
    if bytes.len() > MAX_STAMP_PAYLOAD_BYTES {
        return Err(StampPayloadRefusal::TooLarge {
            limit: MAX_STAMP_PAYLOAD_BYTES,
        });
    }
    Ok(bytes)
}

pub use crate::stamp_canopi::{canopi_file_to_stamp, stamp_to_canopi_file};

fn migrate_stamp_v2_to_v3(value: &Value) -> Result<SavedObjectStampPayloadV3, StampPayloadRefusal> {
    let anchor = parse_point(value.get("anchor"), "$.anchor")?;
    let mut plants = Vec::new();
    for (i, p) in value["plants"].as_array().into_iter().flatten().enumerate() {
        plants.push(StampPlantV3 {
            id: p["id"].as_str().unwrap_or("").to_owned(),
            canonical_name: p["canonicalName"].as_str().unwrap_or("").to_owned(),
            common_name: p["commonName"].as_str().map(ToOwned::to_owned),
            color: p["color"].as_str().map(ToOwned::to_owned),
            symbol: p["symbol"].as_str().map(ToOwned::to_owned),
            pinned_name: false,
            locked: false,
            position: parse_point(p.get("position"), &format!("$.plants[{i}].position"))?,
            rotation_deg: p["rotationDeg"].as_f64(),
            canopy_spread_m: p["scale"].as_f64(),
            notes: None,
        });
    }
    let mut zones = Vec::new();
    for (i, z) in value["zones"].as_array().into_iter().flatten().enumerate() {
        let mut pts = Vec::new();
        for (pi, pt) in z["points"].as_array().into_iter().flatten().enumerate() {
            pts.push(parse_point(
                Some(pt),
                &format!("$.zones[{i}].points[{pi}]"),
            )?);
        }
        zones.push(StampZoneV3 {
            id: z["id"].as_str().unwrap_or("").to_owned(),
            name: z["name"].as_str().map(ToOwned::to_owned),
            locked: false,
            zone_type: z["zoneType"].as_str().unwrap_or("").to_owned(),
            points: pts,
            rotation_deg: z["rotationDeg"].as_f64().unwrap_or(0.0),
            fill_color: z["fillColor"].as_str().map(ToOwned::to_owned),
            stroke_color: None,
            opacity: None,
            notes: None,
        });
    }
    let mut annotations = Vec::new();
    for (i, a) in value["annotations"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        annotations.push(StampAnnotationV3 {
            id: a["id"].as_str().unwrap_or("").to_owned(),
            locked: false,
            annotation_type: a["annotationType"].as_str().unwrap_or("text").to_owned(),
            position: parse_point(a.get("position"), &format!("$.annotations[{i}].position"))?,
            text: a["text"].as_str().unwrap_or("").to_owned(),
            font_size: a["fontSize"].as_f64().unwrap_or(14.0),
            rotation_deg: a["rotationDeg"].as_f64(),
        });
    }
    let groups: Vec<StampGroupV3> =
        serde_json::from_value(value.get("groups").cloned().unwrap_or_else(|| json!([])))
            .unwrap_or_default();

    Ok(SavedObjectStampPayloadV3 {
        version: STAMP_PAYLOAD_CURRENT,
        anchor,
        plants,
        zones,
        annotations,
        measurement_guides: Vec::new(),
        groups,
        plant_species_colors: BTreeMap::new(),
        plant_species_symbols: BTreeMap::new(),
        plant_species_codes: BTreeMap::new(),
        consortiums: Vec::new(),
        budget: Vec::new(),
        timeline: Vec::new(),
    })
}

pub(crate) fn validate_stamp_payload(
    p: &SavedObjectStampPayloadV3,
) -> Result<(), StampPayloadRefusal> {
    check_stamp_point(p.anchor, "$.anchor")?;
    for (i, pl) in p.plants.iter().enumerate() {
        check_stamp_point(pl.position, &format!("$.plants[{i}].position"))?;
        if pl.id.is_empty() || pl.canonical_name.is_empty() {
            return Err(StampPayloadRefusal::InvalidPayload {
                field_path: format!("$.plants[{i}]"),
                message: "plant requires non-empty id and canonical_name".to_owned(),
            });
        }
        if pl
            .canopy_spread_m
            .is_some_and(|s| !(s.is_finite() && s > 0.0))
        {
            return Err(StampPayloadRefusal::InvalidPayload {
                field_path: format!("$.plants[{i}].canopy_spread_m"),
                message: "expected finite positive canopy_spread_m".to_owned(),
            });
        }
    }
    for (i, z) in p.zones.iter().enumerate() {
        if z.id.is_empty() || z.points.is_empty() {
            return Err(StampPayloadRefusal::InvalidPayload {
                field_path: format!("$.zones[{i}]"),
                message: "zone requires non-empty id and points".to_owned(),
            });
        }
        for (pi, pt) in z.points.iter().enumerate() {
            check_stamp_point(*pt, &format!("$.zones[{i}].points[{pi}]"))?;
        }
    }
    for (i, a) in p.annotations.iter().enumerate() {
        check_stamp_point(a.position, &format!("$.annotations[{i}].position"))?;
        if !(a.font_size.is_finite() && a.font_size > 0.0) {
            return Err(StampPayloadRefusal::InvalidPayload {
                field_path: format!("$.annotations[{i}].font_size"),
                message: "expected finite positive font_size".to_owned(),
            });
        }
    }
    for (i, g) in p.measurement_guides.iter().enumerate() {
        check_stamp_point(g.start, &format!("$.measurement_guides[{i}].start"))?;
        check_stamp_point(g.end, &format!("$.measurement_guides[{i}].end"))?;
    }
    Ok(())
}

fn parse_point(val: Option<&Value>, path: &str) -> Result<StampPoint, StampPayloadRefusal> {
    let x = val.and_then(|v| v.get("x")).and_then(Value::as_f64);
    let y = val.and_then(|v| v.get("y")).and_then(Value::as_f64);
    match (x, y) {
        (Some(x), Some(y)) => {
            let pt = StampPoint { x, y };
            check_stamp_point(pt, path)?;
            Ok(pt)
        }
        _ => Err(StampPayloadRefusal::InvalidPayload {
            field_path: path.to_owned(),
            message: "expected finite {x, y} point".to_owned(),
        }),
    }
}

fn check_stamp_point(pt: StampPoint, path: &str) -> Result<(), StampPayloadRefusal> {
    if !(pt.x.is_finite() && pt.y.is_finite()) {
        return Err(StampPayloadRefusal::InvalidPayload {
            field_path: path.to_owned(),
            message: "expected finite coordinates".to_owned(),
        });
    }
    Ok(())
}
