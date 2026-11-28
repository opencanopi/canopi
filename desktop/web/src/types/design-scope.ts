/**
 * types/design-scope.ts: L0 registration interface for a Design's lifetime scope
 * (ADR 0024, contracts §4, 2b-3).
 *
 * Only the Session core (`app/document-session/core/`) opens and disposes a DesignScope.
 * Modules register cleanups through `core.onDesignOpened(scope => ...)` instead of watching
 * `sessionIdentity`.
 */
export interface DesignScope {
  /** Aborted synchronously when the Design closes or is replaced. */
  readonly signal: AbortSignal
  /** True once disposal has begun or finished. */
  readonly closed: boolean
  /** Registers a cleanup callback run in LIFO order when the scope disposes. */
  onDispose(cleanup: () => void): () => void
}
