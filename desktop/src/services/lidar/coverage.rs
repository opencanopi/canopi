//! Import › "Covers your site": where the chosen files lie, read before import.
//!
//! A preflight only: it reads each file's geographic extent through the raster
//! engine (never writing anything beside the user's file) and never copies,
//! hashes or records anything. The Design's extent is compared on the
//! frontend, where the Design lives.

use std::{path::PathBuf, sync::atomic::AtomicBool};

use canopi_types::lidar::LidarImportCoverage;

use super::engine::RasterEngine;

/// The extent of the chosen files: the box around every file whose extent
/// could be read, and how many could not.
pub(crate) fn import_coverage(
    engine: &dyn RasterEngine,
    paths: &[PathBuf],
) -> Result<LidarImportCoverage, String> {
    super::admission::check_source_count(paths.len())?;
    // An unavailable engine is named once rather than for every file.
    engine.version()?;
    let cancel = AtomicBool::new(false);
    Ok(union_of(
        paths.iter().map(|path| engine.wgs84_extent(path, &cancel)),
    ))
}

fn union_of(extents: impl Iterator<Item = Result<[f64; 4], String>>) -> LidarImportCoverage {
    let mut bounds: Option<[f64; 4]> = None;
    let mut unreadable_files = 0u32;
    for extent in extents {
        match extent {
            Ok([west, south, east, north]) => {
                bounds = Some(match bounds {
                    None => [west, south, east, north],
                    Some(current) => [
                        current[0].min(west),
                        current[1].min(south),
                        current[2].max(east),
                        current[3].max(north),
                    ],
                });
            }
            Err(_) => unreadable_files = unreadable_files.saturating_add(1),
        }
    }
    LidarImportCoverage {
        bounds,
        unreadable_files,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coverage_is_the_box_around_every_readable_file() {
        let coverage = union_of(
            [
                Ok([0.10, 47.00, 0.12, 47.01]),
                Err("not a raster".to_owned()),
                Ok([0.12, 46.99, 0.14, 47.00]),
            ]
            .into_iter(),
        );
        assert_eq!(coverage.bounds, Some([0.10, 46.99, 0.14, 47.01]));
        assert_eq!(coverage.unreadable_files, 1);
    }

    #[test]
    fn no_readable_file_has_no_coverage() {
        let coverage = union_of([Err("gone".to_owned())].into_iter());
        assert_eq!(coverage.bounds, None);
        assert_eq!(coverage.unreadable_files, 1);
    }

    #[test]
    fn too_many_files_are_refused_before_any_is_read() {
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let paths = vec![
            PathBuf::from("tile.tif");
            super::super::admission::MAX_SOURCE_FILES_PER_IMPORT + 1
        ];
        let error = import_coverage(&engine, &paths).unwrap_err();
        assert!(error.contains("at most"), "{error}");
    }

    #[test]
    fn a_written_raster_reports_its_wgs84_extent_without_a_sidecar() {
        let root = crate::test_scratch::TestScratch::new("coverage");
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let raster = root.join("tile.tif");
        let grid = super::super::grid::RasterGrid {
            width: 4,
            height: 4,
            geotransform: [11_000.0, 1.0, 0.0, 5_950_004.0, 0.0, -1.0],
        };
        let raw = root.join("tile.raw");
        super::super::import::write_f32_raw(&raw, &[1.0; 16]).unwrap();
        super::super::import::raw_to_tif(
            &engine,
            &AtomicBool::new(false),
            &raw,
            &raster,
            &grid,
            "EPSG:3857",
            -9999.0,
        )
        .unwrap();

        let coverage = import_coverage(&engine, std::slice::from_ref(&raster)).unwrap();
        let [west, south, east, north] = coverage.bounds.unwrap();
        assert!(west < east && south < north);
        assert!((0.09..0.11).contains(&west), "{west}");
        assert!(!root.join("tile.tif.aux.xml").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    /// A chosen file that is not a GeoTIFF has no extent: it is counted
    /// unreadable and the others still cover the site.
    #[test]
    fn a_file_that_is_not_a_geotiff_is_counted_unreadable() {
        let root = crate::test_scratch::TestScratch::new("coverage-not-tiff");
        let engine = crate::services::lidar::rust_engine::RustRasterEngine;
        let raster = root.join("tile.tif");
        let grid = super::super::grid::RasterGrid {
            width: 4,
            height: 4,
            geotransform: [11_000.0, 1.0, 0.0, 5_950_004.0, 0.0, -1.0],
        };
        let raw = root.join("tile.raw");
        super::super::import::write_f32_raw(&raw, &[1.0; 16]).unwrap();
        super::super::import::raw_to_tif(
            &engine,
            &AtomicBool::new(false),
            &raw,
            &raster,
            &grid,
            "EPSG:3857",
            -9999.0,
        )
        .unwrap();
        let ascii = root.join("dem.asc");
        std::fs::write(
            &ascii,
            "ncols 2\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 1\nNODATA_value -9999\n1 2\n3 4\n",
        )
        .unwrap();

        let coverage = import_coverage(&engine, &[raster, ascii]).unwrap();
        assert_eq!(coverage.unreadable_files, 1);
        assert!(coverage.bounds.is_some());
        let _ = std::fs::remove_dir_all(root);
    }
}
