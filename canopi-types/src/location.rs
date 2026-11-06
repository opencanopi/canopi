//! A geocoding result: a place name and its WGS84 position.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct GeoResult {
    pub display_name: String,
    pub lat: f64,
    pub lon: f64,
}
