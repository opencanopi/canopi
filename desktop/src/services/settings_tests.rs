use super::*;
use crate::db::UserDb;
use crate::test_scratch::TestScratch;
use canopi_types::settings::{BasemapStyle, Locale, ScrollWheel, Settings, Theme};
use rusqlite::Connection;

fn test_user_db() -> UserDb {
    let conn = Connection::open_in_memory().unwrap();
    UserDb::initialize(conn).unwrap()
}

fn store_raw_sqlite(user_db: &UserDb, key: &str, raw: &str) {
    let conn = user_db.acquire();
    crate::db::user_db::set_setting(&conn, key, raw).unwrap();
}

fn read_sqlite(user_db: &UserDb, key: &str) -> Option<String> {
    let conn = user_db.acquire();
    crate::db::user_db::get_setting(&conn, key).unwrap()
}

fn all_sqlite_rows(user_db: &UserDb) -> Vec<(String, String)> {
    let conn = user_db.acquire();
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings ORDER BY key")
        .unwrap();
    stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn first_launch_creates_settings_json_v2_with_os_locale_region_and_pointing_device() {
    let scratch = TestScratch::new("settings-first-launch");
    let store = DesktopSettingsStore::new(scratch.path(), test_user_db());

    let snapshot = store
        .get_settings_record_with_env(Some("en_US"), "macos")
        .unwrap();

    assert!(!snapshot.newer_read_only);
    assert!(snapshot.reset_fields.is_empty());
    assert_eq!(snapshot.record["version"], 2);
    assert_eq!(snapshot.record["locale"], "en");
    assert_eq!(snapshot.record["unit_system"], "us_customary");
    assert_eq!(snapshot.record["scroll_wheel"], "pan");
    assert_eq!(snapshot.record["launch_check"], true);
    assert_eq!(snapshot.record["last_open_home"], Value::Null);
    assert!(store.settings_path().exists());
    assert!(!store.before_reset_path().exists());

    // Subsequent launch on another OS/locale preserves the stored settings.json values.
    let reread = store
        .get_settings_record_with_env(Some("fr_FR"), "linux")
        .unwrap();
    assert_eq!(reread.record["locale"], "en");
    assert_eq!(reread.record["unit_system"], "us_customary");
    assert_eq!(reread.record["scroll_wheel"], "pan");
}

/// 2.1-Q373 / 2.1-M547: migrate-once from SQLite `settings` + `updater.check_at_launch`
/// folds into `settings.json` v2, leaves SQLite rows byte-identical, and `settings.json`
/// wins on re-upgrade even if SQLite was edited during a rollback to v2.0.5.
#[test]
fn migrate_once_from_sqlite_folds_launch_check_leaves_sqlite_untouched_and_file_wins_on_reupgrade()
{
    let scratch = TestScratch::new("settings-migrate-once");
    let user_db = test_user_db();
    let legacy_json = r#"{"locale":"de","theme":"dark","satellite_provider":"eox","auto_save_interval_s":60,"google_maps_api_key":"AIzaKeepMe"}"#;
    store_raw_sqlite(&user_db, "settings", legacy_json);
    store_raw_sqlite(&user_db, "updater.check_at_launch", "false");
    let sqlite_before = all_sqlite_rows(&user_db);

    let store = DesktopSettingsStore::new(scratch.path(), user_db.clone());
    let snapshot = store
        .get_settings_record_with_env(Some("de_DE"), "linux")
        .unwrap();

    assert_eq!(snapshot.record["version"], 2);
    assert_eq!(snapshot.record["locale"], "de");
    assert_eq!(snapshot.record["theme"], "dark");
    assert_eq!(snapshot.record["launch_check"], false);
    assert_eq!(snapshot.record["unit_system"], "metric");
    assert_eq!(snapshot.record["google_maps_api_key"], "AIzaKeepMe");
    assert!(!snapshot.record.contains_key("satellite_provider"));
    assert!(!snapshot.record.contains_key("auto_save_interval_s"));
    assert_eq!(
        all_sqlite_rows(&user_db),
        sqlite_before,
        "SQLite rows remain byte-identical for v2.0.5 rollback"
    );

    // Simulate rollback to v2.0.5 editing SQLite theme back to light.
    store_raw_sqlite(&user_db, "settings", r#"{"locale":"fr","theme":"light"}"#);
    let after_reupgrade = store
        .get_settings_record_with_env(Some("en_US"), "linux")
        .unwrap();
    assert_eq!(
        after_reupgrade.record["theme"], "dark",
        "settings.json wins on re-upgrade"
    );
    assert_eq!(after_reupgrade.record["locale"], "de");
}

/// #409 B4: per-field reset keeps valid fields including `google_maps_api_key` and
/// unknown keys, writes original raw JSON write-once to `settings.before-reset.json`,
/// never logs the secret, and never overwrites `settings.before-reset.json` on a second reset.
#[test]
fn per_field_reset_keeps_valid_fields_and_secret_and_writes_before_reset_once() {
    let scratch = TestScratch::new("settings-per-field-reset");
    let store = DesktopSettingsStore::new(scratch.path(), test_user_db());
    let first_corrupt = r#"{"version":2,"locale":"xx","theme":"sepia","basemap_style":"ocean","unit_system":"furlongs","launch_check":"yes","last_open_home":"   ","google_maps_api_key":"SECRET-API-KEY-123","future_key":"kept"}"#;
    std::fs::write(store.settings_path(), first_corrupt).unwrap();

    let (snapshot, logs) = crate::services::design_files::capture_logs(|| {
        store.get_settings_record_with_env(Some("fr_FR"), "linux")
    });
    let snapshot = snapshot.expect("per-field reset succeeds");

    assert_eq!(snapshot.record["google_maps_api_key"], "SECRET-API-KEY-123");
    assert_eq!(snapshot.record["future_key"], "kept");
    assert_eq!(snapshot.record["locale"], "fr");
    assert_eq!(snapshot.record["theme"], "light");
    assert_eq!(snapshot.record["basemap_style"], "liberty");
    assert_eq!(snapshot.record["unit_system"], "metric");
    assert_eq!(snapshot.record["launch_check"], true);
    assert_eq!(snapshot.record["last_open_home"], Value::Null);
    for key in [
        "locale",
        "theme",
        "basemap_style",
        "unit_system",
        "launch_check",
        "last_open_home",
    ] {
        assert!(
            snapshot.reset_fields.contains(&key.to_owned()),
            "expected {key} in reset_fields: {:?}",
            snapshot.reset_fields
        );
    }
    assert_eq!(
        std::fs::read_to_string(store.before_reset_path()).unwrap(),
        first_corrupt
    );
    assert!(!logs.contains("SECRET-API-KEY-123"), "{logs}");

    // Second corrupt write must NOT overwrite settings.before-reset.json (write-once).
    let second_corrupt = r#"{"version":2,"theme":"neon","google_maps_api_key":"SECRET-2"}"#;
    std::fs::write(store.settings_path(), second_corrupt).unwrap();
    let second = store
        .get_settings_record_with_env(Some("en_US"), "linux")
        .unwrap();
    assert_eq!(second.record["google_maps_api_key"], "SECRET-2");
    assert_eq!(second.record["theme"], "light");
    assert_eq!(
        std::fs::read_to_string(store.before_reset_path()).unwrap(),
        first_corrupt,
        "before-reset.json is write-once"
    );
}

#[test]
fn malformed_json_writes_before_reset_once_and_never_logs_secret() {
    let scratch = TestScratch::new("settings-malformed-json");
    let store = DesktopSettingsStore::new(scratch.path(), test_user_db());
    let raw = r#"{"google_maps_api_key":"SECRET-BROKEN""#;
    std::fs::write(store.settings_path(), raw).unwrap();

    let (snapshot, logs) = crate::services::design_files::capture_logs(|| {
        store.get_settings_record_with_env(Some("fr_FR"), "macos")
    });
    let snapshot = snapshot.unwrap();
    assert_eq!(snapshot.record["locale"], "fr");
    assert_eq!(snapshot.record["scroll_wheel"], "pan");
    assert_eq!(snapshot.reset_fields, vec!["*"]);
    assert_eq!(
        std::fs::read_to_string(store.before_reset_path()).unwrap(),
        raw
    );
    assert!(!logs.contains("SECRET-BROKEN"), "{logs}");
}

/// #409 N4: patch writes durably persist `unit_system`, `launch_check`, `last_open_home`,
/// and preserve unknown keys across relaunch.
#[test]
fn patch_writes_persist_all_record_2_fields_and_unknown_keys_across_relaunch() {
    let scratch = TestScratch::new("settings-patch-relaunch");
    let user_db = test_user_db();
    let store = DesktopSettingsStore::new(scratch.path(), user_db.clone());
    std::fs::write(
        store.settings_path(),
        r#"{"version":2,"theme":"light","future_flag":42}"#,
    )
    .unwrap();

    let mut patch = Map::new();
    patch.insert(
        "unit_system".to_owned(),
        Value::String("us_customary".to_owned()),
    );
    patch.insert("launch_check".to_owned(), Value::Bool(false));
    patch.insert(
        "last_open_home".to_owned(),
        Value::String("draft:abc-123".to_owned()),
    );
    store.patch_settings_record(patch).unwrap();

    // Relaunch with a fresh DesktopSettingsStore handle against the same data_dir.
    let relaunched = DesktopSettingsStore::new(scratch.path(), user_db);
    let loaded = relaunched
        .get_settings_record_with_env(Some("de_DE"), "linux")
        .unwrap();
    assert_eq!(loaded.record["version"], 2);
    assert_eq!(loaded.record["unit_system"], "us_customary");
    assert_eq!(loaded.record["launch_check"], false);
    assert_eq!(loaded.record["last_open_home"], "draft:abc-123");
    assert_eq!(loaded.record["future_flag"], 42);
}

/// Version 3 (newer than current record 2) decodes known fields per-field, writes 0 bytes,
/// and refuses all writes with `ReadOnly` / `"store_read_only"`.
#[test]
fn newer_record_v3_is_read_only_and_writes_zero_bytes() {
    let scratch = TestScratch::new("settings-newer-v3");
    let store = DesktopSettingsStore::new(scratch.path(), test_user_db());
    let raw_v3 = r#"{"version":3,"locale":"de","theme":7,"basemap_style":"terrain","snap_to_grid":false,"unit_system":"us_customary","launch_check":false,"future_v3":"keep"}"#;
    std::fs::write(store.settings_path(), raw_v3).unwrap();

    let snapshot = store
        .get_settings_record_with_env(Some("fr_FR"), "macos")
        .unwrap();
    assert!(snapshot.newer_read_only);
    assert!(snapshot.reset_fields.is_empty());
    assert_eq!(snapshot.record["locale"], "de");
    assert_eq!(snapshot.record["snap_to_grid"], false);
    assert_eq!(snapshot.record["unit_system"], "us_customary");
    assert_eq!(snapshot.record["launch_check"], false);
    assert_eq!(snapshot.record["theme"], "light");
    assert_eq!(snapshot.record["basemap_style"], "liberty");
    assert!(!store.before_reset_path().exists());
    assert_eq!(
        std::fs::read_to_string(store.settings_path()).unwrap(),
        raw_v3
    );

    let mut patch = Map::new();
    patch.insert("theme".to_owned(), Value::String("dark".to_owned()));
    assert_eq!(
        store.patch_settings_record(patch),
        Err(SettingsWriteError::ReadOnly)
    );
    assert_eq!(
        store.set_settings(Settings::default()),
        Err("store_read_only".to_owned())
    );
    assert_eq!(
        std::fs::read_to_string(store.settings_path()).unwrap(),
        raw_v3
    );
}

#[test]
fn frozen_settings_record_2_fixture_folds_check_updates_at_launch_into_launch_check() {
    let scratch = TestScratch::new("settings-frozen-v2");
    let store = DesktopSettingsStore::new(scratch.path(), test_user_db());
    let fixture = include_str!("../test_fixtures/frozen/settings-record-2.json");
    std::fs::write(store.settings_path(), fixture).unwrap();

    let snapshot = store
        .get_settings_record_with_env(Some("en_US"), "linux")
        .unwrap();
    assert!(!snapshot.newer_read_only);
    assert!(snapshot.reset_fields.is_empty());
    assert_eq!(snapshot.record["locale"], "de");
    assert_eq!(snapshot.record["theme"], "dark");
    assert_eq!(snapshot.record["unit_system"], "us_customary");
    assert_eq!(snapshot.record["launch_check"], false);
    assert_eq!(
        read_sqlite(&store.user_db, "settings"),
        None,
        "SQLite is untouched"
    );
}

#[test]
fn saves_v1_settings_round_trip_while_preserving_record_2_extras() {
    let scratch = TestScratch::new("settings-v1-round-trip");
    let store = DesktopSettingsStore::new(scratch.path(), test_user_db());
    let mut initial_patch = Map::new();
    initial_patch.insert("launch_check".to_owned(), Value::Bool(false));
    initial_patch.insert(
        "unit_system".to_owned(),
        Value::String("us_customary".to_owned()),
    );
    store.patch_settings_record(initial_patch).unwrap();

    let settings = Settings {
        locale: Locale::De,
        theme: Theme::Dark,
        basemap_style: BasemapStyle::Dark,
        side_panel_width: Some(444),
        saved_stamps_frame_height: Some(260),
        ..Default::default()
    };
    store.set_settings(settings).unwrap();

    let stored = store.get_settings_with_env(Some("en_US"), "linux").unwrap();
    assert_eq!(stored.locale, Locale::De);
    assert_eq!(stored.theme, Theme::Dark);
    assert_eq!(stored.basemap_style, BasemapStyle::Dark);
    assert_eq!(stored.side_panel_width, Some(444));
    assert_eq!(stored.saved_stamps_frame_height, Some(260));

    let record = store
        .get_settings_record_with_env(Some("en_US"), "linux")
        .unwrap()
        .record;
    assert_eq!(record["launch_check"], false);
    assert_eq!(record["unit_system"], "us_customary");
}

#[test]
fn first_launch_takes_every_supported_system_language_and_other_os_defaults_to_mouse() {
    let languages = [
        ("es_ES.UTF-8", Locale::Es),
        ("pt-BR", Locale::Pt),
        ("it_IT", Locale::It),
        ("zh-Hans-CN", Locale::Zh),
        ("de_DE", Locale::De),
        ("ja_JP", Locale::Ja),
        ("ko-KR", Locale::Ko),
        ("NL_be", Locale::Nl),
        ("ru_RU", Locale::Ru),
    ];
    for (system, locale) in languages {
        let scratch = TestScratch::new("settings-lang");
        let store = DesktopSettingsStore::new(scratch.path(), test_user_db());
        let settings = store.get_settings_with_env(Some(system), "linux").unwrap();
        assert_eq!(settings.locale, locale, "{system}");
        assert_eq!(settings.scroll_wheel, ScrollWheel::Zoom, "{system}");
    }
    let scratch = TestScratch::new("settings-lang-unknown");
    let store = DesktopSettingsStore::new(scratch.path(), test_user_db());
    assert_eq!(
        store
            .get_settings_with_env(Some("sv_SE"), "windows")
            .unwrap()
            .locale,
        Locale::En
    );
}
