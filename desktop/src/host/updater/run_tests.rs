//! A cancelled run that settles after a later op started its own run: the late settlement leaves
//! the later run's place and offer alone. Each leader future is polled by hand and every answer the
//! server gives waits on a gate, so the test, not a clock, picks when a run settles. And the
//! link-only probe runs on the executor's Local class.
//!
//! Test code only (the inner attribute below); a module of its own so `tests.rs` keeps under the
//! file-size limit.
#![cfg(test)]

use std::{future::Future, pin::pin};

use canopi_types::{
    failure::{Failure, FailureCode, Lane},
    update::UpdateDownload,
};

use super::{
    UpdaterHost,
    testkit::{
        APPIMAGE, DEB, FAST, Gate, Offer, Route, UNHURRIED, channel_file, code, mock_app, run,
        scratch, sink, start,
    },
};
use crate::native_operation::{
    NativeOperationClass, NativeOperationClassLimits, NativeOperationExecutor,
    NativeOperationLimits,
};

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
    F: Future<Output = Result<(), Failure>>,
    O: Fn(&'static str) -> F,
{
    let mut run_a = pin!(op(a));
    start(&mut run_a).await;
    host.cancel(a);
    let mut run_b = pin!(op(b));
    start(&mut run_b).await;
    assert_eq!(code(run_a.await), FailureCode::Cancelled);
    let mut run_c = pin!(op(c));
    start(&mut run_c).await;
    host.cancel(b);
    let (b, c) = tokio::join!(run_b, run_c);
    [b, c]
}

/// canopi-f47t.52.228.15: a cancelled run that settles after a later op started its own run
/// leaves that run in place, so a third op joins it (cancelling the later run cancels the third op)
/// instead of starting a second run beside it. canopi-ubyr: the channel file and the payload wait on
/// gates opened only once every run settled, so no answer can beat a cancel (a 400 ms delay did,
/// under load, settling the later check `Ok`).
#[test]
fn a_cancelled_run_settling_late_leaves_the_later_run_joinable() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = NativeOperationExecutor::production();
    let host = UpdaterHost {
        appimage: Some(scratch("cancel-settles-late").join("Canopi.AppImage")),
        ..offer.host(APPIMAGE, UNHURRIED)
    };
    let (host, app, executor) = (&host, app.handle(), &executor);
    let gated = |path: &str, body: Vec<u8>| {
        let gate = Gate::default();
        offer.server.route(path, Route::Gated(gate.clone(), body));
        gate
    };
    let check = |id| async move { host.check(app, executor, id).await.map(|_| ()) };
    let download = |id| async move {
        let (progress, _) = sink();
        host.download(app, executor, id, progress).await.map(|_| ())
    };
    let cancelled = FailureCode::Cancelled;

    let channel_file = gated("/stable.json", signed_channel(&offer));
    let [b, c] = run(overlap(host, check, ["check-a", "check-b", "check-c"]));
    assert_eq!(code(b), cancelled);
    assert_eq!(code(c), cancelled, "the third check joined the later run");

    channel_file.open();
    assert!(run(host.check(app, executor, "check-d")).unwrap().is_some());
    let payload = gated("/payload", offer.payload.clone());
    let [b, c] = run(overlap(
        host,
        download,
        ["download-a", "download-b", "download-c"],
    ));
    payload.open();
    assert_eq!(code(b), cancelled);
    assert_eq!(
        code(c),
        cancelled,
        "the third download joined the later run"
    );
    assert!(host.ops().staged.is_none());
}

/// canopi-f47t.52.228.15: a cancelled check that settles after a later check offered an update
/// leaves the offer, so the download that follows has it. canopi-ubyr: the channel file waits on a
/// gate opened after the cancel, so the cancelled check's answer comes after its cancel, which the
/// check's race polls first.
#[test]
fn a_cancelled_check_settling_late_keeps_the_later_checks_offer() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = NativeOperationExecutor::production();
    let host = UpdaterHost {
        appimage: Some(scratch("late-check-offer").join("Canopi.AppImage")),
        ..offer.host(APPIMAGE, UNHURRIED)
    };
    let gate = Gate::default();
    offer.server.route(
        "/stable.json",
        Route::Gated(gate.clone(), signed_channel(&offer)),
    );

    run(async {
        let mut run_a = pin!(host.check(app.handle(), &executor, "check-a"));
        start(&mut run_a).await;
        host.cancel("check-a");
        gate.open();
        let b = host.check(app.handle(), &executor, "check-b").await;
        assert_eq!(b.unwrap().unwrap().version, "9.0.0");
        assert_eq!(code(run_a.await), FailureCode::Cancelled);
    });

    let (progress, _) = sink();
    assert_eq!(
        run(host.download(app.handle(), &executor, "download", progress)),
        Ok(UpdateDownload::Verified),
        "the later check's offer is still there"
    );
}

/// An executor whose Network class runs one op at a time.
fn one_network_slot() -> NativeOperationExecutor {
    let lane = NativeOperationClassLimits::new(8, 1);
    NativeOperationExecutor::new(NativeOperationLimits::new(lane, lane, lane, lane, lane)).unwrap()
}

/// A Network op that, from its first poll, holds `executor`'s slot until the sender sends.
fn hold_network(
    executor: &NativeOperationExecutor,
) -> (
    impl Future<Output = Result<(), String>> + '_,
    std::sync::mpsc::Sender<()>,
) {
    let (release, released) = std::sync::mpsc::channel::<()>();
    let held = executor.run(NativeOperationClass::Network, "test.hold", move || {
        released.recv().ok();
        Ok(())
    });
    (held, release)
}

/// canopi-f47t.52.228.15: a cancelled run settles only after its queued closure gets a Network
/// slot, so the user can press Check or Download again in between: the new op starts its own run
/// and is not dragged into the cancelled one. canopi-ubyr: the slot is held until a channel
/// releases it and each op is polled by hand, so the order is the test's, not a polling loop's.
#[test]
fn an_op_started_after_a_cancel_but_before_its_run_settled_runs_on_its_own() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = one_network_slot();
    let host = UpdaterHost {
        appimage: Some(scratch("cancel-then-restart").join("Canopi.AppImage")),
        ..offer.host(APPIMAGE, FAST)
    };
    let (host, app, executor) = (&host, app.handle(), &executor);
    let op = |id: &'static str| async move {
        if id.starts_with("check") {
            host.check(app, executor, id).await.map(|_| ())
        } else {
            let (progress, _) = sink();
            host.download(app, executor, id, progress).await.map(|_| ())
        }
    };
    // Run A queues behind the held slot, is cancelled, then B starts; A runs only once released.
    let restart = |a, b| {
        run(async {
            let (held, release) = hold_network(executor);
            let mut held = pin!(held);
            start(&mut held).await;
            let mut run_a = pin!(op(a));
            start(&mut run_a).await;
            host.cancel(a);
            let mut run_b = pin!(op(b));
            start(&mut run_b).await;
            release.send(()).unwrap();
            let (held, a, b) = tokio::join!(held, run_a, run_b);
            assert_eq!(held, Ok(()));
            (a, b)
        })
    };

    let (a, b) = restart("check-a", "check-b");
    assert_eq!(code(a), FailureCode::Cancelled);
    assert_eq!(
        b,
        Ok(()),
        "the check started after the cancel runs on its own"
    );
    let (a, b) = restart("download-a", "download-b");
    assert_eq!(code(a), FailureCode::Cancelled);
    assert_eq!(
        b,
        Ok(()),
        "the download started after the cancel runs on its own"
    );
    assert!(host.ops().staged.is_some());
}

/// canopi-ubyr: a check cancelled while it waits for a Network slot settles `cancelled` and never
/// opens a connection. Its race polls the cancel first, as the download's does, so a cancel sent
/// before the check's answer is read always wins; an unbiased race polled the request first one
/// time in two, and settled `Ok` when the answer and the cancel were both ready by its turn.
#[test]
fn canopi_ubyr_a_check_cancelled_before_its_turn_opens_no_connection_and_settles_cancelled() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = one_network_slot();
    let host = offer.host(APPIMAGE, FAST);

    // Sixteen rounds, so an unbiased race goes unseen one time in 65536.
    for round in 0..16 {
        let id = format!("check-{round}");
        let settled = run(async {
            let (held, release) = hold_network(&executor);
            let mut held = pin!(held);
            start(&mut held).await;
            let mut check = pin!(host.check(app.handle(), &executor, &id));
            start(&mut check).await;
            host.cancel(&id);
            release.send(()).unwrap();
            let (held, settled) = tokio::join!(held, check);
            assert_eq!(held, Ok(()));
            settled
        });
        assert_eq!(code(settled), FailureCode::Cancelled, "{id}");
    }
    assert_eq!(
        offer.server.hits(),
        Vec::<String>::new(),
        "no cancelled check reached the server"
    );
}

/// canopi-ubyr: a cancel that reaches a check before it settles makes it settle `cancelled`, also
/// when its answer is already in: the plugin can finish the request within the poll that last read
/// the cancel, so the run reads its cancel again as it settles.
#[test]
fn canopi_ubyr_a_check_cancelled_after_its_answer_came_but_before_it_settled_settles_cancelled() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = one_network_slot();
    let host = offer.host(APPIMAGE, FAST);

    let settled = run(async {
        let mut check = pin!(host.check(app.handle(), &executor, "check"));
        start(&mut check).await;
        // The lane's one slot frees only once the check's closure is done, its answer in hand.
        let after = executor.run(NativeOperationClass::Network, "test.after", || Ok(()));
        assert_eq!(after.await, Ok(()));
        host.cancel("check");
        check.await
    });

    assert_eq!(code(settled), FailureCode::Cancelled);
    assert_eq!(
        offer.server.hits(),
        ["/stable.json"],
        "the answer came first"
    );
}

/// canopi-ubyr: the same for a download: cancelled after its payload came but before it settled,
/// it settles `cancelled` and stages nothing.
#[test]
fn canopi_ubyr_a_download_cancelled_after_its_payload_came_but_before_it_settled_stages_nothing() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = one_network_slot();
    let host = UpdaterHost {
        appimage: Some(scratch("cancel-after-payload").join("Canopi.AppImage")),
        ..offer.host(APPIMAGE, UNHURRIED)
    };
    run(host.check(app.handle(), &executor, "check"))
        .unwrap()
        .unwrap();
    let gate = Gate::default();
    offer.server.route(
        "/payload",
        Route::Gated(gate.clone(), offer.payload.clone()),
    );

    let (progress, _) = sink();
    let settled = run(async {
        let mut download = pin!(host.download(app.handle(), &executor, "download", progress));
        // Polled until its transfer asked for the payload, which the gate holds back.
        let mut requested = pin!(offer.server.requested("/payload"));
        std::future::poll_fn(|cx| {
            assert!(download.as_mut().poll(cx).is_pending(), "the download runs");
            requested.as_mut().poll(cx)
        })
        .await;
        gate.open();
        // The lane's one slot frees only once the transfer's closure is done, the payload in hand.
        let after = executor.run(NativeOperationClass::Network, "test.after", || Ok(()));
        assert_eq!(after.await, Ok(()));
        host.cancel("download");
        download.await
    });

    assert_eq!(code(settled), FailureCode::Cancelled);
    assert!(host.ops().staged.is_none(), "nothing is staged");
}

/// canopi-f47t.52.228: the link-only probe (a stat of every `PATH` folder for a `.deb`, an access
/// check of the AppImage's folder) is filesystem work, so it runs as a Local executor operation
/// and never on the async runtime: with the Local class full, the download answers that lane busy.
#[test]
fn the_link_only_probe_runs_as_a_local_executor_operation() {
    let offer = Offer::signed(DEB);
    let app = mock_app(&offer.key.public_key());
    let one = NativeOperationClassLimits::new(1, 1);
    let executor = NativeOperationExecutor::new(NativeOperationLimits::new(
        one,
        one,
        one,
        NativeOperationClassLimits::new(4, 2),
        one,
    ))
    .unwrap();
    let host = offer.host(DEB, FAST);
    run(host.check(app.handle(), &executor, "check"))
        .unwrap()
        .unwrap();

    let (started, holding) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let holder = executor.clone();
    let hold = tauri::async_runtime::spawn(async move {
        holder
            .run(NativeOperationClass::Local, "test.hold", move || {
                started.send(()).ok();
                released.recv().ok();
                Ok(())
            })
            .await
    });
    holding.recv().unwrap();
    let (progress, _) = sink();
    let settled = run(host.download(app.handle(), &executor, "download", progress));
    release.send(()).unwrap();
    run(hold).unwrap().unwrap();

    assert_eq!(code(settled), FailureCode::Busy { lane: Lane::Local });
    assert_eq!(offer.server.hits(), ["/stable.json"]);
}

/// canopi-f47t.52.35: an executor refusal reaches the updater as its own catalogue code, read from
/// the typed `ExecutorError`, never from its text: with the Network lane full, a check settles busy
/// on the network lane under `updater.check`, Retry allowed, the work never run (About shows
/// "Couldn't check for updates", updater-flow.test.ts).
#[test]
fn a_full_network_lane_settles_the_check_busy_on_the_network_lane() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let one = NativeOperationClassLimits::new(1, 1);
    let roomy = NativeOperationClassLimits::new(4, 2);
    let executor =
        NativeOperationExecutor::new(NativeOperationLimits::new(roomy, roomy, roomy, one, roomy))
            .unwrap();
    let host = offer.host(APPIMAGE, FAST);

    let (started, holding) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let holder = executor.clone();
    let hold = tauri::async_runtime::spawn(async move {
        holder
            .run(NativeOperationClass::Network, "test.hold", move || {
                started.send(()).ok();
                released.recv().ok();
                Ok(())
            })
            .await
    });
    holding.recv().unwrap();
    let settled = run(host.check(app.handle(), &executor, "check"));
    release.send(()).unwrap();
    run(hold).unwrap().unwrap();

    let failure = settled.unwrap_err();
    assert_eq!(
        failure.code,
        FailureCode::Busy {
            lane: Lane::Network
        }
    );
    assert_eq!(failure.op, "updater.check");
    assert!(failure.user_may_retry);
    assert!(offer.server.hits().is_empty(), "the check never ran");
}

/// canopi-f47t.52.35: a cancelled check or download settles `cancelled` under its own op, a silent
/// row: About goes back to idle and no message is shown.
#[test]
fn a_cancelled_check_or_download_settles_silent_cancelled_under_its_op() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = NativeOperationExecutor::production();
    let host = UpdaterHost {
        appimage: Some(scratch("cancelled-op").join("Canopi.AppImage")),
        ..offer.host(APPIMAGE, FAST)
    };

    host.cancel("check-1");
    let check = run(host.check(app.handle(), &executor, "check-1")).unwrap_err();
    run(host.check(app.handle(), &executor, "check-2"))
        .unwrap()
        .unwrap();
    host.cancel("download-1");
    let (progress, _) = sink();
    let download = run(host.download(app.handle(), &executor, "download-1", progress)).unwrap_err();

    for (failure, op) in [(check, "updater.check"), (download, "updater.download")] {
        assert_eq!(failure.code, FailureCode::Cancelled, "{op}");
        assert_eq!(failure.op, op);
        assert!(failure.code.row().silent, "{op}");
        assert!(!failure.user_may_retry, "{op}");
    }
}
