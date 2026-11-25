use canopi_types::design_home::{FileHomeGrant, HomeRead, HomeWrite};
use canopi_types::dialog::{DialogKind, PickOpenOutcome, PickSaveOutcome};
use canopi_types::failure::{Failure, FailureCode};
use canopi_types::ids::{FileGrantId, HomeVersion};
use tauri::State;

use crate::db::UserDb;
use crate::host::dialogs::{self, HostDialogs};
use crate::host::home::{DesktopHomeStore, FileGrantRegistry, recent_id_for_path};
use crate::host::launch::{PendingOpen, PendingOpenSlot};
use crate::native_operation::{NativeOperationClass, NativeOperationExecutor};

/// The Design file a launch asked to open, once: the pull empties the slot (2.1-M214).
#[tauri::command]
pub fn take_pending_open(slot: tauri::State<'_, PendingOpenSlot>) -> Option<PendingOpen> {
    slot.take()
}

/// Reads a Design home (file grant or Draft id) through the unified Desktop home store (2b-4).
#[tauri::command]
pub async fn home_read<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    executor: State<'_, NativeOperationExecutor>,
    home_store: State<'_, std::sync::Arc<DesktopHomeStore>>,
    dialogs: State<'_, HostDialogs>,
    key: String,
) -> Result<HomeRead, Failure> {
    let (outcome, folder_path) =
        home_read_with_executor(executor.inner(), home_store.inner().clone(), key).await?;
    if let Some(path) = folder_path {
        dialogs.record_design_folder(window.label(), path);
    }
    Ok(outcome)
}

/// Durably writes a Design home (file grant or Draft id) with compare-and-swap precondition (2b-4).
#[tauri::command]
pub async fn home_write<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    executor: State<'_, NativeOperationExecutor>,
    home_store: State<'_, std::sync::Arc<DesktopHomeStore>>,
    key: String,
    bytes: Vec<u8>,
    expected: Option<HomeVersion>,
    keep_previous: Option<bool>,
) -> Result<HomeWrite, Failure> {
    let (outcome, folder_path) = home_write_with_executor(
        executor.inner(),
        home_store.inner().clone(),
        key,
        bytes,
        expected,
        keep_previous.unwrap_or(false),
    )
    .await?;
    if let Some(path) = folder_path {
        tauri::Manager::state::<HostDialogs>(&window).record_design_folder(window.label(), path);
    }
    Ok(outcome)
}

async fn home_read_with_executor(
    executor: &NativeOperationExecutor,
    store: std::sync::Arc<DesktopHomeStore>,
    key: String,
) -> Result<(HomeRead, Option<std::path::PathBuf>), Failure> {
    executor
        .run_typed(NativeOperationClass::UserData, "design.open", move || {
            let outcome = store.read(&key);
            let folder_path = matches!(outcome, HomeRead::Present { .. })
                .then(|| {
                    FileGrantRegistry::is_grant(&key)
                        .then(|| store.grants().resolve(&FileGrantId::new(key)))
                        .flatten()
                })
                .flatten();
            Ok((outcome, folder_path))
        })
        .await
}

async fn home_write_with_executor(
    executor: &NativeOperationExecutor,
    store: std::sync::Arc<DesktopHomeStore>,
    key: String,
    bytes: Vec<u8>,
    expected: Option<HomeVersion>,
    keep_previous: bool,
) -> Result<(HomeWrite, Option<std::path::PathBuf>), Failure> {
    executor
        .run_typed(NativeOperationClass::UserData, "design.save", move || {
            let outcome = store.write(&key, &bytes, expected.as_ref(), keep_previous);
            let folder_path = matches!(outcome, HomeWrite::Written { .. })
                .then(|| {
                    FileGrantRegistry::is_grant(&key)
                        .then(|| store.grants().resolve(&FileGrantId::new(key)))
                        .flatten()
                })
                .flatten();
            Ok((outcome, folder_path))
        })
        .await
}

/// Resolves an opaque `recent_id` from `last_open_home` or Recent Designs into a minted [`FileHomeGrant`].
#[tauri::command]
pub async fn grant_for_recent(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    grants: State<'_, std::sync::Arc<FileGrantRegistry>>,
    recent_id: String,
) -> Result<Option<FileHomeGrant>, Failure> {
    let user_db = user_db.inner().clone();
    let grants = grants.inner().clone();
    executor
        .run_typed(NativeOperationClass::UserData, "design.open", move || {
            let files = crate::services::design_files::get_recent_files(&user_db)
                .map_err(|_| Failure::new(FailureCode::Internal, "design.open"))?;
            for entry in files {
                if recent_id_for_path(&entry.path) == recent_id {
                    return grants
                        .grant_info(std::path::Path::new(&entry.path))
                        .map(Some)
                        .map_err(|_| Failure::new(FailureCode::Invalid, "design.open"));
                }
            }
            Ok(None)
        })
        .await
}

/// Show `kind`'s Open dialog in the calling window: the chosen paths, or cancelled (2.1-M81);
/// a second while one is open settles `dialog_already_open` (2.1-Q284).
#[tauri::command]
pub async fn pick_open<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    executor: State<'_, NativeOperationExecutor>,
    dialogs: State<'_, HostDialogs>,
    grants: State<'_, std::sync::Arc<FileGrantRegistry>>,
    kind: DialogKind,
) -> Result<PickOpenOutcome, Failure> {
    dialogs::pick_open(
        executor.inner(),
        dialogs.inner(),
        grants.inner(),
        window.label(),
        kind,
    )
    .await
}

/// Show `kind`'s Save dialog in the calling window, suggesting `stem`: the chosen path with the
/// kind's extension, or cancelled (2.1-M81).
#[tauri::command]
pub async fn pick_save<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    executor: State<'_, NativeOperationExecutor>,
    dialogs: State<'_, HostDialogs>,
    grants: State<'_, std::sync::Arc<FileGrantRegistry>>,
    kind: DialogKind,
    stem: String,
) -> Result<PickSaveOutcome, Failure> {
    dialogs::pick_save(
        executor.inner(),
        dialogs.inner(),
        grants.inner(),
        window.label(),
        kind,
        &stem,
    )
    .await
}
