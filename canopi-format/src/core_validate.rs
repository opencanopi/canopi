//! Validation and decode-side normalisation helpers for [`crate::core`].

use std::collections::{HashMap, HashSet};

use canopi_types::design::{WEB_MERCATOR_MAX_LATITUDE_DEG, field_path::FieldPath};
use serde_json::{Map, Value};

use crate::core::FormatRefusal;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AdmissionMode {
    Decode,
    Write,
}

pub(crate) fn admit_design(value: &Value, mode: AdmissionMode) -> Result<(), FormatRefusal> {
    let root = FieldPath::root();
    let Some(obj) = value.as_object() else {
        return Err(FormatRefusal::invalid_document(
            root,
            "expected a JSON object",
        ));
    };
    let plant_ids = admit_plants(obj, &root)?;
    let zone_ids = admit_zones(obj, &root)?;
    let ann_ids = admit_annotations(obj, &root)?;
    let guide_ids = admit_guides(obj, &root)?;
    admit_groups(
        obj, &root, mode, &plant_ids, &zone_ids, &ann_ids, &guide_ids,
    )?;
    admit_site_data(obj, &root, mode)?;
    admit_budget_species_lines(obj, &root)?;
    admit_print_setup(obj, &root)?;
    Ok(())
}

pub(crate) fn dedup_site_data_on_decode(root: &mut Map<String, Value>) {
    let Some(site) = root.get_mut("site_data").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(entries) = site.get_mut("entries").and_then(Value::as_array_mut) else {
        return;
    };
    let mut best: HashMap<String, (u64, usize, Value)> = HashMap::new();
    for (idx, entry) in entries.drain(..).enumerate() {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let order = entry.get("order").and_then(Value::as_u64).unwrap_or(0);
        match best.get(&id) {
            Some((prev, _, _)) if *prev <= order => {}
            _ => {
                best.insert(id, (order, idx, entry));
            }
        }
    }
    let mut kept: Vec<(u64, usize, Value)> = best.into_values().collect();
    kept.sort_by_key(|(order, idx, _)| (*order, *idx));
    for (_, _, entry) in kept {
        entries.push(entry);
    }
}

fn admit_plants(
    obj: &Map<String, Value>,
    root: &FieldPath,
) -> Result<HashSet<String>, FormatRefusal> {
    let mut ids = HashSet::new();
    let Some(plants) = obj.get("plants").and_then(Value::as_array) else {
        return Ok(ids);
    };
    for (i, plant) in plants.iter().enumerate() {
        let p = root.field("plants").index(i);
        record_unique_id(plant, &p, &mut ids)?;
        check_geo_point(plant.get("position"), &p.field("position"))?;
        if let Some(spread) = plant.get("canopy_spread_m").filter(|v| !v.is_null())
            && !spread.as_f64().is_some_and(|n| n.is_finite() && n > 0.0)
        {
            return Err(FormatRefusal::invalid_document(
                p.field("canopy_spread_m"),
                "expected a finite number above 0",
            ));
        }
        if let Some(rot) = plant.get("rotation").filter(|v| !v.is_null())
            && !rot.as_f64().is_some_and(f64::is_finite)
        {
            return Err(FormatRefusal::invalid_document(
                p.field("rotation"),
                "expected a finite number",
            ));
        }
    }
    Ok(ids)
}

fn admit_zones(
    obj: &Map<String, Value>,
    root: &FieldPath,
) -> Result<HashSet<String>, FormatRefusal> {
    let mut ids = HashSet::new();
    let Some(zones) = obj.get("zones").and_then(Value::as_array) else {
        return Ok(ids);
    };
    for (i, zone) in zones.iter().enumerate() {
        let z = root.field("zones").index(i);
        record_unique_id(zone, &z, &mut ids)?;
        if let Some(points) = zone.get("points").and_then(Value::as_array) {
            for (pi, pt) in points.iter().enumerate() {
                check_geo_point(Some(pt), &z.field("points").index(pi))?;
            }
        }
        if let Some(opacity) = zone.get("opacity").filter(|v| !v.is_null())
            && !opacity
                .as_f64()
                .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
        {
            return Err(FormatRefusal::invalid_document(
                z.field("opacity"),
                "expected a number in [0, 1]",
            ));
        }
    }
    Ok(ids)
}

fn admit_annotations(
    obj: &Map<String, Value>,
    root: &FieldPath,
) -> Result<HashSet<String>, FormatRefusal> {
    let mut ids = HashSet::new();
    let Some(anns) = obj.get("annotations").and_then(Value::as_array) else {
        return Ok(ids);
    };
    for (i, ann) in anns.iter().enumerate() {
        let a = root.field("annotations").index(i);
        record_unique_id(ann, &a, &mut ids)?;
        check_geo_point(ann.get("position"), &a.field("position"))?;
        if let Some(fs) = ann.get("font_size").filter(|v| !v.is_null())
            && !fs.as_f64().is_some_and(|n| n.is_finite() && n > 0.0)
        {
            return Err(FormatRefusal::invalid_document(
                a.field("font_size"),
                "expected a finite number above 0",
            ));
        }
    }
    Ok(ids)
}

fn admit_guides(
    obj: &Map<String, Value>,
    root: &FieldPath,
) -> Result<HashSet<String>, FormatRefusal> {
    let mut ids = HashSet::new();
    let Some(guides) = obj.get("measurement_guides").and_then(Value::as_array) else {
        return Ok(ids);
    };
    for (i, guide) in guides.iter().enumerate() {
        let g = root.field("measurement_guides").index(i);
        record_unique_id(guide, &g, &mut ids)?;
        check_geo_point(guide.get("start"), &g.field("start"))?;
        check_geo_point(guide.get("end"), &g.field("end"))?;
    }
    Ok(ids)
}

fn admit_groups(
    obj: &Map<String, Value>,
    root: &FieldPath,
    mode: AdmissionMode,
    plant_ids: &HashSet<String>,
    zone_ids: &HashSet<String>,
    ann_ids: &HashSet<String>,
    guide_ids: &HashSet<String>,
) -> Result<(), FormatRefusal> {
    let mut ids = HashSet::new();
    let Some(groups) = obj.get("groups").and_then(Value::as_array) else {
        return Ok(());
    };
    for (i, group) in groups.iter().enumerate() {
        let g = root.field("groups").index(i);
        record_unique_id(group, &g, &mut ids)?;
        if mode != AdmissionMode::Write {
            continue;
        }
        let members = group
            .get("members")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                FormatRefusal::invalid_document(g.field("members"), "expected a member array")
            })?;
        if members.len() < 2 {
            return Err(FormatRefusal::invalid_document(
                g.field("members"),
                "expected at least 2 group members on write",
            ));
        }
        let mut seen = HashSet::new();
        for (mi, member) in members.iter().enumerate() {
            let mpath = g.field("members").index(mi);
            let kind = member.get("kind").and_then(Value::as_str).unwrap_or("");
            let id = member.get("id").and_then(Value::as_str).unwrap_or("");
            let exists = match kind {
                "plant" => plant_ids.contains(id),
                "zone" => zone_ids.contains(id),
                "annotation" => ann_ids.contains(id),
                "measurement_guide" => guide_ids.contains(id),
                _ => false,
            };
            if !exists {
                return Err(FormatRefusal::invalid_document(
                    mpath.field("id"),
                    "expected an existing object id",
                ));
            }
            if !seen.insert((kind, id)) {
                return Err(FormatRefusal::invalid_document(
                    mpath.field("id"),
                    "expected unique group members",
                ));
            }
        }
    }
    Ok(())
}

fn admit_site_data(
    obj: &Map<String, Value>,
    root: &FieldPath,
    mode: AdmissionMode,
) -> Result<(), FormatRefusal> {
    let Some(site) = obj.get("site_data").and_then(Value::as_object) else {
        return Ok(());
    };
    let Some(entries) = site.get("entries").and_then(Value::as_array) else {
        return Ok(());
    };
    let mut seen = HashSet::new();
    for (i, entry) in entries.iter().enumerate() {
        let e = root.field("site_data").field("entries").index(i);
        let id = entry.get("id").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() {
            return Err(FormatRefusal::invalid_document(
                e.field("id"),
                "expected a non-empty id",
            ));
        }
        if mode == AdmissionMode::Write && !seen.insert(id) {
            return Err(FormatRefusal::invalid_document(
                e.field("id"),
                "expected unique site_data entry ids on write",
            ));
        }
        if let Some(op) = entry.get("opacity").filter(|v| !v.is_null())
            && !op
                .as_f64()
                .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
        {
            return Err(FormatRefusal::invalid_document(
                e.field("opacity"),
                "expected a number in [0, 1]",
            ));
        }
    }
    Ok(())
}

fn admit_budget_species_lines(
    obj: &Map<String, Value>,
    root: &FieldPath,
) -> Result<(), FormatRefusal> {
    let Some(budget) = obj.get("budget").and_then(Value::as_array) else {
        return Ok(());
    };
    for (i, line) in budget.iter().enumerate() {
        let b = root.field("budget").index(i);
        let is_species = line
            .get("target")
            .and_then(|t| t.get("kind"))
            .and_then(Value::as_str)
            == Some("species");
        if is_species {
            let name = line
                .get("target")
                .and_then(|t| t.get("canonical_name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if name.trim().is_empty() {
                return Err(FormatRefusal::invalid_document(
                    b.field("target").field("canonical_name"),
                    "expected a non-empty canonical_name for species budget line",
                ));
            }
        }
    }
    Ok(())
}

fn admit_print_setup(obj: &Map<String, Value>, root: &FieldPath) -> Result<(), FormatRefusal> {
    let Some(setup) = obj.get("print_setup").and_then(Value::as_object) else {
        return Ok(());
    };
    let ps = root.field("print_setup");
    let mut split_ids = HashSet::new();
    if let Some(splits) = setup.get("splits").and_then(Value::as_array) {
        for (i, split) in splits.iter().enumerate() {
            let sp = ps.field("splits").index(i);
            record_unique_id(split, &sp, &mut split_ids)?;
            check_geo_point(split.get("pivot"), &sp.field("pivot"))?;
        }
    }
    if let Some(pages) = setup.get("pages").and_then(Value::as_array) {
        let mut page_ids = HashSet::new();
        for (i, page) in pages.iter().enumerate() {
            let pp = ps.field("pages").index(i);
            record_unique_id(page, &pp, &mut page_ids)?;
            if let Some(area) = page.get("area").and_then(Value::as_object)
                && area.get("kind").and_then(Value::as_str) == Some("split_sheet")
            {
                let split_ref = area.get("split").and_then(Value::as_str).unwrap_or("");
                if !split_ids.contains(split_ref) {
                    return Err(FormatRefusal::invalid_document(
                        pp.field("area").field("split"),
                        "expected an existing print_setup split id",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn record_unique_id(
    item: &Value,
    path: &FieldPath,
    seen: &mut HashSet<String>,
) -> Result<(), FormatRefusal> {
    let id = item.get("id").and_then(Value::as_str).unwrap_or("");
    if id.is_empty() {
        return Err(FormatRefusal::invalid_document(
            path.field("id"),
            "expected a non-empty id",
        ));
    }
    if !seen.insert(id.to_owned()) {
        return Err(FormatRefusal::invalid_document(
            path.field("id"),
            "expected a unique id",
        ));
    }
    Ok(())
}

fn check_geo_point(point: Option<&Value>, path: &FieldPath) -> Result<(), FormatRefusal> {
    let Some(obj) = point.and_then(Value::as_object) else {
        return Err(FormatRefusal::invalid_document(
            path.clone(),
            "expected a GeoPoint object",
        ));
    };
    let lat = obj.get("lat").and_then(Value::as_f64).unwrap_or(f64::NAN);
    if !(lat.is_finite()
        && (-WEB_MERCATOR_MAX_LATITUDE_DEG..=WEB_MERCATOR_MAX_LATITUDE_DEG).contains(&lat))
    {
        return Err(FormatRefusal::invalid_document(
            path.field("lat"),
            format!(
                "expected a Web Mercator latitude in [-{WEB_MERCATOR_MAX_LATITUDE_DEG}, {WEB_MERCATOR_MAX_LATITUDE_DEG}]"
            ),
        ));
    }
    let lon = obj.get("lon").and_then(Value::as_f64).unwrap_or(f64::NAN);
    if !(lon.is_finite() && (-180.0..=180.0).contains(&lon)) {
        return Err(FormatRefusal::invalid_document(
            path.field("lon"),
            "expected lon in [-180, 180]",
        ));
    }
    Ok(())
}
