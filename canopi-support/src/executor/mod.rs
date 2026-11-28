//! Lane-based native executor with priority queues, deadlines, cooperative cancellation,
//! supersession, and structured settlement telemetry (ADR 0023, ADR 0025, contracts §3).

mod blocking;
mod cancel;
mod lanes;
mod scheduler;
mod settlement;

use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
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
use scheduler::{AdmitOutcome, Grant, LaneScheduler, RunningSlotGuard};
pub use settlement::{SettlementEvent, SettlementKind, SettlementObserver};
use settlement::{SettlementTiming, finish_outcome, settle_error, settle_pre_start};

/// Snapshot of one currently admitted or running request (contracts §3).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InFlightEntry {
    /// Caller's [`OperationId`], if provided.
    pub operation: Option<OperationId>,
    /// Operation constant from [`OpSpec::op`].
    pub op: &'static str,
    /// Target lane.
    pub lane: ExecutorLane,
    /// Monotonic enqueue timestamp.
    pub enqueued_at: Instant,
}

struct ActiveRequest {
    operation: Option<OperationId>,
    op: &'static str,
    lane: ExecutorLane,
    enqueued_at: Instant,
    token: CancelToken,
    supersede_key: Option<&'static str>,
}

struct Registry {
    active: HashMap<u64, ActiveRequest>,
    by_supersede: HashMap<&'static str, CancelToken>,
}

struct ExecutorInner {
    handle: Handle,
    lanes: [LaneScheduler; 6],
    closed: AtomicBool,
    next_id: AtomicU64,
    registry: Mutex<Registry>,
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
                registry: Mutex::new(Registry {
                    active: HashMap::new(),
                    by_supersede: HashMap::new(),
                }),
                observer,
            }),
        }
    }

    /// Cancels all active or queued requests registered under `operation` with [`CancelReason::User`].
    /// Returns the number of tokens transitioned to cancelled.
    pub fn cancel(&self, operation: &OperationId) -> usize {
        let tokens: Vec<CancelToken> = {
            let guard = self
                .inner
                .registry
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard
                .active
                .values()
                .filter(|entry| entry.operation.as_ref() == Some(operation))
                .map(|entry| entry.token.clone())
                .collect()
        };
        tokens
            .into_iter()
            .filter(|token| token.cancel(CancelReason::User))
            .count()
    }

    /// Returns a snapshot of all currently queued or running requests (contracts §3).
    #[must_use]
    pub fn in_flight(&self) -> Vec<InFlightEntry> {
        let guard = self
            .inner
            .registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard
            .active
            .values()
            .map(|entry| InFlightEntry {
                operation: entry.operation.clone(),
                op: entry.op,
                lane: entry.lane,
                enqueued_at: entry.enqueued_at,
            })
            .collect()
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
        let tokens: Vec<CancelToken> = {
            let guard = self
                .inner
                .registry
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard
                .active
                .values()
                .map(|entry| entry.token.clone())
                .collect()
        };
        for token in tokens {
            token.cancel(CancelReason::Shutdown);
        }
    }

    /// Runs `work` on `spec.lane` under `operation` and `token`.
    ///
    /// Guarantees every request settles **exactly once**: `Ok`, domain `Failure`,
    /// `Busy{lane}` (only on deadline expiry), `Cancelled`, `Panicked`, `JoinFailed`,
    /// `Unavailable` (closed), or `Internal` (Job lane oversubscribed).
    /// Dropping the returned future cancels `token` as a backstop so running work sees it.
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
        let obs = self.inner.observer.as_ref();
        if self.is_closed() {
            return Err(settle_pre_start(
                obs,
                spec,
                operation,
                enqueued_at,
                SettlementKind::Unavailable,
                FailureCode::Unavailable,
                false,
            ));
        }

        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        self.register_request(id, spec, operation.clone(), enqueued_at, &token);
        let mut guard = RequestCleanupGuard {
            executor: self.clone(),
            id,
            lane: spec.lane,
            token: token.clone(),
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
        if token.is_cancelled() {
            drop(slot);
            guard.settled = true;
            return Err(settle_error(
                obs,
                spec,
                operation,
                SettlementKind::Cancelled,
                FailureCode::Cancelled,
                SettlementTiming {
                    queued_ms,
                    running_ms: 0,
                    queue_full: false,
                },
            ));
        }

        let started_at = Instant::now();
        let work_token = token.clone();
        let outcome =
            blocking::run_with_guard(&self.inner.handle, slot, move || work(work_token)).await;
        let running_ms = duration_millis(started_at.elapsed());
        guard.settled = true;

        finish_outcome(
            obs,
            spec,
            operation,
            outcome,
            SettlementTiming {
                queued_ms,
                running_ms,
                queue_full: false,
            },
        )
    }

    fn register_request(
        &self,
        id: u64,
        spec: OpSpec,
        operation: Option<OperationId>,
        enqueued_at: Instant,
        token: &CancelToken,
    ) {
        let previous = {
            let mut reg = self
                .inner
                .registry
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let prev = spec
                .supersede_key
                .and_then(|key| reg.by_supersede.insert(key, token.clone()));
            reg.active.insert(
                id,
                ActiveRequest {
                    operation,
                    op: spec.op,
                    lane: spec.lane,
                    enqueued_at,
                    token: token.clone(),
                    supersede_key: spec.supersede_key,
                },
            );
            prev
        };
        if let Some(prev_token) = previous {
            prev_token.cancel(CancelReason::Superseded);
        }
    }

    fn unregister_request(&self, id: u64) {
        let mut reg = self
            .inner
            .registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(entry) = reg.active.remove(&id)
            && let Some(key) = entry.supersede_key
            && reg
                .by_supersede
                .get(key)
                .is_some_and(|current| current.ptr_eq(&entry.token))
        {
            reg.by_supersede.remove(key);
        }
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
            AdmitOutcome::Cancelled => Err(settle_pre_start(
                obs,
                ctx.spec,
                ctx.operation.clone(),
                ctx.enqueued_at,
                SettlementKind::Cancelled,
                FailureCode::Cancelled,
                false,
            )),
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
        mut grant_rx: oneshot::Receiver<Grant>,
        ctx: &WaitContext<'_>,
        from_overflow: bool,
    ) -> Result<RunningSlotGuard, Failure> {
        let wait_result = match ctx.spec.deadline {
            Deadline::Bounded(duration) => {
                let deadline = ctx.enqueued_at + duration;
                tokio::select! {
                    biased;
                    res = &mut grant_rx => WaitOutcome::Grant(res),
                    _ = ctx.token.cancelled() => WaitOutcome::Cancelled,
                    () = tokio::time::sleep_until(deadline) => WaitOutcome::TimedOut,
                }
            }
            Deadline::Unbounded => {
                tokio::select! {
                    biased;
                    res = &mut grant_rx => WaitOutcome::Grant(res),
                    _ = ctx.token.cancelled() => WaitOutcome::Cancelled,
                }
            }
        };

        let obs = self.inner.observer.as_ref();
        match wait_result {
            WaitOutcome::Grant(Ok(Grant::Run)) => Ok(RunningSlotGuard::new(scheduler)),
            WaitOutcome::Grant(Ok(Grant::Closed) | Err(_)) => Err(settle_pre_start(
                obs,
                ctx.spec,
                ctx.operation.clone(),
                ctx.enqueued_at,
                SettlementKind::Unavailable,
                FailureCode::Unavailable,
                false,
            )),
            WaitOutcome::Cancelled => {
                scheduler.remove_waiter(ctx.id);
                if matches!(grant_rx.try_recv(), Ok(Grant::Run)) {
                    scheduler.release_running_slot();
                }
                let (kind, code) = if self.is_closed() {
                    (SettlementKind::Unavailable, FailureCode::Unavailable)
                } else {
                    (SettlementKind::Cancelled, FailureCode::Cancelled)
                };
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
                scheduler.remove_waiter(ctx.id);
                if matches!(grant_rx.try_recv(), Ok(Grant::Run)) {
                    scheduler.release_running_slot();
                }
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
    settled: bool,
}

impl Drop for RequestCleanupGuard {
    fn drop(&mut self) {
        if !self.settled {
            self.token.cancel(CancelReason::User);
            self.executor.inner.lanes[self.lane.index()].remove_waiter(self.id);
        }
        self.executor.unregister_request(self.id);
    }
}
