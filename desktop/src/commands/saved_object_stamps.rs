use super::design::internal_load_failure;
use crate::db::UserDb;
use crate::native_operation::{NativeOperationClass, NativeOperationExecutor};
use canopi_types::design::{CanopiFile, DesignLoadFailure};
use canopi_types::saved_object_stamps::SavedObjectStamp;
use tauri::State;

#[tauri::command]
pub async fn get_saved_object_stamps(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
) -> Result<Vec<SavedObjectStamp>, String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "saved object stamp read",
            move || crate::services::saved_object_stamps::get_saved_object_stamps(&user_db),
        )
        .await
}

#[tauri::command]
pub async fn create_saved_object_stamp(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    name: String,
    payload_json: String,
) -> Result<SavedObjectStamp, String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "saved object stamp create",
            move || {
                crate::services::saved_object_stamps::create_saved_object_stamp(
                    &user_db,
                    name,
                    payload_json,
                )
            },
        )
        .await
}

#[tauri::command]
pub async fn rename_saved_object_stamp(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    id: String,
    name: String,
) -> Result<SavedObjectStamp, String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "saved object stamp rename",
            move || {
                crate::services::saved_object_stamps::rename_saved_object_stamp(&user_db, id, name)
            },
        )
        .await
}

#[tauri::command]
pub async fn delete_saved_object_stamp(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    id: String,
) -> Result<bool, String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "saved object stamp delete",
            move || crate::services::saved_object_stamps::delete_saved_object_stamp(&user_db, id),
        )
        .await
}

#[tauri::command]
pub async fn reorder_saved_object_stamps(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    ids: Vec<String>,
) -> Result<Vec<SavedObjectStamp>, String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "saved object stamp reorder",
            move || {
                crate::services::saved_object_stamps::reorder_saved_object_stamps(&user_db, ids)
            },
        )
        .await
}

#[tauri::command]
pub async fn export_saved_object_stamp_canopi_file(
    executor: State<'_, NativeOperationExecutor>,
    path: String,
    content: CanopiFile,
) -> Result<String, String> {
    executor
        .run(
            NativeOperationClass::Local,
            "saved object stamp export",
            move || crate::services::design_files::export_design_file(path, content),
        )
        .await
}

/// Failures are typed (`DesignLoadFailure`), as for `load_design`, so the
/// interface can say a stamp file was saved before 2.0.
#[tauri::command]
pub async fn load_saved_object_stamp_canopi_file(
    executor: State<'_, NativeOperationExecutor>,
    path: String,
) -> Result<CanopiFile, DesignLoadFailure> {
    executor
        .run(
            NativeOperationClass::Local,
            "saved object stamp import",
            move || Ok(crate::services::design_files::load_design_file(path)),
        )
        .await
        .unwrap_or_else(|message| Err(internal_load_failure(message)))
}
