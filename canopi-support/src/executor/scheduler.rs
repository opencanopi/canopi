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

struct LaneInner {
    lane: ExecutorLane,
    workers: usize,
    queue_bound: usize,
    running: usize,
    closed: bool,
    interactive: VecDeque<QueuedWaiter>,
    background: VecDeque<QueuedWaiter>,
    overflow_interactive: VecDeque<QueuedWaiter>,
    overflow_background: VecDeque<QueuedWaiter>,
}

impl LaneInner {
    fn queued_len(&self) -> usize {
        self.interactive.len() + self.background.len()
    }

    fn total_waiting_len(&self) -> usize {
        self.queued_len() + self.overflow_interactive.len() + self.overflow_background.len()
    }

    fn promote_overflow_into_queue(&mut self) {
        while self.queued_len() < self.queue_bound {
            if let Some(waiter) = self.overflow_interactive.pop_front() {
                if !waiter.token.is_cancelled() && !waiter.grant_tx.is_closed() {
                    self.interactive.push_back(waiter);
                }
                continue;
            }
            if let Some(waiter) = self.overflow_background.pop_front() {
                if !waiter.token.is_cancelled() && !waiter.grant_tx.is_closed() {
                    self.background.push_back(waiter);
                }
                continue;
            }
            break;
        }
    }

    fn pop_next_live_waiter(&mut self) -> Option<oneshot::Sender<Grant>> {
        for queue in [
            &mut self.interactive,
            &mut self.background,
            &mut self.overflow_interactive,
            &mut self.overflow_background,
        ] {
            while let Some(w) = queue.pop_front() {
                if !w.token.is_cancelled() && !w.grant_tx.is_closed() {
                    return Some(w.grant_tx);
                }
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
                overflow_interactive: VecDeque::new(),
                overflow_background: VecDeque::new(),
            })),
        }
    }

    pub(crate) fn waiting_len(&self) -> usize {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.total_waiting_len()
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
        let waiter = QueuedWaiter {
            id,
            token: token.clone(),
            grant_tx,
        };
        match priority {
            Priority::Interactive => guard.overflow_interactive.push_back(waiter),
            Priority::Background => guard.overflow_background.push_back(waiter),
        }
        AdmitOutcome::Overflow(grant_rx)
    }

    pub(crate) fn remove_waiter(&self, id: u64) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.interactive.retain(|w| w.id != id);
        guard.background.retain(|w| w.id != id);
        guard.overflow_interactive.retain(|w| w.id != id);
        guard.overflow_background.retain(|w| w.id != id);
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
            let inner = &mut *guard;
            inner.closed = true;
            let mut tokens = Vec::new();
            for queue in [
                &mut inner.interactive,
                &mut inner.background,
                &mut inner.overflow_interactive,
                &mut inner.overflow_background,
            ] {
                for w in queue.drain(..) {
                    let _ = w.grant_tx.send(Grant::Closed);
                    tokens.push(w.token);
                }
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
