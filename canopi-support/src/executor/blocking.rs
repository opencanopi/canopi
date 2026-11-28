//! The single private blocking-pool entry point for Canopi (ADR 0023, ADR 0025).
//!
//! Every native blocking closure reaches the Tokio blocking pool and panic containment
//! here; no other module in the workspace calls `spawn_blocking` or `catch_unwind`.

use std::panic::{AssertUnwindSafe, catch_unwind};
use tokio::runtime::Handle;

/// Result of running a blocking closure on the executor's pool.
pub enum BlockingOutcome<T> {
    /// Closure returned normally.
    Completed(T),
    /// Closure panicked; the panic was contained and not resumed.
    Panicked,
    /// Blocking task failed to join (runtime shutdown or abort).
    JoinFailed,
}

/// Runs `work` on `handle`'s blocking pool with panic containment and tracing dispatch
/// propagation, invoking `on_settle` on the blocking thread right after `work` finishes or
/// unwinds so permits/slots and settlement logs complete even if the caller drops the future.
async fn spawn_with_settle<T, R, F, S>(handle: &Handle, work: F, on_settle: S) -> Option<R>
where
    T: Send + 'static,
    R: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
    S: FnOnce(BlockingOutcome<T>) -> R + Send + 'static,
{
    let dispatch = tracing::dispatcher::get_default(Clone::clone);
    let task = move || {
        tracing::dispatcher::with_default(&dispatch, || {
            #[expect(
                clippy::disallowed_methods,
                reason = "the executor settlement turns a native operation's panic into its error"
            )]
            let outcome = match catch_unwind(AssertUnwindSafe(work)) {
                Ok(value) => BlockingOutcome::Completed(value),
                Err(_panic) => BlockingOutcome::Panicked,
            };
            on_settle(outcome)
        })
    };
    #[expect(
        clippy::disallowed_methods,
        reason = "the executor owns the blocking pool; every native operation reaches it here"
    )]
    handle.spawn_blocking(task).await.ok()
}

/// Runs `work` on `handle`'s blocking pool with panic containment and tracing dispatch
/// propagation, keeping `guard` alive on the blocking thread until `work` finishes or unwinds.
pub(crate) async fn run_with_guard<T, G, F>(
    handle: &Handle,
    guard: G,
    work: F,
) -> BlockingOutcome<T>
where
    T: Send + 'static,
    G: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    spawn_with_settle(handle, work, move |outcome| {
        drop(guard);
        outcome
    })
    .await
    .unwrap_or(BlockingOutcome::JoinFailed)
}

/// Interim bridge for `canopi-desktop::native_operation::NativeOperationExecutor` until
/// N1-3/N1-4 moves all command callers onto typed facade `OpSpec`s. Keeps `spawn_blocking`
/// and `catch_unwind` exclusively in this module.
#[doc(hidden)]
pub async fn run_legacy_blocking<T, R, F, S>(handle: &Handle, work: F, on_settle: S) -> Option<R>
where
    T: Send + 'static,
    R: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
    S: FnOnce(BlockingOutcome<T>) -> R + Send + 'static,
{
    spawn_with_settle(handle, work, on_settle).await
}
