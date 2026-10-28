//! The update commands (contracts §3 Updater, 2.1-M241): thin calls into `host::updater`, whose
//! check, download and install run on the native executor. The webview holds no `updater:*`
//! permission (2.1-Q240); these commands are the only way in.

use std::{path::PathBuf, sync::Arc};

use common_types::update::{UpdateDownload, UpdateFailure, UpdateOffer, UpdateProgress};
use tauri::{AppHandle, Runtime, State, ipc::Channel};

use crate::{
    db::UserDb,
    host::updater::{self, ProgressSink, UpdaterHost},
    native_operation::NativeOperationExecutor,
};

/// Checks the channel for a newer release for this installer: the offer, or none.
#[tauri::command]
pub async fn update_check<R: Runtime>(
    app: AppHandle<R>,
    executor: State<'_, NativeOperationExecutor>,
    updater: State<'_, UpdaterHost>,
) -> Result<Option<UpdateOffer>, UpdateFailure> {
    UpdaterHost::check(updater.inner(), &app, executor.inner()).await
}

/// Downloads and verifies the offered update, its progress sent on `progress`; `link_only` when
/// this installer cannot replace itself.
#[tauri::command]
pub async fn update_download<R: Runtime>(
    app: AppHandle<R>,
    executor: State<'_, NativeOperationExecutor>,
    updater: State<'_, UpdaterHost>,
    progress: Channel<UpdateProgress>,
) -> Result<UpdateDownload, UpdateFailure> {
    let sink: ProgressSink = Arc::new(move |received| {
        // A closed webview channel only loses the progress line; the download goes on.
        let _sent = progress.send(received);
    });
    UpdaterHost::download(updater.inner(), &app, executor.inner(), sink).await
}

/// Installs the verified update; every failure leaves the Design open.
#[tauri::command]
pub async fn update_install<R: Runtime>(
    app: AppHandle<R>,
    executor: State<'_, NativeOperationExecutor>,
    updater: State<'_, UpdaterHost>,
) -> Result<(), UpdateFailure> {
    UpdaterHost::install(updater.inner(), &app, executor.inner()).await
}

/// Cancels the running check or download.
#[tauri::command]
pub fn update_cancel(updater: State<'_, UpdaterHost>) {
    updater.cancel();
}

/// Restarts into the updated Canopi with `design_path` open, or to the start screen for a Draft.
/// Runs off the main thread.
#[tauri::command(async)]
pub fn update_restart<R: Runtime>(app: AppHandle<R>, design_path: Option<PathBuf>) {
    updater::restart(&app, design_path)
}

/// Whether Canopi checks for an update at launch.
#[tauri::command]
pub async fn update_launch_check_get(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
) -> Result<bool, UpdateFailure> {
    updater::launch_check_get(executor.inner(), user_db.inner().clone()).await
}

/// Stores whether Canopi checks for an update at launch.
#[tauri::command]
pub async fn update_launch_check_set(
    executor: State<'_, NativeOperationExecutor>,
    user_db: State<'_, UserDb>,
    on: bool,
) -> Result<(), UpdateFailure> {
    updater::launch_check_set(executor.inner(), user_db.inner().clone(), on).await
}

/// Whether this launch follows a Windows update that did not install; true once.
#[tauri::command]
pub async fn update_take_launch_notice<R: Runtime>(
    app: AppHandle<R>,
    executor: State<'_, NativeOperationExecutor>,
    updater: State<'_, UpdaterHost>,
) -> Result<bool, UpdateFailure> {
    UpdaterHost::take_launch_notice(updater.inner(), &app, executor.inner()).await
}
