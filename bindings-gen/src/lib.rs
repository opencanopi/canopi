mod analysis_registry;
mod contracts;
mod design_format;
mod external_contracts;
mod locale_keys;
mod new_design_defaults;
mod plant_filter;
mod publication;
mod settings;
mod species_search_normalization;

use external_contracts::{ExternalContractRenderer, PythonContractRenderer};
use publication::{AdmissionMode, GenerationPlan, acquire_generation_admission};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const ANALYSIS_REGISTRY_TS: &str = "desktop/web/src/generated/analysis-registry.ts";
const ANALYSIS_REGISTRY_RUST: &str = "desktop/src/services/lidar/analysis_registry_generated.rs";
const CONTRACTS_TS: &str = "desktop/web/src/generated/contracts.ts";
const KNOWN_KEYS_TS: &str = "desktop/web/src/generated/known-canopi-keys.ts";
const LOCALE_KEYS_TS: &str = "desktop/web/src/generated/locale-keys.ts";
const DESIGN_FORMAT_TS: &str = "desktop/web/src/generated/canopi-design-format.ts";
const SETTINGS_TS: &str = "desktop/web/src/generated/settings.ts";
const NEW_DESIGN_DEFAULTS_TS: &str = "desktop/web/src/generated/new-design-defaults.ts";
const NEW_DESIGN_DEFAULTS_RUST: &str = "desktop/src/design/new_design_defaults.rs";
const PLANT_FILTER_TS: &str = "desktop/web/src/generated/plant-filter-fields.ts";
const PLANT_FILTER_RUST: &str = "desktop/src/db/plant_filter_fields.rs";
const SPECIES_SEARCH_NORMALIZATION_TS: &str =
    "desktop/web/src/generated/species-search-normalization.ts";
const WEB_CATALOG_MODULE: &str = "desktop/web/src/generated/web-catalog-artifact.mjs";
const WEB_CATALOG_DECLARATION: &str = "desktop/web/src/generated/web-catalog-artifact.d.mts";

pub fn run_from_env() -> Result<(), Box<dyn std::error::Error>> {
    let mode = GenerationMode::from_args(std::env::args().skip(1))?;
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .ok_or("bindings-gen manifest directory has no repository parent")?;
    execute_generation(repo_root, repo_root, &PythonContractRenderer, mode)
}

#[derive(Clone, Copy)]
enum GenerationMode {
    Write,
    Check,
}

impl GenerationMode {
    fn from_args(
        args: impl IntoIterator<Item = String>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let args = args.into_iter().collect::<Vec<_>>();
        match args.as_slice() {
            [] => Ok(Self::Write),
            [flag] if flag == "--check" => Ok(Self::Check),
            _ => Err("usage: bindings-gen [--check]".into()),
        }
    }

    fn admission(self) -> AdmissionMode {
        match self {
            Self::Write => AdmissionMode::Publish,
            Self::Check => AdmissionMode::Check,
        }
    }
}

fn execute_generation(
    source_root: &Path,
    destination_root: &Path,
    external: &impl ExternalContractRenderer,
    mode: GenerationMode,
) -> Result<(), Box<dyn std::error::Error>> {
    let admission = acquire_generation_admission(destination_root, mode.admission())?;
    external.validate_species_catalog(source_root)?;
    let mut plan = compile_native_plan(source_root, destination_root)?;
    let web_catalog = external.render_web_catalog(source_root)?;
    plan.add(
        destination_root.join(WEB_CATALOG_MODULE),
        web_catalog.module,
    )?;
    plan.add(
        destination_root.join(WEB_CATALOG_DECLARATION),
        web_catalog.declaration,
    )?;
    match mode {
        GenerationMode::Write => plan.publish_admitted(admission)?,
        GenerationMode::Check => plan.check_admitted(admission)?,
    }
    Ok(())
}

fn compile_native_plan(
    source_root: &Path,
    destination_root: &Path,
) -> Result<GenerationPlan, Box<dyn std::error::Error>> {
    design_format::validate_canopi_design_conformance(
        &source_root.join("common-types/canopi-design-conformance.json"),
    )?;
    let new_design_defaults = new_design_defaults::render_new_design_defaults(
        &source_root.join("common-types/canopi-new-design-defaults.json"),
    )?;
    let new_design_defaults_rust = format_rust_source(&new_design_defaults.rust, source_root)?;
    let (plant_filter_ts, plant_filter_rust) = plant_filter::render_plant_filter_adapters(
        &source_root.join("common-types/plant-filter-fields.json"),
    )?;
    let species_search_normalization_ts = species_search_normalization::render_typescript_adapter(
        &source_root.join("common-types/species-search-normalization.json"),
    )?;
    let plant_filter_rust = format_rust_source(&plant_filter_rust, source_root)?;
    let (analysis_registry_ts, analysis_registry_rust) =
        analysis_registry::render_analysis_registry(
            &source_root.join("common-types/analysis-registry.json"),
        )?;
    let analysis_registry_rust = format_rust_source(&analysis_registry_rust, source_root)?;
    let mut plan = GenerationPlan::new(destination_root);
    plan.add(
        destination_root.join(CONTRACTS_TS),
        contracts::render_typescript_contracts()?,
    )?;
    plan.add(
        destination_root.join(KNOWN_KEYS_TS),
        design_format::render_known_canopi_keys()?,
    )?;
    plan.add(
        destination_root.join(DESIGN_FORMAT_TS),
        design_format::render_canopi_design_format()?,
    )?;
    plan.add(
        destination_root.join(SETTINGS_TS),
        settings::render_settings_runtime()?,
    )?;
    plan.add(
        destination_root.join(NEW_DESIGN_DEFAULTS_TS),
        new_design_defaults.typescript,
    )?;
    plan.add(
        destination_root.join(NEW_DESIGN_DEFAULTS_RUST),
        new_design_defaults_rust,
    )?;
    plan.add(destination_root.join(PLANT_FILTER_TS), plant_filter_ts)?;
    plan.add(destination_root.join(PLANT_FILTER_RUST), plant_filter_rust)?;
    plan.add(
        destination_root.join(SPECIES_SEARCH_NORMALIZATION_TS),
        species_search_normalization_ts,
    )?;
    plan.add(
        destination_root.join(ANALYSIS_REGISTRY_TS),
        analysis_registry_ts,
    )?;
    plan.add(
        destination_root.join(ANALYSIS_REGISTRY_RUST),
        analysis_registry_rust,
    )?;
    plan.add(
        destination_root.join(LOCALE_KEYS_TS),
        locale_keys::render_locale_keys(&source_root.join(locale_keys::EN_JSON))?,
    )?;
    Ok(plan)
}

fn format_rust_source(
    source: &str,
    repo_root: &Path,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut child = Command::new("rustfmt")
        .args(["--edition", "2024", "--emit", "stdout"])
        .current_dir(repo_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to launch rustfmt before publication: {error}"))?;
    let write_result = child
        .stdin
        .take()
        .ok_or("rustfmt stdin was unavailable")?
        .write_all(source.as_bytes());
    let output = child
        .wait_with_output()
        .map_err(|error| format!("failed to collect rustfmt output: {error}"))?;
    write_result.map_err(|error| format!("failed to stream generated Rust to rustfmt: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "rustfmt failed before generated Rust publication: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::{
        ANALYSIS_REGISTRY_RUST, ANALYSIS_REGISTRY_TS, AdmissionMode, CONTRACTS_TS,
        DESIGN_FORMAT_TS, ExternalContractRenderer, GenerationMode, KNOWN_KEYS_TS, LOCALE_KEYS_TS,
        NEW_DESIGN_DEFAULTS_RUST, NEW_DESIGN_DEFAULTS_TS, PLANT_FILTER_RUST, PLANT_FILTER_TS,
        SETTINGS_TS, SPECIES_SEARCH_NORMALIZATION_TS, WEB_CATALOG_DECLARATION, WEB_CATALOG_MODULE,
        acquire_generation_admission, execute_generation,
    };
    use crate::external_contracts::WebCatalogArtifacts;
    use crate::locale_keys::EN_JSON;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, MutexGuard, PoisonError};

    static NEXT_TEMP_ROOT: AtomicU64 = AtomicU64::new(0);

    // `execute_generation` spawns rustfmt. A child forked while another test
    // holds its admission flock inherits that descriptor until exec, so a
    // concurrent test can see its own admission as still held (canopi-he4e).
    // The CLI runs one generation per process; only parallel tests race.
    static GENERATION_RUNS: Mutex<()> = Mutex::new(());

    fn serialize_generation_runs() -> MutexGuard<'static, ()> {
        GENERATION_RUNS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "canopi_bindings_gen_late_renderer_{}_{}",
                std::process::id(),
                NEXT_TEMP_ROOT.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Every destination one generation publishes, relative to the destination root.
    const DESTINATIONS: [&str; 14] = [
        CONTRACTS_TS,
        KNOWN_KEYS_TS,
        DESIGN_FORMAT_TS,
        SETTINGS_TS,
        NEW_DESIGN_DEFAULTS_TS,
        NEW_DESIGN_DEFAULTS_RUST,
        PLANT_FILTER_TS,
        PLANT_FILTER_RUST,
        SPECIES_SEARCH_NORMALIZATION_TS,
        ANALYSIS_REGISTRY_TS,
        ANALYSIS_REGISTRY_RUST,
        LOCALE_KEYS_TS,
        WEB_CATALOG_MODULE,
        WEB_CATALOG_DECLARATION,
    ];

    fn repo_root() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()
    }

    fn write_sentinels(root: &Path) {
        for relative in DESTINATIONS {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, format!("sentinel:{relative}")).unwrap();
        }
    }

    fn assert_sentinels_unchanged(root: &Path) {
        for relative in DESTINATIONS {
            assert_eq!(
                fs::read_to_string(root.join(relative)).unwrap(),
                format!("sentinel:{relative}"),
            );
        }
        assert!(
            !root
                .join("target/bindings-gen-publication.in-progress")
                .exists()
        );
    }

    /// A source root holding the common-types contracts and an en.json fixture, so a test can change English.
    fn fixture_source_root(en_json: &str) -> TempRoot {
        let root = TempRoot::new();
        fs::create_dir_all(root.0.join("common-types")).unwrap();
        for entry in fs::read_dir(repo_root().join("common-types")).unwrap() {
            let path = entry.unwrap().path();
            if path
                .extension()
                .is_some_and(|extension| extension == "json")
            {
                fs::copy(
                    &path,
                    root.0.join("common-types").join(path.file_name().unwrap()),
                )
                .unwrap();
            }
        }
        let en = root.0.join(EN_JSON);
        fs::create_dir_all(en.parent().unwrap()).unwrap();
        fs::write(en, en_json).unwrap();
        root
    }

    /// Generates with a fixed Web Catalog, so a test needs no Python.
    fn generate_fixed(
        source: &Path,
        destination: &Path,
        mode: GenerationMode,
    ) -> Result<(), Box<dyn std::error::Error>> {
        execute_generation(source, destination, &FixedWebCatalog, mode)
    }

    struct FixedWebCatalog;

    impl ExternalContractRenderer for FixedWebCatalog {
        fn validate_species_catalog(
            &self,
            _repo_root: &Path,
        ) -> Result<(), Box<dyn std::error::Error>> {
            Ok(())
        }

        fn render_web_catalog(
            &self,
            _repo_root: &Path,
        ) -> Result<WebCatalogArtifacts, Box<dyn std::error::Error>> {
            Ok(WebCatalogArtifacts {
                module: b"export {}\n".to_vec(),
                declaration: b"export {}\n".to_vec(),
            })
        }
    }

    struct LateFailure;

    impl ExternalContractRenderer for LateFailure {
        fn validate_species_catalog(
            &self,
            _repo_root: &Path,
        ) -> Result<(), Box<dyn std::error::Error>> {
            Ok(())
        }

        fn render_web_catalog(
            &self,
            _repo_root: &Path,
        ) -> Result<WebCatalogArtifacts, Box<dyn std::error::Error>> {
            Err("forced late Web Catalog renderer failure".into())
        }
    }

    struct AdmissionLifetimeProbe {
        admission: PathBuf,
    }

    impl AdmissionLifetimeProbe {
        fn assert_exclusive_admission_is_blocked(&self) -> Result<(), Box<dyn std::error::Error>> {
            let file = fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(&self.admission)?;
            match file.try_lock() {
                Err(fs::TryLockError::WouldBlock) => Ok(()),
                Err(fs::TryLockError::Error(error)) => Err(error.into()),
                Ok(()) => Err("external rendering began before generation admission".into()),
            }
        }
    }

    impl ExternalContractRenderer for AdmissionLifetimeProbe {
        fn validate_species_catalog(
            &self,
            _repo_root: &Path,
        ) -> Result<(), Box<dyn std::error::Error>> {
            self.assert_exclusive_admission_is_blocked()
        }

        fn render_web_catalog(
            &self,
            _repo_root: &Path,
        ) -> Result<WebCatalogArtifacts, Box<dyn std::error::Error>> {
            self.assert_exclusive_admission_is_blocked()?;
            Err("forced renderer failure after admission probe".into())
        }
    }

    #[test]
    fn late_renderer_failure_leaves_every_destination_unchanged() {
        let _generation_run = serialize_generation_runs();
        let destination = TempRoot::new();
        write_sentinels(&destination.0);

        let error = execute_generation(
            repo_root(),
            &destination.0,
            &LateFailure,
            GenerationMode::Write,
        )
        .expect_err("the late renderer should stop generation");

        assert!(
            error
                .to_string()
                .contains("forced late Web Catalog renderer failure")
        );
        assert_sentinels_unchanged(&destination.0);
    }

    #[test]
    fn generation_admission_is_held_through_external_rendering() {
        let _generation_run = serialize_generation_runs();
        let source_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let destination = TempRoot::new();
        let renderer = AdmissionLifetimeProbe {
            admission: destination.0.join("target/bindings-gen-publication.lock"),
        };
        write_sentinels(&destination.0);

        let error = execute_generation(
            source_root,
            &destination.0,
            &renderer,
            GenerationMode::Write,
        )
        .expect_err("the renderer probe stops generation after checking admission");

        assert!(
            error
                .to_string()
                .contains("forced renderer failure after admission probe")
        );
        assert_sentinels_unchanged(&destination.0);
        let _released = acquire_generation_admission(&destination.0, AdmissionMode::Publish)
            .expect("renderer failure must release generation admission");
    }

    #[test]
    fn drift_check_admission_is_held_through_external_rendering() {
        let _generation_run = serialize_generation_runs();
        let source_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let destination = TempRoot::new();
        let renderer = AdmissionLifetimeProbe {
            admission: destination.0.join("target/bindings-gen-publication.lock"),
        };

        let error = execute_generation(
            source_root,
            &destination.0,
            &renderer,
            GenerationMode::Check,
        )
        .expect_err("the renderer probe stops checking after testing admission");

        assert!(
            error
                .to_string()
                .contains("forced renderer failure after admission probe")
        );
        let _released = acquire_generation_admission(&destination.0, AdmissionMode::Publish)
            .expect("renderer failure must release drift-check admission");
    }

    #[test]
    fn drift_check_names_locale_keys_when_english_gains_a_key() {
        let _generation_run = serialize_generation_runs();
        let source = fixture_source_root(r#"{"about": {"title": "About"}}"#);
        let destination = TempRoot::new();
        write_sentinels(&destination.0);
        generate_fixed(&source.0, &destination.0, GenerationMode::Write).unwrap();
        generate_fixed(&source.0, &destination.0, GenerationMode::Check).unwrap();

        let english = r#"{"about": {"title": "About", "version": "Version"}}"#;
        fs::write(source.0.join(EN_JSON), english).unwrap();
        let error = generate_fixed(&source.0, &destination.0, GenerationMode::Check)
            .expect_err("a key English gained is stale in locale-keys.ts");

        let message = error.to_string();
        assert!(
            message.contains("generated artifacts are stale"),
            "{message}"
        );
        assert!(message.contains(LOCALE_KEYS_TS), "{message}");
        assert_eq!(message.matches("\n- ").count(), 1, "{message}");
    }

    #[cfg(unix)]
    #[test]
    fn read_only_destination_leaves_no_partial_locale_keys() {
        use std::os::unix::fs::PermissionsExt;
        let _generation_run = serialize_generation_runs();
        let destination = TempRoot::new();
        let generated = destination.0.join(LOCALE_KEYS_TS);
        let generated = generated.parent().unwrap();
        fs::create_dir_all(generated).unwrap();
        fs::set_permissions(generated, fs::Permissions::from_mode(0o555)).unwrap();

        let result = generate_fixed(repo_root(), &destination.0, GenerationMode::Write);
        let left = fs::read_dir(generated).unwrap().count();
        fs::set_permissions(generated, fs::Permissions::from_mode(0o755)).unwrap();

        assert!(result.is_err(), "a read-only destination refuses");
        assert_eq!(left, 0, "no partial or staged file is left");
        for relative in DESTINATIONS {
            assert!(!destination.0.join(relative).exists(), "{relative}");
        }
    }

    /// The child process `interrupted_generation_leaves_every_destination_unchanged` interrupts.
    const INTERRUPTED_DESTINATION: &str = "CANOPI_BINDINGS_GEN_INTERRUPTED_DESTINATION";

    /// Stalls once the native artifacts are rendered, before publication, until the parent's SIGINT arrives.
    struct StallBeforePublication {
        ready: PathBuf,
    }

    impl ExternalContractRenderer for StallBeforePublication {
        fn validate_species_catalog(
            &self,
            _repo_root: &Path,
        ) -> Result<(), Box<dyn std::error::Error>> {
            Ok(())
        }

        fn render_web_catalog(
            &self,
            _repo_root: &Path,
        ) -> Result<WebCatalogArtifacts, Box<dyn std::error::Error>> {
            fs::write(&self.ready, b"")?;
            std::thread::sleep(std::time::Duration::from_secs(120));
            Err("the interrupt never arrived".into())
        }
    }

    #[test]
    #[ignore = "the child half of interrupted_generation_leaves_every_destination_unchanged"]
    fn interrupted_generation_child() {
        let Some(destination) = std::env::var_os(INTERRUPTED_DESTINATION) else {
            return;
        };
        let destination = PathBuf::from(destination);
        let renderer = StallBeforePublication {
            ready: destination.join("ready"),
        };
        let _ = execute_generation(repo_root(), &destination, &renderer, GenerationMode::Write);
    }

    // A crash inside publication itself leaves the in-progress marker, which refuses the next run:
    // publication.rs's interrupted_publication_marker_blocks_a_new_publication.
    #[cfg(unix)]
    #[test]
    fn interrupted_generation_leaves_every_destination_unchanged() {
        use std::os::unix::process::ExitStatusExt;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        let _generation_run = serialize_generation_runs();
        let destination = TempRoot::new();
        write_sentinels(&destination.0);
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::interrupted_generation_child",
                "--ignored",
            ])
            .env(INTERRUPTED_DESTINATION, &destination.0)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(120);
        while !destination.0.join("ready").exists() {
            if Instant::now() > deadline || child.try_wait().unwrap().is_some() {
                let _ = child.kill();
                panic!("the child never reached publication");
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        let sent = Command::new("kill")
            .args(["-INT", &child.id().to_string()])
            .status()
            .unwrap();
        let status = child.wait().unwrap();

        assert!(sent.success());
        assert_eq!(status.signal(), Some(2), "{status:?}");
        assert_sentinels_unchanged(&destination.0);
        let _released = acquire_generation_admission(&destination.0, AdmissionMode::Publish)
            .expect("an interrupted generation leaves the admission lock free");
    }
}
