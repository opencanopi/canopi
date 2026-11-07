import { reportMapError } from '../../maplibre/map-errors'
import { mapBackgroundPresentationsEqual } from '../../maplibre/map-background'
import type {
  WorkspaceActivationOutcome,
  WorkspaceActivationSnapshot,
} from './workspace-activation'

/** The lifecycle roles the app uses without exposing coordinator internals. */
export interface WorkspaceGenerationLifecycle {
  requestGenerationDisconnect(): Promise<void>
  activate(snapshot: WorkspaceActivationSnapshot): Promise<WorkspaceActivationOutcome>
  teardown(): Promise<void>
  /** Accepts a user Retry of an unavailable map (WorkspaceActivationCoordinator.retry). */
  retry(): boolean
}

export interface WorkspaceGenerationReconcilerOptions {
  /** Reads the current Design-owned workspace input after Scene settlement. */
  readonly readSnapshot: () => WorkspaceActivationSnapshot | null
  readonly workspace: WorkspaceGenerationLifecycle
  readonly onFailure?: (error: unknown) => void
}

const replacementTicketBrand = Symbol('workspace-generation-replacement-ticket')

/** Opaque proof that the caller still owns one synchronous replacement attempt. */
export interface WorkspaceGenerationReplacementTicket {
  readonly [replacementTicketBrand]: number
}

/**
 * Keeps MapLibre generations aligned with synchronous Canvas replacement.
 *
 * It deliberately does not await replacement cleanup before activation: the
 * coordinator owns that join. This prevents a replacement callback from
 * becoming a promise back-edge into its owning lifecycle.
 */
export class WorkspaceGenerationReconciler {
  private replacementGeneration = 0
  private currentReplacement: WorkspaceGenerationReplacementTicket | null = null
  private queuedReplacement: WorkspaceGenerationReplacementTicket | null = null
  private activation: ReconciliationActivation | null = null
  private reconciledSnapshot: WorkspaceActivationSnapshot | null = null
  private replacementSuspended = false
  private disposed = false
  private teardown: Promise<void> | null = null

  constructor(private readonly options: WorkspaceGenerationReconcilerOptions) {}

  /** Reconciles the current Design when the app-owned workspace starts. */
  async reconcileInitialGeneration(): Promise<WorkspaceActivationOutcome | 'no-design'> {
    if (this.disposed) return 'cancelled'
    let snapshot: WorkspaceActivationSnapshot | null
    try {
      snapshot = this.options.readSnapshot()
    } catch (error) {
      this.reportFailure(error)
      return 'cancelled'
    }
    if (this.disposed) return 'cancelled'
    if (!snapshot) {
      this.reconciledSnapshot = null
      return 'no-design'
    }
    const activation: ReconciliationActivation = { ticket: null, snapshot }
    this.activation = activation
    try {
      const outcome = await this.options.workspace.activate(snapshot)
      if (!this.isCurrentActivation(activation)) return 'cancelled'
      this.activation = null
      if (outcome !== 'cancelled') this.reconciledSnapshot = snapshot
      return outcome
    } catch (error) {
      if (!this.isCurrentActivation(activation)) return 'cancelled'
      this.activation = null
      this.reportFailure(error)
      return 'cancelled'
    }
  }

  /**
   * The user's Retry after the map became unavailable: when the workspace accepts it, the current Design
   * is activated again. Refused, and false, with no Design, while an activation or a replacement is under
   * way, or when the workspace refuses.
   */
  retry(): boolean {
    if (this.disposed || this.activation || this.replacementSuspended) return false
    let snapshot: WorkspaceActivationSnapshot | null
    try {
      snapshot = this.options.readSnapshot()
    } catch (error) {
      this.reportFailure(error)
      return false
    }
    if (!snapshot || !this.options.workspace.retry()) return false
    const activation: ReconciliationActivation = { ticket: this.currentReplacement, snapshot }
    this.activation = activation
    this.observeActivation(activation)
    return true
  }

  /** Synchronously fences the old generation before Canvas replacement begins. */
  suspendForDocumentReplacement(): WorkspaceGenerationReplacementTicket | null {
    if (this.disposed) return null
    const ticket = Object.freeze({
      [replacementTicketBrand]: ++this.replacementGeneration,
    })
    this.currentReplacement = ticket
    this.replacementSuspended = true
    // The coordinator owns terminal observation of this unawaited cleanup.
    // Activation later joins it through the coordinator lifecycle.
    this.options.workspace.requestGenerationDisconnect()
    return ticket
  }

  /**
   * Schedules one post-stack read of the authoritative Design snapshot.
   * Calling this after a successor replacement has already begun is a no-op.
   */
  reconcileAfterDocumentReplacement(ticket: WorkspaceGenerationReplacementTicket | null): void {
    if (this.disposed || ticket == null || ticket !== this.currentReplacement) return
    if (this.queuedReplacement === ticket) return
    this.queuedReplacement = ticket
    queueMicrotask(() => this.reconcileQueuedReplacement(ticket))
  }

  /** Stops queued reconciliation and joins terminal cleanup through the coordinator. */
  dispose(): Promise<void> {
    if (this.teardown) return this.teardown
    this.disposed = true
    this.replacementGeneration += 1
    this.currentReplacement = null
    this.queuedReplacement = null
    this.activation = null
    let teardown: Promise<void>
    try {
      teardown = this.options.workspace.teardown()
    } catch (error) {
      teardown = Promise.reject(error)
    }
    this.teardown = teardown
    this.observeTerminalTeardown(teardown)
    return teardown
  }

  private reconcileQueuedReplacement(ticket: WorkspaceGenerationReplacementTicket): void {
    if (this.queuedReplacement === ticket) this.queuedReplacement = null
    if (this.disposed || ticket !== this.currentReplacement) return

    // This is intentionally the first read. Synchronous Scene replacement can
    // publish a successor before this stack unwinds.
    let snapshot: WorkspaceActivationSnapshot | null
    try {
      snapshot = this.options.readSnapshot()
    } catch (error) {
      this.reportFailure(error)
      return
    }
    if (this.disposed || ticket !== this.currentReplacement) return
    if (!snapshot) {
      this.replacementSuspended = false
      this.reconciledSnapshot = null
      return
    }
    if (!this.replacementSuspended && this.matchesCurrentSnapshot(snapshot)) return

    this.replacementSuspended = false
    const activation: ReconciliationActivation = { ticket, snapshot }
    this.activation = activation
    this.observeActivation(activation)
  }

  private matchesCurrentSnapshot(snapshot: WorkspaceActivationSnapshot): boolean {
    return snapshotsEqual(this.reconciledSnapshot, snapshot)
      || snapshotsEqual(this.activation?.snapshot ?? null, snapshot)
  }

  private observeActivation(activation: ReconciliationActivation): void {
    let result: Promise<WorkspaceActivationOutcome>
    try {
      result = this.options.workspace.activate(activation.snapshot)
    } catch (error) {
      this.handleActivationFailure(activation, error)
      return
    }
    void result.then(
      (outcome) => {
        if (!this.isCurrentActivation(activation)) return
        this.activation = null
        if (outcome !== 'cancelled') this.reconciledSnapshot = activation.snapshot
      },
      (error: unknown) => this.handleActivationFailure(activation, error),
    )
  }

  private handleActivationFailure(activation: ReconciliationActivation, error: unknown): void {
    if (!this.isCurrentActivation(activation)) return
    this.activation = null
    this.reportFailure(error)
  }

  private isCurrentActivation(activation: ReconciliationActivation): boolean {
    return !this.disposed
      && (
        activation.ticket == null
          ? this.currentReplacement == null
          : activation.ticket === this.currentReplacement
      )
      && this.activation === activation
  }

  private reportFailure(error: unknown): void {
    try {
      if (this.options.onFailure) this.options.onFailure(error)
      else reportMapError('Shared workspace activation failed:', error)
    } catch (observerError) {
      reportMapError('Shared workspace failure observer failed:', observerError)
    }
  }

  private observeTerminalTeardown(result: Promise<void>): void {
    void result.catch((error) => {
      reportMapError('Shared workspace teardown failed:', error)
    })
  }
}

interface ReconciliationActivation {
  readonly ticket: WorkspaceGenerationReplacementTicket | null
  readonly snapshot: WorkspaceActivationSnapshot
}

function snapshotsEqual(
  left: WorkspaceActivationSnapshot | null,
  right: WorkspaceActivationSnapshot,
): boolean {
  if (!left || left.sessionIdentity !== right.sessionIdentity) return false
  return mapBackgroundPresentationsEqual(left.map.background, right.map.background)
}
