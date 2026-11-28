//! Two-slot Job lane and slow-budget settlement tests (ADR 0025, 2.1-M28).
//!
//! `Slot` lives in `canopi-library`'s job runner (not in `canopi-support`); this test
//! proves the two-slot Job lane contract (`JOB_WORKERS == 2`) without adding a `Slot`
//! primitive to `canopi-support`'s public API.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use canopi_support::executor::{
    CancelToken, Executor, ExecutorLane, JOB_WORKERS, OpSpec, SettlementEvent, SettlementObserver,
};
use tokio::runtime::Handle;
use tokio::sync::{Semaphore, oneshot};

fn recording_observer() -> (SettlementObserver, Arc<Mutex<Vec<SettlementEvent>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let observer: SettlementObserver = Arc::new(move |event| {
        if let Ok(mut guard) = sink.lock() {
            guard.push(event.clone());
        }
    });
    (observer, events)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Slot {
    Heavy,
    Display,
}

impl Slot {
    const ALL: [Self; 2] = [Self::Heavy, Self::Display];
}

const _: () = assert!(Slot::ALL.len() == JOB_WORKERS);

#[tokio::test(flavor = "current_thread")]
async fn slow_running_work_marks_slow_true_in_settlement_event() {
    tokio::time::pause();
    let (observer, events) = recording_observer();
    let executor = Executor::with_observer(Handle::current(), observer);
    let (started_tx, started_rx) = oneshot::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();

    let task = tokio::spawn({
        let exec = executor.clone();
        async move {
            exec.run(
                OpSpec::interactive("test.slow", ExecutorLane::Local)
                    .with_slow_budget(Duration::from_millis(50)),
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
    tokio::time::advance(Duration::from_millis(120)).await;
    let _ = release_tx.send(());
    assert!(task.await.unwrap().is_ok());

    let recorded = events.lock().unwrap();
    let slow_event = recorded
        .iter()
        .find(|e| e.op == "test.slow")
        .expect("slow event must be recorded");
    assert!(
        slow_event.slow,
        "running past slow_budget must set slow = true"
    );
    assert!(slow_event.running_ms >= 100);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_slot_job_lane_keeps_display_unstarved_while_heavy_waits_fifo() {
    let executor = Executor::new(Handle::current());
    let heavy_slot = Arc::new(Semaphore::new(1));
    let display_slot = Arc::new(Semaphore::new(1));

    let (heavy1_started_tx, heavy1_started_rx) = oneshot::channel::<()>();
    let (heavy1_release_tx, heavy1_release_rx) = std::sync::mpsc::channel::<()>();
    let heavy_order = Arc::new(Mutex::new(Vec::<usize>::new()));

    // Heavy #1 acquires Slot::Heavy and holds worker 1 on the Job lane.
    let heavy1 = tokio::spawn({
        let executor = executor.clone();
        let heavy_slot = Arc::clone(&heavy_slot);
        let heavy_order = Arc::clone(&heavy_order);
        async move {
            let _permit = heavy_slot.acquire_owned().await.unwrap();
            executor
                .run(
                    OpSpec::system("job.heavy_1", ExecutorLane::Job),
                    None,
                    CancelToken::new(),
                    move |_| {
                        heavy_order.lock().unwrap().push(1);
                        let _ = heavy1_started_tx.send(());
                        let _ = heavy1_release_rx.recv();
                        Ok(())
                    },
                )
                .await
        }
    });
    heavy1_started_rx.await.unwrap();

    // Heavy #2 waits FIFO on Slot::Heavy without stealing Slot::Display.
    let heavy2_started = Arc::new(AtomicUsize::new(0));
    let heavy2_flag = Arc::clone(&heavy2_started);
    let heavy2 = tokio::spawn({
        let executor = executor.clone();
        let heavy_slot = Arc::clone(&heavy_slot);
        let heavy_order = Arc::clone(&heavy_order);
        async move {
            let _permit = heavy_slot.acquire_owned().await.unwrap();
            executor
                .run(
                    OpSpec::system("job.heavy_2", ExecutorLane::Job),
                    None,
                    CancelToken::new(),
                    move |_| {
                        heavy2_flag.fetch_add(1, Ordering::SeqCst);
                        heavy_order.lock().unwrap().push(2);
                        Ok(())
                    },
                )
                .await
        }
    });
    tokio::task::yield_now().await;

    // Display acquires Slot::Display and finishes immediately on Job lane worker 2.
    let display_permit = display_slot.acquire_owned().await.unwrap();
    let display_res = executor
        .run(
            OpSpec::system("job.display", ExecutorLane::Job),
            None,
            CancelToken::new(),
            |_| Ok("display-ready"),
        )
        .await;
    drop(display_permit);
    assert_eq!(display_res.unwrap(), "display-ready");
    assert_eq!(
        heavy2_started.load(Ordering::SeqCst),
        0,
        "Heavy #2 must wait for Slot::Heavy instead of stealing Slot::Display"
    );

    // Release Heavy #1 -> Heavy #2 now runs and completes FIFO.
    let _ = heavy1_release_tx.send(());
    assert!(heavy1.await.unwrap().is_ok());
    assert!(heavy2.await.unwrap().is_ok());
    assert_eq!(*heavy_order.lock().unwrap(), vec![1, 2]);
}
