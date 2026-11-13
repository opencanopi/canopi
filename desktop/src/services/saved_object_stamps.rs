use canopi_types::saved_object_stamps::SavedObjectStamp;

use crate::db::UserDb;
use crate::db::user_db::write_refusal;

pub fn create_saved_object_stamp(
    user_db: &UserDb,
    name: String,
    payload_json: String,
) -> Result<SavedObjectStamp, String> {
    let conn = user_db.acquire();
    crate::db::user_db::create_saved_object_stamp(&conn, &name, &payload_json)
        .map(row_to_saved_object_stamp)
        .map_err(write_refusal(&format!(
            "Failed to create Saved Object Stamp '{name}'"
        )))
}

pub fn get_saved_object_stamps(user_db: &UserDb) -> Result<Vec<SavedObjectStamp>, String> {
    let conn = user_db.acquire();
    crate::db::user_db::get_saved_object_stamps(&conn)
        .map(|rows| rows.into_iter().map(row_to_saved_object_stamp).collect())
        .map_err(|e| format!("Failed to read Saved Object Stamps: {e}"))
}

pub fn rename_saved_object_stamp(
    user_db: &UserDb,
    id: String,
    name: String,
) -> Result<SavedObjectStamp, String> {
    let conn = user_db.acquire();
    crate::db::user_db::rename_saved_object_stamp(&conn, &id, &name)
        .map(row_to_saved_object_stamp)
        .map_err(write_refusal(&format!(
            "Failed to rename Saved Object Stamp '{id}'"
        )))
}

pub fn delete_saved_object_stamp(user_db: &UserDb, id: String) -> Result<bool, String> {
    let conn = user_db.acquire();
    crate::db::user_db::delete_saved_object_stamp(&conn, &id).map_err(write_refusal(&format!(
        "Failed to delete Saved Object Stamp '{id}'"
    )))
}

pub fn reorder_saved_object_stamps(
    user_db: &UserDb,
    ids: Vec<String>,
) -> Result<Vec<SavedObjectStamp>, String> {
    let conn = user_db.acquire();
    crate::db::user_db::reorder_saved_object_stamps(&conn, &ids)
        .and_then(|()| crate::db::user_db::get_saved_object_stamps(&conn))
        .map(|rows| rows.into_iter().map(row_to_saved_object_stamp).collect())
        .map_err(write_refusal("Failed to reorder Saved Object Stamps"))
}

fn row_to_saved_object_stamp(row: crate::db::user_db::SavedObjectStampRow) -> SavedObjectStamp {
    SavedObjectStamp {
        id: row.id,
        name: row.name,
        payload_json: row.payload_json,
        sort_order: row.sort_order,
        created_at: row.created_at,
        updated_at: row.updated_at,
        // R2 computes it in the listing query (2.1-M88, design check F6).
        needs_newer: false,
    }
}

#[cfg(test)]
mod tests {
    use crate::db::UserDb;

    fn test_user_db() -> UserDb {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        UserDb::initialize(conn).unwrap()
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
}
