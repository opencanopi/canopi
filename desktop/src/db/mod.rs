pub mod design_notebook;
pub(crate) mod plant_catalog_connection;
pub(crate) mod plant_filter_fields;
pub mod query_builder;
pub mod recent_files;
pub(crate) mod schema_contract;
pub(crate) mod species_search_normalization;
#[cfg(test)]
pub(crate) mod test_support;
pub mod user_db;

use common_types::health::PlantDbStatus;
use rusqlite::{Connection, InterruptHandle};
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

pub use user_db::UserDbInitError;

/// Plant database availability boundary.
///
/// When the bundled plant DB is missing or corrupt, the app shell still starts,
/// but species-dependent services must fail explicitly instead of receiving a
/// fake in-memory connection that looks usable.
#[derive(Clone)]
pub struct PlantDb(PlantDbState);

#[derive(Clone)]
enum PlantDbState {
    Available {
        connection: Arc<Mutex<Connection>>,
        interrupt: Arc<InterruptHandle>,
    },
    Missing,
    Corrupt,
}

impl PlantDb {
    pub fn available(connection: Connection) -> Self {
        if let Err(error) = plant_catalog_connection::admit_prepared_catalog(&connection) {
            tracing::error!("Rejected bundled plant database: {error}");
            return Self(PlantDbState::Corrupt);
        }
        let interrupt = Arc::new(connection.get_interrupt_handle());
        Self(PlantDbState::Available {
            connection: Arc::new(Mutex::new(connection)),
            interrupt,
        })
    }

    pub fn missing() -> Self {
        Self(PlantDbState::Missing)
    }

    pub fn corrupt() -> Self {
        Self(PlantDbState::Corrupt)
    }

    pub fn status(&self) -> PlantDbStatus {
        match &self.0 {
            PlantDbState::Available { .. } => PlantDbStatus::Available,
            PlantDbState::Missing => PlantDbStatus::Missing,
            PlantDbState::Corrupt => PlantDbStatus::Corrupt,
        }
    }

    pub fn interrupt_handle(&self) -> Option<Arc<InterruptHandle>> {
        match &self.0 {
            PlantDbState::Available { interrupt, .. } => Some(Arc::clone(interrupt)),
            PlantDbState::Missing | PlantDbState::Corrupt => None,
        }
    }
}

pub(crate) struct PlantDbConnectionGuard<'a>(MutexGuard<'a, Connection>);

impl Deref for PlantDbConnectionGuard<'_> {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

/// User database — writable, serialized access via Mutex.
#[derive(Clone)]
pub struct UserDb(Arc<Mutex<Connection>>);

/// How [`UserDb::open`] found the file it opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserDbOpened {
    /// A current database, or a new one where there was none.
    Ready,
    /// A database from before Canopi 2.0 was moved aside (ADR 0021); the user
    /// is told once.
    MovedAside,
    /// A damaged database was set aside as corrupt.
    ReplacedCorrupt,
}

/// Why a database file is set aside: the suffix its new name carries.
#[derive(Debug, Clone, Copy)]
enum SetAsideReason {
    Before2_0,
    Corrupt,
}

impl SetAsideReason {
    fn suffix(self) -> &'static str {
        match self {
            Self::Before2_0 => "before-2.0",
            Self::Corrupt => "corrupt",
        }
    }
}

impl UserDb {
    /// Open the user database at `path`.
    ///
    /// Canopi 2.0 breaks stored data (ADR 0021): a database from before 2.0
    /// is renamed to `<file>.before-2.0-<unix-seconds>` and replaced by an
    /// empty current one. A file that is not a SQLite database, is damaged
    /// or fails its integrity checks is renamed to
    /// `<file>.corrupt-<unix-seconds>` the same way. Neither rename
    /// overwrites an earlier one, and companion files move with the database.
    /// A newer database is refused as-is with
    /// [`UserDbInitError::NewerSchemaVersion`].
    pub fn open(path: impl AsRef<Path>) -> Result<(Self, UserDbOpened), UserDbInitError> {
        let path = path.as_ref();
        let error = match Self::initialize(Connection::open(path).map_err(UserDbInitError::Open)?) {
            Ok(user_db) => return Ok((user_db, UserDbOpened::Ready)),
            Err(error) => error,
        };
        let (reason, opened) = match error {
            UserDbInitError::OlderSchemaVersion { .. } => {
                (SetAsideReason::Before2_0, UserDbOpened::MovedAside)
            }
            _ if error.sets_aside_as_corrupt() => {
                (SetAsideReason::Corrupt, UserDbOpened::ReplacedCorrupt)
            }
            _ => return Err(error),
        };
        let aside = set_aside_user_db(path, &set_aside_name(path, reason))
            .map_err(|source| UserDbInitError::SetAside { source })?;
        tracing::warn!(
            "Set aside the user database ({error}) as {}; starting with an empty one",
            aside
                .file_name()
                .map(|name| name.to_string_lossy())
                .unwrap_or_default()
        );
        let user_db = Self::initialize(Connection::open(path).map_err(UserDbInitError::Open)?)?;
        Ok((user_db, opened))
    }

    pub fn initialize(connection: Connection) -> Result<Self, UserDbInitError> {
        user_db::initialize_connection(&connection)?;
        Ok(Self(Arc::new(Mutex::new(connection))))
    }

    pub(crate) fn acquire(&self) -> MutexGuard<'_, Connection> {
        acquire(&self.0, "UserDb")
    }
}

/// SQLite companion files that belong to a database file and move with it.
/// The user DB uses the rollback journal; `-wal`/`-shm` are moved too in case
/// another tool switched the file to WAL.
const USER_DB_COMPANION_SUFFIXES: [&str; 3] = ["-journal", "-wal", "-shm"];

fn set_aside_name(path: &Path, reason: SetAsideReason) -> String {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "user.db".to_owned());
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{file_name}.{}-{seconds}", reason.suffix())
}

/// Rename the database at `path` and its companion files to `base`, or to
/// `base-<n>` when that name is taken. Either everything moves or, on failure,
/// what moved is moved back.
fn set_aside_user_db(path: &Path, base: &str) -> std::io::Result<PathBuf> {
    let candidates = (1u32..=10_000).map(|attempt| match attempt {
        1 => path.with_file_name(base),
        n => path.with_file_name(format!("{base}-{n}")),
    });
    move_aside(path, candidates, &USER_DB_COMPANION_SUFFIXES)
}

/// Move the database at `path` and each of its `companions` (name suffixes
/// such as `-wal`) to the first candidate that is free for all of them.
/// Either everything moves or, on failure, what moved is moved back: a
/// companion left behind would be applied to a fresh database at `path`.
pub(crate) fn move_aside(
    path: &Path,
    mut candidates: impl Iterator<Item = PathBuf>,
    companions: &[&str],
) -> std::io::Result<PathBuf> {
    let companion = |target: &Path, suffix: &str| {
        let mut name = target.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    };
    let aside = candidates
        .find(|candidate| {
            !candidate.exists()
                && companions
                    .iter()
                    .all(|suffix| !companion(candidate, suffix).exists())
        })
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("no free name to set {} aside", path.display()),
            )
        })?;

    std::fs::rename(path, &aside)?;
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for suffix in companions {
        let from = companion(path, suffix);
        if !from.exists() {
            continue;
        }
        let to = companion(&aside, suffix);
        if let Err(error) = std::fs::rename(&from, &to) {
            let mut rollback_errors = Vec::new();
            for (original, renamed) in moved.iter().rev() {
                if let Err(rollback) = std::fs::rename(renamed, original) {
                    rollback_errors.push(rollback.to_string());
                }
            }
            if let Err(rollback) = std::fs::rename(&aside, path) {
                rollback_errors.push(rollback.to_string());
            }
            return Err(if rollback_errors.is_empty() {
                std::io::Error::new(
                    error.kind(),
                    format!("could not move the {suffix} companion file: {error}"),
                )
            } else {
                std::io::Error::new(
                    error.kind(),
                    format!(
                        "could not move the {suffix} companion file: {error}; restoring the original files also failed: {}",
                        rollback_errors.join("; ")
                    ),
                )
            });
        }
        moved.push((from, to));
    }
    Ok(aside)
}

pub fn acquire<'a, T>(mutex: &'a Mutex<T>, name: &str) -> MutexGuard<'a, T> {
    mutex.lock().unwrap_or_else(|e| {
        tracing::warn!("Recovered poisoned {name} lock; a prior command panicked while holding it");
        e.into_inner()
    })
}

pub fn plant_db_unavailable_error(status: PlantDbStatus) -> String {
    match status {
        PlantDbStatus::Available => "Plant database unavailable".to_owned(),
        PlantDbStatus::Missing => {
            "Plant database unavailable: bundled plant database is missing".to_owned()
        }
        PlantDbStatus::Corrupt => {
            "Plant database unavailable: bundled plant database is corrupt".to_owned()
        }
    }
}

pub(crate) fn require_plant_db(plant_db: &PlantDb) -> Result<PlantDbConnectionGuard<'_>, String> {
    match &plant_db.0 {
        PlantDbState::Available { connection, .. } => {
            Ok(PlantDbConnectionGuard(acquire(connection, "PlantDb")))
        }
        PlantDbState::Missing => Err(plant_db_unavailable_error(PlantDbStatus::Missing)),
        PlantDbState::Corrupt => Err(plant_db_unavailable_error(PlantDbStatus::Corrupt)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_scratch::TestScratch;

    fn connection_with_identity(schema_version: i32, fingerprint: &str) -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        plant_catalog_connection::stamp_expected_prepared_identity(&connection);
        connection
            .execute(
                "UPDATE species_search_metadata SET value = ?2 WHERE key = ?1",
                ("normalization_fingerprint", fingerprint),
            )
            .unwrap();
        connection
            .pragma_update(None, "user_version", schema_version)
            .unwrap();
        connection
    }

    fn temp_database_path(scratch: &TestScratch, label: &str) -> PathBuf {
        scratch.join(format!("set_aside_{label}.db"))
    }

    fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    }

    #[test]
    fn set_aside_moves_the_rollback_journal_with_the_database() {
        let scratch = TestScratch::new("db-set-aside-moves-the-rollback-journal-with-the-database");
        let path = temp_database_path(&scratch, "journal");
        std::fs::write(&path, b"damaged database").unwrap();
        std::fs::write(with_suffix(&path, "-journal"), b"rollback journal").unwrap();

        let aside =
            set_aside_user_db(&path, &set_aside_name(&path, SetAsideReason::Corrupt)).unwrap();

        assert!(!path.exists());
        assert!(
            !with_suffix(&path, "-journal").exists(),
            "a journal left behind would be applied to the fresh database"
        );
        assert!(
            aside
                .file_name()
                .unwrap()
                .to_string_lossy()
                .contains(".corrupt-")
        );
        assert_eq!(std::fs::read(&aside).unwrap(), b"damaged database");
        assert_eq!(
            std::fs::read(with_suffix(&aside, "-journal")).unwrap(),
            b"rollback journal"
        );

        let _ = std::fs::remove_file(&aside);
        let _ = std::fs::remove_file(with_suffix(&aside, "-journal"));
    }

    #[test]
    fn set_aside_never_overwrites_an_earlier_set_aside_or_its_journal() {
        let scratch =
            TestScratch::new("db-set-aside-never-overwrites-an-earlier-set-aside-or-its-journal");
        let path = temp_database_path(&scratch, "unique");
        let base = format!("{}.corrupt-0", path.file_name().unwrap().to_string_lossy());
        std::fs::write(&path, b"first").unwrap();
        let first = set_aside_user_db(&path, &base).unwrap();
        // An orphan journal of an earlier set-aside name also blocks that name.
        std::fs::write(
            with_suffix(
                &path.with_file_name(format!(
                    "{}-2",
                    first.file_name().unwrap().to_string_lossy()
                )),
                "-journal",
            ),
            b"orphan",
        )
        .unwrap();
        std::fs::write(&path, b"second").unwrap();
        let second = set_aside_user_db(&path, &base).unwrap();

        assert_ne!(first, second);
        assert!(
            second.to_string_lossy().ends_with(".corrupt-0-3"),
            "{second:?}"
        );
        assert_eq!(std::fs::read(&first).unwrap(), b"first");
        assert_eq!(std::fs::read(&second).unwrap(), b"second");

        for file in [
            first.clone(),
            second,
            with_suffix(
                &path.with_file_name(format!(
                    "{}-2",
                    first.file_name().unwrap().to_string_lossy()
                )),
                "-journal",
            ),
        ] {
            let _ = std::fs::remove_file(file);
        }
    }

    #[test]
    fn plant_db_rejects_stale_v12_without_normalization_identity() {
        let connection = Connection::open_in_memory().unwrap();
        connection.pragma_update(None, "user_version", 12).unwrap();

        assert_eq!(
            PlantDb::available(connection).status(),
            PlantDbStatus::Corrupt
        );
    }

    #[test]
    fn plant_db_rejects_current_schema_with_missing_normalization_identity() {
        let missing_table = Connection::open_in_memory().unwrap();
        missing_table
            .pragma_update(
                None,
                "user_version",
                schema_contract::EXPECTED_PLANT_SCHEMA_VERSION,
            )
            .unwrap();
        assert_eq!(
            PlantDb::available(missing_table).status(),
            PlantDbStatus::Corrupt
        );

        let missing_key = connection_with_identity(
            schema_contract::EXPECTED_PLANT_SCHEMA_VERSION,
            schema_contract::SPECIES_SEARCH_NORMALIZATION_FINGERPRINT,
        );
        missing_key
            .execute(
                "DELETE FROM species_search_metadata WHERE key = 'normalization_fingerprint'",
                [],
            )
            .unwrap();
        assert_eq!(
            PlantDb::available(missing_key).status(),
            PlantDbStatus::Corrupt
        );
    }

    #[test]
    fn plant_db_rejects_current_schema_with_any_wrong_embedded_identity() {
        for key in [
            "schema_version",
            "storage_contract_fingerprint",
            "normalization_version",
            "normalization_fingerprint",
        ] {
            let connection = connection_with_identity(
                schema_contract::EXPECTED_PLANT_SCHEMA_VERSION,
                schema_contract::SPECIES_SEARCH_NORMALIZATION_FINGERPRINT,
            );
            connection
                .execute(
                    "UPDATE species_search_metadata SET value = 'wrong' WHERE key = ?1",
                    [key],
                )
                .unwrap();

            assert_eq!(
                PlantDb::available(connection).status(),
                PlantDbStatus::Corrupt,
                "wrong {key} was admitted",
            );
        }
    }

    #[test]
    fn plant_db_accepts_exact_schema_and_normalization_identity() {
        let connection = connection_with_identity(
            schema_contract::EXPECTED_PLANT_SCHEMA_VERSION,
            schema_contract::SPECIES_SEARCH_NORMALIZATION_FINGERPRINT,
        );

        assert_eq!(
            PlantDb::available(connection).status(),
            PlantDbStatus::Available
        );
    }

    #[test]
    fn plant_db_rejects_duplicate_or_extra_identity_keys() {
        let duplicate = Connection::open_in_memory().unwrap();
        plant_catalog_connection::stamp_expected_prepared_identity(&duplicate);
        duplicate
            .execute_batch(
                "ALTER TABLE species_search_metadata RENAME TO original_identity;
                CREATE TABLE species_search_metadata (key TEXT, value TEXT NOT NULL);
                INSERT INTO species_search_metadata SELECT key, value FROM original_identity;
                INSERT INTO species_search_metadata
                    SELECT key, value FROM original_identity
                    WHERE key = 'normalization_fingerprint';",
            )
            .unwrap();
        assert_eq!(
            PlantDb::available(duplicate).status(),
            PlantDbStatus::Corrupt
        );

        let extra = Connection::open_in_memory().unwrap();
        plant_catalog_connection::stamp_expected_prepared_identity(&extra);
        extra
            .execute(
                "INSERT INTO species_search_metadata (key, value) VALUES ('unexpected', 'value')",
                [],
            )
            .unwrap();
        assert_eq!(PlantDb::available(extra).status(), PlantDbStatus::Corrupt);
    }
}
