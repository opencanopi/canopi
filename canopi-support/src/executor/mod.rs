//! Lane-based native executor with priority queues, deadlines, cooperative cancellation,
//! supersession, and structured settlement telemetry (ADR 0023, ADR 0025, contracts §3).

mod blocking;
mod cancel;
mod lanes;
mod registry;
mod scheduler;
mod settlement;

use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

use canopi_types::failure::{Failure, FailureCode, OperationId};
use tokio::runtime::Handle;
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::time::duration_millis;
pub use blocking::{BlockingOutcome, run_legacy_blocking};
pub use cancel::{CancelReason, CancelToken};
pub use lanes::{
    BLOCKING_POOL_FLOOR, Deadline, ExecutorLane, JOB_QUEUE_BOUND, JOB_WORKERS, LANES, LaneConfig,
    OpSpec, Priority, RESERVED_BOOT_READS, lane_config, total_workers,
};
pub use registry::InFlightEntry;
use registry::RequestRegistry;
use scheduler::{AdmitOutcome, Grant, LaneScheduler, RunningSlotGuard};
pub use settlement::{SettlementEvent, SettlementKind, SettlementObserver};
use settlement::{SettlementTiming, finish_outcome, settle_error, settle_pre_start};

struct ExecutorInner {
    handle: Handle,
    lanes: [LaneScheduler; 6],
    closed: AtomicBool,
    next_id: AtomicU64,
    registry: RequestRegistry,
    observer: Option<SettlementObserver>,
}

/// Native lane-based executor owned by `canopi-support` (ADR 0023, ADR 0025).
///
/// Constructed directly with a [`tokio::runtime::Handle`] (no attach step, no `Option`).
#[derive(Clone)]
pub struct Executor {
    inner: Arc<ExecutorInner>,
}

impl Executor {
    /// Builds an executor using the production [`LANES`] table.
    #[must_use]
    pub fn new(handle: Handle) -> Self {
        Self::build(handle, LANES, None)
    }

    /// Builds an executor with a custom [`SettlementObserver`] for diagnostics or tests.
    #[must_use]
    pub fn with_observer(handle: Handle, observer: SettlementObserver) -> Self {
        Self::build(handle, LANES, Some(observer))
    }

    /// Builds an executor with custom lane limits (validated for non-zero workers and queue bounds).
    pub fn with_lanes(
        handle: Handle,
        lanes: [LaneConfig; 6],
        observer: Option<SettlementObserver>,
    ) -> Result<Self, &'static str> {
        for cfg in &lanes {
            if cfg.workers == 0 {
                return Err("lane worker count must be greater than zero");
            }
            if cfg.queue_bound == 0 {
                return Err("lane queue bound must be greater than zero");
            }
        }
        Ok(Self::build(handle, lanes, observer))
    }

    fn build(handle: Handle, lanes: [LaneConfig; 6], observer: Option<SettlementObserver>) -> Self {
        let schedulers =
            ExecutorLane::ALL.map(|lane| LaneScheduler::new(lane, lanes[lane.index()]));
        Self {
            inner: Arc::new(ExecutorInner {
                handle,
                lanes: schedulers,
                closed: AtomicBool::new(false),
                next_id: AtomicU64::new(1),
                registry: RequestRegistry::new(),
                observer,
            }),
        }
    }

    /// Cancels all active or queued requests registered under `operation` with [`CancelReason::User`].
    /// Returns the number of tokens transitioned to cancelled.
    pub fn cancel(&self, operation: &OperationId) -> usize {
        self.inner.registry.cancel_operation(operation)
    }

    /// Returns a snapshot of all currently queued or running requests (contracts §3).
    #[must_use]
    pub fn in_flight(&self) -> Vec<InFlightEntry> {
        self.inner.registry.snapshot()
    }

    /// Returns the number of requests currently waiting (queued or overflow) on `lane`.
    #[must_use]
    pub fn queued_count(&self, lane: ExecutorLane) -> usize {
        self.inner.lanes[lane.index()].waiting_len()
    }

    /// Returns `true` once [`Self::close`] has been called.
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::Acquire)
    }

    /// Closes the executor, cancelling all queued and active tokens with [`CancelReason::Shutdown`]
    /// and refusing subsequent [`Self::run`] calls with [`FailureCode::Unavailable`].
    pub fn close(&self) {
        self.inner.closed.store(true, Ordering::Release);
        for scheduler in &self.inner.lanes {
            scheduler.close();
        }
        self.inner.registry.cancel_all_shutdown();
    }

    /// Runs `work` on `spec.lane` under `operation` and `token`.
    ///
    /// Guarantees every request settles **exactly once**: `Ok`, domain `Failure`,
    /// `Busy{lane}` (only on deadline expiry), `Cancelled`, `Panicked`, `JoinFailed`,
    /// `Unavailable` (closed), or `Internal` (Job lane oversubscribed).
    /// Dropping the returned future cancels `token` as a backstop so running work sees it;
    /// once started, the blocking thread owns slot release, `in_flight` cleanup, and
    /// settlement telemetry.
    pub async fn run<T, F>(
        &self,
        spec: OpSpec,
        operation: Option<OperationId>,
        token: CancelToken,
        work: F,
    ) -> Result<T, Failure>
    where
        T: Send + 'static,
        F: FnOnce(CancelToken) -> Result<T, Failure> + Send + 'static,
    {
        let enqueued_at = Instant::now();
        if let Some(failure) = self.pre_start_failure(spec, &operation, &token, enqueued_at) {
            return Err(failure);
        }

        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        self.register_request(id, spec, operation.clone(), enqueued_at, &token);
        let mut guard = RequestCleanupGuard {
            executor: self.clone(),
            id,
            lane: spec.lane,
            token: token.clone(),
            started: false,
            settled: false,
        };

        let ctx = WaitContext {
            id,
            spec,
            operation: &operation,
            enqueued_at,
            token: &token,
        };
        let slot = match self.acquire_slot(&ctx).await {
            Ok(slot) => slot,
            Err(failure) => {
                guard.settled = true;
                return Err(failure);
            }
        };

        let queued_ms = duration_millis(enqueued_at.elapsed());
        if let Some(failure) = self.pre_start_failure(spec, &operation, &token, enqueued_at) {
            drop(slot);
            guard.settled = true;
            return Err(failure);
        }

        guard.started = true;
        let result = self
            .execute_started(
                StartedContext {
                    id,
                    spec,
                    operation,
                    token,
                    slot,
                    queued_ms,
                },
                work,
            )
            .await;
        guard.settled = true;
        result
    }

    fn pre_start_failure(
        &self,
        spec: OpSpec,
        operation: &Option<OperationId>,
        token: &CancelToken,
        enqueued_at: Instant,
    ) -> Option<Failure> {
        let obs = self.inner.observer.as_ref();
        if self.is_closed() || token.reason() == Some(CancelReason::Shutdown) {
            return Some(settle_pre_start(
                obs,
                spec,
                operation.clone(),
                enqueued_at,
                SettlementKind::Unavailable,
                FailureCode::Unavailable,
                false,
            ));
        }
        if token.is_cancelled() {
            return Some(settle_pre_start(
                obs,
                spec,
                operation.clone(),
                enqueued_at,
                SettlementKind::Cancelled,
                FailureCode::Cancelled,
                false,
            ));
        }
        None
    }

    async fn execute_started<T, F>(&self, ctx: StartedContext, work: F) -> Result<T, Failure>
    where
        T: Send + 'static,
        F: FnOnce(CancelToken) -> Result<T, Failure> + Send + 'static,
    {
        let StartedContext {
            id,
            spec,
            operation,
            token,
            slot,
            queued_ms,
        } = ctx;
        let started_at = Instant::now();
        let exec = self.clone();
        let settle_op = operation.clone();
        let settled = blocking::spawn_with_settle(
            &self.inner.handle,
            move || work(token),
            move |outcome| {
                let running = started_at.elapsed();
                let result = finish_outcome(
                    exec.inner.observer.as_ref(),
                    spec,
                    settle_op,
                    outcome,
                    SettlementTiming {
                        queued_ms,
                        running,
                        queue_full: false,
                    },
                );
                exec.unregister_request(id);
                drop(slot);
                result
            },
        )
        .await;

        match settled {
            Some(result) => result,
            None => {
                self.unregister_request(id);
                Err(settle_error(
                    self.inner.observer.as_ref(),
                    spec,
                    operation,
                    SettlementKind::JoinFailed,
                    FailureCode::JoinFailed,
                    SettlementTiming {
                        queued_ms,
                        running: started_at.elapsed(),
                        queue_full: false,
                    },
                ))
            }
        }
    }

    fn register_request(
        &self,
        id: u64,
        spec: OpSpec,
        operation: Option<OperationId>,
        enqueued_at: Instant,
        token: &CancelToken,
    ) {
        self.inner
            .registry
            .register(id, spec, operation, enqueued_at, token);
    }

    fn unregister_request(&self, id: u64) {
        self.inner.registry.unregister(id);
    }

    async fn acquire_slot(&self, ctx: &WaitContext<'_>) -> Result<RunningSlotGuard, Failure> {
        let scheduler = self.inner.lanes[ctx.spec.lane.index()].clone();
        let obs = self.inner.observer.as_ref();
        match scheduler.admit(ctx.id, ctx.spec.priority, ctx.token) {
            AdmitOutcome::RunningNow => Ok(RunningSlotGuard::new(scheduler)),
            AdmitOutcome::Closed => Err(settle_pre_start(
                obs,
                ctx.spec,
                ctx.operation.clone(),
                ctx.enqueued_at,
                SettlementKind::Unavailable,
                FailureCode::Unavailable,
                false,
            )),
            AdmitOutcome::Cancelled => {
                let (kind, code) = cancel_settlement(ctx.token, false);
                Err(settle_pre_start(
                    obs,
                    ctx.spec,
                    ctx.operation.clone(),
                    ctx.enqueued_at,
                    kind,
                    code,
                    false,
                ))
            }
            AdmitOutcome::JobOversubscribed => Err(settle_pre_start(
                obs,
                ctx.spec,
                ctx.operation.clone(),
                ctx.enqueued_at,
                SettlementKind::Error,
                FailureCode::Internal,
                true,
            )),
            AdmitOutcome::Queued(rx) => self.wait_for_grant(scheduler, rx, ctx, false).await,
            AdmitOutcome::Overflow(rx) => self.wait_for_grant(scheduler, rx, ctx, true).await,
        }
    }

    async fn wait_for_grant(
        &self,
        scheduler: LaneScheduler,
        grant_rx: oneshot::Receiver<Grant>,
        ctx: &WaitContext<'_>,
        from_overflow: bool,
    ) -> Result<RunningSlotGuard, Failure> {
        let mut wait_guard = GrantWaitGuard {
            id: ctx.id,
            scheduler: &scheduler,
            grant_rx,
            completed: false,
        };
        let deadline_instant = match ctx.spec.deadline {
            Deadline::Bounded(duration) => ctx.enqueued_at.checked_add(duration),
            Deadline::Unbounded => None,
        };
        let wait_result = match deadline_instant {
            Some(deadline) => {
                tokio::select! {
                    biased;
                    res = &mut wait_guard.grant_rx => WaitOutcome::Grant(res),
                    _ = ctx.token.cancelled() => WaitOutcome::Cancelled,
                    () = tokio::time::sleep_until(deadline) => WaitOutcome::TimedOut,
                }
            }
            None => {
                tokio::select! {
                    biased;
                    res = &mut wait_guard.grant_rx => WaitOutcome::Grant(res),
                    _ = ctx.token.cancelled() => WaitOutcome::Cancelled,
                }
            }
        };

        let obs = self.inner.observer.as_ref();
        match wait_result {
            WaitOutcome::Grant(Ok(Grant::Run)) => {
                wait_guard.completed = true;
                drop(wait_guard);
                Ok(RunningSlotGuard::new(scheduler))
            }
            WaitOutcome::Grant(Ok(Grant::Closed)) => {
                wait_guard.completed = true;
                Err(settle_pre_start(
                    obs,
                    ctx.spec,
                    ctx.operation.clone(),
                    ctx.enqueued_at,
                    SettlementKind::Unavailable,
                    FailureCode::Unavailable,
                    false,
                ))
            }
            WaitOutcome::Grant(Err(_)) => {
                wait_guard.completed = true;
                let (kind, code) = cancel_settlement(ctx.token, self.is_closed());
                Err(settle_pre_start(
                    obs,
                    ctx.spec,
                    ctx.operation.clone(),
                    ctx.enqueued_at,
                    kind,
                    code,
                    false,
                ))
            }
            WaitOutcome::Cancelled => {
                wait_guard.release_if_granted();
                let (kind, code) = cancel_settlement(ctx.token, false);
                Err(settle_pre_start(
                    obs,
                    ctx.spec,
                    ctx.operation.clone(),
                    ctx.enqueued_at,
                    kind,
                    code,
                    false,
                ))
            }
            WaitOutcome::TimedOut => {
                wait_guard.release_if_granted();
                let code = match ctx.spec.lane.failure_lane() {
                    Some(lane) => FailureCode::Busy { lane },
                    None => FailureCode::Internal,
                };
                Err(settle_pre_start(
                    obs,
                    ctx.spec,
                    ctx.operation.clone(),
                    ctx.enqueued_at,
                    SettlementKind::Busy,
                    code,
                    from_overflow,
                ))
            }
        }
    }
}

fn cancel_settlement(token: &CancelToken, closed: bool) -> (SettlementKind, FailureCode) {
    if token.reason() == Some(CancelReason::Shutdown) || (!token.is_cancelled() && closed) {
        (SettlementKind::Unavailable, FailureCode::Unavailable)
    } else {
        (SettlementKind::Cancelled, FailureCode::Cancelled)
    }
}

struct GrantWaitGuard<'a> {
    id: u64,
    scheduler: &'a LaneScheduler,
    grant_rx: oneshot::Receiver<Grant>,
    completed: bool,
}

impl GrantWaitGuard<'_> {
    fn release_if_granted(&mut self) {
        if !self.completed {
            self.completed = true;
            self.grant_rx.close();
            self.scheduler.remove_waiter(self.id);
            if matches!(self.grant_rx.try_recv(), Ok(Grant::Run)) {
                self.scheduler.release_running_slot();
            }
        }
    }
}

impl Drop for GrantWaitGuard<'_> {
    fn drop(&mut self) {
        self.release_if_granted();
    }
}

struct StartedContext {
    id: u64,
    spec: OpSpec,
    operation: Option<OperationId>,
    token: CancelToken,
    slot: RunningSlotGuard,
    queued_ms: u64,
}

struct WaitContext<'a> {
    id: u64,
    spec: OpSpec,
    operation: &'a Option<OperationId>,
    enqueued_at: Instant,
    token: &'a CancelToken,
}

enum WaitOutcome {
    Grant(Result<Grant, oneshot::error::RecvError>),
    Cancelled,
    TimedOut,
}

struct RequestCleanupGuard {
    executor: Executor,
    id: u64,
    lane: ExecutorLane,
    token: CancelToken,
    started: bool,
    settled: bool,
}

impl Drop for RequestCleanupGuard {
    fn drop(&mut self) {
        if !self.settled {
            self.token.cancel(CancelReason::User);
            if !self.started {
                self.executor.inner.lanes[self.lane.index()].remove_waiter(self.id);
                self.executor.unregister_request(self.id);
            }
        } else if !self.started {
            self.executor.unregister_request(self.id);
        }
    }
}
