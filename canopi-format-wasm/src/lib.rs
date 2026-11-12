//! The Web format worker's module (ADR 0025 format worker; contracts §18 F28):
//! `canopi-format` behind wasm-bindgen, every result a JSON string, loaded on
//! first need by `desktop/web/src/platform/design-core.worker.ts`, the one
//! importer of its glue (`wasm-glue-only-in-adapter`). Desktop reads natively
//! and never loads it (2.1-M476).
//!
//! Step 2.0.4 R1-1 is its probe: the module links `canopi-types` and the
//! `canopi-redact` leaf, so its release size is the worker's size budget
//! (`web wasm: canopi_format_wasm_bg` in policy/ratchets/bundle-size.json), and
//! [`probe`] proves it instantiates and runs in every engine Canopi supports.
//! The read entry points replace [`probe`] in R1-6.

use canopi_redact::{RedactedText, Redactor};
use canopi_types::design::CURRENT_CANOPI_FILE_VERSION;
use serde::Serialize;
use wasm_bindgen::prelude::wasm_bindgen;

/// What [`probe`] answers, as JSON.
#[derive(Debug, Serialize)]
struct ProbeAnswer {
    /// The newest `.canopi` format version this build writes.
    current_version: u32,
    /// The probe's text through the generic redactor.
    redacted: RedactedText,
}

/// The probe call: `text` redacted by the generic redactor, beside the
/// current format version, as JSON
/// (`{"current_version":9,"redacted":"<path>"}`), so one call proves the
/// module instantiated and that `canopi-types` and `canopi-redact` run in it.
#[wasm_bindgen]
pub fn probe(text: &str) -> String {
    let answer = ProbeAnswer {
        current_version: CURRENT_CANOPI_FILE_VERSION,
        redacted: Redactor::generic().redact(text),
    };
    // A struct of a number and a string always serialises; the fallback is
    // still JSON, which the worker reports as a malformed answer.
    serde_json::to_string(&answer).unwrap_or_else(|_| String::from("{}"))
}

#[cfg(test)]
mod tests;
