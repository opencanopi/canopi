//! Regression tests for executor drop-safety, cancellation settlement, and overflow priority.

use std::pin::pin;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::task::Poll;
use std::time::Duration;

use canopi_support::executor::{
    CancelToken, Deadline, Executor, ExecutorLane, LANES, LaneConfig, OpSpec,
};
use canopi_types::failure::FailureCode;
use tokio::runtime::Handle;
use tokio::sync::oneshot;

fn single_worker_lanes(queue_bound: usize) -> [LaneConfig; 6] {
    let mut lanes = LANES;
    lanes[ExecutorLane::Local.index()] = LaneConfig {
        workers: 1,
        queue_bound,
        ..lanes[ExecutorLane::Local.index()]
    };
    lanes
}

#[tokio::test(flavor = "current_thread")]
async fn dropped_queued_future_after_grant_sent_does_not_leak_single_worker_slot() {
    let executor = Executor::with_lanes(Handle::current(), single_worker_lanes(4), None).unwrap();
    let (started_tx, started_rx) = oneshot::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();

    let holder = tokio::spawn({
        let exec = executor.clone();
        async move {
            exec.run(
                OpSpec::interactive("test.holder", ExecutorLane::Local),
                None,
                CancelToken::new(),
                move |_| {
                    let _ = started_tx.send(());
                    let _ = release_rx.recv();
                    Ok(())
                },
            )
            .await
        }
    });
    started_rx.await.unwrap();

    // Poll a queued future once so it registers and enters the lane queue, then hold it unpolled.
    {
        let mut waiter = pin!(executor.run(
            OpSpec::interactive("test.dropped_waiter", ExecutorLane::Local),
            None,
            CancelToken::new(),
            |_| Ok(()),
        ));
        let poll_once = std::future::poll_fn(|cx| {
            assert!(
                matches!(waiter.as_mut().poll(cx), Poll::Pending),
                "waiter must pend while holder occupies the single worker"
            );
            Poll::Ready(())
        });
        poll_once.await;
        assert_eq!(executor.queued_count(ExecutorLane::Local), 1);

        // Release holder: dispatch_or_release pops waiter and sends Grant::Run into its channel.
        let _ = release_tx.send(());
        assert!(holder.await.unwrap().is_ok());
        assert_eq!(executor.queued_count(ExecutorLane::Local), 0);
        // Drop waiter WITHOUT polling it again so Grant::Run is unread.
    }

    // The single worker slot must have been released by GrantWaitGuard::drop.
    let probe = executor
        .run(
            OpSpec::interactive("test.probe", ExecutorLane::Local)
                .with_deadline(Deadline::Bounded(Duration::from_millis(500))),
            None,
            CancelToken::new(),
            |_| Ok("slot-free"),
        )
        .await;
    assert_eq!(probe.unwrap(), "slot-free");
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_queued_waiter_after_holder_finishes_settles_cancelled() {
    let executor = Executor::with_lanes(Handle::current(), single_worker_lanes(4), None).unwrap();
    let (started_tx, started_rx) = oneshot::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();

    let holder = tokio::spawn({
        let exec = executor.clone();
        async move {
            exec.run(
                OpSpec::interactive("test.holder", ExecutorLane::Local),
                None,
                CancelToken::new(),
                move |_| {
                    let _ = started_tx.send(());
                    let _ = release_rx.recv();
                    Ok(())
                },
            )
            .await
        }
    });
    started_rx.await.unwrap();

    let token = CancelToken::new();
    let waiter_ran = Arc::new(AtomicBool::new(false));
    let mut waiter = pin!(executor.run(
        OpSpec::interactive("test.cancelled_waiter", ExecutorLane::Local),
        None,
        token.clone(),
        {
            let ran = Arc::clone(&waiter_ran);
            move |_| {
                ran.store(true, Ordering::SeqCst);
                Ok(())
            }
        },
    ));
    std::future::poll_fn(|cx| {
        assert!(matches!(waiter.as_mut().poll(cx), Poll::Pending));
        Poll::Ready(())
    })
    .await;
    assert_eq!(executor.queued_count(ExecutorLane::Local), 1);

    // Cancel waiter, then let holder finish BEFORE polling waiter again so
    // pop_next_live_waiter discards waiter and drops grant_tx.
    token.cancel(canopi_support::executor::CancelReason::User);
    let _ = release_tx.send(());
    assert!(holder.await.unwrap().is_ok());

    let err = waiter.await.unwrap_err();
    assert_eq!(
        err.code,
        FailureCode::Cancelled,
        "discarded cancelled waiter must settle Cancelled, not Unavailable"
    );
    assert!(!waiter_ran.load(Ordering::SeqCst));
}

#[tokio::test(flavor = "current_thread")]
async fn interactive_waiter_in_overflow_starts_ahead_of_background_waiter_in_overflow() {
    // 1 worker, queue_bound = 1 so the 2nd waiter fills the queue and waiters 3 & 4 enter overflow.
    let executor = Executor::with_lanes(Handle::current(), single_worker_lanes(1), None).unwrap();
    let (started_tx, started_rx) = oneshot::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));

    let holder = tokio::spawn({
        let exec = executor.clone();
        async move {
            exec.run(
                OpSpec::interactive("test.holder", ExecutorLane::Local),
                None,
                CancelToken::new(),
                move |_| {
                    let _ = started_tx.send(());
                    let _ = release_rx.recv();
                    Ok(())
                },
            )
            .await
        }
    });
    started_rx.await.unwrap();

    // Fill the 1-slot bounded queue with a background item.
    let q_bg = tokio::spawn({
        let exec = executor.clone();
        let order = Arc::clone(&order);
        async move {
            exec.run(
                OpSpec::background("test.q_bg", ExecutorLane::Local),
                None,
                CancelToken::new(),
                move |_| {
                    order.lock().unwrap().push("q_bg");
                    Ok(())
                },
            )
            .await
        }
    });
    while executor.queued_count(ExecutorLane::Local) < 1 {
        tokio::task::yield_now().await;
    }

    // Queue is full -> overflow_bg enters overflow first.
    let ov_bg = tokio::spawn({
        let exec = executor.clone();
        let order = Arc::clone(&order);
        async move {
            exec.run(
                OpSpec::background("test.ov_bg", ExecutorLane::Local),
                None,
                CancelToken::new(),
                move |_| {
                    order.lock().unwrap().push("ov_bg");
                    Ok(())
                },
            )
            .await
        }
    });
    while executor.queued_count(ExecutorLane::Local) < 2 {
        tokio::task::yield_now().await;
    }

    // overflow_interactive arrives AFTER overflow_bg but must be promoted and run ahead of it.
    let ov_interactive = tokio::spawn({
        let exec = executor.clone();
        let order = Arc::clone(&order);
        async move {
            exec.run(
                OpSpec::interactive("test.ov_interactive", ExecutorLane::Local),
                None,
                CancelToken::new(),
                move |_| {
                    order.lock().unwrap().push("ov_interactive");
                    Ok(())
                },
            )
            .await
        }
    });
    while executor.queued_count(ExecutorLane::Local) < 3 {
        tokio::task::yield_now().await;
    }

    let _ = release_tx.send(());
    assert!(holder.await.unwrap().is_ok());
    assert!(q_bg.await.unwrap().is_ok());
    assert!(ov_interactive.await.unwrap().is_ok());
    assert!(ov_bg.await.unwrap().is_ok());

    let recorded = order.lock().unwrap();
    let interactive_pos = recorded
        .iter()
        .position(|&name| name == "ov_interactive")
        .unwrap();
    let bg_pos = recorded.iter().position(|&name| name == "ov_bg").unwrap();
    assert!(
        interactive_pos < bg_pos,
        "interactive overflow waiter must start ahead of background overflow waiter: {recorded:?}"
    );
}
