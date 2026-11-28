//! Structured settlement records and logging for the native executor (ADR 0025 Logs).

use std::sync::Arc;
use std::time::Duration;

use canopi_types::failure::{Failure, FailureCode, OperationId};
use tokio::time::Instant;

use super::blocking::BlockingOutcome;
use super::lanes::{ExecutorLane, OpSpec};
use crate::time::duration_millis;

/// Final outcome category of one settled executor request (ADR 0025 Logs).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettlementKind {
    /// Work returned `Ok(_)`.
    Ok,
    /// Work returned `Err(Failure)`.
    Error,
    /// Request did not start before its deadline.
    Busy,
    /// Request was cancelled before or during execution.
    Cancelled,
    /// Work panicked (contained by `blocking::spawn_with_settle`).
    Panicked,
    /// Blocking task could not be joined.
    JoinFailed,
    /// Executor was closed before the request could start.
    Unavailable,
}

impl SettlementKind {
    /// Stable lowercase identifier for structured logs.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Error => "error",
            Self::Busy => "busy",
            Self::Cancelled => "cancelled",
            Self::Panicked => "panicked",
            Self::JoinFailed => "join_failed",
            Self::Unavailable => "unavailable",
        }
    }
}

/// Structured settlement record emitted once per executor request (ADR 0025 Logs).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementEvent {
    /// Operation constant from [`OpSpec::op`].
    pub op: &'static str,
    /// Caller's [`OperationId`], if provided.
    pub operation: Option<OperationId>,
    /// Lane the request ran on.
    pub lane: ExecutorLane,
    /// Terminal settlement kind.
    pub settlement: SettlementKind,
    /// Wire failure code kind when settled with a failure, if any.
    pub code: Option<&'static str>,
    /// Milliseconds spent waiting in queue before start (or until pre-start settlement).
    pub queued_ms: u64,
    /// Milliseconds spent running on the blocking pool (`0` if settled before start).
    pub running_ms: u64,
    /// `true` when `running` exceeded `OpSpec::slow_budget`.
    pub slow: bool,
    /// `true` when a `Busy` settlement occurred while waiting on a full queue.
    pub queue_full: bool,
}

/// Optional observer called synchronously once per settled request.
pub type SettlementObserver = Arc<dyn Fn(&SettlementEvent) + Send + Sync>;

#[derive(Clone, Copy)]
pub(super) struct SettlementTiming {
    pub(super) queued_ms: u64,
    pub(super) running: Duration,
    pub(super) queue_full: bool,
}

pub(super) fn finish_outcome<T>(
    observer: Option<&SettlementObserver>,
    spec: OpSpec,
    operation: Option<OperationId>,
    outcome: BlockingOutcome<Result<T, Failure>>,
    timing: SettlementTiming,
) -> Result<T, Failure> {
    match outcome {
        BlockingOutcome::Completed(Ok(value)) => {
            emit_settlement(observer, spec, operation, SettlementKind::Ok, None, timing);
            Ok(value)
        }
        BlockingOutcome::Completed(Err(mut failure)) => {
            if failure.operation.is_none() {
                failure.operation = operation.clone();
            }
            let kind = if matches!(failure.code, FailureCode::Cancelled) {
                SettlementKind::Cancelled
            } else {
                SettlementKind::Error
            };
            emit_settlement(
                observer,
                spec,
                operation,
                kind,
                Some(failure.code.row().kind),
                timing,
            );
            Err(failure)
        }
        BlockingOutcome::Panicked => Err(settle_error(
            observer,
            spec,
            operation,
            SettlementKind::Panicked,
            FailureCode::Panicked,
            timing,
        )),
    }
}

pub(super) fn settle_pre_start(
    observer: Option<&SettlementObserver>,
    spec: OpSpec,
    operation: Option<OperationId>,
    enqueued_at: Instant,
    settlement: SettlementKind,
    code: FailureCode,
    queue_full: bool,
) -> Failure {
    let timing = SettlementTiming {
        queued_ms: duration_millis(enqueued_at.elapsed()),
        running: Duration::ZERO,
        queue_full,
    };
    settle_error(observer, spec, operation, settlement, code, timing)
}

pub(super) fn settle_error(
    observer: Option<&SettlementObserver>,
    spec: OpSpec,
    operation: Option<OperationId>,
    settlement: SettlementKind,
    code: FailureCode,
    timing: SettlementTiming,
) -> Failure {
    let code_kind = code.row().kind;
    let mut failure = Failure::new(code, spec.op);
    if let Some(op_id) = operation.clone() {
        failure = failure.with_operation(op_id);
    }
    emit_settlement(
        observer,
        spec,
        operation,
        settlement,
        Some(code_kind),
        timing,
    );
    failure
}

fn emit_settlement(
    observer: Option<&SettlementObserver>,
    spec: OpSpec,
    operation: Option<OperationId>,
    settlement: SettlementKind,
    code: Option<&'static str>,
    timing: SettlementTiming,
) {
    let slow = timing.running > spec.slow_budget;
    let event = SettlementEvent {
        op: spec.op,
        operation,
        lane: spec.lane,
        settlement,
        code,
        queued_ms: timing.queued_ms,
        running_ms: duration_millis(timing.running),
        slow,
        queue_full: timing.queue_full,
    };
    let op_str = event.operation.as_ref().map_or("", OperationId::as_str);
    match event.settlement {
        SettlementKind::Ok if !event.slow => {
            tracing::debug!(
                op = event.op,
                operation = op_str,
                lane = event.lane.as_str(),
                settlement = event.settlement.as_str(),
                code = event.code.unwrap_or(""),
                queued_ms = event.queued_ms,
                running_ms = event.running_ms,
                slow = event.slow,
                "Native operation settled",
            );
        }
        // `tracing-warn-only-in-failure-logger` (2.1-M415) restricts `tracing::warn!` to
        // `desktop/src/logging.rs` until the logging stream moves the failure logger here.
        _ => {
            tracing::info!(
                op = event.op,
                operation = op_str,
                lane = event.lane.as_str(),
                settlement = event.settlement.as_str(),
                code = event.code.unwrap_or(""),
                queued_ms = event.queued_ms,
                running_ms = event.running_ms,
                slow = event.slow,
                queue_full = event.queue_full,
                "Native operation settled",
            );
        }
    }
    if let Some(obs) = observer {
        obs(&event);
    }
}
