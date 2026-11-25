//! The `.canopi` v10 Format Core (ADR 0026, contracts §10; 2.1-Q34, 2.1-Q347,
//! 2.1-M156, 2.1-M539, canopi-gjs3).
//!
//! One decode/encode/admission choke point built directly on the typed [`CanopiFileV10`]
//! model and [`canopi_types::design::admit_design_v10`], shared natively on Desktop and via
//! `canopi-format-wasm` on Web. Every v9 input is validated against the frozen
//! `spec/v9/schema.json` before stepping; every v10 value is validated against the emitted
//! `spec/v10/schema.json` and typed admission; every write emits canonical sorted-key JSON.

use std::sync::OnceLock;

use canopi_types::design::field_path::{FieldPath, Refusal};
use canopi_types::design::v10::{CanopiFileV10, FormatLoadRefusalKind};
use canopi_types::design::{
    DEFAULT_BUDGET_CURRENCY, V10AdmissionMode, admit_design_v10, normalise_v10_on_decode,
};
use canopi_types::store_chain::Admission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::chain::{
    CANOPI_CURRENT, admit_canopi_version, canonical_json_string, canonicalize_json, release_label,
    run_migration_steps,
};
use crate::schema::admit_schema;

/// Maximum `.canopi` file size admitted by the Format Core (64 MiB, matches Desktop `format.rs`).
pub const MAX_CANOPI_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Crate version reported by the Format Core (contracts §10).
pub const FORMAT_CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Frozen v9 `.canopi` schema validated before running the v9→v10 step (contracts §10 `:424`).
#[must_use]
pub fn v9_schema() -> Option<&'static Value> {
    static SCHEMA: OnceLock<Option<Value>> = OnceLock::new();
    SCHEMA
        .get_or_init(|| serde_json::from_str(include_str!("../spec/v9/schema.json")).ok())
        .as_ref()
}

/// Full emitted v10 `.canopi` schema walked by decode and write admission (`2.1-M31`).
#[must_use]
pub fn v10_schema() -> Option<&'static Value> {
    static SCHEMA: OnceLock<Option<Value>> = OnceLock::new();
    SCHEMA
        .get_or_init(|| serde_json::from_str(include_str!("../spec/v10/schema.json")).ok())
        .as_ref()
}

/// Outcome of decoding a `.canopi` file through the v10 Format Core.
///
/// Pure format output only: the host adapter (which knows the home kind and file stem)
/// calls [`crate::chain::pre_upgrade_copy_decision`] when `migrated_from` is `Some(_)`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpenedDesign {
    /// Admitted, canonicalised v10 `.canopi` JSON object.
    pub design: Value,
    /// Present when the input was migrated from an earlier format version (e.g. `Some(9)`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migrated_from: Option<u32>,
    /// Frozen release label for `migrated_from` (e.g. `Some("2.0")`), from [`release_label`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migrated_from_release: Option<String>,
}

/// Structured refusal returned by the Format Core on decode or encode failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FormatRefusal {
    /// Structured refusal kind (`migration_failed{from}`, `newer_version`, `invalid_document`, etc.).
    pub kind: FormatLoadRefusalKind,
    /// Diagnostic message (never contains user file values or paths, `2.1-Q286`).
    pub message: String,
    /// Optional leaf field path for diagnostics and Problem Reports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_path: Option<FieldPath>,
}

impl FormatRefusal {
    fn invalid_document(path: FieldPath, expected: impl Into<String>) -> Self {
        let refusal = Refusal::new(path, expected);
        Self {
            kind: FormatLoadRefusalKind::InvalidDocument,
            message: refusal.to_string(),
            field_path: Some(refusal.field_path),
        }
    }

    fn from_refusal(refusal: Refusal) -> Self {
        Self {
            kind: FormatLoadRefusalKind::InvalidDocument,
            message: refusal.to_string(),
            field_path: Some(refusal.field_path),
        }
    }
}

/// Input to [`new_design`] carrying settings-derived `plant_display` defaults (contracts §10).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NewDesignInput {
    /// Initial Design name (empty for Untitled).
    #[serde(default)]
    pub name: String,
    /// Optional `plant_display` defaults from Settings.
    #[serde(default)]
    pub plant_display: Option<Value>,
    /// ISO-8601 creation/update timestamp supplied by the host clock.
    #[serde(default)]
    pub created_at: String,
}

/// Summary outcome for a Draft listing row (contracts §10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftSummaryOutcome {
    /// Design name (empty if unreadable).
    pub name: String,
    /// Last updated timestamp (from file if readable, else caller fallback).
    pub updated_at: String,
    /// True when the Draft opens cleanly through the Format Core.
    pub readable: bool,
    /// Refusal kind when `readable` is false (listed as unreadable, never hidden).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refusal_kind: Option<FormatLoadRefusalKind>,
    /// Source version when the Draft will migrate on open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migrated_from: Option<u32>,
}

/// Decodes raw `.canopi` bytes through size cap, JSON parse, version admission,
/// frozen v9 schema walk + pure v9→v10 migration step (when applicable), full v10 schema walk,
/// typed [`CanopiFileV10`] decode + normalisation, and single typed [`admit_design_v10`].
///
/// # Errors
///
/// Returns [`FormatRefusal`] with `FormatLoadRefusalKind::TooLarge`, `InvalidJson`,
/// `OlderVersion`, `NewerVersion`, `MigrationFailed { from }`, or `InvalidDocument`.
pub fn decode_design(bytes: &[u8]) -> Result<OpenedDesign, FormatRefusal> {
    if bytes.len() as u64 > MAX_CANOPI_FILE_BYTES {
        return Err(FormatRefusal {
            kind: FormatLoadRefusalKind::TooLarge,
            message: format!("file exceeds {MAX_CANOPI_FILE_BYTES} bytes"),
            field_path: None,
        });
    }
    let raw: Value = serde_json::from_slice(bytes).map_err(|_| FormatRefusal {
        kind: FormatLoadRefusalKind::InvalidJson,
        message: "expected valid JSON".to_owned(),
        field_path: None,
    })?;
    decode_design_value(raw)
}

/// Decodes a parsed JSON value through the v10 Format Core.
///
/// # Errors
///
/// Returns [`FormatRefusal`] on version, schema, migration, or semantic admission failure.
pub fn decode_design_value(raw: Value) -> Result<OpenedDesign, FormatRefusal> {
    let version = read_integer_version(&raw)?;
    let (migrated_from, candidate) = match admit_canopi_version(Some(version)) {
        Admission::Absent | Admission::BeforeFloor { .. } => {
            return Err(FormatRefusal {
                kind: FormatLoadRefusalKind::OlderVersion,
                message: format!("format version {version} is older than Canopi 2.0"),
                field_path: Some(FieldPath::root().field("version")),
            });
        }
        Admission::NewerReadable { .. } | Admission::RefusedNewer { .. } => {
            return Err(FormatRefusal {
                kind: FormatLoadRefusalKind::NewerVersion,
                message: format!("format version {version} is newer than Canopi 2.1"),
                field_path: Some(FieldPath::root().field("version")),
            });
        }
        Admission::Migratable { from } => {
            // Contracts §10 :424: validate step input against the frozen vN-1 schema before stepping.
            if from == 9 {
                let schema_v9 = v9_schema().ok_or_else(|| {
                    FormatRefusal::invalid_document(FieldPath::root(), "a valid frozen v9 schema")
                })?;
                admit_schema(&raw, schema_v9).map_err(FormatRefusal::from_refusal)?;
            }
            let migrated = run_migration_steps(raw, from).map_err(|step_err| FormatRefusal {
                kind: FormatLoadRefusalKind::MigrationFailed {
                    from: step_err.from,
                },
                message: format!(
                    "migration from v{} failed: {}",
                    step_err.from, step_err.reason
                ),
                field_path: Some(FieldPath::root()),
            })?;
            (Some(from), migrated)
        }
        Admission::Current => (None, raw),
    };

    let mut typed = parse_and_admit_v10(&candidate, V10AdmissionMode::Decode)?;
    normalise_v10_on_decode(&mut typed);
    let canonical = serde_json::to_value(&typed)
        .map(|v| canonicalize_json(&v))
        .map_err(|_| {
            FormatRefusal::invalid_document(FieldPath::root(), "serialisable v10 CanopiFile")
        })?;

    Ok(OpenedDesign {
        design: canonical,
        migrated_from,
        migrated_from_release: migrated_from.and_then(release_label).map(ToOwned::to_owned),
    })
}

/// Validates and canonically encodes a v10 `.canopi` Design (`canopi-gjs3`, `2.1-M156`).
///
/// Write admission refuses non-v10 versions, dangling/duplicate/<2 group members,
/// duplicate `site_data` entry ids, invalid `print_setup` split references, and files > 64 MiB.
///
/// # Errors
///
/// Returns [`FormatRefusal`] on version, schema, semantic, or size-cap failure.
pub fn encode_design(design: &Value) -> Result<Vec<u8>, FormatRefusal> {
    let version = read_integer_version(design)?;
    if version != CANOPI_CURRENT {
        return Err(FormatRefusal::invalid_document(
            FieldPath::root().field("version"),
            format!("expected current format version {CANOPI_CURRENT} on write"),
        ));
    }
    let typed = parse_and_admit_v10(design, V10AdmissionMode::Write)?;
    let value = serde_json::to_value(&typed).map_err(|_| {
        FormatRefusal::invalid_document(FieldPath::root(), "serialisable v10 CanopiFile")
    })?;
    let bytes = canonical_json_string(&value).into_bytes();
    if bytes.len() as u64 > MAX_CANOPI_FILE_BYTES {
        return Err(FormatRefusal {
            kind: FormatLoadRefusalKind::TooLarge,
            message: format!("encoded file exceeds {MAX_CANOPI_FILE_BYTES} bytes"),
            field_path: None,
        });
    }
    Ok(bytes)
}

/// Builds a canonical new v10 `.canopi` Design document from [`NewDesignInput`].
#[must_use]
pub fn new_design(input: &NewDesignInput) -> Value {
    let plant_display = input
        .plant_display
        .as_ref()
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let file = CanopiFileV10 {
        version: CANOPI_CURRENT,
        name: input.name.clone(),
        description: None,
        plant_species_colors: Default::default(),
        plant_species_symbols: Default::default(),
        plant_species_codes: Default::default(),
        layers: Vec::new(),
        plants: Vec::new(),
        zones: Vec::new(),
        annotations: Vec::new(),
        measurement_guides: Vec::new(),
        consortiums: Vec::new(),
        groups: Vec::new(),
        timeline: Vec::new(),
        budget: Vec::new(),
        budget_currency: DEFAULT_BUDGET_CURRENCY.to_owned(),
        budget_ext: None,
        site_data: None,
        plant_display,
        print_setup: None,
        views: Vec::new(),
        stories: Vec::new(),
        map_view: None,
        created_at: input.created_at.clone(),
        updated_at: input.created_at.clone(),
        extra: Default::default(),
    };
    canonicalize_json(&serde_json::to_value(file).unwrap_or_else(|_| json!({})))
}

/// Summarises raw Draft bytes for listing through the one decode choke point (contracts §10).
#[must_use]
pub fn draft_summary(bytes: &[u8], updated_at: &str) -> DraftSummaryOutcome {
    match decode_design(bytes) {
        Ok(opened) => DraftSummaryOutcome {
            name: opened
                .design
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            updated_at: opened
                .design
                .get("updated_at")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(updated_at)
                .to_owned(),
            readable: true,
            refusal_kind: None,
            migrated_from: opened.migrated_from,
        },
        Err(refusal) => DraftSummaryOutcome {
            name: String::new(),
            updated_at: updated_at.to_owned(),
            readable: false,
            refusal_kind: Some(refusal.kind),
            migrated_from: None,
        },
    }
}

fn read_integer_version(value: &Value) -> Result<u32, FormatRefusal> {
    let path = FieldPath::root().field("version");
    let Some(raw) = value.get("version") else {
        return Err(FormatRefusal::invalid_document(
            path,
            "expected an integer format version",
        ));
    };
    if let Some(u) = raw.as_u64() {
        return u32::try_from(u)
            .map_err(|_| FormatRefusal::invalid_document(path, "expected a u32 format version"));
    }
    if let Some(f) = raw.as_f64()
        && f.is_finite()
        && f.fract() == 0.0
        && f >= 0.0
        && f <= f64::from(u32::MAX)
    {
        return Ok(f as u32);
    }
    Err(FormatRefusal::invalid_document(
        path,
        "expected an unsigned integer format version",
    ))
}

fn parse_and_admit_v10(
    value: &Value,
    mode: V10AdmissionMode,
) -> Result<CanopiFileV10, FormatRefusal> {
    let schema = v10_schema().ok_or_else(|| {
        FormatRefusal::invalid_document(FieldPath::root(), "a valid emitted v10 schema")
    })?;
    admit_schema(value, schema).map_err(FormatRefusal::from_refusal)?;
    let mut typed: CanopiFileV10 = serde_json::from_value(value.clone()).map_err(|_| {
        FormatRefusal::invalid_document(FieldPath::root(), "a valid v10 CanopiFile")
    })?;
    if mode == V10AdmissionMode::Decode {
        normalise_v10_on_decode(&mut typed);
    }
    admit_design_v10(&typed, mode).map_err(FormatRefusal::from_refusal)?;
    Ok(typed)
}
