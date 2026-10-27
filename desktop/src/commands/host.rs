use common_types::dialog::{DialogKind, PickOpenOutcome, PickSaveOutcome};
use tauri::{Manager as _, State};

use crate::host::dialogs::{self, HostDialogs};
use crate::host::launch::{PendingOpen, PendingOpenSlot};
use crate::native_operation::NativeOperationExecutor;

/// The Design file a launch asked to open, once: the pull empties the slot (2.1-M214).
#[tauri::command]
pub fn take_pending_open(slot: tauri::State<'_, PendingOpenSlot>) -> Option<PendingOpen> {
    slot.take()
}

/// Show `kind`'s Open dialog in the calling window: the chosen paths, or cancelled (2.1-M81).
#[tauri::command]
pub async fn pick_open(
    window: tauri::WebviewWindow,
    executor: State<'_, NativeOperationExecutor>,
    dialogs: State<'_, HostDialogs>,
    kind: DialogKind,
) -> Result<PickOpenOutcome, String> {
    let picker = dialogs::system_picker(window.app_handle());
    dialogs::pick_open(
        executor.inner(),
        dialogs.inner(),
        picker,
        window.label(),
        kind,
    )
    .await
}

/// Show `kind`'s Save dialog in the calling window, suggesting `stem`: the chosen path with the
/// kind's extension, or cancelled (2.1-M81).
#[tauri::command]
pub async fn pick_save(
    window: tauri::WebviewWindow,
    executor: State<'_, NativeOperationExecutor>,
    dialogs: State<'_, HostDialogs>,
    kind: DialogKind,
    stem: String,
) -> Result<PickSaveOutcome, String> {
    let picker = dialogs::system_picker(window.app_handle());
    dialogs::pick_save(
        executor.inner(),
        dialogs.inner(),
        picker,
        window.label(),
        kind,
        &stem,
    )
    .await
}
