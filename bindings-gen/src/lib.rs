mod analysis_registry;
mod contracts;
mod design_format;
mod external_contracts;
mod locale_keys;
mod new_design_defaults;
#[cfg(test)]
mod plan_support;
mod plant_filter;
mod publication;
mod settings;
mod species_search_normalization;
mod type_manifest;

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
const TYPE_MANIFEST_JSON: &str = "desktop/web/src/generated/type-manifest.json";
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
        destination_root.join(TYPE_MANIFEST_JSON),
        type_manifest::render_type_manifest(&contracts::contract_types())?,
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
        AdmissionMode, GenerationMode, LOCALE_KEYS_TS, TYPE_MANIFEST_JSON,
        acquire_generation_admission, execute_generation,
    };
    use crate::locale_keys::EN_JSON;
    use crate::plan_support::{
        AdmissionLifetimeProbe, LateFailure, StallBeforePublication, TempRoot,
        assert_sentinels_unchanged, fixture_source_root, generate_fixed, repo_root,
        serialize_generation_runs, write_sentinels,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

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
    fn generation_publishes_the_type_manifest_of_the_contract_types() {
        let _generation_run = serialize_generation_runs();
        let source = fixture_source_root(r#"{"about": {"title": "About"}}"#);
        let destination = TempRoot::new();
        write_sentinels(&destination.0);
        generate_fixed(&source.0, &destination.0, GenerationMode::Write).unwrap();

        let published = fs::read_to_string(destination.0.join(TYPE_MANIFEST_JSON)).unwrap();
        let expected =
            crate::type_manifest::render_type_manifest(&crate::contracts::contract_types())
                .unwrap();
        assert_eq!(published, expected);
        generate_fixed(&source.0, &destination.0, GenerationMode::Check).unwrap();
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
        use crate::plan_support::DESTINATIONS;
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
        panic!("the parent interrupts generation while it stalls before publication");
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
