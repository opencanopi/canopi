use canopi_types::design::field_path::{FieldPath, Refusal};
use canopi_types::design::v10::FormatLoadRefusalKind;
use canopi_types::design::{
    CURRENT_CANOPI_FILE_VERSION, CanopiDesignIngestionErrorKind, CanopiFile,
    DEFAULT_BUDGET_CURRENCY, DesignLoadFailure, DesignLoadFailureKind, Layer, LoadedDesign,
    MISSING_CANOPI_FILE_VERSION,
};
use std::fmt;
use std::path::Path;

use super::new_design_defaults::NEW_DESIGN_LAYER_DEFAULTS;

/// A refused Design: its kind, and the typed refusal naming the field (canopi-cyqd).
#[derive(Debug)]
pub(crate) struct CanopiDesignIngestionError {
    kind: CanopiDesignIngestionErrorKind,
    refusal: Refusal,
    /// The file's version when it is one this build does not open.
    unsupported_version: Option<u64>,
}

impl CanopiDesignIngestionError {
    fn new(kind: CanopiDesignIngestionErrorKind, refusal: Refusal) -> Self {
        Self {
            kind,
            refusal,
            unsupported_version: None,
        }
    }

    fn invalid(field_path: FieldPath, expected: &str) -> Self {
        let kind = CanopiDesignIngestionErrorKind::InvalidDocument;
        Self::new(kind, Refusal::new(field_path, expected))
    }

    fn unsupported_version(version: u64) -> Self {
        let expected = format!(
            "unsupported Canopi Design version {version}; Canopi 2.0 and later open only version {CURRENT_CANOPI_FILE_VERSION}",
        );
        let refusal = Refusal::new(FieldPath::root().field("version"), expected);
        Self {
            unsupported_version: Some(version),
            ..Self::new(CanopiDesignIngestionErrorKind::UnsupportedVersion, refusal)
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
        write!(formatter, "{}: {}", self.kind.as_str(), self.refusal)
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

/// A Design as it opens (2.1-Q347: from 2.1.0, newer Designs are refused unchanged,
/// never opened read-only).
#[derive(Debug, serde::Serialize)]
#[serde(untagged)]
pub enum OpenedDesign<T> {
    /// This build's format (v9 migrated or v10), to edit.
    Editable(T),
}

impl OpenedDesign<LoadedDesign> {
    /// The Design's name as saved, for Recent Designs.
    pub(crate) fn name(&self) -> &str {
        match self {
            Self::Editable(loaded) => &loaded.file.name,
        }
    }
}

#[cfg(test)]
impl<T> OpenedDesign<T> {
    /// The Design opened to edit; a test that expects this build's format.
    pub(crate) fn editable(self) -> T {
        match self {
            Self::Editable(design) => design,
        }
    }
}

impl DesignLoadError {
    pub(crate) fn failure(&self) -> DesignLoadFailure {
        // The refused field, when the file parsed as JSON and the Design was refused.
        let field_path = match self {
            Self::Ingestion { source } => Some(source.refusal.field_path.clone()),
            _ => None,
        };
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
            field_path,
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

/// Encode a Design as canonical v10 `.canopi` wire bytes through `canopi-format`
/// (2b-5, 2.1-M156, 2.1-M539): the one encoder for saves, drafts and exports.
/// Refuses an encoding over [`MAX_CANOPI_FILE_BYTES`] or failing v10 write admission.
pub(crate) fn encode_design(content: &CanopiFile) -> Result<Vec<u8>, String> {
    let v10 = canopi_file_to_v10_value(content)?;
    match canopi_format::core::encode_design(&v10) {
        Ok(bytes) => Ok(bytes),
        Err(refusal) if refusal.kind == FormatLoadRefusalKind::TooLarge => Err(format!(
            "The Design is larger than the {} MiB a Design file may hold; remove some story images or objects before saving",
            MAX_CANOPI_FILE_BYTES / (1024 * 1024)
        )),
        Err(refusal) => Err(format!("Failed to encode Design: {}", refusal.message)),
    }
}

/// Result of [`save_to_file`].
#[cfg(test)]
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
#[cfg(test)]
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

/// Load a `CanopiFile` from disk to use its content, as a stamp or template import does.
///
/// Refuses files over [`MAX_CANOPI_FILE_BYTES`], parses JSON to a value for
/// strict version admission (only the current format, ADR 0021; a newer Design too, whose
/// read-only view is never imported, 2.1-M478), then deserializes `CanopiFile`. Unknown
/// root fields are preserved in `CanopiFile::extra`.
pub(crate) fn load_from_file(path: &Path) -> Result<CanopiFile, DesignLoadError> {
    decode_design_bytes(&read_bounded(path, MAX_CANOPI_FILE_BYTES)?)
}

/// Open a Design to show it: this build's format with the [`super::fingerprint`] of the
/// exact bytes read, or a newer one read-only ([`open_within`]).
pub(crate) fn open_with_fingerprint(
    path: &Path,
) -> Result<OpenedDesign<LoadedDesign>, DesignLoadError> {
    let content = read_bounded(path, MAX_CANOPI_FILE_BYTES)?;
    let fingerprint = super::fingerprint(&content);
    Ok(match open_design_bytes(&content)? {
        OpenedDesign::Editable(file) => OpenedDesign::Editable(LoadedDesign { file, fingerprint }),
    })
}

/// Open a Design only when its file is at most `limit` bytes: the current format admitted as
/// [`load_from_file`] admits it, a version of 10 or later read for the read-only view.
/// Drafts and Recent Design previews open through it, a preview skipping a very large file.
pub(crate) fn open_within(
    path: &Path,
    limit: u64,
) -> Result<OpenedDesign<CanopiFile>, DesignLoadError> {
    open_design_bytes(&read_bounded(path, limit.min(MAX_CANOPI_FILE_BYTES))?)
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

/// Open `.canopi` bytes through the single `canopi-format` v10 Format Core (2b-5; 2.1-Q347):
/// v9 migrates in place to v10, v10 opens directly, v1..v8 refuse as older, v11+ refuse as newer.
pub(crate) fn open_design_bytes(
    content: &[u8],
) -> Result<OpenedDesign<CanopiFile>, DesignLoadError> {
    decode_design_bytes(content).map(OpenedDesign::Editable)
}

fn decode_design_bytes(content: &[u8]) -> Result<CanopiFile, DesignLoadError> {
    let value: serde_json::Value = serde_json::from_slice(content)
        .map_err(|source| DesignLoadError::InvalidJson { source })?;
    decode_design_value(value).map_err(|source| DesignLoadError::Ingestion { source })
}

/// Decode a parsed JSON `.canopi` value through `canopi_format::core::decode_design_value`
/// and project the admitted v10 Design onto [`CanopiFile`].
fn decode_design_value(value: serde_json::Value) -> Result<CanopiFile, CanopiDesignIngestionError> {
    let version = read_design_version(&value)?;
    if version < u64::from(canopi_format::chain::CANOPI_FLOOR)
        || version > u64::from(CURRENT_CANOPI_FILE_VERSION)
    {
        return Err(CanopiDesignIngestionError::unsupported_version(version));
    }
    let opened = canopi_format::core::decode_design_value(value).map_err(|refusal| {
        let path = refusal.typed_field_path.unwrap_or_else(FieldPath::root);
        let prefix = format!("{path}: ");
        let expected = refusal
            .message
            .strip_prefix(&prefix)
            .unwrap_or(&refusal.message);
        match refusal.kind {
            FormatLoadRefusalKind::OlderVersion | FormatLoadRefusalKind::NewerVersion => {
                CanopiDesignIngestionError::unsupported_version(version)
            }
            _ => CanopiDesignIngestionError::invalid(path, expected),
        }
    })?;
    v10_value_to_canopi_file(opened.design)
}

fn strip_nested_ext(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            map.remove("ext");
            for child in map.values_mut() {
                strip_nested_ext(child);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                strip_nested_ext(item);
            }
        }
        _ => {}
    }
}

fn project_v10_site_data_to_lidar(obj: &mut serde_json::Map<String, serde_json::Value>) {
    let Some(mut site_data) = obj.remove("site_data") else {
        return;
    };
    strip_nested_ext(&mut site_data);
    if let Some(entries) = site_data.get_mut("entries").and_then(|v| v.as_array_mut()) {
        for entry in entries {
            if let Some(e) = entry.as_object_mut() {
                e.entry("kind".to_owned())
                    .or_insert_with(|| serde_json::json!("Source"));
                if let Some(ramp) = e.get("ramp").and_then(|r| r.as_str())
                    && !matches!(
                        ramp,
                        "Relief" | "Terrain" | "Earth" | "Greens" | "YellowRed" | "Magma" | "Gray"
                    )
                {
                    e.insert("ramp".to_owned(), serde_json::Value::Null);
                }
            }
        }
    }
    obj.insert("lidar".to_owned(), site_data);
}

fn project_v10_budget_to_session(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    currency: &str,
) {
    let Some(budget) = obj.get_mut("budget").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for line in budget {
        if let Some(item) = line.as_object_mut() {
            let ext = item.remove("ext");
            let ext_obj = ext.as_ref().and_then(|v| v.as_object());
            for (field, fallback) in [
                ("category", serde_json::json!("")),
                ("description", serde_json::json!("")),
                ("quantity", serde_json::json!(1.0)),
                ("currency", serde_json::json!(currency)),
            ] {
                item.entry(field.to_owned()).or_insert_with(|| {
                    ext_obj
                        .and_then(|e| e.get(field))
                        .cloned()
                        .unwrap_or(fallback)
                });
            }
        }
        strip_nested_ext(line);
    }
}

fn v10_value_to_canopi_file(
    mut value: serde_json::Value,
) -> Result<CanopiFile, CanopiDesignIngestionError> {
    let Some(obj) = value.as_object_mut() else {
        return Err(CanopiDesignIngestionError::invalid(
            FieldPath::root(),
            "expected a Canopi Design object",
        ));
    };
    let currency = obj
        .get("budget_currency")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_BUDGET_CURRENCY)
        .to_owned();
    if let Some(layers) = obj.get_mut("layers").and_then(|v| v.as_array_mut()) {
        for layer in layers {
            strip_nested_ext(layer);
            if let Some(l) = layer.as_object_mut() {
                l.entry("visible".to_owned())
                    .or_insert_with(|| serde_json::json!(true));
                l.entry("locked".to_owned())
                    .or_insert_with(|| serde_json::json!(false));
                l.entry("opacity".to_owned())
                    .or_insert_with(|| serde_json::json!(1.0));
            }
        }
    }
    if let Some(plants) = obj.get_mut("plants").and_then(|v| v.as_array_mut()) {
        for plant in plants {
            strip_nested_ext(plant);
            if let Some(p) = plant.as_object_mut() {
                if let Some(spread) = p.remove("canopy_spread_m") {
                    p.insert("scale".to_owned(), spread);
                }
                p.remove("quantity");
                p.entry("locked".to_owned())
                    .or_insert_with(|| serde_json::json!(false));
            }
        }
    }
    if let Some(zones) = obj.get_mut("zones").and_then(|v| v.as_array_mut()) {
        for zone in zones {
            strip_nested_ext(zone);
            if let Some(z) = zone.as_object_mut() {
                z.entry("locked".to_owned())
                    .or_insert_with(|| serde_json::json!(false));
                z.entry("rotation".to_owned())
                    .or_insert_with(|| serde_json::json!(0.0));
            }
        }
    }
    for key in [
        "annotations",
        "measurement_guides",
        "consortiums",
        "groups",
        "timeline",
        "views",
        "stories",
        "map_view",
    ] {
        if let Some(section) = obj.get_mut(key) {
            strip_nested_ext(section);
        }
    }
    if let Some(groups) = obj.get_mut("groups").and_then(|v| v.as_array_mut()) {
        for group in groups {
            if let Some(members) = group.get_mut("members").and_then(|v| v.as_array_mut()) {
                members.retain(|member| {
                    matches!(
                        member.get("kind").and_then(|k| k.as_str()),
                        Some("plant" | "zone" | "annotation")
                    )
                });
            }
        }
    }
    project_v10_site_data_to_lidar(obj);
    project_v10_budget_to_session(obj, &currency);
    serde_json::from_value(value).map_err(|err| {
        CanopiDesignIngestionError::invalid(
            FieldPath::root(),
            &format!("expected a Canopi Design ({err})"),
        )
    })
}

fn canopi_file_to_v10_value(content: &CanopiFile) -> Result<serde_json::Value, String> {
    let mut value =
        serde_json::to_value(content).map_err(|e| format!("Failed to serialize design: {e}"))?;
    let Some(obj) = value.as_object_mut() else {
        return Err("Failed to serialize design: expected an object".to_owned());
    };
    obj.insert(
        "version".to_owned(),
        serde_json::json!(CURRENT_CANOPI_FILE_VERSION),
    );
    if let Some(plants) = obj.get_mut("plants").and_then(|v| v.as_array_mut()) {
        for plant in plants {
            if let Some(p) = plant.as_object_mut()
                && let Some(scale) = p.remove("scale")
            {
                p.insert("canopy_spread_m".to_owned(), scale);
            }
        }
    }
    if let Some(mut lidar) = obj.remove("lidar") {
        if let Some(entries) = lidar.get_mut("entries").and_then(|v| v.as_array_mut()) {
            for entry in entries {
                if let Some(e) = entry.as_object_mut() {
                    e.remove("kind");
                }
            }
        }
        obj.insert("site_data".to_owned(), lidar);
    }
    if let Some(budget) = obj.get_mut("budget").and_then(|v| v.as_array_mut()) {
        let mut plant_lines = Vec::new();
        let mut non_plant_lines = Vec::new();
        for mut line in std::mem::take(budget) {
            let is_species = line
                .get("target")
                .and_then(|t| t.get("kind"))
                .and_then(|k| k.as_str())
                == Some("species");
            if is_species {
                if let Some(item) = line.as_object_mut() {
                    let mut ext = serde_json::Map::new();
                    for key in ["category", "description", "quantity", "currency"] {
                        if let Some(val) = item.remove(key) {
                            ext.insert(key.to_owned(), val);
                        }
                    }
                    if !ext.is_empty() {
                        item.insert("ext".to_owned(), serde_json::Value::Object(ext));
                    }
                }
                plant_lines.push(line);
            } else {
                non_plant_lines.push(line);
            }
        }
        *budget = plant_lines;
        if !non_plant_lines.is_empty() {
            obj.insert(
                "budget_ext".to_owned(),
                serde_json::json!({ "legacy_non_plant_lines": non_plant_lines }),
            );
        }
    }
    Ok(value)
}

fn read_design_version(value: &serde_json::Value) -> Result<u64, CanopiDesignIngestionError> {
    let Some(object) = value.as_object() else {
        let expected = "expected a Canopi Design object";
        return Err(CanopiDesignIngestionError::invalid(
            FieldPath::root(),
            expected,
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
    match version {
        Some(version) if version > 0 => Ok(version),
        _ => Err(CanopiDesignIngestionError::new(
            CanopiDesignIngestionErrorKind::InvalidVersion,
            Refusal::new(
                FieldPath::root().field("version"),
                "expected a positive integer",
            ),
        )),
    }
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
mod tests;

/// Saving, exporting and round trips; reading and admission are `format/tests.rs`.
#[cfg(test)]
mod write_tests {
    use super::tests::{create_default, unique_dir};
    use super::*;
    use canopi_types::design::PanelTarget;
    use canopi_types::views::{SavedViewCamera, SavedViewGroundSize};
    use std::path::PathBuf;

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

    pub(super) fn map_view_value() -> serde_json::Value {
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
            ("zoom", serde_json::json!(27.5), "$.map_view.zoom: "),
            ("bearing", serde_json::json!(361.0), "$.map_view.bearing: "),
            ("lat", serde_json::json!(86.0), "$.map_view.lat: "),
            (
                "ground_size_m",
                serde_json::Value::Null,
                "$.map_view.ground_size_m: ",
            ),
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
            assert!(
                error.refusal.to_string().starts_with(path),
                "{field}: {error}"
            );
        }
    }

    #[test]
    fn a_story_step_without_its_saved_view_is_refused() {
        let mut value = serde_json::to_value(with_views_and_stories()).expect("serialize");
        value["views"] = serde_json::json!([]);

        let error = decode_design_value(value).expect_err("dangling step must be refused");

        assert_eq!(error.kind, CanopiDesignIngestionErrorKind::InvalidDocument);
        assert!(
            error
                .refusal
                .to_string()
                .starts_with("$.stories[0].steps[0].view_id"),
            "{error}"
        );
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
        let LoadedDesign {
            file: loaded,
            fingerprint: loaded_fingerprint,
        } = open_with_fingerprint(&path).unwrap().editable();

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
        assert_eq!(
            open_with_fingerprint(&path).unwrap().editable().fingerprint,
            third
        );
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

        let LoadedDesign {
            file: loaded,
            fingerprint: loaded_fingerprint,
        } = open_with_fingerprint(&path).unwrap().editable();
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

    #[test]
    fn canopi_f47t_52_49_v9_with_species_budget_and_site_data_round_trips_through_v10_save_and_reopen()
     {
        let v9 = include_bytes!("../../../canopi-format/spec/v9/fixture.canopi");
        let opened = decode_design_bytes(v9).expect("v9 frozen fixture decodes and migrates");
        assert_eq!(opened.version, CURRENT_CANOPI_FILE_VERSION);
        assert!(
            !opened.budget.is_empty(),
            "v9 fixture includes budget lines"
        );
        let opened_lidar = opened
            .lidar
            .as_ref()
            .expect("v9 fixture includes Site data layers");
        assert!(!opened_lidar.entries.is_empty());

        let encoded = encode_design(&opened).expect("migrated v9 encodes cleanly as v10");
        let encoded_json: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(encoded_json["version"], 10);
        assert!(
            encoded_json.get("lidar").is_none(),
            "canonical v10 uses site_data, never legacy lidar"
        );

        let reopened = decode_design_bytes(&encoded).expect("saved v10 reopens cleanly");
        assert_eq!(reopened.version, 10);
        assert_eq!(reopened.name, opened.name);
        assert_eq!(reopened.plants.len(), opened.plants.len());
        assert_eq!(reopened.budget.len(), opened.budget.len());
        assert_eq!(
            reopened.lidar.as_ref().map(|s| s.entries.len()),
            Some(opened_lidar.entries.len())
        );
    }
}
