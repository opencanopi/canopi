mod analysis_registry;
mod command_map;
mod contracts;
mod design_format;
mod edition_capabilities;
mod external_contracts;
mod locale_keys;
mod locale_registry;
mod new_design_defaults;
#[cfg(test)]
mod plan_support;
mod plant_filter;
mod publication;
mod quantity_table;
mod redaction;
mod settings;
mod species_search_normalization;
mod store_chain;
mod type_manifest;

use external_contracts::{ExternalContractRenderer, PythonContractRenderer};
use publication::GenerationPlan;
use std::error::Error;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const ANALYSIS_REGISTRY_TS: &str = "desktop/web/src/generated/analysis-registry.ts";
const ANALYSIS_REGISTRY_RUST: &str = "desktop/src/services/lidar/analysis_registry_generated.rs";
const CONTRACTS_TS: &str = "desktop/web/src/generated/contracts.ts";
const EDITION_CAPABILITIES_TS: &str = "desktop/web/src/generated/edition-capabilities.ts";
const KNOWN_KEYS_TS: &str = "desktop/web/src/generated/known-canopi-keys.ts";
const LOCALE_KEYS_TS: &str = "desktop/web/src/generated/locale-keys.ts";
const LOCALE_REGISTRY_TS: &str = "desktop/web/src/generated/locale-registry.ts";
const QUANTITY_TABLE_TS: &str = "desktop/web/src/generated/quantity-table.ts";
const TRANSLATE_VALUE_RUST: &str = "desktop/src/db/query_builder/translate_value.rs";
const DESIGN_FORMAT_TS: &str = "desktop/web/src/generated/canopi-design-format.ts";
const SETTINGS_TS: &str = "desktop/web/src/generated/settings.ts";
const STORE_CHAIN_TS: &str = "desktop/web/src/generated/store-chain.ts";
const NEW_DESIGN_DEFAULTS_TS: &str = "desktop/web/src/generated/new-design-defaults.ts";
const NEW_DESIGN_DEFAULTS_RUST: &str = "desktop/src/design/new_design_defaults.rs";
const PLANT_FILTER_TS: &str = "desktop/web/src/generated/plant-filter-fields.ts";
const PLANT_FILTER_RUST: &str = "desktop/src/db/plant_filter_fields.rs";
const REDACTION_TS: &str = "desktop/web/src/generated/redaction.ts";
const REDACTION_RUST: &str = "canopi-redact/src/table_generated.rs";
const TYPE_MANIFEST_JSON: &str = "desktop/web/src/generated/type-manifest.json";
const SPECIES_SEARCH_NORMALIZATION_TS: &str =
    "desktop/web/src/generated/species-search-normalization.ts";
const WEB_CATALOG_MODULE: &str = "desktop/web/src/generated/web-catalog-artifact.mjs";
const WEB_CATALOG_DECLARATION: &str = "desktop/web/src/generated/web-catalog-artifact.d.mts";
const V9_SPEC_SCHEMA_JSON: &str = "canopi-format/spec/v9/schema.json";
const V10_SPEC_SCHEMA_JSON: &str = "canopi-format/spec/v10/schema.json";
const V10_SPEC_FIELDS_JSON: &str = "canopi-format/spec/v10/fields.json";
const V10_SPEC_DEFAULTS_JSON: &str = "canopi-format/spec/v10/defaults.json";
const V10_SPEC_FIXTURE_CANOPI: &str = "canopi-format/spec/v10/fixture.canopi";
const V10_SPEC_EXPECTED_JSON: &str = "canopi-format/spec/v10/expected.json";
const V10_SPEC_ADDITION_PRINT_SETUP: &str = "canopi-format/spec/v10/additions/print_setup.json";
const V10_SPEC_ADDITION_ZONE_STYLE: &str = "canopi-format/spec/v10/additions/zone_style.json";
const V10_SPEC_ADDITION_TIMELINE_OFFSET: &str =
    "canopi-format/spec/v10/additions/timeline_offset.json";
const STAMP_V2_SPEC_SCHEMA_JSON: &str = "canopi-format/spec/stamps/v2/schema.json";
const STAMP_V3_SPEC_SCHEMA_JSON: &str = "canopi-format/spec/stamps/v3/schema.json";

struct EmittedArtifact {
    relative_path: &'static str,
    contents: Vec<u8>,
}

impl EmittedArtifact {
    fn text(relative_path: &'static str, contents: String) -> Self {
        Self {
            relative_path,
            contents: contents.into_bytes(),
        }
    }

    fn rust(
        relative_path: &'static str,
        source: &str,
        source_root: &Path,
    ) -> Result<Self, Box<dyn Error>> {
        Ok(Self {
            relative_path,
            contents: format_rust_source(source, source_root)?,
        })
    }
}

type EmitterFn = fn(&Path) -> Result<Vec<EmittedArtifact>, Box<dyn Error>>;

/// Static emitter list (2a-1): every native code generator registers here once.
const EMITTERS: &[EmitterFn] = &[
    emit_contracts,
    emit_design_format,
    emit_settings,
    emit_store_chain,
    emit_edition_capabilities,
    emit_command_map,
    emit_new_design_defaults,
    emit_plant_filter,
    emit_species_search_normalization,
    emit_analysis_registry,
    emit_redaction,
    emit_locale_keys,
    emit_locale_registry,
    emit_quantity_table,
    emit_v10_spec,
];

fn emit_v10_spec(_source_root: &Path) -> Result<Vec<EmittedArtifact>, Box<dyn Error>> {
    let v9_schema = canopi_types::design::canopi_file_json_schema();
    let v10_schema = canopi_types::design::v10::canopi_file_v10_json_schema();
    let print_setup_schema = canopi_types::design::v10::print_setup_v10_json_schema();
    let stamp_v2_schema = canopi_types::saved_object_stamps::stamp_payload_v2_json_schema();
    let stamp_v3_schema = canopi_types::saved_object_stamps::stamp_payload_v3_json_schema();

    if let Some(bad) = canopi_format::schema::unsupported_keyword(&v10_schema) {
        return Err(format!("v10 schema uses unsupported keyword: {bad}").into());
    }

    let paths: &[(&str, &'static str)] = &[
        ("schema.json", V10_SPEC_SCHEMA_JSON),
        ("fields.json", V10_SPEC_FIELDS_JSON),
        ("defaults.json", V10_SPEC_DEFAULTS_JSON),
        ("fixture.canopi", V10_SPEC_FIXTURE_CANOPI),
        ("expected.json", V10_SPEC_EXPECTED_JSON),
        ("additions/print_setup.json", V10_SPEC_ADDITION_PRINT_SETUP),
        ("additions/zone_style.json", V10_SPEC_ADDITION_ZONE_STYLE),
        (
            "additions/timeline_offset.json",
            V10_SPEC_ADDITION_TIMELINE_OFFSET,
        ),
    ];
    let emitted = canopi_format::spec_emit::emit_v10_spec_files(&v10_schema, &print_setup_schema);
    let mut out = Vec::with_capacity(emitted.len() + 3);
    out.push(EmittedArtifact::text(
        V9_SPEC_SCHEMA_JSON,
        canopi_format::spec_emit::pretty_canonical_json(&v9_schema),
    ));
    for file in emitted {
        let dest = paths
            .iter()
            .find(|(rel, _)| *rel == file.relative_path)
            .map(|(_, dst)| *dst)
            .ok_or_else(|| format!("unmapped v10 spec file: {}", file.relative_path))?;
        out.push(EmittedArtifact::text(dest, file.content));
    }
    out.push(EmittedArtifact::text(
        STAMP_V2_SPEC_SCHEMA_JSON,
        canopi_format::spec_emit::pretty_canonical_json(&stamp_v2_schema),
    ));
    out.push(EmittedArtifact::text(
        STAMP_V3_SPEC_SCHEMA_JSON,
        canopi_format::spec_emit::pretty_canonical_json(&stamp_v3_schema),
    ));
    Ok(out)
}

fn emit_contracts(_source_root: &Path) -> Result<Vec<EmittedArtifact>, Box<dyn Error>> {
    Ok(vec![
        EmittedArtifact::text(CONTRACTS_TS, contracts::render_typescript_contracts()?),
        EmittedArtifact::text(
            TYPE_MANIFEST_JSON,
            type_manifest::render_type_manifest(&contracts::contract_types())?,
        ),
    ])
}

fn emit_design_format(source_root: &Path) -> Result<Vec<EmittedArtifact>, Box<dyn Error>> {
    design_format::validate_canopi_design_conformance(
        &source_root.join("canopi-types/canopi-design-conformance.json"),
    )?;
    Ok(vec![
        EmittedArtifact::text(KNOWN_KEYS_TS, design_format::render_known_canopi_keys()?),
        EmittedArtifact::text(
            DESIGN_FORMAT_TS,
            design_format::render_canopi_design_format()?,
        ),
    ])
}

fn emit_settings(_source_root: &Path) -> Result<Vec<EmittedArtifact>, Box<dyn Error>> {
    Ok(vec![EmittedArtifact::text(
        SETTINGS_TS,
        settings::render_settings_runtime()?,
    )])
}

fn emit_command_map(_source_root: &Path) -> Result<Vec<EmittedArtifact>, Box<dyn Error>> {
    Ok(vec![EmittedArtifact::text(
        command_map::COMMAND_MAP_OUTPUT,
        command_map::render_typescript_command_map(),
    )])
}

fn emit_store_chain(_source_root: &Path) -> Result<Vec<EmittedArtifact>, Box<dyn Error>> {
    Ok(vec![EmittedArtifact::text(
        STORE_CHAIN_TS,
        store_chain::render_store_chain_ts()?,
    )])
}

fn emit_edition_capabilities(source_root: &Path) -> Result<Vec<EmittedArtifact>, Box<dyn Error>> {
    Ok(vec![EmittedArtifact::text(
        EDITION_CAPABILITIES_TS,
        edition_capabilities::render_edition_capabilities_ts(
            &source_root.join(edition_capabilities::EDITION_CAPABILITIES_JSON),
        )?,
    )])
}

fn emit_new_design_defaults(source_root: &Path) -> Result<Vec<EmittedArtifact>, Box<dyn Error>> {
    let rendered = new_design_defaults::render_new_design_defaults(
        &source_root.join("canopi-types/canopi-new-design-defaults.json"),
    )?;
    Ok(vec![
        EmittedArtifact::text(NEW_DESIGN_DEFAULTS_TS, rendered.typescript),
        EmittedArtifact::rust(NEW_DESIGN_DEFAULTS_RUST, &rendered.rust, source_root)?,
    ])
}

fn emit_plant_filter(source_root: &Path) -> Result<Vec<EmittedArtifact>, Box<dyn Error>> {
    let (ts, rust) = plant_filter::render_plant_filter_adapters(
        &source_root.join("canopi-types/plant-filter-fields.json"),
    )?;
    Ok(vec![
        EmittedArtifact::text(PLANT_FILTER_TS, ts),
        EmittedArtifact::rust(PLANT_FILTER_RUST, &rust, source_root)?,
    ])
}

fn emit_species_search_normalization(
    source_root: &Path,
) -> Result<Vec<EmittedArtifact>, Box<dyn Error>> {
    Ok(vec![EmittedArtifact::text(
        SPECIES_SEARCH_NORMALIZATION_TS,
        species_search_normalization::render_typescript_adapter(
            &source_root.join("canopi-types/species-search-normalization.json"),
        )?,
    )])
}

fn emit_analysis_registry(source_root: &Path) -> Result<Vec<EmittedArtifact>, Box<dyn Error>> {
    let (ts, rust) = analysis_registry::render_analysis_registry(
        &source_root.join("canopi-types/analysis-registry.json"),
    )?;
    Ok(vec![
        EmittedArtifact::text(ANALYSIS_REGISTRY_TS, ts),
        EmittedArtifact::rust(ANALYSIS_REGISTRY_RUST, &rust, source_root)?,
    ])
}

fn emit_redaction(source_root: &Path) -> Result<Vec<EmittedArtifact>, Box<dyn Error>> {
    let (ts, rust) =
        redaction::render_redaction_table(&source_root.join(redaction::REDACTION_JSON))?;
    Ok(vec![
        EmittedArtifact::text(REDACTION_TS, ts),
        EmittedArtifact::rust(REDACTION_RUST, &rust, source_root)?,
    ])
}

fn emit_locale_keys(source_root: &Path) -> Result<Vec<EmittedArtifact>, Box<dyn Error>> {
    Ok(vec![EmittedArtifact::text(
        LOCALE_KEYS_TS,
        locale_keys::render_locale_keys(&source_root.join(locale_keys::EN_JSON))?,
    )])
}

fn emit_locale_registry(source_root: &Path) -> Result<Vec<EmittedArtifact>, Box<dyn Error>> {
    Ok(vec![
        EmittedArtifact::text(
            LOCALE_REGISTRY_TS,
            locale_registry::render_locale_registry_ts()?,
        ),
        EmittedArtifact::rust(
            TRANSLATE_VALUE_RUST,
            &locale_registry::render_translate_value_rust()?,
            source_root,
        )?,
    ])
}

fn emit_quantity_table(_source_root: &Path) -> Result<Vec<EmittedArtifact>, Box<dyn Error>> {
    Ok(vec![EmittedArtifact::text(
        QUANTITY_TABLE_TS,
        quantity_table::render_quantity_table_ts()?,
    )])
}

pub fn run_from_env() -> Result<(), Box<dyn Error>> {
    let mode = GenerationMode::from_args(std::env::args().skip(1))?;
    let repo_root = repository_root(std::env::var_os("CARGO_MANIFEST_DIR"))?;
    execute_generation(&repo_root, &repo_root, &PythonContractRenderer, mode)
}

/// The repository the generator reads and writes. `cargo run` sets
/// `CARGO_MANIFEST_DIR` at run time to the tree it was launched in; that value
/// wins over the compiled one, because one Rust target may serve several
/// worktrees and cargo does not rebuild a workspace member whose source only
/// moved (canopi-f47t.52.264). The compiled path is the fallback for a binary
/// run directly.
fn repository_root(runtime_manifest_dir: Option<OsString>) -> Result<PathBuf, Box<dyn Error>> {
    let manifest_dir = runtime_manifest_dir
        .filter(|dir| !dir.is_empty())
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from);
    Ok(manifest_dir
        .parent()
        .ok_or("bindings-gen manifest directory has no repository parent")?
        .to_path_buf())
}

#[derive(Clone, Copy)]
enum GenerationMode {
    Write,
    Check,
}

impl GenerationMode {
    fn from_args(args: impl IntoIterator<Item = String>) -> Result<Self, Box<dyn Error>> {
        let args = args.into_iter().collect::<Vec<_>>();
        match args.as_slice() {
            [] => Ok(Self::Write),
            [flag] if flag == "--check" => Ok(Self::Check),
            _ => Err("usage: bindings-gen [--check]".into()),
        }
    }
}

fn execute_generation(
    source_root: &Path,
    destination_root: &Path,
    external: &impl ExternalContractRenderer,
    mode: GenerationMode,
) -> Result<(), Box<dyn Error>> {
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
        GenerationMode::Write => plan.publish()?,
        GenerationMode::Check => plan.check()?,
    }
    Ok(())
}

fn compile_native_plan(
    source_root: &Path,
    destination_root: &Path,
) -> Result<GenerationPlan, Box<dyn Error>> {
    let mut plan = GenerationPlan::new(destination_root);
    for emitter in EMITTERS {
        for artifact in emitter(source_root)? {
            plan.add(
                destination_root.join(artifact.relative_path),
                artifact.contents,
            )?;
        }
    }
    Ok(plan)
}

fn format_rust_source(source: &str, repo_root: &Path) -> Result<Vec<u8>, Box<dyn Error>> {
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
        EDITION_CAPABILITIES_TS, GenerationMode, LOCALE_KEYS_TS, STORE_CHAIN_TS,
        TYPE_MANIFEST_JSON, execute_generation, repository_root,
    };
    use crate::locale_keys::EN_JSON;
    use crate::plan_support::{
        LateFailure, TempRoot, assert_sentinels_unchanged, fixture_source_root, generate_fixed,
        repo_root, write_sentinels,
    };
    use std::fs;
    use std::path::Path;

    /// canopi-f47t.52.264: one Rust target serves several worktrees, and cargo
    /// does not rebuild a workspace member whose source moved, so a binary
    /// compiled in another (possibly removed) worktree must still read the tree
    /// `cargo run` launched it in, never the tree it was compiled in.
    #[test]
    fn canopi_f47t_52_264_repository_root_follows_the_run_time_manifest_dir() {
        let elsewhere = Path::new("/elsewhere/worktree");
        let root = repository_root(Some(elsewhere.join("bindings-gen").into_os_string())).unwrap();
        assert_eq!(root, elsewhere);

        let compiled = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        assert_eq!(repository_root(None).unwrap(), compiled);
    }

    #[test]
    fn late_renderer_failure_leaves_every_destination_unchanged() {
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
    fn generation_publishes_the_type_manifest_of_the_contract_types() {
        let source = fixture_source_root(r#"{"about": {"title": "About"}}"#);
        let destination = TempRoot::new();
        write_sentinels(&destination.0);
        generate_fixed(&source.0, &destination.0, GenerationMode::Write).unwrap();

        let published = fs::read_to_string(destination.0.join(TYPE_MANIFEST_JSON)).unwrap();
        let expected =
            crate::type_manifest::render_type_manifest(&crate::contracts::contract_types())
                .unwrap();
        assert_eq!(published, expected);
        assert!(destination.0.join(STORE_CHAIN_TS).is_file());
        assert!(destination.0.join(EDITION_CAPABILITIES_TS).is_file());
        generate_fixed(&source.0, &destination.0, GenerationMode::Check).unwrap();
    }

    #[test]
    fn drift_check_names_locale_keys_when_english_gains_a_key() {
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
}
