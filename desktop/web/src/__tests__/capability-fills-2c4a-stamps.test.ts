// Cross-module behavioural suite for 2c-4a Stamps, Calendar Undo, and Group Movement
// (docs/plans/2-1-foundations.md:345; 2.1-Q154, Q155, Q158, Q168, Q354, M88, M89, T1, T5, T6, T7).

import { afterEach, describe, expect, it } from 'vitest'
import { addTimelineAction, deleteTimelineAction } from '../app/design-edit/timeline'
import { designSessionStore } from '../app/document-session/store'
import { normalizeSelection } from '../app/saved-object-stamps/capture'
import { placeStampThroughCore } from '../app/saved-object-stamps/place'
import { createSavedObjectStampWorkbench } from '../app/saved-object-stamps/workbench'
import {
  SceneStore,
  type SceneDesignObjectTarget,
} from '../canvas/runtime/scene'
import { applySceneDragDeltaToDraft, captureSceneDragState, createSceneDragState } from '../canvas/runtime/scene-runtime/drag-state'
import { SceneRuntimeMutationController } from '../canvas/runtime/scene-runtime/mutations'
import {
  createDetachedSceneSessionAdapter,
  SceneRuntimeEditCoordinator,
} from '../canvas/runtime/scene-runtime/transactions'
import { placeSavedObjectStamp } from '../canvas/runtime/tools/saved-object-stamp'
import {
  mergeStampSpeciesCodes,
  parseSavedObjectStampPayload,
  SAVED_OBJECT_STAMP_PAYLOAD_V3_VERSION,
  serializeSavedObjectStampPayloadV3,
  type SavedObjectStampPayload,
} from '../canvas/saved-object-stamp-payload'
import { resetToastsForTests, toasts } from '../failures/toasts'
import type { ScenePort } from '../app/document-session/core/scene-half'
import type { SavedObjectStamp } from '../types/saved-object-stamps'
import { createTestSessionCore, makeTestDesign } from './support/session-core-fixture'
import { geoAt } from './support/geo-design'

const disposers: Array<() => void> = []

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.()
  resetToastsForTests()
})

function buildV3GuildStamp(): SavedObjectStampPayload {
  return {
    version: SAVED_OBJECT_STAMP_PAYLOAD_V3_VERSION,
    anchor: { x: 0, y: 0 },
    plants: [{
      id: 'sp-1',
      canonicalName: 'Castanea sativa',
      commonName: 'Sweet chestnut',
      color: '#2e7d32',
      symbol: 'canopy',
      position: { x: 1, y: 2 },
      rotationDeg: 0,
      scale: 6,
      locked: true,
      notes: 'Grafted cultivar',
    }],
    zones: [{
      id: 'sz-1',
      name: 'Chestnut bed',
      zoneType: 'rect',
      points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
      rotationDeg: 0,
      fillColor: '#4caf50',
      strokeColor: '#1b5e20',
      opacity: 0.6,
      notes: 'Mulch yearly',
    }],
    annotations: [{
      id: 'sa-1',
      annotationType: 'text',
      position: { x: 2, y: 2 },
      text: 'Irrigate',
      fontSize: 14,
      rotationDeg: null,
    }],
    measurementGuides: [{
      id: 'sg-1',
      start: { x: 0, y: 0 },
      end: { x: 4, y: 0 },
      locked: true,
    }],
    groups: [{
      id: 'sgrp-1',
      name: 'Guild',
      members: [{ kind: 'plant', id: 'sp-1' }, { kind: 'measurement-guide', id: 'sg-1' }],
    }],
    plantSpeciesCodes: { 'Castanea sativa': 'CS' },
    consortiums: [{ canonicalName: 'Castanea sativa', stratum: 'emergent', startPhase: 1, endPhase: 7 }],
    budget: [{ canonicalName: 'Castanea sativa', unitCost: 24 }],
    timeline: [{
      title: 'Winter prune',
      category: 'pruning',
      offsetDays: 30,
      targets: [{ kind: 'placed_plant', plant_id: 'sp-1' }],
    }],
  }
}

function assertPlacedSceneAndDocument(
  store: SceneStore,
  doc: { readonly consortiums: readonly unknown[]; readonly budget: readonly unknown[]; readonly timeline: readonly { readonly description: string; readonly targets: readonly unknown[] }[] },
): string {
  const plant = store.persisted.plants[0]!
  const zone = store.persisted.zones[0]!
  const guide = store.persisted.measurementGuides[0]!
  expect(store.persisted.plants).toHaveLength(1)
  expect(plant.locked).toBe(true)
  expect(plant.notes).toBe('Grafted cultivar')
  expect(store.persisted.zones).toHaveLength(1)
  expect(zone.strokeColor).toBe('#1b5e20')
  expect(zone.opacity).toBe(0.6)
  expect(zone.notes).toBe('Mulch yearly')
  expect(store.persisted.annotations).toHaveLength(1)
  expect(store.persisted.measurementGuides).toHaveLength(1)
  expect(guide.locked).toBe(true)
  expect(store.persisted.groups).toHaveLength(1)
  expect(store.persisted.plantSpeciesCodes['Malus domestica']).toBe('CS')
  expect(store.persisted.plantSpeciesCodes['Castanea sativa']).toBe('CS2')
  expect(doc.consortiums).toHaveLength(1)
  expect(doc.budget).toHaveLength(1)
  expect(doc.timeline).toHaveLength(1)
  expect(doc.timeline[0]!.description).toBe('Winter prune')
  expect(doc.timeline[0]!.targets).toEqual([{ kind: 'placed_plant', plant_id: plant.id }])
  return plant.id
}

describe('2c-4a Stamps, Calendar Undo, and Groups (foundations §345)', () => {
  it('a stamp with guides, locks, notes and a care action places them all, and one Undo removes the copies and the action', () => {
    const initial = makeTestDesign({
      plant_species_codes: { 'Malus domestica': 'CS' },
    })
    const fixture = createTestSessionCore({ file: initial })
    disposers.push(fixture.dispose)
    const { core } = fixture

    const store = new SceneStore().hydrate(initial)
    const edits = new SceneRuntimeEditCoordinator({
      sceneStore: store,
      sceneSession: {
        canUndo: core.canUndo,
        canRedo: core.canRedo,
        recordSceneEdit: (label, command, options) => core.recordSceneEdit(label, command, options),
        placeSavedStamp: (stamp, applyScene) => placeStampThroughCore(core, stamp, () => applyScene()) !== null,
        undo: () => core.undo(),
        redo: () => core.redo(),
      },
      setSelection: (targets) => store.setSelection(targets),
      incrementSceneRevision: () => {},
      syncCanvasSignalsFromScene: () => {},
      invalidate: () => {},
    })
    core.attachScene({
      serialize: () => ({} as ReturnType<ScenePort['serialize']>),
      load() {},
      replay(command, direction) {
        edits.replayCommand(command, direction)
      },
    })

    const mergedCodes = mergeStampSpeciesCodes(
      { 'Malus domestica': 'MD', 'Juglans regia': 'JR' },
      { 'Malus domestica': 'AP', 'Corylus avellana': 'JR', 'Castanea sativa': 'CS' },
    )
    expect(mergedCodes['Malus domestica']).toBe('MD')
    expect(mergedCodes['Castanea sativa']).toBe('CS')
    expect(mergedCodes['Corylus avellana']).toMatch(/^JR\d+$/)

    const v3Stamp = buildV3GuildStamp()
    const parsed = parseSavedObjectStampPayload(serializeSavedObjectStampPayloadV3(v3Stamp))!
    expect(parsed.version).toBe(SAVED_OBJECT_STAMP_PAYLOAD_V3_VERSION)
    expect(parsed.measurementGuides).toHaveLength(1)
    expect(parsed.timeline).toHaveLength(1)

    let committed = false
    placeSavedObjectStamp(
      edits,
      { isLayerOpenForCreation: () => true },
      v3Stamp,
      { x: 10, y: 12 },
      { rotationDeg: 0, bearingDeg: 0, onCommitted: () => { committed = true } },
    )
    expect(committed).toBe(true)

    const placedPlantId = assertPlacedSceneAndDocument(store, core.currentDesign.peek()!.document)
    expect(toasts.peek().some((toast) => toast.message === 'savedObjectStamps.placedToast')).toBe(true)

    // Live capture with designSessionStore.currentDesign captures care actions, consortiums, and budget (B2)
    const liveDesign = designSessionStore.currentDesign.peek()
    expect(liveDesign).not.toBeNull()
    const normalized = normalizeSelection({
      scene: store.persisted,
      selection: {
        editableTargets: [{ kind: 'zone', id: store.persisted.zones[0]!.id }],
        lockedTargets: [{ kind: 'plant', id: placedPlantId }],
        blockedTargets: [],
        bounds: { minX: 0, minY: 0, maxX: 14, maxY: 16 },
        primaryTarget: { kind: 'zone', id: store.persisted.zones[0]!.id },
      } as never,
      localizedCommonNames: new Map(),
      design: liveDesign,
    })!
    expect(normalized.payload.timeline).toHaveLength(1)
    expect(normalized.payload.consortiums).toHaveLength(1)
    expect(normalized.payload.budget).toHaveLength(1)

    // Single Undo removes BOTH all scene copies AND all document parts together
    expect(core.canUndo.peek()).toBe(true)
    core.undo()
    expect(store.persisted.plants).toHaveLength(0)
    expect(store.persisted.zones).toHaveLength(0)
    expect(store.persisted.annotations).toHaveLength(0)
    expect(store.persisted.measurementGuides).toHaveLength(0)
    expect(store.persisted.groups).toHaveLength(0)
    const afterUndo = core.currentDesign.peek()!.document
    expect(afterUndo.consortiums).toHaveLength(0)
    expect(afterUndo.budget).toHaveLength(0)
    expect(afterUndo.timeline).toHaveLength(0)
    expect(core.canUndo.peek()).toBe(false)
  })

  it('a deleted stamp comes back from its Undo toast', async () => {
    const rows: SavedObjectStamp[] = [{
      id: 'stamp-1',
      name: 'Apple guild',
      payload_json: serializeSavedObjectStampPayloadV3({
        version: SAVED_OBJECT_STAMP_PAYLOAD_V3_VERSION,
        anchor: { x: 0, y: 0 },
        plants: [],
        zones: [],
        annotations: [{
          id: 'a1',
          annotationType: 'text',
          position: { x: 0, y: 0 },
          text: 'Guild note',
          fontSize: 14,
          rotationDeg: null,
        }],
        groups: [],
      }),
      sort_order: 0,
      created_at: '2026-11-27T12:00:00Z',
      updated_at: '2026-11-27T12:00:00Z',
    }]
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [...rows],
      deleteSavedObjectStamp: async (id) => {
        const idx = rows.findIndex((row) => row.id === id)
        if (idx === -1) return false
        rows.splice(idx, 1)
        return true
      },
      restoreSavedObjectStamp: async (stamp) => {
        rows.push(stamp)
        return stamp
      },
    })
    disposers.push(() => workbench.dispose())

    await workbench.loadLibrary()
    expect(workbench.library.peek().items).toHaveLength(1)

    const deleted = await workbench.deleteStamp('stamp-1')
    expect(deleted).toBe(true)
    expect(workbench.library.peek().items).toHaveLength(0)

    const undoToast = toasts.peek().find((toast) => toast.key === 'saved-object-stamp-deleted:stamp-1')!
    expect(undoToast.actionLabel).toBe('savedObjectStamps.undo')
    expect(undoToast.onAction).toBeTypeOf('function')

    undoToast.onAction!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(workbench.library.peek().items.map((item) => item.id)).toEqual(['stamp-1'])
  })

  it('Undo restores a deleted calendar action', () => {
    const fixture = createTestSessionCore({ file: makeTestDesign() })
    disposers.push(fixture.dispose)
    const { core } = fixture

    addTimelineAction({
      id: 'act-t7',
      action_type: 'harvest',
      description: 'Harvest chestnuts',
      start_date: '2026-10-15',
      end_date: null,
      recurrence: null,
      targets: [],
      depends_on: null,
      completed: false,
    })
    expect(core.currentDesign.peek()!.document.timeline.map((a) => a.id)).toEqual(['act-t7'])

    deleteTimelineAction('act-t7')
    expect(core.currentDesign.peek()!.document.timeline).toHaveLength(0)

    core.undo()
    const restored = core.currentDesign.peek()!.document.timeline
    expect(restored.map((a) => a.id)).toEqual(['act-t7'])
    expect(restored[0]!.description).toBe('Harvest chestnuts')
  })

  it('a group of a guide and a note moves as one', () => {
    const file = makeTestDesign({
      annotations: [{
        id: 'note-1',
        locked: false,
        annotation_type: 'text',
        position: geoAt(2, 3),
        text: 'Swale crest',
        font_size: 14,
        rotation: null,
      }],
      measurement_guides: [{
        id: 'guide-1',
        locked: false,
        start: geoAt(0, 0),
        end: geoAt(4, 0),
      }],
    })
    const store = new SceneStore().hydrate(file)
    const session = createDetachedSceneSessionAdapter()
    const setSelection = (t: Iterable<SceneDesignObjectTarget>) => store.setSelection(t)
    const edits = new SceneRuntimeEditCoordinator({
      sceneStore: store,
      sceneSession: session,
      setSelection,
      incrementSceneRevision: () => {},
      syncCanvasSignalsFromScene: () => {},
      invalidate: () => {},
    })
    const mutations = new SceneRuntimeMutationController({
      sceneStore: store,
      selection: { set: setSelection },
      sceneEdits: edits,
      commandAdmission: edits,
      settledReader: edits,
      presentation: {
        getViewportScale: () => 10,
        createPlantPresentationContext: (pixelsPerMetre = 10) => ({
          pixelsPerMetre,
          speciesCache: new Map(),
          localizedCommonNames: new Map(),
        }),
        getLocalizedCommonNames: () => new Map(),
      },
      invalidateScene: () => {},
    })

    store.setSelection([
      { kind: 'annotation', id: 'note-1' },
      { kind: 'measurement-guide', id: 'guide-1' },
    ])
    mutations.groupSelected()
    expect(store.persisted.groups).toHaveLength(1)
    const groupId = store.persisted.groups[0]!.id
    const beforeNote = { ...store.persisted.annotations[0]!.position }
    const beforeStart = { ...store.persisted.measurementGuides[0]!.start }
    const beforeEnd = { ...store.persisted.measurementGuides[0]!.end }

    const drag = createSceneDragState()
    captureSceneDragState(drag, store.persisted, [{ kind: 'group', id: groupId }])
    edits.run('move-group', (tx) => {
      tx.mutate((draft) => {
        applySceneDragDeltaToDraft(draft, drag, { x: 3, y: -2 })
      })
    })

    expect(store.persisted.annotations[0]!.position.x).toBeCloseTo(beforeNote.x + 3, 6)
    expect(store.persisted.annotations[0]!.position.y).toBeCloseTo(beforeNote.y - 2, 6)
    expect(store.persisted.measurementGuides[0]!.start.x).toBeCloseTo(beforeStart.x + 3, 6)
    expect(store.persisted.measurementGuides[0]!.start.y).toBeCloseTo(beforeStart.y - 2, 6)
    expect(store.persisted.measurementGuides[0]!.end.x).toBeCloseTo(beforeEnd.x + 3, 6)
    expect(store.persisted.measurementGuides[0]!.end.y).toBeCloseTo(beforeEnd.y - 2, 6)
  })
})
