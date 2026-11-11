//! The rules a `.canopi` Design's schema cannot state, checked after it is decoded:
//! positions, identities and ranges. Each refusal names its leaf field (canopi-cyqd,
//! 2.1-M430) and never a file value.

use super::field_path::{FieldPath, Refusal};
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
