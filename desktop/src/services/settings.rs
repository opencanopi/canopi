//! The Desktop settings record, a row of the user DB, and the launch check beside it.
//!
//! Record 1 is the form this build writes: no `version` key, read strictly. A record whose top-level integer `version`
//! is 2 or more was saved by a newer Canopi (2.1-M480): its known fields are decoded one by one, an unknown literal or a
//! retyped value taking that field's default and unknown keys ignored; it is never set aside and never written, so a
//! change applies for the session only (2.1-Q320), and the settings report newer-read-only on their own, whatever the
//! user DB's mode (A16, `services::health`). Its launch-check field is `check_updates_at_launch`, named for good.

use std::fmt::Display;

use canopi_types::settings::{Locale, ScrollWheel, Settings};
use serde_json::{Map, Value};

use crate::db::{self, UserDb};

pub fn get_settings(user_db: &UserDb) -> Result<Settings, String> {
    get_settings_with_locale(
        user_db,
        sys_locale::get_locale().as_deref(),
        std::env::consts::OS,
    )
}

/// Saves the record; a refused write rejects with the silent `store_read_only` (2.1-M487).
pub fn set_settings(user_db: &UserDb, settings: Settings) -> Result<(), String> {
    let conn = user_db
        .acquire_writable()
        .ok_or(SettingsWriteError::ReadOnly)?;
    refuse_newer(db::user_db::get_setting(&conn, "settings"))?;
    let json = serde_json::to_string(&settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    db::user_db::set_setting(&conn, "settings", &json)
        .map_err(db::user_db::write_refusal("Failed to save settings"))
}

/// The first record `version` a newer Canopi writes; record 1 carries none.
const NEWER_RECORD_VERSION: u64 = 2;

/// Record 2's launch-check field (2.1-M480).
const CHECK_UPDATES_AT_LAUNCH_FIELD: &str = "check_updates_at_launch";

/// The settings row as this build reads it.
enum StoredSettings {
    /// No row: a first run.
    Missing,
    /// Record 1, read strictly.
    Current(Settings),
    /// Record 2 or later, as stored.
    Newer(Map<String, Value>),
    /// A row that is neither, with its text and the strict parse's error.
    Unreadable(String, serde_json::Error),
}

/// The settings row, as `db::user_db::get_setting` answers it, read as this build reads it.
fn read_stored(row: Result<Option<String>, impl Display>) -> Result<StoredSettings, String> {
    let Some(serialized) = row.map_err(|e| format!("Failed to read settings: {e}"))? else {
        return Ok(StoredSettings::Missing);
    };
    if let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&serialized)
        && record
            .get("version")
            .and_then(Value::as_u64)
            .is_some_and(|version| version >= NEWER_RECORD_VERSION)
    {
        return Ok(StoredSettings::Newer(record));
    }
    Ok(match deserialize_settings(&serialized) {
        Ok(settings) => StoredSettings::Current(settings),
        Err(error) => StoredSettings::Unreadable(serialized, error),
    })
}

/// A newer record's known fields, each decoded alone: one that does not decode keeps its default.
fn decode_newer(record: &Map<String, Value>) -> Settings {
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

/// [`SettingsWriteError::ReadOnly`] when the settings row is a newer Canopi's; the caller holds a writable connection.
fn refuse_newer(row: Result<Option<String>, impl Display>) -> Result<(), SettingsWriteError> {
    match read_stored(row).map_err(SettingsWriteError::Failed)? {
        StoredSettings::Newer(_) => Err(SettingsWriteError::ReadOnly),
        _ => Ok(()),
    }
}

/// The launch check's own user-DB key row (2.1-Q164, 2.1-M206): read and written only by the
/// updater, never a field of the settings record, so a whole-record `set_settings` leaves it
/// alone. Interim until 2e moves it (2.1-Q239, canopi-f47t.52.56).
const UPDATER_CHECK_AT_LAUNCH_KEY: &str = "updater.check_at_launch";

/// Whether the updater checks at launch: record 2's field under a newer record, else the key row; missing or
/// unreadable reads on.
pub fn updater_check_at_launch(user_db: &UserDb) -> Result<bool, String> {
    let conn = user_db.acquire();
    if let StoredSettings::Newer(record) = read_stored(db::user_db::get_setting(&conn, "settings"))?
    {
        let field = record.get(CHECK_UPDATES_AT_LAUNCH_FIELD);
        return Ok(field.and_then(Value::as_bool).unwrap_or(true));
    }
    let stored = db::user_db::get_setting(&conn, UPDATER_CHECK_AT_LAUNCH_KEY)
        .map_err(|e| format!("Failed to read the launch check setting: {e}"))?;
    Ok(stored.as_deref() != Some("false"))
}

/// A settings write that did not land.
#[derive(Debug, PartialEq, Eq)]
pub enum SettingsWriteError {
    /// The settings refuse writes for this session: saved by a newer Canopi, or in a user DB that refuses writes.
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

/// Stores whether the updater checks at launch; refused under a newer record, whose own field holds it.
pub fn set_updater_check_at_launch(user_db: &UserDb, on: bool) -> Result<(), SettingsWriteError> {
    let conn = user_db
        .acquire_writable()
        .ok_or(SettingsWriteError::ReadOnly)?;
    refuse_newer(db::user_db::get_setting(&conn, "settings"))?;
    db::user_db::set_setting(
        &conn,
        UPDATER_CHECK_AT_LAUNCH_KEY,
        if on { "true" } else { "false" },
    )
    .map_err(|e| {
        SettingsWriteError::Failed(format!("Failed to save the launch check setting: {e}"))
    })
}

/// Settings key that keeps the last settings record this build refused.
const SET_ASIDE_SETTINGS_KEY: &str = "settings.set-aside";

/// Read Desktop settings.
///
/// One rule covers every invalid value of record 1: it is read strictly,
/// and a record that does not parse (malformed JSON, an unknown theme, locale
/// or basemap style, a wrong type) is set aside under
/// [`SET_ASIDE_SETTINGS_KEY`] and replaced by defaults. Unknown keys are not
/// invalid; they are ignored and never re-emitted. A newer record is decoded
/// field by field and never written; while the user DB refuses writes, a
/// missing or unreadable record gives the defaults, neither set aside nor saved.
///
/// `os` is `std::env::consts::OS`, a parameter so tests choose it: the first-run
/// record on macOS starts on Trackpad (2.1-Q309). `Settings::default()` stays
/// host-independent because generated bindings are built from it.
fn get_settings_with_locale(
    user_db: &UserDb,
    detected_os_locale: Option<&str>,
    os: &str,
) -> Result<Settings, String> {
    let (conn, writable) = match user_db.acquire_writable() {
        Some(conn) => (conn, true),
        None => (user_db.acquire(), false),
    };
    let refused = match read_stored(db::user_db::get_setting(&conn, "settings"))? {
        StoredSettings::Current(settings) => return Ok(settings),
        StoredSettings::Newer(record) => return Ok(decode_newer(&record)),
        StoredSettings::Unreadable(serialized, error) => Some((serialized, error)),
        StoredSettings::Missing => None,
    };

    let mut settings = Settings::default();
    if let Some(locale) = detect_initial_locale(detected_os_locale) {
        settings.locale = locale;
    }
    if os == "macos" {
        settings.scroll_wheel = ScrollWheel::Pan;
    }
    if !writable {
        return Ok(settings);
    }
    let json = serde_json::to_string(&settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    let transaction = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to save initial settings: {e}"))?;
    if let Some((serialized, error)) = &refused {
        db::user_db::set_setting(&transaction, SET_ASIDE_SETTINGS_KEY, serialized)
            .map_err(|e| format!("Failed to set aside invalid settings: {e}"))?;
        // The record may hold a credential, so only the parse position is logged.
        tracing::warn!(
            "Set aside unreadable settings (line {}, column {}); using defaults",
            error.line(),
            error.column()
        );
    }
    db::user_db::set_setting(&transaction, "settings", &json)
        .map_err(|e| format!("Failed to save initial settings: {e}"))?;
    transaction
        .commit()
        .map_err(|e| format!("Failed to save initial settings: {e}"))?;
    Ok(settings)
}

fn deserialize_settings(serialized: &str) -> Result<Settings, serde_json::Error> {
    serde_json::from_str(serialized)
}

fn detect_initial_locale(os_locale: Option<&str>) -> Option<Locale> {
    let code = os_locale?
        .split(['_', '-'])
        .next()
        .unwrap_or("en")
        .to_lowercase();

    match code.as_str() {
        "fr" => Some(Locale::Fr),
        "es" => Some(Locale::Es),
        "pt" => Some(Locale::Pt),
        "it" => Some(Locale::It),
        "zh" => Some(Locale::Zh),
        "de" => Some(Locale::De),
        "ja" => Some(Locale::Ja),
        "ko" => Some(Locale::Ko),
        "nl" => Some(Locale::Nl),
        "ru" => Some(Locale::Ru),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        get_settings_with_locale, set_settings, set_updater_check_at_launch,
        updater_check_at_launch,
    };
    use crate::db::UserDb;
    use canopi_types::settings::{BasemapStyle, Locale, ScrollWheel, Settings, Theme};
    use rusqlite::Connection;

    fn test_user_db() -> UserDb {
        let conn = Connection::open_in_memory().unwrap();
        UserDb::initialize(conn).unwrap()
    }

    #[test]
    fn missing_fields_take_their_defaults() {
        let settings = super::deserialize_settings(
            r#"{"locale":"en","theme":"light","basemap_visible":true}"#,
        )
        .unwrap();

        assert_eq!(settings.basemap_style, BasemapStyle::Liberty);
    }

    fn store_raw_settings(user_db: &UserDb, raw: &str) {
        let conn = user_db.acquire();
        crate::db::user_db::set_setting(&conn, "settings", raw).unwrap();
    }

    fn stored_setting(user_db: &UserDb, key: &str) -> Option<String> {
        let conn = user_db.acquire();
        crate::db::user_db::get_setting(&conn, key).unwrap()
    }

    #[test]
    fn an_invalid_settings_record_is_set_aside_and_replaced_by_defaults() {
        for raw in [
            r#"{"locale":"en","theme":"sepia","google_maps_api_key":"SECRET-KEY"}"#,
            r#"{"locale":"xx","google_maps_api_key":"SECRET-KEY"}"#,
            r#"{"basemap_style":"ocean","google_maps_api_key":"SECRET-KEY"}"#,
            r#"{"google_maps_api_key":"SECRET-KEY""#,
        ] {
            let user_db = test_user_db();
            store_raw_settings(&user_db, raw);

            let (settings, logs) = crate::services::design_files::capture_logs(|| {
                get_settings_with_locale(&user_db, Some("fr_FR"), "linux")
            });
            let settings = settings.expect("invalid settings must not fail forever");

            assert_eq!(settings.theme, Theme::Light, "{raw}");
            assert_eq!(settings.locale, Locale::Fr, "{raw}");
            assert_eq!(settings.google_maps_api_key, None, "{raw}");
            assert_eq!(
                stored_setting(&user_db, super::SET_ASIDE_SETTINGS_KEY).as_deref(),
                Some(raw)
            );
            assert!(logs.contains("Set aside unreadable settings"), "{logs}");
            assert!(!logs.contains("SECRET-KEY"), "{logs}");

            let reread = get_settings_with_locale(&user_db, Some("en_US"), "linux").unwrap();
            assert_eq!(reread.locale, Locale::Fr, "defaults were persisted");
        }
    }

    #[test]
    fn initializes_and_persists_detected_locale_on_first_read() {
        let user_db = test_user_db();

        let settings = get_settings_with_locale(&user_db, Some("fr_FR"), "linux").unwrap();

        assert_eq!(settings.locale, Locale::Fr);

        let persisted = get_settings_with_locale(&user_db, Some("en_US"), "linux").unwrap();
        assert_eq!(persisted.locale, Locale::Fr);
    }

    #[test]
    fn saves_settings_round_trip() {
        let user_db = test_user_db();
        let settings = Settings {
            locale: Locale::De,
            theme: Theme::Dark,
            basemap_style: BasemapStyle::Dark,
            side_panel_width: Some(444),
            saved_stamps_frame_height: Some(260),
            ..Default::default()
        };

        set_settings(&user_db, settings.clone()).unwrap();

        let stored = get_settings_with_locale(&user_db, Some("en_US"), "linux").unwrap();
        assert_eq!(stored.locale, Locale::De);
        assert_eq!(stored.theme, Theme::Dark);
        assert_eq!(stored.basemap_style, BasemapStyle::Dark);
        assert_eq!(stored.side_panel_width, Some(444));
        assert_eq!(stored.saved_stamps_frame_height, Some(260));
    }

    /// The record 2.0.3 writes whole when its user changes any setting (every field of its
    /// `Settings`, here with the theme changed): it knows nothing of the launch check.
    const SETTINGS_RECORD_2_0_3: &str = r#"{"locale":"en","theme":"dark","snap_to_grid":true,
        "side_panel_width":null,"saved_stamps_frame_height":null,"basemap_style":"liberty",
        "basemap_visible":true,"basemap_opacity":1.0,"satellite_visible":false,
        "satellite_opacity":1.0,"google_maps_api_key":null,"satellite_source":null,
        "contour_visible":false,"contour_opacity":1.0,"contour_interval":0,
        "hillshade_visible":false,"hillshade_opacity":0.55,"soften_background":false,
        "plant_spacing_interval_m":0.5,"last_view":null,"used_canvas_tools":[],
        "tool_names_visible":null,"single_key_shortcuts":true,"scroll_wheel":"zoom",
        "new_design_satellite":false,"new_design_symbol_scale":1.0,"new_design_labels":"names"}"#;

    /// plan:192, 2.1-M206: a beta user who reinstalls 2.0.3 and changes a setting there, then
    /// comes back to 2.1, keeps the launch check they turned off. The updater lane's 2.0.3 run
    /// only starts 2.0.3, which writes no valid record when idle, so this is the guard.
    #[test]
    fn a_2_0_3_whole_settings_record_write_leaves_the_launch_check_row() {
        let user_db = test_user_db();
        assert!(
            updater_check_at_launch(&user_db).unwrap(),
            "a missing row reads on"
        );
        set_settings(&user_db, Settings::default()).unwrap();
        set_updater_check_at_launch(&user_db, false).unwrap();

        store_raw_settings(&user_db, SETTINGS_RECORD_2_0_3);

        assert!(!updater_check_at_launch(&user_db).unwrap());
        assert_eq!(
            get_settings_with_locale(&user_db, Some("en_US"), "linux")
                .unwrap()
                .theme,
            Theme::Dark
        );
        set_updater_check_at_launch(&user_db, true).unwrap();
        assert!(updater_check_at_launch(&user_db).unwrap());
    }

    fn stored_keys(record: &str) -> Vec<String> {
        let value: serde_json::Value = serde_json::from_str(record).unwrap();
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    }

    /// 2.1-Q309: a new Mac profile starts on Trackpad; the record it writes is the record every
    /// first launch writes (no new key, 2.1-M473), and "pan" is the literal 2.0.3 already reads.
    #[test]
    fn u_canopi_pqxl_macos_first_launch_defaults_the_pointing_device_to_trackpad() {
        let user_db = test_user_db();

        let settings = get_settings_with_locale(&user_db, Some("en_US"), "macos").unwrap();

        assert_eq!(settings.scroll_wheel, ScrollWheel::Pan);
        let stored = stored_setting(&user_db, "settings").expect("first launch stores the record");
        let value: serde_json::Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(value["scroll_wheel"], "pan", "2.0.3 reads the literal pan");
        assert_eq!(
            stored_keys(&stored),
            stored_keys(&serde_json::to_string(&Settings::default()).unwrap()),
            "no new stored key"
        );
        assert_eq!(
            Settings::default().scroll_wheel,
            ScrollWheel::Zoom,
            "the host-independent default stays Mouse"
        );
        assert_eq!(
            get_settings_with_locale(&user_db, Some("en_US"), "linux")
                .unwrap()
                .scroll_wheel,
            ScrollWheel::Pan,
            "the stored choice is kept"
        );
    }

    #[test]
    fn u_canopi_pqxl_a_set_aside_record_on_macos_defaults_to_trackpad() {
        let user_db = test_user_db();
        store_raw_settings(&user_db, r#"{"theme":"sepia","scroll_wheel":"zoom"}"#);

        let settings = get_settings_with_locale(&user_db, Some("en_US"), "macos").unwrap();

        assert_eq!(settings.scroll_wheel, ScrollWheel::Pan);
        assert!(stored_setting(&user_db, super::SET_ASIDE_SETTINGS_KEY).is_some());
    }

    #[test]
    fn u_canopi_pqxl_an_existing_zoom_record_on_macos_stays_mouse() {
        let user_db = test_user_db();
        store_raw_settings(&user_db, SETTINGS_RECORD_2_0_3);

        let settings = get_settings_with_locale(&user_db, Some("en_US"), "macos").unwrap();

        assert_eq!(settings.scroll_wheel, ScrollWheel::Zoom);
        assert_eq!(
            stored_setting(&user_db, "settings").as_deref(),
            Some(SETTINGS_RECORD_2_0_3),
            "the stored record is not rewritten"
        );
    }

    fn all_rows(user_db: &UserDb) -> Vec<(String, String)> {
        let conn = user_db.acquire();
        let mut rows = conn.prepare("SELECT key, value FROM settings").unwrap();
        let rows = rows.query_map([], |row| Ok((row.get(0)?, row.get(1)?)));
        rows.unwrap().map(Result::unwrap).collect()
    }

    /// A field 2.1 retypes or gives a literal this build lacks takes that field's default; the rest apply, nothing is
    /// set aside and nothing written (2.1-M480).
    #[test]
    fn r2_canopi_f47t_52_271_settings_record_2_with_an_unknown_literal_or_a_retyped_field_takes_that_fields_default()
     {
        let user_db = test_user_db();
        store_raw_settings(
            &user_db,
            r#"{"version":3,"locale":"de","theme":7,"basemap_style":"terrain","side_panel_width":"wide",
            "scroll_wheel":"fling","snap_to_grid":false,"check_updates_at_launch":"no","unit_system":"us"}"#,
        );
        let before = all_rows(&user_db);

        let read = get_settings_with_locale(&user_db, Some("fr_FR"), "macos").unwrap();

        assert_eq!((read.locale, read.snap_to_grid), (Locale::De, false));
        assert_eq!(
            (read.theme, read.basemap_style, read.side_panel_width),
            (Theme::Light, BasemapStyle::Liberty, None)
        );
        assert_eq!(read.scroll_wheel, ScrollWheel::Zoom, "the field's default");
        assert!(updater_check_at_launch(&user_db).unwrap());
        assert_eq!(all_rows(&user_db), before, "nothing set aside or written");
    }

    /// Record 2 can sit in user DB 9 on beta profiles (A16): the user DB stays writable and only the settings refuse.
    #[test]
    fn r2_canopi_f47t_52_271_user_db_9_with_settings_record_2_refuses_only_the_settings_writes() {
        let user_db = test_user_db();
        store_raw_settings(&user_db, r#"{"version":2,"theme":"dark"}"#);
        let before = all_rows(&user_db);

        assert_eq!(
            set_settings(&user_db, Settings::default()),
            Err("store_read_only".to_owned())
        );
        assert_eq!(
            set_updater_check_at_launch(&user_db, false),
            Err(super::SettingsWriteError::ReadOnly)
        );
        assert_eq!(all_rows(&user_db), before);
        let starred = crate::services::plant_browser::toggle_favorite(&user_db, "Malus".into());
        assert!(
            starred.is_ok(),
            "the user DB itself is writable: {starred:?}"
        );
    }

    /// Record 1, with no version or `version` 1, reads strictly and is written as before, the launch check on its row.
    #[test]
    fn r2_canopi_f47t_52_271_settings_record_1_is_unchanged() {
        let user_db = test_user_db();
        store_raw_settings(&user_db, r#"{"version":1,"theme":"sepia"}"#);
        get_settings_with_locale(&user_db, None, "linux").unwrap();
        assert!(stored_setting(&user_db, super::SET_ASIDE_SETTINGS_KEY).is_some());

        store_raw_settings(
            &user_db,
            r#"{"theme":"dark","check_updates_at_launch":false}"#,
        );
        assert!(
            updater_check_at_launch(&user_db).unwrap(),
            "record 1 has no such field"
        );
        set_updater_check_at_launch(&user_db, false).unwrap();
        assert!(!updater_check_at_launch(&user_db).unwrap());
        set_settings(&user_db, Settings::default()).unwrap();
        assert!(
            !stored_setting(&user_db, "settings")
                .unwrap()
                .contains("version")
        );
    }

    #[test]
    fn u_canopi_pqxl_other_systems_start_on_mouse() {
        for os in ["windows", "linux"] {
            let user_db = test_user_db();
            let settings = get_settings_with_locale(&user_db, Some("en_US"), os).unwrap();
            assert_eq!(settings.scroll_wheel, ScrollWheel::Zoom, "{os}");
        }
    }
}
