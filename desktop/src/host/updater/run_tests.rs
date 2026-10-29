//! A cancelled run that settles after a later op started its own run: the late settlement leaves
//! the later run's place and offer alone. Each leader future is polled by hand, so the test picks
//! when the cancelled run settles.
//!
//! Test code only (the inner attribute below); a module of its own so `tests.rs` keeps under the
//! file-size limit.
#![cfg(test)]

use std::{
    future::Future,
    pin::{Pin, pin},
    task::Poll,
    time::Duration,
};

use common_types::update::{UpdateDownload, UpdateFailure, UpdateFailureCode};

use super::{
    UpdaterHost,
    testkit::{APPIMAGE, FAST, Offer, Route, channel_file, code, mock_app, run, scratch, sink},
};
use crate::native_operation::NativeOperationExecutor;

/// Polls `future` once: it has accepted its op and is waiting on its run.
async fn start<F: Future>(future: &mut Pin<&mut F>) {
    std::future::poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending(), "the op is running");
        Poll::Ready(())
    })
    .await;
}

/// `offer`'s channel file, its payload signed.
fn signed_channel(offer: &Offer) -> Vec<u8> {
    let signature = offer.key.sign(&offer.payload, "9.0.0");
    channel_file(
        "9.0.0",
        &APPIMAGE.key(),
        &offer.server.url("/payload"),
        &signature,
    )
}

/// Run A is cancelled and B starts its own run; A settles only then. Then `op(c)` starts and B is
/// cancelled: C's settlement and B's.
async fn overlap<F, O>(host: &UpdaterHost, op: O, [a, b, c]: [&'static str; 3]) -> [F::Output; 2]
where
    F: Future<Output = Result<(), UpdateFailure>>,
    O: Fn(&'static str) -> F,
{
    let mut run_a = pin!(op(a));
    start(&mut run_a).await;
    host.cancel(a);
    let mut run_b = pin!(op(b));
    start(&mut run_b).await;
    assert_eq!(code(run_a.await), UpdateFailureCode::Cancelled);
    let mut run_c = pin!(op(c));
    start(&mut run_c).await;
    host.cancel(b);
    let (b, c) = tokio::join!(run_b, run_c);
    [b, c]
}

/// canopi-f47t.52.228.15: a cancelled run that settles after a later op started its own run
/// leaves that run in place, so a third op joins it (cancelling the later run cancels the third op)
/// instead of starting a second run beside it.
#[test]
fn a_cancelled_run_settling_late_leaves_the_later_run_joinable() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = NativeOperationExecutor::production();
    let host = UpdaterHost {
        appimage: Some(scratch("cancel-settles-late").join("Canopi.AppImage")),
        ..offer.host(APPIMAGE, FAST)
    };
    let (host, app, executor) = (&host, app.handle(), &executor);
    let slow = |path: &str, body: Vec<u8>| {
        offer
            .server
            .route(path, Route::Slow(Duration::from_millis(400), body));
    };
    let check = |id| async move { host.check(app, executor, id).await.map(|_| ()) };
    let download = |id| async move {
        let (progress, _) = sink();
        host.download(app, executor, id, progress).await.map(|_| ())
    };
    let cancelled = UpdateFailureCode::Cancelled;

    slow("/stable.json", signed_channel(&offer));
    let [b, c] = run(overlap(host, check, ["check-a", "check-b", "check-c"]));
    assert_eq!(code(b), cancelled);
    assert_eq!(code(c), cancelled, "the third check joined the later run");

    assert!(run(host.check(app, executor, "check-d")).unwrap().is_some());
    slow("/payload", offer.payload.clone());
    let [b, c] = run(overlap(
        host,
        download,
        ["download-a", "download-b", "download-c"],
    ));
    assert_eq!(code(b), cancelled);
    assert_eq!(
        code(c),
        cancelled,
        "the third download joined the later run"
    );
    assert!(host.ops().staged.is_none());
}
/// canopi-f47t.52.228.15: a cancelled check that settles after a later check offered an update
/// leaves the offer, so the download that follows has it.
#[test]
fn a_cancelled_check_settling_late_keeps_the_later_checks_offer() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = NativeOperationExecutor::production();
    let host = UpdaterHost {
        appimage: Some(scratch("late-check-offer").join("Canopi.AppImage")),
        ..offer.host(APPIMAGE, FAST)
    };
    offer.server.route(
        "/stable.json",
        Route::Slow(Duration::from_millis(200), signed_channel(&offer)),
    );

    run(async {
        let mut run_a = pin!(host.check(app.handle(), &executor, "check-a"));
        start(&mut run_a).await;
        host.cancel("check-a");
        let b = host.check(app.handle(), &executor, "check-b").await;
        assert_eq!(b.unwrap().unwrap().version, "9.0.0");
        assert_eq!(code(run_a.await), UpdateFailureCode::Cancelled);
    });

    let (progress, _) = sink();
    assert_eq!(
        run(host.download(app.handle(), &executor, "download", progress)),
        Ok(UpdateDownload::Verified),
        "the later check's offer is still there"
    );
}
