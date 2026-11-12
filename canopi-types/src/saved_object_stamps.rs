//! A Saved Object Stamp: a named, ordered payload of placed objects kept in
//! the user database for reuse across Designs.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct SavedObjectStamp {
    pub id: String,
    pub name: String,
    pub payload_json: String,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
    /// The payload is newer than this build reads (above v2): listed as needing a newer Canopi, never placed,
    /// renamed, reordered or deleted (2.1-M88). Computed by the owner's listing query; absent reads as false.
    #[serde(default)]
    #[specta(optional)]
    pub needs_newer: bool,
}
