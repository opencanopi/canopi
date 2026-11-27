//! Geocoding host allowlist shared by Rust and TypeScript (`2.1-M142`, contracts §18 R16).

/// Hosts that require Canopi's identifying User-Agent and route through `geocoder_fetch`.
pub const GEOCODER_IDENTIFIED_HOSTS: &[&str] = &["nominatim.openstreetmap.org"];
