use super::{
    ExecutorError, NativeOperationClass, NativeOperationClassLimits, NativeOperationExecutor,
    NativeOperationLimits,
};
use canopi_types::failure::{Failure, FailureCode, Lane};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::{Duration, Instant},
};

const WAIT_TIMEOUT: Duration = Duration::from_secs(2);

fn test_executor(admitted: usize, running: usize) -> NativeOperationExecutor {
    NativeOperationExecutor::new(NativeOperationLimits::uniform(
        NativeOperationClassLimits::new(admitted, running),
    ))
    .unwrap()
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for executor state"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

type HeldWrite = (Sender<()>, Receiver<Result<(), String>>, Receiver<()>);
/// A write held until `release` sends; `finished` is sent inside it, before its permits drop.
fn held_write(executor: &NativeOperationExecutor, class: NativeOperationClass) -> HeldWrite {
    let (release, held) = mpsc::channel::<()>();
    let (settled_tx, settled) = mpsc::channel();
    let (finished_tx, finished) = mpsc::channel();
    let (started_tx, started) = mpsc::channel();
    let executor = executor.clone();
    tauri::async_runtime::spawn(async move {
        let result = executor
            .run(class, "held write", move || {
                started_tx.send(()).ok();
                held.recv().ok();
                finished_tx.send(()).ok();
                Ok(())
            })
            .await;
        settled_tx.send(result).ok();
    });
    started.recv_timeout(WAIT_TIMEOUT).unwrap();
    (release, settled, finished)
}

mod admission;
mod exit_flush;

#[test]
fn production_limits_are_explicit_per_operation_class() {
    let limits = NativeOperationLimits::production();

    assert_eq!(
        limits.for_class(NativeOperationClass::Catalog),
        NativeOperationClassLimits::new(8, 1),
    );
    assert_eq!(
        limits.for_class(NativeOperationClass::UserData),
        NativeOperationClassLimits::new(8, 1),
    );
    assert_eq!(
        limits.for_class(NativeOperationClass::Local),
        NativeOperationClassLimits::new(6, 2),
    );
    assert_eq!(
        limits.for_class(NativeOperationClass::Network),
        NativeOperationClassLimits::new(12, 4),
    );
    assert_eq!(
        limits.for_class(NativeOperationClass::Raster),
        NativeOperationClassLimits::new(4, 2),
    );
}

#[test]
fn rejects_invalid_limits() {
    let zero_running = NativeOperationLimits::uniform(NativeOperationClassLimits::new(1, 0));
    assert!(NativeOperationExecutor::new(zero_running).is_err());

    let more_running_than_admitted =
        NativeOperationLimits::uniform(NativeOperationClassLimits::new(1, 2));
    assert!(NativeOperationExecutor::new(more_running_than_admitted).is_err());
}

#[test]
fn rejects_full_admission_without_spawning_work() {
    tauri::async_runtime::block_on(async {
        let executor = test_executor(1, 1);
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let first_executor = executor.clone();
        let first = tauri::async_runtime::spawn(async move {
            first_executor
                .run(
                    NativeOperationClass::Network,
                    "held network operation",
                    move || {
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    },
                )
                .await
        });
        started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

        let rejected_work_ran = Arc::new(AtomicBool::new(false));
        let rejected_work_probe = Arc::clone(&rejected_work_ran);
        let error = executor
            .run(
                NativeOperationClass::Network,
                "rejected network operation",
                move || {
                    rejected_work_probe.store(true, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
            .unwrap_err();

        assert_eq!(error, "Native network operations are busy; try again");
        assert!(!rejected_work_ran.load(Ordering::SeqCst));
        release_tx.send(()).unwrap();
        first.await.unwrap().unwrap();
    });
}

/// The busy text String commands reject with, byte for byte per class: the frontend's
/// busy matchers read it until N1 and N2 type their commands (2.1-M41), and
/// `__tests__/lidar-display.test.ts` feeds the same five literals through display.ts's.
const BUSY_TEXTS: [(NativeOperationClass, &str); 5] = [
    (
        NativeOperationClass::Catalog,
        "Native catalog operations are busy; try again",
    ),
    (
        NativeOperationClass::UserData,
        "Native user-data operations are busy; try again",
    ),
    (
        NativeOperationClass::Local,
        "Native local operations are busy; try again",
    ),
    (
        NativeOperationClass::Network,
        "Native network operations are busy; try again",
    ),
    (
        NativeOperationClass::Raster,
        "Native raster operations are busy; try again",
    ),
];

#[test]
fn a_full_class_refuses_a_string_command_with_its_exact_busy_text() {
    let executor = test_executor(1, 1);
    for (class, text) in BUSY_TEXTS {
        let (release, settled, _finished) = held_write(&executor, class);
        let refused =
            tauri::async_runtime::block_on(executor.run(class, "one too many", || Ok(())));
        release.send(()).unwrap();
        assert_eq!(refused, Err(text.to_owned()), "{class:?}");
        assert_eq!(settled.recv_timeout(WAIT_TIMEOUT).unwrap(), Ok(()));
    }
}

/// The events `run` logs on this thread and in the work it starts, one line each: the
/// level, then every field as `name=value`.
fn logs_of<R>(run: impl FnOnce() -> R) -> (R, String) {
    use tracing_subscriber::layer::SubscriberExt as _;
    struct Recorder(Arc<std::sync::Mutex<Vec<String>>>);
    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Recorder {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _: tracing_subscriber::layer::Context<'_, S>,
        ) {
            let mut line = event.metadata().level().to_string();
            event.record(
                &mut |field: &tracing::field::Field, value: &dyn std::fmt::Debug| {
                    line.push_str(&format!(" {}={value:?}", field.name()));
                },
            );
            self.0.lock().unwrap().push(line);
        }
    }
    let lines = Arc::default();
    let subscriber = tracing_subscriber::registry().with(Recorder(Arc::clone(&lines)));
    let result = tracing::subscriber::with_default(subscriber, run);
    let text = lines.lock().unwrap().join("\n");
    (result, text)
}

fn lines_with<'a>(logs: &'a str, needle: &str) -> Vec<&'a str> {
    logs.lines().filter(|line| line.contains(needle)).collect()
}

#[test]
fn a_full_class_refuses_a_typed_command_busy_on_its_lane_once_at_info_without_spawning() {
    let executor = test_executor(1, 1);
    let lanes = [
        (NativeOperationClass::Catalog, Lane::Catalog),
        (NativeOperationClass::UserData, Lane::UserData),
        (NativeOperationClass::Local, Lane::Local),
        (NativeOperationClass::Network, Lane::Network),
        (NativeOperationClass::Raster, Lane::Library),
    ];
    for (class, lane) in lanes {
        let (release, settled, _finished) = held_write(&executor, class);
        let ran = Arc::new(AtomicBool::new(false));
        let probe = Arc::clone(&ran);
        let (refused, logs) = logs_of(|| {
            tauri::async_runtime::block_on(executor.run_typed::<(), Failure, _>(
                class,
                "probe.refused_op",
                move || {
                    probe.store(true, Ordering::SeqCst);
                    Ok(())
                },
            ))
        });
        release.send(()).unwrap();
        settled.recv_timeout(WAIT_TIMEOUT).unwrap().unwrap();

        let failure = refused.unwrap_err();
        assert_eq!(failure.code, FailureCode::Busy { lane }, "{class:?}");
        assert_eq!(failure.op, "probe.refused_op");
        assert!(failure.user_may_retry);
        assert!(
            !ran.load(Ordering::SeqCst),
            "{class:?}: the refused work ran"
        );
        let refusals = lines_with(&logs, "probe.refused_op");
        assert_eq!(refusals.len(), 1, "{class:?}: {logs}");
        assert!(
            refusals[0].starts_with("INFO ") && refusals[0].contains("settlement=\"busy\""),
            "{logs}"
        );
    }
}

#[test]
fn a_busy_class_renders_the_string_commands_text_byte_for_byte() {
    for (class, text) in BUSY_TEXTS {
        let error = ExecutorError::Busy {
            class,
            op: "probe.op",
        };
        assert_eq!(String::from(error), text);
    }
}

#[test]
fn a_closed_executor_settles_unavailable_logged_at_warn_and_never_runs_the_work() {
    let executor = test_executor(1, 1);
    executor.close_for_test(NativeOperationClass::UserData);
    let ran = Arc::new(AtomicBool::new(false));
    let probe = Arc::clone(&ran);
    let (typed, logs) = logs_of(|| {
        tauri::async_runtime::block_on(executor.run_typed::<(), Failure, _>(
            NativeOperationClass::UserData,
            "probe.closed_op",
            move || {
                probe.store(true, Ordering::SeqCst);
                Ok(())
            },
        ))
    });
    let text = tauri::async_runtime::block_on(executor.run(
        NativeOperationClass::UserData,
        "settings load",
        || Ok(()),
    ));

    assert_eq!(typed.unwrap_err().code, FailureCode::Unavailable);
    assert_eq!(
        text,
        Err("settings load native operation executor is unavailable".to_owned())
    );
    assert!(!ran.load(Ordering::SeqCst));
    let lines = lines_with(&logs, "probe.closed_op");
    assert_eq!(lines.len(), 1, "{logs}");
    assert!(lines[0].starts_with("WARN "), "{logs}");
}

#[test]
fn a_panic_settles_panicked_frees_its_permits_and_leaves_its_log_to_the_panic_hook() {
    let executor = test_executor(1, 1);
    let (typed, logs) = logs_of(|| {
        tauri::async_runtime::block_on(executor.run_typed::<(), Failure, _>(
            NativeOperationClass::Local,
            "probe.panicking_op",
            || panic!("controlled executor panic"),
        ))
    });
    let text = tauri::async_runtime::block_on(executor.run::<(), _>(
        NativeOperationClass::Local,
        "panicking operation",
        || panic!("controlled executor panic"),
    ));

    let failure = typed.unwrap_err();
    assert_eq!(failure.code, FailureCode::Panicked);
    assert!(!failure.user_may_retry);
    assert_eq!(
        text,
        Err("panicking operation native operation task failed".to_owned())
    );
    assert_eq!(
        executor.available_admission_for_test(NativeOperationClass::Local),
        1
    );
    assert!(
        !logs
            .lines()
            .any(|line| line.starts_with("ERROR") || line.starts_with("WARN")),
        "the executor logs a panic the hook already logged: {logs}"
    );
    assert!(logs.contains("settlement=\"panic\""), "{logs}");
}

#[test]
fn a_task_that_cannot_be_joined_settles_join_failed() {
    let error = ExecutorError::JoinFailed { op: "probe.op" };
    let failure = Failure::from(error);
    assert_eq!(
        (failure.code, failure.op, failure.user_may_retry),
        (FailureCode::JoinFailed, "probe.op", false)
    );
    assert_eq!(String::from(error), "probe.op native operation task failed");
}

#[test]
fn a_dropped_caller_lets_started_work_finish_log_its_settlement_and_free_its_permits() {
    let executor = test_executor(1, 1);
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = mpsc::sync_channel::<()>(1);
    let (finished_tx, finished_rx) = mpsc::sync_channel(1);
    let ((), logs) = logs_of(|| {
        tauri::async_runtime::block_on(async {
            let run = executor.run_typed::<(), Failure, _>(
                NativeOperationClass::Network,
                "probe.dropped_op",
                move || {
                    started_tx.send(()).ok();
                    release_rx.recv().ok();
                    finished_tx.send(()).ok();
                    Ok(())
                },
            );
            // The caller goes away once its work has started.
            tokio::select! {
                _ = run => panic!("the held work settled before its caller went away"),
                _ = started_rx => {}
            }
        });
        release_tx.send(()).unwrap();
        finished_rx.recv_timeout(WAIT_TIMEOUT).unwrap();
        wait_until(|| executor.available_admission_for_test(NativeOperationClass::Network) == 1);
    });

    let settled = lines_with(&logs, "Native operation finished");
    assert_eq!(settled.len(), 1, "{logs}");
    assert!(
        settled[0].contains("probe.dropped_op") && settled[0].contains("settlement=\"success\""),
        "{logs}"
    );
}
