use canopi_types::design::{
    CanopiFile, DesignDraftSummary, DesignLoadFailure, DesignLoadFailureKind, DesignSummary,
    ReadOnlyDesign, RecentDesignSummary,
};
use tauri::State;

use crate::{
    db::UserDb,
    design::drafts::DesignDrafts,
    native_operation::{NativeOperationClass, NativeOperationExecutor},
    services::recent_design_previews::RecentDesignPreviews,
};

/// Create a new Design from the canonical shared defaults.
#[tauri::command]
pub fn new_design() -> Result<CanopiFile, String> {
    crate::services::design_files::new_design()
}

/// Read a Design saved by a newer Canopi into its `ReadOnlyDesign` view (2.1-M478).
#[tauri::command]
pub async fn read_newer_design(
    executor: State<'_, NativeOperationExecutor>,
    text: String,
) -> Result<ReadOnlyDesign, DesignLoadFailure> {
    executor
        .run(
            NativeOperationClass::Local,
            "design read newer",
            move || Ok(crate::design::format::read_newer_design_text(&text)),
        )
        .await
        .unwrap_or_else(|message| Err(internal_load_failure(message)))
}

/// The executor could not run the load: a typed `Internal` failure.
pub(crate) fn internal_load_failure(message: String) -> DesignLoadFailure {
    DesignLoadFailure {
        kind: DesignLoadFailureKind::Internal,
        message,
        field_path: None,
    }
}

/// Return up to 20 recently opened files, most recent first, with minted file grants and `recent_id`s.
#[tauri::command]
pub async fn get_recent_files(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    grants: State<'_, std::sync::Arc<crate::host::home::FileGrantRegistry>>,
) -> Result<Vec<DesignSummary>, String> {
    let user_db = user_db.inner().clone();
    let grants = grants.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "recent designs read",
            move || {
                let mut files = crate::services::design_files::get_recent_files(&user_db)?;
                for entry in &mut files {
                    if let Ok(info) = grants.grant_info(std::path::Path::new(&entry.path)) {
                        entry.grant = Some(info.grant);
                        entry.recent_id = Some(info.recent_id);
                    }
                }
                Ok(files)
            },
        )
        .await
}

/// Start › Recent Designs previews: counts, ground bounds and a sketch read
/// from each listed Design's file. Paths not on the list are skipped; files
/// over the preview cap or unreadable come back without a preview.
#[tauri::command]
pub async fn get_recent_design_previews(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    previews: State<'_, RecentDesignPreviews>,
    paths: Vec<String>,
) -> Result<Vec<RecentDesignSummary>, String> {
    recent_design_previews_with_executor(
        executor.inner(),
        user_db.inner().clone(),
        previews.inner().clone(),
        paths,
    )
    .await
}

async fn recent_design_previews_with_executor(
    executor: &NativeOperationExecutor,
    user_db: UserDb,
    previews: RecentDesignPreviews,
    paths: Vec<String>,
) -> Result<Vec<RecentDesignSummary>, String> {
    let listed = executor
        .run(
            NativeOperationClass::UserData,
            "recent design preview admission",
            move || crate::services::design_files::listed_recent_paths(&user_db, paths),
        )
        .await?;
    executor
        .run(
            NativeOperationClass::Local,
            "recent design previews",
            move || Ok(previews.previews(&listed)),
        )
        .await
}

/// Start › Recent Designs › Remove from list. The file is untouched.
#[tauri::command]
pub async fn remove_recent_design(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    path: String,
) -> Result<(), String> {
    remove_recent_design_with_executor(executor.inner(), user_db.inner().clone(), path).await
}

/// Start › Recent Designs › Show in folder: reveals a Design on the list in
/// its folder, and no other file.
#[tauri::command]
pub async fn show_recent_design_in_folder(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    path: String,
) -> Result<(), String> {
    show_recent_design_in_folder_with_executor(
        executor.inner(),
        user_db.inner().clone(),
        path,
        crate::services::folder_reveal::SystemFolderRevealer,
    )
    .await
}

async fn remove_recent_design_with_executor(
    executor: &NativeOperationExecutor,
    user_db: UserDb,
    path: String,
) -> Result<(), String> {
    executor
        .run(
            NativeOperationClass::UserData,
            "recent design removal",
            move || crate::services::design_files::remove_recent_design(&user_db, &path),
        )
        .await
}

async fn show_recent_design_in_folder_with_executor(
    executor: &NativeOperationExecutor,
    user_db: UserDb,
    path: String,
    revealer: impl crate::services::folder_reveal::FolderRevealer + Send + 'static,
) -> Result<(), String> {
    let file = executor
        .run(
            NativeOperationClass::UserData,
            "recent design lookup",
            move || crate::services::design_files::recent_design_file(&user_db, &path),
        )
        .await?;
    executor
        .run(
            NativeOperationClass::Local,
            "recent design reveal",
            move || crate::services::design_files::show_design_in_folder(&file, &revealer),
        )
        .await
}

/// List readable Design drafts and every one a newer Canopi saved, most recently written first.
#[tauri::command]
pub async fn list_design_drafts(
    executor: State<'_, NativeOperationExecutor>,
    drafts: State<'_, DesignDrafts>,
) -> Result<Vec<DesignDraftSummary>, String> {
    let drafts = drafts.inner().clone();
    executor
        .run(
            NativeOperationClass::Local,
            "design draft listing",
            move || drafts.list(),
        )
        .await
}

/// Delete the Design draft `id`; an absent draft is already deleted.
#[tauri::command]
pub async fn delete_design_draft(
    executor: State<'_, NativeOperationExecutor>,
    drafts: State<'_, DesignDrafts>,
    id: String,
) -> Result<(), String> {
    let drafts = drafts.inner().clone();
    executor
        .run(
            NativeOperationClass::Local,
            "design draft delete",
            move || drafts.delete(&id),
        )
        .await
}

#[cfg(test)]
mod tests;
