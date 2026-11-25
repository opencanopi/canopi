// @vitest-environment jsdom
/**
 * Regression suite for #581 B4, B5, M1, M2, N1, N2, N3, N5, N6:
 * conflict re-read rejection, Save As scope guard, failed Save As autosave reschedule,
 * multi-attempt lost-ack recovery, no-design settings-flush question, blur/hide settings catch,
 * createNew openSequence bump, and close-guard dialog dismissal on cancelled question.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTestDesign } from '../../../__tests__/support/session-core-fixture'
import type { DesignHomeStore, HomeVersion } from '../../../platform/design-home'
import { registerCloseGuard } from '../../shell/close-guard'
import { createJsonSessionCodec, createSessionCore, installLiveSessionCore } from '../live-core'
import { answerSaveProblem, saveProblem } from '../save-problem'
import { composeForWrite } from './scene-half'
import { runSaveAs } from './session-ops'
import { createSessionWriteLane } from './write-lane'
import type { OpenDesignState } from './index'

const cleanups: Array<() => void> = []
const encoder = new TextEncoder()

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
  answerSaveProblem('cancel')
})

function makeMemoryHome(): {
  store: DesignHomeStore
  files: Map<string, { bytes: Uint8Array; version: HomeVersion }>
  onRead: ((key: string) => Promise<void>) | undefined
  onWrite: ((key: string, bytes: Uint8Array, expected: HomeVersion | null) => Promise<void>) | undefined
} {
  const files = new Map<string, { bytes: Uint8Array; version: HomeVersion }>()
  let seq = 1
  const env = {
    files,
    onRead: undefined as ((key: string) => Promise<void>) | undefined,
    onWrite: undefined as ((key: string, bytes: Uint8Array, expected: HomeVersion | null) => Promise<void>) | undefined,
    store: {
      async read(key: string) {
        await env.onRead?.(key)
        const entry = files.get(key)
        if (!entry) return { kind: 'absent' as const }
        return { kind: 'present' as const, bytes: Array.from(entry.bytes), version: entry.version }
      },
      async write(key: string, bytes: Uint8Array, expected: HomeVersion | null) {
        await env.onWrite?.(key, bytes, expected)
        const existing = files.get(key)
        if ((existing?.version ?? null) !== expected) {
          return { kind: 'conflict' as const, current: existing?.version ?? null }
        }
        const version = `v${seq++}`
        files.set(key, { bytes: new Uint8Array(bytes), version })
        return { kind: 'written' as const, version }
      },
      async listDrafts() { return [] },
      async deleteDraft(id: string) {
        files.delete(id)
        return { ok: true as const }
      },
      onVersionChange: () => () => {},
    },
  }
  return env
}

function makeCore(
  home: ReturnType<typeof makeMemoryHome>,
  overrides: Partial<Parameters<typeof createSessionCore>[0]> = {},
) {
  const core = createSessionCore({
    designHome: home.store,
    fileAccess: { pickOpen: async () => ({ kind: 'cancelled' }), pickHomeTarget: async () => ({ kind: 'cancelled' }) },
    lifecycle: { subscribe: () => () => {} },
    codec: createJsonSessionCodec(),
    settings: { readLastOpenHome: async () => null, writeLastOpenHome: async () => {} },
    newDesignFactory: () => makeTestDesign(),
    flushDelayMs: 60_000,
    ...overrides,
  })
  cleanups.push(() => core.dispose())
  return core
}

describe('SessionCore races & error-recovery regressions (#581)', () => {
  it('B4: rejected home_read during conflict re-read clears writing and lets close ask instead of throwing', async () => {
    const home = makeMemoryHome()
    const core = makeCore(home)

    await core.createNew()
    const key = core.currentDesign.value!.home.key
    home.files.set(key, { bytes: encoder.encode('{"external":true}'), version: 'ext-v1' })
    home.onRead = async () => { throw new Error('executor busy on reread') }

    core.document('rename', () => ({ name: 'Edited' }))
    const closing = core.close('close')
    await vi.waitFor(() => {
      expect(core.state.value.kind).toBe('closing')
    })
    expect(core.currentDesign.value?.save.kind).toBe('failed')
    const qId = core.state.value.kind === 'closing' ? core.state.value.question?.id : undefined
    expect(core.answer(qId!, 'discard')).toBe('answered')
    expect(await closing).toBe('closed')
  })

  it('B5: Save As finishing after another Design opens does not move the new Design onto the Save As target or clobber lastOpenHome/deleteDraft', async () => {
    const home = makeMemoryHome()
    let releasePick!: () => void
    const pickGate = new Promise<void>((resolve) => { releasePick = resolve })
    const codec = createJsonSessionCodec()
    const writtenHomes: Array<unknown> = []
    const core = makeCore(home, {
      fileAccess: {
        pickOpen: async () => ({ kind: 'cancelled' }),
        pickHomeTarget: async () => {
          await pickGate
          return { kind: 'picked', grant: 'grant:target', displayName: 'target.canopi', recentId: 'rid-target' }
        },
      },
      settings: {
        readLastOpenHome: async () => null,
        writeLastOpenHome: async (h) => { writtenHomes.push(h) },
      },
      codec,
      newDesignFactory: () => makeTestDesign({ name: 'Design A' }),
    })

    await core.createNew()
    const draftA = core.currentDesign.value!.home.key
    core.document('seed-draft', () => ({ name: 'Draft A Saved' }))
    expect(await core.flushNow()).toBe(true)
    expect(home.files.has(draftA)).toBe(true)

    const saveAsPromise = core.saveAs()
    const encodedB = await codec.encode(makeTestDesign({ name: 'Design B' }))
    const opened = await core.openFrom({
      kind: 'bytes',
      name: 'b.canopi',
      bytes: encodedB.bytes,
    })
    expect(opened.status).toBe('opened')
    const homeB = core.currentDesign.value!.home
    const countBeforeRelease = writtenHomes.length
    releasePick()
    expect(await saveAsPromise).toBe('cancelled')
    expect(core.currentDesign.value?.home).toEqual(homeB)
    expect(home.files.has('grant:target')).toBe(false)
    expect(writtenHomes.length).toBe(countBeforeRelease)
    expect(home.files.has(draftA)).toBe(true)

    // #631 F3: exercise applySaveAsWritten's own scope guard when a concurrent scope change lands at commit time
    // (fails against 914711557 where applySaveAsWritten unconditionally called writeLastOpenHome & deleteDraft).
    const directHome = makeMemoryHome()
    const directDraftKey = 'draft-a'
    const encodedA = await codec.encode(makeTestDesign({ name: 'Design A' }))
    await directHome.store.write(directDraftKey, encodedA.bytes, null)
    expect(directHome.files.has(directDraftKey)).toBe(true)
    const directWrittenHomes: Array<unknown> = []
    const scopeA = 1 as unknown as OpenDesignState['scope']
    const scopeB = 2 as unknown as OpenDesignState['scope']
    const docA = makeTestDesign({ name: 'Design A' })
    const designAState: OpenDesignState = {
      scope: scopeA,
      home: { kind: 'draft', key: directDraftKey as never, version: 'v1' },
      document: docA,
      baseline: docA,
      scene: { kind: 'detached', fields: {} },
      savedByVersion: null,
      readOnly: false,
      rev: 1,
      ackRev: 1,
      migratedFrom: null,
      save: { kind: 'idle' },
    }
    const designBState: OpenDesignState = {
      ...designAState,
      scope: scopeB,
      home: { kind: 'draft', key: 'draft-b' as never, version: 'v1' },
      document: makeTestDesign({ name: 'Design B' }),
    }
    const directOutcome = await runSaveAs({
      deps: {
        designHome: directHome.store,
        fileAccess: {
          pickOpen: async () => ({ kind: 'cancelled' }),
          pickHomeTarget: async () => ({ kind: 'picked', grant: 'grant:target', displayName: 'target.canopi' }),
        },
        codec,
        settings: {
          readLastOpenHome: async () => null,
          writeLastOpenHome: async (h) => { directWrittenHomes.push(h) },
        },
        lifecycle: { subscribe: () => () => {} },
        newDesignFactory: () => makeTestDesign(),
      },
      getCurrentDesign: () => designAState,
      updateCurrentDesign: (updater) => { updater(designBState) },
      setSaveState: () => {},
      composeForWrite,
      clearWriteTimer: () => {},
      runExclusive: (fn) => fn(),
      notifyPendingWrite: () => {},
      scheduleWrite: () => {},
    })
    expect(directOutcome).toBe('saved')
    expect(directWrittenHomes).toEqual([])
    expect(directHome.files.has(directDraftKey)).toBe(true)
  })

  it('M1: failed Save As reschedules Draft autosave when the Design is still dirty', async () => {
    const home = makeMemoryHome()
    home.onWrite = async (key) => {
      if (key === 'grant:bad') throw new Error('permission denied')
    }
    const core = makeCore(home, {
      fileAccess: {
        pickOpen: async () => ({ kind: 'cancelled' }),
        pickHomeTarget: async () => ({ kind: 'picked', grant: 'grant:bad', displayName: 'bad.canopi' }),
      },
      flushDelayMs: 15,
    })

    await core.createNew()
    const draftKey = core.currentDesign.value!.home.key
    core.document('rename', () => ({ name: 'Dirty Draft' }))
    expect(await core.saveAs()).toBe('failed')
    await vi.waitFor(() => {
      expect(home.files.has(draftKey)).toBe(true)
      expect(core.dirty.value).toBe(false)
    })
  })

  it('M2: lost-ack recovery recognizes an earlier unacknowledged attempt even after a newer edit with fresh updated_at', async () => {
    const home = makeMemoryHome()
    let dropFirstAck = true
    const baseWrite = home.store.write.bind(home.store)
    home.store.write = async (key, bytes, expected, options) => {
      const res = await baseWrite(key, bytes, expected, options)
      if (dropFirstAck && res.kind === 'written') {
        dropFirstAck = false
        // Simulate lost IPC reply after disk write succeeded.
        throw new Error('ipc reply lost')
      }
      return res
    }
    const core = makeCore(home)

    await core.createNew()
    core.document('rename', () => ({ name: 'Edit 1' }))
    expect(await core.flushNow()).toBe(false)
    expect(core.currentDesign.value?.save.kind).toBe('failed')

    // Second edit produces fresh updated_at and conflicts against Edit 1's version on disk,
    // yet write-lane recognizes Edit 1 as our own unacked attempt and publishes Edit 2 cleanly.
    core.document('rename', () => ({ name: 'Edit 2' }))
    expect(await core.flushNow()).toBe(true)
    expect(core.dirty.value).toBe(false)
    expect(core.currentDesign.value?.save.kind).toBe('idle')
  })

  it('N1 + N2 + N3 + N5 + N6: no-design settings flush asks with designSaved=false, blur catches, createNew supersedes, cancelled question dismisses dialog', async () => {
    const home = makeMemoryHome()
    let failSettings = true
    const destroy = vi.fn(async () => {})
    const core = makeCore(home, {
      lifecycle: { subscribe: () => () => {}, destroyWindow: destroy },
      settings: {
        readLastOpenHome: async () => null,
        writeLastOpenHome: async () => {},
        flushSettings: async () => { if (failSettings) throw new Error('settings disk full') },
      },
    })
    cleanups.push(installLiveSessionCore(core))
    const guard = registerCloseGuard()
    cleanups.push(() => guard.dispose())

    // N3: blur/hide settings flush error does not become an unhandled rejection.
    await expect(core.handleLifecycle({ kind: 'focus-lost' })).resolves.toBeUndefined()

    // N1 + N2: close('quit') with no open Design asks settings-failed with designSaved: false.
    const quitPromise = core.close('quit')
    await vi.waitFor(() => {
      expect(saveProblem.value).toEqual({ kind: 'settings-failed', designSaved: false })
    })

    // N6: cancelling the question via createNew() dismisses SaveProblemDialog immediately.
    failSettings = false
    const newPromise = core.createNew()
    await vi.waitFor(() => {
      expect(saveProblem.value).toBeNull()
    })
    expect(await quitPromise).toBe('cancelled')
    expect((await newPromise).status).toBe('opened')
    expect(destroy).not.toHaveBeenCalled()

    // N5: createNew() bumps openSequence so an earlier in-flight openFrom() is superseded.
    let releaseRead!: () => void
    home.onRead = () => new Promise<void>((resolve) => { releaseRead = resolve })
    const slowOpen = core.openFrom({ kind: 'file', grant: 'grant:slow' })
    const freshNew = await core.createNew()
    expect(freshNew.status).toBe('opened')
    releaseRead()
    expect(await slowOpen).toEqual({ status: 'cancelled' })

    // M4 live catch: re-opening the currently-open home supersedes an earlier in-flight openFrom().
    let releaseSecond!: () => void
    home.onRead = () => new Promise<void>((resolve) => { releaseSecond = resolve })
    const currentDraftId = core.currentDesign.value!.home.key
    const slowOther = core.openFrom({ kind: 'file', grant: 'grant:other' })
    const reopenSame = await core.openFrom({ kind: 'draft', id: currentDraftId as never })
    expect(reopenSame.status).toBe('already-open')
    releaseSecond()
    expect(await slowOther).toEqual({ status: 'cancelled' })
    expect(core.currentDesign.value?.home.key).toBe(currentDraftId)

    // B6: scenePort.load() observes open state & new scope so workspace activation sees hasCurrentDesign()=true.
    let stateDuringLoad: string | null = null
    core.attachScene({
      serialize: () => makeTestDesign(),
      load: () => { stateDuringLoad = core.state.value.kind },
      replay: () => {},
    })
    const openedB6 = await core.createNew()
    expect(openedB6.status).toBe('opened')
    expect(stateDuringLoad).toBe('open')
  })

  it('#588 M2: forced save queued behind an in-flight write aborts when another Design opens across the await', async () => {
    const home = makeMemoryHome()
    const codec = createJsonSessionCodec()
    let releaseFirstWrite: (() => void) | null = null
    let firstBlocked = true
    const writes: string[] = []
    home.onWrite = async (key) => {
      writes.push(key)
      if (firstBlocked) {
        firstBlocked = false
        await new Promise<void>((resolve) => { releaseFirstWrite = resolve })
      }
    }
    const scopeA = 10 as unknown as OpenDesignState['scope']
    const scopeB = 20 as unknown as OpenDesignState['scope']
    const docA = makeTestDesign({ name: 'Design A' })
    const docB = makeTestDesign({ name: 'Design B' })
    let current: OpenDesignState | null = {
      scope: scopeA,
      home: { kind: 'draft', key: 'draft-a' as never, version: null },
      document: docA,
      baseline: docA,
      scene: { kind: 'detached', fields: {} },
      savedByVersion: null,
      readOnly: false,
      rev: 2,
      ackRev: 1,
      migratedFrom: null,
      save: { kind: 'pending' },
    }
    const designB: OpenDesignState = {
      scope: scopeB,
      home: { kind: 'draft', key: 'draft-b' as never, version: null },
      document: docB,
      baseline: docB,
      scene: { kind: 'detached', fields: {} },
      savedByVersion: null,
      readOnly: false,
      rev: 1,
      ackRev: 1,
      migratedFrom: null,
      save: { kind: 'idle' },
    }
    const lane = createSessionWriteLane({
      designHome: home.store,
      codec,
      getDesign: () => current,
      updateDesign: (updater) => { if (current) current = updater(current) },
      composeForWrite,
      isDisposed: () => false,
      scheduleRetry: () => {},
    })

    const writeA = lane.run()
    await vi.waitFor(() => expect(releaseFirstWrite).toBeTypeOf('function'))
    const queuedForce = lane.run({ forceWrite: true })
    // Switch current design to Design B (non-null, new scope) before writeA finishes;
    // fails against 914711557 where queuedForce wrote Design B ('draft-b').
    current = designB
    releaseFirstWrite!()
    const [okA, okForce] = await Promise.all([writeA, queuedForce])
    expect(okForce).toBe(okA)
    expect(writes).toEqual(['draft-a'])
    expect(home.files.has('draft-b')).toBe(false)
  })
})
