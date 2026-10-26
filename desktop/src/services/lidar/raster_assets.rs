//!
//! Standard COG assets: creation, digesting, admission and 0/1 quality reads.
//!
//! One controlled profile carries every persisted raster: single-band
//! Float32, 256×256 internal TIFF tiles, uncompressed, no overviews and no
//! internal mask. Retained source COGs, resolved generation chunks and
//! analysis quality chunks all use it, so one reader validates them all.
//! Assets are content-addressed and immutable; a reader never deletes one, and
//! a cancelled or failed job only removes files it staged itself.

use super::engine::{RasterEngine, RasterGeoref, RasterInput};
use super::grid::RasterGrid;
use super::paths::LidarPaths;
use super::prepared_raster::{self, PreparedRaster};
use sha2::{Digest, Sha256};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

/// Profile identity recorded in catalogue asset metadata.
pub(super) const COG_PROFILE: &str = "cog-f32-t256-raw-v1";
/// Bounded read size while digesting a file.
const HASH_CHUNK: usize = 64 * 1024;

/// One immutable standard COG on disk.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct CogAsset {
    pub sha256: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub grid: RasterGrid,
    pub nodata: Option<f32>,
}

/// Digest a file with bounded I/O, cancellable between chunks.
pub(super) fn hash_file(path: &Path, cancel: &AtomicBool) -> Result<(String, u64), String> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open raster asset {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = vec![0u8; HASH_CHUNK];
    loop {
        super::import::check_cancel(cancel)?;
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read raster asset {}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "raster asset size overflows".to_string())?;
        hasher.update(&buffer[..read]);
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

/// Create one controlled COG from bounded in-memory samples and admit it into
/// the content-addressed asset store.
///
/// Only the validated, digested COG remains; an identical digest already on
/// disk is reused.
#[expect(
    clippy::too_many_arguments,
    reason = "ratcheted before 2.1-M188; group the arguments when this function next changes"
)]
pub(super) fn write_cog_asset(
    engine: &dyn RasterEngine,
    cancel: &AtomicBool,
    paths: &LidarPaths,
    scratch: &Path,
    stem: &str,
    grid: &RasterGrid,
    crs_ref: &str,
    nodata: Option<f32>,
    values: &[f32],
) -> Result<CogAsset, String> {
    let expected = usize::try_from(
        u64::from(grid.width)
            .checked_mul(u64::from(grid.height))
            .ok_or_else(|| "asset dimensions overflow".to_string())?,
    )
    .map_err(|_| "asset is too large for this platform".to_string())?;
    if values.len() != expected {
        return Err(format!(
            "asset holds {} samples for a {}x{} grid",
            values.len(),
            grid.width,
            grid.height
        ));
    }
    let staged = scratch.join(format!("{stem}.tif"));
    let created = engine.write_controlled_cog(
        RasterInput::Samples { grid, values },
        &staged,
        Some(RasterGeoref { grid, crs: crs_ref }),
        nodata,
        cancel,
    );
    if let Err(error) = created {
        let _ = std::fs::remove_file(&staged);
        return Err(error);
    }
    admit_staged_cog(paths, &staged, grid, nodata, cancel)
}

/// Create one controlled source COG inside the job directory that owns it.
///
/// Nothing is admitted here: the file stays job-local until publication, so a
/// cancelled or failed job owns exactly the bytes it created and no global
/// asset appears for an import that was never accepted.
#[expect(
    clippy::too_many_arguments,
    reason = "ratcheted before 2.1-M188; group the arguments when this function next changes"
)]
pub(super) fn write_job_source_cog(
    engine: &dyn RasterEngine,
    cancel: &AtomicBool,
    job_dir: &Path,
    stem: &str,
    input: &Path,
    grid: &RasterGrid,
    crs_ref: &str,
    nodata: Option<f32>,
) -> Result<CogAsset, String> {
    let required = prepared_raster::required_free_bytes(grid.width, grid.height, 0)?;
    super::paths::require_free_space(job_dir, required, "the staged source COG")?;
    let staged = job_dir.join(format!("{stem}.tif"));
    let created = engine.write_controlled_cog(
        RasterInput::File(input),
        &staged,
        Some(RasterGeoref { grid, crs: crs_ref }),
        nodata,
        cancel,
    );
    if let Err(error) = created {
        let _ = std::fs::remove_file(&staged);
        return Err(error);
    }
    let validated = (|| -> Result<CogAsset, String> {
        let reader = PreparedRaster::open_committed(&staged, grid, nodata)?;
        drop(reader);
        let (sha256, bytes) = hash_file(&staged, cancel)?;
        Ok(CogAsset {
            sha256,
            path: staged.clone(),
            bytes,
            grid: grid.clone(),
            nodata,
        })
    })();
    if validated.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    validated
}

/// Flush a file just renamed into the asset store, and its directory, to
/// stable storage. A catalogue row is written durably right after; without
/// this a crash could leave that row pointing at a truncated asset, which the
/// sweep never removes because it is referenced.
pub(super) fn sync_published_asset(path: &Path) -> Result<(), String> {
    crate::design::sync_file(path)
        .and_then(|()| crate::design::sync_parent_directory(path))
        .map_err(|e| format!("Failed to sync a published raster asset: {e}"))
}

/// Validate, digest and admit one staged COG into the content-addressed store.
///
/// Validation happens before the asset can be referenced: opening the staged
/// file through the production reader rejects a wrong layout or truncation.
/// An identical digest already on disk is reused, and a staged file that is not
/// admitted is removed, so a failed conversion leaves nothing behind.
pub(super) fn admit_staged_cog(
    paths: &LidarPaths,
    staged: &Path,
    grid: &RasterGrid,
    nodata: Option<f32>,
    cancel: &AtomicBool,
) -> Result<CogAsset, String> {
    let admitted = (|| -> Result<CogAsset, String> {
        let reader = PreparedRaster::open_committed(staged, grid, nodata)?;
        drop(reader);
        let (sha256, bytes) = hash_file(staged, cancel)?;
        let target = paths.asset_cog(&sha256);
        if target.exists() {
            let _ = std::fs::remove_file(staged);
        } else {
            std::fs::create_dir_all(
                target
                    .parent()
                    .ok_or_else(|| "asset path has no directory".to_string())?,
            )
            .map_err(|e| format!("Failed to create asset directory: {e}"))?;
            std::fs::rename(staged, &target)
                .map_err(|e| format!("Failed to publish raster asset: {e}"))?;
            sync_published_asset(&target)?;
        }
        Ok(CogAsset {
            sha256,
            path: target,
            bytes,
            grid: grid.clone(),
            nodata,
        })
    })();
    if admitted.is_err() {
        let _ = std::fs::remove_file(staged);
    }
    admitted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::lidar::prepared_raster::RasterWindow;

    fn scratch_dir(label: &str) -> crate::test_scratch::TestScratch {
        crate::test_scratch::TestScratch::new(&format!("assets-{label}"))
    }

    fn library_paths(root: &Path) -> LidarPaths {
        LidarPaths::open(root).expect("library paths")
    }

    fn chunk_grid(x: u32, y: u32) -> RasterGrid {
        RasterGrid {
            width: 4,
            height: 3,
            geotransform: [
                f64::from(x) * 4.0,
                1.0,
                0.0,
                f64::from(y) * 3.0 + 3.0,
                0.0,
                -1.0,
            ],
        }
    }

    /// Authored resolved chunk samples: padding and holes are NaN, while zero,
    /// negative and a finite sentinel-like value stay valid.
    fn authored_values() -> Vec<f32> {
        vec![
            0.0,
            -12.5,
            -9999.0,
            f32::NAN,
            250.25,
            -0.0,
            1.5,
            2.5,
            3.5,
            4.5,
            5.5,
            f32::NAN,
        ]
    }

    #[test]
    fn hash_is_stable_and_counts_bytes() {
        let dir = scratch_dir("hash");
        let path = dir.join("bytes.bin");
        std::fs::write(&path, b"canopi-asset").unwrap();
        let (digest, bytes) = hash_file(&path, &AtomicBool::new(false)).unwrap();
        assert_eq!(bytes, 12);
        // Independently known SHA-256 of the same byte string.
        let mut hasher = Sha256::new();
        hasher.update(b"canopi-asset");
        assert_eq!(digest, format!("{:x}", hasher.finalize()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cog_asset_size_must_match_the_grid() {
        let engine = super::super::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let dir = scratch_dir("size");
        let paths = library_paths(&dir);
        let error = write_cog_asset(
            &engine,
            &cancel,
            &paths,
            &dir,
            "size",
            &chunk_grid(0, 0),
            "EPSG:3857",
            Some(f32::NAN),
            &[1.0, 2.0, 3.0],
        )
        .expect_err("a short sample buffer must be rejected");
        assert!(error.contains("3 samples for a 4x3 grid"), "{error}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn chunk_cog_round_trips_through_the_engine_and_the_native_reader() {
        let engine = super::super::rust_engine::RustRasterEngine;
        let cancel = AtomicBool::new(false);
        let dir = scratch_dir("roundtrip");
        let paths = library_paths(&dir);
        let grid = chunk_grid(3, 5);
        let values = authored_values();

        // Resolved chunk: NaN NoData, exact Float32 values preserved.
        let asset = write_cog_asset(
            &engine,
            &cancel,
            &paths,
            &dir,
            "resolved",
            &grid,
            "EPSG:3857",
            Some(f32::NAN),
            &values,
        )
        .expect("resolved chunk is created");
        assert_eq!(asset.bytes, std::fs::metadata(&asset.path).unwrap().len());
        assert!(asset.path.exists());
        assert!(
            !dir.join("resolved.raw").exists() && !dir.join("resolved.hdr").exists(),
            "the ENVI scratch pair is removed"
        );

        let window = RasterWindow {
            x: 0,
            y: 0,
            width: grid.width,
            height: grid.height,
        };
        {
            // Reopened without any preparation: the committed file is the asset.
            let mut reader =
                PreparedRaster::open_committed(&asset.path, &grid, Some(f32::NAN)).unwrap();
            let read = reader.read_window(window, &cancel).unwrap();
            for (index, expected) in values.iter().enumerate() {
                let got = read.samples()[index];
                if expected.is_nan() {
                    assert!(got.is_nan(), "sample {index} stays NaN");
                    assert_eq!(read.valid()[index], 0, "NaN is invalid");
                } else {
                    assert_eq!(got.to_bits(), expected.to_bits(), "sample {index} bits");
                    assert_eq!(read.valid()[index], 1, "finite sample {index} is valid");
                }
            }
        }
        // Disposal closed the handle and kept the committed bytes.
        assert!(
            asset.path.exists(),
            "committed asset survives reader disposal"
        );
        assert_eq!(
            hash_file(&asset.path, &AtomicBool::new(false)).unwrap(),
            (asset.sha256.clone(), asset.bytes)
        );

        // The engine reopens it as a correctly georeferenced standard raster.
        let probe = engine
            .probe(&asset.path, &cancel)
            .expect("the engine reopens the chunk");
        assert_eq!((probe.width, probe.height), (4, 3));
        assert_eq!(probe.band_type, "Float32");
        assert_eq!(probe.block, [256, 256]);
        assert_eq!(probe.geotransform[0], grid.geotransform[0]);
        assert_eq!(probe.geotransform[3], grid.geotransform[3]);
        assert!(probe.crs_ref.contains("3857"), "{}", probe.crs_ref);

        // Quality asset: exact 0/1 samples with no NoData tag.
        let quality_values: Vec<f32> =
            vec![1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0];
        let quality = write_cog_asset(
            &engine,
            &cancel,
            &paths,
            &dir,
            "quality",
            &grid,
            "EPSG:3857",
            None,
            &quality_values,
        )
        .expect("quality chunk is created");
        let read_back = PreparedRaster::open_committed(&quality.path, &quality.grid, None)
            .expect("quality asset opens")
            .read_window(window, &cancel)
            .expect("quality reads");
        assert_eq!(read_back.samples(), quality_values.as_slice());

        // A truncated asset is rejected rather than decoded partially.
        let truncated = dir.join("truncated.tif");
        let mut bytes = std::fs::read(&asset.path).unwrap();
        bytes.truncate(bytes.len() / 2);
        std::fs::write(&truncated, &bytes).unwrap();
        assert!(PreparedRaster::open_committed(&truncated, &grid, Some(f32::NAN)).is_err());

        // Re-creating identical content reuses the same asset file.
        let again = write_cog_asset(
            &engine,
            &cancel,
            &paths,
            &dir,
            "resolved-again",
            &grid,
            "EPSG:3857",
            Some(f32::NAN),
            &values,
        )
        .expect("re-created chunk");
        assert_eq!(again.sha256, asset.sha256);
        assert_eq!(again.path, asset.path);
        let _ = std::fs::remove_dir_all(dir);
    }
}
