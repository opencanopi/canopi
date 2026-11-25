//! Plan-level test support for the generation tests in lib.rs: temporary roots, the destination list with its
//! sentinels, a fixture source root, and the external renderers that succeed or fail.

use crate::external_contracts::{ExternalContractRenderer, WebCatalogArtifacts};
use crate::locale_keys::EN_JSON;
use crate::{
    ANALYSIS_REGISTRY_RUST, ANALYSIS_REGISTRY_TS, CONTRACTS_TS, DESIGN_FORMAT_TS,
    EDITION_CAPABILITIES_TS, GenerationMode, KNOWN_KEYS_TS, LOCALE_KEYS_TS, LOCALE_REGISTRY_TS,
    NEW_DESIGN_DEFAULTS_RUST, NEW_DESIGN_DEFAULTS_TS, PLANT_FILTER_RUST, PLANT_FILTER_TS,
    QUANTITY_TABLE_TS, REDACTION_RUST, REDACTION_TS, SETTINGS_TS, SPECIES_SEARCH_NORMALIZATION_TS,
    STORE_CHAIN_TS, TRANSLATE_VALUE_RUST, TYPE_MANIFEST_JSON, V10_SPEC_ADDITION_PRINT_SETUP,
    V10_SPEC_ADDITION_TIMELINE_OFFSET, V10_SPEC_ADDITION_ZONE_STYLE, V10_SPEC_DEFAULTS_JSON,
    V10_SPEC_EXPECTED_JSON, V10_SPEC_FIELDS_JSON, V10_SPEC_FIXTURE_CANOPI, V10_SPEC_SCHEMA_JSON,
    WEB_CATALOG_DECLARATION, WEB_CATALOG_MODULE, execute_generation,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_ROOT: AtomicU64 = AtomicU64::new(0);

pub(crate) struct TempRoot(pub(crate) PathBuf);

impl TempRoot {
    pub(crate) fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "canopi_bindings_gen_{}_{}",
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
pub(crate) const DESTINATIONS: [&str; 30] = [
    CONTRACTS_TS,
    TYPE_MANIFEST_JSON,
    KNOWN_KEYS_TS,
    DESIGN_FORMAT_TS,
    SETTINGS_TS,
    STORE_CHAIN_TS,
    EDITION_CAPABILITIES_TS,
    NEW_DESIGN_DEFAULTS_TS,
    NEW_DESIGN_DEFAULTS_RUST,
    PLANT_FILTER_TS,
    PLANT_FILTER_RUST,
    SPECIES_SEARCH_NORMALIZATION_TS,
    ANALYSIS_REGISTRY_TS,
    ANALYSIS_REGISTRY_RUST,
    LOCALE_KEYS_TS,
    LOCALE_REGISTRY_TS,
    QUANTITY_TABLE_TS,
    TRANSLATE_VALUE_RUST,
    REDACTION_TS,
    REDACTION_RUST,
    WEB_CATALOG_MODULE,
    WEB_CATALOG_DECLARATION,
    V10_SPEC_SCHEMA_JSON,
    V10_SPEC_FIELDS_JSON,
    V10_SPEC_DEFAULTS_JSON,
    V10_SPEC_FIXTURE_CANOPI,
    V10_SPEC_EXPECTED_JSON,
    V10_SPEC_ADDITION_PRINT_SETUP,
    V10_SPEC_ADDITION_ZONE_STYLE,
    V10_SPEC_ADDITION_TIMELINE_OFFSET,
];

pub(crate) fn repo_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()
}

pub(crate) fn write_sentinels(root: &Path) {
    for relative in DESTINATIONS {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("sentinel:{relative}")).unwrap();
    }
}

pub(crate) fn assert_sentinels_unchanged(root: &Path) {
    for relative in DESTINATIONS {
        assert_eq!(
            fs::read_to_string(root.join(relative)).unwrap(),
            format!("sentinel:{relative}"),
        );
    }
}

/// A source root holding the canopi-types contracts and an en.json fixture, so a test can change English.
pub(crate) fn fixture_source_root(en_json: &str) -> TempRoot {
    let root = TempRoot::new();
    fs::create_dir_all(root.0.join("canopi-types")).unwrap();
    for entry in fs::read_dir(repo_root().join("canopi-types")).unwrap() {
        let path = entry.unwrap().path();
        if path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            fs::copy(
                &path,
                root.0.join("canopi-types").join(path.file_name().unwrap()),
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
pub(crate) fn generate_fixed(
    source: &Path,
    destination: &Path,
    mode: GenerationMode,
) -> Result<(), Box<dyn std::error::Error>> {
    execute_generation(source, destination, &FixedWebCatalog, mode)
}

pub(crate) struct FixedWebCatalog;

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

pub(crate) struct LateFailure;

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
