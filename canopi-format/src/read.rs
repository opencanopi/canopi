//! Lightweight streaming root-version check for refusing writes over Designs saved by a
//! newer Canopi (`2.1-M410`, `2.1-Q347`).
//!
//! The Step 2.0.4 read-only view (`read_newer_design`) was deleted at 2b-5 per `2.1-Q347`:
//! from 2.1.0, any `.canopi` file newer than [`CURRENT_CANOPI_FILE_VERSION`] is refused
//! unchanged.

use canopi_types::design::CURRENT_CANOPI_FILE_VERSION;
use serde_json::Value;

/// Whether `reader` holds a JSON object whose root `version` is an integer above
/// [`CURRENT_CANOPI_FILE_VERSION`] (saved by a newer Canopi). Only the root `version` is
/// decoded, every other value skipped as it streams past, so the check costs one sequential
/// read. Bytes that are no JSON object, or whose version is missing, not an integer or not
/// above this build's, return `Ok(false)`.
///
/// # Errors
///
/// The reader's I/O error: what could not be read cannot be shown not to be newer.
pub fn saved_by_newer(reader: impl std::io::Read) -> std::io::Result<bool> {
    #[derive(serde::Deserialize)]
    struct RootVersion {
        version: Option<Value>,
    }
    match serde_json::from_reader::<_, RootVersion>(reader) {
        Ok(root) => Ok(root.version.as_ref().is_some_and(|version| {
            let above = u64::from(CURRENT_CANOPI_FILE_VERSION);
            version.as_u64().is_some_and(|version| version > above)
                || version.as_f64().is_some_and(|version| {
                    version.is_finite() && version.fract() == 0.0 && version > above as f64
                })
        })),
        Err(error) if error.is_io() => Err(error.into()),
        Err(_) => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::saved_by_newer;
    use canopi_types::design::CURRENT_CANOPI_FILE_VERSION;

    #[test]
    fn saved_by_newer_flags_only_integer_versions_above_current() {
        let current = format!(r#"{{"version": {CURRENT_CANOPI_FILE_VERSION}}}"#);
        let newer = format!(r#"{{"version": {}}}"#, CURRENT_CANOPI_FILE_VERSION + 1);
        let older = format!(r#"{{"version": {}}}"#, CURRENT_CANOPI_FILE_VERSION - 1);
        assert!(!saved_by_newer(current.as_bytes()).unwrap());
        assert!(saved_by_newer(newer.as_bytes()).unwrap());
        assert!(!saved_by_newer(older.as_bytes()).unwrap());
        assert!(!saved_by_newer(b"not json".as_slice()).unwrap());
    }
}
