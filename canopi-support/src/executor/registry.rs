//! In-flight request registry and supersession tracking for [`super::Executor`].

use std::collections::HashMap;
use std::sync::Mutex;

use canopi_types::failure::OperationId;
use tokio::time::Instant;

use super::cancel::{CancelReason, CancelToken};
use super::lanes::{ExecutorLane, OpSpec};

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

struct RegistryState {
    active: HashMap<u64, ActiveRequest>,
    by_supersede: HashMap<&'static str, CancelToken>,
}

pub(super) struct RequestRegistry {
    state: Mutex<RegistryState>,
}

impl RequestRegistry {
    pub(super) fn new() -> Self {
        Self {
            state: Mutex::new(RegistryState {
                active: HashMap::new(),
                by_supersede: HashMap::new(),
            }),
        }
    }

    pub(super) fn register(
        &self,
        id: u64,
        spec: OpSpec,
        operation: Option<OperationId>,
        enqueued_at: Instant,
        token: &CancelToken,
    ) {
        let previous = {
            let mut reg = self
                .state
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

    pub(super) fn unregister(&self, id: u64) {
        let mut reg = self
            .state
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

    pub(super) fn cancel_operation(&self, operation: &OperationId) -> usize {
        let tokens: Vec<CancelToken> = {
            let guard = self
                .state
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

    pub(super) fn cancel_all_shutdown(&self) {
        let tokens: Vec<CancelToken> = {
            let guard = self
                .state
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

    pub(super) fn snapshot(&self) -> Vec<InFlightEntry> {
        let guard = self
            .state
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
}
