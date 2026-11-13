use crate::db::UserDb;
use crate::db::user_db::write_refusal;
use crate::services::design_files::{design_path_availability, partition_by_availability};
use canopi_types::design::{CanopiFile, DesignNotebookSection, DesignNotebookSnapshot};

pub fn get_design_notebook(user_db: &UserDb) -> Result<DesignNotebookSnapshot, String> {
    let (entries, sections) = {
        let conn = user_db.acquire();
        let entries = crate::db::design_notebook::get_design_notebook_entries_with_sections(&conn)
            .map_err(|e| format!("Failed to get Design Notebook entries: {e}"))?;
        let sections = crate::db::design_notebook::get_notebook_sections(&conn)
            .map_err(|e| format!("Failed to get Design Notebook sections: {e}"))?;
        (entries, sections)
    };

    let filtered =
        partition_by_availability(entries, |entry| &entry.path, None, design_path_availability);
    prune_missing_design_notebook_entries(user_db, &filtered.missing_paths);
    Ok(DesignNotebookSnapshot {
        entries: filtered.visible,
        sections,
    })
}

pub fn create_notebook_section(
    user_db: &UserDb,
    name: &str,
) -> Result<DesignNotebookSection, String> {
    let name = normalize_section_name(name)?;
    let conn = user_db.acquire();
    crate::db::design_notebook::create_notebook_section(&conn, name)
        .map_err(write_refusal("Failed to create Notebook Section"))
}

pub fn add_design_reference(
    user_db: &UserDb,
    path: &str,
    design: &CanopiFile,
) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Design path is required".to_owned());
    }

    let conn = user_db.acquire();
    crate::db::design_notebook::record_design_reference(
        &conn,
        path,
        &design.name,
        design.plants.len() as u32,
    )
    .map_err(write_refusal("Failed to add Design to Notebook"))
}

pub fn rename_notebook_section(
    user_db: &UserDb,
    section_id: &str,
    name: &str,
) -> Result<(), String> {
    let name = normalize_section_name(name)?;
    let conn = user_db.acquire();
    crate::db::design_notebook::rename_notebook_section(&conn, section_id, name)
        .map_err(write_refusal("Failed to rename Notebook Section"))
}

pub fn delete_notebook_section(user_db: &UserDb, section_id: &str) -> Result<(), String> {
    let conn = user_db.acquire();
    crate::db::design_notebook::delete_notebook_section(&conn, section_id)
        .map_err(write_refusal("Failed to delete Notebook Section"))
}

pub fn move_design_reference_to_section(
    user_db: &UserDb,
    path: &str,
    section_id: Option<String>,
) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Design path is required".to_owned());
    }

    let conn = user_db.acquire();
    match section_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(section_id) => {
            crate::db::design_notebook::assign_design_reference_to_section(&conn, path, section_id)
                .map_err(write_refusal("Failed to move Design into Notebook Section"))?;
        }
        None => {
            crate::db::design_notebook::remove_design_reference_from_section(&conn, path).map_err(
                write_refusal("Failed to remove Design from Notebook Section"),
            )?;
        }
    }

    Ok(())
}

pub fn relocate_design_reference(
    user_db: &UserDb,
    path: &str,
    section_id: Option<String>,
    paths: Vec<String>,
) -> Result<(), String> {
    validate_order_values(&paths, "Design path")?;
    if path.trim().is_empty() || !paths.iter().any(|entry| entry == path) {
        return Err("Design Notebook relocation must include the moved Design in its order".into());
    }
    let conn = user_db.acquire();
    crate::db::design_notebook::relocate_design_reference(
        &conn,
        path,
        section_id.as_deref(),
        &paths,
    )
    .map_err(write_refusal("Failed to relocate Design Notebook entry"))
}

pub fn remove_design_reference(user_db: &UserDb, path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Design path is required".to_owned());
    }

    let conn = user_db.acquire();
    crate::db::design_notebook::remove_design_reference(&conn, path)
        .map_err(write_refusal("Failed to remove Design from Notebook"))
}

pub fn reorder_notebook_sections(user_db: &UserDb, section_ids: Vec<String>) -> Result<(), String> {
    validate_order_values(&section_ids, "Notebook Section id")?;
    let conn = user_db.acquire();
    crate::db::design_notebook::reorder_notebook_sections(&conn, &section_ids)
        .map_err(write_refusal("Failed to reorder Notebook Sections"))
}

pub fn reorder_design_references(user_db: &UserDb, paths: Vec<String>) -> Result<(), String> {
    validate_order_values(&paths, "Design path")?;
    let conn = user_db.acquire();
    crate::db::design_notebook::reorder_design_references(&conn, &paths)
        .map_err(write_refusal("Failed to reorder Design Notebook entries"))
}

fn normalize_section_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Notebook Section name is required".to_owned());
    }
    Ok(trimmed)
}

fn validate_order_values(values: &[String], label: &str) -> Result<(), String> {
    if values.iter().any(|value| value.trim().is_empty()) {
        return Err(format!("{label} is required"));
    }
    Ok(())
}

fn prune_missing_design_notebook_entries(user_db: &UserDb, paths: &[String]) {
    if paths.is_empty() {
        return;
    }

    let Some(conn) = user_db.acquire_writable() else {
        return;
    };
    for path in paths {
        if let Err(error) = crate::db::design_notebook::remove_design_reference(&conn, path) {
            tracing::warn!("Failed to prune a missing Design Notebook entry: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::db::UserDb;
    use crate::test_scratch::TestScratch;
    use rusqlite::Connection;
    use std::path::PathBuf;

    fn test_user_db() -> UserDb {
        let conn = Connection::open_in_memory().unwrap();
        UserDb::initialize(conn).unwrap()
    }

    fn test_user_db_at(path: &std::path::Path) -> UserDb {
        UserDb::open(path).unwrap().0
    }

    fn temp_design_path(scratch: &TestScratch, name: &str) -> PathBuf {
        scratch.join(format!("{name}.canopi"))
    }

    #[test]
    fn notebook_listing_prunes_missing_paths() {
        let scratch = TestScratch::new("design-notebook-notebook-listing-prunes-missing-paths");
        let user_db = test_user_db();
        let existing_path = temp_design_path(&scratch, "existing");
        let missing_path = temp_design_path(&scratch, "missing");
        std::fs::write(&existing_path, "{}").unwrap();
        {
            let conn = user_db.acquire();
            crate::db::design_notebook::record_design_reference(
                &conn,
                &existing_path.to_string_lossy(),
                "Existing Design",
                3,
            )
            .unwrap();
            crate::db::design_notebook::record_design_reference(
                &conn,
                &missing_path.to_string_lossy(),
                "Missing Design",
                1,
            )
            .unwrap();
        }

        let entries = super::get_design_notebook(&user_db).unwrap().entries;
        let stored = {
            let conn = user_db.acquire();
            crate::db::design_notebook::get_design_notebook_entries_with_sections(&conn).unwrap()
        };

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, existing_path.to_string_lossy());
        assert!(
            stored
                .iter()
                .all(|entry| entry.path != missing_path.to_string_lossy()),
            "missing Design Notebook entry should be pruned"
        );

        let _ = std::fs::remove_file(existing_path);
    }

    #[test]
    fn notebook_keeps_entries_whose_drive_is_unavailable() {
        let scratch =
            TestScratch::new("design-notebook-notebook-keeps-entries-whose-drive-is-unavailable");
        let user_db = test_user_db();
        let unmounted = temp_design_path(&scratch, "unmounted_drive")
            .with_extension("")
            .join("garden.canopi");
        {
            let conn = user_db.acquire();
            crate::db::design_notebook::record_design_reference(
                &conn,
                &unmounted.to_string_lossy(),
                "Garden on a USB drive",
                2,
            )
            .unwrap();
        }

        let snapshot = super::get_design_notebook(&user_db).unwrap();
        let stored = {
            let conn = user_db.acquire();
            crate::db::design_notebook::get_design_notebook_entries_with_sections(&conn).unwrap()
        };

        assert!(
            snapshot.entries.is_empty(),
            "an unreachable Design is hidden"
        );
        assert_eq!(stored.len(), 1, "an unreachable Design is not forgotten");
    }

    #[test]
    fn notebook_snapshot_includes_sections_and_membership() {
        let scratch =
            TestScratch::new("design-notebook-notebook-snapshot-includes-sections-and-membership");
        let user_db = test_user_db();
        let design_path = temp_design_path(&scratch, "sectioned");
        std::fs::write(&design_path, "{}").unwrap();
        {
            let conn = user_db.acquire();
            crate::db::design_notebook::record_design_reference(
                &conn,
                &design_path.to_string_lossy(),
                "Sectioned Design",
                4,
            )
            .unwrap();
        }
        let section = super::create_notebook_section(&user_db, "Client work").unwrap();
        super::move_design_reference_to_section(
            &user_db,
            design_path.to_string_lossy().as_ref(),
            Some(section.id.clone()),
        )
        .unwrap();

        let snapshot = super::get_design_notebook(&user_db).unwrap();

        assert_eq!(snapshot.sections.len(), 1);
        assert_eq!(snapshot.sections[0].name, "Client work");
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].section_id, Some(section.id));

        let _ = std::fs::remove_file(design_path);
    }

    #[test]
    fn deleting_section_keeps_design_references_unsectioned() {
        let scratch = TestScratch::new(
            "design-notebook-deleting-section-keeps-design-references-unsectioned",
        );
        let user_db = test_user_db();
        let design_path = temp_design_path(&scratch, "deleted_section");
        std::fs::write(&design_path, "{}").unwrap();
        {
            let conn = user_db.acquire();
            crate::db::design_notebook::record_design_reference(
                &conn,
                &design_path.to_string_lossy(),
                "Unsectioned Design",
                2,
            )
            .unwrap();
        }
        let section = super::create_notebook_section(&user_db, "Temporary").unwrap();
        super::move_design_reference_to_section(
            &user_db,
            design_path.to_string_lossy().as_ref(),
            Some(section.id.clone()),
        )
        .unwrap();

        super::delete_notebook_section(&user_db, &section.id).unwrap();
        let snapshot = super::get_design_notebook(&user_db).unwrap();

        assert!(snapshot.sections.is_empty());
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].section_id, None);

        let _ = std::fs::remove_file(design_path);
    }

    #[test]
    fn removing_design_reference_preserves_design_file() {
        let scratch =
            TestScratch::new("design-notebook-removing-design-reference-preserves-design-file");
        let user_db = test_user_db();
        let design_path = temp_design_path(&scratch, "remove_reference");
        std::fs::write(&design_path, "{}").unwrap();
        {
            let conn = user_db.acquire();
            crate::db::design_notebook::record_design_reference(
                &conn,
                &design_path.to_string_lossy(),
                "Removable Design",
                2,
            )
            .unwrap();
        }

        super::remove_design_reference(&user_db, design_path.to_string_lossy().as_ref()).unwrap();
        let snapshot = super::get_design_notebook(&user_db).unwrap();

        assert!(snapshot.entries.is_empty());
        assert!(
            design_path.exists(),
            "removing a notebook reference must not delete the Design file"
        );

        let _ = std::fs::remove_file(design_path);
    }

    #[test]
    fn manual_order_survives_user_db_reopen() {
        let scratch = TestScratch::new("design-notebook-manual-order-survives-user-db-reopen");
        let db_path = temp_design_path(&scratch, "ordered_user_db").with_extension("db");
        let first_design_path = temp_design_path(&scratch, "ordered_first");
        let second_design_path = temp_design_path(&scratch, "ordered_second");
        std::fs::write(&first_design_path, "{}").unwrap();
        std::fs::write(&second_design_path, "{}").unwrap();

        let (first_section_id, second_section_id) = {
            let user_db = test_user_db_at(&db_path);
            {
                let conn = user_db.acquire();
                crate::db::design_notebook::record_design_reference(
                    &conn,
                    &first_design_path.to_string_lossy(),
                    "First Design",
                    1,
                )
                .unwrap();
                crate::db::design_notebook::record_design_reference(
                    &conn,
                    &second_design_path.to_string_lossy(),
                    "Second Design",
                    2,
                )
                .unwrap();
            }
            let first_section = super::create_notebook_section(&user_db, "First Section").unwrap();
            let second_section =
                super::create_notebook_section(&user_db, "Second Section").unwrap();

            super::reorder_notebook_sections(
                &user_db,
                vec![second_section.id.clone(), first_section.id.clone()],
            )
            .unwrap();
            super::reorder_design_references(
                &user_db,
                vec![
                    second_design_path.to_string_lossy().to_string(),
                    first_design_path.to_string_lossy().to_string(),
                ],
            )
            .unwrap();

            (first_section.id, second_section.id)
        };

        let reopened = test_user_db_at(&db_path);
        let snapshot = super::get_design_notebook(&reopened).unwrap();

        assert_eq!(
            snapshot
                .sections
                .iter()
                .map(|section| section.id.as_str())
                .collect::<Vec<_>>(),
            [second_section_id.as_str(), first_section_id.as_str()]
        );
        assert_eq!(
            snapshot
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            [
                second_design_path.to_string_lossy().as_ref(),
                first_design_path.to_string_lossy().as_ref(),
            ]
        );

        let _ = std::fs::remove_file(first_design_path);
        let _ = std::fs::remove_file(second_design_path);
        let _ = std::fs::remove_file(db_path);
    }
}
