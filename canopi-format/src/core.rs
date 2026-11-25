//! The `.canopi` v10 Format Core (ADR 0026, contracts §10; 2.1-Q34, 2.1-Q347,
//! 2.1-M156, 2.1-M539, canopi-gjs3).
//!
//! One decode/encode/admission choke point shared natively on Desktop and via
//! `canopi-format-wasm` on Web. Every write passes schema + semantic write
//! admission and emits canonical sorted-key JSON (`2.1-M156`).

use canopi_types::design::field_path::{FieldPath, Refusal};
use canopi_types::design::{DEFAULT_BUDGET_CURRENCY, DesignLoadFailureKind};
use canopi_types::store_chain::Admission;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::chain::{
    CANOPI_CURRENT, PreUpgradeCopyDecision, admit_canopi_version, canonical_json_string,
    canonicalize_json, normalise_groups_value, pre_upgrade_copy_decision, release_label,
    run_migration_steps,
};
use crate::core_validate::{AdmissionMode, admit_design, dedup_site_data_on_decode};
use crate::schema::admit_schema;
use crate::v10::read_schema;

/// Maximum `.canopi` file size admitted by the Format Core (64 MiB, matches Desktop `format.rs`).
pub const MAX_CANOPI_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Crate version reported by the Format Core (contracts §10).
pub const FORMAT_CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Outcome of decoding a `.canopi` file through the v10 Format Core.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpenedDesign {
    /// Admitted, canonicalised v10 `.canopi` JSON object.
    pub design: Value,
    /// Original format version when migrated forward (e.g. `Some(9)`), or `None` when already v10.
    pub migrated_from: Option<u32>,
    /// Frozen release label for `migrated_from` (e.g. `Some("2.0")`).
    pub release_label: Option<String>,
    /// Pre-upgrade backup decision metadata for Desktop file/Draft homes (2.1-Q35r, 2.1-Q348).
    pub copy_decision: PreUpgradeCopyDecision,
}

/// Typed refusal returned by [`decode_design`] and [`encode_design`] (contracts §10, canopi-cyqd).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FormatRefusal {
    /// Failure kind mapped to user-facing copy.
    pub kind: DesignLoadFailureKind,
    /// Redacted English diagnostic naming what was expected (never a file value).
    pub message: String,
    /// Leaf field path in the Design where admission failed.
    pub field_path: Option<FieldPath>,
    /// Populated when a migration step failed (`design_load{migration_failed{from}}`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration_from: Option<u32>,
}

impl FormatRefusal {
    pub(crate) fn invalid_document(path: FieldPath, expected: impl Into<String>) -> Self {
        let refusal = Refusal::new(path, expected);
        Self {
            kind: DesignLoadFailureKind::InvalidDocument,
            message: refusal.to_string(),
            field_path: Some(refusal.field_path),
            migration_from: None,
        }
    }
}

/// Input to [`new_design`] (contracts §10: carries `plant_display` defaults from settings).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewDesignInput {
    /// Initial Design name (unnamed Designs store `""`, contracts §4).
    #[serde(default)]
    pub name: String,
    /// Optional `plant_display` defaults from Settings › New Designs.
    #[serde(default)]
    pub plant_display: Option<Value>,
    /// ISO 8601 creation timestamp supplied by the caller's injected clock.
    pub created_at: String,
}

/// Summary derived from raw Draft bytes by [`draft_summary`] (contracts §4, §10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftSummaryOutcome {
    /// Stored Design name (empty when unnamed or unreadable).
    pub name: String,
    /// Last-updated timestamp passed in from the store record.
    pub updated_at: String,
    /// `true` when the Draft decodes cleanly through the v10 Format Core.
    pub readable: bool,
    /// Failure kind when `readable == false` (unreadable Drafts are listed, never hidden).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refusal_kind: Option<DesignLoadFailureKind>,
    /// Original format version when the Draft is a v9 Draft pending migration on first edit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migrated_from: Option<u32>,
}

/// Decodes raw `.canopi` bytes through size cap, JSON parse, `store_chain::admit_form_version`,
/// v9→v10 migration, frozen v10 schema walk, and semantic admission (contracts §10).
///
/// # Errors
///
/// Returns [`FormatRefusal`] with `too_large`, `invalid_json`, `older_version`,
/// `newer_version`, or `invalid_document`.
pub fn decode_design(bytes: &[u8]) -> Result<OpenedDesign, FormatRefusal> {
    if bytes.len() as u64 > MAX_CANOPI_FILE_BYTES {
        return Err(FormatRefusal {
            kind: DesignLoadFailureKind::TooLarge,
            message: "the Design exceeds the maximum readable size".to_owned(),
            field_path: Some(FieldPath::root()),
            migration_from: None,
        });
    }
    let mut value: Value = serde_json::from_slice(bytes).map_err(|_| FormatRefusal {
        kind: DesignLoadFailureKind::InvalidJson,
        message: "the Design is not valid JSON".to_owned(),
        field_path: Some(FieldPath::root()),
        migration_from: None,
    })?;

    let version = read_integer_version(&value)?;
    let migrated_from = match admit_canopi_version(Some(version)) {
        Admission::Absent => {
            return Err(FormatRefusal::invalid_document(
                FieldPath::root().field("version"),
                "expected a format version",
            ));
        }
        Admission::BeforeFloor { .. } => {
            return Err(FormatRefusal {
                kind: DesignLoadFailureKind::OlderVersion,
                message: "the Design was saved by an older Canopi version".to_owned(),
                field_path: Some(FieldPath::root().field("version")),
                migration_from: None,
            });
        }
        Admission::RefusedNewer { .. } | Admission::NewerReadable { .. } => {
            return Err(FormatRefusal {
                kind: DesignLoadFailureKind::NewerVersion,
                message: "the Design was saved by a newer Canopi version".to_owned(),
                field_path: Some(FieldPath::root().field("version")),
                migration_from: None,
            });
        }
        Admission::Migratable { from } => {
            value = run_migration_steps(value, from).map_err(|err| FormatRefusal {
                kind: DesignLoadFailureKind::InvalidDocument,
                message: format!("migration from v{} failed: {}", err.from, err.reason),
                field_path: Some(FieldPath::root()),
                migration_from: Some(err.from),
            })?;
            Some(from)
        }
        Admission::Current => None,
    };

    admit_v10_value(&value, AdmissionMode::Decode)?;
    if let Some(root) = value.as_object_mut() {
        normalise_groups_value(root);
        dedup_site_data_on_decode(root);
    }

    let design = canonicalize_json(&value);
    let stem = design
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty());
    let copy_decision = pre_upgrade_copy_decision(migrated_from, stem);
    let label = migrated_from.and_then(release_label).map(ToOwned::to_owned);

    Ok(OpenedDesign {
        design,
        migrated_from,
        release_label: label,
        copy_decision,
    })
}

/// Validates a v10 `.canopi` JSON value under strict write admission (`canopi-gjs3`)
/// and encodes it canonically with sorted keys (`2.1-M156`).
///
/// # Errors
///
/// Returns [`FormatRefusal`] naming the first offending field path if write admission fails.
pub fn encode_design(design: &Value) -> Result<Vec<u8>, FormatRefusal> {
    let version = read_integer_version(design)?;
    if version != CANOPI_CURRENT {
        return Err(FormatRefusal::invalid_document(
            FieldPath::root().field("version"),
            format!("expected current format version {CANOPI_CURRENT}"),
        ));
    }
    admit_v10_value(design, AdmissionMode::Write)?;
    let bytes = canonical_json_string(design).into_bytes();
    if bytes.len() as u64 > MAX_CANOPI_FILE_BYTES {
        return Err(FormatRefusal {
            kind: DesignLoadFailureKind::TooLarge,
            message: "the encoded Design exceeds the maximum size".to_owned(),
            field_path: Some(FieldPath::root()),
            migration_from: None,
        });
    }
    Ok(bytes)
}

/// Constructs a valid canonical v10 Design from [`NewDesignInput`] (contracts §10).
#[must_use]
pub fn new_design(input: &NewDesignInput) -> Value {
    let mut root = Map::new();
    root.insert("version".to_owned(), json!(CANOPI_CURRENT));
    root.insert("name".to_owned(), json!(input.name));
    root.insert("description".to_owned(), Value::Null);
    root.insert("plant_species_colors".to_owned(), json!({}));
    root.insert("plant_species_symbols".to_owned(), json!({}));
    root.insert("plant_species_codes".to_owned(), json!({}));
    root.insert("layers".to_owned(), json!([]));
    root.insert("plants".to_owned(), json!([]));
    root.insert("zones".to_owned(), json!([]));
    root.insert("annotations".to_owned(), json!([]));
    root.insert("measurement_guides".to_owned(), json!([]));
    root.insert("consortiums".to_owned(), json!([]));
    root.insert("groups".to_owned(), json!([]));
    root.insert("timeline".to_owned(), json!([]));
    root.insert("budget".to_owned(), json!([]));
    root.insert("budget_currency".to_owned(), json!(DEFAULT_BUDGET_CURRENCY));
    if let Some(display) = &input.plant_display
        && !display.is_null()
    {
        root.insert("plant_display".to_owned(), display.clone());
    }
    root.insert("views".to_owned(), json!([]));
    root.insert("stories".to_owned(), json!([]));
    root.insert("created_at".to_owned(), json!(input.created_at));
    root.insert("updated_at".to_owned(), json!(input.created_at));
    canonicalize_json(&Value::Object(root))
}

/// Derives a Draft's list summary by decoding its raw bytes (contracts §4, §10).
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
            updated_at: updated_at.to_owned(),
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

fn admit_v10_value(value: &Value, mode: AdmissionMode) -> Result<(), FormatRefusal> {
    let schema = read_schema().ok_or_else(|| {
        FormatRefusal::invalid_document(FieldPath::root(), "a valid frozen v10 schema")
    })?;
    admit_schema(value, schema).map_err(|refusal| FormatRefusal {
        kind: DesignLoadFailureKind::InvalidDocument,
        message: refusal.to_string(),
        field_path: Some(refusal.field_path),
        migration_from: None,
    })?;
    admit_design(value, mode)
}
