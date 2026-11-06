use canopi_types::design::{DesignNotebookEntry, DesignNotebookSection};
use rusqlite::Connection;

pub fn record_design_reference(
    conn: &Connection,
    path: &str,
    name: &str,
    plant_count: u32,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO design_notebook_entries (
            path,
            name,
            updated_at,
            plant_count,
            sort_order,
            created_at,
            last_opened
         )
         VALUES (
            ?1,
            ?2,
            datetime('now'),
            ?3,
            COALESCE((SELECT MAX(sort_order) + 1 FROM design_notebook_entries), 0),
            datetime('now'),
            datetime('now')
         )
         ON CONFLICT(path) DO UPDATE SET
            name = excluded.name,
            updated_at = excluded.updated_at,
            plant_count = excluded.plant_count,
            last_opened = excluded.last_opened",
        rusqlite::params![path, name, plant_count],
    )?;
    Ok(())
}

pub fn remove_design_reference(conn: &Connection, path: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM design_notebook_entries WHERE path = ?1",
        rusqlite::params![path],
    )?;
    Ok(())
}

pub fn create_notebook_section(
    conn: &Connection,
    name: &str,
) -> Result<DesignNotebookSection, rusqlite::Error> {
    conn.execute(
        "INSERT INTO design_notebook_sections (id, name, sort_order, created_at, updated_at)
         VALUES (
            'section-' || lower(hex(randomblob(16))),
            ?1,
            COALESCE((SELECT MAX(sort_order) + 1 FROM design_notebook_sections), 0),
            datetime('now'),
            datetime('now')
         )",
        rusqlite::params![name],
    )?;

    let row_id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id, name, sort_order, created_at, updated_at
         FROM design_notebook_sections
         WHERE rowid = ?1",
        rusqlite::params![row_id],
        notebook_section_from_row,
    )
}

pub fn get_notebook_sections(
    conn: &Connection,
) -> Result<Vec<DesignNotebookSection>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, name, sort_order, created_at, updated_at
         FROM design_notebook_sections
         ORDER BY sort_order ASC, created_at ASC, id ASC",
    )?;

    let rows = stmt.query_map([], notebook_section_from_row)?;
    rows.collect()
}

pub fn rename_notebook_section(
    conn: &Connection,
    section_id: &str,
    name: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE design_notebook_sections
         SET name = ?2, updated_at = datetime('now')
         WHERE id = ?1",
        rusqlite::params![section_id, name],
    )?;
    Ok(())
}

pub fn delete_notebook_section(conn: &Connection, section_id: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM design_notebook_sections WHERE id = ?1",
        rusqlite::params![section_id],
    )?;
    Ok(())
}

pub fn assign_design_reference_to_section(
    conn: &Connection,
    path: &str,
    section_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO design_notebook_section_memberships (path, section_id, created_at, updated_at)
         VALUES (?1, ?2, datetime('now'), datetime('now'))
         ON CONFLICT(path) DO UPDATE SET
            section_id = excluded.section_id,
            updated_at = excluded.updated_at",
        rusqlite::params![path, section_id],
    )?;
    Ok(())
}

pub fn reorder_notebook_sections(
    conn: &Connection,
    section_ids: &[String],
) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "UPDATE design_notebook_sections
             SET sort_order = ?2, updated_at = datetime('now')
             WHERE id = ?1",
        )?;
        for (index, section_id) in section_ids.iter().enumerate() {
            stmt.execute((section_id, index as i32))?;
        }
    }
    tx.commit()
}

pub fn reorder_design_references(
    conn: &Connection,
    paths: &[String],
) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "UPDATE design_notebook_entries
             SET sort_order = ?2
             WHERE path = ?1",
        )?;
        for (index, path) in paths.iter().enumerate() {
            stmt.execute((path, index as i32))?;
        }
    }
    tx.commit()
}

pub fn relocate_design_reference(
    conn: &Connection,
    path: &str,
    section_id: Option<&str>,
    paths: &[String],
) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    tx.query_row(
        "SELECT path FROM design_notebook_entries WHERE path = ?1",
        [path],
        |_| Ok(()),
    )?;
    match section_id {
        Some(section_id) => assign_design_reference_to_section(&tx, path, section_id)?,
        None => remove_design_reference_from_section(&tx, path)?,
    }
    {
        let mut stmt =
            tx.prepare("UPDATE design_notebook_entries SET sort_order = ?2 WHERE path = ?1")?;
        for (index, path) in paths.iter().enumerate() {
            if stmt.execute((path, index as i32))? != 1 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
        }
    }
    tx.commit()
}

pub fn remove_design_reference_from_section(
    conn: &Connection,
    path: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM design_notebook_section_memberships WHERE path = ?1",
        rusqlite::params![path],
    )?;
    Ok(())
}

/// `updated_at` is an RFC 3339 UTC instant: the table stores SQLite's `datetime('now')`, UTC without a zone
/// marker, which a reader would take for local time.
pub fn get_design_notebook_entries_with_sections(
    conn: &Connection,
) -> Result<Vec<DesignNotebookEntry>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT e.path, e.name, strftime('%Y-%m-%dT%H:%M:%SZ', e.updated_at), e.plant_count, m.section_id, e.sort_order
         FROM design_notebook_entries e
         LEFT JOIN design_notebook_section_memberships m ON m.path = e.path
         ORDER BY e.sort_order ASC, e.last_opened DESC, e.created_at DESC, e.path ASC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(DesignNotebookEntry {
            path: row.get(0)?,
            name: row.get(1)?,
            updated_at: row.get(2)?,
            plant_count: row.get(3)?,
            section_id: row.get(4)?,
            sort_order: row.get(5)?,
        })
    })?;

    rows.collect()
}

fn notebook_section_from_row(
    row: &rusqlite::Row<'_>,
) -> Result<DesignNotebookSection, rusqlite::Error> {
    Ok(DesignNotebookSection {
        id: row.get(0)?,
        name: row.get(1)?,
        sort_order: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::user_db::initialize_connection(&conn).unwrap();
        conn
    }

    #[test]
    fn listed_entries_say_when_they_were_saved_as_a_utc_instant() {
        // SQLite's datetime('now') is UTC with no zone marker; the Design notebook read it as local time, so near
        // midnight a Design showed the wrong day (canopi-f47t.61's neighbour).
        let conn = test_db();
        super::record_design_reference(&conn, "/garden.canopi", "Garden", 1).unwrap();
        conn.execute(
            "UPDATE design_notebook_entries SET updated_at = '2026-10-13 23:11:59'",
            [],
        )
        .unwrap();

        let entries = super::get_design_notebook_entries_with_sections(&conn).unwrap();
        assert_eq!(entries[0].updated_at, "2026-10-13T23:11:59Z");
    }

    #[test]
    fn relocation_rolls_back_membership_when_order_write_fails() {
        let conn = test_db();
        super::record_design_reference(&conn, "/first.canopi", "First", 1).unwrap();
        super::record_design_reference(&conn, "/second.canopi", "Second", 1).unwrap();
        let section = super::create_notebook_section(&conn, "Destination").unwrap();
        conn.execute_batch("CREATE TRIGGER reject_order BEFORE UPDATE OF sort_order ON design_notebook_entries BEGIN SELECT RAISE(ABORT, 'order unavailable'); END;").unwrap();
        let result = super::relocate_design_reference(
            &conn,
            "/first.canopi",
            Some(&section.id),
            &["/second.canopi".into(), "/first.canopi".into()],
        );
        assert!(result.is_err());
        let entries = super::get_design_notebook_entries_with_sections(&conn).unwrap();
        assert_eq!(entries[0].path, "/first.canopi");
        assert_eq!(entries[0].section_id, None);
    }

    #[test]
    fn relocation_commits_order_and_membership_and_rejects_stale_targets() {
        let conn = test_db();
        super::record_design_reference(&conn, "/first.canopi", "First", 1).unwrap();
        super::record_design_reference(&conn, "/second.canopi", "Second", 1).unwrap();
        let section = super::create_notebook_section(&conn, "Destination").unwrap();
        let paths = vec!["/second.canopi".into(), "/first.canopi".into()];
        super::relocate_design_reference(&conn, "/first.canopi", Some(&section.id), &paths)
            .unwrap();
        let entries = super::get_design_notebook_entries_with_sections(&conn).unwrap();
        assert_eq!(entries[0].path, "/second.canopi");
        assert_eq!(entries[1].section_id.as_deref(), Some(section.id.as_str()));
        assert!(
            super::relocate_design_reference(
                &conn,
                "/first.canopi",
                Some("deleted-section"),
                &paths
            )
            .is_err()
        );
        assert!(super::relocate_design_reference(&conn, "/missing.canopi", None, &paths).is_err());
        assert!(
            super::relocate_design_reference(
                &conn,
                "/first.canopi",
                None,
                &["/missing.canopi".into()]
            )
            .is_err()
        );
        let after = super::get_design_notebook_entries_with_sections(&conn).unwrap();
        assert_eq!(after[0].path, "/second.canopi");
        assert_eq!(after[1].section_id.as_deref(), Some(section.id.as_str()));
    }

    #[test]
    fn records_and_lists_saved_design_references() {
        let conn = test_db();

        super::record_design_reference(&conn, "/designs/forest.canopi", "Forest Edge", 7).unwrap();

        let entries = super::get_design_notebook_entries_with_sections(&conn).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "/designs/forest.canopi");
        assert_eq!(entries[0].name, "Forest Edge");
        assert_eq!(entries[0].plant_count, 7);
    }

    #[test]
    fn removes_saved_design_references() {
        let conn = test_db();
        super::record_design_reference(&conn, "/designs/forest.canopi", "Forest Edge", 7).unwrap();
        let section = super::create_notebook_section(&conn, "Clients").unwrap();
        super::assign_design_reference_to_section(&conn, "/designs/forest.canopi", &section.id)
            .unwrap();

        super::remove_design_reference(&conn, "/designs/forest.canopi").unwrap();

        assert!(
            super::get_design_notebook_entries_with_sections(&conn)
                .unwrap()
                .is_empty()
        );
        let membership_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM design_notebook_section_memberships",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(membership_count, 0);
    }

    #[test]
    fn creates_renames_and_deletes_notebook_sections() {
        let conn = test_db();

        let section = super::create_notebook_section(&conn, "Client work").unwrap();
        super::record_design_reference(&conn, "/designs/forest.canopi", "Forest Edge", 7).unwrap();
        super::assign_design_reference_to_section(&conn, "/designs/forest.canopi", &section.id)
            .unwrap();

        assert!(section.id.starts_with("section-"));
        assert_eq!(section.name, "Client work");
        assert_eq!(super::get_notebook_sections(&conn).unwrap().len(), 1);

        super::rename_notebook_section(&conn, &section.id, "Food forests").unwrap();
        assert_eq!(
            super::get_notebook_sections(&conn).unwrap()[0].name,
            "Food forests"
        );

        super::delete_notebook_section(&conn, &section.id).unwrap();
        assert!(super::get_notebook_sections(&conn).unwrap().is_empty());
        assert_eq!(
            super::get_design_notebook_entries_with_sections(&conn).unwrap()[0].section_id,
            None
        );
    }

    #[test]
    fn assigns_design_references_to_at_most_one_section() {
        let conn = test_db();
        super::record_design_reference(&conn, "/designs/forest.canopi", "Forest Edge", 7).unwrap();
        let first = super::create_notebook_section(&conn, "Clients").unwrap();
        let second = super::create_notebook_section(&conn, "Home").unwrap();

        super::assign_design_reference_to_section(&conn, "/designs/forest.canopi", &first.id)
            .unwrap();
        assert_eq!(
            super::get_design_notebook_entries_with_sections(&conn).unwrap()[0].section_id,
            Some(first.id.clone())
        );

        super::assign_design_reference_to_section(&conn, "/designs/forest.canopi", &second.id)
            .unwrap();
        assert_eq!(
            super::get_design_notebook_entries_with_sections(&conn).unwrap()[0].section_id,
            Some(second.id)
        );

        super::remove_design_reference_from_section(&conn, "/designs/forest.canopi").unwrap();
        assert_eq!(
            super::get_design_notebook_entries_with_sections(&conn).unwrap()[0].section_id,
            None
        );
    }

    #[test]
    fn reorders_notebook_sections_and_design_references() {
        let conn = test_db();
        let first_section = super::create_notebook_section(&conn, "First").unwrap();
        let second_section = super::create_notebook_section(&conn, "Second").unwrap();
        super::record_design_reference(&conn, "/designs/first.canopi", "First", 1).unwrap();
        super::record_design_reference(&conn, "/designs/second.canopi", "Second", 2).unwrap();

        super::reorder_notebook_sections(
            &conn,
            &[second_section.id.clone(), first_section.id.clone()],
        )
        .unwrap();
        super::reorder_design_references(
            &conn,
            &[
                "/designs/second.canopi".to_owned(),
                "/designs/first.canopi".to_owned(),
            ],
        )
        .unwrap();

        let sections = super::get_notebook_sections(&conn).unwrap();
        assert_eq!(
            sections
                .iter()
                .map(|section| section.id.as_str())
                .collect::<Vec<_>>(),
            [second_section.id.as_str(), first_section.id.as_str()]
        );
        assert_eq!(sections[0].sort_order, 0);
        assert_eq!(sections[1].sort_order, 1);

        let entries = super::get_design_notebook_entries_with_sections(&conn).unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["/designs/second.canopi", "/designs/first.canopi"]
        );
        assert_eq!(entries[0].sort_order, 0);
        assert_eq!(entries[1].sort_order, 1);
    }
}
