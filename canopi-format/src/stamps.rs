//! Saved Object Stamp payload v2 → v3 chain and `.canopi` stamp file round-trip
//! (contracts §10, §11; ADR 0026; 2.1-Q155, 2.1-M88).
//!
//! The payload types live in [`canopi_types::saved_object_stamps`] (with TS types and
//! frozen v2/v3 schemas emitted by `bindings-gen`). Version admission uses
//! [`canopi_types::store_chain::admit_form_version`] with floor 2, current 3, and
//! `max_readable = Some(3)` so newer payloads settle [`StampPayloadRefusal::NeedsNewer`].

use std::collections::BTreeMap;
use std::sync::OnceLock;

use canopi_types::saved_object_stamps::{
    MAX_STAMP_PAYLOAD_BYTES, STAMP_PAYLOAD_CURRENT, STAMP_PAYLOAD_FLOOR, SavedObjectStampPayload,
    StampAnnotation, StampGroup, StampPlant, StampPoint, StampZone,
};
use canopi_types::store_chain::{Admission, admit_form_version};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::chain::canonical_json_string;
use crate::schema::admit_schema;

/// Frozen v2 saved-stamp payload schema walked before stepping v2→v3 (`contracts.md` §10 `:424`).
#[must_use]
pub fn stamp_v2_schema() -> Option<&'static Value> {
    static SCHEMA: OnceLock<Option<Value>> = OnceLock::new();
    SCHEMA
        .get_or_init(|| serde_json::from_str(include_str!("../spec/stamps/v2/schema.json")).ok())
        .as_ref()
}

pub use crate::stamp_canopi::{canopi_file_to_stamp, stamp_to_canopi_file};
pub use canopi_types::saved_object_stamps::{
    MAX_STAMP_PAYLOAD_BYTES as STAMP_MAX_BYTES, STAMP_PAYLOAD_CURRENT as STAMP_CURRENT,
    STAMP_PAYLOAD_FLOOR as STAMP_FLOOR,
};

/// Refusal returned by saved-stamp payload decode or encode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StampPayloadRefusal {
    /// Payload exceeds [`MAX_STAMP_PAYLOAD_BYTES`] (`stamp_too_large{limit}`, contracts §11).
    TooLarge {
        /// Maximum admitted byte length.
        limit: usize,
    },
    /// Payload is not valid UTF-8 JSON.
    InvalidJson,
    /// Payload version is below [`STAMP_PAYLOAD_FLOOR`] (pre-2.0).
    BeforeFloor {
        /// Version found in the payload.
        version: u32,
    },
    /// Payload version is above [`STAMP_PAYLOAD_CURRENT`] (`2.1-M88`): listed as needing a newer Canopi.
    NeedsNewer {
        /// Version found in the payload.
        version: u32,
    },
    /// Payload failed structural or semantic validation.
    InvalidPayload {
        /// Field path at fault.
        field_path: String,
        /// Diagnostic message (never contains user values).
        message: String,
    },
}

/// Decodes and migrates (v2 → v3) a saved-stamp payload from raw JSON bytes.
///
/// # Errors
///
/// Returns [`StampPayloadRefusal`] on cap, JSON, version (`NeedsNewer`/`BeforeFloor`),
/// or structural validation failure.
pub fn decode_stamp_payload(bytes: &[u8]) -> Result<SavedObjectStampPayload, StampPayloadRefusal> {
    if bytes.len() > MAX_STAMP_PAYLOAD_BYTES {
        return Err(StampPayloadRefusal::TooLarge {
            limit: MAX_STAMP_PAYLOAD_BYTES,
        });
    }
    let raw: Value = serde_json::from_slice(bytes).map_err(|_| StampPayloadRefusal::InvalidJson)?;
    let version = raw
        .get("version")
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| StampPayloadRefusal::InvalidPayload {
            field_path: "$.version".to_owned(),
            message: "expected an unsigned integer version".to_owned(),
        })?;

    match admit_form_version(
        STAMP_PAYLOAD_FLOOR,
        STAMP_PAYLOAD_CURRENT,
        Some(STAMP_PAYLOAD_CURRENT),
        Some(version),
    ) {
        Admission::Absent | Admission::BeforeFloor { .. } => {
            Err(StampPayloadRefusal::BeforeFloor { version })
        }
        Admission::NewerReadable { .. } | Admission::RefusedNewer { .. } => {
            Err(StampPayloadRefusal::NeedsNewer { version })
        }
        Admission::Migratable { from: 2 } => {
            // Contracts §10 :424: validate v2 stamp input against the frozen v2 schema before stepping.
            let schema_v2 =
                stamp_v2_schema().ok_or_else(|| StampPayloadRefusal::InvalidPayload {
                    field_path: "$".to_owned(),
                    message: "frozen v2 stamp schema unavailable".to_owned(),
                })?;
            admit_schema(&raw, schema_v2).map_err(|r| StampPayloadRefusal::InvalidPayload {
                field_path: r.field_path.to_string(),
                message: r.to_string(),
            })?;
            let migrated = migrate_stamp_v2_to_v3(&raw)?;
            validate_stamp_payload(&migrated)?;
            Ok(migrated)
        }
        Admission::Migratable { from } => Err(StampPayloadRefusal::InvalidPayload {
            field_path: "$.version".to_owned(),
            message: format!("no migration step from stamp v{from}"),
        }),
        Admission::Current => {
            let payload: SavedObjectStampPayload =
                serde_json::from_value(raw).map_err(|_| StampPayloadRefusal::InvalidPayload {
                    field_path: "$".to_owned(),
                    message: "malformed v3 stamp payload".to_owned(),
                })?;
            validate_stamp_payload(&payload)?;
            Ok(payload)
        }
    }
}

/// Validates and canonically encodes a v3 saved-stamp payload, enforcing [`MAX_STAMP_PAYLOAD_BYTES`].
///
/// # Errors
///
/// Returns [`StampPayloadRefusal`] if version != 3, validation fails, or encoded size exceeds cap.
pub fn encode_stamp_payload(
    payload: &SavedObjectStampPayload,
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

fn migrate_stamp_v2_to_v3(value: &Value) -> Result<SavedObjectStampPayload, StampPayloadRefusal> {
    let anchor = parse_point(value.get("anchor"), "$.anchor")?;
    let mut plants = Vec::new();
    for (i, p) in value["plants"].as_array().into_iter().flatten().enumerate() {
        plants.push(StampPlant {
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
            extra: BTreeMap::new(),
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
        zones.push(StampZone {
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
            extra: BTreeMap::new(),
        });
    }
    let mut annotations = Vec::new();
    for (i, a) in value["annotations"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        annotations.push(StampAnnotation {
            id: a["id"].as_str().unwrap_or("").to_owned(),
            locked: false,
            annotation_type: a["annotationType"].as_str().unwrap_or("text").to_owned(),
            position: parse_point(a.get("position"), &format!("$.annotations[{i}].position"))?,
            text: a["text"].as_str().unwrap_or("").to_owned(),
            font_size: a["fontSize"].as_f64().unwrap_or(14.0),
            rotation_deg: a["rotationDeg"].as_f64(),
            extra: BTreeMap::new(),
        });
    }
    let groups: Vec<StampGroup> =
        serde_json::from_value(value.get("groups").cloned().unwrap_or_else(|| json!([])))
            .unwrap_or_default();

    Ok(SavedObjectStampPayload {
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
        extra: BTreeMap::new(),
    })
}

pub(crate) fn validate_stamp_payload(
    p: &SavedObjectStampPayload,
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
