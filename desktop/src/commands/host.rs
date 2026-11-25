use canopi_types::design_home::{HomeRead, HomeWrite};
use canopi_types::dialog::{DialogKind, PickOpenOutcome, PickSaveOutcome};
use canopi_types::failure::Failure;
use canopi_types::ids::HomeVersion;
use tauri::State;

use crate::host::dialogs::{self, HostDialogs};
use crate::host::home::DesktopHomeStore;
use crate::host::launch::{PendingOpen, PendingOpenSlot};
use crate::native_operation::{NativeOperationClass, NativeOperationExecutor};

/// The Design file a launch asked to open, once: the pull empties the slot (2.1-M214).
#[tauri::command]
pub fn take_pending_open(slot: tauri::State<'_, PendingOpenSlot>) -> Option<PendingOpen> {
    slot.take()
}

/// Reads a Design home (file grant or Draft id) through the unified Desktop home store (2b-4).
#[tauri::command]
pub async fn home_read(
    executor: State<'_, NativeOperationExecutor>,
    home_store: State<'_, std::sync::Arc<DesktopHomeStore>>,
    key: String,
) -> Result<HomeRead, Failure> {
    home_read_with_executor(executor.inner(), home_store.inner().clone(), key).await
}

/// Durably writes a Design home (file grant or Draft id) with compare-and-swap precondition (2b-4).
#[tauri::command]
pub async fn home_write(
    executor: State<'_, NativeOperationExecutor>,
    home_store: State<'_, std::sync::Arc<DesktopHomeStore>>,
    key: String,
    bytes: Vec<u8>,
    expected: Option<HomeVersion>,
    keep_previous: Option<bool>,
) -> Result<HomeWrite, Failure> {
    home_write_with_executor(
        executor.inner(),
        home_store.inner().clone(),
        key,
        bytes,
        expected,
        keep_previous.unwrap_or(false),
    )
    .await
}

async fn home_read_with_executor(
    executor: &NativeOperationExecutor,
    store: std::sync::Arc<DesktopHomeStore>,
    key: String,
) -> Result<HomeRead, Failure> {
    executor
        .run_typed(NativeOperationClass::UserData, "design.open", move || {
            Ok(store.read(&key))
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
) -> Result<HomeWrite, Failure> {
    executor
        .run_typed(NativeOperationClass::UserData, "design.save", move || {
            Ok(store.write(&key, &bytes, expected.as_ref(), keep_previous))
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
    kind: DialogKind,
) -> Result<PickOpenOutcome, Failure> {
    dialogs::pick_open(executor.inner(), dialogs.inner(), window.label(), kind).await
}

/// Show `kind`'s Save dialog in the calling window, suggesting `stem`: the chosen path with the
/// kind's extension, or cancelled (2.1-M81).
#[tauri::command]
pub async fn pick_save<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    executor: State<'_, NativeOperationExecutor>,
    dialogs: State<'_, HostDialogs>,
    kind: DialogKind,
    stem: String,
) -> Result<PickSaveOutcome, Failure> {
    dialogs::pick_save(
        executor.inner(),
        dialogs.inner(),
        window.label(),
        kind,
        &stem,
    )
    .await
}
