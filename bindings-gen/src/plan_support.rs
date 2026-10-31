//! Plan-level test support for the generation tests in lib.rs: temporary roots, the destination list with its
//! sentinels, a fixture source root, and the external renderers that fail, probe admission or stall.

use crate::external_contracts::{ExternalContractRenderer, WebCatalogArtifacts};
use crate::locale_keys::EN_JSON;
use crate::{
    ANALYSIS_REGISTRY_RUST, ANALYSIS_REGISTRY_TS, CONTRACTS_TS, DESIGN_FORMAT_TS, GenerationMode,
    KNOWN_KEYS_TS, LOCALE_KEYS_TS, NEW_DESIGN_DEFAULTS_RUST, NEW_DESIGN_DEFAULTS_TS,
    PLANT_FILTER_RUST, PLANT_FILTER_TS, SETTINGS_TS, SPECIES_SEARCH_NORMALIZATION_TS,
    WEB_CATALOG_DECLARATION, WEB_CATALOG_MODULE, execute_generation,
};
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

pub(crate) fn serialize_generation_runs() -> MutexGuard<'static, ()> {
    GENERATION_RUNS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

pub(crate) struct TempRoot(pub(crate) PathBuf);

impl TempRoot {
    pub(crate) fn new() -> Self {
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
pub(crate) const DESTINATIONS: [&str; 14] = [
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
    assert!(
        !root
            .join("target/bindings-gen-publication.in-progress")
            .exists()
    );
}

/// A source root holding the common-types contracts and an en.json fixture, so a test can change English.
pub(crate) fn fixture_source_root(en_json: &str) -> TempRoot {
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

pub(crate) struct AdmissionLifetimeProbe {
    pub(crate) admission: PathBuf,
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

/// Stalls once the native artifacts are rendered, before publication, until the parent's SIGINT arrives.
pub(crate) struct StallBeforePublication {
    pub(crate) ready: PathBuf,
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
