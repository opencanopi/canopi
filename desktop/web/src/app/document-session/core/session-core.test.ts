/**
 * app/document-session/core/session-core.test.ts: Session suite covering contracts §4
 * across both Desktop and Web in-memory ports, FAT 0-byte crash remnant handling (#341/#400),
 * 2.1-M547 unified Document/Scene/Compound Undo & coalescing, and DesignScope lifecycle.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SceneCommand } from '../../../canvas/runtime/scene-commands'
import type { Failure } from '../../../generated/contracts'
import type { AppLifecyclePort, LifecycleEvent } from '../../../platform/app-lifecycle'
import {
  decodeLastOpenHome,
  EMPTY_SHA256,
  encodeLastOpenHome,
  type DesignHome,
  type DesignHomeStore,
  type DesignHomeWriteResult,
  type DraftId,
  type FileGrantId,
  type HomeRead,
  type HomeVersion,
  type LastOpenHome,
} from '../../../platform/design-home'
import type { FileAccessPort, PickFileOutcome } from '../../../platform/file-access'
import type { CanopiFile } from '../../../types/design'
import { presentDesignOpenFailure, registerDesignOpenFailurePresenter } from '../open-failure'
import { createSessionHistory } from './history'
import { createSessionCore, type ScenePort, type SessionCoreCodec, type SessionCoreDeps } from './session-core'
import { createDesignScope } from './state'

function makeDesign(name = 'Untitled'): CanopiFile {
  return {
    version: 9,
    name,
    description: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    plants: [],
    zones: [],
    layers: [],
    annotations: [],
    measurement_guides: [],
    groups: [],
  } as unknown as CanopiFile
}

function encodeText(file: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(file))
}

function versionFor(bytes: Uint8Array, edition: 'desktop' | 'web', seq: number): HomeVersion {
  if (bytes.byteLength === 0) return EMPTY_SHA256
  if (edition === 'web') return String(seq)
  let hash = 0
  for (const b of bytes) hash = ((hash * 31) + b) >>> 0
  return `sha-${hash.toString(16).padStart(8, '0')}`
}

function makeHarness(edition: 'desktop' | 'web') {
  const files = new Map<string, { bytes: Uint8Array; version: HomeVersion; updatedAt: string }>()
  let seq = 1
  let nextWriteOverride: ((key: string, bytes: Uint8Array, expected: HomeVersion | null, opts?: { readonly keepPrevious?: boolean }) => DesignHomeWriteResult | null) | null = null
  let nextPickTarget: PickFileOutcome = { kind: 'cancelled' }
  let lastOpenHome: DesignHome | null = null
  let storedLastOpen: LastOpenHome | null = null
  let settingsFlushShouldFail = false
  let pendingWrite = false
  const notices: Array<{ kind: string; detail?: string }> = []
  const lifecycleListeners = new Set<(e: LifecycleEvent) => void>()
  const destroyWindow = vi.fn()
  const deleteDraftCalls: DraftId[] = []
  let failDeleteDraft = false

  const designHome: DesignHomeStore = {
    async read(key: string): Promise<HomeRead> {
      const entry = files.get(key)
      if (!entry) return { kind: 'absent' }
      return { kind: 'present', bytes: Array.from(entry.bytes), version: entry.version }
    },
    async write(key, bytes, expected, opts): Promise<DesignHomeWriteResult> {
      if (nextWriteOverride) {
        const res = nextWriteOverride(key, bytes, expected, opts)
        if (res) return res
      }
      const existing = files.get(key)
      if (expected === null) {
        if (existing) return { kind: 'conflict', current: existing.version }
      } else if (!existing || existing.version !== expected) {
        return { kind: 'conflict', current: existing?.version ?? null }
      }
      const version = versionFor(bytes, edition, ++seq)
      files.set(key, { bytes: new Uint8Array(bytes), version, updatedAt: `2026-11-25T12:00:${String(seq).padStart(2, '0')}Z` })
      return { kind: 'written', version }
    },
    async listDrafts() {
      return [...files.entries()]
        .filter(([k]) => !k.startsWith('grant-'))
        .map(([id, entry]) => ({ id: id as DraftId, updatedAt: entry.updatedAt, bytes: entry.bytes }))
    },
    async deleteDraft(id) {
      deleteDraftCalls.push(id)
      if (failDeleteDraft) {
        return {
          ok: false,
          failure: {
            code: { kind: 'io', detail: 'other' },
            user_may_retry: true,
            op: 'draft.delete',
            operation: null,
            detail: null,
          } as unknown as Failure,
        }
      }
      files.delete(id)
      return { ok: true }
    },
    onVersionChange() {
      return () => {}
    },
  }

  const fileAccess: FileAccessPort = {
    async pickOpen() {
      return { kind: 'cancelled' }
    },
    async pickHomeTarget() {
      return nextPickTarget
    },
  }

  const lifecycle: AppLifecyclePort = {
    subscribe(listener) {
      lifecycleListeners.add(listener)
      return () => { lifecycleListeners.delete(listener) }
    },
    destroyWindow,
  }

  const codec: SessionCoreCodec = {
    async decode(bytes) {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as CanopiFile
      return { file: parsed, migratedFrom: parsed.version < 10 ? parsed.version : null }
    },
    async encode(file) {
      const bytes = encodeText(file)
      return { bytes, version: versionFor(bytes, edition, seq + 1) }
    },
  }

  const deps: SessionCoreDeps = {
    designHome,
    fileAccess,
    lifecycle,
    codec,
    settings: {
      async readLastOpenHome() { return storedLastOpen },
      async writeLastOpenHome(home) {
        lastOpenHome = home
        storedLastOpen = home
          ? (home.kind === 'draft' ? { kind: 'draft', id: home.key } : { kind: 'file', recent_id: home.key })
          : null
      },
      async flushSettings() {
        if (settingsFlushShouldFail) throw new Error('settings disk full')
      },
      applyNewDesignDefaults(file) {
        return { ...file, description: 'from-settings-defaults' }
      },
    },
    newDesignFactory: () => makeDesign('Untitled'),
    flushDelayMs: 10,
    onPendingWriteChange(p) { pendingWrite = p },
    onNotice(n) { notices.push(n) },
  }

  const core = createSessionCore(deps)
  return {
    core,
    files,
    notices,
    destroyWindow,
    deleteDraftCalls,
    getPendingWrite: () => pendingWrite,
    getLastOpenHome: () => lastOpenHome,
    setNextWriteOverride: (fn: typeof nextWriteOverride) => { nextWriteOverride = fn },
    setNextPickTarget: (outcome: PickFileOutcome) => { nextPickTarget = outcome },
    setSettingsFlushFail: (fail: boolean) => { settingsFlushShouldFail = fail },
    setFailDeleteDraft: (fail: boolean) => { failDeleteDraft = fail },
    emitLifecycle: (e: LifecycleEvent) => core.handleLifecycle(e),
    seedFile: (key: string, bytes: Uint8Array, version?: HomeVersion) => {
      const v = version ?? versionFor(bytes, edition, ++seq)
      files.set(key, { bytes, version: v, updatedAt: '2026-11-25T11:00:00Z' })
      return v
    },
  }
}

describe.each(['desktop', 'web'] as const)('SessionCore suite on %s ports (contracts §4)', (edition) => {
  it('cases 1 & 14: new Design applies New Design defaults, first edit makes it dirty (rev > ackRev), flush writes Draft', async () => {
    const h = makeHarness(edition)
    const opened = await h.core.createNew()
    expect(opened.status).toBe('opened')
    expect(h.core.currentDesign.value?.document.description).toBe('from-settings-defaults')
    expect(h.core.dirty.value).toBe(false)
    expect(h.getPendingWrite()).toBe(false)

    h.core.document('rename', () => ({ name: 'Orchard' }))
    expect(h.core.dirty.value).toBe(true)
    expect(h.getPendingWrite()).toBe(true)

    expect(await h.core.flushNow()).toBe(true)
    expect(h.core.dirty.value).toBe(false)
    expect(h.getPendingWrite()).toBe(false)
    expect(h.core.currentDesign.value?.home.version).not.toBeNull()
    h.core.dispose()
  })

  it('case 2 & #341/#400 FAT 0-byte Save As: probes 0-byte remnant on user replace, and Conflict Keep my version replaces post-pick 0-byte remnant', async () => {
    const h = makeHarness(edition)
    await h.core.createNew()
    h.core.document('rename', () => ({ name: 'Meadow' }))
    await h.core.flushNow()
    const draftKey = h.core.currentDesign.value!.home.key as DraftId

    // (a) User-confirmed replace of an existing 0-byte FAT crash remnant: probe sees EMPTY_SHA256 and replaces atomically.
    const grantA = 'grant-fat-remnant-a' as FileGrantId
    h.seedFile(grantA, new Uint8Array(0), EMPTY_SHA256)
    h.setNextPickTarget({ kind: 'picked', grant: grantA, displayName: 'Meadow.canopi' })
    expect(await h.core.saveAs()).toBe('saved')
    expect(h.core.currentDesign.value?.home.kind).toBe('file')
    expect(h.files.get(grantA)!.bytes.byteLength).toBeGreaterThan(0)
    expect(h.deleteDraftCalls).toContain(draftKey)

    // (b) Race: target absent at probe, 0-byte FAT remnant appears before write -> strict NotExists returns Conflict(EMPTY_SHA256),
    // and 'Keep my version' retries with expected = EMPTY_SHA256 and succeeds.
    const grantB = 'grant-fat-remnant-b' as FileGrantId
    h.setNextPickTarget({ kind: 'picked', grant: grantB, displayName: 'Meadow-2.canopi' })
    let racedOnce = true
    h.setNextWriteOverride((key, _bytes, expected) => {
      if (racedOnce && key === grantB && expected === null) {
        racedOnce = false
        h.seedFile(grantB, new Uint8Array(0), EMPTY_SHA256)
        return { kind: 'conflict', current: EMPTY_SHA256 }
      }
      return null
    })
    expect(await h.core.saveAs()).toBe('conflict')
    expect(h.core.currentDesign.value?.save).toEqual({ kind: 'conflict', current: EMPTY_SHA256 })

    expect(await h.core.resolveConflict('keep-mine')).toBe('resolved')
    expect(h.core.currentDesign.value?.save).toEqual({ kind: 'idle' })
    expect(h.files.get(grantB)!.bytes.byteLength).toBeGreaterThan(0)
    h.core.dispose()
  })

  it('cases 3 & 13: open refuses without touching current, already-open by homeKey, deleteDraft refuses open Draft', async () => {
    const h = makeHarness(edition)
    await h.core.createNew()
    h.core.document('rename', () => ({ name: 'KeepMe' }))
    await h.core.flushNow()
    const openDraftId = h.core.currentDesign.value!.home.key as DraftId

    // Opening unreadable / absent source leaves current untouched.
    const bad = await h.core.openFrom({ kind: 'file', grant: 'grant-missing' })
    expect(bad.status).toBe('refused')
    expect(h.core.currentDesign.value?.document.name).toBe('KeepMe')

    // Reopening the same home answers already-open.
    const same = await h.core.openFrom({ kind: 'draft', id: openDraftId })
    expect(same.status).toBe('already-open')

    // Deleting the open Design's Draft is refused on both editions.
    const del = await h.core.deleteDraft(openDraftId)
    expect(del).toEqual({ ok: false, reason: 'open-design-draft' })
    h.core.dispose()
  })

  it('cases 4 & 19: close flushes then clears last_open_home and destroys window; focus-lost flushes dirty Design', async () => {
    const h = makeHarness(edition)
    await h.core.createNew()
    h.core.document('rename', () => ({ name: 'FocusGarden' }))
    expect(h.core.dirty.value).toBe(true)

    await h.emitLifecycle({ kind: 'focus-lost' })
    expect(h.core.dirty.value).toBe(false)

    // Settings flush failure asks question; Cancel keeps open; Discard closes.
    h.setSettingsFlushFail(true)
    const closePromise = h.core.close('close')
    await vi.waitFor(() => {
      expect(h.core.state.value.kind).toBe('closing')
    })
    const q1 = h.core.state.value
    if (q1.kind === 'closing' && q1.question) {
      expect(h.core.answer(q1.question.id, 'cancel')).toBe('answered')
      expect(h.core.answer(q1.question.id, 'cancel')).toBe('stale')
    }
    expect(await closePromise).toBe('cancelled')
    expect(h.destroyWindow).not.toHaveBeenCalled()

    h.setSettingsFlushFail(false)
    expect(await h.core.close('close')).toBe('closed')
    expect(h.getLastOpenHome()).toBeNull()
    expect(h.destroyWindow).not.toHaveBeenCalled()

    await h.core.createNew()
    expect(await h.core.close('quit')).toBe('closed')
    expect(h.getLastOpenHome()).not.toBeNull()
    expect(h.destroyWindow).toHaveBeenCalledOnce()
    h.core.dispose()
  })

  it('cases 5, 6, 12, 16: conflict, quota refusal, pre-upgrade copy_blocked + saveWithoutCopy, and lost-ack adoption', async () => {
    const h = makeHarness(edition)
    const grant = 'grant-v9' as FileGrantId
    h.seedFile(grant, encodeText(makeDesign('OldV9')))
    await h.core.openFrom({ kind: 'file', grant })
    expect(h.core.currentDesign.value?.migratedFrom).toBe(9)

    // Pre-upgrade copy_blocked -> saveWithoutCopy succeeds.
    h.core.document('rename', () => ({ name: 'Upgraded' }))
    h.setNextWriteOverride((_k, _b, _e, opts) => (opts?.keepPrevious ? { kind: 'copy_blocked', folder: 'Designs' } : null))
    expect(await h.core.flushNow()).toBe(false)
    expect(h.core.currentDesign.value?.save).toEqual({ kind: 'copy_blocked', folder: 'Designs' })
    expect(await h.core.saveWithoutCopy()).toBe(true)
    expect(h.core.currentDesign.value?.migratedFrom).toBeNull()

    // Lost-ack adoption: write returns conflict whose stored bytes match our in-flight bytes.
    h.core.document('rename', () => ({ name: 'LostAck' }))
    h.setNextWriteOverride((key, bytes) => {
      const v = h.seedFile(key, new Uint8Array(bytes))
      return { kind: 'conflict', current: v }
    })
    expect(await h.core.flushNow()).toBe(true)
    expect(h.core.dirty.value).toBe(false)

    // Quota refusal keeps Design in memory with quota save state.
    h.core.document('rename', () => ({ name: 'QuotaFull' }))
    h.setNextWriteOverride(() => ({ kind: 'quota_refused' }))
    expect(await h.core.flushNow()).toBe(false)
    expect(h.core.currentDesign.value?.save).toEqual({ kind: 'quota' })
    h.core.dispose()
  })

  it('2.1-M547 unified Undo: coalescing, stale expect refusal, compound rollback, detachScene pruning, transient priority, reconcile, snapshot & Revert at rev+1', async () => {
    const h = makeHarness(edition)
    const grant = 'grant-undo-baseline' as FileGrantId
    const seeded = { ...makeDesign('SavedBaseline'), description: 'initial-desc' } as CanopiFile
    h.seedFile(grant, encodeText(seeded))
    const opened = await h.core.openFrom({ kind: 'file', grant })
    expect(opened.status).toBe('opened')
    expect(h.core.revertAvailable.value).toBe(false)
    expect(h.core.dirty.value).toBe(false)

    // Reconcile updates document without bumping rev, marking dirty, or pushing Undo.
    h.core.reconcile(() => ({ description: 'reconciled-desc' }))
    expect(h.core.currentDesign.value?.document.description).toBe('reconciled-desc')
    expect(h.core.currentDesign.value?.rev).toBe(0)
    expect(h.core.dirty.value).toBe(false)
    expect(h.core.canUndo.value).toBe(false)

    // Coalesced Document writes merge into one entry until endCoalesce or another entry.
    const id1 = h.core.document('print-setup', () => ({ description: 'step-1' }), { coalesce: 'pdf' })
    const id2 = h.core.document('print-setup', () => ({ description: 'step-2' }), { coalesce: 'pdf' })
    expect(id2).toBe(id1)
    h.core.endCoalesce('pdf')
    expect(h.core.revertAvailable.value).toBe(true)

    // Stale expect id is refused.
    expect(h.core.undo({ expect: 'h-999' as never })).toEqual({ status: 'stale' })
    expect(h.core.undo({ expect: id1! }).status).toBe('applied')
    expect(h.core.currentDesign.value?.document.description).toBe('reconciled-desc')
    expect(h.core.redo().status).toBe('applied')
    expect(h.core.currentDesign.value?.document.description).toBe('step-2')

    // Compound entry: refused Document half rolls back Scene edit; accepted joins both halves and detachScene drops it.
    const replayed: string[] = []
    let livePlants: CanopiFile['plants'] = []
    const loadedNames: string[] = []
    const port: ScenePort = {
      serialize: () => ({
        plants: livePlants,
        zones: [],
        layers: [],
        annotations: [],
        measurement_guides: [],
        groups: [],
        site_location: null,
        site_elevation_m: null,
      }) as unknown as ReturnType<ScenePort['serialize']>,
      load: (file) => {
        loadedNames.push(file.name)
        livePlants = [...file.plants]
      },
      replay: (cmd, dir) => {
        replayed.push(`${dir}:${cmd.type}`)
      },
    }
    expect(h.core.attachScene(port)).toBe('attached')
    expect(loadedNames).toEqual(['SavedBaseline'])

    livePlants = [{ id: 'p-1' } as CanopiFile['plants'][number]]
    expect(h.core.snapshot()?.plants).toHaveLength(1)

    const rollback = vi.fn()
    const fakeCmd: SceneCommand = { type: 'stamp-place', before: {}, after: {} }

    expect(
      h.core.compound('refused-stamp', () => ({ command: fakeCmd, result: 'x', rollback }), () => null),
    ).toBeNull()
    expect(rollback).toHaveBeenCalledOnce()

    const compId = h.core.compound(
      'accepted-stamp',
      () => ({ command: fakeCmd, result: 'ok', rollback }),
      () => ({ name: 'WithStamp' }),
    )
    expect(compId).not.toBeNull()
    expect(h.core.undo().status).toBe('applied')
    expect(replayed).toEqual(['undo:stamp-place'])
    expect(h.core.redo().status).toBe('applied')
    expect(replayed).toEqual(['undo:stamp-place', 'redo:stamp-place'])

    // Detach snapshots serialized scene fields and drops entries holding a Scene token (including compound), leaving Document-only entries.
    h.core.detachScene()
    expect(h.core.newestUndoable.value?.id).toBe(id1)
    expect(h.core.snapshot()?.plants).toHaveLength(1)

    // Transient history takes priority over Design history.
    let transientUndone = false
    h.core.setTransientHistory({
      canUndo: () => !transientUndone,
      canRedo: () => false,
      undo: () => { transientUndone = true; return true },
      redo: () => false,
    })
    expect(h.core.undo()).toEqual({ status: 'applied', entry: 'transient' })
    expect(transientUndone).toBe(true)

    // Revert clears Undo stack and restores opened baseline at rev + 1, scheduling a write to current home (2.1-Q363).
    const revBeforeRevert = h.core.currentDesign.value!.rev
    expect(await h.core.revert()).toBe('reverted')
    expect(h.core.canUndo.value).toBe(false)
    expect(h.core.currentDesign.value?.rev).toBe(revBeforeRevert + 1)
    expect(h.core.currentDesign.value?.document.name).toBe('SavedBaseline')
    expect(h.core.currentDesign.value?.document.description).toBe('initial-desc')
    expect(h.core.dirty.value).toBe(true)
    expect(await h.core.flushNow()).toBe(true)
    expect(h.core.dirty.value).toBe(false)
    h.core.dispose()
  })

  it('DesignScope late registration & canonical last_open_home codec (#430)', async () => {
    const h = makeHarness(edition)
    await h.core.createNew()
    let disposed = false
    h.core.onDesignOpened((scope) => {
      scope.onDispose(() => { disposed = true })
    })
    expect(disposed).toBe(false)
    await h.core.close('close')
    expect(disposed).toBe(true)

    expect(decodeLastOpenHome(encodeLastOpenHome({ kind: 'file', recent_id: 'abc123' }))).toEqual({
      kind: 'file',
      recent_id: 'abc123',
    })
    expect(decodeLastOpenHome(encodeLastOpenHome({ kind: 'draft', id: 'd-1' as DraftId }))).toEqual({
      kind: 'draft',
      id: 'd-1',
    })
    h.core.dispose()
  })

  it('covers place, remapSceneCommands, scene-only undo/redo, scope cleanup, lifecycle notices, and open-failure presenter', async () => {
    const h = makeHarness(edition)
    await h.core.createNew()
    const replayed: string[] = []
    h.core.attachScene({
      serialize: () => ({ plants: [], zones: [], layers: [], annotations: [], measurement_guides: [], groups: [], site_location: null, site_elevation_m: null }) as unknown as ReturnType<ScenePort['serialize']>,
      load: () => {},
      replay: (cmd, dir) => { replayed.push(`${dir}:${cmd.type}`) },
    })

    const sceneCmd: SceneCommand = { type: 'move', before: {}, after: {} }
    expect(h.core.recordSceneEdit('move', sceneCmd)).not.toBeNull()
    h.core.remapSceneCommands((cmd) => ({ ...cmd, type: `${cmd.type}-remapped` }))
    expect(h.core.undo().status).toBe('applied')
    expect(h.core.redo().status).toBe('applied')
    expect(replayed).toEqual(['undo:move-remapped', 'redo:move-remapped'])

    const placeId = h.core.place(
      { label: 'stamp', sceneObjects: [{ id: 's1' }], documentPatch: { description: 'filled' } },
      () => ({ command: { type: 'place', before: {}, after: {} }, rollback: vi.fn() }),
    )
    expect(placeId).not.toBeNull()

    let transientRedone = false
    h.core.setTransientHistory({
      canUndo: () => false,
      canRedo: () => !transientRedone,
      undo: () => false,
      redo: () => { transientRedone = true; return true },
    })
    expect(h.core.redo()).toEqual({ status: 'applied', entry: 'transient' })
    expect(transientRedone).toBe(true)

    await h.emitLifecycle({ kind: 'hidden' })
    await h.emitLifecycle({ kind: 'release-waiting', source: 'service-worker' })
    await h.emitLifecycle({ kind: 'store-version-change' })
    expect(h.notices.map((n) => n.kind)).toEqual(['release-waiting', 'store-version-change'])

    // Exercise resolveConflict('use-file') and resolveConflict('save-as').
    const grantConflict = 'grant-conflict-use-file' as FileGrantId
    h.seedFile(grantConflict, encodeText(makeDesign('DiskV1')))
    await h.core.openFrom({ kind: 'file', grant: grantConflict })
    h.core.document('rename', () => ({ name: 'LocalEdit' }))
    h.seedFile(grantConflict, encodeText(makeDesign('DiskV2')))
    expect(await h.core.flushNow()).toBe(false)
    expect(await h.core.resolveConflict('use-file')).toBe('resolved')
    expect(h.core.currentDesign.value?.document.name).toBe('DiskV2')

    h.core.document('rename', () => ({ name: 'LocalEdit2' }))
    h.seedFile(grantConflict, encodeText(makeDesign('DiskV3')))
    expect(await h.core.flushNow()).toBe(false)
    const grantCopy = 'grant-conflict-copy' as FileGrantId
    h.setNextPickTarget({ kind: 'picked', grant: grantCopy, displayName: 'Copy.canopi' })
    expect(await h.core.resolveConflict('save-as')).toBe('resolved')
    expect(h.core.currentDesign.value?.home.key).toBe(grantCopy)

    const hist = createSessionHistory(2)
    hist.recordScene('a', sceneCmd)
    hist.recordScene('b', sceneCmd)
    hist.recordScene('c', sceneCmd)
    expect(hist.pastCount).toBe(2)
    expect(hist.futureCount).toBe(0)

    const scope = createDesignScope()
    const removed = vi.fn()
    const unreg = scope.onDispose(removed)
    unreg()
    scope.onDispose(() => { throw new Error('ignored cleanup error') })
    expect(scope.closed).toBe(false)
    scope.dispose()
    expect(scope.closed).toBe(true)
    expect(removed).not.toHaveBeenCalled()
    const late = vi.fn()
    scope.onDispose(late)
    expect(late).toHaveBeenCalledOnce()

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const presented: string[] = []
    registerDesignOpenFailurePresenter((notice) => {
      presented.push(notice.message)
      return Promise.reject(new Error('presenter boom'))
    })
    const expectedByKind: Record<string, string> = {
      missing: 'start.cantReadMissing',
      unreadable: 'start.cantRead',
      too_large: 'start.cantRead',
      invalid_json: 'start.cantReadDamaged',
      older_version: 'start.cantReadOlderVersion',
      newer_version: 'start.cantReadNewerVersion',
      invalid_document: 'start.cantReadDamaged',
      internal: 'start.cantRead',
    }
    for (const [kind, expectedKey] of Object.entries(expectedByKind)) {
      presented.length = 0
      presentDesignOpenFailure({ kind, message: `${kind} err`, field_path: 'plants[0]' })
      expect(presented).toEqual([expectedKey])
    }
    await vi.waitFor(() => { expect(errSpy).toHaveBeenCalledTimes(Object.keys(expectedByKind).length) })
    registerDesignOpenFailurePresenter(null)
    errSpy.mockRestore()
    h.core.dispose()
  })
})
