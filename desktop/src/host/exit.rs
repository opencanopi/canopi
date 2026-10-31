//! The bounded write drain every exit runs (2.1-M82, 2.1-M321). It sits in the host, not the crate
//! root, so the updater's exits call it without reaching back into the crate root (`rust-scc`),
//! and outside `native_operation`, which stays free of Tauri (`tauri-only-in-shell`).

use tauri::{AppHandle, Manager as _, Runtime};

use crate::native_operation::{EXIT_DRAIN_DEADLINE, NativeOperationExecutor};

/// The Design, Draft and settings writes the frontend has sent land, up to `EXIT_DRAIN_DEADLINE`,
/// and no write is admitted after. The exit event runs it, which covers a window close and the
/// NSIS installer's Restart Manager close (`WM_ENDSESSION`, which reaches only `RunEvent::Exit`);
/// the update's exits skip that event, so they run it themselves: the Linux restart and the
/// Windows installer start (`host::updater`). An edit the frontend has not yet sent (continuous
/// save's delay) when the exit starts is the residual.
pub fn flush_writes_before_exit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(executor) = app.try_state::<NativeOperationExecutor>() {
        executor.drain_writes_before_exit(EXIT_DRAIN_DEADLINE);
    }
}
