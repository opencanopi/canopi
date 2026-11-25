//! The `.canopi` migration chain (contracts §10, ADR 0026, 2.1-Q69, 2.1-Q96,
//! 2.1-Q162, 2.1-Q314, 2.1-Q347, 2.1-Q35r, 2.1-Q348, 2.1-M482, 2.1-M491, 2.1-M493).
//!
//! Every step is pure (no I/O, clock or randomness) and operates on JSON values
//! at the one decode choke point. Version admission delegates to
//! [`canopi_types::store_chain::admit_form_version`] with `max_readable = Some(10)`
//! so versions above 10 settle [`Admission::RefusedNewer`] (2.1-Q347).

use canopi_types::design::DEFAULT_BUDGET_CURRENCY;
use canopi_types::store_chain::{Admission, admit_form_version};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

/// Lowest `.canopi` format version this build migrates from (v2.0.0).
pub const CANOPI_FLOOR: u32 = 9;

/// One pure migration step advancing a `.canopi` JSON value from `from` to `from + 1`.
#[derive(Debug, Clone, Copy)]
pub struct CanopiStep {
    /// Input format version accepted by this step.
    pub from: u32,
    /// Pure JSON transform producing version `from + 1`.
    pub run: fn(Value) -> Result<Value, StepFailure>,
}

/// Failure returned when a `.canopi` migration step cannot upgrade a value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepFailure {
    /// Format version the failing step started from.
    pub from: u32,
    /// Redacted English diagnostic naming what failed (never a user file value).
    pub reason: String,
}

/// Ordered contiguous `.canopi` migration steps from [`CANOPI_FLOOR`] to [`CANOPI_CURRENT`].
pub const CANOPI_STEPS: &[CanopiStep] = &[CanopiStep {
    from: 9,
    run: migrate_v9_to_v10,
}];

/// Current `.canopi` format version written by the v10 Format Core (`FLOOR + STEPS.len()`).
pub const CANOPI_CURRENT: u32 = CANOPI_FLOOR + CANOPI_STEPS.len() as u32;

const _: () = {
    let mut expected = CANOPI_FLOOR;
    let mut idx = 0;
    while idx < CANOPI_STEPS.len() {
        assert!(
            CANOPI_STEPS[idx].from == expected,
            "CANOPI_STEPS must be contiguous from CANOPI_FLOOR"
        );
        expected += 1;
        idx += 1;
    }
};

/// Frozen table mapping a `.canopi` format version to the Canopi release label
/// used when naming a pre-upgrade copy (contracts §10, 2.1-Q35r).
#[must_use]
pub const fn release_label(format_version: u32) -> Option<&'static str> {
    match format_version {
        9 => Some("2.0"),
        10 => Some("2.1"),
        _ => None,
    }
}

/// Classifies an optional `.canopi` format version against `[CANOPI_FLOOR, CANOPI_CURRENT]`.
///
/// From 2.1.0, `max_readable` equals `Some(CANOPI_CURRENT)` so any version above 10
/// settles [`Admission::RefusedNewer`] unchanged (2.1-Q347).
#[must_use]
pub const fn admit_canopi_version(version: Option<u32>) -> Admission {
    admit_form_version(CANOPI_FLOOR, CANOPI_CURRENT, Some(CANOPI_CURRENT), version)
}

/// Builds the pre-upgrade backup file name for a migrated file home (contracts §10, 2.1-Q35r).
///
/// `attempt == 0` yields `<stem> (Canopi <label>).canopi`; subsequent attempts yield
/// `<stem> (Canopi <label>) (<attempt + 1>).canopi` so an existing file is never overwritten.
#[must_use]
pub fn pre_upgrade_copy_name(stem: &str, from_version: u32, attempt: u32) -> Option<String> {
    let label = release_label(from_version)?;
    let trimmed = stem.trim();
    let base = if trimmed.is_empty() {
        "Design"
    } else {
        trimmed
    };
    if attempt == 0 {
        Some(format!("{base} (Canopi {label}).canopi"))
    } else {
        Some(format!("{base} (Canopi {label}) ({}).canopi", attempt + 1))
    }
}

/// Decision metadata for the first write after a migrated open (contracts §4, §10; 2.1-Q35r, 2.1-Q348).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PreUpgradeCopyDecision {
    /// No pre-upgrade copy is needed (opened at current version or Web open).
    NotNeeded,
    /// First write to a Desktop file or Desktop Draft home must preserve the prior format once.
    Required {
        /// Format version the Design was migrated from.
        from_version: u32,
        /// Frozen release label for `from_version` (e.g. `"2.0"`).
        release_label: String,
        /// Suggested backup name for file homes (`None` for Desktop Drafts under `drafts/before-v10/`).
        suggested_name: Option<String>,
    },
    /// The folder beside the file home is unwritable; save pauses until user chooses save without copy.
    CopyBlocked {
        /// Display folder name that refused the copy.
        folder: String,
        /// Format version the Design was migrated from.
        from_version: u32,
        /// Frozen release label for `from_version`.
        release_label: String,
    },
}

/// Computes the initial [`PreUpgradeCopyDecision`] for an opened Design.
#[must_use]
pub fn pre_upgrade_copy_decision(
    migrated_from: Option<u32>,
    stem: Option<&str>,
) -> PreUpgradeCopyDecision {
    let Some(from_version) = migrated_from else {
        return PreUpgradeCopyDecision::NotNeeded;
    };
    let label = release_label(from_version).unwrap_or("2.0");
    let suggested_name = stem.and_then(|s| pre_upgrade_copy_name(s, from_version, 0));
    PreUpgradeCopyDecision::Required {
        from_version,
        release_label: label.to_owned(),
        suggested_name,
    }
}

/// Converts a [`PreUpgradeCopyDecision`] into [`PreUpgradeCopyDecision::CopyBlocked`] when
/// the target folder cannot accept the backup copy (2.1-Q35r).
#[must_use]
pub fn mark_copy_blocked(from_version: u32, folder: impl Into<String>) -> PreUpgradeCopyDecision {
    let label = release_label(from_version).unwrap_or("2.0");
    PreUpgradeCopyDecision::CopyBlocked {
        folder: folder.into(),
        from_version,
        release_label: label.to_owned(),
    }
}

/// Runs [`CANOPI_STEPS`] in order starting at `from_version` up to [`CANOPI_CURRENT`].
///
/// # Errors
///
/// Returns [`StepFailure`] naming the failing step's `from` version.
pub fn run_migration_steps(mut value: Value, from_version: u32) -> Result<Value, StepFailure> {
    let start = from_version
        .checked_sub(CANOPI_FLOOR)
        .ok_or_else(|| StepFailure {
            from: from_version,
            reason: "version below migration floor".to_owned(),
        })? as usize;
    if start > CANOPI_STEPS.len() {
        return Err(StepFailure {
            from: from_version,
            reason: "version above current chain".to_owned(),
        });
    }
    for step in &CANOPI_STEPS[start..] {
        value = (step.run)(value)?;
    }
    Ok(value)
}

/// Runs a custom step slice (used by tests to verify `migration_failed` with a planted failing step).
///
/// # Errors
///
/// Returns [`StepFailure`] from the first failing step.
pub fn run_steps_with(
    steps: &[CanopiStep],
    floor: u32,
    mut value: Value,
    from_version: u32,
) -> Result<Value, StepFailure> {
    let start = from_version.checked_sub(floor).ok_or_else(|| StepFailure {
        from: from_version,
        reason: "version below migration floor".to_owned(),
    })? as usize;
    for step in steps.get(start..).unwrap_or(&[]) {
        value = (step.run)(value)?;
    }
    Ok(value)
}

/// Pure v9 → v10 migration step (2.1-Q69, 2.1-Q96, 2.1-Q162, 2.1-Q314, 2.1-M482, 2.1-M491, 2.1-M493).
pub fn migrate_v9_to_v10(mut value: Value) -> Result<Value, StepFailure> {
    let Some(root) = value.as_object_mut() else {
        return Err(StepFailure {
            from: 9,
            reason: "expected a JSON object at root".to_owned(),
        });
    };

    root.insert("version".to_owned(), json!(10));
    migrate_plants(root)?;
    migrate_site_data(root);
    migrate_plant_display(root);
    migrate_budget(root);
    normalise_groups_value(root);

    Ok(value)
}

fn migrate_plants(root: &mut Map<String, Value>) -> Result<(), StepFailure> {
    let Some(plants) = root.get_mut("plants").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for plant in plants {
        let Some(obj) = plant.as_object_mut() else {
            return Err(StepFailure {
                from: 9,
                reason: "expected plant object".to_owned(),
            });
        };
        if let Some(scale) = obj.remove("scale")
            && !obj.contains_key("canopy_spread_m")
            && !scale.is_null()
        {
            obj.insert("canopy_spread_m".to_owned(), scale);
        }
    }
    Ok(())
}

fn migrate_site_data(root: &mut Map<String, Value>) {
    if let Some(lidar) = root.remove("lidar")
        && !root.contains_key("site_data")
    {
        if lidar.is_null() {
            // Absent site_data omits the null key cleanly.
        } else {
            root.insert("site_data".to_owned(), lidar);
        }
    }
    let Some(site_data) = root.get_mut("site_data").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(entries) = site_data.get_mut("entries").and_then(Value::as_array_mut) else {
        return;
    };
    // Drop `kind` and deduplicate by `id`, keeping the lowest `order` (2.1-M493).
    let mut best_by_id: HashMap<String, (u64, usize, Value)> = HashMap::new();
    let mut unkeyed = Vec::new();
    for (idx, mut entry) in entries.drain(..).enumerate() {
        if let Some(obj) = entry.as_object_mut() {
            obj.remove("kind");
            let id = obj.get("id").and_then(Value::as_str).map(ToOwned::to_owned);
            let order = obj.get("order").and_then(Value::as_u64).unwrap_or(0);
            if let Some(id) = id {
                match best_by_id.get(&id) {
                    Some((prev_order, _, _)) if *prev_order <= order => {}
                    _ => {
                        best_by_id.insert(id, (order, idx, entry));
                    }
                }
                continue;
            }
        }
        unkeyed.push((idx, entry));
    }
    let mut kept: Vec<(u64, usize, Value)> = best_by_id.into_values().collect();
    kept.sort_by_key(|(order, idx, _)| (*order, *idx));
    for (_, _, entry) in kept {
        entries.push(entry);
    }
    for (_, entry) in unkeyed {
        entries.push(entry);
    }
}

fn migrate_plant_display(root: &mut Map<String, Value>) {
    let mut extracted = None;
    if let Some(extra) = root.get_mut("extra").and_then(Value::as_object_mut) {
        extracted = extra.remove("plant_display");
        if extra.is_empty() {
            root.remove("extra");
        }
    }
    if let Some(display) = extracted
        && !display.is_null()
        && !root.contains_key("plant_display")
    {
        root.insert("plant_display".to_owned(), display);
    }
}

fn migrate_budget(root: &mut Map<String, Value>) {
    let design_currency = root
        .get("budget_currency")
        .and_then(Value::as_str)
        .filter(|c| !c.trim().is_empty())
        .unwrap_or(DEFAULT_BUDGET_CURRENCY)
        .to_owned();
    if !root.contains_key("budget_currency") {
        root.insert("budget_currency".to_owned(), json!(design_currency));
    }
    let Some(budget) = root.get_mut("budget").and_then(Value::as_array_mut) else {
        return;
    };
    let mut plant_lines = Vec::new();
    let mut non_plant_lines = Vec::new();
    for line in budget.drain(..) {
        let Some(mut obj) = line.as_object().cloned() else {
            continue;
        };
        let target_kind = obj
            .get("target")
            .and_then(|t| t.get("kind"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let category = obj
            .get("category")
            .and_then(Value::as_str)
            .unwrap_or("plants");
        if target_kind == "species" && category == "plants" {
            let target = obj.remove("target").unwrap_or_else(|| json!({}));
            let unit_cost = obj.remove("unit_cost").unwrap_or_else(|| json!(0.0));
            let mut ext = match obj.remove("ext") {
                Some(Value::Object(map)) => map,
                _ => Map::new(),
            };
            for dropped in ["category", "description", "quantity", "currency"] {
                if let Some(val) = obj.remove(dropped) {
                    ext.entry(dropped.to_owned()).or_insert(val);
                }
            }
            for (k, v) in obj {
                ext.entry(k).or_insert(v);
            }
            let mut next_line = Map::new();
            next_line.insert("target".to_owned(), target);
            next_line.insert("unit_cost".to_owned(), unit_cost);
            if !ext.is_empty() {
                next_line.insert("ext".to_owned(), Value::Object(ext));
            }
            plant_lines.push(Value::Object(next_line));
        } else {
            non_plant_lines.push(Value::Object(obj));
        }
    }
    *budget = plant_lines;
    if !non_plant_lines.is_empty() {
        root.insert(
            "budget_ext".to_owned(),
            json!({ "non_plant_lines": non_plant_lines }),
        );
    }
}

/// Normalises `groups` on a JSON `.canopi` root in place: removes dangling or duplicate
/// members and drops groups with fewer than two remaining members (contracts §10).
pub(crate) fn normalise_groups_value(root: &mut Map<String, Value>) {
    let plant_ids = collect_ids(root.get("plants"));
    let zone_ids = collect_ids(root.get("zones"));
    let annotation_ids = collect_ids(root.get("annotations"));
    let guide_ids = collect_ids(root.get("measurement_guides"));

    let Some(groups) = root.get_mut("groups").and_then(Value::as_array_mut) else {
        return;
    };
    groups.retain_mut(|group| {
        let Some(obj) = group.as_object_mut() else {
            return false;
        };
        let Some(members) = obj.get_mut("members").and_then(Value::as_array_mut) else {
            return false;
        };
        let mut seen = HashSet::new();
        members.retain(|member| {
            let Some(kind) = member.get("kind").and_then(Value::as_str) else {
                return false;
            };
            let Some(id) = member.get("id").and_then(Value::as_str) else {
                return false;
            };
            let exists = match kind {
                "plant" => plant_ids.contains(id),
                "zone" => zone_ids.contains(id),
                "annotation" => annotation_ids.contains(id),
                "measurement_guide" => guide_ids.contains(id),
                _ => false,
            };
            exists && seen.insert((kind.to_owned(), id.to_owned()))
        });
        members.len() >= 2
    });
}

fn collect_ids(list: Option<&Value>) -> HashSet<String> {
    list.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect()
}

/// 64-bit FNV-1a fingerprint over canonical JSON bytes (used by `migration_steps_frozen`).
#[must_use]
pub fn canonical_fingerprint(value: &Value) -> u64 {
    let canonical = canonical_json_string(value);
    canonical.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// Recursively sorts every JSON object's keys so serialization is deterministic (2.1-M156).
#[must_use]
pub fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by_key(|(k, _)| *k);
            let mut sorted = Map::with_capacity(entries.len());
            for (k, v) in entries {
                sorted.insert(k.clone(), canonicalize_json(v));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_json).collect()),
        other => other.clone(),
    }
}

/// Canonical compact JSON encoding (sorted keys at every depth, 2.1-M156).
#[must_use]
pub fn canonical_json_string(value: &Value) -> String {
    serde_json::to_string(&canonicalize_json(value)).unwrap_or_else(|_| String::from("{}"))
}
