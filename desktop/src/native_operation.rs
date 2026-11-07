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
mod tests;
