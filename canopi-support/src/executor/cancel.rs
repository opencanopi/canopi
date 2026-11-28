//! Cooperative cancellation token with reason and one-shot interrupt hooks (ADR 0025, contracts §3).

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

/// Why a [`CancelToken`] was cancelled (ADR 0025, contracts §3).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CancelReason {
    /// Explicit user cancellation (e.g. `cancel(operation)` or item deletion).
    User,
    /// Replaced by a newer request sharing the same `OpSpec::supersede_key`.
    Superseded,
    /// Executor drain / application shutdown.
    Shutdown,
}

impl CancelReason {
    /// Stable lowercase identifier for structured logs.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Superseded => "superseded",
            Self::Shutdown => "shutdown",
        }
    }
}

type CancelHook = Box<dyn FnOnce() + Send + 'static>;

struct CancelInner {
    reason: Option<CancelReason>,
    hooks: Vec<CancelHook>,
}

struct CancelState {
    cancelled: AtomicBool,
    inner: Mutex<CancelInner>,
    notify: Notify,
}

/// Clonable cancellation handle passed to executor work and interrupt hooks.
#[derive(Clone)]
pub struct CancelToken {
    state: Arc<CancelState>,
}

impl Default for CancelToken {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for CancelToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CancelToken")
            .field("cancelled", &self.is_cancelled())
            .field("reason", &self.reason())
            .finish()
    }
}

impl CancelToken {
    /// Creates an active (uncancelled) token.
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: Arc::new(CancelState {
                cancelled: AtomicBool::new(false),
                inner: Mutex::new(CancelInner {
                    reason: None,
                    hooks: Vec::new(),
                }),
                notify: Notify::new(),
            }),
        }
    }

    /// Lock-free check whether this token has been cancelled.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::Acquire)
    }

    /// Returns the first [`CancelReason`] that cancelled this token, if any.
    #[must_use]
    pub fn reason(&self) -> Option<CancelReason> {
        if !self.is_cancelled() {
            return None;
        }
        let guard = self
            .state
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.reason
    }

    /// Convenience check for blocking loops: returns `Err(reason)` once cancelled.
    pub fn check(&self) -> Result<(), CancelReason> {
        if let Some(reason) = self.reason() {
            return Err(reason);
        }
        Ok(())
    }

    /// Cancels this token with `reason` if not already cancelled, firing all registered
    /// `on_cancel` hooks once outside the lock. Returns `true` if this call transitioned
    /// the token from active to cancelled.
    pub fn cancel(&self, reason: CancelReason) -> bool {
        let hooks = {
            let mut guard = self
                .state
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if guard.reason.is_some() {
                return false;
            }
            guard.reason = Some(reason);
            self.state.cancelled.store(true, Ordering::Release);
            std::mem::take(&mut guard.hooks)
        };
        for hook in hooks {
            hook();
        }
        self.state.notify.notify_waiters();
        true
    }

    /// Registers an interrupt hook (e.g. a SQLite `InterruptHandle`) that runs once
    /// when the token is cancelled. If the token is already cancelled, `hook` runs
    /// immediately on the calling thread.
    pub fn on_cancel<F>(&self, hook: F)
    where
        F: FnOnce() + Send + 'static,
    {
        let immediate = {
            let mut guard = self
                .state
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if guard.reason.is_some() {
                Some(hook)
            } else {
                guard.hooks.push(Box::new(hook));
                None
            }
        };
        if let Some(hook) = immediate {
            hook();
        }
    }

    /// Resolves with the [`CancelReason`] once this token is cancelled.
    pub async fn cancelled(&self) -> CancelReason {
        loop {
            let notified = self.state.notify.notified();
            if let Some(reason) = self.reason() {
                return reason;
            }
            notified.await;
        }
    }

    /// Pointer-identity equality for internal supersession cleanup.
    pub(crate) fn ptr_eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.state, &other.state)
    }
}

#[cfg(test)]
mod tests {
    use super::{CancelReason, CancelToken};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn first_reason_wins_and_hooks_run_once() {
        let token = CancelToken::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let c1 = Arc::clone(&calls);
        token.on_cancel(move || {
            c1.fetch_add(1, Ordering::SeqCst);
        });

        assert!(!token.is_cancelled());
        assert!(token.cancel(CancelReason::Superseded));
        assert!(!token.cancel(CancelReason::User));
        assert_eq!(token.reason(), Some(CancelReason::Superseded));
        assert_eq!(token.check(), Err(CancelReason::Superseded));
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let c2 = Arc::clone(&calls);
        token.on_cancel(move || {
            c2.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
