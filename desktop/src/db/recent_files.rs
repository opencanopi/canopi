use canopi_types::design::DesignSummary;
use rusqlite::Connection;

/// Rows the table keeps. Recent Designs shows 20; the rest are headroom for
/// Designs that are temporarily unavailable (an unplugged drive) and hidden.
/// Without a cap every path ever opened stays, and each listing checks them all.
pub const RECENT_FILES_KEPT: u32 = 100;

/// Record or update a recent file entry (upsert by path), then drop the
/// entries beyond [`RECENT_FILES_KEPT`], oldest first.
pub fn record_recent_file(
    conn: &Connection,
    path: &str,
    name: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO recent_files (path, name, last_opened)
         VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(path) DO UPDATE SET
             name = excluded.name,
             last_opened = excluded.last_opened",
        rusqlite::params![path, name],
    )?;
    conn.execute(
        "DELETE FROM recent_files
         WHERE path NOT IN (
             SELECT path FROM recent_files
             ORDER BY last_opened DESC, rowid DESC
             LIMIT ?1
         )",
        rusqlite::params![RECENT_FILES_KEPT],
    )?;
    Ok(())
}

/// Return recent files ordered by most recently opened, up to `limit` rows.
/// `updated_at` is an RFC 3339 UTC instant (`2026-10-13T23:11:59Z`): the table
/// stores SQLite's `datetime('now')`, UTC without a zone marker, which a reader
/// would take for local time.
pub fn get_recent_files(
    conn: &Connection,
    limit: u32,
) -> Result<Vec<DesignSummary>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT path, name, strftime('%Y-%m-%dT%H:%M:%SZ', last_opened)
         FROM recent_files
         ORDER BY last_opened DESC
         LIMIT ?1",
    )?;

    let rows = stmt.query_map(rusqlite::params![limit], |row| {
        Ok(DesignSummary {
            path: row.get(0)?,
            name: row.get(1)?,
            updated_at: row.get(2)?,
        })
    })?;

    rows.collect()
}

/// Remove a recent file entry (for files that no longer exist on disk).
pub fn remove_recent_file(conn: &Connection, path: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM recent_files WHERE path = ?1",
        rusqlite::params![path],
    )?;
    Ok(())
}

/// Whether `path` is on the Recent Designs list.
pub fn is_recent_file(conn: &Connection, path: &str) -> Result<bool, rusqlite::Error> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM recent_files WHERE path = ?1)",
        rusqlite::params![path],
        |row| row.get(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::user_db::initialize_connection(&conn).unwrap();
        conn
    }

    #[test]
    fn test_record_and_get_recent_files() {
        let conn = test_db();
        record_recent_file(&conn, "/home/user/garden.canopi", "Garden").unwrap();
        record_recent_file(&conn, "/home/user/forest.canopi", "Forest").unwrap();

        let files = get_recent_files(&conn, 10).unwrap();
        assert_eq!(files.len(), 2);

        // Both entries must be present.
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert!(
            names.contains(&"Garden"),
            "Garden should be in recent files"
        );
        assert!(
            names.contains(&"Forest"),
            "Forest should be in recent files"
        );
    }

    #[test]
    fn listed_entries_say_when_they_were_opened_as_a_utc_instant() {
        // SQLite's datetime('now') is UTC with no zone marker; read as is, the start screen took it for local time
        // (canopi-f47t.61: a Design saved at 01:11 in Paris showed as "Yesterday, 11:11 PM").
        let conn = test_db();
        record_recent_file(&conn, "/home/user/garden.canopi", "Garden").unwrap();
        conn.execute(
            "UPDATE recent_files SET last_opened = '2026-10-13 23:11:59'",
            [],
        )
        .unwrap();

        let files = get_recent_files(&conn, 10).unwrap();
        assert_eq!(files[0].updated_at, "2026-10-13T23:11:59Z");
    }

    #[test]
    fn test_record_recent_file_upserts() {
        let conn = test_db();
        record_recent_file(&conn, "/home/user/garden.canopi", "Garden").unwrap();
        // Update the name via upsert.
        record_recent_file(&conn, "/home/user/garden.canopi", "My Garden").unwrap();

        let files = get_recent_files(&conn, 10).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "My Garden");
    }

    #[test]
    fn test_get_recent_files_respects_limit() {
        let conn = test_db();
        for i in 0..5 {
            record_recent_file(
                &conn,
                &format!("/home/user/garden{i}.canopi"),
                &format!("Garden {i}"),
            )
            .unwrap();
        }

        let files = get_recent_files(&conn, 3).unwrap();
        assert_eq!(files.len(), 3);
    }

    #[test]
    fn test_remove_recent_file() {
        let conn = test_db();
        record_recent_file(&conn, "/home/user/garden.canopi", "Garden").unwrap();
        record_recent_file(&conn, "/home/user/forest.canopi", "Forest").unwrap();

        remove_recent_file(&conn, "/home/user/garden.canopi").unwrap();

        let files = get_recent_files(&conn, 10).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "Forest");
    }

    #[test]
    fn is_recent_file_answers_only_for_listed_paths() {
        let conn = test_db();
        record_recent_file(&conn, "/home/user/garden.canopi", "Garden").unwrap();
        assert!(is_recent_file(&conn, "/home/user/garden.canopi").unwrap());
        assert!(!is_recent_file(&conn, "/home/user/other.canopi").unwrap());
    }

    #[test]
    fn the_table_keeps_the_newest_entries_only() {
        let conn = test_db();
        for i in 0..RECENT_FILES_KEPT + 5 {
            record_recent_file(&conn, &format!("/home/user/garden{i}.canopi"), "Garden").unwrap();
        }

        let files = get_recent_files(&conn, u32::MAX).unwrap();
        assert_eq!(files.len(), RECENT_FILES_KEPT as usize);
        let latest = format!("/home/user/garden{}.canopi", RECENT_FILES_KEPT + 4);
        assert!(is_recent_file(&conn, &latest).unwrap());
        assert!(!is_recent_file(&conn, "/home/user/garden0.canopi").unwrap());
    }

    #[test]
    fn test_remove_nonexistent_recent_file_is_noop() {
        let conn = test_db();
        // Should not error even if the row doesn't exist.
        remove_recent_file(&conn, "/nonexistent.canopi").unwrap();
        let files = get_recent_files(&conn, 10).unwrap();
        assert_eq!(files.len(), 0);
    }
}
