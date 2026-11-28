//! Bounded per-lane priority queue with back-pressure and shutdown semantics (contracts §3).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use super::cancel::{CancelReason, CancelToken};
use super::lanes::{ExecutorLane, LaneConfig, Priority};

/// Signal sent to a queued or overflow waiter once it is granted a running slot or rejected.
pub(crate) enum Grant {
    /// Caller now owns one running worker slot and must release it when finished.
    Run,
    /// Executor closed while waiting.
    Closed,
}

/// Immediate outcome of attempting to admit or enqueue a request on one lane.
pub(crate) enum AdmitOutcome {
    /// Caller immediately owns one running worker slot.
    RunningNow,
    /// Caller is queued in the priority queue; await `grant_rx`.
    Queued(oneshot::Receiver<Grant>),
    /// Queue was full; caller is waiting for back-pressure relief until a slot frees or deadline expires.
    Overflow(oneshot::Receiver<Grant>),
    /// Executor is already closed.
    Closed,
    /// Token was already cancelled before admission.
    Cancelled,
    /// Job lane queue was full (should never happen while `canopi-library` slots gate it).
    JobOversubscribed,
}

struct QueuedWaiter {
    id: u64,
    token: CancelToken,
    grant_tx: oneshot::Sender<Grant>,
}

struct OverflowWaiter {
    id: u64,
    priority: Priority,
    token: CancelToken,
    grant_tx: oneshot::Sender<Grant>,
}

struct LaneInner {
    lane: ExecutorLane,
    workers: usize,
    queue_bound: usize,
    running: usize,
    closed: bool,
    interactive: VecDeque<QueuedWaiter>,
    background: VecDeque<QueuedWaiter>,
    overflow: VecDeque<OverflowWaiter>,
}

impl LaneInner {
    fn queued_len(&self) -> usize {
        self.interactive.len() + self.background.len()
    }

    fn promote_overflow_into_queue(&mut self) {
        while self.queued_len() < self.queue_bound {
            let Some(waiter) = self.overflow.pop_front() else {
                break;
            };
            if waiter.token.is_cancelled() || waiter.grant_tx.is_closed() {
                continue;
            }
            let queued = QueuedWaiter {
                id: waiter.id,
                token: waiter.token,
                grant_tx: waiter.grant_tx,
            };
            match waiter.priority {
                Priority::Interactive => self.interactive.push_back(queued),
                Priority::Background => self.background.push_back(queued),
            }
        }
    }

    fn pop_next_live_waiter(&mut self) -> Option<oneshot::Sender<Grant>> {
        while let Some(w) = self.interactive.pop_front() {
            if !w.token.is_cancelled() && !w.grant_tx.is_closed() {
                return Some(w.grant_tx);
            }
        }
        while let Some(w) = self.background.pop_front() {
            if !w.token.is_cancelled() && !w.grant_tx.is_closed() {
                return Some(w.grant_tx);
            }
        }
        while let Some(w) = self.overflow.pop_front() {
            if !w.token.is_cancelled() && !w.grant_tx.is_closed() {
                return Some(w.grant_tx);
            }
        }
        None
    }

    fn dispatch_or_release(&mut self) {
        if self.closed {
            self.running = self.running.saturating_sub(1);
            return;
        }
        while let Some(grant_tx) = self.pop_next_live_waiter() {
            self.promote_overflow_into_queue();
            if grant_tx.send(Grant::Run).is_ok() {
                return;
            }
        }
        self.running = self.running.saturating_sub(1);
    }
}

/// Thread-safe scheduler for one [`ExecutorLane`].
#[derive(Clone)]
pub(crate) struct LaneScheduler {
    inner: Arc<Mutex<LaneInner>>,
}

impl LaneScheduler {
    pub(crate) fn new(lane: ExecutorLane, cfg: LaneConfig) -> Self {
        Self {
            inner: Arc::new(Mutex::new(LaneInner {
                lane,
                workers: cfg.workers,
                queue_bound: cfg.queue_bound,
                running: 0,
                closed: false,
                interactive: VecDeque::new(),
                background: VecDeque::new(),
                overflow: VecDeque::new(),
            })),
        }
    }

    pub(crate) fn admit(&self, id: u64, priority: Priority, token: &CancelToken) -> AdmitOutcome {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if guard.closed {
            return AdmitOutcome::Closed;
        }
        if token.is_cancelled() {
            return AdmitOutcome::Cancelled;
        }
        if guard.running < guard.workers && guard.queued_len() == 0 {
            guard.running += 1;
            return AdmitOutcome::RunningNow;
        }
        if guard.queued_len() < guard.queue_bound {
            let (grant_tx, grant_rx) = oneshot::channel();
            let waiter = QueuedWaiter {
                id,
                token: token.clone(),
                grant_tx,
            };
            match priority {
                Priority::Interactive => guard.interactive.push_back(waiter),
                Priority::Background => guard.background.push_back(waiter),
            }
            return AdmitOutcome::Queued(grant_rx);
        }
        if guard.lane == ExecutorLane::Job {
            debug_assert!(
                false,
                "Job lane queue oversubscribed; job runner slots must gate admission"
            );
            return AdmitOutcome::JobOversubscribed;
        }
        let (grant_tx, grant_rx) = oneshot::channel();
        guard.overflow.push_back(OverflowWaiter {
            id,
            priority,
            token: token.clone(),
            grant_tx,
        });
        AdmitOutcome::Overflow(grant_rx)
    }

    pub(crate) fn remove_waiter(&self, id: u64) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.interactive.retain(|w| w.id != id);
        guard.background.retain(|w| w.id != id);
        guard.overflow.retain(|w| w.id != id);
        guard.promote_overflow_into_queue();
    }

    pub(crate) fn release_running_slot(&self) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.dispatch_or_release();
    }

    pub(crate) fn close(&self) {
        let tokens = {
            let mut guard = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.closed = true;
            let mut tokens = Vec::new();
            for w in guard.interactive.drain(..) {
                let _ = w.grant_tx.send(Grant::Closed);
                tokens.push(w.token);
            }
            for w in guard.background.drain(..) {
                let _ = w.grant_tx.send(Grant::Closed);
                tokens.push(w.token);
            }
            for w in guard.overflow.drain(..) {
                let _ = w.grant_tx.send(Grant::Closed);
                tokens.push(w.token);
            }
            tokens
        };
        for token in tokens {
            token.cancel(CancelReason::Shutdown);
        }
    }
}

/// RAII guard for an acquired running worker slot on one lane.
pub(crate) struct RunningSlotGuard {
    scheduler: LaneScheduler,
}

impl RunningSlotGuard {
    pub(crate) fn new(scheduler: LaneScheduler) -> Self {
        Self { scheduler }
    }
}

impl Drop for RunningSlotGuard {
    fn drop(&mut self) {
        self.scheduler.release_running_slot();
    }
}
