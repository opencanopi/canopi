//! Bidirectional conversion between [`SavedObjectStampPayloadV3`] and v10 `.canopi` stamp files
//! (2.1-Q155, 2.1-M88).

use std::collections::BTreeMap;

use canopi_types::design::{DEFAULT_BUDGET_CURRENCY, GeoPoint};
use serde_json::{Map, Value, json};

use crate::chain::{CANOPI_CURRENT, canonicalize_json};
use crate::stamps::{
    STAMP_PAYLOAD_CURRENT, SavedObjectStampPayloadV3, StampAnnotationV3, StampBudgetLineV3,
    StampCareActionV3, StampConsortiumV3, StampGroupV3, StampGuideV3, StampPayloadRefusal,
    StampPlantV3, StampPoint, StampZoneV3, validate_stamp_payload,
};

// Local tangent plane metre <-> WGS84 conversion (ADR 0001).
const METRES_PER_DEG_LAT: f64 = 111_319.490_793_273_58;

/// Maps a v3 stamp payload to a v10 `.canopi` stamp file centred at `origin` (2.1-Q155, 2.1-M88).
#[must_use]
pub fn stamp_to_canopi_file(
    payload: &SavedObjectStampPayloadV3,
    name: &str,
    origin: GeoPoint,
) -> Value {
    let to_geo = |pt: StampPoint| -> Value {
        let (lon, lat) = metres_to_wgs84(origin, pt.x - payload.anchor.x, pt.y - payload.anchor.y);
        json!({ "lon": lon, "lat": lat })
    };

    canonicalize_json(&json!({
        "version": CANOPI_CURRENT,
        "name": name,
        "plant_species_colors": payload.plant_species_colors,
        "plant_species_symbols": payload.plant_species_symbols,
        "plant_species_codes": payload.plant_species_codes,
        "layers": [],
        "plants": encode_plants(&payload.plants, &to_geo),
        "zones": encode_zones(&payload.zones, &to_geo),
        "annotations": encode_annotations(&payload.annotations, &to_geo),
        "measurement_guides": encode_guides(&payload.measurement_guides, &to_geo),
        "consortiums": encode_consortiums(&payload.consortiums),
        "groups": payload.groups,
        "timeline": encode_timeline(&payload.timeline),
        "budget": encode_budget(&payload.budget),
        "budget_currency": DEFAULT_BUDGET_CURRENCY,
        "views": [],
        "stories": [],
        "created_at": "",
        "updated_at": "",
    }))
}

/// Converts a v10 `.canopi` stamp file back into a [`SavedObjectStampPayloadV3`] anchored at `origin`.
///
/// # Errors
///
/// Returns [`StampPayloadRefusal::InvalidPayload`] if required stamp entities are malformed.
pub fn canopi_file_to_stamp(
    design: &Value,
    origin: GeoPoint,
) -> Result<SavedObjectStampPayloadV3, StampPayloadRefusal> {
    let groups: Vec<StampGroupV3> =
        serde_json::from_value(design.get("groups").cloned().unwrap_or_else(|| json!([])))
            .unwrap_or_default();

    let payload = SavedObjectStampPayloadV3 {
        version: STAMP_PAYLOAD_CURRENT,
        anchor: StampPoint { x: 0.0, y: 0.0 },
        plants: decode_plants(design, origin)?,
        zones: decode_zones(design, origin)?,
        annotations: decode_annotations(design, origin)?,
        measurement_guides: decode_guides(design, origin)?,
        groups,
        plant_species_colors: string_map(design.get("plant_species_colors")),
        plant_species_symbols: string_map(design.get("plant_species_symbols")),
        plant_species_codes: string_map(design.get("plant_species_codes")),
        consortiums: decode_consortiums(design),
        budget: decode_budget(design),
        timeline: decode_timeline(design),
    };
    validate_stamp_payload(&payload)?;
    Ok(payload)
}

fn encode_plants(plants: &[StampPlantV3], to_geo: &impl Fn(StampPoint) -> Value) -> Vec<Value> {
    plants
        .iter()
        .map(|p| {
            let mut obj = Map::new();
            obj.insert("id".to_owned(), json!(p.id));
            obj.insert("locked".to_owned(), json!(p.locked));
            obj.insert("canonical_name".to_owned(), json!(p.canonical_name));
            obj.insert("common_name".to_owned(), json!(p.common_name));
            obj.insert("color".to_owned(), json!(p.color));
            obj.insert("symbol".to_owned(), json!(p.symbol));
            obj.insert("pinned_name".to_owned(), json!(p.pinned_name));
            obj.insert("position".to_owned(), to_geo(p.position));
            obj.insert("rotation".to_owned(), json!(p.rotation_deg));
            if let Some(spread) = p.canopy_spread_m {
                obj.insert("canopy_spread_m".to_owned(), json!(spread));
            }
            obj.insert("notes".to_owned(), json!(p.notes));
            Value::Object(obj)
        })
        .collect()
}

fn encode_zones(zones: &[StampZoneV3], to_geo: &impl Fn(StampPoint) -> Value) -> Vec<Value> {
    zones
        .iter()
        .map(|z| {
            let mut obj = Map::new();
            obj.insert("id".to_owned(), json!(z.id));
            obj.insert("name".to_owned(), json!(z.name));
            obj.insert("locked".to_owned(), json!(z.locked));
            obj.insert("zone_type".to_owned(), json!(z.zone_type));
            obj.insert(
                "points".to_owned(),
                Value::Array(z.points.iter().copied().map(to_geo).collect()),
            );
            obj.insert("rotation".to_owned(), json!(z.rotation_deg));
            obj.insert("fill_color".to_owned(), json!(z.fill_color));
            if let Some(sc) = &z.stroke_color {
                obj.insert("stroke_color".to_owned(), json!(sc));
            }
            if let Some(op) = z.opacity {
                obj.insert("opacity".to_owned(), json!(op));
            }
            obj.insert("notes".to_owned(), json!(z.notes));
            Value::Object(obj)
        })
        .collect()
}

fn encode_annotations(
    annotations: &[StampAnnotationV3],
    to_geo: &impl Fn(StampPoint) -> Value,
) -> Vec<Value> {
    annotations
        .iter()
        .map(|a| {
            json!({
                "id": a.id,
                "locked": a.locked,
                "annotation_type": a.annotation_type,
                "position": to_geo(a.position),
                "text": a.text,
                "font_size": a.font_size,
                "rotation": a.rotation_deg,
            })
        })
        .collect()
}

fn encode_guides(guides: &[StampGuideV3], to_geo: &impl Fn(StampPoint) -> Value) -> Vec<Value> {
    guides
        .iter()
        .map(|g| {
            json!({
                "id": g.id,
                "locked": g.locked,
                "start": to_geo(g.start),
                "end": to_geo(g.end),
            })
        })
        .collect()
}

fn encode_consortiums(consortiums: &[StampConsortiumV3]) -> Vec<Value> {
    consortiums
        .iter()
        .map(|c| {
            json!({
                "target": { "kind": "species", "canonical_name": c.canonical_name },
                "stratum": c.stratum,
                "start_phase": c.start_phase,
                "end_phase": c.end_phase,
            })
        })
        .collect()
}

fn encode_budget(budget: &[StampBudgetLineV3]) -> Vec<Value> {
    budget
        .iter()
        .map(|b| {
            json!({
                "target": { "kind": "species", "canonical_name": b.canonical_name },
                "unit_cost": b.unit_cost,
            })
        })
        .collect()
}

fn encode_timeline(timeline: &[StampCareActionV3]) -> Vec<Value> {
    timeline
        .iter()
        .enumerate()
        .map(|(order, t)| {
            let mut obj = Map::new();
            obj.insert("id".to_owned(), json!(t.id));
            obj.insert("action_type".to_owned(), json!(t.action_type));
            obj.insert("description".to_owned(), json!(t.description));
            obj.insert("targets".to_owned(), Value::Array(t.targets.clone()));
            obj.insert("completed".to_owned(), json!(false));
            obj.insert("order".to_owned(), json!(order));
            if let Some(offset) = t.offset_days {
                obj.insert("offset_days".to_owned(), json!(offset));
            }
            if let Some(rec) = &t.recurrence {
                obj.insert("recurrence".to_owned(), rec.clone());
            }
            Value::Object(obj)
        })
        .collect()
}

fn from_geo(
    origin: GeoPoint,
    val: Option<&Value>,
    path: &str,
) -> Result<StampPoint, StampPayloadRefusal> {
    let lon = val.and_then(|v| v.get("lon")).and_then(Value::as_f64);
    let lat = val.and_then(|v| v.get("lat")).and_then(Value::as_f64);
    match (lon, lat) {
        (Some(lon), Some(lat)) => {
            let (x, y) = wgs84_to_metres(origin, lon, lat);
            Ok(StampPoint { x, y })
        }
        _ => Err(StampPayloadRefusal::InvalidPayload {
            field_path: path.to_owned(),
            message: "expected GeoPoint".to_owned(),
        }),
    }
}

fn decode_plants(
    design: &Value,
    origin: GeoPoint,
) -> Result<Vec<StampPlantV3>, StampPayloadRefusal> {
    let mut plants = Vec::new();
    for (i, p) in design["plants"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        plants.push(StampPlantV3 {
            id: p["id"].as_str().unwrap_or("").to_owned(),
            canonical_name: p["canonical_name"].as_str().unwrap_or("").to_owned(),
            common_name: p["common_name"].as_str().map(ToOwned::to_owned),
            color: p["color"].as_str().map(ToOwned::to_owned),
            symbol: p["symbol"].as_str().map(ToOwned::to_owned),
            pinned_name: p["pinned_name"].as_bool().unwrap_or(false),
            locked: p["locked"].as_bool().unwrap_or(false),
            position: from_geo(
                origin,
                p.get("position"),
                &format!("$.plants[{i}].position"),
            )?,
            rotation_deg: p["rotation"].as_f64(),
            canopy_spread_m: p["canopy_spread_m"].as_f64(),
            notes: p["notes"].as_str().map(ToOwned::to_owned),
        });
    }
    Ok(plants)
}

fn decode_zones(design: &Value, origin: GeoPoint) -> Result<Vec<StampZoneV3>, StampPayloadRefusal> {
    let mut zones = Vec::new();
    for (i, z) in design["zones"].as_array().into_iter().flatten().enumerate() {
        let mut pts = Vec::new();
        for (pi, pt) in z["points"].as_array().into_iter().flatten().enumerate() {
            pts.push(from_geo(
                origin,
                Some(pt),
                &format!("$.zones[{i}].points[{pi}]"),
            )?);
        }
        zones.push(StampZoneV3 {
            id: z["id"].as_str().unwrap_or("").to_owned(),
            name: z["name"].as_str().map(ToOwned::to_owned),
            locked: z["locked"].as_bool().unwrap_or(false),
            zone_type: z["zone_type"].as_str().unwrap_or("").to_owned(),
            points: pts,
            rotation_deg: z["rotation"].as_f64().unwrap_or(0.0),
            fill_color: z["fill_color"].as_str().map(ToOwned::to_owned),
            stroke_color: z["stroke_color"].as_str().map(ToOwned::to_owned),
            opacity: z["opacity"].as_f64(),
            notes: z["notes"].as_str().map(ToOwned::to_owned),
        });
    }
    Ok(zones)
}

fn decode_annotations(
    design: &Value,
    origin: GeoPoint,
) -> Result<Vec<StampAnnotationV3>, StampPayloadRefusal> {
    let mut annotations = Vec::new();
    for (i, a) in design["annotations"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        annotations.push(StampAnnotationV3 {
            id: a["id"].as_str().unwrap_or("").to_owned(),
            locked: a["locked"].as_bool().unwrap_or(false),
            annotation_type: a["annotation_type"].as_str().unwrap_or("text").to_owned(),
            position: from_geo(
                origin,
                a.get("position"),
                &format!("$.annotations[{i}].position"),
            )?,
            text: a["text"].as_str().unwrap_or("").to_owned(),
            font_size: a["font_size"].as_f64().unwrap_or(14.0),
            rotation_deg: a["rotation"].as_f64(),
        });
    }
    Ok(annotations)
}

fn decode_guides(
    design: &Value,
    origin: GeoPoint,
) -> Result<Vec<StampGuideV3>, StampPayloadRefusal> {
    let mut guides = Vec::new();
    for (i, g) in design["measurement_guides"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        guides.push(StampGuideV3 {
            id: g["id"].as_str().unwrap_or("").to_owned(),
            locked: g["locked"].as_bool().unwrap_or(false),
            start: from_geo(
                origin,
                g.get("start"),
                &format!("$.measurement_guides[{i}].start"),
            )?,
            end: from_geo(
                origin,
                g.get("end"),
                &format!("$.measurement_guides[{i}].end"),
            )?,
        });
    }
    Ok(guides)
}

fn decode_consortiums(design: &Value) -> Vec<StampConsortiumV3> {
    design["consortiums"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let name = c["target"]["canonical_name"].as_str()?;
            Some(StampConsortiumV3 {
                canonical_name: name.to_owned(),
                stratum: c["stratum"].as_str().unwrap_or("").to_owned(),
                start_phase: c["start_phase"].as_i64().unwrap_or(0) as i32,
                end_phase: c["end_phase"].as_i64().unwrap_or(0) as i32,
            })
        })
        .collect()
}

fn decode_budget(design: &Value) -> Vec<StampBudgetLineV3> {
    design["budget"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| {
            let name = b["target"]["canonical_name"].as_str()?;
            Some(StampBudgetLineV3 {
                canonical_name: name.to_owned(),
                unit_cost: b["unit_cost"].as_f64().unwrap_or(0.0),
            })
        })
        .collect()
}

fn decode_timeline(design: &Value) -> Vec<StampCareActionV3> {
    design["timeline"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| StampCareActionV3 {
            id: t["id"].as_str().unwrap_or("").to_owned(),
            action_type: t["action_type"].as_str().unwrap_or("").to_owned(),
            description: t["description"].as_str().unwrap_or("").to_owned(),
            offset_days: t["offset_days"].as_i64().map(|v| v as i32),
            recurrence: t.get("recurrence").filter(|v| !v.is_null()).cloned(),
            targets: t["targets"].as_array().cloned().unwrap_or_default(),
        })
        .collect()
}

fn string_map(val: Option<&Value>) -> BTreeMap<String, String> {
    val.and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
        .collect()
}

fn metres_to_wgs84(origin: GeoPoint, dx_m: f64, dy_m: f64) -> (f64, f64) {
    let cos_lat = origin.lat.to_radians().cos().max(1e-6);
    let lon = origin.lon + dx_m / (METRES_PER_DEG_LAT * cos_lat);
    let lat = origin.lat + dy_m / METRES_PER_DEG_LAT;
    (lon, lat)
}

fn wgs84_to_metres(origin: GeoPoint, lon: f64, lat: f64) -> (f64, f64) {
    let cos_lat = origin.lat.to_radians().cos().max(1e-6);
    let dx = (lon - origin.lon) * METRES_PER_DEG_LAT * cos_lat;
    let dy = (lat - origin.lat) * METRES_PER_DEG_LAT;
    (dx, dy)
}
