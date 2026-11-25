// The read-only Session kind (2.1-M478, design check F3; canopi-f47t.52.270): a Design a newer Canopi saved opens on the
// one replacement path in `read-only{origin: newer-version}`, with no home, Draft id or write destination; continuous
// save writes nothing, Design Edit refuses edits, Save, Save As and Revert are off, and Close ends it through the close
// replacement without asking. The Canvas here is the real Scene authority, so what a close leaves is read from its
// Scene content and undo history.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInMemoryDesignHomeStore } from '../../__tests__/support/session-core-fixture'
import { createDetachedCanvasRuntimeAppAdapter } from '../../__tests__/support/detached-canvas-app-adapter'
import { SceneCanvasRuntime } from '../../canvas/runtime/scene-runtime'
import type { FileGrantId } from '../../platform/design-home'
import type { FileAccessPort } from '../../platform/file-access'
import type { CanopiFile } from '../../types/design'
import { scenePortOf } from '../canvas-map-surface/scene-port'
import { createAppCanvasRuntimeAppAdapter } from '../canvas-runtime/app-adapter'
import { defaultDesignEditAuthority } from '../design-edit/authority-capability'
import {
  closeDesign,
  designRevertAvailable,
  designSaveStatus,
  saveAsCurrentDesign,
  saveCurrentDesign,
  saveCurrentDesignEdits,
} from './actions'
import {
  createJsonSessionCodec,
  createSessionCore,
  installLiveSessionCore,
  type SessionCore,
} from './live-core'
import { designSessionStore } from './store'

const EMPTY_DESIGN: Omit<CanopiFile, 'name' | 'plants'> = {
  version: 9,
  description: null,
  plant_species_colors: {},
  plant_species_symbols: {},
  layers: [],
  zones: [],
  annotations: [],
  measurement_guides: [],
  groups: [],
  consortiums: [],
  timeline: [],
  budget: [],
  budget_currency: 'EUR',
  views: [],
  stories: [],
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  extra: {},
}

/** The `index`th apple tree of a row a metre or so apart. */
function apple(index: number): CanopiFile['plants'][number] {
  return {
    id: `plant-${index}`,
    canonical_name: 'Malus domestica',
    common_name: null,
    color: null,
    position: { lon: 2 + index * 1e-5, lat: 48 },
    rotation: null,
    scale: null,
    notes: null,
    planted_date: null,
    quantity: null,
  } as CanopiFile['plants'][number]
}

function makeFile(name: string, plantCount = 0): CanopiFile {
  return { ...EMPTY_DESIGN, name, plants: Array.from({ length: plantCount }, (_, index) => apple(index)) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

let core: SessionCore
let disposeCore: (() => void) | null = null
let home: ReturnType<typeof createInMemoryDesignHomeStore>
let writeSpy: ReturnType<typeof vi.spyOn>
let pickHomeTarget: ReturnType<typeof vi.fn<FileAccessPort['pickHomeTarget']>>
let runtime: SceneCanvasRuntime
let decodeGate: ((bytes: Uint8Array) => Promise<void>) | null = null

function openEditing(): void {
  home = createInMemoryDesignHomeStore()
  const initialFile = makeFile('Current', 2)
  home.seedFile('/designs/current.canopi', initialFile, 'v-current')
  writeSpy = vi.spyOn(home, 'write')
  pickHomeTarget = vi.fn<FileAccessPort['pickHomeTarget']>(async () => ({ kind: 'cancelled' as const }))
  decodeGate = null

  const baseCodec = createJsonSessionCodec()
  core = createSessionCore({
    designHome: home,
    fileAccess: {
      pickOpen: async () => ({ kind: 'cancelled' }),
      pickHomeTarget: async (name) => pickHomeTarget(name),
    },
    lifecycle: { subscribe: () => () => {} },
    codec: {
      async decode(bytes) {
        if (decodeGate) await decodeGate(bytes)
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as CanopiFile & { __savedByVersion?: number }
        if (parsed.__savedByVersion) {
          const { __savedByVersion, ...rest } = parsed
          return { file: rest, readOnly: true, savedByVersion: __savedByVersion }
        }
        return { file: parsed }
      },
      encode: baseCodec.encode,
    },
    settings: {
      readLastOpenHome: async () => null,
      writeLastOpenHome: async () => {},
    },
    newDesignFactory: () => makeFile('Untitled'),
    initialDesign: {
      home: { kind: 'file', key: '/designs/current.canopi', displayName: 'Current', version: 'v-current' },
      file: initialFile,
    },
  })
  disposeCore = installLiveSessionCore(core)

  runtime = new SceneCanvasRuntime({
    appAdapter: {
      ...createDetachedCanvasRuntimeAppAdapter(),
      isReadOnly: () => designSessionStore.isReadOnly(),
      sceneSession: {
        canUndo: core.canUndo,
        canRedo: core.canRedo,
        recordSceneEdit: (label, command) => { core.recordSceneEdit(label, command) },
        undo: () => { core.undo() },
        redo: () => { core.redo() },
        remapSceneCommands: (map) => { core.remapSceneCommands(map) },
      },
    },
  })
  core.attachScene(scenePortOf(runtime.documentSurface))
}

function seedNewer(name = 'Orchard 2.1', plantCount = 3): FileGrantId {
  const grant: FileGrantId = `/designs/${name}.canopi`
  const payload = { ...makeFile(name, plantCount), __savedByVersion: 10 }
  home.files.set(grant, {
    bytes: new TextEncoder().encode(JSON.stringify(payload)),
    version: `v-${name}`,
    updatedAt: new Date().toISOString(),
    name,
  })
  return grant
}

function openNewer(name = 'Orchard 2.1', plantCount = 3) {
  const grant = seedNewer(name, plantCount)
  return core.openFrom({ kind: 'file', grant })
}

function plantCount(): number {
  return runtime.querySurface.getSceneSnapshot().plants.length
}

beforeEach(() => {
  openEditing()
})

afterEach(() => {
  core.detachScene()
  runtime.destroy()
  disposeCore?.()
  disposeCore = null
})

describe('the read-only Session kind (canopi-f47t.52.270)', () => {
  it('A newer Design opens in the read-only view outside the editing Session', async () => {
    const result = await openNewer('Orchard 2.1', 3)

    expect(result.status).toBe('opened')
    expect(designSessionStore.sessionKind.value).toEqual({ kind: 'read-only', origin: 'newer-version', savedByVersion: 10 })
    expect(designSessionStore.readDesignName()).toBe('Orchard 2.1')
    expect(plantCount()).toBe(3)
    expect(designSessionStore.holdsNewerReadView()).toBe(true)
    expect(designSaveStatus.value).toBe('read-only')
    expect(designRevertAvailable.value).toBe(false)
    expect(core.dirty.value).toBe(false)
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it("the app's canvas adapter answers the Design session's read-only state, which the Scene authority refuses edits on", async () => {
    const adapter = createAppCanvasRuntimeAppAdapter({ presentationData: {} })
    expect(adapter.isReadOnly?.()).toBe(false)
    await openNewer('Orchard 2.1', 3)
    expect(adapter.isReadOnly?.()).toBe(true)
    await closeDesign()
    expect(adapter.isReadOnly?.()).toBe(false)
  })

  it('Design Edit refuses edits, rename and reconcile on a read-only Design', async () => {
    await openNewer()
    const authority = defaultDesignEditAuthority()

    expect(authority.editCommitted((design) => ({ ...design, description: 'edited' }))).toBeNull()
    expect(authority.renameDesign('Renamed')).toBe(false)
    expect(authority.reconcileCommitted((design) => ({ ...design, description: 'reconciled' }))).toBeNull()

    expect(designSessionStore.readCurrentDesign()?.description).toBeNull()
    expect(designSessionStore.readDesignName()).toBe('Orchard 2.1')
    expect(designSessionStore.isDesignDirty()).toBe(false)
  })

  it('the Scene refuses edits: Duplicate, Delete or Undo leaves the shown Design; a selection still applies', async () => {
    await openNewer('Orchard 2.1', 3)
    const shown = runtime.querySurface.getSceneSnapshot()
    expect(runtime.cameraHost.frames.viewFrame.peek().mode).toBe('site')

    runtime.commandSurface.sceneEdits.selectAll()
    expect(runtime.querySurface.getSelection()).toHaveLength(3)
    runtime.commandSurface.sceneEdits.duplicateSelected()
    runtime.commandSurface.sceneEdits.deleteSelected()

    expect(runtime.querySurface.getSceneSnapshot()).toEqual(shown)
    expect(plantCount()).toBe(3)
    expect(core.canUndo.value).toBe(false)
    core.undo()
    expect(runtime.querySurface.getSceneSnapshot()).toEqual(shown)

    // The same Delete removes an editing Design's plants: the read-only refusal, not the view, kept them.
    await closeDesign()
    home.seedFile('/designs/mine.canopi', makeFile('Mine', 2), 'v-mine')
    await core.openFrom({ kind: 'file', grant: '/designs/mine.canopi' })
    runtime.commandSurface.sceneEdits.selectAll()
    runtime.commandSurface.sceneEdits.deleteSelected()
    expect(plantCount()).toBe(0)
    expect(core.canUndo.value).toBe(true)
  })

  it('runs no continuous save or focus-lost flush on a read-only Design', async () => {
    vi.useFakeTimers()
    try {
      await openNewer()
      runtime.commandSurface.sceneEdits.selectAll()
      runtime.commandSurface.sceneEdits.deleteSelected()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(core.dirty.value).toBe(false)
      expect(core.pendingWrite.value).toBe(false)
      await expect(core.flushNow()).resolves.toBe(true)
      await core.handleLifecycle({ kind: 'focus-lost' })
      expect(designSaveStatus.value).toBe('read-only')
      expect(writeSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Save, Save As and Revert are off: nothing is written and no path is asked for', async () => {
    await openNewer()

    await expect(saveCurrentDesign()).resolves.toBe(false)
    await expect(saveCurrentDesignEdits()).resolves.toBe(false)
    await expect(saveAsCurrentDesign()).resolves.toBeNull()
    await expect(core.revert()).resolves.toBe('unavailable')

    expect(pickHomeTarget).not.toHaveBeenCalled()
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('reader release: closing the read-only view leaves no scene or Document state for the next Design', async () => {
    await openNewer('Orchard 2.1', 3)
    expect(core.canUndo.value).toBe(false)

    await expect(core.close('close')).resolves.toBe('closed')

    expect(writeSpy).not.toHaveBeenCalled()
    expect(designSessionStore.readCurrentDesign()).toBeNull()
    expect(designSessionStore.sessionKind.value).toEqual({ kind: 'editing' })
    expect(designSessionStore.isDesignDirty()).toBe(false)
    expect(core.canUndo.value).toBe(false)

    // The next Design is an editing session with its own home and nothing of the read-only one.
    home.seedFile('/designs/next.canopi', makeFile('Next', 1), 'v-next')
    await core.openFrom({ kind: 'file', grant: '/designs/next.canopi' })
    expect(designSessionStore.sessionKind.value).toEqual({ kind: 'editing' })
    expect(plantCount()).toBe(1)
    expect(core.canUndo.value).toBe(false)
    expect(core.document('edit-desc', () => ({ description: 'mine' }))).not.toBeNull()
    await expect(core.flushNow()).resolves.toBe(true)
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy.mock.calls[0]?.[0]).toBe('/designs/next.canopi')
  })

  it('opening a newer Design writes the editing Design home first, then writes nothing for the newer Design', async () => {
    core.document('last-edit', () => ({ description: 'last edit' }))

    await openNewer()

    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy.mock.calls[0]?.[0]).toBe('/designs/current.canopi')
    writeSpy.mockClear()
    await expect(core.flushNow()).resolves.toBe(true)
    expect(writeSpy).not.toHaveBeenCalled()
  })

  describe('failure states', () => {
    it('another open while a decode is pending: the pending result is discarded and the newer open wins', async () => {
      const gate = deferred<void>()
      let gatedOnce = true
      decodeGate = async () => {
        if (gatedOnce) {
          gatedOnce = false
          await gate.promise
        }
      }
      const newerGrant = seedNewer('Too late', 3)
      const pending = core.openFrom({ kind: 'file', grant: newerGrant })
      await Promise.resolve()

      home.seedFile('/designs/other.canopi', makeFile('Other', 2), 'v-other')
      const other = core.openFrom({ kind: 'file', grant: '/designs/other.canopi' })
      gate.resolve()

      await expect(other).resolves.toMatchObject({ status: 'opened' })
      await expect(pending).resolves.toEqual({ status: 'cancelled' })
      expect(designSessionStore.readDesignName()).toBe('Other')
      expect(designSessionStore.sessionKind.value).toEqual({ kind: 'editing' })
      expect(plantCount()).toBe(2)
    })

    it('file changed or removed on disk while shown: nothing is written, and Close asks nothing', async () => {
      await openNewer()
      home.setWriteResult({ kind: 'conflict', current: null })

      await expect(core.flushNow()).resolves.toBe(true)
      expect(core.currentDesign.value?.save).toEqual({ kind: 'idle' })
      expect(designSaveStatus.value).toBe('read-only')
      await expect(core.close('close')).resolves.toBe('closed')
      expect(writeSpy).not.toHaveBeenCalled()
    })
  })
})
