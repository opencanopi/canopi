// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pickCancelled } from '../ipc/dialogs'
import { t } from '../i18n'

const mocks = vi.hoisted(() => ({
  loadDesign: vi.fn(),
  openDesignDialog: vi.fn(),
}))

vi.mock('../ipc/design', async (importOriginal) => {
  const actual = await importOriginal<typeof IpcDesignModule>()
  return { ...actual, loadDesign: mocks.loadDesign, openDesignDialog: mocks.openDesignDialog }
})

import { openDesign } from '../app/document-session/actions'
import {
  designOpenFailureNoticeOf,
  presentDesignOpenFailure,
  registerDesignOpenFailurePresenter,
} from '../app/document-session/open-failure'
import { locale } from '../app/settings/state'
import type * as IpcDesignModule from '../ipc/design'
import { createDesignSessionStore } from '../app/document-session/store'
import { recentFrontendDiagnostics } from '../app/problem-report/diagnostics'
import { resetFrontendDiagnosticsForTests } from '../failures/ring'
import { createDesignCore } from '../platform/design-core'
import { createBrowserDesignSessionController } from '../web/browser-design-session'

const olderVersion = { kind: 'older_version', message: 'unsupported Canopi Design version 6; this build opens versions 7 to 9' }

describe('a Design that cannot be opened is told to the user', () => {
  const presenter = vi.fn()

  beforeEach(() => {
    locale.value = 'en'
    presenter.mockReset()
    registerDesignOpenFailurePresenter(presenter)
    mocks.loadDesign.mockReset()
    mocks.openDesignDialog.mockReset()
  })

  afterEach(() => {
    registerDesignOpenFailurePresenter(null)
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
    mocks.openDesignDialog.mockRejectedValue({ kind: 'newer_version', message: 'newer' })
    await expect(openDesign()).rejects.toBeTruthy()
    expect(presenter).toHaveBeenCalledTimes(1)
    expect(t(presenter.mock.calls[0]?.[0].message)).toBe('Made with a newer version of Canopi; update Canopi to open it')

    presenter.mockReset()
    mocks.openDesignDialog.mockRejectedValue(pickCancelled('dialog.pick_open'))
    await openDesign()
    expect(presenter).not.toHaveBeenCalled()
  })

  it('is silent without a presenter', () => {
    registerDesignOpenFailurePresenter(null)
    expect(() => presentDesignOpenFailure(olderVersion)).not.toThrow()
  })
})

/** The read output canopi-format gives for spec/v10/read-fixture.canopi: what the worker answers for a v10 file. */
const READ_VIEW = readFileSync('../../canopi-format/spec/v10/read-expected.json', 'utf8')
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
  read(id: number): void { this.answer({ id, ok: true, value: `{"read":${READ_VIEW}}`, compiledBy: 'streaming' }) }
  /** The worker script itself failed: a 404 after a deploy, or a module the engine refused. */
  failToStart(): void { this.onerror?.(new Event('error', { cancelable: true })) }
}

/** The adapter over fake workers, and a Web session opening `text` through it. */
function webOpen(text = V10_TEXT, { installed = true } = {}) {
  const workers: FakeFormatWorker[] = []
  const core = createDesignCore({ createWorker: () => { const worker = new FakeFormatWorker(); workers.push(worker); return worker } })
  const store = createDesignSessionStore()
  const controller = createBrowserDesignSessionController({
    store,
    fileAdapter: { openCanopiFile: vi.fn(async () => ({ fileName: 'orchard-2-1.canopi', text })), downloadCanopiFile: vi.fn() },
    requestDraftPersistence: () => {},
  })
  const uninstallFormatCore = installed ? controller.installFormatCore(core) : () => {}
  /** The open's read reaches the worker after the picker resolves. */
  const posted = async (count: number) => { await vi.waitFor(() => expect(workers.flatMap((worker) => worker.calls)).toHaveLength(count)) }
  return { workers, core, store, controller, posted, uninstallFormatCore }
}

describe('a newer Design the Web format core cannot read is told to the user', () => {
  const presenter = vi.fn()

  beforeEach(() => {
    locale.value = 'en'
    presenter.mockReset()
    registerDesignOpenFailurePresenter(presenter)
    resetFrontendDiagnosticsForTests()
  })

  afterEach(() => {
    registerDesignOpenFailurePresenter(null)
  })

  it('canopi-f47t.52.270: a format worker that fails to load refuses only that open with format_core_unavailable, and opening again loads once more', async () => {
    const { workers, store, controller, posted } = webOpen()
    expect(workers).toHaveLength(0)

    const refused = controller.openCanopi()
    await posted(1)
    workers[0]!.failToStart()
    await expect(refused).resolves.toBe(false)
    expect(store.hasCurrentDesign()).toBe(false)
    expect(workers[0]!.terminated).toBe(true)
    expect(t(presenter.mock.calls[0]?.[0].message)).toBe('Canopi couldn’t load the part that opens Designs. Try again, and report a problem if this keeps happening.')
    expect(recentFrontendDiagnostics()).toEqual([expect.objectContaining({ code: { kind: 'format_core_unavailable' }, source: 'format_core.read' })])

    // The module itself could not load inside a running worker: that open only, and the same worker loads again next.
    const second = controller.openCanopi()
    await posted(2)
    workers[1]!.answer({ id: workers[1]!.calls[0]!.id, ok: false, error: 'unavailable', detail: 'TypeError: Failed to fetch' })
    await expect(second).resolves.toBe(false)
    expect(workers[1]!.terminated).toBe(false)

    const retried = controller.openCanopi()
    await posted(3)
    expect(workers).toHaveLength(2)
    workers[1]!.read(workers[1]!.calls[1]!.id)
    await expect(retried).resolves.toBe(true)
    expect(store.sessionKind.value).toEqual({ kind: 'read-only', origin: 'newer-version', savedByVersion: 10 })
  })

  it('canopi-f47t.52.270: a newer Design opened before the format core is installed, or after it is disposed, is refused as newer_version, as 2.0 refuses it', async () => {
    const early = webOpen(V10_TEXT, { installed: false })
    await expect(early.controller.openCanopi()).resolves.toBe(false)
    const late = webOpen()
    late.uninstallFormatCore()
    await expect(late.controller.openCanopi()).resolves.toBe(false)
    const messages = presenter.mock.calls.map((call) => t(call[0].message))
    expect([messages, early.workers.length + late.workers.length, early.store.hasCurrentDesign() || late.store.hasCurrentDesign()]).toEqual([
      ['Made with a newer version of Canopi; update Canopi to open it', 'Made with a newer version of Canopi; update Canopi to open it'], 0, false,
    ])
  })

  it('canopi-f47t.52.270: a trap in decode settles that read and the reads queued behind it format_core_trapped, never replayed, and the next read starts a new worker', async () => {
    const { workers, core } = webOpen()
    const first = core.readNewerDesign(V10_TEXT)
    const queued = core.readNewerDesign(V10_TEXT)
    const [trapped, behind] = workers[0]!.calls
    workers[0]!.answer({ id: trapped!.id, ok: false, error: 'trapped', detail: 'trapped' })
    await expect(first).rejects.toMatchObject({ code: { kind: 'format_core_trapped' }, user_may_retry: true })
    await expect(queued).rejects.toMatchObject({ code: { kind: 'format_core_trapped' } })
    expect(workers[0]!.terminated).toBe(true)

    // A late answer from the dead worker settles nothing twice; the next read runs on a new one.
    workers[0]!.read(behind!.id)
    const next = core.readNewerDesign(V10_TEXT)
    expect(workers).toHaveLength(2)
    workers[1]!.read(workers[1]!.calls[0]!.id)
    await expect(next).resolves.toMatchObject({ saved_by_version: 10 })
    expect(designOpenFailureNoticeOf(await first.catch((error: unknown) => error)).message).toBe('failure.formatCoreTrapped')
  })

  it('canopi-f47t.52.270: a page hidden mid-request settles the open once, when its answer comes, and a repeated answer changes nothing', async () => {
    const { workers, store, controller, posted } = webOpen()
    const opening = controller.openCanopi()
    await posted(1)
    window.dispatchEvent(new Event('pagehide'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(workers[0]!.terminated).toBe(false)
    workers[0]!.read(workers[0]!.calls[0]!.id)
    await expect(opening).resolves.toBe(true)
    workers[0]!.read(workers[0]!.calls[0]!.id)
    workers[0]!.failToStart()
    await Promise.resolve()
    expect([store.sessionKind.value?.kind, store.readDesignName(), presenter.mock.calls.length]).toEqual(['read-only', 'Orchard by the pond', 0])
  })

  it('canopi-f47t.52.270: a newer Design the read refuses says why as Desktop does, its field kept for the report', async () => {
    const { workers, controller, posted } = webOpen()
    const refused = controller.openCanopi()
    await posted(1)
    const failure = { kind: 'newer_version', message: '$.plants[0].canonical_name: missing required value', field_path: '$.plants[0].canonical_name' }
    workers[0]!.answer({ id: workers[0]!.calls[0]!.id, ok: true, value: JSON.stringify({ refused: failure }), compiledBy: 'streaming' })
    await expect(refused).resolves.toBe(false)
    expect(t(presenter.mock.calls[0]?.[0].message)).toBe('Made with a newer version of Canopi; update Canopi to open it')
    expect(recentFrontendDiagnostics()[0]?.message).toContain('at $.plants[0].canonical_name')
  })
})
