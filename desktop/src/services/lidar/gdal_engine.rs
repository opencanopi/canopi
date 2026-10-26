//! The GDAL command-line oracle of the engine comparison lane (test only).
//!
//! Canopi ships no GDAL and never runs it in production (ADR 0014). This
//! adapter implements the raster engine seam on `gdalinfo`, `gdal_translate`,
//! `gdalwarp` and `gdaltransform` found on `PATH`, through the bounded child-process
//! runner in `process.rs`, so `rust_engine::comparison` can hold the Rust
//! engine to GDAL's answers on the same inputs, and runs `gdaldem` (when
//! found) as the relief oracle. Without GDAL the lane skips.

use super::engine::{
    DISPLAY_NODATA, ProbeError, RasterEngine, RasterGeoref, RasterInput, RasterProbe,
    RasterStatistics, bounds_of,
};
#[cfg(test)]
use super::grid::RasterGrid;
use super::process::{self, DEFAULT_PROCESS_TIMEOUT, RunOutput};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// `gdalinfo` reads headers only and finishes in seconds on any local file. A
/// file on an unreachable share must not hold one of the executor's running slots for
/// the full conversion deadline; Import coverage runs up to 24 of these.
const INFO_PROCESS_TIMEOUT: Duration = Duration::from_secs(60);
#[derive(Debug, Clone)]
pub struct GdalEngine {
    discovery: ArcDiscovery,
    /// Where child output is captured: inside the library root, never the
    /// shared system temp directory.
    log_dir: PathBuf,
}

#[derive(Clone)]
struct ArcDiscovery(Arc<Mutex<Option<Result<DiscoveredTools, String>>>>);

impl std::fmt::Debug for ArcDiscovery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("ArcDiscovery").finish()
    }
}

#[derive(Debug, Clone)]
pub struct DiscoveredTools {
    pub gdalinfo: PathBuf,
    pub gdal_translate: PathBuf,
    pub gdalwarp: PathBuf,
    pub gdaltransform: PathBuf,
    /// The relief oracle only; the engine seam never needs it.
    pub gdaldem: Option<PathBuf>,
    pub version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GdalProgram {
    Info,
    Translate,
    Warp,
    Transform,
    Dem,
}

impl GdalEngine {
    /// An engine that captures child output in `log_dir`, which must exist.
    pub fn in_dir(log_dir: PathBuf) -> Self {
        Self {
            discovery: ArcDiscovery(Arc::new(Mutex::new(None))),
            log_dir,
        }
    }

    /// Detect the tool set once per process; a detection failure is cached and
    /// names the missing tool.
    pub fn discover(&self) -> Result<DiscoveredTools, String> {
        let mut guard = self
            .discovery
            .0
            .lock()
            .map_err(|_| "LiDAR engine discovery lock poisoned".to_string())?;
        if let Some(cached) = guard.as_ref() {
            return cached.clone();
        }
        let discovered = self.discover_uncached();
        *guard = Some(discovered.clone());
        discovered
    }

    fn discover_uncached(&self) -> Result<DiscoveredTools, String> {
        let find = |name: &str| -> Result<PathBuf, String> {
            process::which_on_path(name)
                .ok_or_else(|| format!("GDAL tool {name} not found on PATH"))
        };

        let gdalinfo = find("gdalinfo")?;
        let mut tools = DiscoveredTools {
            gdalinfo: gdalinfo.clone(),
            gdal_translate: find("gdal_translate")?,
            gdalwarp: find("gdalwarp")?,
            gdaltransform: find("gdaltransform")?,
            gdaldem: find("gdaldem").ok(),
            version: String::new(),
        };
        let version_output = self.run_once(
            &gdalinfo,
            &["--version".to_string()],
            None,
            None,
            Some(DEFAULT_PROCESS_TIMEOUT),
        )?;
        tools.version = version_output.stdout.trim().to_string();
        if tools.version.is_empty() {
            return Err("GDAL engine reported an empty version".to_string());
        }
        Ok(tools)
    }

    fn tool(&self, program: GdalProgram) -> Result<PathBuf, String> {
        let tools = self.discover()?;
        Ok(match program {
            GdalProgram::Info => tools.gdalinfo,
            GdalProgram::Translate => tools.gdal_translate,
            GdalProgram::Warp => tools.gdalwarp,
            GdalProgram::Transform => tools.gdaltransform,
            GdalProgram::Dem => tools
                .gdaldem
                .ok_or_else(|| "GDAL tool gdaldem not found on PATH".to_string())?,
        })
    }

    /// Run one GDAL tool to completion. Fixed argv, no shell, bounded output,
    /// bounded duration, cancellable while running.
    pub fn run(
        &self,
        program: GdalProgram,
        args: &[String],
        cancel: Option<&AtomicBool>,
    ) -> Result<RunOutput, String> {
        let path = self.tool(program)?;
        self.run_once(&path, args, None, cancel, Some(process_timeout(&program)))
    }

    /// Run a GDAL tool with a small caller-owned stdin payload under the same
    /// timeout, cancellation and output limits as every other command.
    pub fn run_with_input(
        &self,
        program: GdalProgram,
        args: &[String],
        input: &[u8],
        cancel: Option<&AtomicBool>,
    ) -> Result<RunOutput, String> {
        let path = self.tool(program)?;
        self.run_once(
            &path,
            args,
            Some(input),
            cancel,
            Some(DEFAULT_PROCESS_TIMEOUT),
        )
    }

    fn run_once(
        &self,
        path: &Path,
        args: &[String],
        input: Option<&[u8]>,
        cancel: Option<&AtomicBool>,
        timeout: Option<Duration>,
    ) -> Result<RunOutput, String> {
        process::run_bounded(path, args, input, &[], cancel, timeout, &self.log_dir)
    }

    fn info_json(&self, raster: &Path, stats: bool, cancel: &AtomicBool) -> Result<String, String> {
        let mut args = vec!["-json".to_string()];
        if stats {
            args.push("-stats".to_string());
        }
        // No auxiliary metadata is written next to the read-only input.
        args.extend(
            ["--config", "GDAL_PAM_ENABLED", "NO"]
                .into_iter()
                .map(str::to_string),
        );
        args.push(raster.display().to_string());
        Ok(self.run(GdalProgram::Info, &args, Some(cancel))?.stdout)
    }

    /// Resolve an input to the file `gdal_translate` reads, staging samples
    /// as an ENVI pair beside `output` that the returned guard removes.
    fn stage_input(input: RasterInput<'_>, output: &Path) -> Result<StagedInput, String> {
        match input {
            RasterInput::File(path) => Ok(StagedInput {
                path: path.to_path_buf(),
                scratch: Vec::new(),
            }),
            RasterInput::Samples { grid, values } => {
                let expected = usize::try_from(
                    u64::from(grid.width)
                        .checked_mul(u64::from(grid.height))
                        .ok_or_else(|| "sample grid dimensions overflow".to_string())?,
                )
                .map_err(|_| "sample grid is too large for this platform".to_string())?;
                if values.len() != expected {
                    return Err(format!(
                        "{} samples do not fill a {}x{} grid",
                        values.len(),
                        grid.width,
                        grid.height
                    ));
                }
                let raw = output.with_extension("staged.raw");
                let hdr = raw.with_extension("hdr");
                write_f32_raw(&raw, values)?;
                let header = format!(
                    "ENVI\nsamples = {}\nlines = {}\nbands = 1\ndata type = 4\nbyte order = 0\nheader offset = 0\n",
                    grid.width, grid.height
                );
                if let Err(error) = std::fs::write(&hdr, header) {
                    let _ = std::fs::remove_file(&raw);
                    return Err(format!("Failed to write ENVI header: {error}"));
                }
                Ok(StagedInput {
                    path: raw.clone(),
                    scratch: vec![raw, hdr],
                })
            }
        }
    }
}

/// The file a conversion reads plus the scratch files staged for it.
struct StagedInput {
    path: PathBuf,
    scratch: Vec<PathBuf>,
}

impl Drop for StagedInput {
    fn drop(&mut self) {
        for path in &self.scratch {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn write_f32_raw(path: &Path, values: &[f32]) -> Result<(), String> {
    let file =
        std::fs::File::create(path).map_err(|e| format!("Failed to create raw buffer: {e}"))?;
    let mut output = std::io::BufWriter::new(file);
    for value in values {
        output
            .write_all(&value.to_le_bytes())
            .map_err(|e| format!("Failed to write raw buffer: {e}"))?;
    }
    output
        .flush()
        .map_err(|e| format!("Failed to flush raw buffer: {e}"))
}

/// The elapsed-time ceiling for one bounded tool run.
fn process_timeout(program: &GdalProgram) -> Duration {
    match program {
        GdalProgram::Info => INFO_PROCESS_TIMEOUT,
        GdalProgram::Translate | GdalProgram::Warp | GdalProgram::Transform | GdalProgram::Dem => {
            DEFAULT_PROCESS_TIMEOUT
        }
    }
}

/// Shortest round-trip decimal of a NoData marker, so a reader comparing the
/// tag to Float32 samples finds the very value that was written.
fn nodata_argument(nodata: f32) -> String {
    if nodata.is_finite() {
        format!("{:?}", f64::from(nodata))
    } else {
        format!("{nodata}")
    }
}

fn georef_arguments(georef: RasterGeoref<'_>) -> Vec<String> {
    let [min_x, min_y, max_x, max_y] = georef.grid.bounds();
    vec![
        "-a_srs".to_string(),
        georef.crs.to_string(),
        "-a_ullr".to_string(),
        format!("{min_x}"),
        format!("{max_y}"),
        format!("{max_x}"),
        format!("{min_y}"),
    ]
}

/// Fixed arguments of the controlled COG profile: band 1 as Float32, 256×256
/// blocks, uncompressed, no overviews, no mask, no auxiliary metadata beside
/// the input. Georeferencing and NoData are inserted before the paths.
pub(super) fn controlled_cog_arguments(
    input: &Path,
    output: &Path,
    georef: Option<RasterGeoref<'_>>,
    nodata: Option<f32>,
) -> Vec<String> {
    let mut args: Vec<String> = [
        "-q",
        "-of",
        "COG",
        "-ot",
        "Float32",
        "-b",
        "1",
        "-mask",
        "none",
        "--config",
        "GDAL_PAM_ENABLED",
        "NO",
        "-co",
        "BLOCKSIZE=256",
        "-co",
        "COMPRESS=NONE",
        "-co",
        "OVERVIEWS=NONE",
        "-co",
        "NUM_THREADS=1",
        "-co",
        "STATISTICS=NO",
        "-co",
        "SPARSE_OK=NO",
    ]
    .iter()
    .map(|argument| (*argument).to_string())
    .collect();
    if let Some(georef) = georef {
        args.extend(georef_arguments(georef));
    }
    if let Some(nodata) = nodata {
        args.push("-a_nodata".to_string());
        args.push(format!("{nodata}"));
    }
    args.push(input.display().to_string());
    args.push(output.display().to_string());
    args
}

/// The oracle's display warp (A6): `gdalwarp` onto the Rust engine's lattice
/// grid by nearest neighbour, with an exact transform (`-et 0`) and the
/// row's own `definition`, so both warps use the same Helmert shift and can
/// be compared pixel by pixel. The result is a plain GeoTIFF that
/// [`display_cog_arguments`] turns into the profile: written straight to a
/// COG, gdalwarp would warp each overview from the source instead of
/// averaging the level above it.
pub(super) fn display_warp_arguments(
    input: &Path,
    output: &Path,
    definition: &str,
    lattice: &RasterGrid,
    source_nodata: Option<f32>,
    nodata: f32,
) -> Vec<String> {
    let [min_x, min_y, max_x, max_y] = lattice.bounds();
    let mut args: Vec<String> = [
        "-q",
        "-overwrite",
        "-s_srs",
        definition,
        "-t_srs",
        "EPSG:3857",
        "-r",
        "near",
        "-et",
        "0",
        "-ot",
        "Float32",
        "-of",
        "GTiff",
        "--config",
        "GDAL_PAM_ENABLED",
        "NO",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    args.push("-te".to_string());
    args.extend([min_x, min_y, max_x, max_y].map(|value| format!("{value:?}")));
    args.push("-ts".to_string());
    args.push(lattice.width.to_string());
    args.push(lattice.height.to_string());
    if let Some(source_nodata) = source_nodata {
        args.push("-srcnodata".to_string());
        args.push(nodata_argument(source_nodata));
    }
    args.push("-dstnodata".to_string());
    args.push(nodata_argument(nodata));
    args.push(input.display().to_string());
    args.push(output.display().to_string());
    args
}

/// Fixed arguments of the display profile over a warped GeoTIFF: Float32,
/// 256-pixel Deflate blocks, averaged overviews, no statistics, no auxiliary
/// metadata.
pub(super) fn display_cog_arguments(input: &Path, output: &Path) -> Vec<String> {
    let mut args: Vec<String> = [
        "-q",
        "-of",
        "COG",
        "-ot",
        "Float32",
        "-b",
        "1",
        "--config",
        "GDAL_PAM_ENABLED",
        "NO",
        "-co",
        "BLOCKSIZE=256",
        "-co",
        "COMPRESS=DEFLATE",
        "-co",
        "OVERVIEWS=IGNORE_EXISTING",
        "-co",
        "RESAMPLING=AVERAGE",
        "-co",
        "NUM_THREADS=2",
        "-co",
        "STATISTICS=NO",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    args.push(input.display().to_string());
    args.push(output.display().to_string());
    args
}

impl RasterEngine for GdalEngine {
    fn version(&self) -> Result<String, String> {
        self.discover().map(|tools| tools.version)
    }

    fn probe(&self, raster: &Path, cancel: &AtomicBool) -> Result<RasterProbe, ProbeError> {
        parse_gdalinfo_json(&self.info_json(raster, false, cancel)?)
    }

    fn statistics(&self, raster: &Path, cancel: &AtomicBool) -> Result<RasterStatistics, String> {
        let info: serde_json::Value = serde_json::from_str(&self.info_json(raster, true, cancel)?)
            .map_err(|e| format!("gdalinfo returned invalid JSON: {e}"))?;
        let metadata = info
            .pointer("/bands/0/metadata/")
            .ok_or_else(|| "gdalinfo reported no statistics".to_string())?;
        let number = |key: &str| -> Result<f64, String> {
            metadata
                .get(key)
                .and_then(|value| value.as_str())
                .and_then(|value| value.parse::<f64>().ok())
                .ok_or_else(|| format!("gdalinfo statistics lack {key}"))
        };
        Ok(RasterStatistics {
            minimum: number("STATISTICS_MINIMUM")?,
            maximum: number("STATISTICS_MAXIMUM")?,
            mean: number("STATISTICS_MEAN")?,
            std_dev: number("STATISTICS_STDDEV")?,
            valid_percent: number("STATISTICS_VALID_PERCENT")?,
        })
    }

    fn wgs84_extent(&self, raster: &Path, cancel: &AtomicBool) -> Result<[f64; 4], String> {
        let info: serde_json::Value = serde_json::from_str(&self.info_json(raster, false, cancel)?)
            .map_err(|e| format!("Unreadable raster metadata: {e}"))?;
        let ring = info
            .pointer("/wgs84Extent/coordinates/0")
            .and_then(|ring| ring.as_array())
            .ok_or_else(|| "the raster has no geographic extent".to_string())?;
        let corners: Vec<Option<(f64, f64)>> = ring
            .iter()
            .map(|point| {
                Some((
                    point.get(0).and_then(|value| value.as_f64())?,
                    point.get(1).and_then(|value| value.as_f64())?,
                ))
            })
            .collect();
        bounds_of(&corners).ok_or_else(|| "the raster has no geographic extent".to_string())
    }

    fn read_f32(
        &self,
        raster: &Path,
        width: u32,
        height: u32,
        cancel: &AtomicBool,
    ) -> Result<Vec<f32>, String> {
        let cells = usize::try_from(u64::from(width) * u64::from(height))
            .map_err(|_| "raw raster byte count exceeds this platform".to_string())?;
        // Beside its input, which production keeps inside the job's own
        // scratch directory, so the startup sweep reclaims it after a crash.
        let scratch = raster.with_extension(format!("f32-{}.raw", std::process::id()));
        let cleanup = || {
            let _ = std::fs::remove_file(&scratch);
            let _ = std::fs::remove_file(scratch.with_extension("raw.aux.xml"));
            let _ = std::fs::remove_file(scratch.with_extension("hdr"));
        };
        let converted = self.run(
            GdalProgram::Translate,
            &[
                "-q".to_string(),
                "-ot".to_string(),
                "Float32".to_string(),
                "-of".to_string(),
                "ENVI".to_string(),
                raster.display().to_string(),
                scratch.display().to_string(),
            ],
            Some(cancel),
        );
        if let Err(error) = converted {
            cleanup();
            return Err(error);
        }
        let bytes = std::fs::read(&scratch).map_err(|e| format!("Failed to read raw raster: {e}"));
        cleanup();
        let bytes = bytes?;
        if bytes.len() != cells * 4 {
            return Err(format!(
                "raw raster buffer has {} bytes, expected {}",
                bytes.len(),
                cells * 4
            ));
        }
        Ok(bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect())
    }

    fn write_geotiff(
        &self,
        output: &Path,
        georef: RasterGeoref<'_>,
        nodata: f32,
        values: &[f32],
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        let staged = Self::stage_input(
            RasterInput::Samples {
                grid: georef.grid,
                values,
            },
            output,
        )?;
        let mut args: Vec<String> = ["-q", "-ot", "Float32"]
            .into_iter()
            .map(str::to_string)
            .collect();
        args.extend(georef_arguments(georef));
        args.push("-a_nodata".to_string());
        args.push(nodata_argument(nodata));
        args.extend(
            [
                "-co",
                "TILED=YES",
                "-co",
                "COMPRESS=DEFLATE",
                "-co",
                "PREDICTOR=3",
            ]
            .into_iter()
            .map(str::to_string),
        );
        args.push(staged.path.display().to_string());
        args.push(output.display().to_string());
        self.run(GdalProgram::Translate, &args, Some(cancel))
            .map(|_| ())
    }

    fn write_controlled_cog(
        &self,
        input: RasterInput<'_>,
        output: &Path,
        georef: Option<RasterGeoref<'_>>,
        nodata: Option<f32>,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        if georef.is_none() && matches!(input, RasterInput::Samples { .. }) {
            return Err("samples need a georeference to become a raster".to_string());
        }
        let staged = Self::stage_input(input, output)?;
        let args = controlled_cog_arguments(&staged.path, output, georef, nodata);
        self.run(GdalProgram::Translate, &args, Some(cancel))
            .map(|_| ())
    }

    fn write_display_cog(
        &self,
        input: RasterInput<'_>,
        output: &Path,
        georef: Option<RasterGeoref<'_>>,
        nodata: Option<f32>,
        zoom: u32,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        if georef.is_some() || matches!(input, RasterInput::Samples { .. }) {
            return Err("the display oracle warps files only".to_string());
        }
        let staged = Self::stage_input(input, output)?;
        // The input's placement as the Rust engine reads it: the oracle checks
        // the warp, not the key reading the authority's own tests cover.
        let probe = super::rust_engine::RustRasterEngine.probe(&staged.path, cancel)?;
        let grid = RasterGrid {
            width: probe.width,
            height: probe.height,
            geotransform: probe.geotransform,
        };
        let (lattice, definition) =
            super::rust_engine::display_lattice(&grid, &probe.crs_ref, zoom)?;
        let warped = output.with_extension("warped.tif");
        let args = display_warp_arguments(
            &staged.path,
            &warped,
            definition,
            &lattice,
            nodata,
            nodata.or(probe.nodata).unwrap_or(DISPLAY_NODATA),
        );
        let written = self
            .run(GdalProgram::Warp, &args, Some(cancel))
            .and_then(|_| {
                self.run(
                    GdalProgram::Translate,
                    &display_cog_arguments(&warped, output),
                    Some(cancel),
                )
            })
            .map(|_| ());
        let _ = std::fs::remove_file(&warped);
        written
    }

    fn transform_points(
        &self,
        source_crs: &str,
        target_crs: &str,
        points: &[(f64, f64)],
        cancel: &AtomicBool,
    ) -> Result<Vec<Option<(f64, f64)>>, String> {
        if points.is_empty() {
            return Ok(Vec::new());
        }
        let input = points
            .iter()
            .map(|(x, y)| format!("{x} {y}\n"))
            .collect::<String>();
        let output = self.run_with_input(
            GdalProgram::Transform,
            &[
                "-s_srs".to_string(),
                source_crs.to_string(),
                "-t_srs".to_string(),
                target_crs.to_string(),
            ],
            input.as_bytes(),
            Some(cancel),
        )?;
        let mut placed = Vec::with_capacity(points.len());
        for line in output.stdout.lines() {
            let mut parts = line.split_whitespace();
            let (Some(x), Some(y)) = (parts.next(), parts.next()) else {
                placed.push(None);
                continue;
            };
            let (Ok(x), Ok(y)) = (x.parse::<f64>(), y.parse::<f64>()) else {
                return Err(format!("gdaltransform produced an unreadable row: {line}"));
            };
            placed.push((x.is_finite() && y.is_finite()).then_some((x, y)));
        }
        if placed.len() != points.len() {
            return Err(format!(
                "gdaltransform placed {} of {} points",
                placed.len(),
                points.len()
            ));
        }
        Ok(placed)
    }
}

// ---------------------------------------------------------------------------
// gdalinfo JSON
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
#[expect(
    non_snake_case,
    reason = "fields named as gdalinfo -json spells its keys"
)]
struct ProbeJson {
    #[serde(rename = "driverShortName")]
    driver_short_name: Option<String>,
    size: Option<[u32; 2]>,
    bands: Option<Vec<ProbeBand>>,
    geoTransform: Option<Vec<f64>>,
    coordinateSystem: Option<ProbeCrs>,
    metadata: Option<ProbeMetadata>,
}

#[derive(Debug, serde::Deserialize)]
#[expect(
    non_snake_case,
    reason = "fields named as gdalinfo -json spells its keys"
)]
struct ProbeMetadata {
    IMAGE_STRUCTURE: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, serde::Deserialize)]
#[expect(
    non_snake_case,
    reason = "fields named as gdalinfo -json spells its keys"
)]
struct ProbeBand {
    #[serde(rename = "type")]
    band_type: Option<String>,
    noDataValue: Option<serde_json::Value>,
    scale: Option<f64>,
    offset: Option<f64>,
    unit: Option<String>,
    block: Option<[u32; 2]>,
    #[serde(default)]
    overviews: Vec<serde_json::Value>,
    mask: Option<ProbeMask>,
}

#[derive(Debug, serde::Deserialize)]
struct ProbeMask {
    #[serde(default)]
    flags: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct ProbeCrs {
    wkt: Option<String>,
}

/// Admission facts from `gdalinfo -json`, validated rather than trusted.
pub(super) fn parse_gdalinfo_json(json: &str) -> Result<RasterProbe, ProbeError> {
    let parsed: ProbeJson = serde_json::from_str(json)
        .map_err(|e| format!("gdalinfo JSON has unexpected shape: {e}"))?;

    let driver = parsed
        .driver_short_name
        .unwrap_or_else(|| "unknown".to_string());
    let [width, height] = parsed
        .size
        .ok_or_else(|| "gdalinfo JSON missing raster size".to_string())?;
    let bands = parsed.bands.unwrap_or_default();
    if bands.is_empty() {
        return Err(
            "raster has no bands; Canopi admits single-band numeric rasters"
                .to_string()
                .into(),
        );
    }
    let first = &bands[0];
    let band_type = first
        .band_type
        .clone()
        .unwrap_or_else(|| "Unknown".to_string());
    if !is_numeric_band_type(&band_type) {
        return Err(format!("band type {band_type} is not a supported numeric raster type").into());
    }
    let nodata = match &first.noDataValue {
        Some(serde_json::Value::Number(n)) => n.as_f64().map(|v| v as f32),
        _ => None,
    };
    let geotransform_raw = parsed
        .geoTransform
        .ok_or_else(ProbeError::not_georeferenced)?;
    let geotransform: [f64; 6] = geotransform_raw
        .try_into()
        .map_err(|_| "gdalinfo geotransform must have exactly 6 values".to_string())?;
    if geotransform[1] == 0.0 || geotransform[5] == 0.0 {
        return Err(ProbeError::degenerate_pixel_size());
    }
    let crs_ref = parsed
        .coordinateSystem
        .and_then(|crs| crs.wkt)
        .unwrap_or_default();

    Ok(RasterProbe {
        driver,
        width,
        height,
        band_count: bands.len() as u32,
        band_type,
        nodata,
        scale: first.scale.unwrap_or(1.0),
        offset: first.offset.unwrap_or(0.0),
        unit: first.unit.clone().filter(|unit| !unit.trim().is_empty()),
        mask_flags: first
            .mask
            .as_ref()
            .map(|mask| mask.flags.clone())
            .unwrap_or_default(),
        geotransform,
        crs_ref,
        block: first.block.unwrap_or([width, 1]),
        compression: parsed
            .metadata
            .and_then(|metadata| metadata.IMAGE_STRUCTURE)
            .and_then(|structure| structure.get("COMPRESSION").cloned())
            .unwrap_or_else(|| "NONE".to_string()),
        overview_count: first.overviews.len() as u32,
    })
}

fn is_numeric_band_type(band_type: &str) -> bool {
    matches!(
        band_type,
        "Byte"
            | "Int8"
            | "UInt16"
            | "Int16"
            | "UInt32"
            | "Int32"
            | "UInt64"
            | "Int64"
            | "Float16"
            | "Float32"
            | "Float64"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_reads_have_a_short_deadline_and_conversions_keep_the_long_one() {
        assert_eq!(process_timeout(&GdalProgram::Info), Duration::from_secs(60));
        assert_eq!(
            process_timeout(&GdalProgram::Translate),
            DEFAULT_PROCESS_TIMEOUT
        );
        assert!(INFO_PROCESS_TIMEOUT < DEFAULT_PROCESS_TIMEOUT);
    }

    #[test]
    fn nodata_arguments_round_trip_exactly() {
        assert_eq!(nodata_argument(-9999.0), "-9999.0");
        assert_eq!(nodata_argument(f32::MIN), "-3.4028234663852886e38");
        assert_eq!(nodata_argument(f32::NAN), "NaN");
    }

    #[test]
    fn controlled_profile_places_georeferencing_and_nodata_before_the_paths() {
        let grid = RasterGrid {
            width: 4,
            height: 2,
            geotransform: [10.0, 0.5, 0.0, 20.0, 0.0, -0.5],
        };
        let args = controlled_cog_arguments(
            Path::new("in.tif"),
            Path::new("out.tif"),
            Some(RasterGeoref {
                grid: &grid,
                crs: "EPSG:3857",
            }),
            Some(-9999.0),
        );
        let tail: Vec<&str> = args
            .iter()
            .rev()
            .take(11)
            .rev()
            .map(String::as_str)
            .collect();
        assert_eq!(
            tail,
            [
                "-a_srs",
                "EPSG:3857",
                "-a_ullr",
                "10",
                "20",
                "12",
                "19",
                "-a_nodata",
                "-9999",
                "in.tif",
                "out.tif"
            ]
        );
        assert!(args.contains(&"COMPRESS=NONE".to_string()));
        assert!(args.contains(&"OVERVIEWS=NONE".to_string()));
    }

    #[test]
    fn parses_numeric_gdalinfo_json() {
        let json = r#"{
            "driverShortName": "GTiff",
            "size": [2000, 2000],
            "geoTransform": [445999.75, 0.5, 0.0, 6807000.25, 0.0, -0.5],
            "coordinateSystem": {"wkt": "PROJCRS[\"EPSG:2154\"]"},
            "metadata": {"IMAGE_STRUCTURE": {"COMPRESSION": "DEFLATE", "INTERLEAVE": "BAND"}},
            "bands": [
                {
                    "type": "Float32",
                    "noDataValue": -9999.0,
                    "block": [256, 256],
                    "overviews": [{"size": [1000, 1000]}, {"size": [500, 500]}],
                    "mask": {"flags": ["DATASET"]},
                    "minimum": 12.5,
                    "maximum": 88.25
                }
            ]
        }"#;
        let probe = parse_gdalinfo_json(json).expect("probe should parse");
        assert_eq!(probe.driver, "GTiff");
        assert_eq!(probe.width, 2000);
        assert_eq!(probe.band_type, "Float32");
        assert_eq!(probe.nodata, Some(-9999.0));
        assert_eq!(probe.scale, 1.0);
        assert_eq!(probe.offset, 0.0);
        assert_eq!(probe.mask_flags, vec!["DATASET"]);
        assert_eq!(probe.geotransform[1], 0.5);
        assert_eq!(probe.band_count, 1);
        assert_eq!(probe.block, [256, 256]);
        assert_eq!(probe.compression, "DEFLATE");
        assert_eq!(probe.overview_count, 2);
    }

    #[test]
    fn rejects_rasters_without_bands() {
        let json = r#"{
            "driverShortName": "GTiff",
            "size": [4, 4],
            "geoTransform": [0, 1, 0, 4, 0, -1],
            "coordinateSystem": {"wkt": "x"},
            "bands": [{"type": "Byte", "noDataValue": null}]
        }"#;
        assert!(parse_gdalinfo_json(json).is_ok(), "Byte is numeric");
        let json = r#"{
            "driverShortName": "GTiff",
            "size": [4, 4],
            "geoTransform": [0, 1, 0, 4, 0, -1],
            "coordinateSystem": {"wkt": "x"},
            "bands": []
        }"#;
        let error = parse_gdalinfo_json(json).unwrap_err().to_string();
        assert!(error.contains("no bands"));
    }

    #[test]
    fn rejects_missing_georeference_and_leaves_a_missing_crs_empty() {
        let json = r#"{
            "driverShortName": "GTiff",
            "size": [4, 4],
            "bands": [{"type": "Float32"}]
        }"#;
        let error = parse_gdalinfo_json(json).unwrap_err();
        assert!(
            matches!(&error, ProbeError::NotGeoreferenced { detail } if detail.contains("not georeferenced")),
            "{error:?}"
        );
        let json = r#"{
            "driverShortName": "GTiff",
            "size": [4, 4],
            "geoTransform": [0, 0, 0, 4, 0, -1],
            "bands": [{"type": "Float32"}]
        }"#;
        let error = parse_gdalinfo_json(json).unwrap_err();
        assert!(
            matches!(&error, ProbeError::NotGeoreferenced { detail } if detail.contains("degenerate")),
            "{error:?}"
        );
        let json = r#"{
            "driverShortName": "GTiff",
            "size": [4, 4],
            "geoTransform": [0, 1, 0, 4, 0, -1],
            "bands": [{"type": "Float32"}]
        }"#;
        let probe = parse_gdalinfo_json(json).unwrap();
        assert_eq!(probe.crs_ref, "");
        assert_eq!(probe.block, [4, 1]);
        assert_eq!(probe.compression, "NONE");
        assert_eq!(probe.overview_count, 0);
    }

    #[test]
    fn captures_scale_offset_unit_and_mask_metadata() {
        let json = r#"{
            "driverShortName": "GTiff",
            "size": [4, 4],
            "geoTransform": [0, 1, 0, 4, 0, -1],
            "coordinateSystem": {"wkt": "x"},
            "bands": [{
                "type": "Int16",
                "scale": 0.01,
                "offset": 12.0,
                "unit": "metre",
                "mask": {"flags": ["PER_DATASET"]}
            }]
        }"#;
        let probe = parse_gdalinfo_json(json).unwrap();
        assert_eq!(probe.scale, 0.01);
        assert_eq!(probe.offset, 12.0);
        assert_eq!(probe.unit.as_deref(), Some("metre"));
        assert_eq!(probe.mask_flags, vec!["PER_DATASET"]);
    }

    #[test]
    fn rejects_complex_numeric_bands() {
        let json = r#"{
            "driverShortName": "GTiff",
            "size": [4, 4],
            "geoTransform": [0, 1, 0, 4, 0, -1],
            "coordinateSystem": {"wkt": "x"},
            "bands": [{"type": "CFloat32"}]
        }"#;
        assert!(
            parse_gdalinfo_json(json)
                .unwrap_err()
                .to_string()
                .contains("not a supported numeric")
        );
    }
}
