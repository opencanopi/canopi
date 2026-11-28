//! Pure JSON record-2 helpers for `services::settings` (parsing, v1 -> v2 migration,
//! record-2 field validation, and locale-region unit defaults).

use std::path::Path;

use canopi_types::quantity::{UnitSystem, default_unit_system_for_region};
use canopi_types::store_chain::{Admission, SETTINGS_CHAIN};
use serde_json::{Map, Value};

/// Retired v1 keys dropped during v1 -> v2 migration.
const RETIRED_V1_KEYS: &[&str] = &["satellite_provider", "auto_save_interval_s"];

/// Maximum Web Mercator latitude in degrees (matches `field-table.ts` / `canopi-design-format`).
const WEB_MERCATOR_MAX_LATITUDE_DEG: f64 = 85.051_128_779_806_6;

pub(super) enum ParsedRecord {
    Current(Map<String, Value>),
    Migratable(Map<String, Value>),
    Newer(Map<String, Value>),
    Unreadable(String),
}

pub(super) fn read_file_if_exists(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub(super) fn parse_raw_record(raw: &str) -> ParsedRecord {
    let value = match serde_json::from_str::<Value>(raw) {
        Ok(value) => value,
        Err(error) => {
            return ParsedRecord::Unreadable(format!(
                "line {}, column {}",
                error.line(),
                error.column()
            ));
        }
    };
    let Value::Object(map) = value else {
        return ParsedRecord::Unreadable("root is not a JSON object".to_owned());
    };
    let Some(version_val) = map.get("version") else {
        return ParsedRecord::Migratable(map);
    };
    let Some(version) = version_val.as_u64() else {
        return ParsedRecord::Unreadable("version is not a non-negative integer".to_owned());
    };
    let Ok(version) = u32::try_from(version) else {
        return ParsedRecord::Newer(map);
    };
    match SETTINGS_CHAIN.admit(Some(version)) {
        Admission::Current => ParsedRecord::Current(map),
        Admission::Migratable { .. } => ParsedRecord::Migratable(map),
        Admission::NewerReadable { .. } => ParsedRecord::Newer(map),
        Admission::BeforeFloor { .. } | Admission::Absent | Admission::RefusedNewer { .. } => {
            ParsedRecord::Unreadable(format!("unsupported version {version}"))
        }
    }
}

/// Migrates a v1 object (or legacy SQLite row) to record 2: drops retired keys, folds
/// `check_updates_at_launch` / SQLite `updater.check_at_launch` into `launch_check`,
/// adds `unit_system` and `last_open_home` if absent, and stamps `"version": 2`.
pub(super) fn migrate_v1_object_to_v2(
    mut map: Map<String, Value>,
    legacy_launch: Option<&str>,
    detected_os_locale: Option<&str>,
) -> Map<String, Value> {
    for retired in RETIRED_V1_KEYS {
        map.remove(*retired);
    }
    if !map.contains_key("launch_check") {
        if let Some(folded) = map.remove("check_updates_at_launch") {
            map.insert("launch_check".to_owned(), folded);
        } else if let Some(raw_launch) = legacy_launch {
            map.insert(
                "launch_check".to_owned(),
                Value::Bool(raw_launch != "false"),
            );
        } else {
            map.insert("launch_check".to_owned(), Value::Bool(true));
        }
    }
    if !map.contains_key("unit_system") {
        let unit = default_unit_system_for_locale(detected_os_locale);
        map.insert("unit_system".to_owned(), unit_system_value(unit));
    }
    if !map.contains_key("last_open_home") {
        map.insert("last_open_home".to_owned(), Value::Null);
    }
    map.insert("version".to_owned(), Value::from(SETTINGS_CHAIN.current()));
    map
}

/// Validates record-2 and clamped numeric/array fields. Returns `Some(Some(normalized))`
/// when handled and valid, `Some(None)` when handled and invalid, or `None` when the
/// caller should validate via `Settings`.
pub(super) fn validate_special_field(key: &str, value: &Value) -> Option<Option<Value>> {
    match key {
        "unit_system" => Some(match value.as_str() {
            Some("metric" | "us_customary") => Some(value.clone()),
            _ => None,
        }),
        "launch_check" => Some(value.as_bool().map(Value::Bool)),
        "last_open_home" => Some(match value {
            Value::Null => Some(Value::Null),
            Value::String(s) if !s.trim().is_empty() => Some(Value::String(s.trim().to_owned())),
            _ => None,
        }),
        "basemap_opacity" | "satellite_opacity" | "contour_opacity" | "hillshade_opacity" => {
            Some(validate_clamped_f64(value, 0.0, 1.0))
        }
        "plant_spacing_interval_m" => Some(
            value
                .as_f64()
                .filter(|n| n.is_finite() && *n > 0.0)
                .map(|_| value.clone()),
        ),
        "new_design_symbol_scale" => Some(validate_clamped_f64(value, 0.5, 2.0)),
        "last_view" => Some(validate_last_view(value)),
        "used_canvas_tools" => Some(validate_used_canvas_tools(value)),
        _ => None,
    }
}

fn validate_clamped_f64(value: &Value, min: f64, max: f64) -> Option<Value> {
    let n = value.as_f64().filter(|n| n.is_finite())?;
    serde_json::Number::from_f64(n.clamp(min, max)).map(Value::Number)
}

fn validate_last_view(value: &Value) -> Option<Value> {
    match value {
        Value::Null => Some(Value::Null),
        Value::Object(obj) => {
            let lon = obj.get("lon")?.as_f64()?;
            let lat = obj.get("lat")?.as_f64()?;
            let zoom = obj.get("zoom")?.as_f64()?;
            if lon.is_finite()
                && lat.is_finite()
                && zoom.is_finite()
                && (-180.0..=180.0).contains(&lon)
                && lat.abs() <= WEB_MERCATOR_MAX_LATITUDE_DEG
            {
                Some(serde_json::json!({ "lon": lon, "lat": lat, "zoom": zoom }))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn validate_used_canvas_tools(value: &Value) -> Option<Value> {
    let arr = value.as_array()?;
    let mut deduped: Vec<Value> = Vec::with_capacity(arr.len());
    for item in arr {
        let s = item.as_str()?;
        let v = Value::String(s.to_owned());
        if !deduped.contains(&v) {
            deduped.push(v);
        }
    }
    Some(Value::Array(deduped))
}

fn region_from_locale(os_locale: Option<&str>) -> Option<&str> {
    let raw = os_locale?.trim();
    raw.split(['-', '_', '.'])
        .skip(1)
        .find(|part| part.len() == 2 && part.bytes().all(|b| b.is_ascii_alphabetic()))
}

pub(super) fn default_unit_system_for_locale(os_locale: Option<&str>) -> UnitSystem {
    default_unit_system_for_region(region_from_locale(os_locale))
}

pub(super) fn unit_system_value(unit: UnitSystem) -> Value {
    serde_json::to_value(unit).unwrap_or_else(|_| Value::String("metric".to_owned()))
}
