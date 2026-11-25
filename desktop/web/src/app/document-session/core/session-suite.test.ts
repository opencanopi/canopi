/**
 * app/document-session/core/session-suite.test.ts: Comprehensive behavioral suite for the
 * single-authority SessionCore & write-lane (2b-3, ADR 0024, contracts §4, B1.1, B1.5, T7).
 */
import { describe, expect, it, vi } from 'vitest'
import { makeTestDesign } from '../../../__tests__/support/session-core-fixture'
import type { SceneCommand } from '../../../canvas/runtime/scene-commands'
import type { Failure } from '../../../generated/contracts'
import type {
  DesignHome,
  DesignHomeStore,
  DesignHomeWriteResult,
  DraftId,
  FileGrantId,
  HomeRead,
  HomeVersion,
} from '../../../platform/design-home'
import type { FileAccessPort, PickFileOutcome } from '../../../platform/file-access'
import type { CanopiFile } from '../../../types/design'
import type { DeepReadonly } from './immutable'
import { createSessionCore, type ScenePort, type SessionCoreCodec } from './session-core'

function makeDesign(name = 'Orchard', overrides: Partial<CanopiFile> = {}): CanopiFile {
  return makeTestDesign({
    version: 10,
    name,
    lidar: null,
    extra: { plant_display: { labels: 'names', symbol_scale: 1 } },
    ...overrides,
  })
}

function makeFakeScenePort(initialPlants: CanopiFile['plants'] = []) {
  let plants = [...initialPlants]
  const loaded: CanopiFile[] = []
  const replayed: Array<{ command: SceneCommand; direction: 'undo' | 'redo' }> = []
  const port: ScenePort = {
    serialize: () => ({
      plants: [...plants], zones: [], layers: [], annotations: [], measurement_guides: [], groups: [],
      site_location: null, site_elevation_m: null,
    }) as unknown as ReturnType<ScenePort['serialize']>,
    load: (file) => { loaded.push(file as CanopiFile); plants = [...(file.plants ?? [])] },
    replay: (command, direction) => { replayed.push({ command, direction }) },
  }
  return {
    port, loaded, replayed,
    getPlants: () => plants,
    setPlants: (next: CanopiFile['plants']) => { plants = [...next] },
    addPlant: (id: string) => {
      plants = [...plants, {
        id, canonical_name: 'Malus domestica', common_name: null, color: null,
        position: { lon: 2.35, lat: 48.85 }, rotation: null, scale: null, notes: null, planted_date: null, quantity: null,
      } as CanopiFile['plants'][number]]
    },
  }
}

type WriteOpts = { readonly keepPrevious?: boolean } | undefined

function makeSuiteHarness(options: {
  readonly flushDelayMs?: number
  readonly admitWrite?: (file: Readonly<CanopiFile>) => string | null
  readonly decodeDelay?: () => Promise<void>
} = {}) {
  const files = new Map<string, { bytes: Uint8Array; version: HomeVersion; updatedAt: string }>()
  let seq = 1
  const writes: Array<{ key: string; bytes: Uint8Array; expected: HomeVersion | null; opts?: WriteOpts }> = []
  let writeHook: ((
    key: string, bytes: Uint8Array, expected: HomeVersion | null, opts?: WriteOpts,
  ) => Promise<DesignHomeWriteResult | null> | DesignHomeWriteResult | null) | null = null
  let nextPickTarget: PickFileOutcome = { kind: 'cancelled' }
  let lastHome: DesignHome | null = null
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const designHome: DesignHomeStore = {
    async read(key: string): Promise<HomeRead> {
      const entry = files.get(key)
      return entry ? { kind: 'present', bytes: Array.from(entry.bytes), version: entry.version } : { kind: 'absent' }
    },
    async write(key, bytes, expected, opts): Promise<DesignHomeWriteResult> {
      writes.push({ key, bytes: new Uint8Array(bytes), expected, ...(opts !== undefined ? { opts } : {}) })
      if (writeHook) {
        const custom = await writeHook(key, bytes, expected, opts)
        if (custom) return custom
      }
      const existing = files.get(key)
      if (expected === null) {
        if (existing) return { kind: 'conflict', current: existing.version }
      } else if (!existing || existing.version !== expected) {
        return { kind: 'conflict', current: existing?.version ?? null }
      }
      const version = `v-${++seq}`
      files.set(key, { bytes: new Uint8Array(bytes), version, updatedAt: new Date().toISOString() })
      return { kind: 'written', version }
    },
    async listDrafts() {
      return [...files.entries()].map(([id, entry]) => ({ id: id as DraftId, updatedAt: entry.updatedAt, bytes: entry.bytes }))
    },
    async deleteDraft(id) { files.delete(id); return { ok: true as const } },
    onVersionChange: () => () => {},
  }

  const fileAccess: FileAccessPort = {
    async pickOpen() { return { kind: 'cancelled' } },
    async pickHomeTarget() { return nextPickTarget },
  }
  const codec: SessionCoreCodec = {
    async decode(bytes) {
      if (options.decodeDelay) await options.decodeDelay()
      const parsed = JSON.parse(decoder.decode(bytes)) as CanopiFile
      return { file: parsed, migratedFrom: parsed.version < 10 ? parsed.version : null }
    },
    async encode(file) {
      const bytes = encoder.encode(JSON.stringify(file))
      let hash = 0
      for (const b of bytes) hash = ((hash * 31) + b) >>> 0
      return { bytes, version: `sha-${hash.toString(16).padStart(8, '0')}` }
    },
    ...(options.admitWrite ? { admitWrite: (f) => options.admitWrite!(f as CanopiFile) } : {}),
  }

  const core = createSessionCore({
    designHome, fileAccess, lifecycle: { subscribe: () => () => {} }, codec,
    settings: { readLastOpenHome: async () => null, writeLastOpenHome: async (h) => { lastHome = h } },
    newDesignFactory: () => makeDesign('Untitled'), flushDelayMs: options.flushDelayMs ?? 1_500,
  })
  return {
    core, files, writes, getLastHome: () => lastHome,
    setWriteHook: (fn: typeof writeHook) => { writeHook = fn },
    setPickTarget: (outcome: PickFileOutcome) => { nextPickTarget = outcome },
    seedFile: (key: string, file: CanopiFile, version?: HomeVersion) => {
      const v = version ?? `v-${++seq}`
      files.set(key, { bytes: encoder.encode(JSON.stringify(file)), version: v, updatedAt: new Date().toISOString() })
      return v
    },
    readFileJson: (key: string): CanopiFile => {
      const entry = files.get(key)
      if (!entry) throw new Error(`Missing file ${key}`)
      return JSON.parse(decoder.decode(entry.bytes)) as CanopiFile
    },
  }
}

function makeGatedHarness() {
  let releaseDecode: (() => void) | null = null
  let gateNext = false
  const h = makeSuiteHarness({
    decodeDelay: async () => {
      if (gateNext) {
        gateNext = false
        await new Promise<void>((r) => { releaseDecode = r })
      }
    },
  })
  return {
    h,
    armGate: () => { gateNext = true },
    waitForGate: () => vi.waitFor(() => expect(releaseDecode).not.toBeNull()),
    release: () => { releaseDecode!() },
  }
}

describe('SessionCore continuous-save & write-lane behaviors', () => {
  it('debounces rapid edits into a single write after flushDelayMs', async () => {
    vi.useFakeTimers()
    try {
      const h = makeSuiteHarness({ flushDelayMs: 500 })
      const grant = '/designs/debounced.canopi' as FileGrantId
      h.seedFile(grant, makeDesign('Init'))
      await h.core.openFrom({ kind: 'file', grant })

      h.core.document('edit-1', () => ({ name: 'A' }))
      await vi.advanceTimersByTimeAsync(200)
      h.core.document('edit-2', () => ({ name: 'B' }))
      await vi.advanceTimersByTimeAsync(200)
      h.core.document('edit-3', () => ({ name: 'C' }))
      expect(h.writes).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(500)
      expect(h.writes).toHaveLength(1)
      expect(h.readFileJson(grant).name).toBe('C')
      expect(h.core.dirty.value).toBe(false)
      h.core.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushNow writes immediately and loops if another edit lands while a write is in flight', async () => {
    const h = makeSuiteHarness({ flushDelayMs: 5_000 })
    const grant = '/designs/inflight.canopi' as FileGrantId
    h.seedFile(grant, makeDesign('Start'))
    await h.core.openFrom({ kind: 'file', grant })

    let releaseFirst!: () => void
    let paused = false
    h.setWriteHook(async () => {
      if (!paused) {
        paused = true
        await new Promise<void>((r) => { releaseFirst = r })
      }
      return null
    })

    h.core.document('e1', () => ({ name: 'First' }))
    const flushing = h.core.flushNow()
    await vi.waitFor(() => expect(paused).toBe(true))

    // Second edit lands while the first write is still in flight.
    h.core.document('e2', () => ({ name: 'Second' }))
    releaseFirst()
    expect(await flushing).toBe(true)

    expect(h.writes).toHaveLength(2)
    expect(h.readFileJson(grant).name).toBe('Second')
    expect(h.core.dirty.value).toBe(false)
    h.core.dispose()
  })

  it('sets busy save state on busy failure and succeeds on retry', async () => {
    const h = makeSuiteHarness({ flushDelayMs: 100 })
    const grant = '/designs/busy.canopi' as FileGrantId
    h.seedFile(grant, makeDesign('Busy'))
    await h.core.openFrom({ kind: 'file', grant })

    let failOnce = true
    h.setWriteHook(() => {
      if (failOnce) {
        failOnce = false
        return {
          kind: 'failed',
          failure: { code: { kind: 'busy' }, user_may_retry: true, op: 'design.write', operation: null, detail: null } as unknown as Failure,
        }
      }
      return null
    })

    h.core.document('e1', () => ({ name: 'AfterBusy' }))
    expect(await h.core.flushNow()).toBe(false)
    expect(h.core.currentDesign.value?.save).toEqual({ kind: 'busy' })

    expect(await h.core.flushNow()).toBe(true)
    expect(h.core.dirty.value).toBe(false)
    expect(h.core.currentDesign.value?.save).toEqual({ kind: 'idle' })
    expect(h.readFileJson(grant).name).toBe('AfterBusy')
    h.core.dispose()
  })

  it('resolves write conflict via keep-mine and via save-as', async () => {
    const h = makeSuiteHarness()
    const grantA = '/designs/conflict.canopi' as FileGrantId
    const grantB = '/designs/conflict-copy.canopi' as FileGrantId
    h.seedFile(grantA, makeDesign('Original'))
    await h.core.openFrom({ kind: 'file', grant: grantA })

    // External modification causes conflict.
    h.seedFile(grantA, makeDesign('ExternalChange'), 'v-external-1')
    h.core.document('local-1', () => ({ name: 'Mine1' }))
    expect(await h.core.flushNow()).toBe(false)
    expect(h.core.currentDesign.value?.save).toEqual({ kind: 'conflict', current: 'v-external-1' })

    // Resolve with keep-mine -> writes with expected = v-external-1.
    expect(await h.core.resolveConflict('keep-mine')).toBe('resolved')
    expect(h.readFileJson(grantA).name).toBe('Mine1')
    expect(h.core.dirty.value).toBe(false)

    // Second external modification -> resolve with save-as to a new home.
    h.seedFile(grantA, makeDesign('ExternalChange2'), 'v-external-2')
    h.core.document('local-2', () => ({ name: 'MineCopy' }))
    expect(await h.core.flushNow()).toBe(false)
    expect(h.core.currentDesign.value?.save).toEqual({ kind: 'conflict', current: 'v-external-2' })

    h.setPickTarget({ kind: 'picked', grant: grantB, displayName: 'conflict-copy.canopi' })
    expect(await h.core.resolveConflict('save-as')).toBe('resolved')
    expect(h.core.currentDesign.value?.home.key).toBe(grantB)
    expect(h.readFileJson(grantB).name).toBe('MineCopy')
    h.core.dispose()
  })

  it('lost-ack adoption: adopts stored write when conflict bytes match in-flight write (case 16)', async () => {
    const h = makeSuiteHarness()
    const grant = '/designs/lost-ack.canopi' as FileGrantId
    h.seedFile(grant, makeDesign('Before'))
    await h.core.openFrom({ kind: 'file', grant })

    h.core.document('edit', () => ({ name: 'PersistedDespiteLostAck' }))
    h.setWriteHook((key, bytes) => {
      h.files.set(key, { bytes: new Uint8Array(bytes), version: 'v-lost-ack', updatedAt: new Date().toISOString() })
      return { kind: 'conflict', current: 'v-lost-ack' }
    })

    expect(await h.core.flushNow()).toBe(true)
    expect(h.core.dirty.value).toBe(false)
    expect(h.core.currentDesign.value?.home.version).toBe('v-lost-ack')
    expect(h.core.currentDesign.value?.save).toEqual({ kind: 'idle' })
    h.core.dispose()
  })

  it('pre-upgrade copy_blocked -> saveWithoutCopy clears migratedFrom, and quota_refused keeps Design in memory', async () => {
    const h = makeSuiteHarness()
    const grant = '/designs/v9.canopi' as FileGrantId
    h.seedFile(grant, makeDesign('LegacyV9', { version: 9 }))
    await h.core.openFrom({ kind: 'file', grant })
    expect(h.core.currentDesign.value?.migratedFrom).toBe(9)

    h.core.document('edit', () => ({ name: 'Upgraded' }))
    h.setWriteHook((_k, _b, _e, opts) => (opts?.keepPrevious ? { kind: 'copy_blocked', folder: 'Documents' } : null))
    expect(await h.core.flushNow()).toBe(false)
    expect(h.core.currentDesign.value?.save).toEqual({ kind: 'copy_blocked', folder: 'Documents' })

    expect(await h.core.saveWithoutCopy()).toBe(true)
    expect(h.core.currentDesign.value?.migratedFrom).toBeNull()
    expect(h.readFileJson(grant).name).toBe('Upgraded')

    // Quota refusal
    h.core.document('edit-quota', () => ({ name: 'TooBig' }))
    h.setWriteHook(() => ({ kind: 'quota_refused' }))
    expect(await h.core.flushNow()).toBe(false)
    expect(h.core.currentDesign.value?.save).toEqual({ kind: 'quota' })
    expect(h.core.currentDesign.value?.document.name).toBe('TooBig')
    h.core.dispose()
  })

  it('case 11: write-admission refusal refuses before touching DesignHomeStore', async () => {
    const h = makeSuiteHarness({
      admitWrite: (file) => (file.name === 'FORBIDDEN' ? 'invalid_design_payload' : null),
    })
    const grant = '/designs/admit.canopi' as FileGrantId
    h.seedFile(grant, makeDesign('Valid'))
    await h.core.openFrom({ kind: 'file', grant })

    h.core.document('bad', () => ({ name: 'FORBIDDEN' }))
    expect(await h.core.flushNow()).toBe(false)
    expect(h.core.currentDesign.value?.save).toEqual({ kind: 'refused', reason: 'invalid_design_payload' })
    expect(h.writes).toHaveLength(0)
    h.core.dispose()
  })
})

describe('Replacement-during-load variants (edit landing during slow load is written before next Design opens)', () => {
  it('variant 1 (Document edit): Document edit landing during a slow load is flushed before the next Design opens', async () => {
    const { h, armGate, waitForGate, release } = makeGatedHarness()
    const grantA = '/designs/a.canopi' as FileGrantId
    const grantB = '/designs/b.canopi' as FileGrantId
    h.seedFile(grantA, makeDesign('A'))
    h.seedFile(grantB, makeDesign('B'))

    await h.core.openFrom({ kind: 'file', grant: grantA })
    armGate()
    const openingB = h.core.openFrom({ kind: 'file', grant: grantB })
    await waitForGate()

    h.core.document('late-doc-edit', () => ({ description: 'edited-during-load' }))
    release()

    expect(await openingB).toMatchObject({ status: 'opened' })
    expect(h.core.currentDesign.value?.document.name).toBe('B')
    expect(h.readFileJson(grantA).description).toBe('edited-during-load')
    h.core.dispose()
  })

  it('variant 2 (Scene edit): Scene edit landing during a slow load is flushed before the next Design opens', async () => {
    const { h, armGate, waitForGate, release } = makeGatedHarness()
    const grantA = '/designs/scene-a.canopi' as FileGrantId
    const grantB = '/designs/scene-b.canopi' as FileGrantId
    h.seedFile(grantA, makeDesign('SceneA'))
    h.seedFile(grantB, makeDesign('SceneB'))

    const scene = makeFakeScenePort()
    await h.core.openFrom({ kind: 'file', grant: grantA })
    h.core.attachScene(scene.port)

    armGate()
    const openingB = h.core.openFrom({ kind: 'file', grant: grantB })
    await waitForGate()

    scene.addPlant('plant-during-load')
    h.core.recordSceneEdit('add-plant', { type: 'add-plant', before: {}, after: {} })
    release()

    expect(await openingB).toMatchObject({ status: 'opened' })
    expect(h.core.currentDesign.value?.document.name).toBe('SceneB')
    expect(h.readFileJson(grantA).plants.map((p) => p.id)).toEqual(['plant-during-load'])
    h.core.dispose()
  })

  it('variant 3 (reentrant-final-write): a second edit landing while the pre-replacement flush is in flight is also written before next Design opens', async () => {
    const { h, armGate, waitForGate, release } = makeGatedHarness()
    const grantA = '/designs/reentrant-a.canopi' as FileGrantId
    const grantB = '/designs/reentrant-b.canopi' as FileGrantId
    h.seedFile(grantA, makeDesign('A'))
    h.seedFile(grantB, makeDesign('B'))

    await h.core.openFrom({ kind: 'file', grant: grantA })
    armGate()
    const openingB = h.core.openFrom({ kind: 'file', grant: grantB })
    await waitForGate()

    let releaseFirstWrite!: () => void
    let pausedWrite = false
    h.setWriteHook(async () => {
      if (!pausedWrite) {
        pausedWrite = true
        await new Promise<void>((r) => { releaseFirstWrite = r })
      }
      return null
    })

    h.core.document('edit-1', () => ({ description: 'first-in-load' }))
    release()
    await vi.waitFor(() => expect(pausedWrite).toBe(true))

    h.core.document('edit-2', () => ({ description: 'second-during-flush' }))
    releaseFirstWrite()

    expect(await openingB).toMatchObject({ status: 'opened' })
    expect(h.core.currentDesign.value?.document.name).toBe('B')
    expect(h.readFileJson(grantA).description).toBe('second-during-flush')
    h.core.dispose()
  })
})

describe('B1.1 & B1.5: Save As persistence and Revert after Save As', () => {
  it('B1.1: Save As -> further Document & Scene edits -> flush -> close -> reopen preserves EVERY edit', async () => {
    const h = makeSuiteHarness()
    const scene = makeFakeScenePort()
    await h.core.createNew()
    h.core.attachScene(scene.port)

    const targetGrant = '/designs/saved-as.canopi' as FileGrantId
    h.setPickTarget({ kind: 'picked', grant: targetGrant, displayName: 'saved-as.canopi' })
    expect(await h.core.saveAs()).toBe('saved')

    // Further Document edit + Scene edit after Save As.
    h.core.document('rename-and-desc', () => ({ name: 'FullOrchard', description: 'persisted-doc-edit' }))
    scene.addPlant('apple-1')
    h.core.recordSceneEdit('place-apple', { type: 'place', before: {}, after: {} })
    scene.addPlant('pear-2')
    h.core.recordSceneEdit('place-pear', { type: 'place', before: {}, after: {} })

    expect(await h.core.flushNow()).toBe(true)
    expect(await h.core.close('close')).toBe('closed')
    expect(h.core.currentDesign.value).toBeNull()

    // Reopen and verify every Document and Scene edit survived.
    const reopened = await h.core.openFrom({ kind: 'file', grant: targetGrant })
    expect(reopened.status).toBe('opened')
    expect(h.core.currentDesign.value?.document.name).toBe('FullOrchard')
    expect(h.core.currentDesign.value?.document.description).toBe('persisted-doc-edit')
    expect(scene.getPlants().map((p) => p.id)).toEqual(['apple-1', 'pear-2'])
    expect(h.core.snapshot()?.plants.map((p) => p.id)).toEqual(['apple-1', 'pear-2'])
    h.core.dispose()
  })

  it('B1.5: Revert after Save As restores opened baseline at rev + 1 and writes to current home', async () => {
    const h = makeSuiteHarness()
    const origGrant = '/designs/orig.canopi' as FileGrantId
    const copyGrant = '/designs/copy.canopi' as FileGrantId
    const baselineFile = makeDesign('OriginalBaseline', { description: 'opened-state' })
    h.seedFile(origGrant, baselineFile)

    const scene = makeFakeScenePort()
    await h.core.openFrom({ kind: 'file', grant: origGrant })
    h.core.attachScene(scene.port)

    // Edit, then Save As to copyGrant, then edit again.
    h.core.document('e1', () => ({ name: 'EditedBeforeSaveAs', description: 'changed-1' }))
    h.setPickTarget({ kind: 'picked', grant: copyGrant, displayName: 'copy.canopi' })
    expect(await h.core.saveAs()).toBe('saved')

    h.core.document('e2', () => ({ name: 'EditedAfterSaveAs', description: 'changed-2' }))
    scene.addPlant('extra-plant')
    h.core.recordSceneEdit('add', { type: 'add', before: {}, after: {} })
    expect(await h.core.flushNow()).toBe(true)

    const revBefore = h.core.currentDesign.value!.rev
    expect(h.core.revertAvailable.value).toBe(true)
    expect(await h.core.revert()).toBe('reverted')

    expect(h.core.currentDesign.value?.rev).toBe(revBefore + 1)
    expect(h.core.currentDesign.value?.home.key).toBe(copyGrant)
    expect(h.core.currentDesign.value?.document.name).toBe('OriginalBaseline')
    expect(h.core.currentDesign.value?.document.description).toBe('opened-state')
    expect(scene.getPlants()).toEqual([])
    expect(h.core.canUndo.value).toBe(false)
    expect(h.core.dirty.value).toBe(true)

    expect(await h.core.flushNow()).toBe(true)
    expect(h.readFileJson(copyGrant).name).toBe('OriginalBaseline')
    expect(h.readFileJson(copyGrant).description).toBe('opened-state')
    expect(h.readFileJson(copyGrant).plants).toEqual([])
    h.core.dispose()
  })
})

describe('T7 per-family Document Undo (views, stories, budget, timeline, consortium, lidar, plant-display, rename)', () => {
  const FAMILIES: ReadonlyArray<{
    readonly family: string
    readonly patch: Partial<CanopiFile>
    readonly read: (file: DeepReadonly<CanopiFile>) => unknown
    readonly initial: unknown
    readonly updated: unknown
  }> = [
    {
      family: 'views',
      patch: { views: [{ id: 'v-1', name: 'North Slope' } as unknown as NonNullable<CanopiFile['views']>[number]] },
      read: (f) => (f.views ?? []).length,
      initial: 0,
      updated: 1,
    },
    {
      family: 'stories',
      patch: { stories: [{ id: 's-1', title: 'Year 1', steps: [] } as unknown as NonNullable<CanopiFile['stories']>[number]] },
      read: (f) => (f.stories ?? []).length,
      initial: 0,
      updated: 1,
    },
    {
      family: 'budget',
      patch: { budget: [{ id: 'b-1', item: 'Mulch', cost: 40 } as unknown as CanopiFile['budget'][number]] },
      read: (f) => f.budget.length,
      initial: 0,
      updated: 1,
    },
    {
      family: 'timeline',
      patch: { timeline: [{ id: 't-1', title: 'Planting', date: '2026-11-01' } as unknown as CanopiFile['timeline'][number]] },
      read: (f) => f.timeline.length,
      initial: 0,
      updated: 1,
    },
    {
      family: 'consortium',
      patch: { consortiums: [{ id: 'c-1', name: 'Apple Guild', members: [] } as unknown as CanopiFile['consortiums'][number]] },
      read: (f) => f.consortiums.length,
      initial: 0,
      updated: 1,
    },
    {
      family: 'lidar',
      patch: { lidar: { source: 'ign', visible: true } as unknown as NonNullable<CanopiFile['lidar']> },
      read: (f) => f.lidar != null,
      initial: false,
      updated: true,
    },
    {
      family: 'plant-display',
      patch: { extra: { plant_display: { labels: 'none', symbol_scale: 1.5 } } },
      read: (f) => f.extra?.plant_display,
      initial: { labels: 'names', symbol_scale: 1 },
      updated: { labels: 'none', symbol_scale: 1.5 },
    },
    {
      family: 'rename',
      patch: { name: 'Renamed Orchard' },
      read: (f) => f.name,
      initial: 'Orchard',
      updated: 'Renamed Orchard',
    },
  ]

  it.each(FAMILIES)('undoes and redoes %s Document edits cleanly', async ({ family, patch, read, initial, updated }) => {
    const h = makeSuiteHarness()
    const grant: FileGrantId = `/designs/t7-${family}.canopi`
    h.seedFile(grant, makeDesign('Orchard'))
    await h.core.openFrom({ kind: 'file', grant })

    expect(read(h.core.currentDesign.value!.document)).toEqual(initial)
    const id = h.core.document(`edit-${family}`, () => patch)
    expect(id).not.toBeNull()
    expect(read(h.core.currentDesign.value!.document)).toEqual(updated)
    expect(h.core.canUndo.value).toBe(true)

    expect(h.core.undo({ expect: id! }).status).toBe('applied')
    expect(read(h.core.currentDesign.value!.document)).toEqual(initial)
    expect(h.core.canRedo.value).toBe(true)

    expect(h.core.redo().status).toBe('applied')
    expect(read(h.core.currentDesign.value!.document)).toEqual(updated)
    h.core.dispose()
  })
})
