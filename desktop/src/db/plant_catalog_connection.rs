use std::collections::BTreeMap;

use rusqlite::Connection;

use super::{schema_contract, species_search_normalization};

pub(super) fn admit_prepared_catalog(connection: &Connection) -> Result<(), String> {
    let schema_version = connection
        .pragma_query_value::<i32, _>(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("failed to read prepared schema version: {error}"))?;
    if schema_version != schema_contract::EXPECTED_PLANT_SCHEMA_VERSION {
        return Err(format!(
            "prepared schema version {schema_version} does not equal required {}",
            schema_contract::EXPECTED_PLANT_SCHEMA_VERSION,
        ));
    }

    verify_prepared_identity(connection)?;
    initialize_search_connection(connection)
}

pub(crate) fn initialize_search_connection(connection: &Connection) -> Result<(), String> {
    species_search_normalization::register_sqlite_function(connection)
        .map_err(|error| format!("failed to register Species Search normalization: {error}"))?;
    ensure_search_initialized(connection)
}

pub(crate) fn ensure_search_initialized(connection: &Connection) -> Result<(), String> {
    let normalized = connection
        .query_row(
            "SELECT canopi_normalize_species_search('Straße')",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("Species Search connection is not initialized: {error}"))?;
    if normalized != "strasse" {
        return Err(
            "Species Search connection is not initialized with the admitted normalization"
                .to_owned(),
        );
    }
    Ok(())
}

fn verify_prepared_identity(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("SELECT key, value FROM species_search_metadata")
        .map_err(|error| format!("failed to read prepared search identity: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("failed to query prepared search identity: {error}"))?;
    let mut values_by_key = BTreeMap::<String, Vec<String>>::new();
    for row in rows {
        let (key, value) =
            row.map_err(|error| format!("failed to decode prepared search identity: {error}"))?;
        values_by_key.entry(key).or_default().push(value);
    }

    let expected = [
        (
            "schema_version",
            schema_contract::EXPECTED_PLANT_SCHEMA_VERSION.to_string(),
        ),
        (
            "storage_contract_fingerprint",
            schema_contract::SPECIES_STORAGE_CONTRACT_FINGERPRINT.to_owned(),
        ),
        (
            "normalization_version",
            schema_contract::SPECIES_SEARCH_NORMALIZATION_VERSION.to_string(),
        ),
        (
            "normalization_fingerprint",
            schema_contract::SPECIES_SEARCH_NORMALIZATION_FINGERPRINT.to_owned(),
        ),
    ];
    for (key, expected_value) in expected {
        let values = values_by_key.remove(key).unwrap_or_default();
        match values.as_slice() {
            [actual] if actual == &expected_value => {}
            [] => return Err(format!("prepared search identity is missing key {key:?}")),
            [_] => {
                return Err(format!(
                    "prepared search identity {key:?} does not match the required value"
                ));
            }
            _ => {
                return Err(format!(
                    "prepared search identity contains duplicate key {key:?}"
                ));
            }
        }
    }
    if let Some((key, _)) = values_by_key.first_key_value() {
        return Err(format!(
            "prepared search identity contains unexpected key {key:?}"
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn stamp_expected_prepared_identity(connection: &Connection) {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS species_search_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            DELETE FROM species_search_metadata;",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO species_search_metadata (key, value) VALUES (?1, ?2)",
            (
                "schema_version",
                schema_contract::EXPECTED_PLANT_SCHEMA_VERSION.to_string(),
            ),
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO species_search_metadata (key, value) VALUES (?1, ?2)",
            (
                "storage_contract_fingerprint",
                schema_contract::SPECIES_STORAGE_CONTRACT_FINGERPRINT,
            ),
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO species_search_metadata (key, value) VALUES (?1, ?2)",
            (
                "normalization_version",
                schema_contract::SPECIES_SEARCH_NORMALIZATION_VERSION.to_string(),
            ),
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO species_search_metadata (key, value) VALUES (?1, ?2)",
            (
                "normalization_fingerprint",
                schema_contract::SPECIES_SEARCH_NORMALIZATION_FINGERPRINT,
            ),
        )
        .unwrap();
    connection
        .pragma_update(
            None,
            "user_version",
            schema_contract::EXPECTED_PLANT_SCHEMA_VERSION,
        )
        .unwrap();
}

/// The plant DB a run opens: `resource` is Tauri's bundled resource path.
/// A release build reads only its bundle. A debug build first reads the DB
/// `scripts/prepare-db.py` leaves under `desktop/resources/` of the tree it
/// runs in, then Tauri's resource copy: in an unbundled run that copy sits in
/// the Rust target, which several worktrees may share, and tauri-build
/// refreshes it only when the build script reruns, so it can be another
/// worktree's catalog (canopi-f47t.52.264).
#[cfg(debug_assertions)]
pub(crate) fn plant_db_path(resource: Option<std::path::PathBuf>) -> Option<std::path::PathBuf> {
    debug_plant_db_path(
        dev_plant_db_candidate(std::env::var_os("CARGO_MANIFEST_DIR")),
        resource,
        |path| path.exists(),
    )
}

#[cfg(not(debug_assertions))]
pub(crate) fn plant_db_path(resource: Option<std::path::PathBuf>) -> Option<std::path::PathBuf> {
    resource.filter(|path| path.exists())
}

#[cfg(any(debug_assertions, test))]
fn debug_plant_db_path(
    dev: std::path::PathBuf,
    resource: Option<std::path::PathBuf>,
    exists: impl Fn(&std::path::Path) -> bool,
) -> Option<std::path::PathBuf> {
    std::iter::once(dev)
        .chain(resource)
        .find(|path| exists(path))
}

/// The run-time `CARGO_MANIFEST_DIR` that `cargo run` and `cargo tauri dev`
/// set wins over the compiled one, because cargo does not rebuild a member
/// whose source only moved to another worktree (canopi-f47t.52.264).
#[cfg(any(debug_assertions, test))]
fn dev_plant_db_candidate(runtime_manifest_dir: Option<std::ffi::OsString>) -> std::path::PathBuf {
    runtime_manifest_dir
        .filter(|dir| !dir.is_empty())
        .map_or_else(
            || std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            std::path::PathBuf::from,
        )
        .join("resources")
        .join("canopi-core.db")
}

#[cfg(test)]
mod dev_plant_db_tests {
    /// canopi-f47t.52.264: one Rust target serves several worktrees and cargo
    /// does not rebuild a workspace member whose source only moved, so a debug
    /// build compiled in another worktree reads the catalog of the tree
    /// `cargo run` (or `cargo tauri dev`) launched it in.
    #[test]
    fn canopi_f47t_52_264_dev_plant_db_follows_the_run_time_manifest_dir() {
        let elsewhere = std::path::Path::new("/elsewhere/worktree/desktop");
        assert_eq!(
            super::dev_plant_db_candidate(Some(elsewhere.as_os_str().to_owned())),
            elsewhere.join("resources").join("canopi-core.db")
        );
        assert_eq!(
            super::dev_plant_db_candidate(None),
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/canopi-core.db")
        );
    }

    /// canopi-f47t.52.264: a debug build reads its own tree's catalog before
    /// Tauri's resource copy in a shared Rust target, which may be another
    /// worktree's; the copy stays the fallback.
    #[test]
    fn canopi_f47t_52_264_debug_build_reads_its_tree_catalog_before_the_resource_copy() {
        let dev = std::path::PathBuf::from("/worktree/desktop/resources/canopi-core.db");
        let copy = std::path::PathBuf::from("/shared/target/debug/resources/canopi-core.db");
        let both = |_: &std::path::Path| true;
        assert_eq!(
            super::debug_plant_db_path(dev.clone(), Some(copy.clone()), both),
            Some(dev.clone())
        );
        let only_copy = |path: &std::path::Path| path == copy.as_path();
        assert_eq!(
            super::debug_plant_db_path(dev.clone(), Some(copy.clone()), only_copy),
            Some(copy.clone())
        );
        assert_eq!(super::debug_plant_db_path(dev, Some(copy), |_| false), None);
    }
}
