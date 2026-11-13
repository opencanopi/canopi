import { batch, computed, signal, type ReadonlySignal } from '@preact/signals'
import type { GeoPosition, SessionPlane } from '../../session-plane'

import type { CanopiFile } from '../../../types/design'
import { collectCanvasRuntimeErrors, throwCanvasRuntimeCleanupErrors } from '../cleanup'
import {
  CanvasAuthorityBusyError,
  CanvasDocumentReplacementNotAdmittedError,
  type CanvasDocumentReplacementToken,
} from '../runtime'
import type { SceneHistory } from '../scene-history'
import {
  type SceneDesignObjectTarget,
  type ScenePersistedState,
  type SceneStore,
} from '../scene'
import {
  applySceneCommandPersistedPatch,
  createScenePatchCommand,
  type SceneCommand,
  type SceneCommandPatch,
  type SceneCommandSnapshot,
} from '../scene-commands'

export interface SceneEditTransaction {
  mutate(edit: (draft: ScenePersistedState) => void): void
  setSelection(targets: Iterable<SceneDesignObjectTarget>): void
  commit(): boolean
  abort(): void
  readonly changed: boolean
}

export interface SceneEditRunOptions {
  readonly onCommitted?: () => void
}

export interface SceneEditCoordinator {
  run(type: string, edit: (tx: SceneEditTransaction) => void, options?: SceneEditRunOptions): boolean
  begin(type: string, options?: Pick<SceneEditRunOptions, 'onCommitted'>): SceneEditTransaction
}

export interface SceneCommandAdmission {
  readonly revision: ReadonlySignal<number>
  /** Runs `operation` when no Scene operation owns the Scene; otherwise returns `busyResult` and runs nothing. */
  runWhenSettled<T>(operation: () => T, busyResult: T): T
}

export interface SettledSceneReader {
  readonly revision: ReadonlySignal<number>
  readWhenSettled<T>(operation: () => T, busyResult: T): T
}

export interface SceneHistoryCommands {
  readonly canUndo: ReadonlySignal<boolean>
  readonly canRedo: ReadonlySignal<boolean>
  undo(): boolean
  redo(): boolean
}

type ScenePersistenceAcknowledgement = 'applied' | 'stale'

export interface ScenePersistenceCapture {
  readonly scene: Readonly<ScenePersistedState>
  readonly plane: SessionPlane
  isCurrent(): boolean
  acknowledgeSaved(): ScenePersistenceAcknowledgement
}

export interface ScenePersistenceAuthority {
  capturePersistence(): ScenePersistenceCapture
  disposePersistence(): void
}

export interface SceneDocumentAuthority {
  hydrate(file: CanopiFile): void
  replaceDocument(file: CanopiFile, stages: SceneDocumentReplacementStages): boolean
}

export interface SceneDocumentReplacementStages {
  readonly token: CanvasDocumentReplacementToken
  readonly prepare: () => void
  readonly finalizeReplacement?: () => void
}

type SceneRuntimeAuthority = SceneEditCoordinator
  & SceneCommandAdmission
  & SettledSceneReader
  & SceneHistoryCommands
  & ScenePersistenceAuthority
  & SceneDocumentAuthority

export class SceneEditBusyError extends CanvasAuthorityBusyError {
  constructor(activeType: string) {
    super(activeType, `Scene edit ${activeType} already owns the Scene`)
    this.name = 'SceneEditBusyError'
  }
}

interface SceneRuntimeEditCoordinatorOptions {
  sceneStore: SceneStore
  history: SceneHistory
  setSelection(targets: Iterable<SceneDesignObjectTarget>): void
  incrementSceneRevision(): void
  syncCanvasSignalsFromScene(): void
  invalidate(): void
  /** A read-only Design (2.1-M478): mutate changes nothing, a selection still applies, undo and redo refuse. */
  refusesEdits?(): boolean
}

/**
 * One Scene operation (an edit, an undo or redo, a hydration or replacement). Each runs its steps once (ADR 0018, spec
 * §1.4 "Admission"): on a throw an edit or replay restores what it must, releases the Scene and rethrows; a hydration or
 * replacement keeps the Scene until the next open or replace succeeds. Nothing resumes an operation.
 */
interface SceneAuthorityOperation {
  readonly type: string
}

export class SceneRuntimeEditCoordinator implements SceneRuntimeAuthority {
  private readonly _sceneStore: SceneStore
  private readonly _history: SceneHistory
  private readonly _setSelection: SceneRuntimeEditCoordinatorOptions['setSelection']
  private readonly _incrementSceneRevision: SceneRuntimeEditCoordinatorOptions['incrementSceneRevision']
  private readonly _syncCanvasSignalsFromScene: SceneRuntimeEditCoordinatorOptions['syncCanvasSignalsFromScene']
  private readonly _invalidate: SceneRuntimeEditCoordinatorOptions['invalidate']
  private readonly _refusesEdits: () => boolean
  private readonly _admissionRevision = signal(0)
  private _active: SceneAuthorityOperation | null = null
  private _replacementHandoff: {
    readonly predecessor: SceneRuntimeEditTransaction
    readonly successor: SceneHydrationSettlement
  } | null = null
  private _documentGeneration = 0
  private _persistenceEpoch = 0
  private _persistenceDisposed = false

  readonly revision: ReadonlySignal<number> = this._admissionRevision
  readonly canUndo = computed(() => {
    void this._admissionRevision.value
    return this._active === null && !this._refusesEdits() && this._history.canUndo.value
  })
  readonly canRedo = computed(() => {
    void this._admissionRevision.value
    return this._active === null && !this._refusesEdits() && this._history.canRedo.value
  })

  constructor(options: SceneRuntimeEditCoordinatorOptions) {
    this._sceneStore = options.sceneStore
    this._history = options.history
    this._setSelection = options.setSelection
    this._incrementSceneRevision = options.incrementSceneRevision
    this._syncCanvasSignalsFromScene = options.syncCanvasSignalsFromScene
    this._invalidate = options.invalidate
    this._refusesEdits = options.refusesEdits ?? (() => false)
  }

  runWhenSettled<T>(operation: () => T, busyResult: T): T {
    return this._active ? busyResult : operation()
  }

  readWhenSettled<T>(operation: () => T, busyResult: T): T {
    return this._active ? busyResult : operation()
  }

  run(
    type: string,
    edit: (tx: SceneEditTransaction) => void,
    options: SceneEditRunOptions = {},
  ): boolean {
    if (this._active) return false
    const tx = this._begin(type, options.onCommitted)
    try {
      edit(tx)
    } catch (error) {
      tx.fail(error)
    }
    return tx.commit()
  }

  begin(
    type: string,
    options: Pick<SceneEditRunOptions, 'onCommitted'> = {},
  ): SceneEditTransaction {
    return this._begin(type, options.onCommitted)
  }

  private _begin(type: string, onCommitted: () => void = () => {}): SceneRuntimeEditTransaction {
    if (this._active) throw new SceneEditBusyError(this._active.type)
    const transaction = new SceneRuntimeEditTransaction({
      type,
      sceneStore: this._sceneStore,
      captureSnapshot: () => this._captureSnapshot(),
      setSelection: this._setSelection,
      recordHistory: (command, accepted) => this._history.record(command, accepted),
      syncCanvasSignalsFromScene: this._syncCanvasSignalsFromScene,
      incrementSceneRevision: this._incrementSceneRevision,
      invalidate: this._invalidate,
      refusesContent: this._refusesEdits,
      onCommitted,
      restore: (snapshot) => this._restore(snapshot),
      release: (settled) => this._release(settled),
    })
    this._acquire(transaction)
    return transaction
  }

  undo(): boolean {
    return this._replay('undo')
  }

  redo(): boolean {
    return this._replay('redo')
  }

  /**
   * Rebuilds the session plane at `origin` while settled. The scene and every
   * undo command move through one reprojector, so stored lon/lat is unchanged
   * and nothing is dirtied or recorded; the camera follows through the plane
   * effect. When not settled it does nothing.
   */
  reoriginSessionPlane(origin: GeoPosition): void {
    if (
      this._persistenceDisposed
      || this._active
      || this._replacementHandoff
    ) return
    const reprojector = this._sceneStore.beginReorigin(origin)
    const reprojectPatch = (patch: SceneCommandPatch): SceneCommandPatch => patch.persisted
      ? { ...patch, persisted: reprojector.persisted(patch.persisted) }
      : patch
    batch(() => {
      this._history.remapCommands((command) => ({
        ...command,
        before: reprojectPatch(command.before),
        after: reprojectPatch(command.after),
      }))
      this._sceneStore.commitReorigin(reprojector)
      this._incrementSceneRevision()
      this._invalidate()
    })
  }

  capturePersistence(): ScenePersistenceCapture {
    if (this._persistenceDisposed) {
      throw new SceneEditBusyError('runtime-disposed')
    }
    if (this._replacementHandoff || this._active instanceof SceneHydrationSettlement) {
      throw new SceneEditBusyError(this._active?.type ?? 'document-replacement')
    }
    if (this._active && !(this._active instanceof SceneRuntimeEditTransaction)) {
      throw new SceneEditBusyError(this._active.type)
    }

    const scene = this._active instanceof SceneRuntimeEditTransaction
      && !this._active.historyAccepted
      ? this._active.captureCommittedPersistedState()
      : this._sceneStore.persisted
    const checkpoint = this._history.captureCheckpoint()
    const documentGeneration = this._documentGeneration
    const persistenceEpoch = this._persistenceEpoch
    let acknowledgement: ScenePersistenceAcknowledgement | null = null
    const captureIsCurrent = () => !this._persistenceDisposed
      && documentGeneration === this._documentGeneration
      && persistenceEpoch === this._persistenceEpoch
      && this._history.isCheckpointCurrent(checkpoint)

    return Object.freeze({
      scene,
      plane: this._sceneStore.sessionPlane,
      isCurrent: captureIsCurrent,
      acknowledgeSaved: (): ScenePersistenceAcknowledgement => {
        if (acknowledgement) return acknowledgement
        if (
          this._persistenceDisposed
          || documentGeneration !== this._documentGeneration
          || persistenceEpoch !== this._persistenceEpoch
        ) {
          acknowledgement = 'stale'
          return acknowledgement
        }
        const historyAcknowledgement = this._history.acknowledgeSaved(checkpoint)
        acknowledgement = historyAcknowledgement === 'stale'
          || this._persistenceDisposed
          || documentGeneration !== this._documentGeneration
          || persistenceEpoch !== this._persistenceEpoch
          ? 'stale'
          : 'applied'
        return acknowledgement
      },
    })
  }

  disposePersistence(): void {
    if (this._persistenceDisposed) return
    this._persistenceDisposed = true
    this._persistenceEpoch += 1
  }

  hydrate(file: CanopiFile): void {
    if (this._active && !isFailedSettlement(this._active)) throw new SceneEditBusyError(this._active.type)
    const ownedFile = cloneDocument(file)
    const hydration = new SceneHydrationSettlement({
      type: 'document-hydration',
      file: ownedFile,
      sceneStore: this._sceneStore,
      history: this._history,
      noteStoreHydrated: () => this._noteStoreHydrated(),
      syncCanvasSignalsFromScene: this._syncCanvasSignalsFromScene,
      invalidate: this._invalidate,
      incrementSceneRevision: this._incrementSceneRevision,
      release: (settled) => this._release(settled),
    })
    this._acquire(hydration)
    hydration.run()
  }

  replaceDocument(file: CanopiFile, stages: SceneDocumentReplacementStages): boolean {
    if (this._replacementHandoff) {
      throw new SceneEditBusyError(this._replacementHandoff.successor.type)
    }
    const predecessor = this._active
    // A failed open keeps the Scene through `prepare`; this replacement takes it over once admitted.
    const failedOpen = isFailedSettlement(predecessor) ? predecessor : null
    if (predecessor && !failedOpen && !(predecessor instanceof SceneRuntimeEditTransaction && predecessor.isOpen)) {
      throw new SceneEditBusyError(predecessor.type)
    }
    const ownedFile = cloneDocument(file)
    const replacement = new SceneHydrationSettlement({
      type: 'document-replacement',
      file: ownedFile,
      sceneStore: this._sceneStore,
      history: this._history,
      noteStoreHydrated: () => this._noteStoreHydrated(),
      syncCanvasSignalsFromScene: this._syncCanvasSignalsFromScene,
      invalidate: this._invalidate,
      incrementSceneRevision: this._incrementSceneRevision,
      finalizeReplacement: stages.finalizeReplacement,
      release: (settled) => this._release(settled),
    })

    // An open edit (a drag) hands the Scene to the replacement when `prepare` ends it.
    if (predecessor instanceof SceneRuntimeEditTransaction) {
      this._replacementHandoff = { predecessor, successor: replacement }
    } else if (!failedOpen) {
      this._acquire(replacement)
    }

    try {
      stages.prepare()
      if (failedOpen && this._active === failedOpen) this._acquire(replacement)
      if (this._active !== replacement) {
        throw new SceneEditBusyError(predecessor?.type ?? replacement.type)
      }
    } catch (error) {
      this._cancelReplacementBeforeHydration(replacement)
      if (error instanceof CanvasDocumentReplacementNotAdmittedError) throw error
      throw new CanvasDocumentReplacementNotAdmittedError(error)
    }
    replacement.run()
    return stages.finalizeReplacement !== undefined
  }

  private _captureSnapshot(): SceneCommandSnapshot {
    return {
      persisted: this._sceneStore.persisted,
      selectedTargets: this._sceneStore.session.selectedTargets,
    }
  }

  private _cancelReplacementBeforeHydration(replacement: SceneHydrationSettlement): void {
    if (this._replacementHandoff?.successor === replacement) {
      this._replacementHandoff = null
    }
    if (this._active === replacement) this._release(replacement)
  }

  private _restore(snapshot: SceneCommandSnapshot): void {
    const rollback = createScenePatchCommand(
      'scene-edit-abort',
      snapshot,
      this._captureSnapshot(),
    )
    if (!rollback) return
    this._applyPersisted(rollback.before)
    if (rollback.before.selection) this._setSelection(rollback.before.selection)
  }

  /** The patch's Scene content as one store update. */
  private _applyPersisted(patch: SceneCommandPatch): void {
    if (!patch.persisted) return
    this._sceneStore.updatePersisted((draft) => applySceneCommandPersistedPatch(draft, patch))
  }

  /**
   * Undo or redo: the cursor moves, then the patch's content is one store update (a throw there moves the cursor back
   * and changes nothing), then history's signals, the selection and the Scene publication run once each; a throw among
   * them keeps the step and is rethrown after the Scene is released.
   */
  private _replay(direction: 'undo' | 'redo'): boolean {
    if (this._active || this._refusesEdits()) return false
    const replay: SceneAuthorityOperation = { type: `scene-history-${direction}` }
    this._acquire(replay)
    const patchOf = (command: SceneCommand) => direction === 'undo' ? command.before : command.after
    const step: { patch?: SceneCommandPatch } = {}
    const apply = (command: SceneCommand) => {
      this._applyPersisted(patchOf(command))
      step.patch = patchOf(command)
    }
    const errors: unknown[] = []
    try {
      if (!(direction === 'undo' ? this._history.undo(apply) : this._history.redo(apply))) {
        this._release(replay)
        return false
      }
    } catch (error) {
      if (!step.patch) {
        this._release(replay)
        throw error
      }
      errors.push(error)
    }
    const selection = step.patch!.selection
    errors.push(...collectCanvasRuntimeErrors([
      ...selection ? [() => this._setSelection(selection)] : [],
      this._syncCanvasSignalsFromScene,
      this._incrementSceneRevision,
      () => this._invalidate(),
    ]))
    this._release(replay)
    throwCanvasRuntimeCleanupErrors(errors, `Scene history ${direction} failed to publish`)
    return true
  }

  private _noteStoreHydrated(): void {
    this._documentGeneration += 1
  }

  private _acquire(operation: SceneAuthorityOperation): void {
    this._active = operation
    this._publishAdmissionRevision()
  }

  private _release(operation: SceneAuthorityOperation): void {
    if (this._active !== operation) return
    const handoff = this._replacementHandoff
    if (handoff?.predecessor === operation) {
      this._replacementHandoff = null
      this._active = handoff.successor
    } else {
      this._active = null
    }
    this._publishAdmissionRevision()
  }

  private _publishAdmissionRevision(): void {
    try {
      this._admissionRevision.value += 1
    } catch {
      // Reactive consumers observe authority state; they must never own its lifecycle.
      // The signal value still advanced, so a later read sees the settled state.
    }
  }
}

interface SceneHydrationSettlementOptions {
  readonly type: 'document-hydration' | 'document-replacement'
  readonly file: CanopiFile
  readonly sceneStore: SceneStore
  readonly history: SceneHistory
  readonly noteStoreHydrated: () => void
  readonly syncCanvasSignalsFromScene: () => void
  readonly invalidate: () => void
  readonly incrementSceneRevision: () => void
  readonly finalizeReplacement?: () => void
  readonly release: (hydration: SceneHydrationSettlement) => void
}

/**
 * A hydration or replacement. Its steps run once, in order; a throw stops it, restores nothing and rethrows, and the
 * Scene stays closed to presses, edits and undo (the document surface `settling`) until the next open or replace
 * succeeds and takes it over; the document session's retry is a fresh replace.
 */
class SceneHydrationSettlement implements SceneAuthorityOperation {
  readonly type: SceneHydrationSettlementOptions['type']
  private readonly _options: SceneHydrationSettlementOptions
  /** A step threw: the settlement keeps the Scene until the next open or replace takes it over. */
  failed = false

  constructor(options: SceneHydrationSettlementOptions) {
    this._options = options
    this.type = options.type
  }

  run(): void {
    const options = this._options
    try {
      options.sceneStore.hydrate(options.file)
      options.noteStoreHydrated()
      options.history.clear()
      options.syncCanvasSignalsFromScene()
      options.invalidate()
      options.incrementSceneRevision()
      options.finalizeReplacement?.()
    } catch (error) {
      this.failed = true
      throw error
    }
    options.release(this)
  }
}

function isFailedSettlement(operation: SceneAuthorityOperation | null): operation is SceneHydrationSettlement {
  return operation instanceof SceneHydrationSettlement && operation.failed
}

interface SceneRuntimeEditTransactionOptions {
  type: string
  sceneStore: SceneStore
  captureSnapshot(): SceneCommandSnapshot
  setSelection(targets: Iterable<SceneDesignObjectTarget>): void
  recordHistory(command: SceneCommand, accepted: () => void): void
  syncCanvasSignalsFromScene(): void
  incrementSceneRevision(): void
  invalidate(): void
  refusesContent(): boolean
  onCommitted(): void
  restore(snapshot: SceneCommandSnapshot): void
  release(transaction: SceneRuntimeEditTransaction): void
}

/**
 * An edit. Commit and abort each run once: a throw before history accepts the command restores the before-state;
 * after acceptance each remaining publication step runs once. Either way the Scene is released and the error
 * rethrown. A commit or abort on a closed edit does nothing.
 */
class SceneRuntimeEditTransaction implements SceneEditTransaction {
  private readonly _type: string
  private readonly _sceneStore: SceneStore
  private readonly _before: SceneCommandSnapshot
  private readonly _options: SceneRuntimeEditTransactionOptions
  private _open = true
  private _historyAccepted = false
  private _committedChanged = false

  constructor(options: SceneRuntimeEditTransactionOptions) {
    this._type = options.type
    this._sceneStore = options.sceneStore
    this._options = options
    this._before = options.captureSnapshot()
  }

  get type(): string {
    return this._type
  }

  get changed(): boolean {
    if (!this._open) return this._committedChanged
    return this._createCommand() !== null
  }

  get isOpen(): boolean {
    return this._open
  }

  /** History holds this edit's command: a save during its publication writes the after-state. */
  get historyAccepted(): boolean {
    return this._historyAccepted
  }

  captureCommittedPersistedState(): Readonly<ScenePersistedState> {
    return this._before.persisted
  }

  mutate(edit: (draft: ScenePersistedState) => void): void {
    this._assertOpen()
    if (this._options.refusesContent()) return
    this._sceneStore.updatePersisted(edit)
  }

  setSelection(targets: Iterable<SceneDesignObjectTarget>): void {
    this._assertOpen()
    this._options.setSelection(targets)
  }

  commit(): boolean {
    if (!this._open) return this._committedChanged
    this._open = false
    const command = this._createCommand()
    if (!command) {
      this._options.release(this)
      return false
    }
    const errors: unknown[] = []
    try {
      this._options.recordHistory(command, () => { this._historyAccepted = true })
    } catch (error) {
      errors.push(error)
      if (!this._historyAccepted) this._undo(errors)
    }
    return this._publish(errors)
  }

  abort(): void {
    if (!this._open) return
    this._open = false
    this._undo([])
  }

  /** The edit callback of `run` threw: restore and rethrow it (an edit it already closed only rethrows). */
  fail(error: unknown): never {
    if (this._open) {
      this._open = false
      this._undo([error])
    }
    throw error
  }

  private _publish(errors: unknown[]): boolean {
    this._committedChanged = true
    errors.push(...collectCanvasRuntimeErrors([
      this._options.syncCanvasSignalsFromScene,
      this._options.incrementSceneRevision,
      this._options.invalidate,
      this._options.onCommitted,
    ]))
    this._options.release(this)
    throwCanvasRuntimeCleanupErrors(errors, `Scene edit ${this._type} failed to publish`)
    return true
  }

  /** Puts the Scene back as it was before the edit, releases it, and rethrows `errors` with any of its own. */
  private _undo(errors: unknown[]): void {
    errors.push(...collectCanvasRuntimeErrors([
      () => this._options.restore(this._before),
      this._options.syncCanvasSignalsFromScene,
    ]))
    this._options.release(this)
    throwCanvasRuntimeCleanupErrors(errors, `Scene edit ${this._type} failed and was undone`)
  }

  private _createCommand(): SceneCommand | null {
    return createScenePatchCommand(this._type, this._before, this._options.captureSnapshot())
  }

  private _assertOpen(): void {
    if (!this._open) throw new Error('Scene edit transaction is closed')
  }
}

function cloneDocument(file: CanopiFile): CanopiFile {
  return JSON.parse(JSON.stringify(file)) as CanopiFile
}
