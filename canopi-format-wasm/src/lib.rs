//! The Web format worker's module (ADR 0025 format worker; contracts §18 F28):
//! `canopi-format` behind wasm-bindgen, every result a JSON string, loaded on
//! first need by `desktop/web/src/platform/design-core.worker.ts`, the one
//! importer of its glue (`wasm-glue-only-in-adapter`). Desktop reads natively
//! and never loads it (2.1-M476).
//!
//! Step 2.0.4's reader release asks one thing of it, [`read_newer_design`]:
//! a `.canopi` text of version 10 or later read by `canopi-format`'s read
//! admission into the read-only view, the one Rust view both editions show
//! and 2b's switch deletes (2.1-M478). Its release size is the worker's size
//! budget (`web wasm: canopi_format_wasm_bg` in policy/ratchets/bundle-size.json).

use canopi_format::read::read_newer_design as read_view;
use canopi_types::design::field_path::FieldPath;
use canopi_types::design::{DesignLoadFailure, DesignLoadFailureKind, ReadOnlyDesign};
use serde::Serialize;
use wasm_bindgen::prelude::wasm_bindgen;

/// What [`read_newer_design`] answers, as JSON: the read view, or the load
/// failure the interface maps, its message naming the refused field and
/// what was expected there, never a value of the file.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ReadAnswer {
    /// The Design as the read-only view shows it.
    Read(Box<ReadOnlyDesign>),
    /// Why the read refused it.
    Refused(DesignLoadFailure),
}

/// Read `text`, a `.canopi` Design of version 10 or later, for the read-only
/// view, as JSON: `{"read":{"view":…,"saved_by_version":10}}`, or
/// `{"refused":{"kind":"newer_version","message":…,"field_path":"$.plants[0]"}}`
/// (`invalid_json` for text that is no JSON, else `newer_version` or
/// `invalid_document` as `canopi-format` settles them, 2.1-M481).
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
    // The view serialises as it does to the Desktop interface; a failure here
    // is no answer the worker can map, and it says so as a malformed answer.
    serde_json::to_string(&answer).unwrap_or_else(|_| String::from("{}"))
}

#[cfg(test)]
mod tests;
