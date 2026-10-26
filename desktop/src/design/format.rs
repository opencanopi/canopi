use common_types::design::{
    CURRENT_CANOPI_FILE_VERSION, CanopiDesignIngestionErrorKind, CanopiFile,
    DEFAULT_BUDGET_CURRENCY, DesignLoadFailure, DesignLoadFailureKind, Layer,
    MISSING_CANOPI_FILE_VERSION, admit_design_identities_and_ranges, validate_design_geometry,
};
use common_types::views::{validate_map_view, validate_views_and_stories};
use std::fmt;
use std::path::Path;

use super::new_design_defaults::NEW_DESIGN_LAYER_DEFAULTS;

#[derive(Debug)]
pub(crate) struct CanopiDesignIngestionError {
    kind: CanopiDesignIngestionErrorKind,
    message: String,
    /// The file's version when it is one this build does not open.
    unsupported_version: Option<u64>,
}

impl CanopiDesignIngestionError {
    fn new(kind: CanopiDesignIngestionErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            unsupported_version: None,
        }
    }

    fn unsupported_version(version: u64) -> Self {
        Self {
            unsupported_version: Some(version),
            ..Self::new(
                CanopiDesignIngestionErrorKind::UnsupportedVersion,
                format!(
                    "$.version: unsupported Canopi Design version {version}; Canopi 2.0 and later open only version {CURRENT_CANOPI_FILE_VERSION}",
                ),
            )
        }
    }

    /// The version of a well-formed Design this build does not open, if that is the error.
    pub(crate) fn found_unsupported_version(&self) -> Option<u64> {
        self.unsupported_version
    }

    /// Whether the unsupported version is older than the current format
    /// (written before Canopi 2.0, ADR 0021) as opposed to newer than this build.
    pub(crate) fn is_older_than_supported(&self) -> bool {
        self.unsupported_version
            .is_some_and(|version| version < u64::from(CURRENT_CANOPI_FILE_VERSION))
    }
}

impl fmt::Display for CanopiDesignIngestionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.kind.as_str(), self.message)
    }
}

/// Largest `.canopi` file this build opens, matching the GeoJSON import limit.
pub(crate) const MAX_CANOPI_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Why a `.canopi` file could not be opened. Messages never name the file:
/// the caller knows the path, and they reach logs and Problem Reports.
#[derive(Debug)]
pub(crate) enum DesignLoadError {
    Read { source: std::io::Error },
    TooLarge { limit: u64 },
    InvalidJson { source: serde_json::Error },
    Ingestion { source: CanopiDesignIngestionError },
}

impl DesignLoadError {
    pub(crate) fn failure(&self) -> DesignLoadFailure {
        let kind = match self {
            Self::Read { source } if source.kind() == std::io::ErrorKind::NotFound => {
                DesignLoadFailureKind::Missing
            }
            Self::Read { .. } => DesignLoadFailureKind::Unreadable,
            Self::TooLarge { .. } => DesignLoadFailureKind::TooLarge,
            Self::InvalidJson { .. } => DesignLoadFailureKind::InvalidJson,
            Self::Ingestion { source } => match source.found_unsupported_version() {
                Some(_) if source.is_older_than_supported() => DesignLoadFailureKind::OlderVersion,
                Some(_) => DesignLoadFailureKind::NewerVersion,
                None => DesignLoadFailureKind::InvalidDocument,
            },
        };
        DesignLoadFailure {
            kind,
            message: self.to_string(),
        }
    }
}

impl fmt::Display for DesignLoadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { source } => write!(formatter, "Failed to read the Design file: {source}"),
            Self::TooLarge { limit } => write!(
                formatter,
                "The Design file exceeds the {} MiB limit",
                limit / (1024 * 1024)
            ),
            Self::InvalidJson { source } => {
                write!(formatter, "The Design file is not valid JSON: {source}")
            }
            Self::Ingestion { source } => {
                write!(formatter, "Failed to parse the Design: {source}")
            }
        }
    }
}

impl std::error::Error for DesignLoadError {}

/// Encode a Design as `.canopi` wire bytes: the one encoder for saves, drafts
/// and exports. Refuses an encoding over [`MAX_CANOPI_FILE_BYTES`], so nothing
/// is ever written that this build would then refuse to open.
pub(crate) fn encode_design(content: &CanopiFile) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec_pretty(content)
        .map_err(|e| format!("Failed to serialize design: {e}"))?;
    if bytes.len() as u64 > MAX_CANOPI_FILE_BYTES {
        return Err(format!(
            "The Design is larger than the {} MiB a Design file may hold; remove some story images or objects before saving",
            MAX_CANOPI_FILE_BYTES / (1024 * 1024)
        ));
    }
    Ok(bytes)
}

/// Result of [`save_to_file`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SaveResult {
    /// Written; the fingerprint of the bytes now on disk.
    Saved { fingerprint: String },
    /// The file no longer has the expected fingerprint; nothing was written.
    Conflict { current_fingerprint: Option<String> },
}

/// Durably save a `CanopiFile` to `path`.
///
/// With `expected_fingerprint`, the write happens only while the file on disk
/// still has that fingerprint (a missing file has none); otherwise nothing is
/// written and the current fingerprint is returned. `None` overwrites
/// unconditionally (Save As, or keeping this copy over an outside change). The
/// check and the write run under one write admission for the target.
pub(crate) fn save_to_file(
    path: &Path,
    content: &CanopiFile,
    expected_fingerprint: Option<&str>,
) -> Result<SaveResult, String> {
    let bytes = encode_design(content)?;
    super::with_write_admission(path, || {
        if let Some(expected) = expected_fingerprint {
            let current = super::fingerprint_file(path)
                .map_err(|e| format!("Failed to check {} before saving: {e}", path.display()))?;
            if current.as_deref() != Some(expected) {
                return Ok(SaveResult::Conflict {
                    current_fingerprint: current,
                });
            }
        }
        super::write_file_durably(path, &bytes, "tmp")
            .map_err(|e| format!("Failed to save {}: {e}", path.display()))?;
        Ok(SaveResult::Saved {
            fingerprint: super::fingerprint(&bytes),
        })
    })
}

/// Write a standalone `.canopi` export (a Saved Object Stamp file).
///
/// An export is derived output, not a Design save: it has no fingerprint check
/// and is not recorded as a Recent Design.
pub fn export_to_file(path: &Path, content: &CanopiFile) -> Result<(), String> {
    let bytes = encode_design(content)?;
    super::write_derived_file(path, &bytes)
        .map_err(|e| format!("Failed to export {}: {e}", path.display()))
}

/// Load a `CanopiFile` from disk.
///
/// Refuses files over [`MAX_CANOPI_FILE_BYTES`], parses JSON to a value for
/// strict version admission (only the current format opens, ADR 0021), then
/// deserializes `CanopiFile`. Unknown root fields are preserved in `CanopiFile::extra`.
pub(crate) fn load_from_file(path: &Path) -> Result<CanopiFile, DesignLoadError> {
    Ok(load_with_fingerprint(path)?.0)
}

/// [`load_from_file`] plus the [`super::fingerprint`] of the exact bytes read.
pub(crate) fn load_with_fingerprint(path: &Path) -> Result<(CanopiFile, String), DesignLoadError> {
    let content = read_bounded(path, MAX_CANOPI_FILE_BYTES)?;
    let fingerprint = super::fingerprint(&content);
    let decoded = decode_design_bytes(&content)?;
    Ok((decoded, fingerprint))
}

/// Load a Design only when its file is at most `limit` bytes, with the same
/// admission as [`load_with_fingerprint`]. Recent Design previews read
/// through it so a very large file is skipped rather than parsed.
pub(crate) fn load_within(path: &Path, limit: u64) -> Result<CanopiFile, DesignLoadError> {
    let content = read_bounded(path, limit.min(MAX_CANOPI_FILE_BYTES))?;
    decode_design_bytes(&content)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, DesignLoadError> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|source| DesignLoadError::Read { source })?;
    let length = file
        .metadata()
        .map_err(|source| DesignLoadError::Read { source })?
        .len();
    if length > limit {
        return Err(DesignLoadError::TooLarge { limit });
    }
    let mut content = Vec::new();
    // Read one byte past the limit so a file that grows while it is read is
    // still refused without buffering it whole.
    file.take(limit + 1)
        .read_to_end(&mut content)
        .map_err(|source| DesignLoadError::Read { source })?;
    if content.len() as u64 > limit {
        return Err(DesignLoadError::TooLarge { limit });
    }
    Ok(content)
}

fn decode_design_bytes(content: &[u8]) -> Result<CanopiFile, DesignLoadError> {
    let value: serde_json::Value = serde_json::from_slice(content)
        .map_err(|source| DesignLoadError::InvalidJson { source })?;
    decode_design_value(value).map_err(|source| DesignLoadError::Ingestion { source })
}

/// Version admission, then current-format admission. Canopi 2.0 breaks
/// stored data (ADR 0021): there is no migration ladder, and any version
/// other than the current one is refused as `unsupported_version`.
fn decode_design_value(value: serde_json::Value) -> Result<CanopiFile, CanopiDesignIngestionError> {
    let version = read_design_version(&value)?;
    if version != u64::from(CURRENT_CANOPI_FILE_VERSION) {
        return Err(CanopiDesignIngestionError::unsupported_version(version));
    }
    admit_current_design_value(value)
}

#[expect(
    clippy::expect_used,
    reason = "checked to be an object by `read_design_version`"
)]
fn admit_current_design_value(
    mut value: serde_json::Value,
) -> Result<CanopiFile, CanopiDesignIngestionError> {
    let object = value
        .as_object()
        .expect("checked to be an object by `read_design_version`");
    // `extra` is the in-memory bag for unknown root fields, never a wire key:
    // the canonical encoder writes unknown fields at the root.
    if object.contains_key("extra") {
        return Err(CanopiDesignIngestionError::new(
            CanopiDesignIngestionErrorKind::InvalidDocument,
            "$.extra: reserved root field; unknown fields are stored at the root",
        ));
    }

    value["version"] = serde_json::json!(CURRENT_CANOPI_FILE_VERSION);
    let file: CanopiFile = serde_json::from_value(value).map_err(|error| {
        CanopiDesignIngestionError::new(
            CanopiDesignIngestionErrorKind::InvalidDocument,
            format!("$: {error}"),
        )
    })?;
    validate_design_geometry(&file)
        .and_then(|()| admit_design_identities_and_ranges(&file))
        .and_then(|()| validate_views_and_stories(&file.views, &file.stories))
        .and_then(|()| validate_map_view(file.map_view.as_ref()))
        .map_err(|error| {
            CanopiDesignIngestionError::new(CanopiDesignIngestionErrorKind::InvalidDocument, error)
        })?;
    Ok(file)
}

fn read_design_version(value: &serde_json::Value) -> Result<u64, CanopiDesignIngestionError> {
    let Some(object) = value.as_object() else {
        return Err(CanopiDesignIngestionError::new(
            CanopiDesignIngestionErrorKind::InvalidDocument,
            "$: expected a Canopi Design object",
        ));
    };
    let Some(raw_version) = object.get("version") else {
        return Ok(MISSING_CANOPI_FILE_VERSION as u64);
    };
    let version = raw_version.as_u64().or_else(|| {
        raw_version.as_f64().and_then(|version| {
            (version.is_finite() && version.fract() == 0.0 && version >= 1.0)
                .then_some(version as u64)
        })
    });
    let Some(version) = version else {
        return Err(CanopiDesignIngestionError::new(
            CanopiDesignIngestionErrorKind::InvalidVersion,
            "$.version: expected a positive integer",
        ));
    };
    if version == 0 {
        return Err(CanopiDesignIngestionError::new(
            CanopiDesignIngestionErrorKind::InvalidVersion,
            "$.version: expected a positive integer",
        ));
    }
    Ok(version)
}

/// Compose a new Design from caller-owned identity and generated static defaults.
pub(crate) fn create_new_design(
    name: impl Into<String>,
    timestamp: impl Into<String>,
) -> CanopiFile {
    let timestamp = timestamp.into();
    let layers = NEW_DESIGN_LAYER_DEFAULTS
        .iter()
        .map(|layer| Layer {
            name: layer.name.to_owned(),
            visible: layer.visible,
            locked: layer.locked,
            opacity: layer.opacity,
        })
        .collect();

    CanopiFile {
        lidar: None,
        version: CURRENT_CANOPI_FILE_VERSION,
        name: name.into(),
        description: None,
        plant_species_colors: std::collections::HashMap::new(),
        plant_species_symbols: std::collections::HashMap::new(),
        plant_species_codes: std::collections::HashMap::new(),
        layers,
        plants: Vec::new(),
        zones: Vec::new(),
        annotations: Vec::new(),
        measurement_guides: Vec::new(),
        consortiums: Vec::new(),
        groups: Vec::new(),
        timeline: Vec::new(),
        budget: Vec::new(),
        budget_currency: DEFAULT_BUDGET_CURRENCY.to_owned(),
        views: Vec::new(),
        stories: Vec::new(),
        map_view: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        extra: std::collections::HashMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_scratch::TestScratch;
    use common_types::design::PanelTarget;
    use common_types::views::{SavedViewCamera, SavedViewGroundSize};
    use std::path::PathBuf;

    fn create_default() -> CanopiFile {
        create_new_design("Untitled", "2026-07-02T00:00:00Z")
    }

    #[test]
    fn a_design_that_would_not_reopen_is_refused_before_it_is_written() {
        let mut design = create_default();
        // One description just past the file limit: the encoder must refuse
        // it rather than write a file this build then refuses to load.
        design.description = Some("x".repeat(MAX_CANOPI_FILE_BYTES as usize + 1));
        let error = encode_design(&design).unwrap_err();
        assert!(error.contains("MiB"), "{error}");

        let dir = unique_dir("oversized");
        let path = dir.join("huge.canopi");
        assert!(save_to_file(&path, &design, None).is_err());
        assert!(export_to_file(&path, &design).is_err());
        assert!(!path.exists(), "nothing is written for a refused Design");
    }

    #[test]
    fn shared_canopi_conformance_corpus_matches_native_ingestion() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../common-types/canopi-design-conformance.json"
        ))
        .expect("shared Canopi conformance corpus should be valid JSON");

        assert_eq!(corpus["contract_version"], serde_json::json!(1));
        assert_eq!(
            corpus["facts"],
            serde_json::json!({
                "current_version": CURRENT_CANOPI_FILE_VERSION,
                "missing_version": MISSING_CANOPI_FILE_VERSION,
                "future_version_policy": common_types::design::FUTURE_CANOPI_FILE_VERSION_POLICY,
                "error_kinds": CanopiDesignIngestionErrorKind::ALL
                    .iter()
                    .map(|kind| kind.as_str())
                    .collect::<Vec<_>>(),
            }),
        );

        for case in corpus["cases"]
            .as_array()
            .expect("conformance cases should be an array")
        {
            let id = case["id"].as_str().expect("case id should be a string");
            let input = case["input"].clone();
            if let Some(expected_name) = case.get("accepted").and_then(|value| value.as_str()) {
                let expected = corpus["accepted_documents"][expected_name].clone();
                let file = decode_design_value(input)
                    .unwrap_or_else(|error| panic!("{id}: ingestion failed: {error}"));
                assert_eq!(conformance_document_value(&file), expected, "{id}");
                let wire = serde_json::to_value(file)
                    .expect("accepted Canopi Design should serialize for round trip");
                let round_tripped = decode_design_value(wire)
                    .unwrap_or_else(|error| panic!("{id}: round trip failed: {error}"));
                assert_eq!(
                    conformance_document_value(&round_tripped),
                    expected,
                    "{id}: round trip",
                );
                continue;
            }
            let expected_kind = case["error_kind"].as_str().expect("error case kind");

            let error = match decode_design_value(input) {
                Ok(_) => panic!("{id}: expected ingestion to fail"),
                Err(error) => error,
            };
            assert_eq!(error.kind.as_str(), expected_kind, "{id}");
            // serde reports a shape error at the root without its path; the
            // corpus names that as `native_error_path` (canopi-cyqd shares
            // the validators in 2.1).
            let expected_path = case
                .get("native_error_path")
                .or_else(|| case.get("error_path"))
                .and_then(|value| value.as_str())
                .unwrap_or_else(|| panic!("{id}: every refusal case names its path"));
            let path = error
                .message
                .split_once(": ")
                .map_or(error.message.as_str(), |(path, _)| path);
            assert_eq!(path, expected_path, "{id}: {}", error.message);
        }
    }

    fn conformance_document_value(file: &CanopiFile) -> serde_json::Value {
        let mut wire = serde_json::to_value(file).expect("normalized Design should serialize");
        let object = wire
            .as_object_mut()
            .expect("normalized Design should serialize as an object");
        let known = common_types::design::DESIGN_FILE_FIELDS
            .iter()
            .map(|field| field.key)
            .filter(|key| *key != "extra")
            .collect::<std::collections::HashSet<_>>();
        let mut extra = serde_json::Map::new();
        for key in object
            .keys()
            .filter(|key| !known.contains(key.as_str()))
            .cloned()
            .collect::<Vec<_>>()
        {
            let value = object.remove(&key).expect("collected key should exist");
            extra.insert(key, value);
        }
        object.insert("extra".to_owned(), serde_json::Value::Object(extra));
        wire
    }

    fn owned_sidecars(dir: &Path, role: &str) -> Vec<PathBuf> {
        let suffix = format!(".{role}");
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    return false;
                };
                name.starts_with(".canopi-") && name.ends_with(&suffix)
            })
            .collect()
    }

    #[test]
    fn test_create_default_has_four_layers() {
        let design = create_default();
        assert_eq!(design.version, CURRENT_CANOPI_FILE_VERSION);
        assert_eq!(design.name, "Untitled");
        assert_eq!(design.layers.len(), 4);
        assert!(design.measurement_guides.is_empty());
    }

    #[test]
    fn new_design_uses_caller_identity_and_fresh_layer_records() {
        let mut first = create_new_design("First Design", "2026-07-02T00:00:00Z");
        let second = create_new_design("Second Design", "2026-07-03T00:00:00Z");

        assert_eq!(first.name, "First Design");
        assert_eq!(first.created_at, "2026-07-02T00:00:00Z");
        assert_eq!(first.updated_at, "2026-07-02T00:00:00Z");
        assert_eq!(second.name, "Second Design");
        assert_eq!(second.created_at, "2026-07-03T00:00:00Z");
        first.layers[0].name = "changed".to_owned();
        assert_eq!(second.layers[0].name, "zones");
    }

    #[test]
    fn test_create_default_layer_visibility() {
        let design = create_default();
        let by_name: std::collections::HashMap<_, _> = design
            .layers
            .iter()
            .map(|l| (l.name.as_str(), l.visible))
            .collect();
        assert_eq!(
            by_name,
            std::collections::HashMap::from([
                ("zones", true),
                ("plants", true),
                ("measurement-guides", true),
                ("annotations", true),
            ]),
        );
    }

    #[test]
    fn test_save_and_load_round_trip() {
        let dir = unique_dir("round_trip");
        let path: PathBuf = dir.join("canopi_test_round_trip.canopi");

        let original = create_default();
        save_to_file(&path, &original, None).expect("save should succeed");
        assert!(path.exists());

        let loaded = load_from_file(&path).expect("load should succeed");
        assert_eq!(loaded.name, original.name);
        assert_eq!(loaded.version, original.version);
        assert_eq!(loaded.layers.len(), 4);

        // Clean up
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn save_waits_for_existing_target_admission() {
        use std::sync::mpsc;
        use std::time::Duration;

        let dir = unique_dir("save_admission");
        let path = dir.join("garden.canopi");
        let initial = create_default();
        std::fs::write(&path, serde_json::to_string_pretty(&initial).unwrap()).unwrap();

        let mut replacement = create_default();
        replacement.name = "Admitted replacement".to_owned();
        let writer_path = path.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let writer = crate::design::with_write_admission(&path, || {
            let writer = std::thread::spawn(move || {
                started_tx.send(()).unwrap();
                finished_tx
                    .send(save_to_file(&writer_path, &replacement, None))
                    .unwrap();
            });
            started_rx.recv().unwrap();
            assert!(
                finished_rx
                    .recv_timeout(Duration::from_millis(250))
                    .is_err(),
                "save completed while another operation held target admission"
            );
            writer
        });

        finished_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("save should complete after target admission is released")
            .expect("save should succeed");
        writer.join().unwrap();
        assert_eq!(load_from_file(&path).unwrap().name, "Admitted replacement");
    }

    #[test]
    fn concurrent_saves_leave_one_complete_design() {
        use std::sync::{Arc, Barrier};

        let dir = unique_dir("concurrent_saves");
        let path = dir.join("garden.canopi");
        let mut initial = create_default();
        initial.name = "Initial".to_owned();
        save_to_file(&path, &initial, None).unwrap();

        let writer_count = 8;
        let barrier = Arc::new(Barrier::new(writer_count + 1));
        let mut writers = Vec::new();
        let mut expected_names = std::collections::HashSet::new();
        for index in 0..writer_count {
            let name = format!("Concurrent {index}");
            expected_names.insert(name.clone());
            let mut design = create_default();
            design.name = name;
            let writer_path = path.clone();
            let writer_barrier = Arc::clone(&barrier);
            writers.push(std::thread::spawn(move || {
                writer_barrier.wait();
                save_to_file(&writer_path, &design, None)
            }));
        }
        barrier.wait();
        for writer in writers {
            writer.join().unwrap().unwrap();
        }

        let final_design = load_from_file(&path).unwrap();
        assert!(expected_names.contains(&final_design.name));
        assert!(
            owned_sidecars(&dir, "tmp").is_empty(),
            "concurrent saves must not leak owned temporary sidecars"
        );
        assert!(
            owned_sidecars(&dir, "old").is_empty(),
            "concurrent saves must not leak owned rollback sidecars"
        );
    }

    #[test]
    fn test_atomic_write_creates_tmp_then_final() {
        let dir = unique_dir("atomic_save");
        let path: PathBuf = dir.join("garden.canopi");

        let design = create_default();
        save_to_file(&path, &design, None).expect("save should succeed");

        assert!(path.exists(), "final file should exist");
        assert!(
            owned_sidecars(&dir, "tmp").is_empty(),
            "successful save must not leak an owned temporary sidecar"
        );
        assert!(
            owned_sidecars(&dir, "old").is_empty(),
            "successful save must not leak an owned rollback sidecar"
        );
    }

    #[test]
    fn save_does_not_claim_an_existing_legacy_temp_sidecar() {
        let dir = unique_dir("owned_save_temp");
        let path = dir.join("garden.canopi");
        let legacy_tmp = path.with_extension("canopi.tmp");
        std::fs::write(&legacy_tmp, "another operation owns this").unwrap();

        save_to_file(&path, &create_default(), None).expect("save should succeed");

        assert_eq!(
            std::fs::read_to_string(&legacy_tmp).unwrap(),
            "another operation owns this"
        );
        assert!(load_from_file(&path).is_ok());
    }

    #[test]
    fn test_extra_fields_preserved_on_round_trip() {
        use serde_json::json;

        let dir = unique_dir("extra");
        let path: PathBuf = dir.join("canopi_test_extra.canopi");

        // Build a design with an unknown future field injected at JSON level.
        let mut design = create_default();
        design
            .extra
            .insert("future_field".into(), json!("from_future"));

        save_to_file(&path, &design, None).expect("save");
        let loaded = load_from_file(&path).expect("load");

        assert_eq!(
            loaded.extra.get("future_field").and_then(|v| v.as_str()),
            Some("from_future"),
            "unknown fields should survive round-trip"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    #[expect(
        clippy::too_many_lines,
        reason = "ratcheted before 2.1-M188; split when this function next changes"
    )]
    fn geolocated_objects_panel_sections_and_unknown_fields_round_trip() {
        use serde_json::json;

        let dir = unique_dir("geolocated_round_trip");
        let path: PathBuf = dir.join("canopi_test_geolocated_round_trip.canopi");

        let mut value = serde_json::to_value(create_default()).expect("default design serializes");
        value["plants"] = json!([{
            "id": "plant-1",
            "canonical_name": "Quercus robur",
            "position": { "lon": 2.352_212_345_6, "lat": 48.856_612_345_6 }
        }]);
        value["zones"] = json!([{
            "id": "zone-north",
            "name": "North bed",
            "zone_type": "rect",
            "points": [
                { "lon": 2.3522, "lat": 48.8567 },
                { "lon": 2.3523, "lat": 48.8566 }
            ],
            "rotation": 30.0
        }]);
        value["measurement_guides"] = json!([{
            "id": "guide-1",
            "start": { "lon": -180.0, "lat": -85.0511287798066 },
            "end": { "lon": 180.0, "lat": 85.0511287798066 }
        }]);
        value["future_panel_field"] = json!({ "preserve": true });
        value["consortiums"] = json!([
            {
                "target": { "kind": "species", "canonical_name": "Quercus robur" },
                "stratum": "high",
                "start_phase": 0,
                "end_phase": 3
            }
        ]);
        value["timeline"] = json!([
            {
                "id": "task-1",
                "action_type": "planting",
                "description": "Plant oak",
                "start_date": "2026-04-01",
                "end_date": "2026-04-02",
                "recurrence": null,
                "targets": [
                    { "kind": "species", "canonical_name": "Quercus robur" },
                    { "kind": "zone", "zone_id": "zone-north" }
                ],
                "depends_on": null,
                "completed": false,
                "order": 0
            }
        ]);
        value["budget"] = json!([
            {
                "target": { "kind": "species", "canonical_name": "Quercus robur" },
                "category": "plants",
                "description": "English oak",
                "quantity": 1,
                "unit_cost": 25,
                "currency": "EUR"
            }
        ]);

        std::fs::write(&path, serde_json::to_string_pretty(&value).unwrap())
            .expect("write current-version file");
        let loaded = load_from_file(&path).expect("current-version file should load");
        save_to_file(&path, &loaded, None).expect("current-version file should save");
        let reloaded = load_from_file(&path).expect("saved file should reload");

        assert_eq!(reloaded.version, CURRENT_CANOPI_FILE_VERSION);
        let reloaded_value = serde_json::to_value(&reloaded).expect("reloaded design serializes");
        assert_eq!(
            reloaded_value["plants"][0]["position"],
            value["plants"][0]["position"]
        );
        assert_eq!(
            reloaded_value["zones"][0]["points"],
            value["zones"][0]["points"]
        );
        assert_eq!(reloaded_value["zones"][0]["rotation"], json!(30.0));
        assert_eq!(reloaded_value["zones"][0]["id"], json!("zone-north"));
        assert_eq!(reloaded_value["zones"][0]["name"], json!("North bed"));
        assert_eq!(
            reloaded_value["timeline"][0]["targets"][1],
            json!({ "kind": "zone", "zone_id": "zone-north" })
        );
        assert_eq!(
            reloaded_value["measurement_guides"][0]["start"],
            value["measurement_guides"][0]["start"]
        );
        assert_eq!(
            reloaded_value["measurement_guides"][0]["end"],
            value["measurement_guides"][0]["end"]
        );
        assert!(reloaded_value.get("spatial_frame").is_none());
        assert_eq!(reloaded.consortiums.len(), 1);
        assert_eq!(reloaded.timeline.len(), 1);
        assert_eq!(reloaded.timeline[0].targets.len(), 2);
        assert!(matches!(
            reloaded.timeline[0].targets[0],
            PanelTarget::Species { .. }
        ));
        assert_eq!(reloaded.budget.len(), 1);
        assert!(matches!(
            reloaded.budget[0].target,
            PanelTarget::Species { .. }
        ));
        assert_eq!(
            reloaded
                .extra
                .get("future_panel_field")
                .and_then(|field| field.get("preserve"))
                .and_then(|preserve| preserve.as_bool()),
            Some(true),
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_budget_currency_is_a_named_defaulted_field() {
        use serde_json::json;

        let mut value = serde_json::to_value(create_default()).expect("serialize");
        value["budget_currency"] = json!("USD");

        let loaded: CanopiFile = serde_json::from_value(value).expect("deserialize");
        assert_eq!(loaded.budget_currency, "USD");
        assert!(!loaded.extra.contains_key("budget_currency"));

        let mut without_currency = serde_json::to_value(create_default()).expect("serialize");
        without_currency
            .as_object_mut()
            .expect("default design serializes to object")
            .remove("budget_currency");

        let defaulted: CanopiFile =
            serde_json::from_value(without_currency).expect("budget_currency is optional");
        assert_eq!(defaulted.budget_currency, DEFAULT_BUDGET_CURRENCY);
    }

    fn unique_dir(label: &str) -> TestScratch {
        TestScratch::new(&format!("format-{label}"))
    }

    #[test]
    fn a_root_extra_key_is_refused_not_flattened() {
        let mut value = serde_json::to_value(create_default()).expect("serialize");
        value["extra"] = serde_json::json!({ "future_field": true });

        let error = decode_design_value(value).expect_err("root extra must be refused");

        assert_eq!(error.kind, CanopiDesignIngestionErrorKind::InvalidDocument);
        assert!(error.message.starts_with("$.extra:"), "{error}");
    }

    /// Canopi 2.0 breaks stored data (ADR 0021): the 2.0 previews' formats
    /// (v7, v8) are refused as older, with the message naming the one
    /// version this build opens, and nothing is upgraded in memory.
    #[test]
    fn designs_written_before_2_0_are_refused_as_older() {
        for version in [
            CURRENT_CANOPI_FILE_VERSION - 2,
            CURRENT_CANOPI_FILE_VERSION - 1,
        ] {
            let mut value = serde_json::to_value(create_default()).expect("serialize");
            value["version"] = serde_json::json!(version);

            let error = decode_design_value(value).expect_err("an earlier format is refused");

            assert_eq!(
                error.kind,
                CanopiDesignIngestionErrorKind::UnsupportedVersion
            );
            assert!(error.is_older_than_supported(), "v{version}");
            assert_eq!(
                error.message,
                format!(
                    "$.version: unsupported Canopi Design version {version}; Canopi 2.0 and later open only version {CURRENT_CANOPI_FILE_VERSION}"
                ),
            );
        }
    }

    #[test]
    fn a_newer_version_is_refused_and_told_apart_from_an_older_one() {
        let mut value = serde_json::to_value(create_default()).expect("serialize");
        value["version"] = serde_json::json!(CURRENT_CANOPI_FILE_VERSION + 1);

        let error = decode_design_value(value).expect_err("newer Designs are refused");

        assert_eq!(
            error.kind,
            CanopiDesignIngestionErrorKind::UnsupportedVersion
        );
        assert!(!error.is_older_than_supported());
    }

    /// A Canopi 1.2 file (format v6, local metres under a `spatial_frame`) is
    /// below the floor: it is refused as an older version, never as damaged,
    /// and nothing about it is read past its version.
    #[test]
    fn a_canopi_1_2_design_is_refused_as_an_older_version() {
        let dir = unique_dir("older_version");
        let path = dir.join("canopi-1.2.canopi");
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&serde_json::json!({
                "version": 6,
                "spatial_frame": {
                    "anchor_longitude_deg": 2.3522,
                    "anchor_latitude_deg": 48.8566,
                    "north_bearing_deg": 0.0,
                    "placement_status": "confirmed"
                },
                "name": "Canopi 1.2 garden",
                "plant_species_colors": {},
                "layers": [],
                "plants": [{
                    "id": "plant-1",
                    "canonical_name": "Malus domestica",
                    "position": { "x": 10.0, "y": -10.0 }
                }],
                "zones": [],
                "created_at": "2026-07-15T00:00:00.000Z",
                "updated_at": "2026-07-15T00:00:00.000Z"
            }))
            .unwrap(),
        )
        .unwrap();

        let error = load_from_file(&path).expect_err("a v6 Design is below the floor");
        let failure = error.failure();
        assert_eq!(failure.kind, DesignLoadFailureKind::OlderVersion);
        assert!(
            failure
                .message
                .contains("unsupported Canopi Design version 6"),
            "{}",
            failure.message
        );
        assert!(
            !failure.message.contains("canopi-1.2"),
            "no paths: {}",
            failure.message
        );
        assert!(load_with_fingerprint(&path).is_err());
    }

    /// Open the user's own Designs: every `.canopi` in
    /// `CANOPI_REAL_DESIGNS_DIR` either opens at the current version or is
    /// refused as older (ADR 0021). Run with `--ignored`; the files are
    /// private and never enter the repository.
    #[test]
    #[ignore = "local fixture: the user's Designs in CANOPI_REAL_DESIGNS_DIR"]
    fn real_designs_open_or_are_refused_as_older() {
        let Ok(dir) = std::env::var("CANOPI_REAL_DESIGNS_DIR") else {
            panic!("set CANOPI_REAL_DESIGNS_DIR");
        };
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("canopi") {
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            match load_from_file(&path) {
                Ok(file) => {
                    assert_eq!(file.version, CURRENT_CANOPI_FILE_VERSION, "{name}");
                    eprintln!(
                        "{name}: opens with {} plants, {} zones",
                        file.plants.len(),
                        file.zones.len()
                    );
                }
                Err(error) => {
                    assert_eq!(
                        error.failure().kind,
                        DesignLoadFailureKind::OlderVersion,
                        "{name}: {error}"
                    );
                    eprintln!("{name}: refused as older");
                }
            }
            checked += 1;
        }
        assert!(checked > 0, "no Designs found in {dir}");
    }

    #[test]
    fn load_failures_name_a_kind_and_never_the_path() {
        let dir = unique_dir("failures");
        let missing = dir.join("missing.canopi");
        let error = load_from_file(&missing).expect_err("missing file");
        assert_eq!(error.failure().kind, DesignLoadFailureKind::Missing);
        assert!(!error.to_string().contains("missing.canopi"), "{error}");

        let garbage = dir.join("garbage.canopi");
        std::fs::write(&garbage, "not json").unwrap();
        assert_eq!(
            load_from_file(&garbage).unwrap_err().failure().kind,
            DesignLoadFailureKind::InvalidJson
        );

        let invalid = dir.join("invalid.canopi");
        std::fs::write(&invalid, r#"{"version": 9, "plants": 3}"#).unwrap();
        assert_eq!(
            load_from_file(&invalid).unwrap_err().failure().kind,
            DesignLoadFailureKind::InvalidDocument
        );

        let old = dir.join("old.canopi");
        std::fs::write(&old, r#"{"version": 4, "name": "Canopi 1.1"}"#).unwrap();
        let error = load_from_file(&old).unwrap_err();
        assert_eq!(error.failure().kind, DesignLoadFailureKind::OlderVersion);
        assert!(!error.failure().message.contains("old.canopi"));

        let newer = dir.join("newer.canopi");
        std::fs::write(&newer, r#"{"version": 99, "name": "Next"}"#).unwrap();
        assert_eq!(
            load_from_file(&newer).unwrap_err().failure().kind,
            DesignLoadFailureKind::NewerVersion
        );

        let folder = dir.join("folder.canopi");
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(
            load_from_file(&folder).unwrap_err().failure().kind,
            DesignLoadFailureKind::Unreadable
        );
    }

    fn with_views_and_stories() -> CanopiFile {
        let mut value = serde_json::to_value(create_default()).expect("serialize");
        value["views"] = serde_json::json!([{
            "id": "view-1",
            "name": "Berry hedges",
            "camera": {
                "lon": 2.294_481_234_5, "lat": 48.858_370_123_4, "zoom": 19.25, "bearing": 0.0,
                "ground_size_m": { "width": 312.5, "height": 187.5 }
            },
            "visible_layers": {
                "background": { "kind": "satellite" },
                "terrain": { "contours": false, "hillshade": false },
                "scene_layers": ["plants", "zones"],
                "site_data": []
            },
            "highlighted": {
                "species": ["Lycium barbarum"],
                "objects": [{ "kind": "zone", "id": "Hedge" }]
            },
            "title": "Berry hedges",
            "text": []
        }]);
        value["stories"] = serde_json::json!([{
            "id": "story-1",
            "name": "Client visit",
            "steps": [{
                "id": "step-1",
                "view_id": "view-1",
                "title": "Berry hedges",
                "text": [{ "kind": "paragraph", "spans": [
                    { "text": "Two hedges", "bold": true, "italic": false, "link": null }
                ] }],
                "images": [{ "src": "https://example.org/hedge.jpg", "alt": "Hedge" }]
            }]
        }]);
        decode_design_value(value).expect("views and stories should be admitted")
    }

    #[test]
    fn views_and_stories_save_byte_identically_when_unchanged() {
        let dir = unique_dir("views_round_trip");
        let path = dir.join("stories.canopi");
        let bytes = encode_design(&with_views_and_stories()).expect("encode");
        std::fs::write(&path, &bytes).unwrap();

        let loaded = load_from_file(&path).expect("load");
        save_to_file(&path, &loaded, None).expect("save");

        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(loaded.views[0].camera.lon, 2.294_481_234_5);
        assert_eq!(loaded.stories[0].steps[0].view_id, "view-1");
    }

    fn map_view_value() -> serde_json::Value {
        serde_json::json!({
            "lon": 2.294_481_234_5,
            "lat": 48.858_370_123_4,
            "zoom": 19.25,
            "bearing": 30.5,
            "ground_size_m": { "width": 312.5, "height": 187.5 }
        })
    }

    fn resaved_bytes(dir: &Path, name: &str, bytes: &[u8]) -> (CanopiFile, Vec<u8>) {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        let loaded = load_from_file(&path).expect("load");
        save_to_file(&path, &loaded, None).expect("save");
        (loaded, std::fs::read(&path).unwrap())
    }

    #[test]
    fn a_design_saves_its_map_view_and_one_without_it_saves_byte_identically() {
        let dir = unique_dir("map_view_round_trip");

        let plain = encode_design(&create_default()).expect("encode");
        assert!(!String::from_utf8_lossy(&plain).contains("map_view"));
        let (loaded, resaved) = resaved_bytes(&dir, "plain.canopi", &plain);
        assert_eq!(loaded.map_view, None);
        assert_eq!(resaved, plain, "a Design without the field stays as it was");

        let mut value = serde_json::to_value(create_default()).expect("serialize");
        value["map_view"] = map_view_value();
        let design = decode_design_value(value).expect("a saved map view is admitted");
        assert_eq!(
            design.map_view,
            Some(SavedViewCamera {
                lon: 2.294_481_234_5,
                lat: 48.858_370_123_4,
                zoom: 19.25,
                bearing: 30.5,
                ground_size_m: SavedViewGroundSize {
                    width: 312.5,
                    height: 187.5,
                },
            })
        );
        assert!(
            design.extra.is_empty(),
            "map_view is a known field, not extra"
        );
        let bytes = encode_design(&design).expect("encode");
        let (loaded, resaved) = resaved_bytes(&dir, "viewed.canopi", &bytes);
        assert_eq!(loaded.map_view, design.map_view);
        assert_eq!(resaved, bytes);
        assert_eq!(loaded.version, CURRENT_CANOPI_FILE_VERSION);
    }

    #[test]
    fn an_invalid_map_view_is_refused_at_its_path() {
        for (field, invalid, path) in [
            ("zoom", serde_json::json!(27.5), "$.map_view: "),
            ("bearing", serde_json::json!(361.0), "$.map_view: "),
            ("lat", serde_json::json!(86.0), "$.map_view: "),
            ("ground_size_m", serde_json::Value::Null, "$: "),
            (
                "ground_size_m",
                serde_json::json!({ "width": 0.0, "height": 187.5 }),
                "$.map_view.ground_size_m: ",
            ),
        ] {
            let mut value = serde_json::to_value(create_default()).expect("serialize");
            value["map_view"] = map_view_value();
            value["map_view"][field] = invalid;

            let error = decode_design_value(value).expect_err("an invalid map view is refused");

            assert_eq!(error.kind, CanopiDesignIngestionErrorKind::InvalidDocument);
            assert!(error.message.starts_with(path), "{field}: {error}");
        }
    }

    #[test]
    fn a_story_step_without_its_saved_view_is_refused() {
        let mut value = serde_json::to_value(with_views_and_stories()).expect("serialize");
        value["views"] = serde_json::json!([]);

        let error = decode_design_value(value).expect_err("dangling step must be refused");

        assert_eq!(error.kind, CanopiDesignIngestionErrorKind::InvalidDocument);
        assert!(
            error.message.starts_with("$.stories[0].steps[0].view_id"),
            "{error}"
        );
    }

    #[test]
    fn opening_a_design_over_the_size_limit_is_refused() {
        let dir = unique_dir("too_large");
        let path = dir.join("huge.canopi");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_CANOPI_FILE_BYTES + 1).unwrap();
        drop(file);

        let error = load_from_file(&path).expect_err("oversized Design must be refused");

        assert!(matches!(error, DesignLoadError::TooLarge { .. }), "{error}");
        assert!(error.to_string().contains("64 MiB"), "{error}");
    }

    #[test]
    fn export_writes_a_loadable_design_without_leaving_a_temporary() {
        let dir = unique_dir("export");
        let path = dir.join("stamp.canopi");
        std::fs::write(&path, "an earlier export").unwrap();

        export_to_file(&path, &create_default()).expect("export should succeed");

        assert_eq!(load_from_file(&path).unwrap().name, "Untitled");
        assert!(owned_sidecars(&dir, "export").is_empty());
    }

    fn named(name: &str) -> CanopiFile {
        let mut design = create_default();
        design.name = name.to_owned();
        design
    }

    fn saved_fingerprint(result: SaveResult) -> String {
        match result {
            SaveResult::Saved { fingerprint } => fingerprint,
            SaveResult::Conflict { .. } => panic!("expected the save to be written"),
        }
    }

    /// A folder the user can write into but not list: the Design is renamed
    /// into place, but the parent directory cannot be opened to sync it.
    #[cfg(unix)]
    #[test]
    fn a_save_whose_directory_sync_fails_after_the_replace_is_still_saved() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = unique_dir("unlistable");
        let folder = dir.join("write-only");
        std::fs::create_dir(&folder).unwrap();
        let path = folder.join("garden.canopi");
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o333)).unwrap();
        let restore =
            || std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
        if std::fs::File::open(&folder).is_ok() {
            // Running with privileges that bypass directory permissions.
            restore();
            return;
        }

        let first = save_to_file(&path, &named("Garden"), None);
        let second = first
            .as_ref()
            .ok()
            .and_then(|result| match result {
                SaveResult::Saved { fingerprint } => Some(fingerprint.clone()),
                SaveResult::Conflict { .. } => None,
            })
            .map(|fingerprint| save_to_file(&path, &named("Garden 2"), Some(&fingerprint)));
        let on_disk = std::fs::read(&path);
        restore();

        let saved = saved_fingerprint(first.expect("a replaced Design is a successful save"));
        // The next continuous save with that fingerprint writes, not conflicts,
        // and reports the fingerprint of the bytes now on disk.
        let next = saved_fingerprint(
            second
                .expect("the first save returned its fingerprint")
                .expect("the next save succeeds"),
        );
        assert_ne!(next, saved);
        assert_eq!(next, crate::design::fingerprint(&on_disk.unwrap()));
    }

    #[test]
    fn saved_and_loaded_fingerprints_are_the_sha256_of_the_file_bytes() {
        let dir = unique_dir("fingerprint");
        let path = dir.join("garden.canopi");

        let saved = saved_fingerprint(save_to_file(&path, &named("Garden"), None).unwrap());
        let (loaded, loaded_fingerprint) = load_with_fingerprint(&path).unwrap();

        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(saved, crate::design::fingerprint(&bytes));
        assert_eq!(loaded_fingerprint, saved);
        assert_eq!(saved.len(), 64);
        assert!(
            saved
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        );
        assert_eq!(loaded.name, "Garden");
    }

    #[test]
    fn a_save_expecting_the_current_fingerprint_writes_and_returns_the_next_one() {
        let dir = unique_dir("fingerprint_match");
        let path = dir.join("garden.canopi");
        let first = saved_fingerprint(save_to_file(&path, &named("First"), None).unwrap());

        let second =
            saved_fingerprint(save_to_file(&path, &named("Second"), Some(&first)).unwrap());

        assert_ne!(second, first);
        assert_eq!(load_from_file(&path).unwrap().name, "Second");
        let third = saved_fingerprint(save_to_file(&path, &named("Third"), Some(&second)).unwrap());
        assert_eq!(load_with_fingerprint(&path).unwrap().1, third);
        let entries = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(entries, 1, "a save leaves only the Design file, no backup");
    }

    #[test]
    fn a_save_after_an_outside_change_is_a_conflict_and_writes_nothing() {
        let dir = unique_dir("fingerprint_conflict");
        let path = dir.join("garden.canopi");
        let opened = saved_fingerprint(save_to_file(&path, &named("Mine"), None).unwrap());
        std::fs::write(&path, "changed by another program").unwrap();

        let result = save_to_file(&path, &named("Mine, edited"), Some(&opened)).unwrap();

        assert_eq!(
            result,
            SaveResult::Conflict {
                current_fingerprint: Some(crate::design::fingerprint(
                    b"changed by another program"
                )),
            }
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "changed by another program"
        );
    }

    #[test]
    fn a_save_expecting_a_deleted_file_is_a_conflict_and_does_not_recreate_it() {
        let dir = unique_dir("fingerprint_deleted");
        let path = dir.join("garden.canopi");
        let opened = saved_fingerprint(save_to_file(&path, &named("Mine"), None).unwrap());
        std::fs::remove_file(&path).unwrap();

        let result = save_to_file(&path, &named("Mine"), Some(&opened)).unwrap();

        assert_eq!(
            result,
            SaveResult::Conflict {
                current_fingerprint: None
            }
        );
        assert!(!path.exists());
    }

    #[test]
    fn a_save_without_an_expected_fingerprint_overwrites_an_outside_change() {
        let dir = unique_dir("fingerprint_overwrite");
        let path = dir.join("garden.canopi");
        std::fs::write(&path, "changed by another program").unwrap();

        let fingerprint =
            saved_fingerprint(save_to_file(&path, &named("Keep mine"), None).unwrap());

        let (loaded, loaded_fingerprint) = load_with_fingerprint(&path).unwrap();
        assert_eq!(loaded.name, "Keep mine");
        assert_eq!(loaded_fingerprint, fingerprint);
    }

    #[test]
    fn a_save_that_cannot_check_the_target_fails_without_writing() {
        let dir = unique_dir("fingerprint_unreadable");
        // A directory at the target cannot be read as a file.
        let path = dir.join("garden.canopi");
        std::fs::create_dir(&path).unwrap();

        let result = save_to_file(&path, &named("Mine"), Some("0"));

        assert!(result.is_err(), "{result:?}");
        assert!(path.is_dir());
        assert!(owned_sidecars(&dir, "tmp").is_empty());
    }
}
