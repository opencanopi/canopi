use canopi_types::saved_object_stamps::SavedObjectStamp;

use crate::db::UserDb;
use crate::db::user_db::{StampWriteError, write_refusal};

/// The text a stamp write settles with when its row's payload is newer than this build reads (2.1-M88).
pub(crate) const NEEDS_NEWER: &str = "saved_object_stamp_needs_newer";

/// A refused stamp write's text: [`NEEDS_NEWER`] for a newer row, else what [`write_refusal`] gives SQLite's error.
fn stamp_write_refusal(context: &str) -> impl FnOnce(StampWriteError) -> String + '_ {
    move |error| match error {
        StampWriteError::NeedsNewer => NEEDS_NEWER.to_owned(),
        StampWriteError::Sqlite(error) => write_refusal(context)(error),
    }
}

pub fn create_saved_object_stamp(
    user_db: &UserDb,
    name: String,
    payload_json: String,
) -> Result<SavedObjectStamp, String> {
    let conn = user_db.acquire();
    crate::db::user_db::create_saved_object_stamp(&conn, &name, &payload_json).map_err(
        write_refusal(&format!("Failed to create Saved Object Stamp '{name}'")),
    )
}

pub fn get_saved_object_stamps(user_db: &UserDb) -> Result<Vec<SavedObjectStamp>, String> {
    let conn = user_db.acquire();
    crate::db::user_db::get_saved_object_stamps(&conn)
        .map_err(|e| format!("Failed to read Saved Object Stamps: {e}"))
}

pub fn rename_saved_object_stamp(
    user_db: &UserDb,
    id: String,
    name: String,
) -> Result<SavedObjectStamp, String> {
    let conn = user_db.acquire();
    crate::db::user_db::rename_saved_object_stamp(&conn, &id, &name).map_err(stamp_write_refusal(
        &format!("Failed to rename Saved Object Stamp '{id}'"),
    ))
}

pub fn delete_saved_object_stamp(user_db: &UserDb, id: String) -> Result<bool, String> {
    let conn = user_db.acquire();
    crate::db::user_db::delete_saved_object_stamp(&conn, &id).map_err(stamp_write_refusal(
        &format!("Failed to delete Saved Object Stamp '{id}'"),
    ))
}

pub fn reorder_saved_object_stamps(
    user_db: &UserDb,
    ids: Vec<String>,
) -> Result<Vec<SavedObjectStamp>, String> {
    let context = "Failed to reorder Saved Object Stamps";
    let conn = user_db.acquire();
    crate::db::user_db::reorder_saved_object_stamps(&conn, &ids)
        .map_err(stamp_write_refusal(context))?;
    crate::db::user_db::get_saved_object_stamps(&conn).map_err(write_refusal(context))
}

#[cfg(test)]
mod tests {
    use crate::db::UserDb;

    fn test_user_db() -> UserDb {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        UserDb::initialize(conn).unwrap()
    }

    #[test]
    fn test_saved_object_stamp_round_trip_preserves_payload_and_order() {
        let user_db = test_user_db();
        let payload = r#"{"plants":[{"id":"plant-1"}],"zones":[],"annotations":[],"groups":[]}"#;

        let saved =
            super::create_saved_object_stamp(&user_db, "Apple guild".into(), payload.into())
                .unwrap();

        assert_eq!(saved.name, "Apple guild");
        assert_eq!(saved.sort_order, 0);
        assert!(!saved.created_at.is_empty());
        assert_eq!(saved.updated_at, saved.created_at);

        let stamps = super::get_saved_object_stamps(&user_db).unwrap();
        assert_eq!(stamps.len(), 1);
        assert_eq!(stamps[0].id, saved.id);
        assert_eq!(stamps[0].name, "Apple guild");
        assert_eq!(stamps[0].payload_json, payload);
        assert_eq!(stamps[0].sort_order, 0);
    }

    #[test]
    fn test_saved_object_stamps_can_be_renamed_deleted_and_reordered() {
        let user_db = test_user_db();
        let create = |name: &str| {
            super::create_saved_object_stamp(&user_db, name.into(), r#"{"plants":[]}"#.into())
                .unwrap()
        };
        let (first, second) = (create("First"), create("Second"));

        let renamed =
            super::rename_saved_object_stamp(&user_db, first.id.clone(), "Renamed".into()).unwrap();
        assert_eq!(renamed.name, "Renamed");

        let reordered =
            super::reorder_saved_object_stamps(&user_db, vec![second.id.clone(), first.id.clone()])
                .unwrap();
        assert_eq!(
            reordered
                .iter()
                .map(|stamp| (stamp.id.as_str(), stamp.sort_order))
                .collect::<Vec<_>>(),
            [(second.id.as_str(), 0), (first.id.as_str(), 1)]
        );

        assert!(super::delete_saved_object_stamp(&user_db, second.id.clone()).unwrap());
        assert!(!super::delete_saved_object_stamp(&user_db, second.id.clone()).unwrap());
        let remaining = super::get_saved_object_stamps(&user_db).unwrap();
        assert_eq!(
            remaining
                .iter()
                .map(|stamp| stamp.id.as_str())
                .collect::<Vec<_>>(),
            [first.id.as_str()]
        );
    }

    #[test]
    fn creates_and_lists_saved_object_stamps() {
        let user_db = test_user_db();

        let saved = super::create_saved_object_stamp(
            &user_db,
            "Apple guild".to_owned(),
            r#"{"plants":[{"id":"plant-1"}],"zones":[],"annotations":[],"groups":[]}"#.to_owned(),
        )
        .unwrap();

        let stamps = super::get_saved_object_stamps(&user_db).unwrap();

        assert_eq!(saved.name, "Apple guild");
        assert_eq!(stamps, vec![saved]);
    }

    #[test]
    fn renames_deletes_and_reorders_saved_object_stamps() {
        let user_db = test_user_db();
        let first = super::create_saved_object_stamp(&user_db, "First".to_owned(), "{}".to_owned())
            .unwrap();
        let second =
            super::create_saved_object_stamp(&user_db, "Second".to_owned(), "{}".to_owned())
                .unwrap();

        let renamed =
            super::rename_saved_object_stamp(&user_db, first.id.clone(), "Renamed".to_owned())
                .unwrap();
        super::reorder_saved_object_stamps(&user_db, vec![second.id.clone(), first.id.clone()])
            .unwrap();
        assert!(super::delete_saved_object_stamp(&user_db, second.id.clone()).unwrap());

        let stamps = super::get_saved_object_stamps(&user_db).unwrap();

        assert_eq!(renamed.name, "Renamed");
        assert_eq!(stamps.len(), 1);
        assert_eq!(stamps[0].id, first.id);
        assert_eq!(stamps[0].name, "Renamed");
    }

    /// A row 2.1 leaves behind, inserted as it stores it rather than through this build's writer.
    fn insert_raw(user_db: &UserDb, id: &str, payload_json: &str, sort_order: i32) {
        let conn = user_db.acquire();
        conn.execute(
            "INSERT INTO saved_object_stamps (id, name, payload_json, sort_order, created_at, updated_at)
             VALUES (?1, ?1, ?2, ?3, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')",
            rusqlite::params![id, payload_json, sort_order],
        )
        .unwrap();
    }

    /// Every column of every row, in rowid order: what "the row is unchanged" compares.
    fn raw_rows(user_db: &UserDb) -> Vec<(String, String, String, i32, String, String)> {
        let conn = user_db.acquire();
        let mut statement = conn
            .prepare(
                "SELECT id, name, payload_json, sort_order, created_at, updated_at
                 FROM saved_object_stamps ORDER BY rowid",
            )
            .unwrap();
        statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    const V3: &str =
        r#"{"version":3,"plants":[],"zones":[],"annotations":[],"groups":[],"guides":[]}"#;
    const V2: &str = r#"{"version":2,"plants":[],"zones":[],"annotations":[],"groups":[]}"#;

    #[test]
    fn canopi_f47t_52_271_the_listing_marks_only_a_payload_above_v2_as_needing_a_newer_canopi() {
        let user_db = test_user_db();
        insert_raw(&user_db, "v3", V3, 0);
        insert_raw(&user_db, "v2", V2, 1);
        insert_raw(&user_db, "v1", r#"{"version":1}"#, 2);
        insert_raw(&user_db, "unversioned", "{}", 3);
        insert_raw(&user_db, "text-version", r#"{"version":"9"}"#, 4);
        insert_raw(&user_db, "damaged", "not json", 5);

        let listed = super::get_saved_object_stamps(&user_db).unwrap();

        assert_eq!(
            listed
                .iter()
                .map(|stamp| (stamp.id.as_str(), stamp.needs_newer))
                .collect::<Vec<_>>(),
            [
                ("v3", true),
                ("v2", false),
                ("v1", false),
                ("unversioned", false),
                ("text-version", false),
                ("damaged", false),
            ]
        );
    }

    #[test]
    fn canopi_f47t_52_271_renaming_or_deleting_a_v3_row_is_refused_and_leaves_it_unchanged() {
        let user_db = test_user_db();
        insert_raw(&user_db, "v3", V3, 0);
        let before = raw_rows(&user_db);

        let renamed = super::rename_saved_object_stamp(&user_db, "v3".into(), "Hedge".into());
        let deleted = super::delete_saved_object_stamp(&user_db, "v3".into());

        assert_eq!(renamed, Err(super::NEEDS_NEWER.to_owned()));
        assert_eq!(deleted, Err(super::NEEDS_NEWER.to_owned()));
        assert_eq!(raw_rows(&user_db), before, "the v3 row is byte-identical");
    }

    #[test]
    fn canopi_f47t_52_271_a_reorder_naming_a_v3_row_is_refused_whole_and_renumbers_no_row() {
        let user_db = test_user_db();
        insert_raw(&user_db, "first", V2, 0);
        insert_raw(&user_db, "v3", V3, 1);
        insert_raw(&user_db, "last", V2, 2);
        let before = raw_rows(&user_db);

        let reordered = super::reorder_saved_object_stamps(
            &user_db,
            vec!["last".into(), "v3".into(), "first".into()],
        );

        assert_eq!(reordered, Err(super::NEEDS_NEWER.to_owned()));
        assert_eq!(raw_rows(&user_db), before, "no row renumbered");
    }

    #[test]
    fn canopi_f47t_52_271_a_reorder_of_the_older_rows_renumbers_them_and_leaves_the_v3_row_unchanged()
     {
        let user_db = test_user_db();
        insert_raw(&user_db, "first", V2, 0);
        insert_raw(&user_db, "v3", V3, 5);
        insert_raw(&user_db, "last", V2, 2);
        let v3_row = |user_db: &UserDb| {
            raw_rows(user_db)
                .into_iter()
                .find(|row| row.0 == "v3")
                .unwrap()
        };
        let before = v3_row(&user_db);

        let reordered =
            super::reorder_saved_object_stamps(&user_db, vec!["last".into(), "first".into()])
                .unwrap();

        assert_eq!(
            reordered
                .iter()
                .map(|stamp| (stamp.id.as_str(), stamp.sort_order))
                .collect::<Vec<_>>(),
            [("last", 0), ("first", 1), ("v3", 5)]
        );
        assert_eq!(v3_row(&user_db), before, "the v3 row is byte-identical");
    }

    #[test]
    fn canopi_f47t_52_271_a_v1_row_beside_a_v3_row_is_still_deleted() {
        let user_db = test_user_db();
        insert_raw(&user_db, "v1", r#"{"version":1,"plants":[]}"#, 0);
        insert_raw(&user_db, "v3", V3, 1);

        assert_eq!(
            super::delete_saved_object_stamp(&user_db, "v1".into()),
            Ok(true)
        );
        assert_eq!(
            super::delete_saved_object_stamp(&user_db, "v1".into()),
            Ok(false),
            "a missing row is not a refusal"
        );
        let listed = super::get_saved_object_stamps(&user_db).unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|stamp| stamp.id.as_str())
                .collect::<Vec<_>>(),
            ["v3"]
        );
    }
}
