// @vitest-environment jsdom
/**
 * Real edition-port behavioral suite for SessionCore (2b-3 #558, M5, D1–D8, M1–M4).
 * Exercises the production codec (`createJsonSessionCodec`), Desktop lifecycle port
 * (`createDesktopAppLifecyclePort`), Web home store (`createBrowserSessionHomeStore`),
 * and `actions.ts` + `close-guard.ts` end-to-end.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flattenDocumentForJson as encodeCanopiDesign } from '../../contracts/document'
import { createTestDesignCore } from '../../../__tests__/support/design-wire'
import { createInMemoryDesignHomeStore, makeTestDesign } from '../../../__tests__/support/session-core-fixture'
import {
  createDesktopAppLifecyclePort,
  type DesktopWindowHandle,
} from '../../../editions/desktop/session-ports'
import { createBrowserSessionHomeStore } from '../../../editions/web/session-ports'
import type { DesignHome, DesignHomeWriteResult, DraftId, HomeVersion } from '../../../platform/design-home'
import type { CanopiFile } from '../../../types/design'
import { createBrowserAppDataStore, type BrowserStorageAdapter } from '../../../web/browser-app-data'
import { flushBeforeExit, holdCloseUntilSettled, registerCloseGuard, waitForCloseHold } from '../../shell/close-guard'
import { withNewDesignDisplay } from '../../settings/new-design-defaults'
import {
  designSaveFailureReason,
  designSaveStatus,
  openDesignFromPath,
  resolveDesignConflict,
  retryDesignSave,
  saveCurrentDesign,
} from '../actions'
import { designOpenFailureNoticeOf, registerDesignOpenFailurePresenter } from '../open-failure'
import { createJsonSessionCodec, createSessionCore, installLiveSessionCore } from '../live-core'
import { answerSaveProblem, saveProblem } from '../save-problem'
import type { ScenePort } from './scene-half'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function memoryStorage(): BrowserStorageAdapter & { writeError: Error | null } {
  const values = new Map<string, string>()
  return {
    writeError: null,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (this.writeError) throw this.writeError
      values.set(key, value)
    },
    removeItem: (key) => { values.delete(key) },
  }
}

function wireBytes(file: CanopiFile, extraRoot: Record<string, unknown> = {}): Uint8Array {
  return encoder.encode(JSON.stringify({ ...encodeCanopiDesign(file), ...extraRoot }))
}

function makeFakeWindow() {
  let closeHandler: ((event: { preventDefault(): void }) => void) | null = null
  const destroy = vi.fn(async () => {})
  const unlisten = vi.fn()
  const handle: DesktopWindowHandle = {
    async onCloseRequested(handler) {
      closeHandler = handler
      return unlisten
    },
    destroy,
  }
  return {
    handle,
    destroy,
    unlisten,
    async requestClose() {
      const preventDefault = vi.fn()
      closeHandler?.({ preventDefault })
      await new Promise((r) => setTimeout(r, 10))
      return { preventDefault }
    },
  }
}

function makePlant(id: string): CanopiFile['plants'][number] {
  return {
    id,
    locked: false,
    canonical_name: 'Malus domestica',
    common_name: null,
    color: null,
    position: { lon: 2.35, lat: 48.85 },
    rotation: null,
    canopy_spread_m: null,
    notes: null,
    planted_date: null,
    quantity: null,
  }
}

const cleanups: Array<() => void> = []

function installBasicCore(
  designHome: ReturnType<typeof createInMemoryDesignHomeStore>,
  flushDelayMs?: number,
) {
  const core = createSessionCore({
    designHome,
    fileAccess: { pickOpen: async () => ({ kind: 'cancelled' }), pickHomeTarget: async () => ({ kind: 'cancelled' }) },
    lifecycle: { subscribe: () => () => {} },
    codec: createJsonSessionCodec({ designCore: createTestDesignCore() }),
    settings: { readLastOpenHome: async () => null, writeLastOpenHome: async () => {} },
    newDesignFactory: () => makeTestDesign(),
    ...(flushDelayMs !== undefined ? { flushDelayMs } : {}),
  })
  cleanups.push(installLiveSessionCore(core))
  return core
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
  answerSaveProblem('cancel')
})

describe('SessionCore on real Desktop and Web edition ports (D1–D8, M1–M5)', () => {
  it('D1 + M2: Desktop onCloseRequested flushes pending edits & settings, preserves lastOpenHome, and destroys window; update hold cancels close', async () => {
    const win = makeFakeWindow()
    const home = createInMemoryDesignHomeStore()
    const file = makeTestDesign({ name: 'Orchard' })
    home.seedFile('grant:1', file, 'v-0')

    const events: string[] = []
    let lastOpen: DesignHome | null = { kind: 'file', key: 'grant:1', displayName: 'Orchard', version: 'v-0' }
    const lifecycle = createDesktopAppLifecyclePort({
      getWindow: () => win.handle,
      waitForCloseHold,
    })
    const core = createSessionCore({
      designHome: home,
      fileAccess: {
        pickOpen: async () => ({ kind: 'cancelled' }),
        pickHomeTarget: async () => ({ kind: 'cancelled' }),
      },
      lifecycle,
      codec: createJsonSessionCodec({ designCore: createTestDesignCore() }),
      settings: {
        readLastOpenHome: async () => null,
        writeLastOpenHome: async (next) => {
          events.push(`lastOpen:${next ? next.key : 'null'}`)
          lastOpen = next
        },
        flushSettings: async () => { events.push('flushSettings') },
      },
      newDesignFactory: () => makeTestDesign(),
      flushDelayMs: 60_000,
    })
    cleanups.push(installLiveSessionCore(core))
    const guard = registerCloseGuard()
    cleanups.push(() => guard.dispose())

    await core.openFrom({ kind: 'file', grant: 'grant:1' })
    core.document('rename', () => ({ name: 'Orchard Edited' }))
    expect(core.dirty.value).toBe(true)

    // Active update hold that cancels prevents window close and destroyWindow.
    holdCloseUntilSettled('install', Promise.resolve('cancel'))
    const heldClose = await win.requestClose()
    expect(heldClose.preventDefault).toHaveBeenCalledTimes(1)
    expect(win.destroy).not.toHaveBeenCalled()
    expect(core.state.value.kind).toBe('open')

    // Normal window close flushes pending edits + settings, preserves lastOpenHome, then destroys window.
    events.length = 0
    const realClose = await win.requestClose()
    expect(realClose.preventDefault).toHaveBeenCalledTimes(1)
    expect(win.destroy).toHaveBeenCalledTimes(1)
    expect(lastOpen?.key).toBe('grant:1')
    expect(events).toEqual(['flushSettings'])
    const saved = await home.read('grant:1')
    expect(saved.kind).toBe('present')
    if (saved.kind === 'present') {
      expect((JSON.parse(decoder.decode(new Uint8Array(saved.bytes))) as { name: string }).name).toBe('Orchard Edited')
    }
  })

  it('M2: Close Design clears lastOpenHome before flushSettings without destroying window, while close(update|reload) preserves lastOpenHome', async () => {
    const win = makeFakeWindow()
    const home = createInMemoryDesignHomeStore()
    home.seedFile('grant:1', makeTestDesign({ name: 'Site A' }), 'v-0')
    const order: string[] = []
    const lastOpen: { current: DesignHome | null } = { current: null }

    const core = createSessionCore({
      designHome: home,
      fileAccess: { pickOpen: async () => ({ kind: 'cancelled' }), pickHomeTarget: async () => ({ kind: 'cancelled' }) },
      lifecycle: createDesktopAppLifecyclePort({ getWindow: () => win.handle }),
      codec: createJsonSessionCodec({ designCore: createTestDesignCore() }),
      settings: {
        readLastOpenHome: async () => null,
        writeLastOpenHome: async (next) => {
          order.push(`writeLast:${next ? next.key : 'null'}`)
          lastOpen.current = next
        },
        flushSettings: async () => { order.push('flushSettings') },
      },
      newDesignFactory: () => makeTestDesign(),
    })
    cleanups.push(installLiveSessionCore(core))

    await core.openFrom({ kind: 'file', grant: 'grant:1' })
    order.length = 0
    // N5: update flushes Design + settings without closing the open Design.
    expect(await flushBeforeExit('update')).toBe('proceed')
    expect(core.currentDesign.value?.home.key).toBe('grant:1')
    expect(lastOpen.current?.key).toBe('grant:1')
    expect(order).toEqual(['flushSettings'])
    expect(win.destroy).not.toHaveBeenCalled()

    // N7: close('close') flushes settings first, then clears lastOpenHome and flushes again; does not destroy window.
    order.length = 0
    expect(await core.close('close')).toBe('closed')
    expect(lastOpen.current).toBeNull()
    expect(order).toEqual(['flushSettings', 'writeLast:null', 'flushSettings'])
    expect(win.destroy).not.toHaveBeenCalled()
  })

  it('D2: Save As captures targetRev before async write so edits during Save As stay dirty and flush to the new file', async () => {
    let releaseWrite: (() => void) | null = null
    const baseHome = createInMemoryDesignHomeStore()
    const writes: Array<{ key: string; name: string }> = []
    const home = {
      ...baseHome,
      async write(key: string, bytes: Uint8Array, expected: HomeVersion | null) {
        const parsed = JSON.parse(decoder.decode(bytes)) as { name: string }
        writes.push({ key, name: parsed.name })
        if (writes.length === 1) {
          await new Promise<void>((resolve) => { releaseWrite = resolve })
        }
        return baseHome.write(key, bytes, expected)
      },
    }

    const core = createSessionCore({
      designHome: home,
      fileAccess: {
        pickOpen: async () => ({ kind: 'cancelled' }),
        pickHomeTarget: async () => ({ kind: 'picked', grant: 'grant:new', displayName: 'new.canopi' }),
      },
      lifecycle: { subscribe: () => () => {} },
      codec: createJsonSessionCodec({ designCore: createTestDesignCore() }),
      settings: { readLastOpenHome: async () => null, writeLastOpenHome: async () => {} },
      newDesignFactory: () => makeTestDesign({ name: 'Draft 1' }),
      flushDelayMs: 20,
    })
    cleanups.push(installLiveSessionCore(core))

    await core.createNew()
    const saveAsPromise = core.saveAs()
    await vi.waitFor(() => { expect(releaseWrite).not.toBeNull() })

    // User edits while Save As is still writing (N3 + M2): MUST wait for Save As, then autosave on timer
    // WITHOUT requiring any lifecycle event (no hidden/blur).
    core.document('rename', () => ({ name: 'Edited During Save As' }))
    releaseWrite!()
    expect(await saveAsPromise).toBe('saved')

    await vi.waitFor(() => {
      expect(core.dirty.value).toBe(false)
      expect(core.currentDesign.value?.save.kind).toBe('idle')
    })

    // Autosave ran AFTER Save As adopted the new file home, writing cleanly to grant:new (never old Draft).
    expect(writes.every((w) => w.key === 'grant:new')).toBe(true)
    expect(writes.map((w) => w.name)).toEqual(['Draft 1', 'Edited During Save As'])

    const onDisk = await baseHome.read('grant:new')
    expect(onDisk.kind).toBe('present')
    if (onDisk.kind === 'present') {
      expect((JSON.parse(decoder.decode(new Uint8Array(onDisk.bytes))) as { name: string }).name).toBe('Edited During Save As')
    }
  })

  it('D3: production codec preserves unknown root keys (plant_display) and refuses pre-2.0 and newer-version files unchanged (2.1-Q347)', async () => {
    const codec = createJsonSessionCodec({ designCore: createTestDesignCore() })
    const base = makeTestDesign({ name: 'RoundTrip', extra: {} })
    const rawWithUnknown = wireBytes(base, {
      plant_display: { labels: 'codes', symbol_scale: 1.25 },
      future_custom_key: { nested: true },
    })

    const decoded = await codec.decode(rawWithUnknown)
    expect(decoded.file.plant_display).toMatchObject({ labels: 'codes', symbol_scale: 1.25 })
    expect(decoded.file.extra).toEqual({
      future_custom_key: { nested: true },
    })

    const reencoded = await codec.encode(decoded.file)
    const reencodedJson = JSON.parse(decoder.decode(reencoded.bytes)) as Record<string, unknown>
    expect(reencodedJson.plant_display).toMatchObject({ labels: 'codes', symbol_scale: 1.25 })
    expect(reencodedJson.future_custom_key).toEqual({ nested: true })
    expect('extra' in reencodedJson).toBe(false)

    // Pre-2.0 (v7) refused.
    const v7Bytes = encoder.encode(JSON.stringify({ ...encodeCanopiDesign(base), version: 7 }))
    await expect(codec.decode(v7Bytes)).rejects.toThrow(/version 7/i)

    // Newer-version (v11) is refused unchanged (2.1-Q347).
    const v11Bytes = encoder.encode(JSON.stringify({ ...encodeCanopiDesign(base), version: 11 }))
    await expect(codec.decode(v11Bytes)).rejects.toThrow(/version 11/i)

    // admitWrite refuses invalid duplicate plant ids.
    const invalidFile = makeTestDesign({ plants: [makePlant('dup-1'), makePlant('dup-1')] })
    expect(codec.admitWrite?.(invalidFile)).toBeTruthy()
  })

  it('D4: "Use the file\'s version" reloads current disk bytes rather than stale opening baseline', async () => {
    const home = createInMemoryDesignHomeStore()
    home.seedFile('grant:1', makeTestDesign({ name: 'Opening Baseline' }), 'v-1')
    const core = installBasicCore(home, 60_000)

    await core.openFrom({ kind: 'file', grant: 'grant:1' })
    // External writer updates the file on disk.
    home.seedFile('grant:1', makeTestDesign({ name: 'External Disk Version' }), 'v-2')
    // Local user edits and flushes -> conflict.
    core.document('rename', () => ({ name: 'Local Edit' }))
    expect(await core.flushNow()).toBe(false)
    expect(core.currentDesign.value?.save.kind).toBe('conflict')

    const resolving = resolveDesignConflict()
    await vi.waitFor(() => { expect(saveProblem.value?.kind).toBe('conflict') })
    answerSaveProblem('use-file')
    await resolving

    expect(core.currentDesign.value?.document.name).toBe('External Disk Version')
    expect(core.currentDesign.value?.home.version).toBe('v-2')
    expect(core.currentDesign.value?.save.kind).toBe('idle')
    expect(core.dirty.value).toBe(false)
  })

  it('D5: failed attachScene never wipes Scene fields on detachScene, and failed open restores previous Scene', async () => {
    const home = createInMemoryDesignHomeStore()
    const plant = makePlant('p-1')
    home.seedFile('grant:good', makeTestDesign({ name: 'Good', plants: [plant] }), 'v-1')
    home.seedFile('grant:bad', makeTestDesign({ name: 'Bad' }), 'v-2')
    const core = installBasicCore(home)

    await core.openFrom({ kind: 'file', grant: 'grant:good' })

    const failingPort: ScenePort = {
      load() { throw new Error('boom during attach') },
      serialize() { return { plants: [] } as unknown as ReturnType<ScenePort['serialize']> },
      replay() {},
    }
    expect(() => core.attachScene(failingPort)).toThrow('boom during attach')
    core.detachScene()
    expect(core.snapshot()?.plants.map((p) => p.id)).toEqual(['p-1'])

    // Attach a healthy port that rejects only "Bad": previous Scene is restored and close() still works.
    let loadedPlants: CanopiFile['plants'] = []
    const selectivePort: ScenePort = {
      load(file) {
        if (file.name === 'Bad') throw new Error('hydration failed')
        loadedPlants = [...file.plants]
      },
      serialize() { return { plants: loadedPlants } as unknown as ReturnType<ScenePort['serialize']> },
      replay() {},
    }
    expect(core.attachScene(selectivePort)).toBe('attached')
    const refused = await core.openFrom({ kind: 'file', grant: 'grant:bad' })
    expect(refused).toEqual({ status: 'refused', reason: 'hydration failed' })
    expect(core.currentDesign.value?.document.name).toBe('Good')
    expect(core.snapshot()?.plants.map((p) => p.id)).toEqual(['p-1'])
    expect(await core.close('close')).toBe('closed')
  })

  it('D6 + D7: pan-only change is ignored by blur/close but written by manual Save & Retry, and updated_at advances on every write', async () => {
    const home = createInMemoryDesignHomeStore()
    home.seedFile('grant:pan', makeTestDesign({ name: 'Pan Site', updated_at: '2026-01-01T00:00:00.000Z' }), 'v-0')

    let liveView = { lon: 2.0, lat: 48.0, zoom: 14, bearing: 0, ground_size_m: { width: 100, height: 100 } }
    const port: ScenePort = {
      load() {},
      serialize: () => ({ map_view: liveView }) as unknown as ReturnType<ScenePort['serialize']>,
      replay() {},
    }
    const core = installBasicCore(home)

    await core.openFrom({ kind: 'file', grant: 'grant:pan' })
    core.attachScene(port)

    // Pan only -> clean; focus-lost writes nothing.
    liveView = { lon: 3.5, lat: 49.5, zoom: 16, bearing: 15, ground_size_m: { width: 50, height: 50 } }
    await core.handleLifecycle({ kind: 'focus-lost' })
    const beforeSave = await home.read('grant:pan')
    expect(beforeSave.kind).toBe('present')
    if (beforeSave.kind === 'present') expect(beforeSave.version).toBe('v-0')

    // Manual Save writes the live map_view and advances updated_at.
    expect(await saveCurrentDesign()).toBe(true)
    const afterSave = await home.read('grant:pan')
    expect(afterSave.kind).toBe('present')
    if (afterSave.kind === 'present') {
      expect(afterSave.version).not.toBe('v-0')
      const parsed = JSON.parse(decoder.decode(new Uint8Array(afterSave.bytes))) as CanopiFile
      expect(parsed.map_view).toEqual(liveView)
      expect(parsed.updated_at).not.toBe('2026-01-01T00:00:00.000Z')
    }

    // Failed manual pan Save -> Retry writes the updated view and clears error.
    liveView = { lon: 4.0, lat: 50.0, zoom: 17, bearing: 0, ground_size_m: { width: 40, height: 40 } }
    home.setWriteResult({
      kind: 'failed',
      failure: { code: { kind: 'io', io: 'other' }, user_may_retry: true, op: 'home.write', operation: null, detail: null },
    })
    expect(await saveCurrentDesign()).toBe(false)
    expect(designSaveStatus.value).toBe('error')

    home.setWriteResult(null)
    await retryDesignSave()
    expect(designSaveStatus.value).toBe('saved')
    const afterRetry = await home.read('grant:pan')
    if (afterRetry.kind === 'present') {
      expect((JSON.parse(decoder.decode(new Uint8Array(afterRetry.bytes))) as CanopiFile).map_view).toEqual(liveView)
    }
  })

  it('M1 + M5 + D8: Web real home store enforces single-flight writes, WEB-03 pendingWrite after quota failure, New Design defaults, Retry after Undo, and homeless Design dirty state', async () => {
    const storage = memoryStorage()
    const appDataStore = createBrowserAppDataStore({ storage })
    let tick = 0
    const realWebHome = createBrowserSessionHomeStore(
      appDataStore,
      () => new Date(Date.UTC(2026, 7, 1, 10, 0, tick++)),
    )

    let concurrentWrites = 0
    let maxConcurrentWrites = 0
    const wrappedWebHome = {
      ...realWebHome,
      async write(key: string, bytes: Uint8Array, expected: HomeVersion | null): Promise<DesignHomeWriteResult> {
        concurrentWrites += 1
        maxConcurrentWrites = Math.max(maxConcurrentWrites, concurrentWrites)
        await new Promise((r) => setTimeout(r, 5))
        try {
          return await realWebHome.write(key, bytes, expected)
        } finally {
          concurrentWrites -= 1
        }
      },
    }

    const core = createSessionCore({
      designHome: wrappedWebHome,
      fileAccess: { pickOpen: async () => ({ kind: 'cancelled' }), pickHomeTarget: async () => ({ kind: 'cancelled' }) },
      lifecycle: { subscribe: () => () => {} },
      codec: createJsonSessionCodec({ designCore: createTestDesignCore() }),
      settings: {
        readLastOpenHome: async () => null,
        writeLastOpenHome: async () => {},
        applyNewDesignDefaults: withNewDesignDisplay,
      },
      newDesignFactory: () => makeTestDesign({ name: 'Web Untitled' }),
      flushDelayMs: 60_000,
    })
    cleanups.push(installLiveSessionCore(core))

    // New Design defaults apply via real withNewDesignDisplay on createNew().
    const created = await core.createNew()
    expect(created.status).toBe('opened')
    expect(core.currentDesign.value?.document.extra).toHaveProperty('plant_display')

    // D8 Draft capture failure: first write failing keeps error status and pendingWrite true.
    storage.writeError = new DOMException('quota exceeded', 'QuotaExceededError')
    core.document('rename', () => ({ name: 'Web Orchard' }))
    expect(core.dirty.value).toBe(true)
    expect(core.pendingWrite.value).toBe(true)
    expect(await core.flushNow()).toBe(false)
    expect(designSaveStatus.value).toBe('error')
    expect(designSaveFailureReason.value).toBe('quota_refused')
    storage.writeError = null

    // Simultaneous focus-lost + hidden stays strictly single-flight (M1).
    await Promise.all([
      core.handleLifecycle({ kind: 'focus-lost' }),
      core.handleLifecycle({ kind: 'hidden' }),
    ])
    expect(maxConcurrentWrites).toBe(1)
    expect(core.dirty.value).toBe(false)

    // WEB-03: quota refusal keeps pendingWrite true so beforeunload warns the user.
    storage.writeError = new DOMException('quota exceeded', 'QuotaExceededError')
    core.document('rename', () => ({ name: 'Quota Blocked' }))
    expect(await core.flushNow()).toBe(false)
    expect(core.pendingWrite.value).toBe(true)
    expect(designSaveStatus.value).toBe('error')

    // Retry after Undo through real retryDesignSave() writes cleanly and clears error.
    storage.writeError = null
    expect(core.undo().status).toBe('applied')
    await retryDesignSave()
    expect(core.pendingWrite.value).toBe(false)
    expect(designSaveStatus.value).toBe('draft')

    // N4: Open failures preserve typed error so presenter receives specific locale key (not generic start.cantRead).
    const notices: string[] = []
    registerDesignOpenFailurePresenter((notice) => { notices.push(notice.message) })
    cleanups.push(() => registerDesignOpenFailurePresenter(null))
    const v7 = encoder.encode(JSON.stringify({ ...encodeCanopiDesign(makeTestDesign({ name: 'Old' })), version: 7 }))
    const refusedV7 = await core.openFrom({ kind: 'bytes', name: 'old.canopi', bytes: v7 })
    expect(refusedV7.status).toBe('refused')
    if (refusedV7.status === 'refused') {
      expect(designOpenFailureNoticeOf(refusedV7.error).message).toBe('start.cantReadOlderVersion')
    }
    await expect(openDesignFromPath('grant:missing')).rejects.toBeDefined()
    expect(notices).toContain('start.cantReadMissing')

    // Opening another Design while a flush-failed closing/replacing question is open supersedes cleanly without hanging.
    const draftId = created.status === 'opened' ? (created.home.key as DraftId) : ('draft-x' as DraftId)
    expect(draftId).toBeTruthy()
    storage.writeError = new Error('transient disk fault')
    core.document('rename', () => ({ name: 'Unsaved Before Switch' }))
    const openOther = core.openFrom({ kind: 'bytes', name: 'other.canopi', bytes: wireBytes(makeTestDesign({ name: 'Other' })) })
    await vi.waitFor(() => { expect(core.state.value.kind).toBe('replacing') })
    storage.writeError = null
    const openThird = await core.openFrom({ kind: 'bytes', name: 'third.canopi', bytes: wireBytes(makeTestDesign({ name: 'Third' })) })
    expect(openThird.status).toBe('opened')
    expect(await openOther).toEqual({ status: 'cancelled' })
  })
})
