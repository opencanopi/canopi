// @vitest-environment jsdom
/**
 * Real Desktop edition-port behavioral suite (2b-3 #570, M5, N1, N2):
 * exercises `createDesktopSessionHomeStore`, `desktopHomePort`, `desktopFileAccessPort`,
 * `desktopDesignCorePort.readNewerDesign`, and `createDesktopAppLifecyclePort` over mocked
 * Tauri `invoke` so Desktop IPC adapters are tested end-to-end with `SessionCore`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  convertFileSrc: (path: string) => path,
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({
  message: vi.fn().mockResolvedValue(undefined),
}))

import { flattenDocumentForJson as encodeCanopiDesign } from '../../app/contracts/document'
import { createJsonSessionCodec, createSessionCore, getLiveSessionCore, installLiveSessionCore } from '../../app/document-session/live-core'
import { designSessionStore } from '../../app/document-session/store'
import { makeTestDesign } from '../../__tests__/support/session-core-fixture'
import type { DraftId } from '../../platform/design-home'
import { bootDesktopEdition } from './boot'
import { desktopGeoJsonWorkflow, presentDesktopGeoJsonNotice } from './geojson'
import { createDesktopLastOpenHomePort, encodeDesktopLastOpenHome } from './last-open-home'
import {
  createDesktopAppLifecyclePort,
  createDesktopSessionHomeStore,
  desktopDesignCorePort,
  desktopFileAccessPort,
  type DesktopWindowHandle,
} from './session-ports'

const encoder = new TextEncoder()
const cleanups: Array<() => void> = []

beforeEach(() => {
  invokeMock.mockReset()
})

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

describe('Desktop edition ports (M5, N1, N2)', () => {
  it('M5 + N1: real createDesktopSessionHomeStore + desktopDesignCorePort open editable and newer-Canopi files read-only via IPC', async () => {
    const v9Bytes = Array.from(encoder.encode(JSON.stringify(encodeCanopiDesign(makeTestDesign({ name: 'Desktop Orchard' })))))
    const v10Bytes = Array.from(encoder.encode(JSON.stringify({ ...encodeCanopiDesign(makeTestDesign({ name: 'Future 2.1' })), version: 10 })))
    const writes: Array<{ key: string; expected: string | null }> = []

    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'home_read') {
        if (args.key === 'grant:v9') return { kind: 'present', bytes: v9Bytes, version: 'sha-v9' }
        if (args.key === 'grant:v10') return { kind: 'present', bytes: v10Bytes, version: 'sha-v10' }
        return { kind: 'absent' }
      }
      if (cmd === 'home_write') {
        writes.push({ key: String(args.key), expected: (args.expected as string | null) ?? null })
        return { kind: 'written', version: 'sha-v9-next' }
      }
      if (cmd === 'read_newer_design') {
        return { saved_by_version: 10, view: makeTestDesign({ name: 'Future 2.1' }) }
      }
      if (cmd === 'list_design_drafts') {
        return [{ id: 'draft-1', name: 'Draft One', updated_at: '2026-09-01T00:00:00.000Z' }]
      }
      if (cmd === 'delete_design_draft') {
        if (args.id === 'draft-fail') throw new Error('disk busy')
        return undefined
      }
      throw new Error(`Unexpected invoke: ${cmd}`)
    })

    const home = createDesktopSessionHomeStore()
    expect(await home.listDrafts()).toEqual([
      { id: 'draft-1', updatedAt: '2026-09-01T00:00:00.000Z', bytes: null },
    ])
    expect(await home.deleteDraft('draft-1' as DraftId)).toEqual({ ok: true })
    const delFail = await home.deleteDraft('draft-fail' as DraftId)
    expect(delFail.ok).toBe(false)
    const unsub = home.onVersionChange(() => {})
    unsub()

    const core = createSessionCore({
      designHome: home,
      fileAccess: desktopFileAccessPort,
      lifecycle: { subscribe: () => () => {} },
      codec: createJsonSessionCodec({ readNewerDesign: desktopDesignCorePort.readNewerDesign }),
      settings: { readLastOpenHome: async () => null, writeLastOpenHome: async () => {} },
      newDesignFactory: () => makeTestDesign(),
      flushDelayMs: 60_000,
    })
    cleanups.push(installLiveSessionCore(core))

    // Editable v9 file opens, edits, and writes through home_write IPC.
    const opened = await core.openFrom({ kind: 'file', grant: 'grant:v9' })
    expect(opened.status).toBe('opened')
    core.document('rename', () => ({ name: 'Desktop Orchard Edited' }))
    expect(await core.flushNow()).toBe(true)
    expect(writes).toEqual([{ key: 'grant:v9', expected: 'sha-v9' }])

    // N1 (M478): Newer-Canopi v10 file opens read-only through native read_newer_design IPC, never refused.
    const newer = await core.openFrom({ kind: 'file', grant: 'grant:v10' })
    expect(newer.status).toBe('opened')
    expect(designSessionStore.sessionKind.value).toEqual({
      kind: 'read-only',
      origin: 'newer-version',
      savedByVersion: 10,
    })
    expect(designSessionStore.readDesignName()).toBe('Future 2.1')
  })

  it('B1 + B2: desktopFileAccessPort and last_open_home use host-minted { grant, displayName, recentId }, never raw paths', async () => {
    invokeMock
      .mockResolvedValueOnce({
        kind: 'picked',
        paths: ['/home/u/orchard.canopi'],
        grants: ['grant:7'],
        file_homes: [{ grant: 'grant:7', display_name: 'orchard.canopi', recent_id: 'sha256-orchard' }],
      })
      .mockResolvedValueOnce({ kind: 'cancelled' })
      .mockResolvedValueOnce({
        kind: 'picked',
        path: '/home/u/saved-copy.canopi',
        grant: 'grant:8',
        file_home: { grant: 'grant:8', display_name: 'saved-copy.canopi', recent_id: 'sha256-saved-copy' },
      })
      .mockResolvedValueOnce({ kind: 'cancelled' })

    const opened = await desktopFileAccessPort.pickOpen('canopi')
    expect(opened).toEqual({
      kind: 'picked',
      grant: 'grant:7',
      displayName: 'orchard.canopi',
      recentId: 'sha256-orchard',
    })
    expect(await desktopFileAccessPort.pickOpen('canopi')).toEqual({ kind: 'cancelled' })
    const saved = await desktopFileAccessPort.pickHomeTarget('Orchard')
    expect(saved).toEqual({
      kind: 'picked',
      grant: 'grant:8',
      displayName: 'saved-copy.canopi',
      recentId: 'sha256-saved-copy',
    })
    expect(await desktopFileAccessPort.pickHomeTarget('Orchard')).toEqual({ kind: 'cancelled' })

    // B2: last_open_home encodes opaque recentId, never hashes grant:7, and resolves back to { grant, displayName, recentId }.
    const encoded = await encodeDesktopLastOpenHome({
      kind: 'file',
      key: 'grant:7',
      displayName: 'orchard.canopi',
      recentId: 'sha256-orchard',
      version: null,
    })
    expect(encoded).toBe('file:sha256-orchard')

    const port = createDesktopLastOpenHomePort({
      settingsReady: Promise.resolve(),
      getRecentFiles: async () => [],
      grantForRecent: async (id) =>
        id === 'sha256-orchard'
          ? { grant: 'grant:42', display_name: 'orchard.canopi', recent_id: 'sha256-orchard' }
          : null,
    })
    expect(await port.resolveFileHome('sha256-orchard')).toEqual({
      grant: 'grant:42',
      displayName: 'orchard.canopi',
      recentId: 'sha256-orchard',
    })
  })

  it('N2: Desktop window still destroys on unexpected close error and forwards blur/visibility events', async () => {
    let closeHandler: ((event: { preventDefault(): void }) => void) | null = null
    const destroy = vi.fn(async () => {})
    const unlisten = vi.fn()
    const win: DesktopWindowHandle = {
      async onCloseRequested(handler) {
        closeHandler = handler
        return unlisten
      },
      destroy,
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    cleanups.push(() => errorSpy.mockRestore())

    // Case A: waitForCloseHold rejects -> window stays open (never silently discards dirty edits).
    const lifecycleA = createDesktopAppLifecyclePort({
      getWindow: () => win,
      waitForCloseHold: async () => { throw new Error('hold exploded') },
    })
    const events: string[] = []
    const unsubA = lifecycleA.subscribe((e) => { events.push(e.kind) })
    await vi.waitFor(() => { expect(closeHandler).not.toBeNull() })

    window.dispatchEvent(new Event('blur'))
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(events).toEqual(['focus-lost', 'hidden', 'shown'])

    closeHandler!({ preventDefault: vi.fn() })
    await new Promise((r) => setTimeout(r, 20))
    expect(destroy).not.toHaveBeenCalled()
    unsubA()
    expect(unlisten).toHaveBeenCalledTimes(1)

    // Case B (B1 + M1 + closePending): rejected home_write during close('quit') clears 'writing' to 'failed',
    // asks Retry/Discard/Cancel, keeps window open, ignores a second X click while closing, and closes on Discard.
    destroy.mockClear()
    closeHandler = null
    invokeMock.mockRejectedValue(new Error('executor busy'))
    const lifecycleB = createDesktopAppLifecyclePort({ getWindow: () => win })
    const core = createSessionCore({
      designHome: createDesktopSessionHomeStore(),
      fileAccess: desktopFileAccessPort,
      lifecycle: lifecycleB,
      codec: createJsonSessionCodec({ readNewerDesign: desktopDesignCorePort.readNewerDesign }),
      settings: { readLastOpenHome: async () => null, writeLastOpenHome: async () => {} },
      newDesignFactory: () => makeTestDesign(),
      flushDelayMs: 60_000,
    })
    cleanups.push(installLiveSessionCore(core))
    await core.createNew()
    core.document('rename', () => ({ name: 'Dirty Before Reject' }))
    await vi.waitFor(() => { expect(closeHandler).not.toBeNull() })

    closeHandler!({ preventDefault: vi.fn() })
    await vi.waitFor(() => {
      const s = core.state.value
      expect(s.kind).toBe('closing')
      if (s.kind === 'closing') expect(s.question?.kind).toBe('flush-failed-before-close')
    })
    expect(core.currentDesign.value?.save.kind).toBe('failed')
    expect(destroy).not.toHaveBeenCalled()

    // Second X click while close is pending is ignored (does not replace the active question).
    const firstQuestionId = core.state.value.kind === 'closing' ? core.state.value.question?.id : null
    closeHandler!({ preventDefault: vi.fn() })
    await new Promise((r) => setTimeout(r, 10))
    expect(core.state.value.kind === 'closing' ? core.state.value.question?.id : null).toBe(firstQuestionId)
    expect(destroy).not.toHaveBeenCalled()

    // Answering Discard completes close('quit') and destroys the window once.
    expect(core.answer(firstQuestionId!, 'discard')).toBe('answered')
    await vi.waitFor(() => { expect(destroy).toHaveBeenCalledTimes(1) })
  })

  it('presents Desktop GeoJSON notices through native message dialogs and boots Desktop edition cleanly', async () => {
    await presentDesktopGeoJsonNotice({ tone: 'error', title: 'geojson.importFailedTitle', message: 'geojson.invalidFile' } as never)
    expect(desktopGeoJsonWorkflow).toBeDefined()

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'new_design') return makeTestDesign({ name: 'Booted Desktop' })
      if (cmd === 'get_recent_files') return []
      if (cmd === 'take_pending_open') return null
      if (cmd === 'load_settings') return null
      if (cmd === 'save_settings') return undefined
      if (cmd === 'app_health') return {}
      return null
    })
    const dispose = bootDesktopEdition()
    const live = getLiveSessionCore()!
    expect(live).not.toBeNull()
    const opened = await live.createNew()
    expect(opened.status).toBe('opened')
    await live.close('close')
    dispose()
  })
})
