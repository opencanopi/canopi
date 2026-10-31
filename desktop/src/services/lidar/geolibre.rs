//! The pinned GeoLibre CLI sidecar every registered analysis runs on.
//!
//! Executors run tools of the `geolibre` CLI built from `geolibre-rust` at
//! [`GEOLIBRE_REVISION`] as job-owned child processes: fixed argv, no shell,
//! bounded output, the finite process deadline, and kill/reap on cancel, all
//! through the bounded child-process runner in `process.rs`. Discovery is cached,
//! so a missing binary makes new analysis runs unavailable with a named reason
//! and never falls back to another method.

use super::process;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

/// The `geolibre-rust` commit the shipped CLI is built from.
pub const GEOLIBRE_REVISION: &str = "aac2b743978666f3c3119b5c93de1b30963b1493";
// upstream: W13
/// Worker threads one windowed tool run may use.
const RAYON_THREADS: &str = "2";
#[cfg(windows)]
const EXECUTABLE: &str = "geolibre.exe";
#[cfg(not(windows))]
const EXECUTABLE: &str = "geolibre";

#[derive(Debug, Clone)]
pub struct GeolibreTool {
    pub path: PathBuf,
    /// The runner's own version line, e.g. `geolibre-cli 1.5.3`.
    pub version: String,
}

impl GeolibreTool {
    /// What a published run records as the engine that actually ran.
    pub fn provenance(&self, tools: Vec<String>) -> common_types::library::ToolProvenance {
        common_types::library::ToolProvenance {
            engine: "geolibre".to_string(),
            version: self.version.clone(),
            revision: GEOLIBRE_REVISION.to_string(),
            tools,
        }
    }
}

#[derive(Debug, Clone)]
pub struct GeolibreEngine {
    /// A fixed binary instead of discovery; tests use it to name a missing one.
    fixed: Option<PathBuf>,
    discovery: Arc<Mutex<Option<Result<GeolibreTool, String>>>>,
    /// Where child output is captured, inside the library root.
    log_dir: PathBuf,
}

impl GeolibreEngine {
    /// A runner that captures child output in `log_dir`, which must exist.
    pub fn in_dir(log_dir: PathBuf) -> Self {
        Self {
            fixed: None,
            discovery: Arc::new(Mutex::new(None)),
            log_dir,
        }
    }

    #[cfg(test)]
    pub fn at(path: PathBuf, log_dir: PathBuf) -> Self {
        Self {
            fixed: Some(path),
            ..Self::in_dir(log_dir)
        }
    }

    /// Test support: fix what discovery reports.
    #[cfg(test)]
    pub fn preset(&self, discovered: Result<GeolibreTool, String>) {
        *self.discovery.lock().unwrap() = Some(discovered);
    }

    /// Find the runner once per process: `CANOPI_GEOLIBRE_BIN`, then beside
    /// the application executable (where packaging puts it), then `PATH`.
    pub fn discover(&self) -> Result<GeolibreTool, String> {
        let mut guard = self
            .discovery
            .lock()
            .map_err(|_| "GeoLibre discovery lock poisoned".to_string())?;
        if let Some(cached) = guard.as_ref() {
            return cached.clone();
        }
        let discovered = self.discover_uncached();
        *guard = Some(discovered.clone());
        discovered
    }

    fn discover_uncached(&self) -> Result<GeolibreTool, String> {
        let path = match &self.fixed {
            Some(path) => path.clone(),
            None => locate()?,
        };
        if !path.is_file() {
            return Err(format!(
                "the GeoLibre engine is not installed ({} is missing)",
                path.display()
            ));
        }
        let output =
            process::run_managed(&path, &["version".to_string()], &[], None, &self.log_dir)?;
        let version = output.stdout.trim().to_string();
        if version.is_empty() {
            return Err("the GeoLibre engine reported no version".to_string());
        }
        Ok(GeolibreTool { path, version })
    }

    /// Run one tool of the pinned CLI: `<tool> --input=<input> --output=<output>
    /// <args>`.
    ///
    /// The tool reads `input` (Float32, a round-trip-safe NoData tag) and writes
    /// `output`. Only a completed child with an output file counts as success;
    /// the caller owns both paths and their cleanup.
    pub fn run(
        &self,
        tool: &str,
        input: &Path,
        output: &Path,
        args: &[String],
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        let runner = self.discover()?;
        let mut argv = vec![
            tool.to_string(),
            format!("--input={}", input.display()),
            format!("--output={}", output.display()),
        ];
        argv.extend_from_slice(args);
        process::run_managed(
            &runner.path,
            &argv,
            &[("RAYON_NUM_THREADS", RAYON_THREADS)],
            Some(cancel),
            &self.log_dir,
        )?;
        if !output.is_file() {
            return Err(format!("the GeoLibre tool {tool} produced no output"));
        }
        Ok(())
    }
}

/// Where the sidecar is looked for, in order: `CANOPI_GEOLIBRE_BIN`, beside
/// the application executable (Tauri's `externalBin` puts it there on every
/// platform), then `PATH`.
pub(super) struct SidecarSearch {
    pub explicit: Option<std::ffi::OsString>,
    pub executable: Option<PathBuf>,
    pub path_var: Option<std::ffi::OsString>,
}

impl SidecarSearch {
    fn from_process() -> Self {
        Self {
            explicit: std::env::var_os("CANOPI_GEOLIBRE_BIN"),
            executable: std::env::current_exe().ok(),
            path_var: std::env::var_os("PATH"),
        }
    }

    /// The sidecar's path beside the application executable: `geolibre` or
    /// `geolibre.exe` in the executable's directory, whether or not it exists.
    pub(super) fn beside_executable(&self) -> Option<PathBuf> {
        self.executable
            .as_deref()
            .and_then(Path::parent)
            .map(|dir| dir.join(EXECUTABLE))
    }

    pub(super) fn locate(&self) -> Result<PathBuf, String> {
        if let Some(explicit) = &self.explicit {
            return Ok(PathBuf::from(explicit));
        }
        if let Some(beside) = self
            .beside_executable()
            .filter(|candidate| candidate.is_file())
        {
            return Ok(beside);
        }
        self.path_var
            .as_deref()
            .and_then(|path_var| process::which_in(path_var, EXECUTABLE))
            .ok_or_else(|| {
                "the GeoLibre engine is not installed; new analysis runs are unavailable"
                    .to_string()
            })
    }
}

fn locate() -> Result<PathBuf, String> {
    SidecarSearch::from_process().locate()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> crate::test_scratch::TestScratch {
        crate::test_scratch::TestScratch::new(&format!("geolibre-{name}"))
    }

    /// The sidecar Tauri packages is `geolibre[.exe]` in the executable's own
    /// directory on every platform.
    #[test]
    fn the_beside_executable_candidate_is_the_sidecar_name_in_the_exe_dir() {
        let search = SidecarSearch {
            explicit: None,
            executable: Some(PathBuf::from("/opt/canopi/bin/canopi")),
            path_var: None,
        };
        assert_eq!(
            search.beside_executable(),
            Some(PathBuf::from("/opt/canopi/bin").join(EXECUTABLE))
        );
        assert_eq!(
            EXECUTABLE,
            if cfg!(windows) {
                "geolibre.exe"
            } else {
                "geolibre"
            }
        );
        let search = SidecarSearch {
            executable: None,
            ..search
        };
        assert_eq!(search.beside_executable(), None);
    }

    /// `CANOPI_GEOLIBRE_BIN` wins even when it names nothing (so a wrong
    /// override is reported, not silently replaced); otherwise the packaged
    /// sidecar beside the executable beats an installation on `PATH`; `PATH`
    /// is the last resort.
    #[test]
    fn lookup_order_is_env_then_beside_the_executable_then_path() {
        let root = scratch("order");
        let exe_dir = root.join("bin");
        let path_dir = root.join("path");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(&path_dir).unwrap();
        let beside = exe_dir.join(EXECUTABLE);
        let on_path = path_dir.join(EXECUTABLE);
        std::fs::write(&beside, b"").unwrap();
        std::fs::write(&on_path, b"").unwrap();
        let path_var = Some(std::env::join_paths([&path_dir]).unwrap());
        let executable = Some(exe_dir.join("canopi"));

        let explicit = root.join("explicit-geolibre");
        let search = SidecarSearch {
            explicit: Some(explicit.clone().into_os_string()),
            executable: executable.clone(),
            path_var: path_var.clone(),
        };
        assert_eq!(search.locate().unwrap(), explicit);

        let search = SidecarSearch {
            explicit: None,
            executable: executable.clone(),
            path_var: path_var.clone(),
        };
        assert_eq!(search.locate().unwrap(), beside);

        std::fs::remove_file(&beside).unwrap();
        assert_eq!(search.locate().unwrap(), on_path);

        std::fs::remove_file(&on_path).unwrap();
        let error = search.locate().expect_err("nothing installed");
        assert!(error.contains("not installed"), "{error}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The build script and the provenance name the same pinned revision.
    #[test]
    fn the_build_script_pins_the_recorded_revision() {
        let script = include_str!("../../../../scripts/build-geolibre-cli.sh");
        assert!(
            script.contains(&format!("REVISION={GEOLIBRE_REVISION}")),
            "scripts/build-geolibre-cli.sh must build {GEOLIBRE_REVISION}"
        );
    }

    #[test]
    fn a_missing_runner_is_a_named_unavailability_not_a_fallback() {
        let scratch = scratch("missing-runner");
        let engine = GeolibreEngine::at(
            scratch.join("no-such-geolibre-binary"),
            scratch.path().to_path_buf(),
        );
        let error = engine.discover().expect_err("missing binary");
        assert!(error.contains("not installed"), "{error}");
        let cancel = AtomicBool::new(false);
        let error = engine
            .run(
                "slope",
                Path::new("in.tif"),
                Path::new("out.tif"),
                &[],
                &cancel,
            )
            .expect_err("no analysis without the runner");
        assert!(error.contains("not installed"), "{error}");
    }
}
