import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createToolHarness,
  createToolSceneSource,
  type ToolHarness,
} from '../../../__tests__/support/tool-harness'
import {
  normalizeSavedObjectStampPayload,
  type SavedObjectStampPayload,
} from '../../saved-object-stamp-payload'
import type { SceneArrangementTemplate } from '../scene-runtime/arrangement-placement'
import type { DraftShape } from './draft'
import {
  canPlaceSavedObjectStamp,
  placeSavedObjectStamp,
  savedObjectStampGhostShapes,
} from './saved-object-stamp'
import type { CanvasTool } from './tool'
import { createToolScene } from './tool-host'
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

function harness(): ToolHarness {
  const created = createToolHarness()
  harnesses.push(created)
  return created
}

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose()
  builtTools.length = 0
})

/** A saved stamp as the read model holds it (normalised, as selectSavedObjectStampSource stores it). */
function stamp(payload: Omit<SavedObjectStampPayload, 'version'>): SavedObjectStampPayload {
  const normalized = normalizeSavedObjectStampPayload({ version: 2, ...payload })
  if (!normalized) throw new Error('The test stamp does not normalise.')
  return normalized
}

/** Arms the saved stamp with `held`, as the session does from the read model. */
function holding(h: ToolHarness, held: SavedObjectStampPayload): void {
  h.arm('saved-object-stamp', { kind: 'saved-stamp', stamp: held })
}

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

function ghostsIn(shapes: readonly DraftShape[] | null | undefined): GhostShape[] {
  return (shapes ?? []).filter((shape): shape is GhostShape => shape.kind === 'ghost')
}

/** The stamp's ghosts in the draft the renderer holds (the host may add its own decorations beside them). */
function ghosts(h: ToolHarness): GhostShape[] {
  return ghostsIn(h.renderer.lastDraft()?.shapes)
}

function templateOf(shape: GhostShape | undefined): SceneArrangementTemplate {
  if (shape?.entity.kind !== 'objects') throw new Error('Expected an objects ghost.')
  return shape.entity.template
}

/** The held angle the ghost shows: the turn of the stamp's level note (drawn in the second ghost), as a placement stores it. */
function ghostNoteRotation(h: ToolHarness): number | null {
  return templateOf(ghosts(h)[1]).annotations[0]!.entity.rotationDeg
}

/** The mulch stamp's ghost with its anchor at `at`, turned by `degrees`: its plant saved 10 m east of the anchor turns with it. */
function expectMulchGhostAt(h: ToolHarness, at: { x: number; y: number }, degrees: number): void {
  const radians = (degrees * Math.PI) / 180
  const plant = templateOf(ghosts(h)[0]).plants[0]!.entity
  expect(plant.position.x).toBeCloseTo(at.x + 10 * Math.cos(radians), 6)
  expect(plant.position.y).toBeCloseTo(at.y + 10 * Math.sin(radians), 6)
  expect(ghostNoteRotation(h)).toBe(degrees)
}

const GUILD = stamp({
  anchor: { x: 12, y: 24 },
  plants: [{
    id: 'plant-1',
    canonicalName: 'Malus domestica',
    commonName: 'Apple',
    color: '#C44230',
    symbol: 'canopy',
    position: { x: 12, y: 24 },
    rotationDeg: 15,
    scale: 4,
  }],
  zones: [{
    id: 'zone-1',
    name: 'Kitchen bed',
    zoneType: 'rect',
    points: [
      { x: 2, y: 10 },
      { x: 22, y: 10 },
      { x: 22, y: 30 },
      { x: 2, y: 30 },
    ],
    rotationDeg: 0,
    fillColor: '#A06B1F',
  }],
  annotations: [{
    id: 'annotation-1',
    annotationType: 'text',
    position: { x: 30, y: 20 },
    text: 'Guild',
    fontSize: 16,
    rotationDeg: 5,
  }],
  groups: [{
    id: 'group-1',
    name: 'Guild unit',
    members: [
      { kind: 'plant', id: 'plant-1' },
      { kind: 'zone', id: 'zone-1' },
      { kind: 'annotation', id: 'annotation-1' },
    ],
  }],
})

/** A plant 10 m east of the anchor, a 4 m square on it and a note 10 m south. */
function mulchStamp(): SavedObjectStampPayload {
  return stamp({
    anchor: { x: 0, y: 0 },
    plants: [{
      id: 'plant-1', canonicalName: 'Malus domestica', commonName: 'Apple', color: null, symbol: null,
      position: { x: 10, y: 0 }, rotationDeg: null, scale: null,
    }],
    zones: [{
      id: 'zone-1', name: null, zoneType: 'rect', rotationDeg: 0, fillColor: null,
      points: [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }],
    }],
    annotations: [{
      id: 'annotation-1', annotationType: 'text', position: { x: 0, y: 10 }, text: 'Mulch', fontSize: 16, rotationDeg: null,
    }],
    groups: [],
  })
}

const LOCKED_ZONE_ONLY = stamp({
  anchor: { x: 0, y: 0 },
  plants: [],
  zones: [{
    id: 'zone-1',
    name: 'Kitchen bed',
    zoneType: 'rect',
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    rotationDeg: 0,
    fillColor: null,
  }],
  annotations: [],
  groups: [],
})

function lockLayer(h: ToolHarness, name: string): void {
  h.store.updatePersisted((draft) => {
    draft.layers = draft.layers.map((layer) => layer.name === name ? { ...layer, locked: true } : layer)
  })
}

describe('saved object stamp tool', () => {
  it('places once, then returns to Select', () => {
    const h = harness()
    const commits = committedEdits(h)
    holding(h, GUILD)

    h.click({ x: 100, y: 120 })

    expect(commits).toEqual(['interaction-saved-object-stamp'])
    expect(h.toolState.value).toBe('select')
    expect(ghosts(h)).toEqual([])
    // The second press of a double-click reaches Select, which places nothing.
    h.click({ x: 100, y: 120 })
    expect(commits).toEqual(['interaction-saved-object-stamp'])
    expect(h.store.persisted.plants).toHaveLength(1)
  })

  it('places Saved Object Stamps with full ghost preview and selected unlocked copies', () => {
    const h = harness()
    const commits = committedEdits(h)
    holding(h, GUILD)

    h.hover({ x: 100, y: 120 })
    // Zones and plants in one ghost, the note in its own, where a click would put them.
    expect(ghosts(h).map((shape) => shape.opacity)).toEqual([0.62, 0.68])
    expect(templateOf(ghosts(h)[0]).plants.map(({ entity }) => entity.position)).toEqual([{ x: 100, y: 120 }])
    expect(templateOf(ghosts(h)[0]).zones.map(({ entity }) => entity.points[0])).toEqual([{ x: 90, y: 106 }])
    expect(templateOf(ghosts(h)[1]).annotations.map(({ entity }) => entity.position)).toEqual([{ x: 118, y: 116 }])

    h.click({ x: 100, y: 120 })

    expect(h.store.persisted.plants).toHaveLength(1)
    expect(h.store.persisted.zones).toHaveLength(1)
    expect(h.store.persisted.annotations).toHaveLength(1)
    expect(h.store.persisted.groups).toHaveLength(1)

    const plant = h.store.persisted.plants[0]!
    const zone = h.store.persisted.zones[0]!
    const annotation = h.store.persisted.annotations[0]!
    const group = h.store.persisted.groups[0]!

    expect(plant).toMatchObject({
      locked: false,
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: '#C44230',
      symbol: 'canopy',
      position: { x: 100, y: 120 },
      rotationDeg: 15,
      notes: null,
      plantedDate: null,
      quantity: null,
    })
    expect(zone).toMatchObject({
      locked: false,
      name: 'Kitchen bed',
      points: [
        { x: 90, y: 106 },
        { x: 110, y: 106 },
        { x: 110, y: 126 },
        { x: 90, y: 126 },
      ],
      fillColor: '#A06B1F',
      notes: null,
    })
    expect(annotation).toMatchObject({
      locked: false,
      position: { x: 118, y: 116 },
      text: 'Guild',
      fontSize: 16,
      rotationDeg: 5,
    })
    expect(group).toMatchObject({
      name: 'Guild unit',
      locked: false,
      members: [
        { kind: 'plant', id: plant.id },
        { kind: 'zone', id: zone.id },
        { kind: 'annotation', id: annotation.id },
      ],
    })
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'group', id: group.id }])
    expect(commits).toEqual(['interaction-saved-object-stamp'])
    expect(ghosts(h)).toEqual([])
  })

  it('blocks Saved Object Stamp placement when any target Layer is locked', () => {
    const h = harness()
    const commits = committedEdits(h)
    lockLayer(h, 'zones')
    holding(h, LOCKED_ZONE_ONLY)

    h.hover({ x: 100, y: 120 })
    expect(ghosts(h)).toEqual([])
    h.click({ x: 100, y: 120 })

    expect(h.store.persisted.zones).toHaveLength(0)
    expect(commits).toEqual([])
    expect(h.toolState.value).toBe('saved-object-stamp')
  })

  describe('stamp rotation', () => {
    it('turns a held saved stamp by 15° with ] and [, in its preview and in the objects it places', () => {
      const h = harness()
      holding(h, mulchStamp())
      h.hover({ x: 100, y: 100 })
      expect(h.record.guidance.at(-1)?.stampRotationDeg).toBe(0)

      for (let turn = 0; turn < 7; turn += 1) {
        expect(h.host.command({ kind: 'rotate-held', stepDeg: 15 })).toBe('handled')
      }
      h.host.command({ kind: 'rotate-held', stepDeg: -15 })
      expect(h.record.guidance.at(-1)?.stampRotationDeg).toBe(90)
      // The ghost turns with it: the plant 10 m east of the anchor now shows 10 m south of the pointer.
      expect(ghostNoteRotation(h)).toBe(90)
      const ghostPlant = templateOf(ghosts(h)[0]).plants[0]!.entity
      expect(ghostPlant.position.x).toBeCloseTo(100, 6)
      expect(ghostPlant.position.y).toBeCloseTo(110, 6)

      h.click({ x: 100, y: 100 })
      expect(h.store.persisted.plants[0]?.position).toEqual({ x: 100, y: 110 })
      expect(h.store.persisted.zones[0]?.rotationDeg).toBe(90)
      expect(h.store.persisted.annotations[0]).toMatchObject({ position: { x: 90, y: 100 }, rotationDeg: 90 })
    })

    it('a saved stamp pick starts at the bearing and the tool card reads 0°', () => {
      // The screen centre shows the plane's origin; the map is turned 30° (spec §4.7, phase-1 amendment A13).
      const h = createToolHarness({ camera: { bearingDeg: 30 } })
      harnesses.push(h)
      holding(h, mulchStamp())
      expect(h.record.guidance.at(-1)?.stampRotationDeg).toBe(0)

      h.hover({ x: 200, y: 150 })
      const anchor = h.world({ x: 200, y: 150 })
      expect(ghostNoteRotation(h)).toBe(30)
      // Level to the screen: the plant saved 10 m east of the anchor shows 10 px right of the pointer.
      const right = h.world({ x: 210, y: 150 })
      const ghostPlant = templateOf(ghosts(h)[0]).plants[0]!.entity
      expect(ghostPlant.position.x).toBeCloseTo(right.x, 6)
      expect(ghostPlant.position.y).toBeCloseTo(right.y, 6)

      // ] turns it 15° from the pick's start: the card reads 15°, the copies are stored at 45°.
      h.host.command({ kind: 'rotate-held', stepDeg: 15 })
      expect(h.record.guidance.at(-1)?.stampRotationDeg).toBe(15)
      expect(ghostNoteRotation(h)).toBe(45)
      h.host.command({ kind: 'rotate-held', stepDeg: -15 })
      h.host.command({ kind: 'rotate-held', stepDeg: -15 })
      expect(h.record.guidance.at(-1)?.stampRotationDeg).toBe(345)
      expect(ghostNoteRotation(h)).toBe(15)

      // Another stamp starts at the bearing again.
      h.host.sourceChanged({ kind: 'saved-stamp', stamp: mulchStamp() })
      expect(h.record.guidance.at(-1)?.stampRotationDeg).toBe(0)
      h.host.command({ kind: 'rotate-held', stepDeg: 15 })
      h.click({ x: 200, y: 150 })
      expect(h.store.persisted.zones[0]?.rotationDeg).toBe(45)
      expect(h.store.persisted.annotations[0]?.rotationDeg).toBe(45)
      expect(h.store.persisted.plants[0]!.position.x).toBeCloseTo(anchor.x + 10 * Math.cos(Math.PI / 4), 6)
      expect(h.store.persisted.plants[0]!.position.y).toBeCloseTo(anchor.y + 10 * Math.sin(Math.PI / 4), 6)
    })

    it('a held saved stamp keeps its ground angle when the view turns, as an Object stamp pick does', () => {
      // At bearing 30 the stamp is chosen and ] lines it up with a bed edge (spec §4.7: the pick starts at the bearing).
      const h = createToolHarness({ camera: { bearingDeg: 30 } })
      harnesses.push(h)
      holding(h, mulchStamp())
      h.host.command({ kind: 'rotate-held', stepDeg: 15 })
      // Shift+→ turns the view to 45° with the stamp held.
      const { camera } = h.view.host.frames.viewFrame.peek().view
      h.view.host.current().apply({ kind: 'set', target: { ...camera, bearingDeg: 45 }, animation: 'none' })

      h.hover({ x: 200, y: 150 })
      // The card shows rotationDeg minus the pick's start; the ghost keeps the angle it was lined up at.
      expect(h.record.guidance.at(-1)?.stampRotationDeg).toBe(15)
      expect(ghostNoteRotation(h)).toBe(45)

      h.click({ x: 200, y: 150 })
      expect(h.store.persisted.zones[0]?.rotationDeg).toBe(45)
      expect(h.store.persisted.annotations[0]?.rotationDeg).toBe(45)
    })

    it('the ghost left with the pointer off the map keeps its ground angle as the view turns', () => {
      const h = harness()
      holding(h, mulchStamp())
      h.hover({ x: 200, y: 150 })
      h.host.command({ kind: 'rotate-held', stepDeg: 15 })
      // The pointer moves onto the compass: the ghost stays where it was drawn.
      h.leave()
      expect(ghostNoteRotation(h)).toBe(15)

      // The compass or "Turn view to this edge" turns the view to 30° with no pointer on the map.
      const { camera } = h.view.host.frames.viewFrame.peek().view
      h.view.host.current().apply({ kind: 'set', target: { ...camera, bearingDeg: 30 }, animation: 'none' })
      h.advance(0)

      // After any frame runs, the parked ghost keeps the ground angle a click places.
      expectMulchGhostAt(h, { x: 200, y: 150 }, 15)
      expect(h.record.guidance.at(-1)?.stampRotationDeg).toBe(15)
    })

    it('a stamp chosen while armed starts level to the screen, and none leaves nothing to turn', () => {
      const h = harness()
      holding(h, mulchStamp())
      h.hover({ x: 100, y: 100 })
      h.host.command({ kind: 'rotate-held', stepDeg: 15 })
      expect(h.record.guidance.at(-1)?.stampRotationDeg).toBe(15)

      h.host.sourceChanged({ kind: 'saved-stamp', stamp: mulchStamp() })
      expect(h.record.guidance.at(-1)?.stampRotationDeg).toBe(0)
      // The turned ghost of the stamp it held goes; the new stamp shows at the next hover.
      expect(ghosts(h)).toEqual([])
      h.hover({ x: 100, y: 100 })
      expect(ghostNoteRotation(h) ?? 0).toBe(0)

      h.host.sourceChanged(null)
      expect(h.record.guidance.at(-1)?.stampRotationDeg).toBeNull()
      expect(h.host.command({ kind: 'rotate-held', stepDeg: 15 })).toBe('pass')
      h.hover({ x: 120, y: 100 })
      expect(ghosts(h)).toEqual([])
      h.click({ x: 120, y: 100 })
      expect(h.store.persisted.plants).toHaveLength(0)
    })
  })

  it('hides the ghost in overview and keeps the stamp for when the map comes back', () => {
    const h = harness()
    holding(h, mulchStamp())
    h.hover({ x: 100, y: 100 })
    h.host.command({ kind: 'rotate-held', stepDeg: 15 })
    expect(ghosts(h)).toHaveLength(2)

    h.view.setViewport({ x: 200, y: 150, scale: 0.05 })
    h.advance(0)
    expect(ghosts(h)).toEqual([])

    h.view.setViewport({ x: 0, y: 0, scale: 1 })
    h.advance(0)
    h.hover({ x: 120, y: 120 })
    expectMulchGhostAt(h, { x: 120, y: 120 }, 15)
    h.click({ x: 120, y: 120 })
    expect(h.store.persisted.plants).toHaveLength(1)
  })

  it('every cancellation reason hides the ghost until the next hover; none drops the stamp', () => {
    const h = harness()
    holding(h, mulchStamp())
    const tool = builtTools.at(-1)!

    for (const reason of ['tool-change', 'navigate', 'document-replaced', 'overview'] as const) {
      h.hover({ x: 100, y: 100 })
      expect(ghosts(h)).toHaveLength(2)
      tool.cancelTransient(reason)
      expect(ghosts(h)).toEqual([])
    }

    h.hover({ x: 120, y: 120 })
    expect(ghosts(h)).toHaveLength(2)
    h.click({ x: 120, y: 120 })
    expect(h.store.persisted.plants).toHaveLength(1)
  })

  it('hides the ghost on a window blur or the tool armed again, until the next hover, and keeps the stamp and its angle', () => {
    const h = harness()
    holding(h, mulchStamp())
    h.hover({ x: 100, y: 100 })
    h.host.command({ kind: 'rotate-held', stepDeg: 15 })
    expect(ghosts(h)).toHaveLength(2)

    h.blur()
    expect(ghosts(h)).toEqual([])
    h.hover({ x: 110, y: 100 })
    expectMulchGhostAt(h, { x: 110, y: 100 }, 15)

    // Today's setTool to the same tool ran the cancellation.
    h.arm('saved-object-stamp')
    expect(ghosts(h)).toEqual([])
    // A press that places nothing (an edit that does not commit) leaves the stamp; its release hides the ghost again.
    h.hover({ x: 120, y: 100 })
    expectMulchGhostAt(h, { x: 120, y: 100 }, 15)
    vi.spyOn(h.edits, 'run').mockReturnValueOnce(false)
    h.press({ x: 120, y: 100 })
    expect(h.store.persisted.plants).toHaveLength(0)
    expect(ghosts(h)).toHaveLength(2)
    h.release()
    expect(ghosts(h)).toEqual([])
    expect(h.toolState.value).toBe('saved-object-stamp')

    h.hover({ x: 130, y: 100 })
    h.click({ x: 130, y: 100 })
    expect(h.store.persisted.plants).toHaveLength(1)
  })

  it('Esc leaves at once: the held stamp is no transient, so the chain\'s tool layer leaves', () => {
    const h = harness()
    holding(h, GUILD)
    h.hover({ x: 100, y: 120 })

    expect(h.host.activeToolHasEscapeTransient()).toBe(false)
    expect(h.host.command({ kind: 'escape' })).toBe('pass')
    expect(h.toolState.value).toBe('saved-object-stamp')
  })

  describe('drop placement', () => {
    it('previews and places a dropped stamp at the given point, level, as one saved-stamp edit', () => {
      const h = harness()
      const commits = committedEdits(h)
      const scene = createToolScene(createToolSceneSource(h.store))
      const at = { x: 100, y: 120 }

      expect(canPlaceSavedObjectStamp(scene, GUILD)).toBe(true)
      const preview = savedObjectStampGhostShapes(scene, GUILD, at, 0)
      expect(ghostsIn(preview).map((shape) => shape.opacity)).toEqual([0.62, 0.68])
      expect(templateOf(ghostsIn(preview)[0]).plants[0]!.entity.position).toEqual(at)

      const onCommitted = vi.fn()
      placeSavedObjectStamp(h.edits, scene, GUILD, at, { rotationDeg: 0, onCommitted })

      expect(onCommitted).toHaveBeenCalledOnce()
      expect(commits).toEqual(['interaction-saved-object-stamp'])
      expect(h.store.persisted.plants[0]).toMatchObject({ position: at, rotationDeg: 15, pinnedName: false })
      expect(h.store.persisted.groups).toHaveLength(1)
    })

    it('refuses a stamp with nothing to place or a layer it adds to that is hidden or locked', () => {
      const h = harness()
      const commits = committedEdits(h)
      const scene = createToolScene(createToolSceneSource(h.store))
      const empty = stamp({ anchor: { x: 0, y: 0 }, plants: [], zones: [], annotations: [], groups: [] })

      expect(canPlaceSavedObjectStamp(scene, empty)).toBe(false)
      lockLayer(h, 'zones')
      expect(canPlaceSavedObjectStamp(scene, LOCKED_ZONE_ONLY)).toBe(false)
      expect(savedObjectStampGhostShapes(scene, LOCKED_ZONE_ONLY, { x: 10, y: 10 }, 0)).toBeNull()
      const onCommitted = vi.fn()
      placeSavedObjectStamp(h.edits, scene, LOCKED_ZONE_ONLY, { x: 10, y: 10 }, { rotationDeg: 0, onCommitted })
      expect(onCommitted).not.toHaveBeenCalled()
      h.store.updatePersisted((draft) => {
        draft.layers = draft.layers.map((layer) => layer.name === 'plants' ? { ...layer, visible: false } : layer)
      })
      expect(canPlaceSavedObjectStamp(scene, GUILD)).toBe(false)

      expect(h.store.persisted.zones).toHaveLength(0)
      expect(commits).toEqual([])
    })
  })
})
