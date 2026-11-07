//! The payload's download for `UpdaterHost::download`, on the Network class's blocking thread.

use std::sync::{Arc, Mutex};

use canopi_types::{
    failure::{Failure, NetworkFailureKind},
    update::{UpdateOp, UpdateProgress},
};
use tauri_plugin_updater::Update;
use tokio::sync::watch;

use super::{channel::Installation, failure};

/// Where a download's progress goes; the command's channel in the app.
pub type ProgressSink = Arc<dyn Fn(UpdateProgress) + Send + Sync>;

/// The payload's transfer: the plugin's download raced against `cancelled` and the size cap its
/// chunk callback watches; progress goes to every sink.
pub(super) async fn transfer(
    update: &Update,
    installation: Installation,
    size_cap: u64,
    sinks: &Mutex<Vec<ProgressSink>>,
    cancelled: impl std::future::Future,
) -> Result<Vec<u8>, Failure> {
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

#[cfg(test)]
mod tests {
    use canopi_types::{
        failure::{Failure, NetworkFailureKind},
        update::UpdateDownload,
    };

    use crate::host::updater::{
        Limits, UpdaterHost,
        testkit::{APPIMAGE, FAST, Offer, Route, code, mock_app, network, run, scratch, sink},
    };
    use crate::native_operation::NativeOperationExecutor;

    /// Downloads `offer`'s payload, served by `route`, under a size cap of `size_cap` bytes; a
    /// failed download stages nothing.
    fn download(offer: &Offer, route: Route, size_cap: u64) -> Result<UpdateDownload, Failure> {
        offer.server.route("/payload", route);
        let app = mock_app(&offer.key.public_key());
        let executor = NativeOperationExecutor::production();
        let host = UpdaterHost {
            appimage: Some(scratch("transfer-cap").join("Canopi.AppImage")),
            ..offer.host(APPIMAGE, Limits { size_cap, ..FAST })
        };
        run(host.check(app.handle(), &executor, "check"))
            .unwrap()
            .unwrap();
        let (progress, _) = sink();
        let settled = run(host.download(app.handle(), &executor, "download", progress));
        assert_eq!(host.ops().staged.is_some(), settled.is_ok());
        settled
    }

    #[test]
    fn canopi_f47t_52_228_15_a_payload_without_content_length_that_streams_past_the_cap_ends_too_large()
     {
        let offer = Offer::signed(APPIMAGE);
        assert_eq!(
            code(download(
                &offer,
                Route::Chunked(offer.payload.clone()),
                1024
            )),
            network(NetworkFailureKind::TooLarge)
        );
    }

    #[test]
    fn canopi_f47t_52_228_15_a_payload_of_exactly_the_cap_downloads_and_one_byte_more_is_too_large()
    {
        let offer = Offer::signed(APPIMAGE);
        let length = u64::try_from(offer.payload.len()).unwrap();
        // With its length announced, and streamed without one.
        for route in [
            Route::Body(offer.payload.clone()),
            Route::Chunked(offer.payload.clone()),
        ] {
            assert_eq!(
                download(&offer, route.clone(), length),
                Ok(UpdateDownload::Verified),
                "a payload of exactly the cap downloads"
            );
            assert_eq!(
                code(download(&offer, route, length - 1)),
                network(NetworkFailureKind::TooLarge),
                "one byte past the cap is too large"
            );
        }
    }
}
