import { batch, computed, signal, type ReadonlySignal, type Signal } from '@preact/signals'
import type { CanopiFile } from '../../types/design'
import { registerDesignEditAuthorityCapability } from '../design-edit/authority-capability'
import {
  registerDesignSessionPersistenceCapability,
  type DesignSessionPersistenceCapture,
} from './persistence-capability'

export interface DesignSessionIdentity {
  readonly file: CanopiFile | null
  readonly path: string | null
  readonly name: string
}

export interface DesignSessionStore {
  readonly sessionIdentity: ReadonlySignal<object>
  readonly currentDesign: ReadonlySignal<CanopiFile | null>
  readonly designPath: ReadonlySignal<string | null>
  readonly designName: ReadonlySignal<string>
  readonly designDirty: ReadonlySignal<boolean>
  readonly canvasDirty: ReadonlySignal<boolean>
  readonly committedDesignRevision: ReadonlySignal<number>
  /** Counts Scene history reports; a committed canvas change advances it. */
  readonly canvasChangeRevision: ReadonlySignal<number>

  readIdentity(): DesignSessionIdentity
  readCurrentDesign(): CanopiFile | null
  readDesignPath(): string | null
  readDesignName(): string
  hasCurrentDesign(): boolean
  isDesignDirty(): boolean
  isCanvasDirty(): boolean

  replaceCurrentDesignState(file: CanopiFile, path: string | null, name: string): void
  replaceCurrentDesignSnapshot(file: CanopiFile): void
  /** End the session: no current Design, clean baselines, a new session identity. */
  clearCurrentDesign(): void
  renameCurrentDesign(name: string): boolean

  resetDirtyBaselines(): void
  markCanvasDetachedDirty(dirty: boolean): void
  setCanvasClean(clean: boolean): void

  readPendingDesignPath(): string | null
  setPendingDesignPath(path: string | null): void
}

declare const persistenceCapableDesignSessionStoreBrand: unique symbol

export interface PersistenceCapableDesignSessionStore extends DesignSessionStore {
  readonly [persistenceCapableDesignSessionStoreBrand]: true
}

interface DesignSessionStoreSignals {
  readonly currentDesign: Signal<CanopiFile | null>
  readonly designPath: Signal<string | null>
  readonly designName: Signal<string>
  readonly nonCanvasRevision: Signal<number>
  readonly nonCanvasSavedRevision: Signal<number>
  readonly persistenceDiverged: Signal<boolean>
  readonly canvasClean: Signal<boolean>
  readonly detachedCanvasDirty: Signal<boolean>
  readonly pendingDesignPath: Signal<string | null>
  readonly canvasDirty: ReadonlySignal<boolean>
  readonly designDirty: ReadonlySignal<boolean>
}

interface DesignSessionStoreTestState extends Partial<DesignSessionIdentity> {
  readonly nonCanvasRevision?: number
  readonly nonCanvasSavedRevision?: number
  readonly persistenceDiverged?: boolean
  readonly canvasClean?: boolean
  readonly detachedCanvasDirty?: boolean
  readonly pendingDesignPath?: string | null
}

/** @testonly */
export interface DesignSessionStoreTestFixture {
  readonly nonCanvasRevision: ReadonlySignal<number>
  readonly nonCanvasSavedRevision: ReadonlySignal<number>
  readonly persistenceDiverged: ReadonlySignal<boolean>
  readonly canvasClean: ReadonlySignal<boolean>
  readonly detachedCanvasDirty: ReadonlySignal<boolean>
  readonly pendingDesignPath: ReadonlySignal<string | null>
  reset(initial?: DesignSessionStoreTestState): void
  setState(state: DesignSessionStoreTestState): void
  markSaved(): void
}

const testFixtures = new WeakMap<object, DesignSessionStoreTestFixture>()

export function createDesignSessionStore(
  initial: Partial<DesignSessionIdentity> = {},
): PersistenceCapableDesignSessionStore {
  const currentDesign = signal<CanopiFile | null>(initial.file ?? null)
  const designPath = signal<string | null>(initial.path ?? null)
  const designName = signal<string>(initial.name ?? initial.file?.name ?? 'Untitled')
  const nonCanvasRevision = signal(0)
  const nonCanvasSavedRevision = signal(0)
  const persistenceDiverged = signal(false)
  const canvasChangeRevision = signal(0)
  const canvasClean = signal(true)
  const detachedCanvasDirty = signal(false)
  const pendingDesignPath = signal<string | null>(null)
  const canvasDirty = computed(() => detachedCanvasDirty.value || !canvasClean.value)
  const designDirty = computed(() =>
    canvasDirty.value
    || nonCanvasRevision.value !== nonCanvasSavedRevision.value
    || persistenceDiverged.value
  )
  const signals: DesignSessionStoreSignals = {
    currentDesign,
    designPath,
    designName,
    nonCanvasRevision,
    nonCanvasSavedRevision,
    persistenceDiverged,
    canvasClean,
    detachedCanvasDirty,
    pendingDesignPath,
    canvasDirty,
    designDirty,
  }

  const sessionIdentity = signal<object>(Object.freeze({}))
  let lifetime = Object.freeze({})
  let sessionGeneration = 0
  let detachedCanvasRevision = 0
  let committedContentRevision = 0
  let acknowledgementGeneration = 0
  const committedDesignRevision = signal(0)

  function applyCommittedDesign(
    updater: (design: CanopiFile) => CanopiFile,
    markDirty: boolean,
  ): CanopiFile | null {
    const current = signals.currentDesign.peek()
    if (!current) return null

    const next = updater(current)
    if (next === current) return current

    committedContentRevision += 1
    batch(() => {
      signals.currentDesign.value = next
      committedDesignRevision.value += 1
      if (markDirty) {
        signals.nonCanvasRevision.value += 1
      }
    })
    return next
  }

  function rolloverDesignEditAuthority(): void {
    sessionGeneration += 1
  }

  const store = {
    sessionIdentity,
    currentDesign: signals.currentDesign,
    designPath: signals.designPath,
    designName: signals.designName,
    designDirty: signals.designDirty,
    canvasDirty: signals.canvasDirty,
    committedDesignRevision,
    canvasChangeRevision,

    readIdentity() {
      return {
        file: signals.currentDesign.value,
        path: signals.designPath.value,
        name: signals.designName.value,
      }
    },

    readCurrentDesign() {
      return signals.currentDesign.value
    },

    readDesignPath() {
      return signals.designPath.value
    },

    readDesignName() {
      return signals.designName.value
    },

    hasCurrentDesign() {
      return signals.currentDesign.value !== null
    },

    isDesignDirty() {
      return signals.designDirty.value
    },

    isCanvasDirty() {
      return signals.canvasDirty.value
    },

    replaceCurrentDesignState(file, path, name) {
      sessionGeneration += 1
      detachedCanvasRevision = 0
      committedContentRevision += 1
      batch(() => {
        sessionIdentity.value = Object.freeze({})
        signals.currentDesign.value = file
        committedDesignRevision.value += 1
        signals.persistenceDiverged.value = false
        signals.designPath.value = path
        signals.designName.value = name
      })
    },

    clearCurrentDesign() {
      sessionGeneration += 1
      detachedCanvasRevision = 0
      committedContentRevision += 1
      batch(() => {
        sessionIdentity.value = Object.freeze({})
        signals.currentDesign.value = null
        committedDesignRevision.value += 1
        signals.designPath.value = null
        signals.designName.value = 'Untitled'
        signals.canvasClean.value = true
        signals.detachedCanvasDirty.value = false
        signals.nonCanvasRevision.value = 0
        signals.nonCanvasSavedRevision.value = 0
        signals.persistenceDiverged.value = false
      })
    },

    replaceCurrentDesignSnapshot(file) {
      detachedCanvasRevision += 1
      committedContentRevision += 1
      batch(() => {
        signals.currentDesign.value = file
        committedDesignRevision.value += 1
      })
    },

    renameCurrentDesign(name) {
      const design = signals.currentDesign.peek()
      if (!design || name === signals.designName.value) return false
      const next = { ...design, name }
      committedContentRevision += 1
      batch(() => {
        signals.currentDesign.value = next
        committedDesignRevision.value += 1
        signals.designName.value = name
        signals.nonCanvasRevision.value += 1
      })
      return true
    },

    resetDirtyBaselines() {
      batch(() => {
        signals.canvasClean.value = true
        signals.detachedCanvasDirty.value = false
        signals.nonCanvasRevision.value = 0
        signals.nonCanvasSavedRevision.value = 0
        signals.persistenceDiverged.value = false
      })
    },

    markCanvasDetachedDirty(dirty) {
      signals.detachedCanvasDirty.value = dirty
    },

    setCanvasClean(clean) {
      batch(() => {
        signals.canvasClean.value = clean
        canvasChangeRevision.value += 1
      })
    },

    readPendingDesignPath() {
      return signals.pendingDesignPath.value
    },

    setPendingDesignPath(path) {
      signals.pendingDesignPath.value = path
    },
  } as PersistenceCapableDesignSessionStore

  registerDesignEditAuthorityCapability(
    store,
    {
      editCommitted: (projector) => applyCommittedDesign(projector, true),
      reconcileCommitted: (projector) => applyCommittedDesign(projector, false),
      markCommittedDirty: () => {
        signals.nonCanvasRevision.value += 1
      },
    },
    rolloverDesignEditAuthority,
  )

  registerDesignSessionPersistenceCapability(store, () => {
    const capturedLifetime = lifetime
    const file = signals.currentDesign.peek()
    const generation = sessionGeneration
    const canvasRevision = detachedCanvasRevision
    const contentRevision = committedContentRevision
    const nonCanvasRevision = signals.nonCanvasRevision.value
    const persistenceDiverged = signals.persistenceDiverged.value
    // A guard captured while dirty may survive the exact Save that cleans it;
    // a guard captured clean must become stale if an older write later diverges.
    const divergenceBaselineIsCurrent = () =>
      persistenceDiverged || !signals.persistenceDiverged.value
    const capture: DesignSessionPersistenceCapture = {
      file: file ? cloneDocument(file) : null,
      path: signals.designPath.value,
      name: signals.designName.value,
      isCurrent: () => capturedLifetime === lifetime
        && generation === sessionGeneration
        && canvasRevision === detachedCanvasRevision,
      isExactCurrent: () => capturedLifetime === lifetime
        && generation === sessionGeneration
        && canvasRevision === detachedCanvasRevision
        && contentRevision === committedContentRevision
        && nonCanvasRevision === signals.nonCanvasRevision.value
        && divergenceBaselineIsCurrent(),
      acknowledgeSaved(options = {}) {
        if (
          capturedLifetime !== lifetime
          || generation !== sessionGeneration
          || canvasRevision !== detachedCanvasRevision
        ) return 'stale'
        const acknowledgement = ++acknowledgementGeneration
        batch(() => {
          if (options.canvasAcknowledged || options.canvasDetached) {
            signals.detachedCanvasDirty.value = false
          }
          if (options.canvasDetached) signals.canvasClean.value = true
          signals.nonCanvasSavedRevision.value = nonCanvasRevision
          signals.persistenceDiverged.value = contentRevision !== committedContentRevision
        })
        if (
          acknowledgement === acknowledgementGeneration
          && capturedLifetime === lifetime
          && generation === sessionGeneration
          && canvasRevision === detachedCanvasRevision
          && contentRevision !== committedContentRevision
        ) {
          signals.persistenceDiverged.value = true
        }
        return 'applied'
      },
      updatePath(path) {
        if (
          capturedLifetime !== lifetime
          || generation !== sessionGeneration
          || canvasRevision !== detachedCanvasRevision
        ) return false
        signals.designPath.value = path
        return true
      },
    }
    return Object.freeze(capture)
  })

  const fixture = Object.freeze({
    nonCanvasRevision: signals.nonCanvasRevision,
    nonCanvasSavedRevision: signals.nonCanvasSavedRevision,
    persistenceDiverged: signals.persistenceDiverged,
    canvasClean: signals.canvasClean,
    detachedCanvasDirty: signals.detachedCanvasDirty,
    pendingDesignPath: signals.pendingDesignPath,
    reset(state: DesignSessionStoreTestState = {}) {
      lifetime = Object.freeze({})
      sessionGeneration = 0
      detachedCanvasRevision = 0
      committedContentRevision = 0
      acknowledgementGeneration = 0
      batch(() => {
        sessionIdentity.value = Object.freeze({})
        signals.currentDesign.value = state.file ?? null
        signals.designPath.value = state.path ?? null
        signals.designName.value = state.name ?? state.file?.name ?? 'Untitled'
        signals.nonCanvasRevision.value = state.nonCanvasRevision ?? 0
        signals.nonCanvasSavedRevision.value = state.nonCanvasSavedRevision ?? 0
        signals.persistenceDiverged.value = state.persistenceDiverged ?? false
        signals.canvasClean.value = state.canvasClean ?? true
        signals.detachedCanvasDirty.value = state.detachedCanvasDirty ?? false
        signals.pendingDesignPath.value = state.pendingDesignPath ?? null
        committedDesignRevision.value = 0
      })
    },
    setState(state: DesignSessionStoreTestState) {
      const has = (property: keyof DesignSessionStoreTestState) =>
        Object.prototype.hasOwnProperty.call(state, property)
      if (has('file')) {
        sessionGeneration += 1
        detachedCanvasRevision = 0
        committedContentRevision += 1
      }
      batch(() => {
        if (has('file')) {
          sessionIdentity.value = Object.freeze({})
          signals.currentDesign.value = state.file ?? null
          committedDesignRevision.value += 1
        }
        if (has('path')) signals.designPath.value = state.path ?? null
        if (has('name')) signals.designName.value = state.name ?? 'Untitled'
        if (has('nonCanvasRevision')) {
          signals.nonCanvasRevision.value = state.nonCanvasRevision ?? 0
        }
        if (has('nonCanvasSavedRevision')) {
          signals.nonCanvasSavedRevision.value = state.nonCanvasSavedRevision ?? 0
        }
        if (has('persistenceDiverged')) {
          signals.persistenceDiverged.value = state.persistenceDiverged ?? false
        }
        if (has('canvasClean')) signals.canvasClean.value = state.canvasClean ?? true
        if (has('detachedCanvasDirty')) {
          signals.detachedCanvasDirty.value = state.detachedCanvasDirty ?? false
        }
        if (has('pendingDesignPath')) {
          signals.pendingDesignPath.value = state.pendingDesignPath ?? null
        }
      })
    },
    markSaved() {
      acknowledgementGeneration += 1
      batch(() => {
        signals.detachedCanvasDirty.value = false
        signals.canvasClean.value = true
        signals.nonCanvasSavedRevision.value = signals.nonCanvasRevision.value
        signals.persistenceDiverged.value = false
      })
    },
  } satisfies DesignSessionStoreTestFixture)
  testFixtures.set(store, fixture)

  return store
}

/** @testonly */
export function createDesignSessionStoreTestFixture(
  store: PersistenceCapableDesignSessionStore,
): DesignSessionStoreTestFixture {
  const fixture = testFixtures.get(store)
  if (!fixture) throw new Error('Design Session store has no test fixture capability')
  return fixture
}

export const designSessionStore: PersistenceCapableDesignSessionStore = createDesignSessionStore()

export const currentDesign = designSessionStore.currentDesign
export const designPath = designSessionStore.designPath
export const designName = designSessionStore.designName
export const setCanvasClean = (clean: boolean) => designSessionStore.setCanvasClean(clean)
export const setPendingDesignPath = (path: string | null) =>
  designSessionStore.setPendingDesignPath(path)

function cloneDocument(file: CanopiFile): CanopiFile {
  return JSON.parse(JSON.stringify(file)) as CanopiFile
}
