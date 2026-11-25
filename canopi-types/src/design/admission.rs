//! The rules a `.canopi` Design's schema cannot state, checked after it is decoded:
//! positions, identities and ranges. Each refusal names its leaf field (canopi-cyqd,
//! 2.1-M430) and never a file value.

use std::collections::{HashMap, HashSet};

use super::field_path::{FieldPath, Refusal};
use super::v10::{CanopiFileV10, ObjectGroupMemberV10, PrintAreaV10, PrintScaleV10};
use super::{CanopiFile, GeoPoint, WEB_MERCATOR_MAX_LATITUDE_DEG};

/// Check every persisted position of an admitted Design. Serde accepts any
/// finite `f64`; the WGS84 and Web Mercator ranges are enforced here so native
/// admission matches the generated Web schema.
pub fn validate_design_geometry(file: &CanopiFile) -> Result<(), Refusal> {
    let root = FieldPath::root();
    for (index, plant) in file.plants.iter().enumerate() {
        check_point(
            &plant.position,
            &root.field("plants").index(index).field("position"),
        )?;
    }
    for (index, zone) in file.zones.iter().enumerate() {
        let zone_path = root.field("zones").index(index);
        for (point_index, point) in zone.points.iter().enumerate() {
            check_point(point, &zone_path.field("points").index(point_index))?;
        }
        if !zone.rotation.is_finite() {
            return Err(Refusal::new(zone_path.field("rotation"), FINITE));
        }
    }
    for (index, annotation) in file.annotations.iter().enumerate() {
        let path = root.field("annotations").index(index).field("position");
        check_point(&annotation.position, &path)?;
    }
    for (index, guide) in file.measurement_guides.iter().enumerate() {
        let path = root.field("measurement_guides").index(index);
        check_point(&guide.start, &path.field("start"))?;
        check_point(&guide.end, &path.field("end"))?;
    }
    Ok(())
}

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

/// Identities and ranges of an admitted Design, checked after version
/// admission. Plants, zones, annotations, measurement guides and groups need
/// unique, non-empty ids because targets, groups and saved views refer to
/// them; Canopi never invents a missing one. Opacities, scales and font sizes must be
/// finite and in range, and the LiDAR section must be the schema this build
/// writes, with named entries and any custom colour range a finite rising pair.
pub fn admit_design_identities_and_ranges(file: &CanopiFile) -> Result<(), Refusal> {
    let root = FieldPath::root();
    check_unique_ids("plants", file.plants.iter().map(|plant| plant.id.as_str()))?;
    for (index, plant) in file.plants.iter().enumerate() {
        let path = root.field("plants").index(index);
        if plant
            .scale
            .is_some_and(|scale| !(scale.is_finite() && scale > 0.0))
        {
            return Err(Refusal::new(
                path.field("scale"),
                "expected a finite number above 0",
            ));
        }
        if plant.rotation.is_some_and(|rotation| !rotation.is_finite()) {
            return Err(Refusal::new(path.field("rotation"), FINITE));
        }
    }
    let guides = file
        .measurement_guides
        .iter()
        .map(|guide| guide.id.as_str());
    check_unique_ids("measurement_guides", guides)?;
    check_unique_ids("zones", file.zones.iter().map(|zone| zone.id.as_str()))?;
    let annotations = file
        .annotations
        .iter()
        .map(|annotation| annotation.id.as_str());
    check_unique_ids("annotations", annotations)?;
    check_unique_ids("groups", file.groups.iter().map(|group| group.id.as_str()))?;
    for (index, annotation) in file.annotations.iter().enumerate() {
        let path = root.field("annotations").index(index);
        if !(annotation.font_size.is_finite() && annotation.font_size > 0.0) {
            return Err(Refusal::new(
                path.field("font_size"),
                "expected a finite number above 0",
            ));
        }
        if annotation
            .rotation
            .is_some_and(|rotation| !rotation.is_finite())
        {
            return Err(Refusal::new(path.field("rotation"), FINITE));
        }
    }
    for (index, layer) in file.layers.iter().enumerate() {
        if !(layer.opacity.is_finite() && (0.0..=1.0).contains(&layer.opacity)) {
            let path = root.field("layers").index(index).field("opacity");
            return Err(Refusal::new(path, UNIT_INTERVAL));
        }
    }
    let Some(lidar) = &file.lidar else {
        return Ok(());
    };
    for (index, entry) in lidar.entries.iter().enumerate() {
        let path = root.field("lidar").field("entries").index(index);
        if !(entry.opacity.is_finite() && (0.0..=1.0).contains(&entry.opacity)) {
            return Err(Refusal::new(path.field("opacity"), UNIT_INTERVAL));
        }
        if entry.name.trim().is_empty() {
            return Err(Refusal::new(
                path.field("name"),
                "expected a non-empty name",
            ));
        }
        if let Some(crate::lidar::LidarColourRange::Custom { min, max }) = entry.range
            && !(min.is_finite() && max.is_finite() && min < max)
        {
            return Err(Refusal::new(
                path.field("range"),
                "expected finite min and max with min below max",
            ));
        }
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
            ObjectGroupMemberV10::Plant { id } => self.plants.contains(id.as_str()),
            ObjectGroupMemberV10::Zone { id } => self.zones.contains(id.as_str()),
            ObjectGroupMemberV10::Annotation { id } => self.annotations.contains(id.as_str()),
            ObjectGroupMemberV10::MeasurementGuide { id } => self.guides.contains(id.as_str()),
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
            group
                .members
                .retain(|member| ids.contains(member) && seen.insert(member.clone()));
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

/// The single typed admission rule set for v10 `.canopi` Designs (`ADR 0026`, `canopi-gjs3`),
/// sharing [`check_point`] and [`check_unique_ids`] with v9 admission.
pub fn admit_design_v10(file: &CanopiFileV10, mode: V10AdmissionMode) -> Result<(), Refusal> {
    let root = FieldPath::root();
    admit_v10_scene_objects(file, &root)?;
    admit_v10_groups(file, &root, mode)?;
    admit_v10_site_data(file, &root, mode)?;
    admit_v10_budget(file, &root)?;
    admit_v10_print_setup(file, &root)?;
    Ok(())
}

fn admit_v10_scene_objects(file: &CanopiFileV10, root: &FieldPath) -> Result<(), Refusal> {
    check_unique_ids("plants", file.plants.iter().map(|p| p.id.as_str()))?;
    for (i, plant) in file.plants.iter().enumerate() {
        let p = root.field("plants").index(i);
        check_point(&plant.position, &p.field("position"))?;
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
            check_point(pt, &z.field("points").index(pi))?;
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
        check_point(&ann.position, &a.field("position"))?;
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
        check_point(&guide.start, &g.field("start"))?;
        check_point(&guide.end, &g.field("end"))?;
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
            if !seen.insert(member) {
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
        if let Some(crate::lidar::LidarColourRange::Custom { min, max }) = entry.range
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

fn admit_v10_print_setup(file: &CanopiFileV10, root: &FieldPath) -> Result<(), Refusal> {
    let Some(setup) = &file.print_setup else {
        return Ok(());
    };
    let ps = root.field("print_setup");
    let mut split_ids = HashSet::new();
    for (i, split) in setup.splits.iter().enumerate() {
        let sp = ps.field("splits").index(i);
        if split.id.is_empty() {
            return Err(Refusal::new(sp.field("id"), "expected a non-empty id"));
        }
        if !split_ids.insert(split.id.as_str()) {
            return Err(Refusal::new(sp.field("id"), "expected a unique id"));
        }
        check_point(&split.pivot, &sp.field("pivot"))?;
        if !split.angle_deg.is_finite() {
            return Err(Refusal::new(sp.field("angle_deg"), FINITE));
        }
    }
    let mut page_ids = HashSet::new();
    for (i, page) in setup.pages.iter().enumerate() {
        let pp = ps.field("pages").index(i);
        admit_v10_print_page(page, &pp, &split_ids, &mut page_ids)?;
    }
    Ok(())
}

fn admit_v10_print_page<'a>(
    page: &'a super::v10::PrintPageV10,
    pp: &FieldPath,
    split_ids: &HashSet<&str>,
    page_ids: &mut HashSet<&'a str>,
) -> Result<(), Refusal> {
    if page.id.is_empty() {
        return Err(Refusal::new(pp.field("id"), "expected a non-empty id"));
    }
    if !page_ids.insert(page.id.as_str()) {
        return Err(Refusal::new(pp.field("id"), "expected a unique id"));
    }
    match &page.area {
        PrintAreaV10::Box {
            centre,
            size,
            angle_deg,
        } => {
            check_point(centre, &pp.field("area").field("centre"))?;
            if !(size.width_m.is_finite() && size.width_m > 0.0) {
                return Err(Refusal::new(
                    pp.field("area").field("size").field("width_m"),
                    "expected a finite number above 0",
                ));
            }
            if !(size.height_m.is_finite() && size.height_m > 0.0) {
                return Err(Refusal::new(
                    pp.field("area").field("size").field("height_m"),
                    "expected a finite number above 0",
                ));
            }
            if !angle_deg.is_finite() {
                return Err(Refusal::new(pp.field("area").field("angle_deg"), FINITE));
            }
        }
        PrintAreaV10::WholeDesign {
            angle_deg,
            fallback,
        } => {
            if !angle_deg.is_finite() {
                return Err(Refusal::new(pp.field("area").field("angle_deg"), FINITE));
            }
            if let Some(fb) = fallback {
                check_point(
                    &fb.centre,
                    &pp.field("area").field("fallback").field("centre"),
                )?;
            }
        }
        PrintAreaV10::SplitSheet {
            split,
            along_page,
            size,
        } => {
            if !split_ids.contains(split.as_str()) {
                return Err(Refusal::new(
                    pp.field("area").field("split"),
                    "expected an existing print_setup split id",
                ));
            }
            if !(along_page.right_m.is_finite() && along_page.down_m.is_finite()) {
                return Err(Refusal::new(pp.field("area").field("along_page"), FINITE));
            }
            if !(size.width_m.is_finite()
                && size.width_m > 0.0
                && size.height_m.is_finite()
                && size.height_m > 0.0)
            {
                return Err(Refusal::new(
                    pp.field("area").field("size"),
                    "expected positive finite dimensions",
                ));
            }
        }
    }
    match page.scale {
        PrintScaleV10::Fit => {}
        PrintScaleV10::Ratio { denominator: 0 } => {
            return Err(Refusal::new(
                pp.field("scale").field("denominator"),
                "expected a positive denominator",
            ));
        }
        PrintScaleV10::Ratio { .. } => {}
        PrintScaleV10::Customary { inches, feet }
            if !(inches.is_finite() && inches > 0.0 && feet.is_finite() && feet > 0.0) =>
        {
            return Err(Refusal::new(
                pp.field("scale"),
                "expected positive finite customary scale values",
            ));
        }
        PrintScaleV10::Customary { .. } => {}
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
