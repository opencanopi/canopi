//! The Web format worker's module (ADR 0025 format worker; contracts §10, §18 F28; 2.1-M539):
//! `canopi-format` behind wasm-bindgen, every result a JSON string, loaded on
//! first need by `desktop/web/src/platform/design-core.worker.ts`, the one
//! importer of its glue (`wasm-glue-only-in-adapter`).
//!
//! Exposes both the Format Core v10 API (`decode_design`, `encode_design`, `new_design`,
//! `draft_summary`, `decode_stamp_payload`, `encode_stamp_payload`, `format_core_version`)
//! and the legacy Step 2.0.4 `read_newer_design` export until the TS DesignCore switch
//! deletes the read-only view.

use canopi_format::core::{
    FORMAT_CORE_VERSION, FormatRefusal, NewDesignInput, OpenedDesign,
    decode_design as core_decode_design, draft_summary as core_draft_summary,
    encode_design as core_encode_design, new_design as core_new_design,
};
use canopi_format::read::read_newer_design as read_view;
use canopi_format::stamps::{
    StampPayloadRefusal, decode_stamp_payload as core_decode_stamp,
    encode_stamp_payload as core_encode_stamp,
};
use canopi_types::design::field_path::FieldPath;
use canopi_types::design::v10::FormatLoadRefusalKind;
use canopi_types::design::{DesignLoadFailure, DesignLoadFailureKind, ReadOnlyDesign};
use canopi_types::saved_object_stamps::SavedObjectStampPayload;
use serde::Serialize;
use wasm_bindgen::prelude::wasm_bindgen;

/// Legacy Step 2.0.4 answer envelope for [`read_newer_design`].
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ReadAnswer {
    Read(Box<ReadOnlyDesign>),
    Refused(DesignLoadFailure),
}

/// Answer envelope for [`decode_design`].
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum DecodeAnswer {
    Ok(Box<OpenedDesign>),
    Err(FormatRefusal),
}

/// Answer envelope for [`encode_design`].
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum EncodeAnswer {
    Ok(String),
    Err(FormatRefusal),
}

/// Answer envelope for [`decode_stamp_payload`].
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum StampDecodeAnswer {
    Ok(Box<SavedObjectStampPayload>),
    Err(StampPayloadRefusal),
}

/// Answer envelope for [`encode_stamp_payload`].
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum StampEncodeAnswer {
    Ok(String),
    Err(StampPayloadRefusal),
}

/// Reports the `canopi-format` crate version (contracts §10 parity test).
#[wasm_bindgen]
pub fn format_core_version() -> String {
    FORMAT_CORE_VERSION.to_owned()
}

/// Decodes a `.canopi` Design (v9 or v10) through the Format Core v10 pipeline,
/// returning `{"ok": OpenedDesign}` or `{"err": FormatRefusal}`.
#[wasm_bindgen]
pub fn decode_design(text: &str) -> String {
    let answer = match core_decode_design(text.as_bytes()) {
        Ok(opened) => DecodeAnswer::Ok(Box::new(opened)),
        Err(refusal) => DecodeAnswer::Err(refusal),
    };
    serde_json::to_string(&answer).unwrap_or_else(|_| String::from("{}"))
}

/// Validates a v10 `.canopi` Design under write admission and returns its canonical
/// JSON encoding as `{"ok": "<canonical-json>"}` or `{"err": FormatRefusal}`.
#[wasm_bindgen]
pub fn encode_design(design_json: &str) -> String {
    let answer = match serde_json::from_str::<serde_json::Value>(design_json) {
        Err(_) => EncodeAnswer::Err(FormatRefusal {
            kind: FormatLoadRefusalKind::InvalidJson,
            message: "the Design is not valid JSON".to_owned(),
            field_path: Some(FieldPath::root()),
        }),
        Ok(value) => match core_encode_design(&value) {
            Ok(bytes) => {
                EncodeAnswer::Ok(String::from_utf8(bytes).unwrap_or_else(|_| String::from("{}")))
            }
            Err(refusal) => EncodeAnswer::Err(refusal),
        },
    };
    serde_json::to_string(&answer).unwrap_or_else(|_| String::from("{}"))
}

/// Constructs a canonical v10 Design from a JSON-encoded [`NewDesignInput`].
#[wasm_bindgen]
pub fn new_design(input_json: &str) -> String {
    let input = serde_json::from_str::<NewDesignInput>(input_json).unwrap_or(NewDesignInput {
        name: String::new(),
        plant_display: None,
        created_at: String::new(),
    });
    serde_json::to_string(&core_new_design(&input)).unwrap_or_else(|_| String::from("{}"))
}

/// Derives a Draft summary from raw `.canopi` text and its stored `updated_at` timestamp.
#[wasm_bindgen]
pub fn draft_summary(text: &str, updated_at: &str) -> String {
    let summary = core_draft_summary(text.as_bytes(), updated_at);
    serde_json::to_string(&summary).unwrap_or_else(|_| String::from("{}"))
}

/// Decodes a v2 or v3 saved-stamp payload, migrating v2 → v3 in place.
#[wasm_bindgen]
pub fn decode_stamp_payload(text: &str) -> String {
    let answer = match core_decode_stamp(text.as_bytes()) {
        Ok(payload) => StampDecodeAnswer::Ok(Box::new(payload)),
        Err(refusal) => StampDecodeAnswer::Err(refusal),
    };
    serde_json::to_string(&answer).unwrap_or_else(|_| String::from("{}"))
}

/// Validates and canonically encodes a v3 saved-stamp payload.
#[wasm_bindgen]
pub fn encode_stamp_payload(payload_json: &str) -> String {
    let answer = match serde_json::from_str::<SavedObjectStampPayload>(payload_json) {
        Err(_) => StampEncodeAnswer::Err(StampPayloadRefusal::InvalidJson),
        Ok(payload) => match core_encode_stamp(&payload) {
            Ok(bytes) => StampEncodeAnswer::Ok(
                String::from_utf8(bytes).unwrap_or_else(|_| String::from("{}")),
            ),
            Err(refusal) => StampEncodeAnswer::Err(refusal),
        },
    };
    serde_json::to_string(&answer).unwrap_or_else(|_| String::from("{}"))
}

/// Legacy Step 2.0.4 export: read `text`, a `.canopi` Design of version 10 or later,
/// for the read-only view. Kept until Lead's TS DesignCore switch deletes the read-only view.
#[wasm_bindgen]
pub fn read_newer_design(text: &str) -> String {
    let answer = match serde_json::from_str::<serde_json::Value>(text) {
        Err(_) => ReadAnswer::Refused(DesignLoadFailure {
            kind: DesignLoadFailureKind::InvalidJson,
            message: "the Design is not JSON".to_owned(),
            field_path: Some(FieldPath::root()),
        }),
        Ok(value) => match read_view(&value) {
            Ok(design) => ReadAnswer::Read(Box::new(design)),
            Err(refused) => ReadAnswer::Refused(DesignLoadFailure {
                kind: refused.kind,
                message: refused.refusal.to_string(),
                field_path: Some(refused.refusal.field_path),
            }),
        },
    };
    serde_json::to_string(&answer).unwrap_or_else(|_| String::from("{}"))
}

#[cfg(test)]
mod tests;
