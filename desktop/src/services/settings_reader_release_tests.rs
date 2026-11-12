//! The reader release's user-DB user paths on Desktop (Step 2.0.4 R2, canopi-f47t.52.271): settings record 2 (plan
//! "reader release: settings record 2 applies its known fields and is never written", 2.1-M480, A16) and a saved
//! stamp with a v3 payload (plan "a saved stamp with a v3 payload lists as needing a newer Canopi and its row is
//! unchanged", 2.1-M88).
//!
//! Written failing in commit 0 and marked expected-fail: R2-6 removes the settings marker, R2-5 the stamp marker (the
//! main agent flips the stamp case at R2-5's merge, since R2-6 owns this file). R2-6 may swap the inline record for
//! the frozen `test_fixtures/frozen/settings-record-2.json` once it lands.

use crate::db::UserDb;
use crate::services::{saved_object_stamps, settings};
use canopi_types::settings::{BasemapStyle, Locale, Theme};
#[cfg(test)]
use rusqlite::Connection;

fn user_db() -> UserDb {
    UserDb::initialize(Connection::open_in_memory().unwrap()).unwrap()
}

/// Every settings-table row, key and value, in key order: what "never written" compares.
#[cfg(test)]
fn settings_rows(user_db: &UserDb) -> Vec<(String, String)> {
    let conn = user_db.acquire();
    let mut statement = conn
        .prepare("SELECT key, value FROM settings ORDER BY key")
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// A record 2.1 writes: a top-level integer `version`, a basemap literal this build does not know, a field it never
/// heard of and known fields it reads (contracts §11 Read projections: per-field tolerant decode, unknown keys ignored).
const SETTINGS_RECORD_2: &str = r#"{"version":2,"locale":"de","theme":"dark","snap_to_grid":true,"basemap_style":"terrain-2-1","unit_system":"us_customary"}"#;

#[test]
#[ignore = "expected-fail: R2 canopi-f47t.52.271"]
fn r2_canopi_f47t_52_271_settings_record_2_applies_its_known_fields_and_is_never_written() {
    let user_db = user_db();
    {
        let conn = user_db.acquire();
        crate::db::user_db::set_setting(&conn, "settings", SETTINGS_RECORD_2).unwrap();
    }
    let before = settings_rows(&user_db);

    // Today the unknown basemap literal sets the whole record aside and defaults replace it.
    let read = settings::get_settings(&user_db).expect("settings record 2 is read");
    assert_eq!(read.locale, Locale::De, "a known field applies");
    assert_eq!(read.theme, Theme::Dark, "a known field applies");
    assert!(read.snap_to_grid, "a known field applies");
    assert_eq!(
        read.basemap_style,
        BasemapStyle::Liberty,
        "an unknown literal takes that field's default"
    );
    assert_eq!(settings_rows(&user_db), before, "reading writes no row");

    let mut changed = read.clone();
    changed.theme = Theme::Light;
    assert!(
        settings::set_settings(&user_db, changed).is_err(),
        "a settings change is refused, applied for the session only (2.1-Q320)"
    );
    assert_eq!(
        settings_rows(&user_db),
        before,
        "the record is never written"
    );
}

#[test]
#[ignore = "expected-fail: R2 canopi-f47t.52.271"]
fn r2_canopi_f47t_52_271_a_v3_saved_stamp_needs_a_newer_canopi_and_its_row_is_unchanged() {
    let user_db = user_db();
    let older = saved_object_stamps::create_saved_object_stamp(
        &user_db,
        "Hedge".to_string(),
        r#"{"version":2,"plants":[],"zones":[],"annotations":[],"groups":[]}"#.to_string(),
    )
    .unwrap();
    let newer = saved_object_stamps::create_saved_object_stamp(
        &user_db,
        "Apple guild".to_string(),
        r#"{"version":3,"plants":[],"zones":[],"annotations":[],"groups":[],"guides":[],"notes":[]}"#
            .to_string(),
    )
    .unwrap();
    let before = saved_object_stamps::get_saved_object_stamps(&user_db).unwrap();

    // Today needs_newer is never set and the v3 row renames, reorders and deletes like any other.
    let listed = before.iter().find(|stamp| stamp.id == newer.id).unwrap();
    assert!(
        listed.needs_newer,
        "the v3 stamp lists as needing a newer Canopi"
    );
    assert!(
        !before
            .iter()
            .find(|stamp| stamp.id == older.id)
            .unwrap()
            .needs_newer
    );
    assert!(
        saved_object_stamps::rename_saved_object_stamp(&user_db, newer.id.clone(), "x".into())
            .is_err(),
        "a v3 row is never renamed"
    );
    assert!(
        saved_object_stamps::reorder_saved_object_stamps(
            &user_db,
            vec![newer.id.clone(), older.id.clone()]
        )
        .is_err(),
        "a reorder naming a v3 row is refused"
    );
    assert!(
        saved_object_stamps::delete_saved_object_stamp(&user_db, newer.id.clone()).is_err(),
        "a v3 row is never deleted"
    );
    let after = saved_object_stamps::get_saved_object_stamps(&user_db).unwrap();
    let row = |stamps: &[canopi_types::saved_object_stamps::SavedObjectStamp]| {
        stamps
            .iter()
            .find(|stamp| stamp.id == newer.id)
            .map(|stamp| {
                (
                    stamp.name.clone(),
                    stamp.payload_json.clone(),
                    stamp.sort_order,
                    stamp.updated_at.clone(),
                )
            })
    };
    assert_eq!(row(&after), row(&before), "the v3 row is unchanged");
}
