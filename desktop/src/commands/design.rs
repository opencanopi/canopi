use common_types::design::{
    CanopiFile, DesignDraftSummary, DesignLoadFailure, DesignLoadFailureKind, DesignSaveOutcome,
    DesignSummary, LoadedDesign, RecentDesignSummary,
};
use tauri::State;

use crate::{
    db::UserDb,
    design::drafts::DesignDrafts,
    host::dialogs::HostDialogs,
    native_operation::{NativeOperationClass, NativeOperationExecutor},
    services::recent_design_previews::RecentDesignPreviews,
};

// ---------------------------------------------------------------------------
// IPC commands: Design file I/O on paths the host dialogs chose
// (`commands::host::pick_open` and `pick_save`). A Design loaded or saved here
// records its folder for that window's next Open and Save dialogs.
// ---------------------------------------------------------------------------

/// Create a new Design from the canonical shared defaults.
#[tauri::command]
pub fn new_design() -> Result<CanopiFile, String> {
    crate::services::design_files::new_design()
}

/// Durably save a design to `path`.
///
/// With `expected_fingerprint`, the file is written only if it still has that
/// fingerprint; otherwise nothing is written and the outcome is `Conflict`.
/// `None` overwrites unconditionally (Save As, keeping this copy). The path
/// comes from the host's Save dialog; a written Design records its folder.
#[tauri::command]
pub async fn save_design<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    dialogs: State<'_, HostDialogs>,
    path: String,
    content: CanopiFile,
    expected_fingerprint: Option<String>,
) -> Result<DesignSaveOutcome, String> {
    let user_db = user_db.inner().clone();
    let outcome = executor
        .run(NativeOperationClass::Local, "design save", move || {
            crate::services::design_files::save_design(
                &user_db,
                path,
                content,
                expected_fingerprint,
            )
        })
        .await?;
    if let DesignSaveOutcome::Saved { path, .. } = &outcome {
        dialogs.record_design_folder(window.label(), path);
    }
    Ok(outcome)
}

/// Load a design and the fingerprint of the bytes read from `path`: a path
/// the host's Open dialog chose, a recent file or a launch's file. A loaded
/// Design records its folder. Failures are typed (`DesignLoadFailure`) so the
/// interface can say "made with an older version" rather than "invalid".
#[tauri::command]
pub async fn load_design<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    dialogs: State<'_, HostDialogs>,
    path: String,
) -> Result<LoadedDesign, DesignLoadFailure> {
    let user_db = user_db.inner().clone();
    let read = path.clone();
    let loaded = executor
        .run(NativeOperationClass::Local, "design load", move || {
            Ok(crate::services::design_files::load_design(&user_db, read))
        })
        .await
        .unwrap_or_else(|message| Err(internal_load_failure(message)))?;
    dialogs.record_design_folder(window.label(), &path);
    Ok(loaded)
}

/// The executor could not run the load: a typed `Internal` failure.
pub(crate) fn internal_load_failure(message: String) -> DesignLoadFailure {
    DesignLoadFailure {
        kind: DesignLoadFailureKind::Internal,
        message,
    }
}

/// Return up to 20 recently opened files, most recent first.
#[tauri::command]
pub async fn get_recent_files(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
) -> Result<Vec<DesignSummary>, String> {
    let user_db = user_db.inner().clone();
    executor
        .run(
            NativeOperationClass::UserData,
            "recent designs read",
            move || crate::services::design_files::get_recent_files(&user_db),
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

/// Durably write the Design draft `id` to the app-data drafts store.
#[tauri::command]
pub async fn save_design_draft(
    executor: State<'_, NativeOperationExecutor>,
    drafts: State<'_, DesignDrafts>,
    id: String,
    content: CanopiFile,
) -> Result<(), String> {
    let drafts = drafts.inner().clone();
    executor
        .run(
            NativeOperationClass::Local,
            "design draft save",
            move || drafts.save(&id, &content),
        )
        .await
}

/// Load the Design draft `id`.
#[tauri::command]
pub async fn load_design_draft(
    executor: State<'_, NativeOperationExecutor>,
    drafts: State<'_, DesignDrafts>,
    id: String,
) -> Result<CanopiFile, String> {
    let drafts = drafts.inner().clone();
    executor
        .run(
            NativeOperationClass::Local,
            "design draft load",
            move || drafts.load(&id),
        )
        .await
}

/// List readable Design drafts, most recently written first.
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
