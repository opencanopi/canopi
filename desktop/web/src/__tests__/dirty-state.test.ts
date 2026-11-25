/**
 * Document dirty-state lifecycle tests (SessionCore single-authority model, 2b-3).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { SceneCommand } from '../canvas/runtime/scene-commands'
import type { CanopiFile } from '../types/design'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import { designDirty, resetDirtyBaselines } from './support/design-session-state'
import { createTestSessionCore, type TestSessionCoreHandle } from './support/session-core-fixture'

function noop(): SceneCommand {
  return {
    type: 'test',
    before: {},
    after: {},
  }
}

function baseDesign(): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Dirty Test',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-04-02T00:00:00.000Z',
    updated_at: '2026-04-02T00:00:00.000Z',
    extra: {},
  }
}

let handle: TestSessionCoreHandle

beforeEach(() => {
  handle = createTestSessionCore({
    file: baseDesign(),
    path: '/designs/dirty-test.canopi',
    name: 'Dirty Test',
  })
  handle.core.attachScene({
    serialize: () => ({
      plant_species_colors: {},
      layers: [],
      plants: [],
      zones: [],
      annotations: [],
      groups: [],
    }),
    load: () => {},
    replay: () => {},
  })
})

afterEach(() => {
  handle.dispose()
})

describe('dirty state after open/new', () => {
  it('is clean after opening a design', () => {
    expect(designDirty.value).toBe(false)
  })

  it('is clean after resetDirtyBaselines', () => {
    resetDirtyBaselines()
    expect(designDirty.value).toBe(false)
  })
})

describe('canvas edits', () => {
  it('single edit makes dirty', () => {
    handle.core.recordSceneEdit('test', noop())
    expect(designDirty.value).toBe(true)
  })

  it('history record/undo/redo reconcile history and dirty state', async () => {
    handle.core.recordSceneEdit('test', noop())
    expect(handle.core.canUndo.value).toBe(true)
    expect(designDirty.value).toBe(true)
    handle.core.undo()
    expect(handle.core.canUndo.value).toBe(false)
    expect(handle.core.canRedo.value).toBe(true)
    expect(await handle.core.flushNow()).toBe(true)
    expect(designDirty.value).toBe(false)
    handle.core.redo()
    expect(handle.core.canUndo.value).toBe(true)
    expect(handle.core.canRedo.value).toBe(false)
  })

  it('history record marks dirty', () => {
    const cmd: SceneCommand = {
      type: 'recorded-test',
      before: {},
      after: {},
    }

    handle.core.recordSceneEdit('recorded-test', cmd)

    expect(designDirty.value).toBe(true)
  })

  it('save clears dirty', async () => {
    handle.core.recordSceneEdit('test', noop())
    expect(designDirty.value).toBe(true)
    expect(await handle.core.flushNow()).toBe(true)
    expect(designDirty.value).toBe(false)
  })

  it('undo schedules a save and flushing clears dirty', async () => {
    expect(await handle.core.flushNow()).toBe(true)
    handle.core.recordSceneEdit('test', noop())
    expect(designDirty.value).toBe(true)
    handle.core.undo()
    expect(handle.core.canUndo.value).toBe(false)
    expect(await handle.core.flushNow()).toBe(true)
    expect(designDirty.value).toBe(false)
  })

  it('redo after undo makes dirty again', async () => {
    expect(await handle.core.flushNow()).toBe(true)
    handle.core.document('edit', () => ({ description: 'changed' }))
    handle.core.undo()
    expect(await handle.core.flushNow()).toBe(true)
    expect(designDirty.value).toBe(false)
    handle.core.redo()
    expect(designDirty.value).toBe(true)
  })

  it('dirty survives beyond 500 operations (the cap bug)', async () => {
    expect(await handle.core.flushNow()).toBe(true)

    for (let i = 0; i < 501; i++) {
      handle.core.recordSceneEdit('test', noop())
    }

    expect(designDirty.value).toBe(true)

    expect(await handle.core.flushNow()).toBe(true)
    expect(designDirty.value).toBe(false)
    handle.core.recordSceneEdit('test', noop())
    expect(designDirty.value).toBe(true)
  })

  it('save at cap boundary then undo and flush works', async () => {
    for (let i = 0; i < 500; i++) {
      handle.core.recordSceneEdit('test', noop())
    }
    expect(await handle.core.flushNow()).toBe(true)
    expect(designDirty.value).toBe(false)

    handle.core.recordSceneEdit('test', noop())
    expect(designDirty.value).toBe(true)
    handle.core.undo()
    expect(await handle.core.flushNow()).toBe(true)
    expect(designDirty.value).toBe(false)
  })
})

describe('non-canvas edits (timeline/budget/consortium)', () => {
  it('non-canvas edit makes dirty', () => {
    handle.core.document('rename', () => ({ name: 'Updated' }))
    expect(designDirty.value).toBe(true)
  })

  it('save clears non-canvas dirty', async () => {
    handle.core.document('rename', () => ({ name: 'Updated' }))
    expect(await handle.core.flushNow()).toBe(true)
    expect(designDirty.value).toBe(false)
  })

  it('canvas undo to clean does not clear non-canvas dirty', () => {
    handle.core.document('rename', () => ({ name: 'Updated' }))
    handle.core.recordSceneEdit('test', noop())
    handle.core.undo()

    // Still dirty because the non-canvas edit remains unsaved
    expect(designDirty.value).toBe(true)
  })
})

describe('mixed edit sources', () => {
  it('save clears both canvas and non-canvas dirty', async () => {
    handle.core.recordSceneEdit('test', noop())
    handle.core.document('rename', () => ({ name: 'Updated' }))
    expect(designDirty.value).toBe(true)
    expect(await handle.core.flushNow()).toBe(true)
    expect(designDirty.value).toBe(false)
  })

  it('resetDirtyBaselines clears everything', () => {
    handle.core.recordSceneEdit('test', noop())
    handle.core.document('rename', () => ({ name: 'Updated' }))
    expect(designDirty.value).toBe(true)
    resetDirtyBaselines()
    expect(designDirty.value).toBe(false)
  })
})
