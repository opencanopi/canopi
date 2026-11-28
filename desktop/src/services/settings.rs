//! The Desktop settings store (`settings.json` + write-once `settings.before-reset.json`,
//! `2e-2`, ADR 0024, ADR 0026, `2.1-Q373`, `2.1-M550`).
//!
//! - **File authority.** Record 2 (`"version": 2`) lives in `data_dir/settings.json`, published
//!   exclusively through `canopi_support::durable::publish_durably`.
//! - **Migrate-once from SQLite.** When `settings.json` is absent, Desktop reads the legacy v2.0
//!   `settings` and `updater.check_at_launch` rows from `user.db` (read-only), folds them into
//!   record 2, and writes `settings.json` durably while leaving SQLite rows untouched for
//!   emergency rollback to v2.0.5 (`2.1-Q373`, `2.1-M550`). Once `settings.json` exists, it
//!   always wins on re-upgrade.
//! - **Per-field reset.** Malformed individual fields reset only those fields, keeping every
//!   valid field (including `google_maps_api_key`) and unknown keys intact, writing the original
//!   raw JSON write-once to `settings.before-reset.json` (`Precondition::NotExists`), and saving
//!   the repaired record 2 back to `settings.json`.
//! - **Newer-read-only.** A record whose integer `version` exceeds `SETTINGS_CHAIN.current()`
//!   (v3+) decodes known fields per-field without writing a byte and refuses all writes with
//!   `StoreReadOnly { store: StoreId::Settings }` (`"store_read_only"`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use canopi_support::durable::{
    DurableError, OsDurableFs, Precondition, PublishSource, TargetLocks, publish_durably,
};
use canopi_types::health::{StoreHealth, StoreOpenStatus};
use canopi_types::settings::{Locale, ScrollWheel, Settings};
use canopi_types::store_chain::SETTINGS_CHAIN;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::db::{self, UserDb};
use crate::services::settings_record::{
    ParsedRecord, default_unit_system_for_locale, migrate_v1_object_to_v2, parse_raw_record,
    read_file_if_exists, unit_system_value, validate_special_field,
};
use crate::target_locks::temporary_target_locks;

/// Durable settings file name inside `app_data_dir()`.
pub const SETTINGS_FILE_NAME: &str = "settings.json";

/// Write-once backup of the raw settings record before its first reset.
pub const SETTINGS_BEFORE_RESET_FILE_NAME: &str = "settings.before-reset.json";

/// Legacy SQLite key folded into record 2's `launch_check` on first migration.
const UPDATER_CHECK_AT_LAUNCH_KEY: &str = "updater.check_at_launch";

/// Snapshot returned by `get_settings_record` for the TS settings interpreter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SettingsRecordSnapshot {
    /// Stored JSON object (always includes `"version"`, known fields, and any unknown keys).
    pub record: Map<String, Value>,
    /// Field keys reset during this read (empty when clean or newer-read-only).
    pub reset_fields: Vec<String>,
    /// True when the stored record was written by a newer Canopi (writes are refused).
    pub newer_read_only: bool,
}

/// A settings write that did not land.
#[derive(Debug, PartialEq, Eq)]
pub enum SettingsWriteError {
    /// The settings refuse writes for this session: saved by a newer Canopi, or in a read-only user DB.
    ReadOnly,
    /// The write failed; the text names what failed.
    Failed(String),
}

/// The text a String command rejects with: `store_read_only`, settled silently, for a refused write.
impl From<SettingsWriteError> for String {
    fn from(error: SettingsWriteError) -> Self {
        match error {
            SettingsWriteError::ReadOnly => "store_read_only".to_owned(),
            SettingsWriteError::Failed(text) => text,
        }
    }
}

/// Desktop settings store backed by `data_dir/settings.json` with one-time SQLite migration.
#[derive(Clone)]
pub struct DesktopSettingsStore {
    data_dir: PathBuf,
    user_db: UserDb,
    locks: Arc<TargetLocks>,
}

impl DesktopSettingsStore {
    /// Creates a store rooted at `data_dir` with `user_db` used only for one-time migration.
    pub fn new(data_dir: impl Into<PathBuf>, user_db: UserDb) -> Self {
        Self {
            data_dir: data_dir.into(),
            user_db,
            locks: Arc::clone(temporary_target_locks()),
        }
    }

    /// Path to `settings.json`.
    pub fn settings_path(&self) -> PathBuf {
        self.data_dir.join(SETTINGS_FILE_NAME)
    }

    /// Path to write-once `settings.before-reset.json`.
    pub fn before_reset_path(&self) -> PathBuf {
        self.data_dir.join(SETTINGS_BEFORE_RESET_FILE_NAME)
    }

    /// Reads the typed v1 `Settings` view from `settings.json` (migrating once if absent).
    pub fn get_settings(&self) -> Result<Settings, String> {
        self.get_settings_with_env(sys_locale::get_locale().as_deref(), std::env::consts::OS)
    }

    /// Reads the full record 2 snapshot (including `unit_system`, `launch_check`,
    /// `last_open_home`, unknown keys, `reset_fields`, and `newer_read_only`).
    pub fn get_settings_record(&self) -> Result<SettingsRecordSnapshot, String> {
        self.get_settings_record_with_env(sys_locale::get_locale().as_deref(), std::env::consts::OS)
    }

    /// Merges `patch` into `settings.json`, preserving untouched fields and unknown keys.
    pub fn patch_settings_record(
        &self,
        patch: Map<String, Value>,
    ) -> Result<(), SettingsWriteError> {
        self.patch_settings_record_with_env(
            patch,
            sys_locale::get_locale().as_deref(),
            std::env::consts::OS,
        )
    }

    /// Saves the typed v1 `Settings` fields as a patch onto `settings.json`, preserving
    /// record-2 fields (`unit_system`, `launch_check`, `last_open_home`) and unknown keys.
    #[cfg(test)]
    pub fn set_settings(&self, settings: Settings) -> Result<(), String> {
        let Ok(Value::Object(patch)) = serde_json::to_value(&settings) else {
            return Err("Failed to serialize settings".to_owned());
        };
        self.patch_settings_record(patch).map_err(String::from)
    }

    fn get_settings_with_env(
        &self,
        detected_os_locale: Option<&str>,
        os: &str,
    ) -> Result<Settings, String> {
        let snapshot = self.get_settings_record_with_env(detected_os_locale, os)?;
        Ok(decode_v1_settings(&snapshot.record))
    }

    fn get_settings_record_with_env(
        &self,
        detected_os_locale: Option<&str>,
        os: &str,
    ) -> Result<SettingsRecordSnapshot, String> {
        let settings_path = self.settings_path();
        if let Some(raw_bytes) = read_file_if_exists(&settings_path)
            .map_err(|e| format!("Failed to read settings file: {e}"))?
        {
            let raw = String::from_utf8_lossy(&raw_bytes).into_owned();
            return self.process_existing_file(&raw, detected_os_locale, os);
        }

        // Migrate-once from SQLite user.db (read-only; never mutates SQLite).
        let can_write_file = self.user_db.acquire_writable().is_some();
        let conn = self.user_db.acquire();
        let legacy_row = db::user_db::get_setting(&conn, "settings")
            .map_err(|e| format!("Failed to read legacy settings: {e}"))?;
        let legacy_launch = db::user_db::get_setting(&conn, UPDATER_CHECK_AT_LAUNCH_KEY)
            .map_err(|e| format!("Failed to read legacy launch check: {e}"))?;
        drop(conn);

        match legacy_row {
            None => {
                let mut record = build_default_record(detected_os_locale, os);
                if let Some(raw_launch) = legacy_launch.as_deref() {
                    record.insert(
                        "launch_check".to_owned(),
                        Value::Bool(raw_launch != "false"),
                    );
                }
                if can_write_file {
                    self.write_settings_file(&record)
                        .map_err(|e| format!("Failed to save initial settings: {e}"))?;
                }
                Ok(SettingsRecordSnapshot {
                    record,
                    reset_fields: Vec::new(),
                    newer_read_only: !can_write_file,
                })
            }
            Some(raw) => self.migrate_legacy_row(
                &raw,
                legacy_launch.as_deref(),
                can_write_file,
                detected_os_locale,
                os,
            ),
        }
    }

    fn process_existing_file(
        &self,
        raw: &str,
        detected_os_locale: Option<&str>,
        os: &str,
    ) -> Result<SettingsRecordSnapshot, String> {
        match parse_raw_record(raw) {
            ParsedRecord::Newer(map) => Ok(SettingsRecordSnapshot {
                record: decode_newer_record(&map, detected_os_locale, os),
                reset_fields: Vec::new(),
                newer_read_only: true,
            }),
            ParsedRecord::Current(map) => {
                let (repaired, reset_fields) =
                    validate_and_repair_record(map, detected_os_locale, os, false);
                if !reset_fields.is_empty() {
                    self.write_before_reset_once(raw.as_bytes());
                    self.write_settings_file(&repaired)
                        .map_err(|e| format!("Failed to save repaired settings: {e}"))?;
                    log_settings_reset(&format!(
                        "Reset invalid settings fields ({}); preserved valid fields",
                        reset_fields.join(",")
                    ));
                }
                Ok(SettingsRecordSnapshot {
                    record: repaired,
                    reset_fields,
                    newer_read_only: false,
                })
            }
            ParsedRecord::Migratable(map) => {
                let migrated = migrate_v1_object_to_v2(map, None, detected_os_locale);
                let (repaired, reset_fields) =
                    validate_and_repair_record(migrated, detected_os_locale, os, false);
                if !reset_fields.is_empty() {
                    self.write_before_reset_once(raw.as_bytes());
                    log_settings_reset(&format!(
                        "Reset invalid settings fields during migration ({}); preserved valid fields",
                        reset_fields.join(",")
                    ));
                }
                self.write_settings_file(&repaired)
                    .map_err(|e| format!("Failed to save migrated settings: {e}"))?;
                Ok(SettingsRecordSnapshot {
                    record: repaired,
                    reset_fields,
                    newer_read_only: false,
                })
            }
            ParsedRecord::Unreadable(location) => {
                self.write_before_reset_once(raw.as_bytes());
                // The record may hold a credential, so only the parse position is logged.
                log_settings_reset(&format!(
                    "Set aside unreadable settings ({location}); using defaults"
                ));
                let defaults = build_default_record(detected_os_locale, os);
                self.write_settings_file(&defaults)
                    .map_err(|e| format!("Failed to save default settings: {e}"))?;
                Ok(SettingsRecordSnapshot {
                    record: defaults,
                    reset_fields: vec!["*".to_owned()],
                    newer_read_only: false,
                })
            }
        }
    }

    fn migrate_legacy_row(
        &self,
        raw: &str,
        legacy_launch: Option<&str>,
        can_write_file: bool,
        detected_os_locale: Option<&str>,
        os: &str,
    ) -> Result<SettingsRecordSnapshot, String> {
        match parse_raw_record(raw) {
            ParsedRecord::Newer(map) => Ok(SettingsRecordSnapshot {
                record: decode_newer_record(&map, detected_os_locale, os),
                reset_fields: Vec::new(),
                newer_read_only: true,
            }),
            ParsedRecord::Current(map) | ParsedRecord::Migratable(map) => {
                let migrated = migrate_v1_object_to_v2(map, legacy_launch, detected_os_locale);
                let (repaired, reset_fields) =
                    validate_and_repair_record(migrated, detected_os_locale, os, false);
                if can_write_file {
                    if !reset_fields.is_empty() {
                        self.write_before_reset_once(raw.as_bytes());
                        log_settings_reset(&format!(
                            "Reset invalid legacy settings fields during migration ({}); preserved valid fields",
                            reset_fields.join(",")
                        ));
                    }
                    self.write_settings_file(&repaired)
                        .map_err(|e| format!("Failed to save migrated settings: {e}"))?;
                }
                Ok(SettingsRecordSnapshot {
                    record: repaired,
                    reset_fields,
                    newer_read_only: !can_write_file,
                })
            }
            ParsedRecord::Unreadable(location) => {
                let mut defaults = build_default_record(detected_os_locale, os);
                if let Some(raw_launch) = legacy_launch {
                    defaults.insert(
                        "launch_check".to_owned(),
                        Value::Bool(raw_launch != "false"),
                    );
                }
                if can_write_file {
                    self.write_before_reset_once(raw.as_bytes());
                    log_settings_reset(&format!(
                        "Set aside unreadable legacy settings ({location}); using defaults"
                    ));
                    self.write_settings_file(&defaults)
                        .map_err(|e| format!("Failed to save default settings: {e}"))?;
                }
                Ok(SettingsRecordSnapshot {
                    record: defaults,
                    reset_fields: if can_write_file {
                        vec!["*".to_owned()]
                    } else {
                        Vec::new()
                    },
                    newer_read_only: !can_write_file,
                })
            }
        }
    }

    fn patch_settings_record_with_env(
        &self,
        patch: Map<String, Value>,
        detected_os_locale: Option<&str>,
        os: &str,
    ) -> Result<(), SettingsWriteError> {
        let snapshot = self
            .get_settings_record_with_env(detected_os_locale, os)
            .map_err(SettingsWriteError::Failed)?;
        if snapshot.newer_read_only {
            return Err(SettingsWriteError::ReadOnly);
        }
        let mut merged = snapshot.record;
        for (key, value) in patch {
            if key == "version" {
                continue;
            }
            merged.insert(key, value);
        }
        merged.insert("version".to_owned(), Value::from(SETTINGS_CHAIN.current()));
        self.write_settings_file(&merged)
            .map_err(|e| SettingsWriteError::Failed(format!("Failed to save settings: {e}")))
    }

    fn write_settings_file(&self, record: &Map<String, Value>) -> Result<(), String> {
        if let Err(error) = std::fs::create_dir_all(&self.data_dir) {
            return Err(format!("could not create data folder: {error}"));
        }
        let bytes = serde_json::to_vec_pretty(&Value::Object(record.clone()))
            .map_err(|e| format!("serialize settings: {e}"))?;
        publish_durably(
            &OsDurableFs,
            &self.locks,
            PublishSource::Bytes(&bytes),
            &self.settings_path(),
            "settings",
            Precondition::Any,
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    /// Writes `raw` to `settings.before-reset.json` only if it does not already exist.
    fn write_before_reset_once(&self, raw: &[u8]) {
        if std::fs::create_dir_all(&self.data_dir).is_err() {
            return;
        }
        let result = publish_durably(
            &OsDurableFs,
            &self.locks,
            PublishSource::Bytes(raw),
            &self.before_reset_path(),
            "settings-before-reset",
            Precondition::NotExists,
        );
        if let Err(error) = result
            && !matches!(error, DurableError::AlreadyExists)
        {
            tracing::info!("Could not write settings.before-reset.json: {error}");
        }
    }
}

/// Logs a settings reset notice without ever including raw settings content or credentials.
fn log_settings_reset(message: &str) {
    tracing::warn!("{message}");
}

/// Inspects `StoreId::Settings` startup health without writing any bytes.
pub(crate) fn inspect_settings_health(
    data_dir: &Path,
    user_db: &UserDb,
    user_db_health: &StoreHealth,
) -> StoreHealth {
    let settings_path = data_dir.join(SETTINGS_FILE_NAME);
    if let Ok(Some(bytes)) = read_file_if_exists(&settings_path) {
        let raw = String::from_utf8_lossy(&bytes);
        let status = match parse_raw_record(&raw) {
            ParsedRecord::Newer(_) => StoreOpenStatus::NewerReadOnly,
            _ => StoreOpenStatus::Ready,
        };
        return StoreHealth {
            status,
            notice: None,
        };
    }

    let mut status = match &user_db_health.status {
        StoreOpenStatus::SetAsideDamaged { .. } | StoreOpenStatus::Recovered { .. } => {
            StoreOpenStatus::Ready
        }
        other => other.clone(),
    };
    if status == StoreOpenStatus::Ready && legacy_row_is_newer(user_db) {
        status = StoreOpenStatus::NewerReadOnly;
    }
    StoreHealth {
        status,
        notice: None,
    }
}

fn legacy_row_is_newer(user_db: &UserDb) -> bool {
    let row = db::user_db::get_setting(&user_db.acquire(), "settings");
    matches!(row, Ok(Some(raw)) if matches!(parse_raw_record(&raw), ParsedRecord::Newer(_)))
}

fn build_default_record(detected_os_locale: Option<&str>, os: &str) -> Map<String, Value> {
    let mut settings = Settings::default();
    if let Some(locale) = detect_initial_locale(detected_os_locale) {
        settings.locale = locale;
    }
    if os == "macos" {
        settings.scroll_wheel = ScrollWheel::Pan;
    }
    let mut map = match serde_json::to_value(&settings) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    map.insert("version".to_owned(), Value::from(SETTINGS_CHAIN.current()));
    map.insert(
        "unit_system".to_owned(),
        unit_system_value(default_unit_system_for_locale(detected_os_locale)),
    );
    map.insert("last_open_home".to_owned(), Value::Null);
    map.insert("launch_check".to_owned(), Value::Bool(true));
    map
}

/// Validates every known field of record 2 individually: valid fields and unknown keys are
/// kept intact; invalid fields are replaced with their defaults and recorded in `reset_fields`.
fn validate_and_repair_record(
    mut record: Map<String, Value>,
    detected_os_locale: Option<&str>,
    os: &str,
    keep_newer_version: bool,
) -> (Map<String, Value>, Vec<String>) {
    // Also fold legacy frozen `check_updates_at_launch` alias when `launch_check` is absent.
    if !record.contains_key("launch_check")
        && let Some(alias) = record.remove("check_updates_at_launch")
    {
        record.insert("launch_check".to_owned(), alias);
    }

    let defaults = build_default_record(detected_os_locale, os);
    let mut reset_fields = Vec::new();

    for (key, default_value) in &defaults {
        if key == "version" {
            continue;
        }
        let Some(stored) = record.get(key) else {
            record.insert(key.clone(), default_value.clone());
            continue;
        };
        let validated = match validate_special_field(key, stored) {
            Some(result) => result,
            None => {
                let alone = Value::Object(Map::from_iter([(key.clone(), stored.clone())]));
                serde_json::from_value::<Settings>(alone)
                    .ok()
                    .map(|_| stored.clone())
            }
        };
        match validated {
            Some(normalized) => {
                record.insert(key.clone(), normalized);
            }
            None => {
                record.insert(key.clone(), default_value.clone());
                reset_fields.push(key.clone());
            }
        }
    }

    if !keep_newer_version {
        record.insert("version".to_owned(), Value::from(SETTINGS_CHAIN.current()));
    }

    (record, reset_fields)
}

fn decode_newer_record(
    record: &Map<String, Value>,
    detected_os_locale: Option<&str>,
    os: &str,
) -> Map<String, Value> {
    let (decoded, _ignored_resets) =
        validate_and_repair_record(record.clone(), detected_os_locale, os, true);
    decoded
}

fn decode_v1_settings(record: &Map<String, Value>) -> Settings {
    let Ok(Value::Object(mut known)) = serde_json::to_value(Settings::default()) else {
        return Settings::default();
    };
    for (key, slot) in &mut known {
        let Some(stored) = record.get(key) else {
            continue;
        };
        let alone = Value::Object(Map::from_iter([(key.clone(), stored.clone())]));
        if serde_json::from_value::<Settings>(alone).is_ok() {
            *slot = stored.clone();
        }
    }
    serde_json::from_value(Value::Object(known)).unwrap_or_default()
}

fn detect_initial_locale(os_locale: Option<&str>) -> Option<Locale> {
    canopi_types::locale::match_locale(os_locale)
}

// Legacy compatibility helpers for in-memory reader-release tests that operate directly on `UserDb`.
#[cfg(test)]
pub(crate) fn get_settings(user_db: &UserDb) -> Result<Settings, String> {
    let scratch = crate::test_scratch::TestScratch::new("settings-compat-read");
    DesktopSettingsStore::new(scratch.path(), user_db.clone()).get_settings()
}

#[cfg(test)]
pub(crate) fn set_settings(user_db: &UserDb, settings: Settings) -> Result<(), String> {
    let scratch = crate::test_scratch::TestScratch::new("settings-compat-write");
    DesktopSettingsStore::new(scratch.path(), user_db.clone()).set_settings(settings)
}

#[cfg(test)]
pub(crate) fn record_is_newer(user_db: &UserDb) -> bool {
    legacy_row_is_newer(user_db)
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
