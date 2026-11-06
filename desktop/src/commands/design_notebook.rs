use canopi_types::design::{CanopiFile, DesignNotebookSection, DesignNotebookSnapshot};

use crate::{
    db::UserDb,
    native_operation::{NativeOperationClass, NativeOperationExecutor},
};
use tauri::State;

#[tauri::command]
pub async fn get_design_notebook(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
) -> Result<DesignNotebookSnapshot, String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "design notebook read",
            move || crate::services::design_notebook::get_design_notebook(&user_db),
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
    path: String,
    content: CanopiFile,
) -> Result<(), String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "design notebook reference add",
            move || {
                crate::services::design_notebook::add_design_reference(&user_db, &path, &content)
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
