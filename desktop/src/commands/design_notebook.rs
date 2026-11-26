use std::path::Path;
use std::sync::Arc;

use canopi_types::design::v10::CanopiFileV10;
use canopi_types::design::{DesignNotebookSection, DesignNotebookSnapshot};
use canopi_types::ids::FileGrantId;

use crate::{
    db::UserDb,
    host::home::FileGrantRegistry,
    native_operation::{NativeOperationClass, NativeOperationExecutor},
};
use tauri::State;

#[tauri::command]
pub async fn get_design_notebook(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    grants: State<'_, Arc<FileGrantRegistry>>,
) -> Result<DesignNotebookSnapshot, String> {
    let user_db = user_db.inner().clone();
    let grants = grants.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "design notebook read",
            move || {
                let mut snapshot = crate::services::design_notebook::get_design_notebook(&user_db)?;
                for entry in &mut snapshot.entries {
                    if let Ok(info) = grants.grant_info(Path::new(&entry.path)) {
                        entry.grant = Some(info.grant.to_string());
                        entry.recent_id = Some(info.recent_id);
                    }
                }
                Ok(snapshot)
            },
        )
        .await
}

#[tauri::command]
pub async fn create_notebook_section(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    name: String,
) -> Result<DesignNotebookSection, String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "notebook section create",
            move || crate::services::design_notebook::create_notebook_section(&user_db, &name),
        )
        .await
}

#[tauri::command]
pub async fn add_design_reference_to_notebook(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    grants: State<'_, Arc<FileGrantRegistry>>,
    path: String,
    content: CanopiFileV10,
) -> Result<(), String> {
    let user_db = user_db.inner().clone();
    let grants = grants.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "design notebook reference add",
            move || {
                if !FileGrantRegistry::is_grant(&path) {
                    return Err("Design Notebook requires a host-issued file grant".to_owned());
                }
                let resolved_path = grants
                    .resolve(&FileGrantId::new(path))
                    .ok_or_else(|| "Unknown Design file grant".to_owned())?
                    .to_string_lossy()
                    .into_owned();
                crate::services::design_notebook::add_design_reference(
                    &user_db,
                    &resolved_path,
                    &content,
                )
            },
        )
        .await
}

#[tauri::command]
pub async fn rename_notebook_section(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    section_id: String,
    name: String,
) -> Result<(), String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "notebook section rename",
            move || {
                crate::services::design_notebook::rename_notebook_section(
                    &user_db,
                    &section_id,
                    &name,
                )
            },
        )
        .await
}

#[tauri::command]
pub async fn delete_notebook_section(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    section_id: String,
) -> Result<(), String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "notebook section delete",
            move || {
                crate::services::design_notebook::delete_notebook_section(&user_db, &section_id)
            },
        )
        .await
}

#[tauri::command]
pub async fn move_design_reference_to_section(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    path: String,
    section_id: Option<String>,
) -> Result<(), String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "design notebook reference move",
            move || {
                crate::services::design_notebook::move_design_reference_to_section(
                    &user_db, &path, section_id,
                )
            },
        )
        .await
}

#[tauri::command]
pub async fn remove_design_reference(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    path: String,
) -> Result<(), String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "design notebook reference remove",
            move || crate::services::design_notebook::remove_design_reference(&user_db, &path),
        )
        .await
}

#[tauri::command]
pub async fn reorder_notebook_sections(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    section_ids: Vec<String>,
) -> Result<(), String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "notebook section reorder",
            move || {
                crate::services::design_notebook::reorder_notebook_sections(&user_db, section_ids)
            },
        )
        .await
}

#[tauri::command]
pub async fn reorder_design_references(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    paths: Vec<String>,
) -> Result<(), String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "design notebook reference reorder",
            move || crate::services::design_notebook::reorder_design_references(&user_db, paths),
        )
        .await
}

#[tauri::command]
pub async fn relocate_design_reference(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    path: String,
    section_id: Option<String>,
    paths: Vec<String>,
) -> Result<(), String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "design notebook reference relocate",
            move || {
                crate::services::design_notebook::relocate_design_reference(
                    &user_db, &path, section_id, paths,
                )
            },
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Manager;

    #[test]
    fn b1_add_resolves_grant_to_real_path_and_get_mints_grant_and_recent_id_for_non_recents() {
        let scratch = crate::test_scratch::TestScratch::new("notebook-cmd-b1");
        let file_path = scratch.join("orchard.canopi");
        let file = crate::design::format::create_new_design("Orchard", "2026-09-25T00:00:00Z");
        crate::design::format::export_to_file(&file_path, &file).unwrap();
        let user_db = UserDb::initialize(rusqlite::Connection::open_in_memory().unwrap()).unwrap();
        let grants = Arc::new(FileGrantRegistry::default());
        let grant = grants.grant(&file_path).unwrap();
        let app = tauri::test::mock_builder()
            .manage(NativeOperationExecutor::production())
            .manage(user_db)
            .manage(Arc::clone(&grants))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();

        tauri::async_runtime::block_on(add_design_reference_to_notebook(
            app.state(),
            app.state(),
            app.state(),
            grant.as_str().to_owned(),
            file,
        ))
        .unwrap();

        // Simulate restart with a fresh grant table and empty Recents.
        let fresh_grants = Arc::new(FileGrantRegistry::default());
        let app2 = tauri::test::mock_builder()
            .manage(NativeOperationExecutor::production())
            .manage(app.state::<UserDb>().inner().clone())
            .manage(Arc::clone(&fresh_grants))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let snapshot = tauri::async_runtime::block_on(get_design_notebook(
            app2.state(),
            app2.state(),
            app2.state(),
        ))
        .unwrap();
        assert_eq!(snapshot.entries.len(), 1);
        let entry = &snapshot.entries[0];
        assert_eq!(entry.path, file_path.to_string_lossy());
        assert!(!FileGrantRegistry::is_grant(&entry.path));
        let minted = entry.grant.as_deref().expect("fresh grant minted");
        assert!(FileGrantRegistry::is_grant(minted));
        assert_eq!(
            fresh_grants.resolve(&FileGrantId::new(minted)),
            Some(file_path.clone())
        );
        assert!(entry.recent_id.as_deref().is_some_and(|id| id.len() == 64));
    }

    #[test]
    fn f1_add_refuses_raw_non_grant_path() {
        let scratch = crate::test_scratch::TestScratch::new("notebook-cmd-f1");
        let file_path = scratch.join("secret.canopi");
        let file = crate::design::format::create_new_design("Secret", "2026-09-25T00:00:00Z");
        crate::design::format::export_to_file(&file_path, &file).unwrap();
        let user_db = UserDb::initialize(rusqlite::Connection::open_in_memory().unwrap()).unwrap();
        let grants = Arc::new(FileGrantRegistry::default());
        let app = tauri::test::mock_builder()
            .manage(NativeOperationExecutor::production())
            .manage(user_db)
            .manage(Arc::clone(&grants))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();

        let err = tauri::async_runtime::block_on(add_design_reference_to_notebook(
            app.state(),
            app.state(),
            app.state(),
            file_path.to_string_lossy().into_owned(),
            file,
        ))
        .expect_err("raw non-grant path must be refused");
        assert!(err.contains("file grant"), "unexpected error: {err}");

        let snapshot = tauri::async_runtime::block_on(get_design_notebook(
            app.state(),
            app.state(),
            app.state(),
        ))
        .unwrap();
        assert!(snapshot.entries.is_empty());
    }
}
