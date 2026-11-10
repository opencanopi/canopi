pub mod design_notebook;
pub(crate) mod plant_catalog_connection;
pub(crate) mod plant_filter_fields;
pub mod query_builder;
pub mod recent_files;
pub(crate) mod schema_contract;
mod set_aside_reason;
pub(crate) mod species_search_normalization;
#[cfg(test)]
pub(crate) mod test_support;
pub mod user_db;

use canopi_types::failure::{Failure, FailureCode, PlantCatalogCause};
use canopi_types::health::{PlantDbStatus, StoreHealth, StoreOpenStatus};
use canopi_types::sensitive::UserPath;
use rusqlite::{Connection, InterruptHandle};
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

pub use set_aside_reason::SetAsideReason;
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
            log_plant_db_unavailable(
                PlantCatalogCause::OpenFailed,
                &format!("the bundled plant database was rejected: {error}"),
            );
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
    /// [`UserDbInitError::NewerSchemaVersion`]. The user DB's entry in
    /// `SubsystemHealth` comes back with it.
    pub fn open(path: impl AsRef<Path>) -> Result<(Self, StoreHealth), UserDbInitError> {
        let path = path.as_ref();
        let error = match Self::initialize(Connection::open(path).map_err(UserDbInitError::Open)?) {
            Ok(user_db) => {
                let ready = StoreHealth {
                    status: StoreOpenStatus::Ready,
                    notice: None,
                };
                return Ok((user_db, ready));
            }
            Err(error) => error,
        };
        let reason = match error {
            UserDbInitError::OlderSchemaVersion { .. } => SetAsideReason::Before2_0,
            _ if error.sets_aside_as_corrupt() => SetAsideReason::Corrupt,
            _ => return Err(error),
        };
        let aside = set_aside_user_db(path, &set_aside_name(path, reason))
            .map_err(|source| UserDbInitError::SetAside { reason, source })?;
        // The set-aside name is Canopi's own (`user.db.corrupt-<seconds>`), never
        // the folder it sits in.
        let file = aside
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        tracing::warn!(
            "Set aside the user database ({error}) as {file}; starting with an empty one"
        );
        let user_db = Self::initialize(Connection::open(path).map_err(UserDbInitError::Open)?)?;
        Ok((user_db, reason.health(file)))
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
                format!("no free name to set {} aside", UserPath::from(path)),
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

/// Locks `mutex`, recovering it once when a panicking command left it poisoned: the poison is
/// cleared so the recovery settles once per panic, not on every later read.
pub fn acquire<'a, T>(mutex: &'a Mutex<T>, name: &str) -> MutexGuard<'a, T> {
    mutex.lock().unwrap_or_else(|e| {
        let failure = Failure::new(FailureCode::Internal, LOCK_OP).with_english(&format!(
            "recovered the poisoned {name} lock; a prior command panicked while holding it"
        ));
        crate::logging::log_failure(&failure, None);
        mutex.clear_poison();
        e.into_inner()
    })
}

/// The op of recovering a lock a panicking command left poisoned.
const LOCK_OP: &str = canopi_types::failure::ops::DB_LOCK;

/// The op of opening and admitting the bundled plant catalog at startup.
pub(crate) const PLANT_CATALOG_OPEN_OP: &str = canopi_types::failure::ops::PLANT_CATALOG_OPEN;

/// The plant catalog is unavailable for `cause`, through the failure logger; `english` is
/// redacted, so a path formatted into it reads `<path>` (canopi-ouxd).
pub(crate) fn log_plant_db_unavailable(cause: PlantCatalogCause, english: &str) {
    let failure = Failure::new(
        FailureCode::PlantDbUnavailable { cause },
        PLANT_CATALOG_OPEN_OP,
    );
    crate::logging::log_failure(&failure.with_english(english), None);
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

    /// Makes `path`'s `-shm` companion a directory and each name it could move to for `reason` a
    /// dangling link, so `UserDb::open`'s set-aside fails late; returns the refusal's reason.
    #[cfg(unix)]
    fn refusal_with_the_set_aside_blocked(path: &Path, reason: SetAsideReason) -> SetAsideReason {
        std::fs::create_dir(with_suffix(path, "-shm")).unwrap();
        let base = set_aside_name(path, reason);
        let (prefix, seconds) = base.rsplit_once('-').unwrap();
        let seconds: u64 = seconds.parse().unwrap();
        for second in seconds..seconds + 60 {
            let blocked = path.with_file_name(format!("{prefix}-{second}-shm"));
            std::os::unix::fs::symlink("nowhere", blocked).unwrap();
        }
        match UserDb::open(path) {
            Err(UserDbInitError::SetAside { reason, .. }) => reason,
            other => panic!("refused as a failed set-aside: {:?}", other.err()),
        }
    }

    /// NAT-02: the set-aside of a damaged database fails after the database itself moved.
    #[cfg(unix)]
    #[test]
    fn nat_02_a_set_aside_that_fails_moves_the_database_back_and_refuses_startup() {
        let scratch = TestScratch::new("db-nat-02-a-set-aside-that-fails");
        let path = temp_database_path(&scratch, "stuck");
        std::fs::write(&path, b"damaged database").unwrap();

        let reason = refusal_with_the_set_aside_blocked(&path, SetAsideReason::Corrupt);

        assert_eq!(reason, SetAsideReason::Corrupt);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"damaged database",
            "moved back"
        );
        assert!(
            with_suffix(&path, "-shm").is_dir(),
            "its companion stays in place"
        );
    }

    /// canopi-f47t.52.41: a healthy pre-2.0 user DB whose set-aside fails (a data folder Canopi
    /// cannot write to) is refused as pre-2.0, and its startup message never calls it damaged.
    #[cfg(unix)]
    #[test]
    fn canopi_f47t_52_41_a_pre_2_0_user_db_that_cannot_be_moved_aside_is_not_called_damaged() {
        let scratch = TestScratch::new("db-a-pre-2-0-set-aside-that-fails");
        let path = temp_database_path(&scratch, "stuck-before-2-0");
        Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE TABLE favorites (id INTEGER); PRAGMA user_version = 1;")
            .unwrap();

        let reason = refusal_with_the_set_aside_blocked(&path, SetAsideReason::Before2_0);

        assert_eq!(reason, SetAsideReason::Before2_0);
        assert_eq!(
            reason.startup_refusal(),
            "Canopi could not move its earlier data file aside to start fresh. Check that the Canopi data folder can be written to, then start Canopi again.",
        );
    }

    #[test]
    fn nat_02_a_busy_or_failing_user_db_is_refused_never_set_aside() {
        use rusqlite::ffi::{Error, SQLITE_BUSY, SQLITE_CORRUPT, SQLITE_IOERR_READ, SQLITE_LOCKED};
        let failure = |code| rusqlite::Error::SqliteFailure(Error::new(code), None);
        let wrappers: [fn(rusqlite::Error) -> UserDbInitError; 4] = [
            UserDbInitError::ReadSchemaVersion,
            UserDbInitError::ConfigureForeignKeys,
            UserDbInitError::CreateSchema,
            UserDbInitError::VerifyIntegrity,
        ];
        for (code, wrap) in [SQLITE_BUSY, SQLITE_LOCKED, SQLITE_IOERR_READ]
            .into_iter()
            .flat_map(|code| wrappers.map(|wrap| (code, wrap)))
        {
            let error = wrap(failure(code));
            assert!(!error.sets_aside_as_corrupt(), "{code}: {error}");
        }
        assert!(UserDbInitError::VerifyIntegrity(failure(SQLITE_CORRUPT)).sets_aside_as_corrupt());
    }

    #[test]
    fn set_aside_with_no_free_name_fails_without_naming_the_database_path() {
        let scratch = TestScratch::new("db-set-aside-no-free-name");
        let path = temp_database_path(&scratch, "full");
        std::fs::write(&path, b"damaged database").unwrap();

        let error = move_aside(&path, std::iter::empty(), &USER_DB_COMPANION_SUFFIXES).unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(error.to_string(), "no free name to set <path> aside");
        assert_eq!(std::fs::read(&path).unwrap(), b"damaged database");
    }

    #[test]
    fn canopi_f47t_52_35_a_rejected_plant_db_and_a_poisoned_lock_settle_once_through_the_logger() {
        let rejected = crate::logging::lines_of(|| {
            let _ = PlantDb::available(Connection::open_in_memory().unwrap());
        });
        assert!(
            rejected.iter().any(|line| line["level"] == "WARN"
                && line["settlement"] == "plant_db_unavailable"
                && line["code"].as_str().unwrap().contains("open_failed")),
            "{rejected:?}"
        );
        let unopened = crate::logging::lines_of(|| {
            let db = Path::new("/home/ana/Applications/canopi/resources/canopi-core.db");
            let english = format!("the plant DB at {} could not be opened", db.display());
            log_plant_db_unavailable(PlantCatalogCause::OpenFailed, &english);
        });
        assert_eq!(
            unopened[0]["detail"], "the plant DB at <path> could not be opened",
            "canopi-ouxd: {unopened:?}"
        );
        let lock = Arc::new(Mutex::new(()));
        let held = Arc::clone(&lock);
        let _ = std::thread::spawn(move || {
            let _guard = held.lock().unwrap();
            panic!("a command panicked holding the lock");
        })
        .join();
        let poisoned = crate::logging::lines_of(|| {
            drop(acquire(&lock, "UserDb"));
            drop(acquire(&lock, "UserDb"));
        });
        let recovered: Vec<_> = poisoned.iter().filter(|l| l["op"] == "db.lock").collect();
        assert_eq!(recovered.len(), 1, "logged once per panic: {poisoned:?}");
        assert_eq!(recovered[0]["level"], "ERROR");
        assert_eq!(recovered[0]["settlement"], "internal");
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
