// The pick contract (canopi-qd2k, the user's decision of 2026-10-14): every closed zone (polygon, rectangle, ellipse) is
// picked by its outline only, within PICK_TOLERANCE_PX of it in screen pixels (6 for a mouse or a pen, 16 for a finger) at
// every zoom and bearing; a click picks the one topmost drawn object (notes over plants over guides over zones), so a
// click inside a zone picks what lies beneath or nothing, and among zones in reach the nearest line wins; the context
// menu (right-click, long press) targets exactly what a click would select; the passive hover highlights what a mouse
// click would pick; a band selects a zone when it crosses one of its lines or holds it whole, and a band wholly inside a
// zone selects only what it touches there. Lines, guides and plants keep their own picking. This contract replaced the
// fill picking of canopi-f47t.2 (A25) and canopi-f47t.40, which had reversed canopi-c7k8's outline rule: rewriting it
// needs the user's word.

import { afterEach, describe, expect, it } from 'vitest'
import { stageScaleToMapZoom } from '../../projection'
import {
  createToolHarness,
  createToolSceneSource,
  measurementGuide,
  plantEntity,
  rectZone,
  textNote,
  type ToolHarness,
} from '../../../__tests__/support/tool-harness'
import type { PointerKind } from '../interaction-types'
import type { ScenePersistedState, ScenePoint, SceneZoneEntity } from '../scene'
import { sceneTargetKey, type SceneDesignObjectTarget } from '../scene/design-object-targets'
import type { ScreenPoint } from '../view/types'
import { PICK_TOLERANCE_PX } from './hit-testing'
import { contextMenuTargetAt, createToolScene } from './tool-host'

const harnesses: ToolHarness[] = []

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose()
})

/** The layout in screen pixels at bearing 0, around the screen centre; each case scales it to metres. */
type Px = ScenePoint

function zone(id: string, zoneType: SceneZoneEntity['zoneType'], points: Px[], scale: number, locked = false): SceneZoneEntity {
  return rectZone(id, points.map((p) => metres(p, scale)), { zoneType, locked })
}

function rect(id: string, x0: number, y0: number, x1: number, y1: number, scale: number, locked = false): SceneZoneEntity {
  return zone(id, 'rect', [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], scale, locked)
}

function metres(p: Px, scale: number): ScenePoint {
  return { x: p.x / scale, y: p.y / scale }
}

function plant(id: string, at: Px, scale: number) {
  return plantEntity(id, 'Malus domestica', metres(at, scale), { canopySpreadM: null })
}

/**
 * bed: a rectangle with the Apple inside and the Pear on its right edge. field: a polygon. pond: an ellipse. plot: a
 * rectangle grouped (g) with the Plum inside it, the ungrouped Fig on its top edge. outer and inner: nested rectangles.
 * hedge: a line zone. guide: a measurement guide. shed: an object-locked rectangle. note: a note on the field's left edge.
 * west and east: side-by-side rectangles whose facing edges are 10 px apart, east drawn over west.
 */
function layout(scale: number): Partial<ScenePersistedState> {
  return {
    plants: [
      plant('apple', { x: -240, y: -210 }, scale),
      plant('pear', { x: -180, y: -230 }, scale),
      plant('fig', { x: -240, y: -50 }, scale),
      plant('plum', { x: -270, y: 0 }, scale),
    ],
    zones: [
      rect('bed', -300, -250, -180, -170, scale),
      zone('field', 'polygon', [{ x: -100, y: -250 }, { x: 40, y: -250 }, { x: 40, y: -160 }, { x: -30, y: -140 }, { x: -100, y: -160 }], scale),
      zone('pond', 'ellipse', [{ x: 200, y: -200 }, { x: 80, y: 50 }], scale),
      rect('plot', -300, -50, -180, 30, scale),
      rect('outer', -100, -50, 100, 150, scale),
      rect('inner', -50, 0, 50, 100, scale),
      zone('hedge', 'line', [{ x: 150, y: 0 }, { x: 300, y: 0 }], scale),
      rect('shed', 150, 200, 300, 280, scale, true),
      rect('west', -300, 200, -230, 280, scale),
      rect('east', -220, 200, -150, 280, scale),
    ],
    measurementGuides: [measurementGuide('guide', metres({ x: 150, y: 100 }, scale), metres({ x: 300, y: 100 }, scale))],
    annotations: [textNote('note', metres({ x: -100, y: -205 }, scale), 'Herbs')],
    groups: [{ kind: 'group', id: 'g', locked: false, name: null, members: [{ kind: 'zone', id: 'plot' }, { kind: 'plant', id: 'plum' }] }],
  }
}

/** A place on the map: a layout point, or `px` screen pixels from a layout point towards another (from it when negative). */
type Place = Px | { readonly from: Px; readonly toward: Px; readonly px: number }

interface Row {
  readonly name: string
  readonly at: Place
  readonly pointer: PointerKind
  /** 'kind:id', or null for nothing. */
  readonly pick: string | null
  /** The pick came through a plant, not its group's zone line: no edge for "Turn view to this edge". */
  readonly noEdge?: true
}

const BED_LEFT = { x: -300, y: -210 }
const BED_IN = { x: -240, y: -190 }
const POND_RIGHT = { x: 280, y: -200 }
const POND_CENTRE = { x: 200, y: -200 }
const FIELD_SLANT = { x: 5, y: -150 }
const FIELD_IN = { x: -30, y: -200 }
const INNER_LEFT = { x: -50, y: 30 }
const HEDGE = { x: 220, y: 0 }
const GUIDE = { x: 220, y: 100 }
const SHED_LEFT = { x: 150, y: 240 }
const WEST_RIGHT = { x: -230, y: 240 }
const EAST_LEFT = { x: -220, y: 240 }

/** The picks whose zone has edges for "Turn view to this edge": every zone but the pond (an ellipse); g, by its plot. */
const PICKS_WITH_EDGES: ReadonlySet<string | null> = new Set(['zone:bed', 'zone:field', 'zone:plot', 'zone:inner', 'zone:hedge', 'zone:shed', 'zone:west', 'zone:east', 'group:g'])

const both = (row: Omit<Row, 'pointer'>): Row[] => [{ ...row, pointer: 'mouse' }, { ...row, pointer: 'touch' }]

const ROWS: readonly Row[] = [
  ...both({ name: 'a plant inside a zone', at: { x: -240, y: -210 }, pick: 'plant:apple' }),
  ...both({ name: 'empty ground inside a rectangle', at: { x: -275, y: -200 }, pick: null }),
  ...both({ name: '5 px inside a rectangle edge', at: { from: BED_LEFT, toward: BED_IN, px: 5 }, pick: 'zone:bed' }),
  ...both({ name: '5 px outside a rectangle edge', at: { from: BED_LEFT, toward: BED_IN, px: -5 }, pick: 'zone:bed' }),
  { name: '8 px inside a rectangle edge', at: { from: BED_LEFT, toward: BED_IN, px: 8 }, pointer: 'mouse', pick: null },
  { name: '8 px inside a rectangle edge', at: { from: BED_LEFT, toward: BED_IN, px: 8 }, pointer: 'pen', pick: null },
  { name: '8 px inside a rectangle edge', at: { from: BED_LEFT, toward: BED_IN, px: 8 }, pointer: 'touch', pick: 'zone:bed' },
  { name: '14 px outside a rectangle edge', at: { from: BED_LEFT, toward: BED_IN, px: -14 }, pointer: 'touch', pick: 'zone:bed' },
  { name: '20 px inside a rectangle edge', at: { from: BED_LEFT, toward: BED_IN, px: 20 }, pointer: 'touch', pick: null },
  ...both({ name: '5 px inside a polygon edge', at: { from: FIELD_SLANT, toward: FIELD_IN, px: 5 }, pick: 'zone:field' }),
  ...both({ name: '5 px outside a polygon edge', at: { from: FIELD_SLANT, toward: FIELD_IN, px: -5 }, pick: 'zone:field' }),
  { name: '10 px inside a polygon edge', at: { from: FIELD_SLANT, toward: FIELD_IN, px: 10 }, pointer: 'mouse', pick: null },
  { name: '10 px inside a polygon edge', at: { from: FIELD_SLANT, toward: FIELD_IN, px: 10 }, pointer: 'touch', pick: 'zone:field' },
  ...both({ name: 'inside a polygon, away from its lines', at: FIELD_IN, pick: null }),
  ...both({ name: '5 px inside an ellipse', at: { from: POND_RIGHT, toward: POND_CENTRE, px: 5 }, pick: 'zone:pond' }),
  ...both({ name: '5 px outside an ellipse', at: { from: POND_RIGHT, toward: POND_CENTRE, px: -5 }, pick: 'zone:pond' }),
  { name: '10 px inside an ellipse', at: { from: POND_RIGHT, toward: POND_CENTRE, px: 10 }, pointer: 'mouse', pick: null },
  { name: '10 px inside an ellipse', at: { from: POND_RIGHT, toward: POND_CENTRE, px: 10 }, pointer: 'touch', pick: 'zone:pond' },
  ...both({ name: 'an ellipse\'s centre', at: POND_CENTRE, pick: null }),
  ...both({ name: 'a plant on a zone\'s line', at: { x: -180, y: -230 }, pick: 'plant:pear' }),
  ...both({ name: 'a plant on a grouped zone\'s line', at: { x: -240, y: -50 }, pick: 'plant:fig' }),
  ...both({ name: 'near a grouped zone\'s line', at: { x: -296, y: -10 }, pick: 'group:g' }),
  ...both({ name: 'a grouped plant inside its grouped zone', at: { x: -270, y: 0 }, pick: 'group:g', noEdge: true }),
  ...both({ name: 'inside a grouped zone, away from its lines', at: { x: -220, y: 0 }, pick: null }),
  ...both({ name: 'a note over a zone\'s line', at: { x: -98, y: -203 }, pick: 'annotation:note' }),
  ...both({ name: 'inside the outer zone, 4 px from the inner one\'s line', at: { from: INNER_LEFT, toward: { x: -100, y: 30 }, px: 4 }, pick: 'zone:inner' }),
  ...both({ name: 'inside both nested zones, away from their lines', at: { x: 0, y: 50 }, pick: null }),
  ...both({ name: 'inside the outer zone only, away from its lines', at: { x: -75, y: 125 }, pick: null }),
  ...both({ name: '4 px from a line zone', at: { from: HEDGE, toward: { x: 220, y: 50 }, px: 4 }, pick: 'zone:hedge' }),
  { name: '10 px from a line zone', at: { from: HEDGE, toward: { x: 220, y: 50 }, px: 10 }, pointer: 'touch', pick: null },
  ...both({ name: '4 px from a guide', at: { from: GUIDE, toward: { x: 220, y: 150 }, px: 4 }, pick: 'measurement-guide:guide' }),
  { name: '10 px from a guide', at: { from: GUIDE, toward: { x: 220, y: 150 }, px: 10 }, pointer: 'touch', pick: null },
  ...both({ name: 'on a zone\'s line, 10 px from a zone drawn over it', at: WEST_RIGHT, pick: 'zone:west' }),
  ...both({ name: '4 px from a zone\'s line, 6 px from a zone drawn over it', at: { from: WEST_RIGHT, toward: EAST_LEFT, px: 4 }, pick: 'zone:west' }),
  ...both({ name: 'on the line of a zone drawn over another 10 px away', at: EAST_LEFT, pick: 'zone:east' }),
  ...both({ name: '4 px inside an object-locked zone', at: { from: SHED_LEFT, toward: { x: 225, y: 240 }, px: 4 }, pick: 'zone:shed' }),
]

const SCALES = [1, 40] as const
const BEARINGS = [0, 30] as const

function key(target: SceneDesignObjectTarget | null | undefined): string | null {
  return target ? sceneTargetKey(target) : null
}

function setup(scale: number, bearingDeg: number) {
  const h = createToolHarness({
    scene: layout(scale),
    screen: { width: 1000, height: 1000 },
    camera: { zoom: stageScaleToMapZoom(scale, 0), bearingDeg },
  })
  harnesses.push(h)
  const scene = createToolScene(createToolSceneSource(h.store, { pixelsPerMetre: () => h.view.view().pixelsPerMetre }))
  const toScreen = (p: Px): ScreenPoint => h.view.view().worldToScreen(metres(p, scale))
  const screenAt = (place: Place): ScreenPoint => {
    if (!('from' in place)) return toScreen(place)
    const a = toScreen(place.from)
    const b = toScreen(place.toward)
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    return { x: a.x + ((b.x - a.x) / length) * place.px, y: a.y + ((b.y - a.y) / length) * place.px }
  }
  return { h, scene, toScreen, screenAt }
}

describe('(canopi-qd2k) zones are picked by their outline only (user decision 2026-10-14)', () => {
  it('the tolerance table: 6 px for a mouse or a pen, 16 px for a finger', () => {
    expect(PICK_TOLERANCE_PX).toEqual({ mouse: 6, pen: 6, touch: 16 })
  })

  for (const scale of SCALES) {
    for (const bearingDeg of BEARINGS) {
      describe(`at ${scale} px/m, bearing ${bearingDeg}°`, () => {
        it.each(ROWS)('$pointer: $name picks $pick, and the click and the menu agree', ({ at, pointer, pick, noEdge }) => {
          const { h, scene, screenAt } = setup(scale, bearingDeg)
          expect(h.view.view().pixelsPerMetre).toBeCloseTo(scale, 6)
          const screen = screenAt(at)
          const world = h.world(screen)

          expect(key(scene.hitAt(world, { pointer })?.kind === 'object' ? (scene.hitAt(world, { pointer }) as { target: SceneDesignObjectTarget }).target : null)).toBe(pick)
          expect(key(contextMenuTargetAt(scene, world, pointer).target)).toBe(pick)

          // The click: the pick alone, or a cleared selection (a selected Apple elsewhere is let go).
          h.select({ kind: 'plant', id: 'apple' })
          h.click(screen, { pointer })
          expect(h.store.session.selectedTargets.map(key)).toEqual(pick ? [pick] : [])

          // The menu targets what the click selected: the pick, or the empty map's menu with the selection kept.
          h.select({ kind: 'plant', id: 'apple' })
          h.menu(screen, pointer === 'touch' ? 'long-press' : 'mouse')
          expect(key(h.record.menus.at(-1)?.pick?.target)).toBe(pick)
          expect(h.store.session.selectedTargets.map(key)).toEqual(pick ? [pick] : ['plant:apple'])
          // "Turn view to this edge" is offered only on an edge of the zone it picks (an ellipse has none).
          expect(h.record.menus.at(-1)?.turnViewToEdge !== undefined).toBe(PICKS_WITH_EDGES.has(pick) && !noEdge)

          // A mouse hover highlights what its click picks.
          if (pointer !== 'touch') {
            h.hover(screen)
            expect(key(h.record.hovers.at(-1))).toBe(pick)
          }
        })

        it('a band selects a zone it crosses or holds whole; a band wholly inside a zone selects only the plants there', () => {
          const { h, toScreen, screenAt } = setup(scale, bearingDeg)
          const zonesBefore = structuredClone(h.store.persisted.zones)
          const around = (p: Px, half: number): [ScreenPoint, ScreenPoint] => {
            const c = toScreen(p)
            return [{ x: c.x - half, y: c.y - half }, { x: c.x + half, y: c.y + half }]
          }
          const band = (corners: [ScreenPoint, ScreenPoint]) => {
            h.select()
            h.drag(corners[0], corners[1])
            return h.store.session.selectedTargets.map(key)
          }

          /** A band pressed 30 px outside a line, away from its tolerance, released 20 px inside it. */
          const across = (from: Px, toward: Px): [ScreenPoint, ScreenPoint] =>
            [screenAt({ from, toward, px: -30 }), screenAt({ from, toward, px: 20 })]

          // Inside the bed, around the Apple: the Apple only.
          expect(band(around({ x: -240, y: -210 }, 20))).toEqual(['plant:apple'])
          // Inside the bed, on empty ground: nothing.
          expect(band(around({ x: -280, y: -185 }, 8))).toEqual([])
          // Across the bed's left edge: the bed.
          expect(band(across(BED_LEFT, BED_IN))).toEqual(['zone:bed'])
          // Around the whole pond: the pond.
          expect(band(around(POND_CENTRE, 100))).toEqual(['zone:pond'])
          // Inside the outer zone, across the inner one's left edge: the inner zone only.
          expect(band(across(INNER_LEFT, { x: 0, y: 30 }))).toEqual(['zone:inner'])
          // Inside both nested zones: nothing.
          expect(band(around({ x: 0, y: 50 }, 20))).toEqual([])
          // A band draws and selects; it never moves a zone.
          expect(h.store.persisted.zones).toEqual(zonesBefore)
        })
      })
    }
  }

  it('a band across an ellipse\'s drawn line selects it at high zoom, midway between the outline\'s corners', () => {
    // 10 m radius at 500 px/m: 5000 px on screen, where a fixed 48-gon would lie about 10 px inside the drawn curve.
    const scale = 500
    const radius = 10
    const theta = Math.PI / 48
    const centre = { x: -radius * Math.cos(theta), y: -radius * Math.sin(theta) }
    const h = createToolHarness({
      scene: { zones: [rectZone('pond', [centre, { x: radius, y: radius }], { zoneType: 'ellipse' })] },
      screen: { width: 1000, height: 1000 },
      camera: { zoom: stageScaleToMapZoom(scale, 0), bearingDeg: 0 },
    })
    harnesses.push(h)
    expect(h.view.view().pixelsPerMetre).toBeCloseTo(scale, 6)
    const onLine = h.view.view().worldToScreen({ x: 0, y: 0 })
    const inward = Math.sign(h.view.view().worldToScreen(centre).x - onLine.x)
    // From 20 px outside the drawn line to 4 px inside it, 8 px tall.
    h.drag({ x: onLine.x - inward * 20, y: onLine.y - 4 }, { x: onLine.x + inward * 4, y: onLine.y + 4 })
    expect(h.store.session.selectedTargets.map(key)).toEqual(['zone:pond'])
  })

  it('a zone on a locked layer is picked by neither a click nor the menu; the hover still highlights its line and the menu turns to its edge', () => {
    const { h, scene, screenAt } = setup(1, 0)
    h.store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (layer.name === 'zones' ? { ...layer, locked: true } : layer))
    })
    const screen = screenAt({ from: BED_LEFT, toward: BED_IN, px: 4 })
    const world = h.world(screen)

    expect(scene.hitAt(world, { pointer: 'mouse' })).toBeNull()
    expect(scene.hitAt(world, { pointer: 'mouse', includeLocked: true })).toEqual({ kind: 'object', target: { kind: 'zone', id: 'bed' } })
    expect(contextMenuTargetAt(scene, world, 'mouse')).toEqual({ visible: { kind: 'zone', id: 'bed' }, target: null })
    h.click(screen)
    expect(h.store.session.selectedTargets).toEqual([])
    h.hover(screen)
    expect(h.record.hovers.at(-1)).toEqual({ kind: 'zone', id: 'bed' })
    // Its menu names the bed (the visible pick), so it offers the bed's edge: turning the view moves no object.
    h.menu(screen, 'mouse')
    expect(h.record.menus.at(-1)!.turnViewToEdge).toBeTypeOf('function')
    expect(scene.hitAt(world, { pointer: 'mouse', includeLocked: true, zoneEdge: true })).toMatchObject({ kind: 'zone-edge', zoneId: 'bed' })
    // Select's double-click corner follows its own editable pick: no edge on a locked layer.
    expect(scene.hitAt(world, { pointer: 'mouse', zoneEdge: true })).toBeNull()
  })

  it('canopi-eon8.14.3: a click and the menu on a member of a group holding a locked member pick the group (2.1-Q161)', () => {
    const { h, scene, toScreen } = setup(1, 0)
    h.store.updatePersisted((draft) => {
      draft.plants = draft.plants.map((entry) => (entry.id === 'plum' ? { ...entry, locked: true } : entry))
    })
    const screen = toScreen({ x: -270, y: 0 })
    const world = h.world(screen)

    expect(contextMenuTargetAt(scene, world, 'mouse')).toEqual({ visible: { kind: 'group', id: 'g' }, target: { kind: 'group', id: 'g' } })
    h.click(screen)
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'group', id: 'g' }])
    h.select({ kind: 'plant', id: 'apple' })
    h.menu(screen, 'mouse')
    expect(h.record.menus.at(-1)?.pick?.target).toEqual({ kind: 'group', id: 'g' })
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'group', id: 'g' }])
  })

  it('"Turn view to this edge" turns to the edge of the zone a long press picks, never a nearer line it does not reach', () => {
    // A long press 8 px from a fence (a line zone, 6 px reach) and 12 px from the bed's left line (16 px reach): the bed.
    const h = createToolHarness({
      scene: {
        zones: [
          rectZone('bed', [{ x: -100, y: -100 }, { x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }], { zoneType: 'rect' }),
          rectZone('fence', [{ x: -300, y: 8 }, { x: -105, y: 8 }], { zoneType: 'line' }),
        ],
      },
      screen: { width: 1000, height: 1000 },
      camera: { zoom: stageScaleToMapZoom(1, 0), bearingDeg: 0 },
    })
    harnesses.push(h)
    const screen = h.view.view().worldToScreen({ x: -112, y: 0 })
    h.menu(screen, 'long-press')
    expect(key(h.record.menus.at(-1)?.pick?.target)).toBe('zone:bed')
    const turn = h.record.menus.at(-1)!.turnViewToEdge
    expect(turn).toBeTypeOf('function')
    turn!()
    h.advance(1000)
    // The bed's left line runs north-south: turned level, the view's bearing is a quarter turn (the fence's would keep 0).
    expect(Math.abs((((h.view.view().camera.bearingDeg % 180) + 180) % 180) - 90)).toBeLessThan(0.5)
  })

  it('"Turn view to this edge" follows the same table: 6 px from a mouse menu, 16 px from a long press', () => {
    const { h, screenAt } = setup(1, 0)
    const offered = () => h.record.menus.at(-1)!.turnViewToEdge
    h.menu(screenAt({ from: BED_LEFT, toward: BED_IN, px: 5 }), 'mouse')
    expect(offered()).toBeTypeOf('function')
    h.menu(screenAt({ from: BED_LEFT, toward: BED_IN, px: 8 }), 'mouse')
    expect(offered()).toBeUndefined()
    h.menu(screenAt({ from: BED_LEFT, toward: BED_IN, px: 14 }), 'long-press')
    expect(offered()).toBeTypeOf('function')
    h.menu(screenAt({ from: BED_LEFT, toward: BED_IN, px: 20 }), 'long-press')
    expect(offered()).toBeUndefined()
  })
})
