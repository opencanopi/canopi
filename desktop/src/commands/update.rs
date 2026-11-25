//! The update commands (contracts §3 Updater, 2.1-M241): thin calls into `host::updater`, whose
//! check, download and install run on the native executor. The webview holds no `updater:*`
//! permission (2.1-Q240); these commands are the only way in.

use std::sync::Arc;

use canopi_types::{
    failure::Failure,
    update::{UpdateDownload, UpdateOffer, UpdateProgress},
};
use tauri::{AppHandle, Runtime, State, ipc::Channel};

use crate::{
    host::updater::{self, ProgressSink, UpdaterHost},
    native_operation::NativeOperationExecutor,
};

/// Checks the channel for a newer release for this installer: the offer, or none. `operation` is
/// the caller's id for this request, the one `update_cancel` names.
#[tauri::command]
pub async fn update_check<R: Runtime>(
    app: AppHandle<R>,
    executor: State<'_, NativeOperationExecutor>,
    updater: State<'_, UpdaterHost>,
    operation: String,
) -> Result<Option<UpdateOffer>, Failure> {
    UpdaterHost::check(updater.inner(), &app, executor.inner(), &operation).await
}

/// Downloads and verifies the offered update, its progress sent on `progress`; `link_only` when
/// this installer cannot replace itself. `operation` is the caller's id for this request.
#[tauri::command]
pub async fn update_download<R: Runtime>(
    app: AppHandle<R>,
    executor: State<'_, NativeOperationExecutor>,
    updater: State<'_, UpdaterHost>,
    operation: String,
    progress: Channel<UpdateProgress>,
) -> Result<UpdateDownload, Failure> {
    let sink: ProgressSink = Arc::new(move |received| {
        // A closed webview channel only loses the progress line; the download goes on.
        let _sent = progress.send(received);
    });
    UpdaterHost::download(updater.inner(), &app, executor.inner(), &operation, sink).await
}

/// Installs the verified update; every failure leaves the Design open (2.1-M523: launch reopens
/// the last open home, so no Design path is passed to the installer).
#[tauri::command]
pub async fn update_install<R: Runtime>(
    app: AppHandle<R>,
    executor: State<'_, NativeOperationExecutor>,
    updater: State<'_, UpdaterHost>,
) -> Result<(), Failure> {
    UpdaterHost::install(updater.inner(), &app, executor.inner()).await
}

/// Cancels the check or download `operation` names, even one that has not reached the host yet:
/// this command runs on the main thread, the ops on the async runtime.
#[tauri::command]
pub fn update_cancel(updater: State<'_, UpdaterHost>, operation: String) {
    updater.cancel(&operation);
}

/// Restarts into the updated Canopi with no Design path argument; launch reopens the last open
/// home (2.1-Q127, 2.1-M523). Runs off the main thread.
#[tauri::command(async)]
pub fn update_restart<R: Runtime>(app: AppHandle<R>) {
    updater::restart(&app)
}

/// Whether this launch follows a Windows update that did not install; true once.
#[tauri::command]
pub async fn update_take_launch_notice<R: Runtime>(
    app: AppHandle<R>,
    executor: State<'_, NativeOperationExecutor>,
    updater: State<'_, UpdaterHost>,
) -> Result<bool, Failure> {
    UpdaterHost::take_launch_notice(updater.inner(), &app, executor.inner()).await
}
