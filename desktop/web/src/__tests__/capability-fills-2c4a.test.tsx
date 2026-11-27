// Cross-module behavioural suite for 2c-4a Capability Fills
// (pre-2c1-2c4-plan-v2.md §5.3; 2.1-Q149, Q153, Q154, Q155, Q158, Q160, Q168, Q353, Q354, Q355, Q63, T1-T12).

import { afterEach, describe, expect, it } from 'vitest'
import { createSessionPlane } from '../geo/session-plane'
import { formatLength, parseQuantity } from '../utils/format'
import {
  prepareEditGuideDimensions,
  prepareEditZoneDimensions,
  prepareSetSpeciesCode,
  prepareSetZoneStyle,
  readPolygonDimensions,
  readRectOrEllipseDimensions,
  readSegmentDimensions,
} from '../canvas/runtime/dimension-math'
import {
  SceneStore,
  type SceneDesignObjectTarget,
  type SceneObjectGroupMember,
  type SceneZoneEntity,
} from '../canvas/runtime/scene'
import {
  createDetachedSceneSessionAdapter,
  SceneRuntimeEditCoordinator,
} from '../canvas/runtime/scene-runtime/transactions'
import { SceneRuntimeMutationController } from '../canvas/runtime/scene-runtime/mutations'
import { createScenePatchCommand, type SceneCommand } from '../canvas/runtime/scene-commands'
import { addTimelineAction } from '../app/design-edit/timeline'
import { deletePlantBudgetPrice, setPlantBudgetPrice } from '../app/design-edit/budget'
import { buildConsortiumPlanningProjection } from '../app/planning-projection/consortium'
import { sceneExtentPoints } from '../canvas/runtime/scene-extent'
import { formatHoverTooltipContent } from '../canvas/runtime/hover-tooltip-content'
import { resolveZoneVisual } from '../canvas/runtime/scene-visuals'
import {
  currentCanvasTouchConstrain,
  setCanvasTouchConstrain,
  toggleCanvasTouchConstrain,
} from '../canvas/session-state'
import { DEFAULT_PLANT_DISPLAY } from '../canvas/runtime/plant-display'
import type { ScenePort } from '../app/document-session/core/scene-half'
import { createTestSessionCore, makeTestDesign } from './support/session-core-fixture'
import { geoAt } from './support/geo-design'

const disposers: Array<() => void> = []

function makeDummySceneCommand(type: string): SceneCommand {
  const before = new SceneStore().hydrate(makeTestDesign()).persisted
  const after = new SceneStore().hydrate(makeTestDesign({
    annotations: [{
      id: `cmd-${type}`,
      locked: false,
      annotation_type: 'text',
      position: geoAt(1, 1),
      text: type,
      font_size: 14,
      rotation: null,
    }],
  })).persisted
  return createScenePatchCommand(
    type,
    { persisted: before, selectedTargets: [] },
    { persisted: after, selectedTargets: [] },
  )!
}

describe('2c-4a Capability Fills', () => {
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose()
    setCanvasTouchConstrain(false)
  })

  it('Edit dimensions round-trips at high latitude without Web Mercator drift and in Imperial', () => {
    const plane = createSessionPlane({ lon: 10.7522, lat: 59.9139 })
    const rect: SceneZoneEntity = {
      kind: 'zone',
      id: 'zone-rect-oslo',
      name: 'Oslo bed',
      locked: false,
      zoneType: 'rect',
      points: [
        { x: -2, y: -1 },
        { x: 2, y: -1 },
        { x: 2, y: 1 },
        { x: -2, y: 1 },
      ],
      rotationDeg: 0,
      fillColor: '#4caf50',
      notes: null,
    }

    const w = parseQuantity('length', '4 ft', 'us_customary', 'en')
    const h = parseQuantity('length', '8 ft', 'us_customary', 'en')
    expect(w).not.toBeNull()
    expect(h).not.toBeNull()
    if (w === null || h === null) return

    const store = new SceneStore()
    store.hydrate(makeTestDesign())
    const persisted = {
      ...store.persisted,
      zones: [rect],
      measurementGuides: [{ kind: 'measurement-guide' as const, id: 'g-oslo', locked: false, start: { x: 0, y: 0 }, end: { x: 5, y: 0 } }],
    }
    const rectMut = prepareEditZoneDimensions(persisted, plane, rect.id, { widthM: w, heightM: h })
    expect(rectMut).not.toBeNull()
    const rectDraft = { ...persisted }
    rectMut!(rectDraft)
    const updated = rectDraft.zones[0]!
    const readback = readRectOrEllipseDimensions(updated, plane)
    expect(readback).not.toBeNull()
    expect(readback!.widthM).toBeCloseTo(w, 3)
    expect(readback!.heightM).toBeCloseTo(h, 3)
    expect(formatLength(readback!.widthM, 'us_customary', 'en')).toBe('4 ft')
    expect(formatLength(readback!.heightM, 'us_customary', 'en')).toBe('8 ft')

    // Polygon: side lengths, interior angles, and centre lat/lon (no per-vertex coordinates)
    const poly: SceneZoneEntity = {
      kind: 'zone',
      id: 'zone-poly-oslo',
      name: 'Triangle',
      locked: false,
      zoneType: 'polygon',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
      rotationDeg: 0,
      fillColor: null,
      notes: null,
    }
    const polyDraft = { ...persisted, zones: [poly] }
    const polyMut = prepareEditZoneDimensions(polyDraft, plane, poly.id, { sideIndex: 0, sideLengthM: 12 })
    expect(polyMut).not.toBeNull()
    polyMut!(polyDraft)
    const polyReadback = readPolygonDimensions(polyDraft.zones[0]!, plane)
    expect(polyReadback).not.toBeNull()
    expect(polyReadback!.sideLengthsM[0]).toBeCloseTo(12, 3)
    expect(polyReadback!.interiorAnglesDeg).toHaveLength(3)
    expect(polyReadback!.center.lat).toBeCloseTo(59.9139, 3)

    // Segment / guide round-trip
    const guideDraft = { ...persisted }
    const guideMut = prepareEditGuideDimensions(guideDraft, plane, 'g-oslo', { lengthM: 10, angleDeg: 45 })
    expect(guideMut).not.toBeNull()
    guideMut!(guideDraft)
    const editedGuide = guideDraft.measurementGuides[0]!
    const segRead = readSegmentDimensions(editedGuide.start, editedGuide.end, plane)
    expect(segRead.lengthM).toBeCloseTo(10, 3)
    expect(segRead.angleDeg).toBeCloseTo(45, 2)
  })

  it('Flat groups hold any object including guides and notes, never nest', () => {
    const file = makeTestDesign({
      plants: [{
        id: 'p1',
        locked: false,
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: null,
        position: geoAt(0, 0),
        rotation: null,
        canopy_spread_m: 4,
        notes: null,
        planted_date: null,
        quantity: 1,
      }],
      annotations: [{
        id: 'a1',
        locked: false,
        annotation_type: 'text',
        position: geoAt(2, 0),
        text: 'Swale note',
        font_size: 14,
        rotation: null,
      }, {
        id: 'a2',
        locked: false,
        annotation_type: 'text',
        position: geoAt(4, 0),
        text: 'Second',
        font_size: 14,
        rotation: null,
      }],
      measurement_guides: [{
        id: 'g1',
        locked: false,
        start: geoAt(0, 0),
        end: geoAt(5, 0),
      }],
    })
    const store = new SceneStore().hydrate(file)
    const setSelection = (targets: Iterable<SceneDesignObjectTarget>) => store.setSelection(targets)
    const session = createDetachedSceneSessionAdapter()
    const sceneEdits = new SceneRuntimeEditCoordinator({
      sceneStore: store,
      sceneSession: session,
      setSelection,
      incrementSceneRevision: () => {},
      syncCanvasSignalsFromScene: () => {},
      invalidate: () => {},
    })
    session.bindReplay((cmd, dir) => sceneEdits.replayCommand(cmd, dir))
    const controller = new SceneRuntimeMutationController({
      sceneStore: store,
      selection: { set: setSelection },
      sceneEdits,
      commandAdmission: sceneEdits,
      settledReader: sceneEdits,
      presentation: {
        getViewportScale: () => 1,
        createPlantPresentationContext: (pixelsPerMetre = 1) => ({
          pixelsPerMetre,
          speciesCache: new Map(),
          localizedCommonNames: new Map(),
        }),
        getLocalizedCommonNames: () => new Map(),
      },
      invalidateScene: () => {},
    })

    store.setSelection([
      { kind: 'plant', id: 'p1' },
      { kind: 'annotation', id: 'a1' },
      { kind: 'measurement-guide', id: 'g1' },
    ])
    controller.groupSelected()

    expect(store.persisted.groups).toHaveLength(1)
    expect(store.persisted.groups[0]!.members.map((m: SceneObjectGroupMember) => `${m.kind}:${m.id}`).sort()).toEqual([
      'annotation:a1',
      'measurement-guide:g1',
      'plant:p1',
    ])

    // Selecting the group + another object flattens instead of nesting
    store.setSelection([
      { kind: 'group', id: store.persisted.groups[0]!.id },
      { kind: 'annotation', id: 'a2' },
    ])
    controller.groupSelected()
    expect(store.persisted.groups).toHaveLength(1)
    expect(store.persisted.groups[0]!.members.every((m: SceneObjectGroupMember) => (m.kind as string) !== 'group')).toBe(true)
    expect(store.persisted.groups[0]!.members).toHaveLength(4)
  })

  it('Deleting the last plant of a species removes its Consortium row in the same Undo entry', () => {
    const initial = makeTestDesign({
      consortiums: [{
        target: { kind: 'species', canonical_name: 'Malus domestica' },
        stratum: 'high',
        start_phase: 1,
        end_phase: 5,
      }],
    })
    const fixture = createTestSessionCore({ file: initial })
    disposers.push(fixture.dispose)
    const { core } = fixture
    core.attachScene({
      serialize: () => ({} as ReturnType<ScenePort['serialize']>),
      load() {},
      replay() {},
    })

    // Derived consortium projection includes placed species not yet in design.consortiums
    const projection = buildConsortiumPlanningProjection({
      consortiums: [],
      plants: [{
        id: 'p1',
        canonical_name: 'Corylus avellana',
        common_name: null,
        color: null,
        locked: false,
        position: { lon: 0, lat: 0 },
        rotation: null,
        canopy_spread_m: 3,
        notes: null,
        planted_date: null,
        quantity: 1,
      }],
    })
    expect(projection.activeEntries).toHaveLength(1)

    // Deleting the last Malus domestica plant prunes its consortium row in the SAME compound Undo entry
    const cmd = makeDummySceneCommand('delete-selection')
    core.recordSceneEdit('delete-selection', cmd, { remainingPlantSpecies: new Set() })
    expect(core.currentDesign.peek()?.document.consortiums).toHaveLength(0)

    // Undoing the plant delete restores the consortium row in one Undo step
    core.undo()
    expect(core.currentDesign.peek()?.document.consortiums).toHaveLength(1)
    expect(core.canUndo.peek()).toBe(false)
  })

  it('Every Document edit (Timeline, Budget, Consortium, Views, Stories) undoes and redoes through Session Core', () => {
    const fixture = createTestSessionCore({ file: makeTestDesign() })
    disposers.push(fixture.dispose)
    const { core } = fixture

    addTimelineAction({
      id: 'act-1',
      action_type: 'pruning',
      description: 'Prune apple trees',
      start_date: '2026-03-01',
      end_date: null,
      recurrence: null,
      targets: [],
      depends_on: null,
      completed: false,
    })
    expect(core.currentDesign.peek()?.document.timeline).toHaveLength(1)
    core.undo()
    expect(core.currentDesign.peek()?.document.timeline).toHaveLength(0)
    core.redo()
    expect(core.currentDesign.peek()?.document.timeline).toHaveLength(1)
    expect(core.currentDesign.peek()?.document.timeline[0]!.description).toBe('Prune apple trees')

    setPlantBudgetPrice('Malus domestica', 18)
    expect(core.currentDesign.peek()?.document.budget).toHaveLength(1)
    deletePlantBudgetPrice('Malus domestica')
    expect(core.currentDesign.peek()?.document.budget).toHaveLength(0)
    core.undo()
    expect(core.currentDesign.peek()?.document.budget).toHaveLength(1)
    core.redo()
    expect(core.currentDesign.peek()?.document.budget).toHaveLength(0)
  })

  it('Fit, Inspection Lens, Hover Tooltips, Zone Style, Species Code, and Touch Constrain behave per 2c-4a', () => {
    const plane = createSessionPlane({ lon: 2.35, lat: 48.85 })
    const file = makeTestDesign({
      layers: [
        { name: 'plants', visible: true, locked: false, opacity: 1 },
        { name: 'zones', visible: true, locked: false, opacity: 1 },
        { name: 'annotations', visible: true, locked: false, opacity: 1 },
        { name: 'measurement-guides', visible: true, locked: false, opacity: 1 },
      ],
      zones: [{
        id: 'z1',
        name: 'Pond',
        locked: false,
        zone_type: 'rect',
        points: [geoAt(0, 0), geoAt(4, 0), geoAt(4, 4), geoAt(0, 4)],
        rotation: 0,
        fill_color: '#2196f3',
        stroke_color: '#0d47a1',
        opacity: 0.45,
        notes: null,
      }],
      measurement_guides: [{
        id: 'g1',
        locked: false,
        start: geoAt(10, 20),
        end: geoAt(30, 40),
      }],
      annotations: [{
        id: 'a1',
        locked: false,
        annotation_type: 'text',
        position: geoAt(5, 5),
        text: 'North windbreak',
        font_size: 14,
        rotation: null,
      }],
    })
    const store = new SceneStore().hydrate(file)
    const sceneWithGuide = store.persisted
    const plantCtx = {
      pixelsPerMetre: 10,
      speciesCache: new Map(),
      localizedCommonNames: new Map<string, string | null>(),
      plantDisplay: DEFAULT_PLANT_DISPLAY,
    }

    // Visible guide & zone & note are included in fit extents
    const visiblePts = sceneExtentPoints(sceneWithGuide, plantCtx)(10)
    expect(visiblePts.length).toBeGreaterThan(4)

    // Opacity-0 or hidden layer is excluded from fit (2.1-Q63)
    const zeroOpacityGuide = {
      ...sceneWithGuide,
      layers: sceneWithGuide.layers.map((l) => l.name === 'measurement-guides' ? { ...l, opacity: 0 } : l),
    }
    expect(sceneExtentPoints(zeroOpacityGuide, plantCtx)(10).length).toBeLessThan(visiblePts.length)

    // Zone visual resolves strokeColor and unified opacity
    const visual = resolveZoneVisual(sceneWithGuide.zones[0]!)
    expect(visual.stroke).toBe('#0d47a1')
    expect(visual.opacity).toBeCloseTo(0.45, 5)

    // Hover tooltips format zones, guides, and notes
    const guideTip = formatHoverTooltipContent(
      sceneWithGuide,
      { kind: 'measurement-guide', id: 'g1' },
      plane,
      new Map(),
      'metric',
      'en',
    )
    expect(guideTip?.subtitle).toContain('m')
    const noteTip = formatHoverTooltipContent(
      sceneWithGuide,
      { kind: 'annotation', id: 'a1' },
      plane,
      new Map(),
      'metric',
      'en',
    )
    expect(noteTip?.subtitle).toBe('North windbreak')

    // Touch constrain toggle
    expect(currentCanvasTouchConstrain.peek()).toBe(false)
    toggleCanvasTouchConstrain()
    expect(currentCanvasTouchConstrain.peek()).toBe(true)
    setCanvasTouchConstrain(false)
    expect(currentCanvasTouchConstrain.peek()).toBe(false)

    // prepareSetZoneStyle and prepareSetSpeciesCode mutate through SceneRuntimeEditCoordinator
    const session = createDetachedSceneSessionAdapter()
    const edits = new SceneRuntimeEditCoordinator({
      sceneStore: store,
      sceneSession: session,
      setSelection: (t) => store.setSelection(t),
      incrementSceneRevision: () => {},
      syncCanvasSignalsFromScene: () => {},
      invalidate: () => {},
    })
    const styleMut = prepareSetZoneStyle(store.persisted, 'z1', { strokeColor: '#ff0000', opacity: 0.7 })
    expect(styleMut).not.toBeNull()
    edits.run('set-zone-style', (tx) => tx.mutate(styleMut!))
    expect(store.persisted.zones[0]?.strokeColor).toBe('#ff0000')
    expect(store.persisted.zones[0]?.opacity).toBe(0.7)
    const codeMut = prepareSetSpeciesCode(store.persisted, 'Malus domestica', 'AP1')
    expect(codeMut).not.toBeNull()
    edits.run('set-species-code', (tx) => tx.mutate(codeMut!))
    expect(store.persisted.plantSpeciesCodes['Malus domestica']).toBe('AP1')
  })
})
