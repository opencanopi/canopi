//! The native executor: bounded admission and running per operation class, every native
//! operation's work on the blocking pool. A run the executor settles itself, without the
//! work's own result, is an [`ExecutorError`]: a typed command maps it onto its catalogue
//! `Failure`, a String command onto the text it has always rejected with (contracts §2;
//! until N0's lanes replace the classes, 2.1-M41).

use canopi_types::failure::{Failure, FailureCode, Lane};
use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError};

const OPERATION_CLASSES: [NativeOperationClass; 5] = [
    NativeOperationClass::Catalog,
    NativeOperationClass::UserData,
    NativeOperationClass::Local,
    NativeOperationClass::Network,
    NativeOperationClass::Raster,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeOperationClass {
    Catalog,
    UserData,
    Local,
    Network,
    /// LiDAR import, analysis and display preparation (U50(1)): their own
    /// class, so raster work never fills the Local slots that saves, loads and
    /// Site data sampling need.
    Raster,
}

impl NativeOperationClass {
    const fn index(self) -> usize {
        match self {
            Self::Catalog => 0,
            Self::UserData => 1,
            Self::Local => 2,
            Self::Network => 3,
            Self::Raster => 4,
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::Catalog => "catalog",
            Self::UserData => "user-data",
            Self::Local => "local",
            Self::Network => "network",
            Self::Raster => "raster",
        }
    }

    /// The lane this class is on the wire (2.1-M420): today's Raster class is the library's.
    pub const fn lane(self) -> Lane {
        match self {
            Self::Catalog => Lane::Catalog,
            Self::UserData => Lane::UserData,
            Self::Local => Lane::Local,
            Self::Network => Lane::Network,
            Self::Raster => Lane::Library,
        }
    }
}

/// A run the executor settled without the work's own result. `op` is the label the run
/// was admitted under: a typed command's dotted op constant.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutorError {
    /// The class's admission was full; the work never ran.
    Busy {
        /// The full class.
        class: NativeOperationClass,
        /// The refused run's label.
        op: &'static str,
    },
    /// The executor is closed; the work never ran.
    Unavailable {
        /// The refused run's label.
        op: &'static str,
    },
    /// The work panicked; its permits are freed and the panic is not resumed.
    Panicked {
        /// The run's label.
        op: &'static str,
    },
    /// The work's blocking task could not be joined.
    JoinFailed {
        /// The run's label.
        op: &'static str,
    },
}

impl ExecutorError {
    /// The catalogue code of this settlement.
    pub const fn code(self) -> FailureCode {
        match self {
            Self::Busy { class, .. } => FailureCode::Busy { lane: class.lane() },
            Self::Unavailable { .. } => FailureCode::Unavailable,
            Self::Panicked { .. } => FailureCode::Panicked,
            Self::JoinFailed { .. } => FailureCode::JoinFailed,
        }
    }
}

/// A typed command's failure: the settlement's code, for the op the run was admitted under.
impl From<ExecutorError> for Failure {
    fn from(error: ExecutorError) -> Self {
        let op = match error {
            ExecutorError::Busy { op, .. }
            | ExecutorError::Unavailable { op }
            | ExecutorError::Panicked { op }
            | ExecutorError::JoinFailed { op } => op,
        };
        Failure::new(error.code(), op)
    }
}

/// A String command's rejection, byte for byte the text it had before the executor was
/// typed: the frontend's busy matchers read it until N1 and N2 type their commands
/// (2.1-M41), and a panic reads as a failed task, as it did when it was resumed.
impl From<ExecutorError> for String {
    fn from(error: ExecutorError) -> Self {
        match error {
            ExecutorError::Busy { class, .. } => {
                format!("Native {} operations are busy; try again", class.as_str())
            }
            ExecutorError::Unavailable { op } => {
                format!("{op} native operation executor is unavailable")
            }
            ExecutorError::Panicked { op } | ExecutorError::JoinFailed { op } => {
                format!("{op} native operation task failed")
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeOperationClassLimits {
    admitted: usize,
    running: usize,
}

impl NativeOperationClassLimits {
    pub const fn new(admitted: usize, running: usize) -> Self {
        Self { admitted, running }
    }

    fn validate(self, class: NativeOperationClass) -> Result<(), String> {
        if self.running == 0 {
            return Err(format!(
                "Native {} operation running capacity must be greater than zero",
                class.as_str(),
            ));
        }
        if self.admitted < self.running {
            return Err(format!(
                "Native {} operation admission capacity must be at least its running capacity",
                class.as_str(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeOperationLimits {
    classes: [NativeOperationClassLimits; 5],
}

impl NativeOperationLimits {
    pub const fn new(
        catalog: NativeOperationClassLimits,
        user_data: NativeOperationClassLimits,
        local: NativeOperationClassLimits,
        network: NativeOperationClassLimits,
        raster: NativeOperationClassLimits,
    ) -> Self {
        Self {
            classes: [catalog, user_data, local, network, raster],
        }
    }

    #[cfg(test)]
    const fn uniform(limits: NativeOperationClassLimits) -> Self {
        Self::new(limits, limits, limits, limits, limits)
    }

    pub const fn production() -> Self {
        Self::new(
            NativeOperationClassLimits::new(8, 1),
            NativeOperationClassLimits::new(8, 1),
            NativeOperationClassLimits::new(6, 2),
            NativeOperationClassLimits::new(12, 4),
            NativeOperationClassLimits::new(4, 2),
        )
    }

    pub const fn for_class(self, class: NativeOperationClass) -> NativeOperationClassLimits {
        self.classes[class.index()]
    }
}

#[derive(Clone)]
pub struct NativeOperationExecutor {
    classes: [NativeOperationClassExecutor; 5],
}

impl NativeOperationExecutor {
    pub fn new(limits: NativeOperationLimits) -> Result<Self, String> {
        for class in OPERATION_CLASSES {
            limits.for_class(class).validate(class)?;
        }
        Ok(Self {
            classes: OPERATION_CLASSES
                .map(|class| NativeOperationClassExecutor::new(limits.for_class(class))),
        })
    }

    #[expect(
        clippy::expect_used,
        reason = "the production limits are constants validated by tests"
    )]
    pub fn production() -> Self {
        Self::new(NativeOperationLimits::production())
            .expect("production native operation limits must be valid")
    }

    /// Run a String command's `work` in `class`: an executor settlement rejects with the
    /// text it always has ([`ExecutorError`]'s String rendering).
    pub async fn run<T, F>(
        &self,
        class: NativeOperationClass,
        label: &'static str,
        work: F,
    ) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, String> + Send + 'static,
    {
        self.run_typed(class, label, work).await
    }

    /// Run `work` in `class` under `op`, admitted at once or refused [`ExecutorError::Busy`]
    /// with no spawn, then queued FIFO for a running slot. The work's own error passes
    /// through unchanged; an executor settlement becomes `E` (a typed command's `Failure`).
    /// A caller that goes away does not stop started work: it runs to its end, logs its
    /// settlement and frees its permits.
    pub async fn run_typed<T, E, F>(
        &self,
        class: NativeOperationClass,
        op: &'static str,
        work: F,
    ) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<ExecutorError> + Send + 'static,
        F: FnOnce() -> Result<T, E> + Send + 'static,
    {
        let executor = &self.classes[class.index()];
        let queued_at = Instant::now();
        let admission_permit = match Arc::clone(&executor.admission).try_acquire_owned() {
            Ok(permit) => permit,
            Err(TryAcquireError::NoPermits) => {
                // Info: a full class is expected under load, and the caller shows it once.
                tracing::info!(
                    native_operation_class = class.as_str(),
                    native_operation = op,
                    settlement = "busy",
                    "Native operation rejected",
                );
                return Err(ExecutorError::Busy { class, op }.into());
            }
            Err(TryAcquireError::Closed) => return Err(unavailable(class, op).into()),
        };
        tracing::debug!(
            native_operation_class = class.as_str(),
            native_operation = op,
            "Native operation admitted",
        );

        let Ok(running_permit) = Arc::clone(&executor.running).acquire_owned().await else {
            return Err(unavailable(class, op).into());
        };
        let queued_ms = duration_millis(queued_at.elapsed());
        // The work logs to the caller's subscriber, whichever thread runs it.
        let dispatch = tracing::dispatcher::get_default(Clone::clone);

        // The closure sits outside the reviewed statement so clippy still checks it.
        let run = move || {
            tracing::dispatcher::with_default(&dispatch, || {
                tracing::debug!(
                    native_operation_class = class.as_str(),
                    native_operation = op,
                    queued_ms,
                    "Native operation started",
                );
                let started_at = Instant::now();
                #[expect(
                    clippy::disallowed_methods,
                    reason = "the executor settlement turns a native operation's panic into its error"
                )]
                let settlement = catch_unwind(AssertUnwindSafe(work));
                // A panic was logged once by the panic hook; it settles here and is not resumed.
                let (result, settled) = match settlement {
                    Ok(result) => {
                        let settled = if result.is_ok() { "success" } else { "error" };
                        (result, settled)
                    }
                    Err(_panic) => (Err(ExecutorError::Panicked { op }.into()), "panic"),
                };
                tracing::debug!(
                    native_operation_class = class.as_str(),
                    native_operation = op,
                    settlement = settled,
                    running_ms = duration_millis(started_at.elapsed()),
                    "Native operation finished",
                );
                drop(running_permit);
                drop(admission_permit);
                result
            })
        };
        #[expect(
            clippy::disallowed_methods,
            reason = "the executor owns the blocking pool; every native operation reaches it here"
        )]
        let task = tauri::async_runtime::spawn_blocking(run);

        match task.await {
            Ok(result) => result,
            Err(_) => {
                tracing::error!(
                    native_operation_class = class.as_str(),
                    native_operation = op,
                    settlement = "join-failure",
                    "Native operation task failed",
                );
                Err(ExecutorError::JoinFailed { op }.into())
            }
        }
    }

    #[cfg(test)]
    fn close_for_test(&self, class: NativeOperationClass) {
        self.classes[class.index()].admission.close();
    }

    /// The bounded exit flush, for an exit nothing asked first (the NSIS installer's Restart
    /// Manager close ends Canopi with `RunEvent::Exit` only; 2.1-M82): waits up to `deadline` for
    /// every admitted write-class operation to settle, so a Design, Draft or settings write the
    /// frontend already sent lands whole, and admits no write after, since Canopi is exiting. A
    /// poll of the admission permits, so it needs no runtime on the exiting event-loop thread.
    /// True when every write settled in time.
    pub fn drain_writes_before_exit(&self, deadline: Duration) -> bool {
        let drain = self.hold_writes_for_exit(deadline, None);
        let settled = drain.settled();
        drain.keep();
        settled
    }

    /// The exit flush for an exit Canopi starts itself (the update's restart, its Windows
    /// installer): waits up to `deadline` for the admitted write-class operations to settle and
    /// holds their admission, so no write starts while the [`ExitDrain`] lives. `caller` is the
    /// write class the calling operation runs in, whose own admission it leaves out. An exit that
    /// does not happen drops the drain, and writes are admitted again.
    pub fn hold_writes_for_exit(
        &self,
        deadline: Duration,
        caller: Option<NativeOperationClass>,
    ) -> ExitDrain {
        let until = Instant::now() + deadline;
        let mut drain = ExitDrain {
            held: Vec::new(),
            settled: true,
        };
        for class in WRITE_CLASSES {
            let executor = &self.classes[class.index()];
            let own = usize::from(caller == Some(class));
            let wanted = u32::try_from(executor.admitted.saturating_sub(own)).unwrap_or(u32::MAX);
            loop {
                if let Ok(permits) = Arc::clone(&executor.admission).try_acquire_many_owned(wanted)
                {
                    drain.held.push(permits);
                    break;
                }
                if Instant::now() >= until {
                    // Info, not warn: warn and error belong to the failure logger (R15), and nothing
                    // shows a user an exit that is already under way; the log keeps the record.
                    tracing::info!(
                        native_operation_class = class.as_str(),
                        "Exit flush reached its deadline with writes still running",
                    );
                    drain.settled = false;
                    return drain;
                }
                std::thread::sleep(EXIT_FLUSH_POLL);
            }
        }
        drain
    }

    #[cfg(test)]
    fn available_admission_for_test(&self, class: NativeOperationClass) -> usize {
        self.classes[class.index()].admission.available_permits()
    }
}

#[derive(Clone)]
struct NativeOperationClassExecutor {
    admission: Arc<Semaphore>,
    running: Arc<Semaphore>,
    admitted: usize,
}

impl NativeOperationClassExecutor {
    fn new(limits: NativeOperationClassLimits) -> Self {
        Self {
            admission: Arc::new(Semaphore::new(limits.admitted)),
            running: Arc::new(Semaphore::new(limits.running)),
            admitted: limits.admitted,
        }
    }
}

/// How long an exit waits for the writes already sent to land.
pub const EXIT_DRAIN_DEADLINE: Duration = Duration::from_secs(2);

/// The write classes' admission, held by an exit: no write starts while it lives. Dropped, the
/// writes are admitted again (an exit that did not happen); kept, never again (an exit under way).
#[must_use = "dropping the drain admits writes again"]
pub struct ExitDrain {
    held: Vec<OwnedSemaphorePermit>,
    settled: bool,
}

impl ExitDrain {
    /// Whether every write settled before the deadline.
    pub fn settled(&self) -> bool {
        self.settled
    }

    /// Keeps the admission for good: Canopi is exiting.
    pub fn keep(self) {
        for permits in self.held {
            permits.forget();
        }
    }
}

/// The classes whose operations write user work: Design, Draft and settings writes.
const WRITE_CLASSES: [NativeOperationClass; 2] =
    [NativeOperationClass::UserData, NativeOperationClass::Local];

/// How often the exit flush looks again for the write classes to settle.
const EXIT_FLUSH_POLL: Duration = Duration::from_millis(5);

/// A closed executor refused `op`: the work never ran.
fn unavailable(class: NativeOperationClass, op: &'static str) -> ExecutorError {
    tracing::warn!(
        native_operation_class = class.as_str(),
        native_operation = op,
        settlement = "unavailable",
        "Native operation executor is closed",
    );
    ExecutorError::Unavailable { op }
}

fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
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

    #[test]
    fn the_exit_flush_waits_for_a_running_write_to_settle_then_admits_no_write() {
        let executor = test_executor(2, 1);
        let (release, settled, _finished) = held_write(&executor, NativeOperationClass::Local);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            release.send(()).ok();
        });

        let drained = executor.drain_writes_before_exit(WAIT_TIMEOUT);

        let refused = tauri::async_runtime::block_on(executor.run(
            NativeOperationClass::UserData,
            "late write",
            || Ok(()),
        ));
        assert_eq!(
            (
                drained,
                settled.recv_timeout(WAIT_TIMEOUT).unwrap(),
                refused
            ),
            (
                true,
                Ok(()),
                Err("Native user-data operations are busy; try again".to_owned())
            )
        );
    }

    #[test]
    fn the_exit_flush_gives_up_at_its_deadline_when_a_write_does_not_settle() {
        let executor = test_executor(2, 1);
        let (release, _settled, _finished) = held_write(&executor, NativeOperationClass::UserData);
        let started = Instant::now();

        let drained = executor.drain_writes_before_exit(Duration::from_millis(30));

        let waited = started.elapsed();
        release.send(()).unwrap();
        assert!(!drained);
        assert!(waited >= Duration::from_millis(30) && waited < WAIT_TIMEOUT);
    }

    /// canopi-f47t.52.228.15: the Windows update starts its installer, which ends Canopi, from
    /// inside its own Local operation; its drain waits for every other write and not for itself.
    #[test]
    fn an_exit_from_inside_a_write_waits_for_the_other_writes_and_not_for_itself() {
        let executor = test_executor(2, 1);
        let (release, _settled, finished) = held_write(&executor, NativeOperationClass::UserData);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            release.send(()).ok();
        });
        let inner = executor.clone();

        let seen = tauri::async_runtime::block_on(executor.run(
            NativeOperationClass::Local,
            "update exit",
            move || {
                let drain =
                    inner.hold_writes_for_exit(WAIT_TIMEOUT, Some(NativeOperationClass::Local));
                Ok((drain.settled(), finished.try_recv().is_ok()))
            },
        ));

        assert_eq!(seen, Ok((true, true)));
    }

    /// canopi-f47t.52.228.15: an installer that cannot start leaves Canopi open, saving again.
    #[test]
    fn a_dropped_exit_drain_admits_writes_again() {
        let executor = test_executor(2, 1);
        let drain = executor.hold_writes_for_exit(WAIT_TIMEOUT, None);
        let refused = tauri::async_runtime::block_on(executor.run(
            NativeOperationClass::UserData,
            "write while held",
            || Ok(()),
        ));

        drop(drain);

        let admitted = tauri::async_runtime::block_on(executor.run(
            NativeOperationClass::UserData,
            "write after",
            || Ok(()),
        ));
        assert_eq!((refused.is_err(), admitted), (true, Ok(())));
    }

    #[test]
    fn the_exit_flush_does_not_wait_for_network_or_raster_work() {
        let executor = test_executor(2, 1);
        let (release, _settled, _finished) = held_write(&executor, NativeOperationClass::Network);

        let drained = executor.drain_writes_before_exit(Duration::from_millis(30));

        release.send(()).unwrap();
        assert!(drained);
    }

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
            wait_until(|| {
                executor.available_admission_for_test(NativeOperationClass::Network) == 1
            });
        });

        let settled = lines_with(&logs, "Native operation finished");
        assert_eq!(settled.len(), 1, "{logs}");
        assert!(
            settled[0].contains("probe.dropped_op")
                && settled[0].contains("settlement=\"success\""),
            "{logs}"
        );
    }

    #[test]
    fn starts_admitted_work_in_fifo_order() {
        tauri::async_runtime::block_on(async {
            let executor = test_executor(3, 1);
            let (started_tx, started_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::sync_channel(1);
            let first_executor = executor.clone();
            let first = tauri::async_runtime::spawn(async move {
                first_executor
                    .run(NativeOperationClass::Catalog, "fifo blocker", move || {
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    })
                    .await
            });
            started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

            let (order_tx, order_rx) = mpsc::channel();
            let second_executor = executor.clone();
            let second_order = order_tx.clone();
            let second = tauri::async_runtime::spawn(async move {
                second_executor
                    .run(NativeOperationClass::Catalog, "fifo second", move || {
                        second_order.send(2).unwrap();
                        Ok(())
                    })
                    .await
            });
            wait_until(|| {
                executor.available_admission_for_test(NativeOperationClass::Catalog) == 1
            });

            let third_executor = executor.clone();
            let third = tauri::async_runtime::spawn(async move {
                third_executor
                    .run(NativeOperationClass::Catalog, "fifo third", move || {
                        order_tx.send(3).unwrap();
                        Ok(())
                    })
                    .await
            });
            wait_until(|| {
                executor.available_admission_for_test(NativeOperationClass::Catalog) == 0
            });

            release_tx.send(()).unwrap();
            assert_eq!(order_rx.recv_timeout(WAIT_TIMEOUT).unwrap(), 2);
            assert_eq!(order_rx.recv_timeout(WAIT_TIMEOUT).unwrap(), 3);
            first.await.unwrap().unwrap();
            second.await.unwrap().unwrap();
            third.await.unwrap().unwrap();
        });
    }

    #[test]
    fn dropping_queued_work_releases_admission_without_spawning() {
        tauri::async_runtime::block_on(async {
            let executor = test_executor(2, 1);
            let (started_tx, started_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::sync_channel(1);
            let first_executor = executor.clone();
            let first = tauri::async_runtime::spawn(async move {
                first_executor
                    .run(NativeOperationClass::Local, "queue blocker", move || {
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    })
                    .await
            });
            started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

            let queued_work_ran = Arc::new(AtomicBool::new(false));
            let queued_work_probe = Arc::clone(&queued_work_ran);
            let queued_executor = executor.clone();
            let queued = tauri::async_runtime::spawn(async move {
                queued_executor
                    .run(
                        NativeOperationClass::Local,
                        "cancelled queued operation",
                        move || {
                            queued_work_probe.store(true, Ordering::SeqCst);
                            Ok(())
                        },
                    )
                    .await
            });
            wait_until(|| executor.available_admission_for_test(NativeOperationClass::Local) == 0);

            queued.abort();
            assert!(queued.await.is_err());
            wait_until(|| executor.available_admission_for_test(NativeOperationClass::Local) == 1);
            assert!(!queued_work_ran.load(Ordering::SeqCst));

            release_tx.send(()).unwrap();
            first.await.unwrap().unwrap();
            executor
                .run(
                    NativeOperationClass::Local,
                    "post-cancellation operation",
                    || Ok(()),
                )
                .await
                .unwrap();
        });
    }

    #[test]
    fn dropping_started_caller_keeps_capacity_until_blocking_work_finishes() {
        tauri::async_runtime::block_on(async {
            let executor = test_executor(1, 1);
            let (started_tx, started_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::sync_channel(1);
            let (finished_tx, finished_rx) = mpsc::sync_channel(1);
            let started_executor = executor.clone();
            let started = tauri::async_runtime::spawn(async move {
                started_executor
                    .run(
                        NativeOperationClass::Network,
                        "detached started operation",
                        move || {
                            started_tx.send(()).unwrap();
                            release_rx.recv().unwrap();
                            finished_tx.send(()).unwrap();
                            Ok(())
                        },
                    )
                    .await
            });
            started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

            started.abort();
            assert!(started.await.is_err());
            let rejected_work_ran = Arc::new(AtomicBool::new(false));
            let rejected_work_probe = Arc::clone(&rejected_work_ran);
            let error = executor
                .run(
                    NativeOperationClass::Network,
                    "while detached work runs",
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
            finished_rx.recv_timeout(WAIT_TIMEOUT).unwrap();
            wait_until(|| {
                executor.available_admission_for_test(NativeOperationClass::Network) == 1
            });
            executor
                .run(
                    NativeOperationClass::Network,
                    "after detached completion",
                    || Ok(()),
                )
                .await
                .unwrap();
        });
    }

    #[test]
    fn panic_and_work_error_release_capacity() {
        tauri::async_runtime::block_on(async {
            let executor = test_executor(1, 1);

            let panic_error = executor
                .run::<(), _>(NativeOperationClass::Local, "panicking operation", || {
                    panic!("controlled executor panic")
                })
                .await
                .unwrap_err();
            assert_eq!(
                panic_error,
                "panicking operation native operation task failed"
            );

            let work_error = executor
                .run::<(), _>(NativeOperationClass::Local, "fallible operation", || {
                    Err("domain failure".to_owned())
                })
                .await
                .unwrap_err();
            assert_eq!(work_error, "domain failure");

            executor
                .run(NativeOperationClass::Local, "after failures", || Ok(()))
                .await
                .unwrap();
        });
    }

    #[test]
    fn a_local_operation_starts_while_raster_is_saturated() {
        tauri::async_runtime::block_on(async {
            let executor = NativeOperationExecutor::production();
            let raster =
                NativeOperationLimits::production().for_class(NativeOperationClass::Raster);
            let (started_tx, started_rx) = mpsc::channel();
            let mut releases = Vec::new();
            let mut raster_jobs = Vec::new();
            let mut start_raster_job = |label: &'static str| {
                let (release_tx, release_rx) = mpsc::sync_channel(1);
                releases.push(release_tx);
                let started_tx = started_tx.clone();
                let job_executor = executor.clone();
                raster_jobs.push(tauri::async_runtime::spawn(async move {
                    job_executor
                        .run(NativeOperationClass::Raster, label, move || {
                            started_tx.send(()).unwrap();
                            release_rx.recv().unwrap();
                            Ok(())
                        })
                        .await
                }));
            };

            for _ in 0..raster.running {
                start_raster_job("running raster operation");
            }
            for _ in 0..raster.running {
                started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();
            }
            for _ in raster.running..raster.admitted {
                start_raster_job("queued raster operation");
            }
            wait_until(|| executor.available_admission_for_test(NativeOperationClass::Raster) == 0);

            let refused = executor
                .run(
                    NativeOperationClass::Raster,
                    "one raster operation too many",
                    || Ok(()),
                )
                .await
                .unwrap_err();
            assert_eq!(refused, "Native raster operations are busy; try again");

            let (local_tx, local_rx) = mpsc::sync_channel(1);
            let local_executor = executor.clone();
            let local = tauri::async_runtime::spawn(async move {
                let result = local_executor
                    .run(
                        NativeOperationClass::Local,
                        "save during raster work",
                        || Ok("saved"),
                    )
                    .await;
                local_tx.send(result).unwrap();
            });
            assert_eq!(
                local_rx.recv_timeout(WAIT_TIMEOUT).unwrap(),
                Ok("saved"),
                "a Local operation must not wait behind saturated Raster work",
            );
            local.await.unwrap();

            for release in releases {
                release.send(()).unwrap();
            }
            for job in raster_jobs {
                job.await.unwrap().unwrap();
            }
        });
    }
}
