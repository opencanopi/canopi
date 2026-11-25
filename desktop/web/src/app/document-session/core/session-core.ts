/**
 * Owner of the unified Session Core state machine and document-transition outcome unions
 * (`no-cancelled-literal`, ADR 0024, ADR 0025; contracts §4, 2b-3).
 * Invariant: one DesignSessionState, one DesignScope per open Design, and one unified Undo order.
 */
import { batch, computed, signal } from '@preact/signals'
import type { SceneCommand } from '../../../canvas/runtime/scene-commands'
import type { LifecycleEvent } from '../../../platform/app-lifecycle'
import { homeKey, type DesignHome, type DesignSource } from '../../../platform/design-home'
import type { DesignScope } from '../../../types/design-scope'
import { mintDraftId } from '../../../utils/ids'
import { createSessionEdits } from './edits'
import { readDesignSource, sameHome } from './helpers'
import { createSessionHistory } from './history'
import { deepFreezeDev } from './immutable'
import { composeForWrite, extractSceneFields, type ScenePort } from './scene-half'
import { flushSettingsWithRetry, runSaveAs } from './session-ops'
import {
  createDesignScope, isDesignDirty, type DesignSessionState, type ManagedDesignScope,
  type OpenDesignState, type QuestionChoice, type QuestionId, type QuestionKind,
  type QuestionPurpose, type SaveState,
} from './state'
import type {
  DecodedDesignPayload, OpenResult, SessionCore, SessionCoreCodec, SessionCoreDeps,
} from './types'
import { createSessionWriteLane } from './write-lane'

export type {
  DecodedDesignPayload, ScenePort, SessionCore, SessionCoreCodec, SessionCoreDeps,
}

export function createSessionCore(deps: SessionCoreDeps): SessionCore {
  const flushDelayMs = deps.flushDelayMs ?? 1_500
  let activeScope: ManagedDesignScope | null = deps.initialDesign ? createDesignScope() : null
  const initialState: DesignSessionState = deps.initialDesign
    ? (() => {
        const frozenFile = deepFreezeDev(deps.initialDesign.file)
        return {
          kind: 'open',
          design: {
            scope: activeScope!,
            home: deps.initialDesign.home,
            document: frozenFile,
            baseline: frozenFile,
            rev: 0,
            ackRev: 0,
            save: { kind: 'idle' },
            scene: { kind: 'detached', fields: extractSceneFields(frozenFile) },
            migratedFrom: deps.initialDesign.migratedFrom ?? null,
            readOnly: Boolean(deps.initialDesign.readOnly),
            savedByVersion: deps.initialDesign.savedByVersion ?? null,
          },
        }
      })()
    : { kind: 'idle' }
  const stateSignal = signal<DesignSessionState>(initialState)
  const historyTick = signal(0)
  const pendingWriteSignal = signal(false)
  const history = createSessionHistory()

  let attachedPort: ScenePort | null = null
  let writeTimer: ReturnType<typeof setTimeout> | null = null
  let openSequence = 0
  let questionSequence = 1
  let pendingQuestion: { readonly id: QuestionId; readonly resolve: (choice: QuestionChoice) => void } | null = null
  const openedListeners = new Set<(scope: DesignScope, design: OpenDesignState) => void>()

  const notifyPendingWrite = (pending: boolean): void => {
    pendingWriteSignal.value = pending
    deps.onPendingWriteChange?.(pending)
  }

  const getCurrentDesign = (): OpenDesignState | null => {
    const s = stateSignal.peek()
    if (s.kind === 'open') return s.design
    if (s.kind === 'opening' || s.kind === 'closing') return s.current ?? null
    if (s.kind === 'replacing') return s.current
    return null
  }

  const updateCurrentDesign = (updater: (design: OpenDesignState) => OpenDesignState): void => {
    const s = stateSignal.peek()
    if (s.kind === 'open') stateSignal.value = { kind: 'open', design: updater(s.design) }
    else if (s.kind === 'opening' && s.current) stateSignal.value = { ...s, current: updater(s.current) }
    else if (s.kind === 'replacing') stateSignal.value = { ...s, current: updater(s.current) }
    else if (s.kind === 'closing' && s.current) stateSignal.value = { ...s, current: updater(s.current) }
  }

  const setSaveState = (save: SaveState): void => {
    updateCurrentDesign((design) => ({ ...design, save }))
  }

  const clearWriteTimer = (): void => {
    if (writeTimer !== null) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
  }

  const writeLane = createSessionWriteLane({
    designHome: deps.designHome,
    codec: deps.codec,
    isDisposed: () => stateSignal.peek().kind === 'disposed',
    getDesign: getCurrentDesign,
    composeForWrite,
    updateDesign: updateCurrentDesign,
    scheduleRetry: () => scheduleWrite(),
    onPendingWriteChange: notifyPendingWrite,
  })

  const scheduleWrite = (): void => {
    clearWriteTimer()
    const design = getCurrentDesign()
    if (!design || design.readOnly || !isDesignDirty(design) || stateSignal.peek().kind === 'disposed') return
    if (writeLane.inFlight) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      void flushNow()
    }, flushDelayMs)
  }

  const flushNow = async (options?: { readonly force?: boolean }): Promise<boolean> => {
    clearWriteTimer()
    return writeLane.run(options?.force ? { forceWrite: true } : undefined)
  }

  const replayScene = (command: SceneCommand, direction: 'undo' | 'redo'): void => {
    attachedPort?.replay(command, direction)
  }

  const edits = createSessionEdits({
    history,
    getDesign: getCurrentDesign,
    updateDesign: updateCurrentDesign,
    bumpHistoryTick: () => { historyTick.value += 1 },
    notifyPendingWrite,
    scheduleWrite,
    replayScene,
  })

  const askQuestion = (
    kind: QuestionKind,
    purpose: QuestionPurpose,
    setStateWithQuestion: (q: { readonly id: QuestionId; readonly kind: QuestionKind; readonly purpose: QuestionPurpose }) => void,
  ): Promise<QuestionChoice> => {
    cancelPendingQuestion()
    const id = `q-${questionSequence++}` as QuestionId
    setStateWithQuestion({ id, kind, purpose })
    return new Promise<QuestionChoice>((resolve) => {
      pendingQuestion = { id, resolve }
    })
  }

  const flushOrAskBeforeTransition = async (
    purpose: QuestionPurpose,
    nextSource?: DesignSource,
  ): Promise<'proceed' | 'discarded' | 'cancelled'> => {
    while (true) {
      const current = getCurrentDesign()
      if (!current || current.readOnly || !isDesignDirty(current)) return 'proceed'
      if (await flushNow()) continue
      if (stateSignal.peek().kind === 'disposed') return 'cancelled'
      const curAfter = getCurrentDesign()
      if (!curAfter) return 'proceed'
      const qKind: QuestionKind = purpose === 'open' ? 'flush-failed-before-open' : 'flush-failed-before-close'
      const choice = await askQuestion(qKind, purpose, (question) => {
        stateSignal.value = nextSource
          ? { kind: 'replacing', current: curAfter, next: nextSource, question }
          : { kind: 'closing', current: curAfter, question }
      })
      if (choice === 'cancel') {
        if (stateSignal.peek().kind !== 'opening' && getCurrentDesign()) {
          stateSignal.value = { kind: 'open', design: getCurrentDesign()! }
        }
        return 'cancelled'
      }
      if (choice === 'discard') {
        if (writeLane.inFlight) await writeLane.inFlight
        return 'discarded'
      }
    }
  }

  const installOpenDesign = async (
    home: DesignHome,
    decoded: DecodedDesignPayload,
  ): Promise<{ readonly ok: true; readonly design: OpenDesignState } | { readonly ok: false; readonly reason: string }> => {
    const frozenFile = deepFreezeDev(decoded.file)
    const sceneFields = extractSceneFields(frozenFile)
    const prevScope = activeScope
    const prevState = stateSignal.peek()
    const previous = getCurrentDesign()
    const prevComposed = previous ? composeForWrite(previous) : null
    const nextScope = createDesignScope()

    const design: OpenDesignState = {
      scope: nextScope,
      home,
      document: frozenFile,
      baseline: frozenFile,
      rev: 0,
      ackRev: 0,
      save: { kind: 'idle' },
      scene: attachedPort
        ? { kind: 'attached', port: attachedPort, fields: sceneFields }
        : { kind: 'detached', fields: sceneFields },
      migratedFrom: decoded.migratedFrom ?? null,
      readOnly: Boolean(decoded.readOnly),
      savedByVersion: decoded.savedByVersion ?? null,
    }

    // Batch state publish with Scene load so reactive effects never observe nextScope paired with the prior Scene (B6).
    let loadFailure: string | null = null
    batch(() => {
      stateSignal.value = { kind: 'open', design }
      if (!attachedPort) return
      try {
        attachedPort.load(frozenFile)
      } catch (error) {
        loadFailure = error instanceof Error ? error.message : 'scene_load_failed'
        stateSignal.value = prevState
        if (prevComposed) {
          try { attachedPort.load(prevComposed) } catch { /* Best-effort restore after refused load. */ }
        }
      }
    })
    if (loadFailure !== null) return { ok: false, reason: loadFailure }

    activeScope = nextScope
    history.clear()
    historyTick.value += 1
    prevScope?.dispose()
    notifyPendingWrite(false)
    if (!design.readOnly) await deps.settings.writeLastOpenHome(home)
    for (const listener of openedListeners) listener(nextScope, design)
    return { ok: true, design }
  }

  const cancelPendingQuestion = (): void => {
    if (!pendingQuestion) return
    const q = pendingQuestion
    pendingQuestion = null
    q.resolve('cancel')
  }

  const isSuperseded = (seq: number): boolean => seq !== openSequence || stateSignal.peek().kind === 'disposed'

  const openFrom = async (source: DesignSource): Promise<OpenResult> => {
    if (stateSignal.peek().kind === 'disposed') return { status: 'cancelled' }

    const current = getCurrentDesign()
    if (current && sameHome(current.home, source)) {
      // Cancel any in-flight open for another Design before returning already-open (M4 live catch).
      openSequence += 1
      cancelPendingQuestion()
      if (stateSignal.peek().kind !== 'open') stateSignal.value = { kind: 'open', design: current }
      if (isDesignDirty(current)) await flushNow()
      return { status: 'already-open', home: current.home }
    }

    const seq = ++openSequence
    cancelPendingQuestion()
    stateSignal.value = { kind: 'opening', source, ...(current ? { current } : {}) }
    const restoreCurrent = (): void => {
      const live = getCurrentDesign()
      stateSignal.value = live ? { kind: 'open', design: live } : { kind: 'idle' }
    }

    const fetched = await readDesignSource(deps.designHome, source)
    if (isSuperseded(seq)) return { status: 'cancelled' }
    if (!fetched.ok) {
      restoreCurrent()
      return { status: 'refused', reason: fetched.reason, error: fetched.error }
    }

    let decoded: DecodedDesignPayload
    try {
      decoded = await deps.codec.decode(fetched.bytes)
    } catch (error) {
      if (isSuperseded(seq)) return { status: 'cancelled' }
      restoreCurrent()
      return { status: 'refused', reason: error instanceof Error ? error.message : 'decode_failed', error }
    }

    if (isSuperseded(seq)) return { status: 'cancelled' }
    if ((await flushOrAskBeforeTransition('open', source)) === 'cancelled' || isSuperseded(seq)) {
      return { status: 'cancelled' }
    }
    if (writeLane.inFlight) {
      await writeLane.inFlight
      if (isSuperseded(seq)) return { status: 'cancelled' }
    }

    const installed = await installOpenDesign(fetched.home, decoded)
    if (!installed.ok) {
      restoreCurrent()
      return { status: 'refused', reason: installed.reason }
    }
    return { status: 'opened', home: installed.design.home }
  }

  const createNew = async (): Promise<OpenResult> => {
    if (stateSignal.peek().kind === 'disposed') return { status: 'cancelled' }
    const seq = ++openSequence
    cancelPendingQuestion()
    if ((await flushOrAskBeforeTransition('open')) === 'cancelled' || isSuperseded(seq)) {
      return { status: 'cancelled' }
    }
    const base = await deps.newDesignFactory()
    if (isSuperseded(seq)) return { status: 'cancelled' }
    if (isDesignDirty(getCurrentDesign()) && ((await flushOrAskBeforeTransition('open')) === 'cancelled' || isSuperseded(seq))) {
      return { status: 'cancelled' }
    }
    if (writeLane.inFlight) {
      await writeLane.inFlight
      if (isSuperseded(seq)) return { status: 'cancelled' }
    }
    const file = deps.settings.applyNewDesignDefaults ? deps.settings.applyNewDesignDefaults(base) : base
    const home: DesignHome = { kind: 'draft', key: mintDraftId(), version: null }
    const installed = await installOpenDesign(home, { file })
    if (!installed.ok) return { status: 'refused', reason: installed.reason }
    return { status: 'opened', home: installed.design.home }
  }

  const bestEffortFlushSettings = async (): Promise<void> => {
    if (!deps.settings.flushSettings) return
    try {
      await deps.settings.flushSettings()
    } catch {
      // Best-effort flush when blurring/hiding or after settings flush already succeeded (N3).
    }
  }

  const teardownOpenDesign = async (purpose: QuestionPurpose): Promise<void> => {
    if (purpose === 'close') {
      await deps.settings.writeLastOpenHome(null)
      await bestEffortFlushSettings()
    }
    clearWriteTimer()
    const prevScope = activeScope
    activeScope = null
    history.clear()
    historyTick.value += 1
    stateSignal.value = { kind: 'idle' }
    prevScope?.dispose()
    notifyPendingWrite(false)
    if (purpose === 'quit') await deps.lifecycle.destroyWindow?.()
  }

  const close = async (purpose: QuestionPurpose = 'close'): Promise<'closed' | 'cancelled'> => {
    openSequence += 1
    cancelPendingQuestion()
    const hadOpenDesign = getCurrentDesign() !== null
    let flushOutcome: 'proceed' | 'discarded' | 'cancelled' = 'proceed'
    if (hadOpenDesign) {
      flushOutcome = await flushOrAskBeforeTransition(purpose)
      if (flushOutcome === 'cancelled') return 'cancelled'
    }

    const revBeforeSettingsFlush = getCurrentDesign()?.rev ?? 0
    const flushedSettings = await flushSettingsWithRetry({
      flushSettings: deps.settings.flushSettings,
      purpose,
      designSaved: hadOpenDesign && flushOutcome !== 'discarded',
      getCurrentDesign,
      setState: (next) => { stateSignal.value = next },
      askQuestion,
    })
    if (!flushedSettings) return 'cancelled'
    if (!hadOpenDesign) {
      if (purpose === 'close') await deps.settings.writeLastOpenHome(null)
      stateSignal.value = { kind: 'idle' }
      if (purpose === 'quit') await deps.lifecycle.destroyWindow?.()
      return 'closed'
    }
    if ((getCurrentDesign()?.rev ?? 0) > revBeforeSettingsFlush && (await flushOrAskBeforeTransition(purpose)) === 'cancelled') {
      return 'cancelled'
    }

    // Update flushes Design and settings without closing the Design so a cancelled or failed install keeps it open (N5).
    if (purpose === 'update') {
      const live = getCurrentDesign()
      if (live) stateSignal.value = { kind: 'open', design: live }
      return 'closed'
    }

    await teardownOpenDesign(purpose)
    return 'closed'
  }

  const saveAs = async (): Promise<'saved' | 'cancelled' | 'conflict' | 'failed'> => {
    const outcome = await runSaveAs({
      deps,
      getCurrentDesign,
      updateCurrentDesign,
      setSaveState,
      composeForWrite,
      clearWriteTimer,
      runExclusive: writeLane.runExclusive,
      notifyPendingWrite,
      scheduleWrite,
    })
    return outcome === 'aborted' ? 'cancelled' : outcome
  }

  const resolveConflict = async (choice: 'keep-mine' | 'save-as' | 'use-file'): Promise<'resolved' | 'cancelled' | 'failed'> => {
    const design = getCurrentDesign()
    if (!design || design.save.kind !== 'conflict') return 'failed'
    if (choice === 'save-as') {
      const outcome = await saveAs()
      return outcome === 'saved' ? 'resolved' : outcome === 'cancelled' ? 'cancelled' : 'failed'
    }
    if (choice === 'use-file') {
      const fresh = await deps.designHome.read(design.home.key)
      if (fresh.kind !== 'present') return 'failed'
      let decoded: DecodedDesignPayload
      try {
        decoded = await deps.codec.decode(new Uint8Array(fresh.bytes))
      } catch {
        // Unreadable file on disk during conflict resolution; keep conflict active.
        return 'failed'
      }
      const installed = await installOpenDesign({ ...design.home, version: fresh.version }, decoded)
      return installed.ok ? 'resolved' : 'failed'
    }
    const ok = await writeLane.run({ useOverrideExpected: true, overrideExpected: design.save.current })
    return ok ? 'resolved' : 'failed'
  }

  const revert = async (): Promise<'reverted' | 'unavailable' | 'failed'> => {
    const design = getCurrentDesign()
    if (!design || design.readOnly || design.rev === 0) return 'unavailable'
    const baseline = design.baseline
    const baselineSceneFields = extractSceneFields(baseline)
    try {
      if (attachedPort) attachedPort.load(baseline)
    } catch {
      // Scene port rejected the baseline file; leave current design untouched and report failure.
      return 'failed'
    }
    history.clear()
    historyTick.value += 1
    updateCurrentDesign((cur) => ({
      ...cur,
      document: baseline,
      rev: cur.rev + 1,
      save: { kind: 'pending' },
      scene: cur.scene.kind === 'attached'
        ? { kind: 'attached', port: cur.scene.port, fields: baselineSceneFields }
        : { kind: 'detached', fields: baselineSceneFields },
    }))
    notifyPendingWrite(true)
    scheduleWrite()
    return 'reverted'
  }

  const handleLifecycle = async (event: LifecycleEvent): Promise<void> => {
    if (stateSignal.peek().kind === 'disposed') return
    if (event.kind === 'focus-lost' || event.kind === 'hidden') {
      if (isDesignDirty(getCurrentDesign())) await flushNow()
      await bestEffortFlushSettings()
      return
    }
    if (event.kind === 'close-requested') {
      const work = (async () => {
        try {
          await close('quit')
        } catch (error) {
          // Unexpected failure during close workflow: keep the window open so dirty edits are never silently lost (base close-guard.ts).
          deps.onNotice?.({ kind: 'close-failed', detail: error instanceof Error ? error.message : 'close_failed' })
        }
      })()
      event.done?.(work)
      await work
      return
    }
    if (event.kind === 'release-waiting' || event.kind === 'store-version-change') {
      deps.onNotice?.({ kind: event.kind })
    }
  }

  const unsubscribeLifecycle = deps.lifecycle.subscribe((event) => {
    void handleLifecycle(event)
  })

  const currentDesign = computed(() => {
    const s = stateSignal.value
    if (s.kind === 'open') return s.design
    if (s.kind === 'opening' || s.kind === 'closing') return s.current ?? null
    if (s.kind === 'replacing') return s.current
    return null
  })

  return {
    state: stateSignal,
    currentDesign,
    dirty: computed(() => isDesignDirty(currentDesign.value)),
    revertAvailable: computed(() => {
      const d = currentDesign.value
      return d !== null && !d.readOnly && d.rev > 0
    }),
    pendingWrite: computed(() => pendingWriteSignal.value),
    canUndo: computed(() => { void historyTick.value; return history.canUndo }),
    canRedo: computed(() => { void historyTick.value; return history.canRedo }),
    newestUndoable: computed(() => { void historyTick.value; return history.newestUndoable }),
    snapshot() {
      const design = getCurrentDesign()
      return design ? composeForWrite(design) : null
    },
    openFrom,
    createNew,
    close,
    flushNow,
    saveAs,
    resolveConflict,
    saveWithoutCopy: () => writeLane.run({ omitKeepPrevious: true }),
    revert,
    ...edits,
    attachScene(port) {
      const design = getCurrentDesign()
      if (!design) {
        attachedPort = port
        return 'no-design'
      }
      const composed = composeForWrite(design)
      port.load(composed)
      attachedPort = port
      updateCurrentDesign((cur) => ({ ...cur, scene: { kind: 'attached', port, fields: cur.scene.fields } }))
      return 'attached'
    },
    detachScene() {
      const port = attachedPort
      if (!port) return
      attachedPort = null
      const fields = deepFreezeDev(port.serialize())
      history.dropSceneEntries()
      historyTick.value += 1
      updateCurrentDesign((cur) => ({ ...cur, scene: { kind: 'detached', fields } }))
    },
    onDesignOpened(listener) {
      openedListeners.add(listener)
      const design = getCurrentDesign()
      if (design && activeScope && !activeScope.closed) listener(activeScope, design)
      return () => { openedListeners.delete(listener) }
    },
    answer(id, choice) {
      if (!pendingQuestion || pendingQuestion.id !== id) return 'stale'
      const current = pendingQuestion
      pendingQuestion = null
      current.resolve(choice)
      return 'answered'
    },
    async listDrafts() {
      const drafts = await deps.designHome.listDrafts()
      return [...drafts].sort((a, b) =>
        a.updatedAt !== b.updatedAt ? b.updatedAt.localeCompare(a.updatedAt) : a.id.localeCompare(b.id),
      )
    },
    async deleteDraft(id) {
      const current = getCurrentDesign()
      if (current && homeKey(current.home) === homeKey({ kind: 'draft', key: id })) {
        return { ok: false, reason: 'open-design-draft' }
      }
      const res = await deps.designHome.deleteDraft(id)
      return res.ok ? { ok: true } : { ok: false, reason: 'delete-failed' }
    },
    handleLifecycle,
    dispose() {
      clearWriteTimer()
      openSequence += 1
      if (pendingQuestion) {
        const q = pendingQuestion
        pendingQuestion = null
        q.resolve('cancel')
      }
      unsubscribeLifecycle()
      attachedPort = null
      stateSignal.value = { kind: 'disposed' }
      activeScope?.dispose()
      activeScope = null
      history.clear()
      historyTick.value += 1
      pendingWriteSignal.value = false
    },
  }
}
