import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createToolHarness,
  measurementGuide,
  plantEntity,
  rectZone,
  textNote,
  type ToolHarness,
  type ToolHarnessOptions,
} from '../../../__tests__/support/tool-harness'
import type { SceneArrangementTemplate } from '../scene-runtime/arrangement-placement'
import type { ScenePersistedState, ScenePlantEntity } from '../scene/types'
import type { WorldPoint } from '../view/types'
import type { DraftShape } from './draft'
import type { CanvasTool } from './tool'
import '../../../__tests__/support/camera-tolerance'
import type * as RegistryModule from './registry'

/** The tools the registry built, newest last: a test calls one as the host does. */
const builtTools = vi.hoisted(() => [] as CanvasTool[])
vi.mock('./registry', async (importOriginal) => {
  const actual = await importOriginal<typeof RegistryModule>()
  const recording = Object.entries(actual.TOOL_REGISTRY).map(([id, factory]) => [id, () => {
    const tool = factory!()
    builtTools.push(tool)
    return tool
  }])
  return { ...actual, TOOL_REGISTRY: Object.freeze(Object.fromEntries(recording)) }
})

const harnesses: ToolHarness[] = []

/** The Object stamp armed on the split suites' camera (scale 1 at the origin) unless the options say otherwise. */
function stampHarness(scene: Partial<ScenePersistedState>, options: ToolHarnessOptions = {}): ToolHarness {
  const created = createToolHarness({ scene, tool: 'object-stamp', ...options })
  harnesses.push(created)
  return created
}

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose()
  builtTools.length = 0
})

/** The Scene Edits that committed, by history type (today's onSceneEditCommit). */
function committedEdits(h: ToolHarness): string[] {
  const committed: string[] = []
  const run = h.edits.run.bind(h.edits)
  vi.spyOn(h.edits, 'run').mockImplementation((type, edit, options) => {
    const done = run(type, edit, options)
    if (done) committed.push(type)
    return done
  })
  return committed
}

type GhostShape = Extract<DraftShape, { kind: 'ghost' }>

/** The stamp's ghosts in the draft the renderer holds (the host may add its own decorations beside them). */
function ghosts(h: ToolHarness): GhostShape[] {
  return (h.renderer.lastDraft()?.shapes ?? []).filter((shape): shape is GhostShape => shape.kind === 'ghost')
}

function objectsGhost(shape: GhostShape | undefined): { template: SceneArrangementTemplate } {
  if (shape?.entity.kind !== 'objects') throw new Error('Expected an objects ghost.')
  return shape.entity
}

/** The first plant the stamp's ghost draws, where a press would place it. */
function ghostPlant(h: ToolHarness): ScenePlantEntity {
  return objectsGhost(ghosts(h)[0]).template.plants[0]!.entity
}

/** An offset from the pick's anchor turned by the held angle, as the placement turns it (the selection rotation's sense). */
function turned(offset: WorldPoint, degrees: number): WorldPoint {
  const radians = (degrees * Math.PI) / 180
  return {
    x: offset.x * Math.cos(radians) - offset.y * Math.sin(radians),
    y: offset.x * Math.sin(radians) + offset.y * Math.cos(radians),
  }
}

function expectPoint(actual: WorldPoint, expected: WorldPoint): void {
  expect(actual.x).toBeCloseTo(expected.x, 6)
  expect(actual.y).toBeCloseTo(expected.y, 6)
}

function selected(h: ToolHarness) {
  return h.store.session.selectedTargets
}

const APPLE = plantEntity('plant-1', 'Malus domestica', { x: 50, y: 60 }, {
  commonName: 'Apple',
  color: '#C44230',
  symbol: 'triangle',
  canopySpreadM: 4,
  rotationDeg: 15,
  notes: 'Source plant',
  plantedDate: '2026-02-01',
  quantity: 2,
})

function smallApple(position: WorldPoint, overrides: Parameters<typeof plantEntity>[3] = {}) {
  return plantEntity('plant-1', 'Malus domestica', position, { commonName: 'Apple', canopySpreadM: 2, ...overrides })
}

describe('object stamp tool', () => {
  it('the first click picks, the next places', () => {
    const h = stampHarness({ plants: [APPLE] })
    const commits = committedEdits(h)

    h.press({ x: 54, y: 63 })
    expect(h.store.persisted.plants).toHaveLength(1)
    expect(commits).toEqual([])
    // The pick's ghost sits on the picked plant, anchored where it was pressed, level.
    expect(ghosts(h)).toHaveLength(1)
    expect(ghosts(h)[0]!.opacity).toBe(0.62)
    expect(objectsGhost(ghosts(h)[0]).template.plants.map(({ entity }) => entity.position)).toEqual([{ x: 50, y: 60 }])
    expect(h.record.guidance.at(-1)).toMatchObject({
      stamp: { kind: 'plant', name: 'Apple', plants: 1, species: 1 },
      stampRotationDeg: 0,
    })
    // The release hides it until the next hover, as today's pointerup hid the preview; the pick is held.
    h.release()
    expect(ghosts(h)).toEqual([])
    expect(h.record.guidance.at(-1)?.stamp).toMatchObject({ kind: 'plant', name: 'Apple' })

    // The ghost follows the pointer with the pick's offset.
    h.hover({ x: 100, y: 120 })
    expect(objectsGhost(ghosts(h)[0]).template.plants[0]!.entity).toMatchObject({ position: { x: 96, y: 117 }, pinnedName: false })

    h.press({ x: 100, y: 120 })

    expect(h.store.persisted.plants).toHaveLength(2)
    const clone = h.store.persisted.plants[1]!
    expect(clone.id).not.toBe('plant-1')
    expect(clone).toMatchObject({
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: '#C44230',
      symbol: 'triangle',
      canopySpreadM: 4,
      position: { x: 96, y: 117 },
      rotationDeg: 15,
      notes: 'Source plant',
      plantedDate: '2026-02-01',
      quantity: 2,
    })
    expect(selected(h)).toEqual([{ kind: 'plant', id: clone.id }])
    expect(commits).toEqual(['interaction-object-stamp'])
    // The ghost stands on the copy while the button is down; the release hides it.
    expect(ghostPlant(h).position).toEqual({ x: 96, y: 117 })
    h.release()
    expect(ghosts(h)).toEqual([])
    // Each later click places again: the pick is still held.
    h.click({ x: 140, y: 120 })
    expect(h.store.persisted.plants).toHaveLength(3)
    expect(commits).toEqual(['interaction-object-stamp', 'interaction-object-stamp'])
  })

  it('[ and ] turn the pick 15 degrees', () => {
    const h = stampHarness({ plants: [APPLE] })

    // Nothing held: the keys are not the stamp's (they stay send to back and bring to front).
    expect(h.host.command({ kind: 'rotate-held', stepDeg: 15 })).toBe('pass')

    h.click({ x: 54, y: 63 })
    expect(h.host.command({ kind: 'rotate-held', stepDeg: 15 })).toBe('handled')
    expect(h.record.guidance.at(-1)?.stampRotationDeg).toBe(15)
    // The release hid the ghost; the turn draws it again where it stood, about the pick's anchor (today's rotateBy).
    const offset = turned({ x: -4, y: -3 }, 15)
    expectPoint(ghostPlant(h).position, { x: 54 + offset.x, y: 63 + offset.y })

    for (let turn = 0; turn < 6; turn += 1) h.host.command({ kind: 'rotate-held', stepDeg: 15 })
    expect(h.host.command({ kind: 'rotate-held', stepDeg: -15 })).toBe('handled')
    expect(h.record.guidance.at(-1)?.stampRotationDeg).toBe(90)

    // The plant was picked 4 m east and 3 m south of its centre; at 90° that offset turns too.
    h.hover({ x: 100, y: 120 })
    expectPoint(ghostPlant(h).position, { x: 103, y: 116 })
    h.click({ x: 100, y: 120 })
    expect(h.store.persisted.plants[1]?.position).toEqual({ x: 103, y: 116 })
  })

  it('at bearing 30 an Object stamp pick starts at 0', () => {
    // The screen centre shows the plane's origin; the map is turned 30° (spec §4.7, phase-1 amendment A13). The plant's
    // centre is 3 m east of the press, inside its 10 m canopy.
    const h = stampHarness(
      { plants: [smallApple({ x: 3, y: 0 }, { canopySpreadM: 20 })] },
      { camera: { bearingDeg: 30 } },
    )

    h.press({ x: 200, y: 150 })
    // Copies keep their source's orientation, like Paste and Duplicate: the pick is not turned to the screen.
    expectPoint(ghostPlant(h).position, { x: 3, y: 0 })
    expect(h.record.guidance.at(-1)?.stampRotationDeg).toBe(0)
    h.release()

    // The copy keeps the pick's offset in the plane: still 3 m east of where it is placed.
    h.click({ x: 260, y: 150 })
    const placedAt = h.world({ x: 260, y: 150 })
    expect(h.store.persisted.plants[1]!.position.x).toBeCloseTo(placedAt.x + 3, 6)
    expect(h.store.persisted.plants[1]!.position.y).toBeCloseTo(placedAt.y, 6)

    // ] turns it from there, and the tool card reads the turn.
    h.host.command({ kind: 'rotate-held', stepDeg: 15 })
    expect(h.record.guidance.at(-1)?.stampRotationDeg).toBe(15)
    const offset = turned({ x: 3, y: 0 }, 15)
    expectPoint(ghostPlant(h).position, { x: placedAt.x + offset.x, y: placedAt.y + offset.y })
  })

  it('keeps the passive hover off while a pick is held, and runs it before', () => {
    const h = stampHarness({ plants: [smallApple({ x: 40, y: 40 })] })

    h.hover({ x: 40, y: 40 })
    expect(h.chrome.tooltip?.target).toEqual({ kind: 'plant', id: 'plant-1' })

    h.click({ x: 40, y: 40 })
    h.hover({ x: 41, y: 40 })
    expect(h.chrome.tooltip).toBeNull()
    expect(h.record.hovers.at(-1)).toBeNull()
  })

  it('keeps the pick and its ghost when the pointer leaves the map or a press is cancelled', () => {
    const h = stampHarness({ plants: [smallApple({ x: 40, y: 40 })] })

    h.click({ x: 40, y: 40 })
    h.hover({ x: 90, y: 90 })
    const shown = h.renderer.lastDraft()
    h.leave()
    expect(h.renderer.lastDraft()).toEqual(shown)

    // Today's stamp press let go of the pointer gesture, so a pointercancel or a lost capture after it cancelled nothing.
    h.press({ x: 120, y: 120 })
    expect(h.store.persisted.plants).toHaveLength(2)
    const placed = h.renderer.lastDraft()
    expect(ghostPlant(h).position).toEqual({ x: 120, y: 120 })
    h.cancel('pointercancel')
    expect(h.renderer.lastDraft()).toEqual(placed)
  })

  it('hides the ghost on a release, a window blur or the tool armed again, until the next hover, and keeps the pick', () => {
    const h = stampHarness({ plants: [smallApple({ x: 40, y: 40 })] })
    const hoverShows = (at: { x: number; y: number }) => {
      h.hover(at)
      expect(ghostPlant(h).position).toEqual(at)
    }

    h.click({ x: 40, y: 40 })
    expect(ghosts(h)).toEqual([])
    hoverShows({ x: 90, y: 90 })

    // A drag after a placing press: the ghost follows the pointer, and the release hides it.
    h.press({ x: 90, y: 90 })
    h.move({ x: 110, y: 100 })
    expect(ghostPlant(h).position).toEqual({ x: 110, y: 100 })
    h.release()
    expect(ghosts(h)).toEqual([])
    hoverShows({ x: 100, y: 130 })

    h.blur()
    expect(ghosts(h)).toEqual([])
    hoverShows({ x: 130, y: 100 })

    // K again while armed (today's setTool to the same tool ran the cancellation).
    h.arm('object-stamp')
    expect(ghosts(h)).toEqual([])

    // The pick outlived them all.
    hoverShows({ x: 150, y: 150 })
    h.click({ x: 150, y: 150 })
    expect(h.store.persisted.plants.map((plant) => plant.position)).toEqual([
      { x: 40, y: 40 },
      { x: 90, y: 90 },
      { x: 150, y: 150 },
    ])
  })

  it('hides the ghost in overview and keeps the pick for when the map comes back', () => {
    const h = stampHarness({ plants: [smallApple({ x: 40, y: 40 })] })

    h.click({ x: 40, y: 40 })
    h.hover({ x: 90, y: 90 })
    expect(ghosts(h)).toHaveLength(1)

    h.view.setViewport({ x: 200, y: 150, scale: 0.05 })
    h.advance(0)
    expect(ghosts(h)).toEqual([])

    h.view.setViewport({ x: 0, y: 0, scale: 1 })
    h.advance(0)
    h.hover({ x: 120, y: 120 })
    expect(ghosts(h)).toHaveLength(1)
    h.click({ x: 120, y: 120 })
    expect(h.store.persisted.plants).toHaveLength(2)
  })

  it('shows the ghost again under a mouse resting where it was released at the next camera frame (plan §1, exception 1)', () => {
    const h = stampHarness({ plants: [smallApple({ x: 40, y: 40 })] })
    h.click({ x: 40, y: 40 })
    expect(ghosts(h)).toEqual([])

    h.wheelZoom({ x: 40, y: 40 }, 2)
    h.advance(0)
    // The zoom keeps the ground under the pointer: the ghost stands where the pick was pressed.
    expect(ghostPlant(h).position.x).toBeCloseTo(40, 6)
    expect(ghostPlant(h).position.y).toBeCloseTo(40, 6)
  })

  it('every cancellation reason hides the ghost until the next hover; none drops the pick', () => {
    const h = stampHarness({ plants: [smallApple({ x: 40, y: 40 })] })
    h.click({ x: 40, y: 40 })
    const tool = builtTools.at(-1)!

    for (const reason of ['tool-change', 'navigate', 'document-replaced', 'overview'] as const) {
      h.hover({ x: 90, y: 90 })
      expect(ghosts(h)).toHaveLength(1)
      tool.cancelTransient(reason)
      expect(ghosts(h)).toEqual([])
    }

    h.hover({ x: 120, y: 120 })
    expect(ghosts(h)).toHaveLength(1)
    h.click({ x: 120, y: 120 })
    expect(h.store.persisted.plants).toHaveLength(2)
  })

  it('Esc drops the pick, a second Esc leaves', () => {
    const h = stampHarness({ plants: [smallApple({ x: 40, y: 40 })] })
    expect(h.host.activeToolHasEscapeTransient()).toBe(false)

    h.click({ x: 40, y: 40 })
    // The pick is the tool's transient (the chain's tool-transient layer), and it holds re-origin.
    expect(h.host.activeToolHasEscapeTransient()).toBe(true)
    expect(h.host.holdsReorigin()).toBe(true)
    expect(h.host.command({ kind: 'escape' })).toBe('handled')
    expect(h.toolState.value).toBe('object-stamp')
    expect(ghosts(h)).toEqual([])
    expect(h.record.guidance.at(-1)).toMatchObject({ stamp: null, stampRotationDeg: null })

    // Nothing held: the tool's Esc passes, and the chain's tool layer leaves.
    expect(h.host.activeToolHasEscapeTransient()).toBe(false)
    expect(h.host.holdsReorigin()).toBe(false)
    expect(h.host.command({ kind: 'escape' })).toBe('pass')
    expect(h.toolState.value).toBe('object-stamp')
  })

  it('ignores Measurement Guides in Object Stamp sampling and placement', () => {
    const h = stampHarness({
      plants: [],
      zones: [],
      annotations: [],
      measurementGuides: [measurementGuide('measurement-guide-1', { x: 20, y: 40 }, { x: 120, y: 40 })],
    })
    const commits = committedEdits(h)

    h.click({ x: 60, y: 40 })
    h.hover({ x: 150, y: 90 })
    h.click({ x: 150, y: 90 })

    expect(h.store.persisted.measurementGuides).toHaveLength(1)
    expect(h.store.persisted.plants).toHaveLength(0)
    expect(h.store.persisted.zones).toHaveLength(0)
    expect(h.store.persisted.annotations).toHaveLength(0)
    expect(commits).toEqual([])
    expect(ghosts(h)).toEqual([])
  })

  it('snaps Object Stamp placement by the sampled plant anchor', () => {
    const h = stampHarness(
      { plants: [plantEntity('plant-1', 'Malus domestica', { x: 10, y: 10 }, { commonName: 'Apple', canopySpreadM: 4 })] },
      { viewport: { x: 0, y: 0, scale: 4 }, snapping: { grid: true } },
    )

    // Screen (44, 44) -> world (11, 11), so the sampled anchor is +1,+1 from the plant position.
    h.click({ x: 44, y: 44 })
    // Screen (93, 107) -> world (23.25, 26.75), snapped to (25, 25) at this zoom level.
    h.click({ x: 93, y: 107 })

    expect(h.store.persisted.plants[1]?.position).toEqual({ x: 24, y: 24 })
  })

  it('clears loaded Object Stamp source when changing tools', () => {
    const h = stampHarness({ plants: [smallApple({ x: 40, y: 40 })] })

    h.click({ x: 40, y: 40 })
    h.arm('select')
    expect(ghosts(h)).toEqual([])
    h.arm('object-stamp')
    h.click({ x: 90, y: 90 })

    expect(h.store.persisted.plants).toHaveLength(1)
    expect(h.record.guidance.at(-1)).toMatchObject({ stamp: null, stampRotationDeg: null })
  })

  it('clears loaded Object Stamp preview on dispose', () => {
    const h = stampHarness({ plants: [smallApple({ x: 40, y: 40 })] })

    h.click({ x: 40, y: 40 })
    h.hover({ x: 90, y: 90 })
    expect(ghosts(h)).toHaveLength(1)

    h.dispose()

    expect(h.renderer.lastDraft()).toBeNull()
  })

  it('blocks Object Stamp sampling and placement for locked or hidden plant sources', () => {
    const h = stampHarness({ plants: [smallApple({ x: 40, y: 40 }, { locked: true })] })
    const commits = committedEdits(h)

    h.click({ x: 40, y: 40 })
    h.click({ x: 90, y: 90 })
    expect(h.store.persisted.plants).toHaveLength(1)

    h.store.updatePersisted((draft) => {
      const plant = draft.plants.find((entry) => entry.id === 'plant-1')
      if (plant) plant.locked = false
    })
    h.click({ x: 40, y: 40 })
    h.store.updatePersisted((draft) => {
      const plantsLayer = draft.layers.find((layer) => layer.name === 'plants')
      if (plantsLayer) plantsLayer.visible = false
    })
    h.click({ x: 90, y: 90 })

    expect(h.store.persisted.plants).toHaveLength(1)
    expect(commits).toEqual([])
  })

  it('samples a zone with Object Stamp and places anchored collision-safe clones', () => {
    const h = stampHarness({
      zones: [
        rectZone('Kitchen bed', [{ x: 10, y: 20 }, { x: 50, y: 20 }, { x: 50, y: 60 }, { x: 10, y: 60 }], {
          name: 'Kitchen bed',
          fillColor: '#A06B1F',
          notes: 'Annuals',
        }),
        rectZone('Kitchen bed copy', [{ x: 200, y: 200 }, { x: 220, y: 200 }, { x: 220, y: 220 }, { x: 200, y: 220 }], {
          name: 'Kitchen bed copy',
        }),
      ],
    })
    const commits = committedEdits(h)

    h.click({ x: 10, y: 30 })
    expect(h.store.persisted.zones).toHaveLength(2)
    expect(commits).toEqual([])

    h.hover({ x: 120, y: 150 })
    expect(objectsGhost(ghosts(h)[0]).template.zones[0]!.entity.points).toEqual([
      { x: 120, y: 140 },
      { x: 160, y: 140 },
      { x: 160, y: 180 },
      { x: 120, y: 180 },
    ])

    h.click({ x: 120, y: 150 })

    expect(h.store.persisted.zones).toHaveLength(3)
    const clone = h.store.persisted.zones[2]!
    expect(clone).toMatchObject({
      name: 'Kitchen bed',
      zoneType: 'rect',
      rotationDeg: 0,
      points: [
        { x: 120, y: 140 },
        { x: 160, y: 140 },
        { x: 160, y: 180 },
        { x: 120, y: 180 },
      ],
      fillColor: '#A06B1F',
      notes: 'Annuals',
    })
    expect(selected(h)).toEqual([{ kind: 'zone', id: clone.id }])
    expect(commits).toEqual(['interaction-object-stamp'])
  })

  it('samples a linear zone with Object Stamp and places anchored clones', () => {
    const h = stampHarness({
      zones: [rectZone('Hedgerow', [{ x: 10, y: 20 }, { x: 50, y: 60 }], {
        name: 'Hedgerow',
        zoneType: 'line',
        fillColor: '#A06B1F',
        notes: 'Boundary',
      })],
    })
    const commits = committedEdits(h)

    h.click({ x: 20, y: 30 })
    h.hover({ x: 120, y: 150 })

    // The preview is the stamp itself: the line zone's ghost under the pointer.
    expect(objectsGhost(ghosts(h)[0]).template.zones[0]!.entity).toMatchObject({
      zoneType: 'line',
      points: [{ x: 110, y: 140 }, { x: 150, y: 180 }],
    })

    h.click({ x: 120, y: 150 })

    expect(h.store.persisted.zones).toHaveLength(2)
    expect(h.store.persisted.zones[1]).toMatchObject({
      name: 'Hedgerow',
      zoneType: 'line',
      rotationDeg: 0,
      points: [
        { x: 110, y: 140 },
        { x: 150, y: 180 },
      ],
      fillColor: '#A06B1F',
      notes: 'Boundary',
    })
    expect(selected(h)).toEqual([{ kind: 'zone', id: h.store.persisted.zones[1]!.id }])
    expect(commits).toEqual(['interaction-object-stamp'])
  })

  it('samples an annotation with Object Stamp and places anchored clones with fresh ids', () => {
    const h = stampHarness({
      annotations: [textNote('annotation-1', { x: 20, y: 30 }, 'Guild note', { fontSize: 20, rotationDeg: 12 })],
    })
    const commits = committedEdits(h)

    h.click({ x: 26, y: 36 })
    expect(h.store.persisted.annotations).toHaveLength(1)
    expect(commits).toEqual([])

    h.hover({ x: 100, y: 110 })
    // A note's ghost is its own, a little less faint than zones and plants (today's 0.68).
    expect(ghosts(h).map((shape) => shape.opacity)).toEqual([0.68])
    expect(objectsGhost(ghosts(h)[0]).template.annotations[0]!.entity).toMatchObject({
      position: { x: 94, y: 104 },
      text: 'Guild note',
    })

    h.click({ x: 100, y: 110 })

    expect(h.store.persisted.annotations).toHaveLength(2)
    const clone = h.store.persisted.annotations[1]!
    expect(clone.id).not.toBe('annotation-1')
    expect(clone).toMatchObject({
      annotationType: 'text',
      position: { x: 94, y: 104 },
      text: 'Guild note',
      fontSize: 20,
      rotationDeg: 12,
    })
    expect(selected(h)).toEqual([{ kind: 'annotation', id: clone.id }])
    expect(commits).toEqual(['interaction-object-stamp'])
  })

  it('snaps Object Stamp placement by the sampled annotation anchor', () => {
    const h = stampHarness(
      { annotations: [textNote('annotation-1', { x: 10, y: 10 }, 'Note', { fontSize: 20 })] },
      { viewport: { x: 0, y: 0, scale: 4 }, snapping: { grid: true } },
    )

    // Screen (44, 44) -> world (11, 11), so the sampled anchor is +1,+1 from the annotation position.
    h.click({ x: 44, y: 44 })
    // Screen (93, 107) -> world (23.25, 26.75), snapped to (25, 25) at this zoom level.
    h.click({ x: 93, y: 107 })

    expect(h.store.persisted.annotations[1]?.position).toEqual({ x: 24, y: 24 })
  })

  it('preserves elliptical zone radii when stamping zones', () => {
    const h = stampHarness({
      zones: [rectZone('Oval bed', [{ x: 50, y: 60 }, { x: 20, y: 10 }], { name: 'Oval bed', zoneType: 'ellipse' })],
    })

    h.click({ x: 70, y: 60 })
    h.click({ x: 100, y: 100 })

    expect(h.store.persisted.zones).toHaveLength(2)
    expect(h.store.persisted.zones[1]).toMatchObject({
      name: 'Oval bed',
      zoneType: 'ellipse',
      rotationDeg: 0,
      points: [
        { x: 80, y: 100 },
        { x: 20, y: 10 },
      ],
    })
  })

  it('blocks Object Stamp sampling and placement for locked or hidden zone and annotation sources', () => {
    const h = stampHarness({
      zones: [rectZone('Kitchen bed', [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }, { x: 10, y: 50 }], {
        name: 'Kitchen bed',
      })],
      annotations: [textNote('annotation-1', { x: 100, y: 30 }, 'Note', { fontSize: 20 })],
    })
    const commits = committedEdits(h)

    h.store.updatePersisted((draft) => {
      draft.zones = draft.zones.map((zone) => zone.id === 'Kitchen bed' ? { ...zone, locked: true } : zone)
    })
    h.click({ x: 20, y: 20 })
    h.click({ x: 120, y: 120 })
    expect(h.store.persisted.zones).toHaveLength(1)

    h.store.updatePersisted((draft) => {
      draft.zones = draft.zones.map((zone) => zone.id === 'Kitchen bed' ? { ...zone, locked: false } : zone)
    })
    h.click({ x: 20, y: 20 })
    h.store.updatePersisted((draft) => {
      const zonesLayer = draft.layers.find((layer) => layer.name === 'zones')
      if (zonesLayer) zonesLayer.visible = false
    })
    h.click({ x: 120, y: 120 })
    expect(h.store.persisted.zones).toHaveLength(1)

    h.arm('select')
    h.arm('object-stamp')
    h.store.updatePersisted((draft) => {
      const zonesLayer = draft.layers.find((layer) => layer.name === 'zones')
      if (zonesLayer) zonesLayer.visible = true
    })

    h.store.updatePersisted((draft) => {
      draft.annotations = draft.annotations.map((annotation) =>
        annotation.id === 'annotation-1' ? { ...annotation, locked: true } : annotation,
      )
    })
    h.click({ x: 104, y: 34 })
    h.click({ x: 150, y: 90 })
    expect(h.store.persisted.annotations).toHaveLength(1)

    h.store.updatePersisted((draft) => {
      draft.annotations = draft.annotations.map((annotation) =>
        annotation.id === 'annotation-1' ? { ...annotation, locked: false } : annotation,
      )
    })
    h.click({ x: 104, y: 34 })
    h.store.updatePersisted((draft) => {
      const annotationsLayer = draft.layers.find((layer) => layer.name === 'annotations')
      if (annotationsLayer) annotationsLayer.locked = true
    })
    h.click({ x: 150, y: 90 })

    expect(h.store.persisted.annotations).toHaveLength(1)
    expect(commits).toEqual([])
  })

  it('samples an object group with Object Stamp and places cloned members with remapped group membership', () => {
    const h = stampHarness({
      plants: [plantEntity('plant-1', 'Malus domestica', { x: 40, y: 40 }, {
        commonName: 'Apple',
        color: '#C44230',
        canopySpreadM: 4,
        rotationDeg: 15,
        notes: 'Tree',
      })],
      zones: [rectZone('Kitchen bed', [{ x: 10, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 50 }, { x: 10, y: 50 }], {
        name: 'Kitchen bed',
        fillColor: '#A06B1F',
        notes: 'Bed',
      })],
      annotations: [textNote('annotation-1', { x: 60, y: 30 }, 'Guild', { fontSize: 20, rotationDeg: 10 })],
      groups: [{
        kind: 'group',
        locked: false,
        id: 'group-1',
        name: 'Guild unit',
        members: [
          { kind: 'plant', id: 'plant-1' },
          { kind: 'zone', id: 'Kitchen bed' },
          { kind: 'annotation', id: 'annotation-1' },
        ],
      }],
    })
    const commits = committedEdits(h)

    h.click({ x: 40, y: 40 })
    expect(h.record.guidance.at(-1)?.stamp).toEqual({ kind: 'group', name: 'Guild unit', plants: 1, species: 1 })
    h.hover({ x: 100, y: 120 })
    // Zones and plants in one ghost, the note in its own.
    expect(ghosts(h).map((shape) => shape.opacity)).toEqual([0.62, 0.68])
    expect(objectsGhost(ghosts(h)[0]).template.plants.map(({ entity }) => entity.position)).toEqual([{ x: 100, y: 120 }])
    expect(objectsGhost(ghosts(h)[0]).template.zones).toHaveLength(1)
    expect(objectsGhost(ghosts(h)[1]).template.annotations.map(({ entity }) => entity.position)).toEqual([{ x: 120, y: 110 }])

    h.click({ x: 100, y: 120 })

    expect(h.store.persisted.groups).toHaveLength(2)
    expect(h.store.persisted.plants).toHaveLength(2)
    expect(h.store.persisted.zones).toHaveLength(2)
    expect(h.store.persisted.annotations).toHaveLength(2)

    const clonePlant = h.store.persisted.plants[1]!
    const cloneZone = h.store.persisted.zones[1]!
    const cloneAnnotation = h.store.persisted.annotations[1]!
    const cloneGroup = h.store.persisted.groups[1]!

    expect(clonePlant.id).not.toBe('plant-1')
    expect(clonePlant).toMatchObject({
      canonicalName: 'Malus domestica',
      position: { x: 100, y: 120 },
      rotationDeg: 15,
    })
    expect(cloneZone).toMatchObject({
      name: 'Kitchen bed',
      points: [
        { x: 70, y: 100 },
        { x: 90, y: 100 },
        { x: 90, y: 130 },
        { x: 70, y: 130 },
      ],
      fillColor: '#A06B1F',
      notes: 'Bed',
    })
    expect(cloneAnnotation.id).not.toBe('annotation-1')
    expect(cloneAnnotation).toMatchObject({
      position: { x: 120, y: 110 },
      text: 'Guild',
      fontSize: 20,
      rotationDeg: 10,
    })
    expect(cloneGroup).toMatchObject({
      name: 'Guild unit',
      members: [
        { kind: 'plant', id: clonePlant.id },
        { kind: 'zone', id: cloneZone.id },
        { kind: 'annotation', id: cloneAnnotation.id },
      ],
    })
    expect(cloneGroup.id).not.toBe('group-1')
    expect(h.store.persisted.groups[0]?.members).toEqual([
      { kind: 'plant', id: 'plant-1' },
      { kind: 'zone', id: 'Kitchen bed' },
      { kind: 'annotation', id: 'annotation-1' },
    ])
    expect(selected(h)).toEqual([{ kind: 'group', id: cloneGroup.id }])
    expect(commits).toEqual(['interaction-object-stamp'])
  })

  it('a group pick whose members were all removed refuses the placement', () => {
    const h = stampHarness({
      plants: [smallApple({ x: 40, y: 40 }, { canopySpreadM: 4 })],
      groups: [{
        kind: 'group',
        id: 'group-1',
        name: 'Guild unit',
        locked: false,
        members: [{ kind: 'plant', id: 'plant-1' }],
      }],
    })
    const commits = committedEdits(h)

    h.click({ x: 40, y: 40 })
    expect(h.record.guidance.at(-1)?.stamp).toMatchObject({ kind: 'group', plants: 1 })
    // An undo or a delete elsewhere removes the group's only member after the pick.
    h.store.updatePersisted((draft) => {
      draft.plants = []
    })
    h.click({ x: 120, y: 120 })

    expect(h.store.persisted.plants).toEqual([])
    expect(h.store.persisted.groups).toHaveLength(1)
    expect(commits).toEqual([])
  })

  it('blocks Object Stamp sampling and placement for locked group sources or locked group layers', () => {
    const h = stampHarness({
      plants: [smallApple({ x: 40, y: 40 }, { canopySpreadM: 4 })],
      groups: [{
        kind: 'group',
        id: 'group-1',
        name: 'Guild unit',
        locked: false,
        members: [{ kind: 'plant', id: 'plant-1' }],
      }],
    })
    const commits = committedEdits(h)

    h.store.updatePersisted((draft) => {
      draft.groups = draft.groups.map((group) => group.id === 'group-1' ? { ...group, locked: true } : group)
    })
    h.click({ x: 40, y: 40 })
    h.click({ x: 120, y: 120 })
    expect(h.store.persisted.groups).toHaveLength(1)
    expect(h.store.persisted.plants).toHaveLength(1)

    h.store.updatePersisted((draft) => {
      draft.groups = draft.groups.map((group) => group.id === 'group-1' ? { ...group, locked: false } : group)
    })
    h.click({ x: 40, y: 40 })
    h.store.updatePersisted((draft) => {
      const plantsLayer = draft.layers.find((layer) => layer.name === 'plants')
      if (plantsLayer) plantsLayer.locked = true
    })
    h.click({ x: 120, y: 120 })

    expect(h.store.persisted.groups).toHaveLength(1)
    expect(h.store.persisted.plants).toHaveLength(1)
    expect(commits).toEqual([])
  })

  it('blocks Object Stamp sampling and placement for group sources containing locked members', () => {
    const h = stampHarness({
      plants: [smallApple({ x: 40, y: 40 }, { canopySpreadM: 4 })],
      groups: [{
        kind: 'group',
        id: 'group-1',
        locked: false,
        name: 'Guild unit',
        members: [{ kind: 'plant', id: 'plant-1' }],
      }],
    })
    const commits = committedEdits(h)
    const lockPlant = (locked: boolean) => h.store.updatePersisted((draft) => {
      draft.plants = draft.plants.map((plant) => plant.id === 'plant-1' ? { ...plant, locked } : plant)
    })

    lockPlant(true)
    h.click({ x: 40, y: 40 })
    h.click({ x: 120, y: 120 })
    expect(h.store.persisted.groups).toHaveLength(1)
    expect(h.store.persisted.plants).toHaveLength(1)

    lockPlant(false)
    h.click({ x: 40, y: 40 })
    lockPlant(true)
    h.click({ x: 120, y: 120 })

    expect(h.store.persisted.groups).toHaveLength(1)
    expect(h.store.persisted.plants).toHaveLength(1)
    expect(commits).toEqual([])
  })
})
