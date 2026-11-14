//! What a failed user DB open tells its reader (mutation exit, canopi-tnfd): the startup log and an internal startup
//! failure read `UserDbInitError` through `Display`, and its cause through `std::error::Error::source`.

use super::{CURRENT_USER_DB_VERSION, UserDbInitError};
use crate::db::UserDb;
use crate::test_scratch::TestScratch;
use rusqlite::Connection;
use std::error::Error;

#[test]
fn a_user_db_that_cannot_be_opened_says_so_and_keeps_its_sqlite_cause() {
    let scratch = TestScratch::new("user-db-open-error");
    let path = scratch.join("missing-folder").join("user.db");

    let Err(error) = UserDb::open(&path) else {
        panic!("a user DB in a missing folder cannot open");
    };

    assert!(matches!(error, UserDbInitError::Open(_)), "{error:?}");
    let message = error.to_string();
    assert!(
        message.starts_with("failed to open user database: "),
        "{message}"
    );
    let cause = error.source().expect("the SQLite failure is the cause");
    assert!(message.ends_with(&cause.to_string()), "{message}");
}

#[test]
fn a_newer_user_db_refused_read_write_names_both_versions_and_has_no_cause() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "user_version", CURRENT_USER_DB_VERSION + 1)
        .unwrap();

    let Err(error) = UserDb::initialize(conn) else {
        panic!("a newer user DB is refused read-write");
    };

    assert_eq!(
        error.to_string(),
        format!(
            "user database schema version {} was written by a newer Canopi (this version reads {}); open it with that newer Canopi",
            CURRENT_USER_DB_VERSION + 1,
            CURRENT_USER_DB_VERSION
        )
    );
    assert!(error.source().is_none());
}
