//! Recent Design previews: counts, ground bounds and a symbolic sketch derived
//! from a Design's own plants and zones. Pure: no file or network access.

use canopi_types::design::{
    CanopiFile, DESIGN_SKETCH_GRID, DESIGN_SKETCH_MAX_PLANTS, DESIGN_SKETCH_MAX_ZONE_POINTS,
    DesignGroundBounds, DesignSketch, DesignSketchZone, GeoPoint, RecentDesignPreview, Zone,
};

/// Points an ellipse zone is drawn with in a sketch.
const SKETCH_ELLIPSE_POINTS: usize = 16;

/// The preview of a Design read from its file.
pub(crate) fn preview_of(file: &CanopiFile) -> RecentDesignPreview {
    let bounds = ground_bounds(file);
    RecentDesignPreview::Read {
        plant_count: saturating_u32(file.plants.len()),
        zone_count: saturating_u32(file.zones.len()),
        bounds,
        sketch: bounds.map(|bounds| sketch(file, bounds)),
    }
}

fn saturating_u32(count: usize) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// The box around every plant position and zone point, or `None` without any.
pub(crate) fn ground_bounds(file: &CanopiFile) -> Option<DesignGroundBounds> {
    let points = file.plants.iter().map(|plant| plant.position).chain(
        file.zones
            .iter()
            .flat_map(|zone| zone.points.iter().copied()),
    );
    points.fold(None, |bounds: Option<DesignGroundBounds>, point| {
        Some(match bounds {
            None => DesignGroundBounds {
                west: point.lon,
                south: point.lat,
                east: point.lon,
                north: point.lat,
            },
            Some(bounds) => DesignGroundBounds {
                west: bounds.west.min(point.lon),
                south: bounds.south.min(point.lat),
                east: bounds.east.max(point.lon),
                north: bounds.north.max(point.lat),
            },
        })
    })
}

/// A local metre-like plane over the bounds: x east and y south from the
/// north-west corner, with longitude shrunk by the cosine of the middle
/// latitude so a square garden stays square.
struct SketchPlane {
    west: f64,
    north: f64,
    lon_scale: f64,
    /// Plane units per sketch unit.
    unit: f64,
    width: u16,
    height: u16,
}

impl SketchPlane {
    fn over(bounds: DesignGroundBounds) -> Self {
        let lon_scale = ((bounds.south + bounds.north) / 2.0)
            .to_radians()
            .cos()
            .max(1e-6);
        let span_x = (bounds.east - bounds.west) * lon_scale;
        let span_y = bounds.north - bounds.south;
        let longest = span_x.max(span_y);
        let grid = f64::from(DESIGN_SKETCH_GRID);
        if longest <= 0.0 {
            // One point, or every object in one spot: a square frame with the
            // objects in its middle.
            return Self {
                west: bounds.west - 1.0,
                north: bounds.north + 1.0,
                lon_scale: 1.0,
                unit: 2.0 / grid,
                width: DESIGN_SKETCH_GRID,
                height: DESIGN_SKETCH_GRID,
            };
        }
        let unit = longest / grid;
        Self {
            west: bounds.west,
            north: bounds.north,
            lon_scale,
            unit,
            width: sketch_length(span_x / unit),
            height: sketch_length(span_y / unit),
        }
    }

    fn local(&self, point: GeoPoint) -> (f64, f64) {
        (
            (point.lon - self.west) * self.lon_scale,
            self.north - point.lat,
        )
    }

    fn project(&self, (x, y): (f64, f64)) -> [u16; 2] {
        [
            sketch_coordinate(x / self.unit, self.width),
            sketch_coordinate(y / self.unit, self.height),
        ]
    }
}

fn sketch_length(value: f64) -> u16 {
    // At least one unit, so a Design along one line keeps a visible frame.
    value.round().clamp(1.0, f64::from(DESIGN_SKETCH_GRID)) as u16
}

fn sketch_coordinate(value: f64, max: u16) -> u16 {
    if value.is_finite() {
        value.round().clamp(0.0, f64::from(max)) as u16
    } else {
        0
    }
}

/// Every `step`-th item, so a large collection is sampled evenly and the same
/// file always gives the same sketch.
fn step_for(count: usize, cap: usize) -> usize {
    count.div_ceil(cap).max(1)
}

fn sketch(file: &CanopiFile, bounds: DesignGroundBounds) -> DesignSketch {
    let plane = SketchPlane::over(bounds);
    let plant_step = step_for(file.plants.len(), DESIGN_SKETCH_MAX_PLANTS);
    let plants = file
        .plants
        .iter()
        .step_by(plant_step)
        .flat_map(|plant| plane.project(plane.local(plant.position)))
        .collect();

    let outlines: Vec<(bool, Vec<(f64, f64)>)> = file
        .zones
        .iter()
        .filter_map(|zone| zone_outline(zone, &plane))
        .collect();
    let total_points: usize = outlines.iter().map(|(_, points)| points.len()).sum();
    let point_step = step_for(total_points, DESIGN_SKETCH_MAX_ZONE_POINTS);
    let zones = outlines
        .into_iter()
        .filter_map(|(closed, points)| {
            let kept: Vec<u16> = points
                .into_iter()
                .step_by(point_step)
                .flat_map(|point| plane.project(point))
                .collect();
            (kept.len() >= 4).then_some(DesignSketchZone {
                closed,
                points: kept,
            })
        })
        .collect();

    DesignSketch {
        width: plane.width,
        height: plane.height,
        plants,
        zones,
    }
}

/// A zone's outline in the sketch plane: polygon and line zones by their
/// vertices; rectangles and ellipses from the opposite corners of their
/// unrotated box, turned clockwise by the zone's rotation about its centre.
fn zone_outline(zone: &Zone, plane: &SketchPlane) -> Option<(bool, Vec<(f64, f64)>)> {
    let points: Vec<(f64, f64)> = zone
        .points
        .iter()
        .map(|point| plane.local(*point))
        .collect();
    match zone.zone_type.as_str() {
        "rect" | "ellipse" => {
            let (min_x, min_y, max_x, max_y) = points.iter().fold(
                (
                    f64::INFINITY,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    f64::NEG_INFINITY,
                ),
                |(min_x, min_y, max_x, max_y), (x, y)| {
                    (min_x.min(*x), min_y.min(*y), max_x.max(*x), max_y.max(*y))
                },
            );
            if points.len() < 2 {
                return None;
            }
            let centre = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0);
            let (half_x, half_y) = ((max_x - min_x) / 2.0, (max_y - min_y) / 2.0);
            let unrotated: Vec<(f64, f64)> = if zone.zone_type == "rect" {
                vec![
                    (min_x, min_y),
                    (max_x, min_y),
                    (max_x, max_y),
                    (min_x, max_y),
                ]
            } else {
                (0..SKETCH_ELLIPSE_POINTS)
                    .map(|index| {
                        let angle =
                            std::f64::consts::TAU * index as f64 / SKETCH_ELLIPSE_POINTS as f64;
                        (
                            centre.0 + half_x * angle.cos(),
                            centre.1 + half_y * angle.sin(),
                        )
                    })
                    .collect()
            };
            let (sin, cos) = zone.rotation.to_radians().sin_cos();
            // y grows south here, so this standard rotation turns clockwise on screen.
            let rotated = unrotated
                .into_iter()
                .map(|(x, y)| {
                    let (dx, dy) = (x - centre.0, y - centre.1);
                    (
                        centre.0 + dx * cos - dy * sin,
                        centre.1 + dx * sin + dy * cos,
                    )
                })
                .collect();
            Some((true, rotated))
        }
        "line" => (points.len() >= 2).then_some((false, points)),
        _ => (points.len() >= 2).then_some((true, points)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopi_types::design::PlacedPlant;

    fn design() -> CanopiFile {
        crate::design::format::create_new_design("Orchard", "2026-09-27T00:00:00Z")
    }

    fn plant(id: usize, lon: f64, lat: f64) -> PlacedPlant {
        serde_json::from_value(serde_json::json!({
            "id": format!("plant-{id}"),
            "canonical_name": "Malus domestica",
            "position": { "lon": lon, "lat": lat },
        }))
        .unwrap()
    }

    fn zone(zone_type: &str, points: &[(f64, f64)], rotation: f64) -> Zone {
        serde_json::from_value(serde_json::json!({
            "id": format!("zone-{zone_type}"),
            "zone_type": zone_type,
            "points": points.iter().map(|(lon, lat)| serde_json::json!({ "lon": lon, "lat": lat })).collect::<Vec<_>>(),
            "rotation": rotation,
        }))
        .unwrap()
    }

    #[test]
    fn an_empty_design_has_counts_and_no_bounds_or_sketch() {
        assert_eq!(
            preview_of(&design()),
            RecentDesignPreview::Read {
                plant_count: 0,
                zone_count: 0,
                bounds: None,
                sketch: None,
            }
        );
    }

    #[test]
    fn counts_bounds_and_a_north_up_sketch_come_from_plants_and_zones() {
        let mut file = design();
        file.plants = vec![plant(0, 0.0, 0.0), plant(1, 0.002, 0.001)];
        file.zones = vec![zone(
            "polygon",
            &[(0.0, 0.0), (0.001, 0.0), (0.001, 0.001)],
            0.0,
        )];
        let RecentDesignPreview::Read {
            plant_count,
            zone_count,
            bounds,
            sketch,
        } = preview_of(&file)
        else {
            panic!("a readable Design has a preview");
        };
        assert_eq!((plant_count, zone_count), (2, 1));
        assert_eq!(
            bounds,
            Some(DesignGroundBounds {
                west: 0.0,
                south: 0.0,
                east: 0.002,
                north: 0.001,
            })
        );
        let sketch = sketch.unwrap();
        assert_eq!((sketch.width, sketch.height), (DESIGN_SKETCH_GRID, 500));
        // The south-west plant is bottom left; the north-east one top right.
        assert_eq!(sketch.plants, vec![0, 500, 1000, 0]);
        assert_eq!(sketch.zones.len(), 1);
        assert!(sketch.zones[0].closed);
        assert_eq!(sketch.zones[0].points, vec![0, 500, 500, 500, 500, 0]);
    }

    #[test]
    fn large_designs_are_sampled_evenly_and_deterministically() {
        let mut file = design();
        file.plants = (0..5000)
            .map(|index| plant(index, index as f64 * 1e-6, 0.0))
            .collect();
        let first = preview_of(&file);
        let RecentDesignPreview::Read {
            plant_count,
            sketch: Some(sketch),
            ..
        } = &first
        else {
            panic!("plants give a sketch");
        };
        assert_eq!(*plant_count, 5000);
        assert!(sketch.plants.len() / 2 <= DESIGN_SKETCH_MAX_PLANTS);
        assert_eq!(sketch.plants.len() / 2, 1667);
        assert_eq!(preview_of(&file), first);
    }

    #[test]
    fn rotated_rectangles_ellipses_and_lines_have_outlines() {
        let mut file = design();
        file.zones = vec![
            zone("rect", &[(0.0, 0.0), (0.001, 0.001)], 45.0),
            zone("ellipse", &[(0.002, 0.0), (0.003, 0.001)], 0.0),
            zone("line", &[(0.0, 0.002), (0.003, 0.002)], 0.0),
        ];
        let RecentDesignPreview::Read {
            sketch: Some(sketch),
            ..
        } = preview_of(&file)
        else {
            panic!("zones give a sketch");
        };
        let shapes: Vec<(bool, usize)> = sketch
            .zones
            .iter()
            .map(|zone| (zone.closed, zone.points.len() / 2))
            .collect();
        assert_eq!(
            shapes,
            vec![(true, 4), (true, SKETCH_ELLIPSE_POINTS), (false, 2)]
        );
        // A 45° turn brings the rectangle's north-west corner straight above
        // its centre (x = 0.0005° of a 0.003° wide frame).
        assert_eq!(sketch.zones[0].points[0], 167);
    }

    #[test]
    fn zone_points_are_capped_across_all_zones() {
        let mut file = design();
        let ring: Vec<(f64, f64)> = (0..3000)
            .map(|index| {
                let angle = std::f64::consts::TAU * index as f64 / 3000.0;
                (angle.cos() * 0.001, angle.sin() * 0.001)
            })
            .collect();
        file.zones = vec![zone("polygon", &ring, 0.0), zone("polygon", &ring, 0.0)];
        let RecentDesignPreview::Read {
            sketch: Some(sketch),
            ..
        } = preview_of(&file)
        else {
            panic!("zones give a sketch");
        };
        let points: usize = sketch.zones.iter().map(|zone| zone.points.len() / 2).sum();
        assert!(points <= DESIGN_SKETCH_MAX_ZONE_POINTS, "{points}");
        assert_eq!(sketch.zones.len(), 2);
    }

    #[test]
    fn a_design_in_one_spot_keeps_a_square_frame() {
        let mut file = design();
        file.plants = vec![plant(0, 2.35, 48.85)];
        let RecentDesignPreview::Read {
            sketch: Some(sketch),
            ..
        } = preview_of(&file)
        else {
            panic!("a plant gives a sketch");
        };
        assert_eq!(
            (sketch.width, sketch.height),
            (DESIGN_SKETCH_GRID, DESIGN_SKETCH_GRID)
        );
        assert_eq!(sketch.plants, vec![500, 500]);
    }
}
