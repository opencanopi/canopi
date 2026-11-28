//! Behavioural contract suite for `canopi-support::executor` (ADR 0025, contracts §3).
//!
//! Uses `tokio::time::pause()` and explicit `tokio::time::advance(...)` — never
//! `std::thread::sleep` — because an active blocking task prevents Tokio paused time
//! from auto-advancing (ADR 0025 Checks).

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use canopi_support::executor::{
    CancelReason, CancelToken, Deadline, Executor, ExecutorLane, LANES, LaneConfig, OpSpec,
    SettlementEvent, SettlementKind, SettlementObserver,
};
use canopi_types::failure::{Failure, FailureCode, Lane as FailureLane, OperationId};
use tokio::runtime::Handle;
use tokio::sync::{Notify, oneshot};

fn recording_observer() -> (SettlementObserver, Arc<Mutex<Vec<SettlementEvent>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let observer: SettlementObserver = Arc::new(move |event: &SettlementEvent| {
        if let Ok(mut guard) = sink.lock() {
            guard.push(event.clone());
        }
    });
    (observer, events)
}

fn single_worker_lanes(queue_bound: usize) -> [LaneConfig; 6] {
    let mut lanes = LANES;
    lanes[ExecutorLane::Catalog.index()] = LaneConfig {
        workers: 1,
        queue_bound,
        interactive_deadline: Some(Duration::from_secs(2)),
        slow_budget: Duration::from_millis(50),
        inner_parallelism: None,
    };
    lanes
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interactive_work_queued_behind_background_starts_first() {
    let executor = Executor::with_lanes(Handle::current(), single_worker_lanes(4), None).unwrap();
    let (block_tx, block_rx) = std::sync::mpsc::channel::<()>();
    let (started_tx, started_rx) = oneshot::channel::<()>();
    let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));

    // Occupy the single Catalog worker.
    let holder = tokio::spawn({
        let executor = executor.clone();
        async move {
            executor
                .run(
                    OpSpec::background("test.holder", ExecutorLane::Catalog),
                    None,
                    CancelToken::new(),
                    move |_| {
                        let _ = started_tx.send(());
                        let _ = block_rx.recv();
                        Ok(())
                    },
                )
                .await
        }
    });
    started_rx.await.unwrap();

    // Queue background first, then interactive behind it.
    let bg = tokio::spawn({
        let executor = executor.clone();
        let order = Arc::clone(&order);
        async move {
            executor
                .run(
                    OpSpec::background("test.bg", ExecutorLane::Catalog),
                    None,
                    CancelToken::new(),
                    move |_| {
                        order.lock().unwrap().push("bg");
                        Ok(())
                    },
                )
                .await
        }
    });
    tokio::task::yield_now().await;
    while executor.in_flight().len() < 2 {
        tokio::task::yield_now().await;
    }

    let interactive = tokio::spawn({
        let executor = executor.clone();
        let order = Arc::clone(&order);
        async move {
            executor
                .run(
                    OpSpec::interactive("test.interactive", ExecutorLane::Catalog),
                    None,
                    CancelToken::new(),
                    move |_| {
                        order.lock().unwrap().push("interactive");
                        Ok(())
                    },
                )
                .await
        }
    });
    while executor.in_flight().len() < 3 {
        tokio::task::yield_now().await;
    }

    let _ = block_tx.send(());
    assert!(holder.await.unwrap().is_ok());
    assert!(interactive.await.unwrap().is_ok());
    assert!(bg.await.unwrap().is_ok());
    assert_eq!(*order.lock().unwrap(), vec!["interactive", "bg"]);
}

#[tokio::test(flavor = "current_thread")]
async fn request_queued_past_deadline_settles_busy_and_work_never_runs() {
    tokio::time::pause();
    let (observer, events) = recording_observer();
    let executor =
        Executor::with_lanes(Handle::current(), single_worker_lanes(4), Some(observer)).unwrap();

    let (block_tx, block_rx) = std::sync::mpsc::channel::<()>();
    let (started_tx, started_rx) = oneshot::channel::<()>();
    let holder = tokio::spawn({
        let executor = executor.clone();
        async move {
            executor
                .run(
                    OpSpec::system("test.holder", ExecutorLane::Catalog),
                    None,
                    CancelToken::new(),
                    move |_| {
                        let _ = started_tx.send(());
                        let _ = block_rx.recv();
                        Ok(())
                    },
                )
                .await
        }
    });
    started_rx.await.unwrap();

    let ran = Arc::new(AtomicBool::new(false));
    let ran_flag = Arc::clone(&ran);
    let waiter = tokio::spawn({
        let executor = executor.clone();
        async move {
            executor
                .run(
                    OpSpec::interactive("test.waiter", ExecutorLane::Catalog)
                        .with_deadline(Deadline::Bounded(Duration::from_millis(200))),
                    None,
                    CancelToken::new(),
                    move |_| {
                        ran_flag.store(true, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .await
        }
    });

    while executor.in_flight().len() < 2 {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_millis(250)).await;

    let err = waiter.await.unwrap().unwrap_err();
    assert_eq!(
        err.code,
        FailureCode::Busy {
            lane: FailureLane::Catalog
        }
    );
    assert!(!ran.load(Ordering::SeqCst), "timed-out work must never run");

    let _ = block_tx.send(());
    assert!(holder.await.unwrap().is_ok());
    let recorded = events.lock().unwrap();
    assert!(
        recorded.iter().any(|e| e.op == "test.waiter"
            && e.settlement == SettlementKind::Busy
            && !e.queue_full)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn full_queue_waits_then_settles_busy_with_queue_full_at_deadline() {
    tokio::time::pause();
    let (observer, events) = recording_observer();
    let executor =
        Executor::with_lanes(Handle::current(), single_worker_lanes(1), Some(observer)).unwrap();

    let (block_tx, block_rx) = std::sync::mpsc::channel::<()>();
    let (started_tx, started_rx) = oneshot::channel::<()>();
    let holder = tokio::spawn({
        let executor = executor.clone();
        async move {
            executor
                .run(
                    OpSpec::system("test.holder", ExecutorLane::Catalog),
                    None,
                    CancelToken::new(),
                    move |_| {
                        let _ = started_tx.send(());
                        let _ = block_rx.recv();
                        Ok(())
                    },
                )
                .await
        }
    });
    started_rx.await.unwrap();

    // Fill the 1-slot queue.
    let queued = tokio::spawn({
        let executor = executor.clone();
        async move {
            executor
                .run(
                    OpSpec::system("test.queued", ExecutorLane::Catalog),
                    None,
                    CancelToken::new(),
                    |_| Ok(()),
                )
                .await
        }
    });
    while executor.in_flight().len() < 2 {
        tokio::task::yield_now().await;
    }

    // Overflow waiter: waits on full queue, settles Busy with queue_full at deadline.
    let overflow_ran = Arc::new(AtomicBool::new(false));
    let overflow_flag = Arc::clone(&overflow_ran);
    let overflow = tokio::spawn({
        let executor = executor.clone();
        async move {
            executor
                .run(
                    OpSpec::interactive("test.overflow", ExecutorLane::Catalog)
                        .with_deadline(Deadline::Bounded(Duration::from_millis(150))),
                    None,
                    CancelToken::new(),
                    move |_| {
                        overflow_flag.store(true, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .await
        }
    });
    while executor.in_flight().len() < 3 {
        tokio::task::yield_now().await;
    }

    tokio::time::advance(Duration::from_millis(200)).await;
    let err = overflow.await.unwrap().unwrap_err();
    assert_eq!(
        err.code,
        FailureCode::Busy {
            lane: FailureLane::Catalog
        }
    );
    assert!(!overflow_ran.load(Ordering::SeqCst));

    let _ = block_tx.send(());
    assert!(holder.await.unwrap().is_ok());
    assert!(queued.await.unwrap().is_ok());

    let recorded = events.lock().unwrap();
    assert!(recorded.iter().any(|e| {
        e.op == "test.overflow" && e.settlement == SettlementKind::Busy && e.queue_full
    }));
}

#[tokio::test(flavor = "current_thread")]
async fn cancel_before_start_and_supersede_hook_and_drop_guard() {
    let executor = Executor::with_lanes(Handle::current(), single_worker_lanes(4), None).unwrap();

    // 1. Pre-cancelled token never runs.
    let pre_cancelled = CancelToken::new();
    pre_cancelled.cancel(CancelReason::User);
    let ran = Arc::new(AtomicBool::new(false));
    let ran_flag = Arc::clone(&ran);
    let err = executor
        .run(
            OpSpec::interactive("test.precancel", ExecutorLane::Catalog),
            None,
            pre_cancelled,
            move |_| {
                ran_flag.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, FailureCode::Cancelled);
    assert!(!ran.load(Ordering::SeqCst));

    // 2. Supersede key fires on_cancel hook with CancelReason::Superseded.
    let hook_fired = Arc::new(AtomicBool::new(false));
    let hook_flag = Arc::clone(&hook_fired);
    let (started_tx, started_rx) = oneshot::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let first_token = CancelToken::new();
    first_token.on_cancel(move || {
        hook_flag.store(true, Ordering::SeqCst);
        let _ = release_tx.send(());
    });
    let first = tokio::spawn({
        let executor = executor.clone();
        let token = first_token.clone();
        async move {
            executor
                .run(
                    OpSpec::interactive("species.search", ExecutorLane::Catalog)
                        .with_supersede_key("species_search"),
                    None,
                    token,
                    move |tok| {
                        let _ = started_tx.send(());
                        let _ = release_rx.recv();
                        if tok.is_cancelled() {
                            return Err(Failure::new(FailureCode::Cancelled, "species.search"));
                        }
                        Ok(())
                    },
                )
                .await
        }
    });
    started_rx.await.unwrap();

    let second = executor
        .run(
            OpSpec::interactive("species.search", ExecutorLane::Catalog)
                .with_supersede_key("species_search"),
            None,
            CancelToken::new(),
            |_| Ok(()),
        )
        .await;
    assert!(second.is_ok());
    assert!(hook_fired.load(Ordering::SeqCst));
    assert_eq!(first_token.reason(), Some(CancelReason::Superseded));
    assert_eq!(
        first.await.unwrap().unwrap_err().code,
        FailureCode::Cancelled
    );

    // 3. Dropped future cancels token as backstop.
    let (drop_started_tx, drop_started_rx) = oneshot::channel::<()>();
    let (drop_done_tx, drop_done_rx) = oneshot::channel::<bool>();
    let drop_token = CancelToken::new();
    let seen_cancel = Arc::new(Notify::new());
    let notify_cancel = Arc::clone(&seen_cancel);
    drop_token.on_cancel(move || notify_cancel.notify_one());

    let dropped_task = tokio::spawn({
        let executor = executor.clone();
        let token = drop_token.clone();
        async move {
            let _ = executor
                .run(
                    OpSpec::interactive("test.drop", ExecutorLane::Local),
                    None,
                    token,
                    move |tok| {
                        let _ = drop_started_tx.send(());
                        while !tok.is_cancelled() {
                            std::thread::yield_now();
                        }
                        let _ = drop_done_tx.send(tok.is_cancelled());
                        Ok(())
                    },
                )
                .await;
        }
    });
    drop_started_rx.await.unwrap();
    dropped_task.abort();
    seen_cancel.notified().await;
    assert!(drop_token.is_cancelled());
    assert!(drop_done_rx.await.unwrap());
}

#[tokio::test(flavor = "current_thread")]
async fn panic_settles_panicked_closed_settles_unavailable_and_n_ops_emit_n_settlements() {
    tokio::time::pause();
    let (observer, events) = recording_observer();
    let executor = Executor::with_observer(Handle::current(), observer);

    // Panic settles Panicked without unwinding the caller.
    let panicked = executor
        .run::<(), _>(
            OpSpec::interactive("test.panic", ExecutorLane::Local),
            None,
            CancelToken::new(),
            |_| panic!("intentional contract test panic"),
        )
        .await
        .unwrap_err();
    assert_eq!(panicked.code, FailureCode::Panicked);

    // N concurrent requests under one OperationId emit N settlement events carrying it.
    let op_id = OperationId::system();
    let mut handles = Vec::new();
    for _ in 0..4 {
        let exec = executor.clone();
        let id = op_id.clone();
        handles.push(tokio::spawn(async move {
            exec.run(
                OpSpec::interactive("test.batch", ExecutorLane::Local),
                Some(id),
                CancelToken::new(),
                |_| Ok(1usize),
            )
            .await
        }));
    }
    for handle in handles {
        assert_eq!(handle.await.unwrap().unwrap(), 1);
    }

    // Cancel by OperationId before start prevents queued work from running.
    let (block_tx, block_rx) = std::sync::mpsc::channel::<()>();
    let (started_tx, started_rx) = oneshot::channel::<()>();
    let holder = tokio::spawn({
        let exec = executor.clone();
        async move {
            exec.run(
                OpSpec::system("test.cat_holder", ExecutorLane::Catalog),
                None,
                CancelToken::new(),
                move |_| {
                    let _ = started_tx.send(());
                    let _ = block_rx.recv();
                    Ok(())
                },
            )
            .await
        }
    });
    started_rx.await.unwrap();

    let cancel_op = OperationId::system();
    let cancelled_ran = Arc::new(AtomicBool::new(false));
    let cancelled_flag = Arc::clone(&cancelled_ran);
    let queued_cancel = tokio::spawn({
        let exec = executor.clone();
        let id = cancel_op.clone();
        async move {
            exec.run(
                OpSpec::interactive("test.cancel_by_op", ExecutorLane::Catalog),
                Some(id),
                CancelToken::new(),
                move |_| {
                    cancelled_flag.store(true, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
        }
    });
    while executor.in_flight().len() < 2 {
        tokio::task::yield_now().await;
    }
    assert_eq!(executor.cancel(&cancel_op), 1);
    assert_eq!(
        queued_cancel.await.unwrap().unwrap_err().code,
        FailureCode::Cancelled
    );
    assert!(!cancelled_ran.load(Ordering::SeqCst));
    let _ = block_tx.send(());
    assert!(holder.await.unwrap().is_ok());

    // Closed executor settles Unavailable.
    executor.close();
    assert!(executor.is_closed());
    let closed_err = executor
        .run(
            OpSpec::interactive("test.after_close", ExecutorLane::Local),
            None,
            CancelToken::new(),
            |_| Ok(()),
        )
        .await
        .unwrap_err();
    assert_eq!(closed_err.code, FailureCode::Unavailable);

    let recorded = events.lock().unwrap();
    let batch_count = recorded
        .iter()
        .filter(|e| e.op == "test.batch" && e.operation.as_ref() == Some(&op_id))
        .count();
    assert_eq!(batch_count, 4);
}
