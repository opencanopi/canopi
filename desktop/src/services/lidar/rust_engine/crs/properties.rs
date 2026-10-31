//! Property tests for the CRS authority (2.1-M234), on the crate's one fixed-seed config: every table row round-trips
//! a point of its area of use, and the keys written for a row read back to it.

use super::super::super::grid::property_config;
use super::*;
use proptest::prelude::*;

/// Longitude and latitude back from a row within 3e-8 deg (3 mm), the reference grid's bound: a 2-D transform
/// drops the ellipsoidal height a datum shift moves. The worst of a 61x61 sweep of every row's area, edges
/// included, is 2.33e-8 deg (Greek Grid, 28.3E 41.75N).
const ROUND_TRIP_DEG: f64 = 3e-8;

/// One point per row, as fractions of the row's area of use, edges included.
fn one_point_per_row() -> impl Strategy<Value = Vec<(f64, f64)>> {
    prop::collection::vec((0.0..=1.0f64, 0.0..=1.0f64), crs_table::ROWS.len())
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn a_point_in_a_rows_area_goes_there_and_back(fractions in one_point_per_row()) {
        let wgs84 = from_code(4326).unwrap();
        for (row, (u, v)) in crs_table::ROWS.iter().zip(fractions) {
            let crs = from_code(row.code).unwrap();
            let [west, south, east, north] = row.area;
            let (lon, lat) = (west + (east - west) * u, south + (north - south) * v);
            let (x, y) = Transformer::new(&wgs84, &crs).apply(lon, lat).unwrap();
            let (back_lon, back_lat) = Transformer::new(&crs, &wgs84).apply(x, y).unwrap();
            prop_assert!(
                (back_lon - lon).abs() <= ROUND_TRIP_DEG && (back_lat - lat).abs() <= ROUND_TRIP_DEG,
                "EPSG:{} at {} {}: back at {} {}", row.code, lon, lat, back_lon, back_lat
            );
        }
    }

    #[test]
    fn written_keys_read_back_to_the_same_row(index in 0..crs_table::ROWS.len()) {
        let resolved = from_code(crs_table::ROWS[index].code).unwrap();
        prop_assert_eq!(from_geokeys(&geokeys_for(&resolved)).unwrap(), Some(resolved));
    }
}
