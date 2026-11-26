import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDesign } from '../app/document-session/actions'
import { designSessionStore } from '../app/document-session/store'
import { SceneStore } from '../canvas/runtime/scene'
import type { CanopiFile } from '../types/design'
import { createTestSessionCore, type TestSessionCoreHandle } from './support/session-core-fixture'
import { currentDesign } from './support/design-session-state'

function makeFile(name: string, plantCount = 0): CanopiFile {
  return {
    version: 10,
    name,
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: [],
    plants: Array.from({ length: plantCount }, (_, index) => ({
      id: `plant-${index}`,
      canonical_name: 'Malus domestica',
      common_name: null,
      color: null,
      position: { lon: 2 + index * 1e-5, lat: 48 },
      rotation: null,
      canopy_spread_m: null,
      notes: null,
      planted_date: null,
      quantity: null,
      locked: false,
    })),
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
}

let handle: TestSessionCoreHandle
let sceneStore: SceneStore

function openCurrent(file = makeFile('Current', 2)): void {
  handle?.dispose()
  sceneStore = new SceneStore().hydrate(file)
  handle = createTestSessionCore({
    file,
    path: '/designs/current.canopi',
    name: 'Current',
    newDesignFactory: () => makeFile('Untitled'),
  })
  handle.core.attachScene({
    serialize: () => {
      const f = sceneStore.toCanopiFile()
      return {
        plants: f.plants,
        zones: f.zones,
        annotations: f.annotations,
        measurement_guides: f.measurement_guides ?? [],
        groups: f.groups,
        layers: f.layers,
        plant_species_colors: f.plant_species_colors,
        plant_species_symbols: f.plant_species_symbols ?? {},
        plant_species_codes: f.plant_species_codes ?? {},
      }
    },
    load: (next) => {
      sceneStore.hydrate(next as CanopiFile)
    },
    replay: () => {},
  })
}

function makeDirty(description: string): void {
  handle.core.document('edit-description', () => ({ description }))
  handle.core.recordSceneEdit('test-edit', { type: 'test-edit', before: {}, after: {} })
}

beforeEach(() => {
  openCurrent()
})

afterEach(() => {
  handle?.dispose()
})

describe('Desktop Close Design', () => {
  it('writes pending changes home, then empties the store and undo history', async () => {
    makeDirty('last edit')
    expect(handle.core.canUndo.value).toBe(true)

    const result = await handle.core.close('close')

    expect(result).toBe('closed')
    const written = handle.home.files.get('/designs/current.canopi')
    expect(written).toBeDefined()
    expect(JSON.parse(new TextDecoder().decode(written!.bytes))).toMatchObject({ description: 'last edit' })

    expect(designSessionStore.readCurrentDesign()).toBeNull()
    expect(designSessionStore.readDesignPath()).toBeNull()
    expect(designSessionStore.isDesignDirty()).toBe(false)
    expect(handle.core.canUndo.value).toBe(false)
  })

  it('ends continuous save: the closed Design home is never written again', async () => {
    vi.useFakeTimers()
    try {
      await handle.core.close('close')
      const writeSpy = vi.spyOn(handle.home, 'write')

      expect(handle.core.currentDesign.value).toBeNull()
      expect(handle.core.revertAvailable.value).toBe(false)
      await expect(handle.core.flushNow()).resolves.toBe(true)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(writeSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks when the write fails; Cancel keeps the Design open and Discard closes it', async () => {
    makeDirty('unwritable')
    handle.home.setWriteResult({
      kind: 'failed',
      failure: { code: { kind: 'io', io: 'other' }, op: 'design.write', operation: 'design.write' as never, detail: 'disk full' as never, user_may_retry: true },
    })

    const readQuestion = () => {
      const state = handle.core.state.value
      return state.kind === 'closing' || state.kind === 'replacing' ? state.question ?? null : null
    }

    const closing = handle.core.close('close')
    await vi.waitFor(() => {
      expect(readQuestion()).not.toBeNull()
    })
    const q1 = readQuestion()!
    expect(q1.purpose).toBe('close')
    handle.core.answer(q1.id, 'cancel')

    await expect(closing).resolves.toBe('cancelled')
    expect(designSessionStore.readCurrentDesign()?.description).toBe('unwritable')
    expect(handle.core.canUndo.value).toBe(true)

    const closingAgain = handle.core.close('close')
    await vi.waitFor(() => {
      expect(readQuestion()).not.toBeNull()
    })
    handle.core.answer(readQuestion()!.id, 'discard')

    await expect(closingAgain).resolves.toBe('closed')
    expect(designSessionStore.readCurrentDesign()).toBeNull()
    expect(handle.core.canUndo.value).toBe(false)
  })

  it('does nothing when no Design is open', async () => {
    await handle.core.close('close')
    await expect(handle.core.close('close')).resolves.toBe('closed')
    expect(designSessionStore.readCurrentDesign()).toBeNull()
  })

  it('opens and creates Designs normally after a close', async () => {
    await handle.core.close('close')
    const opened = makeFile('Opened', 1)
    handle.home.seedFile('/designs/opened.canopi', opened, 'v-opened')

    const result = await handle.core.openFrom({ kind: 'file', grant: '/designs/opened.canopi' })

    expect(result.status).toBe('opened')
    expect(designSessionStore.readDesignName()).toBe('Opened')
    expect(sceneStore.persisted.plants.length).toBe(1)

    await handle.core.close('close')
    const created = await handle.core.createNew()
    expect(created.status).toBe('opened')
    expect(designSessionStore.readDesignName()).toBe('Untitled')
    expect(handle.core.currentDesign.value?.home.kind).toBe('draft')
  })

  it('closes a Design while no Canvas is attached', async () => {
    handle.dispose()
    handle = createTestSessionCore({ file: makeFile('Detached'), path: null, name: 'Detached' })

    await expect(handle.core.close('close')).resolves.toBe('closed')
    expect(designSessionStore.readCurrentDesign()).toBeNull()
  })
})

describe('closeDesign action', () => {
  it('closes the current Design through the shared Desktop Design Session', async () => {
    await closeDesign()
    expect(currentDesign.value).toBeNull()
  })
})
