//! The rules a `.canopi` Design's schema cannot state, checked after it is decoded:
//! positions, identities and ranges. Each refusal names its leaf field (canopi-cyqd,
//! 2.1-M430) and never a file value.

use std::collections::{HashMap, HashSet};

use super::field_path::{FieldPath, Refusal};
use super::v10::{CanopiFileV10, GeoPointV10, LidarColourRangeV10, ObjectGroupMemberV10};
use super::{GeoPoint, WEB_MERCATOR_MAX_LATITUDE_DEG};

const FINITE: &str = "expected a finite number";
const UNIT_INTERVAL: &str = "expected a number in [0, 1]";

/// A WGS84 position's leaf at fault, latitude first as the schema walks it.
pub(crate) fn check_point(point: &GeoPoint, path: &FieldPath) -> Result<(), Refusal> {
    let lat_valid = point.lat.is_finite()
        && (-WEB_MERCATOR_MAX_LATITUDE_DEG..=WEB_MERCATOR_MAX_LATITUDE_DEG).contains(&point.lat);
    if !lat_valid {
        return Err(Refusal::new(
            path.field("lat"),
            format!(
                "expected a Web Mercator latitude in [-{WEB_MERCATOR_MAX_LATITUDE_DEG}, {WEB_MERCATOR_MAX_LATITUDE_DEG}]"
            ),
        ));
    }
    if !(point.lon.is_finite() && (-180.0..=180.0).contains(&point.lon)) {
        return Err(Refusal::new(
            path.field("lon"),
            "expected lon in [-180, 180]",
        ));
    }
    Ok(())
}

/// The first empty or repeated id of the list at `$.<key>`, named by its index only.
pub(crate) fn check_unique_ids<'a>(
    key: &'static str,
    ids: impl Iterator<Item = &'a str>,
) -> Result<(), Refusal> {
    let list = FieldPath::root().field(key);
    let mut seen = std::collections::HashSet::new();
    for (index, id) in ids.enumerate() {
        if id.is_empty() {
            return Err(Refusal::new(
                list.index(index).field("id"),
                "expected a non-empty id",
            ));
        }
        if !seen.insert(id) {
            return Err(Refusal::new(
                list.index(index).field("id"),
                "expected a unique id",
            ));
        }
    }
    Ok(())
}

/// Whether [`admit_design_v10`] is checking a decoded file or an outgoing write (`canopi-gjs3`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V10AdmissionMode {
    /// Decode-time admission (after group normalisation and site_data dedup).
    Decode,
    /// Write-time admission (refuses dangling/duplicate/<2 group members and duplicate site_data ids).
    Write,
}

struct MemberIdSets<'a> {
    plants: HashSet<&'a str>,
    zones: HashSet<&'a str>,
    annotations: HashSet<&'a str>,
    guides: HashSet<&'a str>,
}

impl<'a> MemberIdSets<'a> {
    fn from_file(file: &'a CanopiFileV10) -> Self {
        Self {
            plants: file.plants.iter().map(|p| p.id.as_str()).collect(),
            zones: file.zones.iter().map(|z| z.id.as_str()).collect(),
            annotations: file.annotations.iter().map(|a| a.id.as_str()).collect(),
            guides: file
                .measurement_guides
                .iter()
                .map(|g| g.id.as_str())
                .collect(),
        }
    }

    fn contains(&self, member: &ObjectGroupMemberV10) -> bool {
        match member {
            ObjectGroupMemberV10::Plant { id, .. } => self.plants.contains(id.as_str()),
            ObjectGroupMemberV10::Zone { id, .. } => self.zones.contains(id.as_str()),
            ObjectGroupMemberV10::Annotation { id, .. } => self.annotations.contains(id.as_str()),
            ObjectGroupMemberV10::MeasurementGuide { id, .. } => self.guides.contains(id.as_str()),
        }
    }
}

/// Normalises decode-time invariants on a typed [`CanopiFileV10`] in one place:
/// - Strips dangling or duplicate group members and drops groups with fewer than 2 members (`2.1-Q154`).
/// - Deduplicates `site_data.entries` by `id`, keeping the lowest `order` (`contracts.md:432`, `2.1-M493`).
pub fn normalise_v10_on_decode(file: &mut CanopiFileV10) {
    let mut groups = std::mem::take(&mut file.groups);
    {
        let ids = MemberIdSets::from_file(file);
        groups.retain_mut(|group| {
            let mut seen = HashSet::new();
            group.members.retain(|member| {
                let (kind, id) = member.identity();
                ids.contains(member) && seen.insert((kind, id.to_owned()))
            });
            group.members.len() >= 2
        });
    }
    file.groups = groups;

    if let Some(site) = &mut file.site_data {
        let mut best: HashMap<String, (u32, usize, super::v10::SiteDataEntryV10)> = HashMap::new();
        for (idx, entry) in site.entries.drain(..).enumerate() {
            match best.get(&entry.id) {
                Some((prev_order, _, _)) if *prev_order <= entry.order => {}
                _ => {
                    best.insert(entry.id.clone(), (entry.order, idx, entry));
                }
            }
        }
        let mut kept: Vec<_> = best.into_values().collect();
        kept.sort_by_key(|(order, idx, _)| (*order, *idx));
        site.entries = kept.into_iter().map(|(_, _, e)| e).collect();
    }
}

pub(super) fn check_point_v10(point: &GeoPointV10, path: &FieldPath) -> Result<(), Refusal> {
    check_point(
        &GeoPoint {
            lon: point.lon,
            lat: point.lat,
        },
        path,
    )
}

/// The single typed admission rule set for v10 `.canopi` Designs (`ADR 0026`, `canopi-gjs3`),
/// sharing [`check_point`] and [`check_unique_ids`] with v9 admission.
pub fn admit_design_v10(file: &CanopiFileV10, mode: V10AdmissionMode) -> Result<(), Refusal> {
    let root = FieldPath::root();
    if file.extra.contains_key("extra") {
        return Err(Refusal::new(
            root.field("extra"),
            "reserved root field 'extra' is not allowed",
        ));
    }
    admit_v10_scene_objects(file, &root)?;
    admit_v10_groups(file, &root, mode)?;
    admit_v10_site_data(file, &root, mode)?;
    admit_v10_budget(file, &root)?;
    if let Some(setup) = &file.print_setup {
        super::v10_print::admit_print_setup(setup, &root)?;
    }
    let v9_views: Vec<_> = file
        .views
        .iter()
        .map(super::v10::SavedViewV10::to_v9)
        .collect();
    let v9_stories: Vec<_> = file
        .stories
        .iter()
        .map(super::v10::StoryV10::to_v9)
        .collect();
    crate::views::validate_views_and_stories(&v9_views, &v9_stories)?;
    if let Some(camera) = &file.map_view {
        crate::views::validate_camera(&camera.to_v9(), &root.field("map_view"))?;
    }
    Ok(())
}

fn admit_v10_scene_objects(file: &CanopiFileV10, root: &FieldPath) -> Result<(), Refusal> {
    check_unique_ids("plants", file.plants.iter().map(|p| p.id.as_str()))?;
    for (i, plant) in file.plants.iter().enumerate() {
        let p = root.field("plants").index(i);
        check_point_v10(&plant.position, &p.field("position"))?;
        if plant
            .canopy_spread_m
            .is_some_and(|s| !(s.is_finite() && s > 0.0))
        {
            return Err(Refusal::new(
                p.field("canopy_spread_m"),
                "expected a finite number above 0",
            ));
        }
        if plant.rotation.is_some_and(|r| !r.is_finite()) {
            return Err(Refusal::new(p.field("rotation"), FINITE));
        }
    }

    check_unique_ids("zones", file.zones.iter().map(|z| z.id.as_str()))?;
    for (i, zone) in file.zones.iter().enumerate() {
        let z = root.field("zones").index(i);
        for (pi, pt) in zone.points.iter().enumerate() {
            check_point_v10(pt, &z.field("points").index(pi))?;
        }
        if !zone.rotation.is_finite() {
            return Err(Refusal::new(z.field("rotation"), FINITE));
        }
        if zone
            .opacity
            .is_some_and(|op| !(op.is_finite() && (0.0..=1.0).contains(&op)))
        {
            return Err(Refusal::new(z.field("opacity"), UNIT_INTERVAL));
        }
    }

    check_unique_ids(
        "annotations",
        file.annotations.iter().map(|a| a.id.as_str()),
    )?;
    for (i, ann) in file.annotations.iter().enumerate() {
        let a = root.field("annotations").index(i);
        check_point_v10(&ann.position, &a.field("position"))?;
        if !(ann.font_size.is_finite() && ann.font_size > 0.0) {
            return Err(Refusal::new(
                a.field("font_size"),
                "expected a finite number above 0",
            ));
        }
        if ann.rotation.is_some_and(|r| !r.is_finite()) {
            return Err(Refusal::new(a.field("rotation"), FINITE));
        }
    }

    check_unique_ids(
        "measurement_guides",
        file.measurement_guides.iter().map(|g| g.id.as_str()),
    )?;
    for (i, guide) in file.measurement_guides.iter().enumerate() {
        let g = root.field("measurement_guides").index(i);
        check_point_v10(&guide.start, &g.field("start"))?;
        check_point_v10(&guide.end, &g.field("end"))?;
    }

    for (i, layer) in file.layers.iter().enumerate() {
        if !(layer.opacity.is_finite() && (0.0..=1.0).contains(&layer.opacity)) {
            return Err(Refusal::new(
                root.field("layers").index(i).field("opacity"),
                UNIT_INTERVAL,
            ));
        }
    }
    Ok(())
}

fn admit_v10_groups(
    file: &CanopiFileV10,
    root: &FieldPath,
    mode: V10AdmissionMode,
) -> Result<(), Refusal> {
    check_unique_ids("groups", file.groups.iter().map(|g| g.id.as_str()))?;
    if mode != V10AdmissionMode::Write {
        return Ok(());
    }
    let ids = MemberIdSets::from_file(file);

    for (i, group) in file.groups.iter().enumerate() {
        let g = root.field("groups").index(i);
        if group.members.len() < 2 {
            return Err(Refusal::new(
                g.field("members"),
                "expected at least 2 group members on write",
            ));
        }
        let mut seen = HashSet::new();
        for (mi, member) in group.members.iter().enumerate() {
            let mpath = g.field("members").index(mi).field("id");
            if !ids.contains(member) {
                return Err(Refusal::new(mpath, "expected an existing object id"));
            }
            if !seen.insert(member.identity()) {
                return Err(Refusal::new(mpath, "expected unique group members"));
            }
        }
    }
    Ok(())
}

fn admit_v10_site_data(
    file: &CanopiFileV10,
    root: &FieldPath,
    mode: V10AdmissionMode,
) -> Result<(), Refusal> {
    let Some(site) = &file.site_data else {
        return Ok(());
    };
    let mut seen = HashSet::new();
    for (i, entry) in site.entries.iter().enumerate() {
        let e = root.field("site_data").field("entries").index(i);
        if entry.id.is_empty() {
            return Err(Refusal::new(e.field("id"), "expected a non-empty id"));
        }
        if mode == V10AdmissionMode::Write && !seen.insert(entry.id.as_str()) {
            return Err(Refusal::new(
                e.field("id"),
                "expected unique site_data entry ids on write",
            ));
        }
        if entry.name.trim().is_empty() {
            return Err(Refusal::new(e.field("name"), "expected a non-empty name"));
        }
        if !(entry.opacity.is_finite() && (0.0..=1.0).contains(&entry.opacity)) {
            return Err(Refusal::new(e.field("opacity"), UNIT_INTERVAL));
        }
        if let Some(LidarColourRangeV10::Custom { min, max, .. }) = &entry.range
            && !(min.is_finite() && max.is_finite() && min < max)
        {
            return Err(Refusal::new(
                e.field("range"),
                "expected finite min and max with min below max",
            ));
        }
    }
    Ok(())
}

fn admit_v10_budget(file: &CanopiFileV10, root: &FieldPath) -> Result<(), Refusal> {
    for (i, line) in file.budget.iter().enumerate() {
        let b = root.field("budget").index(i);
        if !line.unit_cost.is_finite() {
            return Err(Refusal::new(b.field("unit_cost"), FINITE));
        }
        if line.target.kind == "species"
            && line
                .target
                .canonical_name
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
        {
            return Err(Refusal::new(
                b.field("target").field("canonical_name"),
                "expected a non-empty canonical_name for species budget line",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::check_unique_ids;

    /// canopi-cyqd: a refusal names the field at fault and what it expected, never the
    /// file's value, so a hostile id never reaches a log or a Problem Report.
    #[test]
    fn canopi_cyqd_identity_refusals_name_the_leaf_and_never_the_value() {
        let hostile = "<script>/home/alice/Private garden</script>";
        let refusal = check_unique_ids("zones", ["bed", hostile, hostile].into_iter())
            .expect_err("a repeated id is refused");
        assert_eq!(refusal.to_string(), "$.zones[2].id: expected a unique id");
        assert!(!refusal.to_string().contains("alice"), "{refusal}");
    }
}
