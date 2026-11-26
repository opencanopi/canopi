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

    /// canopi-f47t.52.270: a store's write accessor asks whether the bytes it would replace or
    /// delete hold a Design saved by a newer Canopi (2.1-M410): only the root `version` decides,
    /// read past any value before it, and bytes no Canopi reads as a Design hold none.
    #[test]
    fn canopi_f47t_52_270_saved_by_newer_reads_only_the_root_version() {
        let newer = |text: &str| saved_by_newer(text.as_bytes()).expect("bytes read");
        let current = CURRENT_CANOPI_FILE_VERSION;
        let next = current + 1;
        assert!(newer(&format!(r#"{{"version": {next}}}"#)));
        let late = format!(
            r#"{{"plants": [{{"id": "p", "version": 1}}], "name": "Late", "version": {next}.0}}"#
        );
        assert!(
            newer(&late),
            "a version after other values, as an integral float"
        );
        for held in [
            format!(r#"{{"version": {current}, "name": "Current"}}"#),
            format!(r#"{{"version": {}, "name": "Older"}}"#, current - 1),
            r#"{"name": "No version"}"#.to_owned(),
            format!(r#"{{"version": "{next}"}}"#),
            format!(r#"{{"version": {current}.5}}"#),
            format!(r#"[{{"version": {next}}}]"#),
            format!(r#"{{"version": {next}"#),
            "not json".to_owned(),
            String::new(),
        ] {
            assert!(!newer(&held), "{held}");
        }
    }

    /// canopi-f47t.52.270: a read that fails is no answer, so the caller writes nothing.
    #[test]
    fn canopi_f47t_52_270_saved_by_newer_passes_a_read_error_on() {
        struct Failing;
        impl std::io::Read for Failing {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            }
        }
        let error = saved_by_newer(Failing).expect_err("the read failed");
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    }
}
