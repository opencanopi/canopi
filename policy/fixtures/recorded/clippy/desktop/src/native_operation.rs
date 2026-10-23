use std::{
    panic::{AssertUnwindSafe, catch_unwind, resume_unwind},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Semaphore, TryAcquireError};

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

    fn busy_error(self) -> String {
        format!("Native {} operations are busy; try again", self.as_str())
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
        let executor = &self.classes[class.index()];
        let queued_at = Instant::now();
        let admission_permit = match Arc::clone(&executor.admission).try_acquire_owned() {
            Ok(permit) => permit,
            Err(TryAcquireError::NoPermits) => {
                tracing::warn!(
                    native_operation_class = class.as_str(),
                    native_operation = label,
                    settlement = "busy",
                    "Native operation rejected",
                );
                return Err(class.busy_error());
            }
            Err(TryAcquireError::Closed) => {
                tracing::error!(
                    native_operation_class = class.as_str(),
                    native_operation = label,
                    settlement = "executor-closed",
                    "Native operation admission failed",
                );
                return Err(format!("{label} native operation executor is unavailable"));
            }
        };
        tracing::debug!(
            native_operation_class = class.as_str(),
            native_operation = label,
            "Native operation admitted",
        );

        let running_permit = Arc::clone(&executor.running)
            .acquire_owned()
            .await
            .map_err(|_| format!("{label} native operation executor is unavailable"))?;
        let queued_ms = duration_millis(queued_at.elapsed());

        // The closure sits outside the reviewed statement so clippy still checks it.
        let run = move || {
            tracing::debug!(
                native_operation_class = class.as_str(),
                native_operation = label,
                queued_ms,
                "Native operation started",
            );
            let started_at = Instant::now();
            let settlement = catch_unwind(AssertUnwindSafe(work));

            match settlement {
                Ok(result) => {
                    tracing::debug!(
                        native_operation_class = class.as_str(),
                        native_operation = label,
                        settlement = if result.is_ok() { "success" } else { "error" },
                        running_ms = duration_millis(started_at.elapsed()),
                        "Native operation finished",
                    );
                    drop(running_permit);
                    drop(admission_permit);
                    result
                }
                Err(panic_payload) => {
                    tracing::error!(
                        native_operation_class = class.as_str(),
                        native_operation = label,
                        settlement = "panic",
                        running_ms = duration_millis(started_at.elapsed()),
                        "Native operation panicked",
                    );
                    drop(running_permit);
                    drop(admission_permit);
                    resume_unwind(panic_payload)
                }
            }
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
                    native_operation = label,
                    settlement = "join-failure",
                    "Native operation task failed",
                );
                Err(format!("{label} native operation task failed"))
            }
        }
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
}

impl NativeOperationClassExecutor {
    fn new(limits: NativeOperationClassLimits) -> Self {
        Self {
            admission: Arc::new(Semaphore::new(limits.admitted)),
            running: Arc::new(Semaphore::new(limits.running)),
        }
    }
}

fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::{
        NativeOperationClass, NativeOperationClassLimits, NativeOperationExecutor,
        NativeOperationLimits,
    };
    use std::{
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
            mpsc,
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
