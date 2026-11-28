// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../i18n'
import { openDesign } from '../app/document-session/actions'
import {
  designOpenFailureNoticeOf,
  presentDesignOpenFailure,
  registerDesignOpenFailurePresenter,
} from '../app/document-session/open-failure'
import {
  createJsonSessionCodec,
  createSessionCore,
  installLiveSessionCore,
} from '../app/document-session/live-core'
import { designSessionStore } from '../app/document-session/store'
import { locale } from '../app/settings/state'
import { recentFrontendDiagnostics } from '../app/problem-report/diagnostics'
import { resetFrontendDiagnosticsForTests } from '../failures/ring'
import { createDesignCore } from '../platform/design-core'
import { installEditionPorts } from '../platform/edition-ports'
import { createTestEditionPorts } from './support/test-edition-ports'
import { createInMemoryDesignHomeStore, createTestSessionCore } from './support/session-core-fixture'
import { createTestDesignCore } from './support/design-wire'

const olderVersion = { kind: 'older_version', message: 'unsupported Canopi Design version 6; this build opens versions 7 to 9' }

describe('a Design that cannot be opened is told to the user', () => {
  const presenter = vi.fn()
  let disposePorts: (() => void) | null = null
  let disposeSession: (() => void) | null = null

  beforeEach(() => {
    locale.value = 'en'
    presenter.mockReset()
    registerDesignOpenFailurePresenter(presenter)
  })

  afterEach(() => {
    registerDesignOpenFailurePresenter(null)
    disposeSession?.()
    disposeSession = null
    disposePorts?.()
    disposePorts = null
  })

  it('turns the typed load failure into the Start-screen wording, never the raw message or a path', () => {
    const older = designOpenFailureNoticeOf(olderVersion)
    expect([older.tone, t(older.title), t(older.message)]).toEqual([
      'error', 'Can’t open this Design', 'Made with Canopi before 2.0; Canopi 2.0 and later can’t open it',
    ])
    const unreadable = designOpenFailureNoticeOf(new Error('/home/someone/garden.canopi: boom'))
    expect([unreadable.tone, t(unreadable.title), t(unreadable.message)]).toEqual([
      'error', 'Can’t open this Design', 'Can’t read this file',
    ])
  })

  it('presents a failure from the open dialog, and says nothing when the dialog is cancelled', async () => {
    const handle = createTestSessionCore({ file: null })
    disposeSession = () => handle.dispose()
    const pickOpen = vi.fn()
    disposePorts = installEditionPorts(createTestEditionPorts({
      fileAccess: {
        pickOpen,
        pickHomeTarget: async () => ({ kind: 'cancelled' as const }),
      },
    }))

    pickOpen.mockResolvedValueOnce({ kind: 'picked' as const, grant: '/designs/missing.canopi' })
    await expect(openDesign()).rejects.toBeTruthy()
    expect(presenter).toHaveBeenCalledTimes(1)

    presenter.mockReset()
    pickOpen.mockResolvedValueOnce({ kind: 'cancelled' as const })
    await openDesign()
    expect(presenter).not.toHaveBeenCalled()
  })

  it('is silent without a presenter', () => {
    registerDesignOpenFailurePresenter(null)
    expect(() => presentDesignOpenFailure(olderVersion)).not.toThrow()
  })
})

/** The frozen v10 Design fixture: what the worker answers for a v10 file. */
const V10_TEXT = readFileSync('../../canopi-format/spec/v10/read-fixture.canopi', 'utf8')

type DesignCoreWorker = ReturnType<NonNullable<NonNullable<Parameters<typeof createDesignCore>[0]>['createWorker']>>
type DesignCoreRequest = Parameters<DesignCoreWorker['postMessage']>[0]

/** A worker the test answers by hand: its calls, its termination, and the two ways a page sees it fail. */
class FakeFormatWorker implements DesignCoreWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  readonly calls: DesignCoreRequest[] = []
  terminated = false
  postMessage(message: DesignCoreRequest): void { this.calls.push(message) }
  terminate(): void { this.terminated = true }
  answer(reply: unknown): void { this.onmessage?.({ data: reply } as MessageEvent<unknown>) }
  read(id: number): void { this.answer({ id, ok: true, value: JSON.stringify({ ok: { design: JSON.parse(V10_TEXT), migrated_from: null } }), compiledBy: 'streaming' }) }
  /** The worker script itself failed: a 404 after a deploy, or a module the engine refused. */
  failToStart(): void { this.onerror?.(new Event('error', { cancelable: true })) }
}

/** The adapter over fake workers, wired into a live SessionCore opening `text` through its codec. */
function webOpen(text = V10_TEXT, { installed = true } = {}) {
  const workers: FakeFormatWorker[] = []
  let activeFormatCore: ReturnType<typeof createDesignCore> | null = installed
    ? createDesignCore({ createWorker: () => { const worker = new FakeFormatWorker(); workers.push(worker); return worker } })
    : null
  const home = createInMemoryDesignHomeStore()
  let lastDecodeError: unknown = null
  const sessionCore = createSessionCore({
    designHome: home,
    fileAccess: {
      pickOpen: async () => ({ kind: 'cancelled' }),
      pickHomeTarget: async () => ({ kind: 'cancelled' }),
    },
    lifecycle: { subscribe: () => () => {}, destroyWindow: async () => {} },
    codec: createJsonSessionCodec({
      designCore: createTestDesignCore(),
      decode: async (bytes) => {
        lastDecodeError = null
        if (!activeFormatCore) {
          lastDecodeError = { kind: 'newer_version', message: 'newer version' }
          throw lastDecodeError
        }
        try {
          const result = await activeFormatCore.decode(bytes)
          if ('err' in result) {
            lastDecodeError = result.err
            throw Object.assign(new Error(result.err.message), result.err)
          }
          return {
            file: result.ok.design as never,
            readOnly: false,
          }
        } catch (error) {
          lastDecodeError = error
          throw error
        }
      },
    }),
    settings: {
      readLastOpenHome: async () => null,
      writeLastOpenHome: async () => {},
    },
    newDesignFactory: () => { throw new Error('unused') },
  })
  const disposeLive = installLiveSessionCore(sessionCore)
  const openCanopi = async (): Promise<boolean> => {
    lastDecodeError = null
    try {
      const result = await sessionCore.openFrom({
        kind: 'bytes',
        name: 'orchard-2-1.canopi',
        bytes: new TextEncoder().encode(text),
      })
      if (result.status === 'refused') {
        presentDesignOpenFailure(lastDecodeError ?? new Error(result.reason))
        return false
      }
      return result.status === 'opened' || result.status === 'already-open'
    } catch (error) {
      presentDesignOpenFailure(error)
      return false
    }
  }
  const posted = async (count: number) => {
    await vi.waitFor(() => expect(workers.flatMap((worker) => worker.calls)).toHaveLength(count))
  }
  return {
    workers,
    core: activeFormatCore,
    openCanopi,
    posted,
    uninstallFormatCore: () => {
      activeFormatCore = null
    },
    dispose: () => {
      disposeLive()
    },
  }
}

describe('a newer Design the Web format core cannot read is told to the user', () => {
  const presenter = vi.fn()
  const disposers: Array<() => void> = []

  beforeEach(() => {
    locale.value = 'en'
    presenter.mockReset()
    registerDesignOpenFailurePresenter(presenter)
    resetFrontendDiagnosticsForTests()
  })

  afterEach(() => {
    registerDesignOpenFailurePresenter(null)
    for (const dispose of disposers.splice(0)) dispose()
  })

  it('canopi-f47t.52.270: a format worker that fails to load refuses only that open with format_core_unavailable, and opening again loads once more', async () => {
    const h = webOpen()
    disposers.push(h.dispose)
    expect(h.workers).toHaveLength(0)

    const refused = h.openCanopi()
    await h.posted(1)
    h.workers[0]!.failToStart()
    await expect(refused).resolves.toBe(false)
    expect(designSessionStore.hasCurrentDesign()).toBe(false)
    expect(h.workers[0]!.terminated).toBe(true)
    expect(recentFrontendDiagnostics()).toEqual([expect.objectContaining({ code: { kind: 'format_core_unavailable' }, source: 'format_core' })])

    // The module itself could not load inside a running worker: that open only, and the same worker loads again next.
    const second = h.openCanopi()
    await h.posted(2)
    h.workers[1]!.answer({ id: h.workers[1]!.calls[0]!.id, ok: false, error: 'unavailable', detail: 'TypeError: Failed to fetch' })
    await expect(second).resolves.toBe(false)
    expect(h.workers[1]!.terminated).toBe(false)

    const retried = h.openCanopi()
    await h.posted(3)
    expect(h.workers).toHaveLength(2)
    h.workers[1]!.read(h.workers[1]!.calls[1]!.id)
    await expect(retried).resolves.toBe(true)
    expect(designSessionStore.hasCurrentDesign()).toBe(true)
  })

  it('canopi-f47t.52.270: a newer Design opened before the format core is installed, or after it is disposed, is refused as newer_version, as 2.0 refuses it', async () => {
    const early = webOpen(V10_TEXT, { installed: false })
    disposers.push(early.dispose)
    await expect(early.openCanopi()).resolves.toBe(false)
    const late = webOpen()
    disposers.push(late.dispose)
    late.uninstallFormatCore()
    await expect(late.openCanopi()).resolves.toBe(false)
    expect(early.workers.length + late.workers.length).toBe(0)
    expect(designSessionStore.hasCurrentDesign()).toBe(false)
  })

  it('canopi-f47t.52.270: a trap in decode settles that read and the reads queued behind it format_core_trapped, never replayed, and the next read starts a new worker', async () => {
    const h = webOpen()
    disposers.push(h.dispose)
    const bytes = new TextEncoder().encode(V10_TEXT)
    const first = h.core!.decode(bytes)
    const queued = h.core!.decode(bytes)
    const [trapped, behind] = h.workers[0]!.calls
    h.workers[0]!.answer({ id: trapped!.id, ok: false, error: 'trapped', detail: 'trapped' })
    await expect(first).rejects.toMatchObject({ code: { kind: 'format_core_trapped' }, user_may_retry: true })
    await expect(queued).rejects.toMatchObject({ code: { kind: 'format_core_trapped' }, user_may_retry: true })
    expect(h.workers[0]!.terminated).toBe(true)

    // A late answer from the dead worker settles nothing twice; the next read runs on a new one.
    h.workers[0]!.read(behind!.id)
    const next = h.core!.decode(bytes)
    expect(h.workers).toHaveLength(2)
    h.workers[1]!.read(h.workers[1]!.calls[0]!.id)
    await expect(next).resolves.toMatchObject({ ok: { design: { version: 10 } } })
    expect(designOpenFailureNoticeOf(await first.catch((error: unknown) => error)).message).toBe('failure.formatCoreTrapped')
  })

  it('canopi-f47t.52.270: a page hidden mid-request settles the open once, when its answer comes, and a repeated answer changes nothing', async () => {
    const h = webOpen()
    disposers.push(h.dispose)
    const opening = h.openCanopi()
    await h.posted(1)
    window.dispatchEvent(new Event('pagehide'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(h.workers[0]!.terminated).toBe(false)
    h.workers[0]!.read(h.workers[0]!.calls[0]!.id)
    await expect(opening).resolves.toBe(true)
    h.workers[0]!.read(h.workers[0]!.calls[0]!.id)
    h.workers[0]!.failToStart()
    await Promise.resolve()
    expect([designSessionStore.sessionKind.value?.kind, designSessionStore.readDesignName(), presenter.mock.calls.length]).toEqual(['editing', 'Orchard by the pond', 0])
  })

  it('canopi-f47t.52.270: a newer Design the read refuses says why as Desktop does, its field kept for the report', async () => {
    const h = webOpen()
    disposers.push(h.dispose)
    const refused = h.openCanopi()
    await h.posted(1)
    const failure = { kind: 'newer_version', message: '$.plants[0].canonical_name: missing required value', field_path: '$.plants[0].canonical_name' }
    h.workers[0]!.answer({ id: h.workers[0]!.calls[0]!.id, ok: true, value: JSON.stringify({ err: failure }), compiledBy: 'streaming' })
    await expect(refused).resolves.toBe(false)
    expect(recentFrontendDiagnostics()[0]?.message).toContain('at $.plants[0].canonical_name')
  })
})
