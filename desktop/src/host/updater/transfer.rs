//! The payload's download for `UpdaterHost::download`, on the Network class's blocking thread.

use std::sync::Mutex;

use common_types::update::{NetworkFailureKind, UpdateFailure, UpdateOp, UpdateProgress};
use tauri_plugin_updater::Update;
use tokio::sync::watch;

use super::{ProgressSink, channel::Installation, failure};

/// The payload's transfer: the plugin's download raced against `cancelled` and the size cap its
/// chunk callback watches; progress goes to every sink.
pub(super) async fn transfer(
    update: &Update,
    installation: Installation,
    size_cap: u64,
    sinks: &Mutex<Vec<ProgressSink>>,
    cancelled: impl std::future::Future,
) -> Result<Vec<u8>, UpdateFailure> {
    let op = UpdateOp::Download;
    let (over_cap, mut watching) = watch::channel(false);
    let mut received: u64 = 0;
    let on_chunk = |length: usize, total: Option<u64>| {
        received = received.saturating_add(length as u64);
        if received > size_cap || total.is_some_and(|total| total > size_cap) {
            over_cap.send_replace(true);
            return;
        }
        let progress = UpdateProgress {
            received: u32::try_from(received).unwrap_or(u32::MAX),
            total: total.and_then(|total| u32::try_from(total).ok()),
        };
        for sink in sinks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
        {
            sink(progress);
        }
    };
    let too_large = || {
        failure::network(
            op,
            NetworkFailureKind::TooLarge,
            "the payload is larger than its cap",
        )
    };
    let downloaded = tokio::select! {
        biased;
        _ = cancelled => return Err(failure::cancelled(op)),
        _ = watching.wait_for(|over| *over) => return Err(too_large()),
        downloaded = update.download(on_chunk, || {}) => downloaded,
    };
    // A payload that arrived whole in one poll passed the cap before the watch was read.
    if *watching.borrow() {
        return Err(too_large());
    }
    downloaded.map_err(|error| failure::from_plugin(op, installation, &error))
}
