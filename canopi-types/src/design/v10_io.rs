//! Wire DTOs for the `.canopi` v10 Format Core (`contracts.md` §2 `:67`, §10 `:423`).
//!
//! Emitted into `desktop/web/src/generated/contracts.ts` via `bindings-gen` so the 2b-5
//! TypeScript host consumes typed refusal, open, draft-summary, and answer-envelope shapes
//! without hand-typing them.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::design::field_path::{FieldPath, Refusal};
use crate::design::v10::{CanopiFileV10, PlantDisplayV10};

/// Structured refusal kind returned by the v10 Format Core (`contracts.md` §2 `:67`, §10 `:423`).
///
/// Flattened into [`FormatRefusal`] so the wire shape is `{"kind":"migration_failed","from":9,"message":...}`
/// rather than a nested `{"kind":{"kind":...}}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FormatLoadRefusalKind {
    /// File exceeded the 64 MiB admission cap.
    TooLarge,
    /// Input bytes were not valid UTF-8 JSON.
    InvalidJson,
    /// Format version is below the 2.0 floor (v9).
    OlderVersion,
    /// Format version is above the highest version this build writes (v10; `2.1-Q347`).
    NewerVersion,
    /// A pure migration step failed on its input (`design_load{migration_failed{from}}`).
    MigrationFailed {
        /// The format version the failing step was migrating from.
        from: u32,
    },
    /// Schema or semantic admission refused the document.
    InvalidDocument,
}

/// Structured refusal returned by the Format Core on decode or encode failure.
///
/// Serialises flat on the wire: `{"kind":"older_version","message":"...","field_path":"$.version"}`
/// or `{"kind":"migration_failed","from":9,"message":"...","field_path":"$"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FormatRefusal {
    /// Flattened refusal kind (`kind`, plus `from` when `kind == "migration_failed"`).
    #[serde(flatten)]
    pub kind: FormatLoadRefusalKind,
    /// Diagnostic message (never contains user file values or paths, `2.1-Q286`).
    pub message: String,
    /// Optional leaf field path for diagnostics and Problem Reports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_path: Option<String>,
}

impl FormatRefusal {
    /// Builds an `invalid_document` refusal at `path`.
    #[must_use]
    pub fn invalid_document(path: FieldPath, expected: impl Into<String>) -> Self {
        let refusal = Refusal::new(path, expected);
        Self::from_refusal(refusal)
    }

    /// Converts a [`Refusal`] from schema or typed admission into a [`FormatRefusal`].
    #[must_use]
    pub fn from_refusal(refusal: Refusal) -> Self {
        Self {
            kind: FormatLoadRefusalKind::InvalidDocument,
            message: refusal.to_string(),
            field_path: Some(refusal.field_path.to_string()),
        }
    }
}

/// Wire contract for the Format Core's `decode_design` outcome (`contracts.md` §10).
///
/// Pure format output only: the host adapter computes any pre-upgrade copy decision when
/// `migrated_from` is `Some(_)`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct OpenedDesignContract {
    /// Admitted, canonicalised v10 `.canopi` Design.
    pub design: CanopiFileV10,
    /// Present when the input was migrated from an earlier format version (e.g. `Some(9)`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migrated_from: Option<u32>,
    /// Frozen release label for `migrated_from` (e.g. `Some("2.0")`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migrated_from_release: Option<String>,
}

/// Input to `new_design` carrying settings-derived `plant_display` defaults (`contracts.md` §10).
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct NewDesignInputContract {
    /// Initial Design name (empty for Untitled).
    #[serde(default)]
    pub name: String,
    /// Optional `plant_display` defaults from Settings.
    #[serde(default)]
    pub plant_display: Option<PlantDisplayV10>,
    /// ISO-8601 creation/update timestamp supplied by the host clock.
    #[serde(default)]
    pub created_at: String,
}

/// Summary outcome for a Draft listing row (`contracts.md` §10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
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

/// Wire answer envelope returned by `canopi-format-wasm` `decode_design`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FormatDecodeAnswer {
    /// Successful decode outcome.
    Ok(Box<OpenedDesignContract>),
    /// Structured refusal.
    Err(FormatRefusal),
}

/// Wire answer envelope returned by `canopi-format-wasm` `encode_design`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FormatEncodeAnswer {
    /// Canonical sorted-key JSON string.
    Ok(String),
    /// Structured refusal.
    Err(FormatRefusal),
}

#[cfg(feature = "design-schema")]
pub(crate) fn strip_schema_descriptions(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            map.remove("description");
            for (key, v) in map.iter_mut() {
                if key == "properties" || key == "$defs" || key == "definitions" {
                    if let serde_json::Value::Object(entries) = v {
                        for entry in entries.values_mut() {
                            strip_schema_descriptions(entry);
                        }
                    }
                } else {
                    strip_schema_descriptions(v);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                strip_schema_descriptions(item);
            }
        }
        _ => {}
    }
}
