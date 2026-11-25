import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createToolHarness,
  plantEntity,
  useStubTools,
  type ToolHarness,
  type ToolHarnessOptions,
} from '../../../__tests__/support/tool-harness'
import type { CanvasPlantRowGuidance } from '../../session-state'
import type { ToolHandleId } from '../interaction-types'
import type { ScenePlantEntity } from '../scene/types'
import type { ScreenPoint, WorldPoint } from '../../../geo/view/types'
import type { DraftShape } from './draft'
import { createPlantRowTool } from './plant-row'
import type { CanvasTool, ToolSettingsPort } from './tool'
import '../../../__tests__/support/camera-tolerance'

vi.mock('./registry', () => ({ TOOL_REGISTRY: {} }))

const harnesses: ToolHarness[] = []

afterEach(() => {
  for (const h of harnesses.splice(0)) h.dispose()
})

interface RowSettings extends ToolSettingsPort {
  intervalM: number
  readonly commitPlantSpacingIntervalM: ReturnType<typeof vi.fn<(metres: number) => void>>
}

function rowSettings(intervalM: number): RowSettings {
  const settings: RowSettings = {
    intervalM,
    plantSpacingIntervalM: () => settings.intervalM,
    commitPlantSpacingIntervalM: vi.fn((metres: number) => {
      settings.intervalM = metres
    }),
  }
  return settings
}

function sourcePlant(position: WorldPoint = { x: 20, y: 30 }, overrides: Partial<ScenePlantEntity> = {}): ScenePlantEntity {
  return plantEntity('source', 'Malus domestica', position, { commonName: 'Apple', ...overrides })
}

/** Plant a row armed on a harness at `scale` px/m, over `plants` (default the source at (20, 30)), with `intervalM`. */
function rowHarness(options: ToolHarnessOptions & {
  readonly scale?: number
  readonly intervalM?: number
  readonly plants?: readonly ScenePlantEntity[]
} = {}): { readonly h: ToolHarness; readonly settings: RowSettings; readonly tool: CanvasTool } {
  const settings = rowSettings(options.intervalM ?? 0.5)
  const tool = createPlantRowTool()
  useStubTools(tool)
  const { scale = 1, intervalM: _intervalM, plants = [sourcePlant()], scene, ...rest } = options
  const h = createToolHarness({ viewport: { x: 0, y: 0, scale }, scene: { plants: [...plants], ...scene }, settings, ...rest })
  harnesses.push(h)
  h.arm('plant-spacing')
  return { h, settings, tool }
}

function row(h: ToolHarness): CanvasPlantRowGuidance {
  const guidance = h.record.guidance.at(-1)?.plantRow
  if (!guidance) throw new Error('Plant a row published no guidance.')
  return guidance
}

function shapesOf<K extends DraftShape['kind']>(h: ToolHarness, kind: K): Extract<DraftShape, { kind: K }>[] {
  return (h.renderer.lastDraft()?.shapes ?? []).filter((shape): shape is Extract<DraftShape, { kind: K }> => shape.kind === kind)
}

function ghostPositions(h: ToolHarness): WorldPoint[] {
  return shapesOf(h, 'ghost').flatMap((ghost) => ghost.entity.kind === 'plant' ? [ghost.entity.plant.position] : [])
}

function lengthLabel(h: ToolHarness): string | undefined {
  return shapesOf(h, 'label').find((label) => label.tone === 'hint-primary')?.text
}

/** Enter: plants the drawn row (U58). */
function finish(h: ToolHarness): void {
  h.host.command({ kind: 'confirm' })
}

function added(h: ToolHarness): WorldPoint[] {
  return h.store.persisted.plants.filter((plant) => plant.id !== 'source').map((plant) => plant.position)
}

function closePoint(x: number, y: number): { readonly x: unknown; readonly y: unknown } {
  return { x: expect.closeTo(x, 6), y: expect.closeTo(y, 6) }
}

function steppedPoint(h: ToolHarness, start: WorldPoint, end: WorldPoint, distanceM: number): { readonly x: unknown; readonly y: unknown } {
  const ratio = distanceM / h.store.sessionPlane.groundLength(start, end)
  return closePoint(start.x + (end.x - start.x) * ratio, start.y + (end.y - start.y) * ratio)
}

describe('Plant a row tool', () => {
  it('a press that misses a plant keeps picking and leaves the selection alone', () => {
    const { h } = rowHarness({ plants: [] })
    h.store.setSelection([{ kind: 'plant', id: 'already-selected' }])

    h.click({ x: 200, y: 200 })

    expect(row(h)).toMatchObject({ phase: 'missed', plantName: null })
    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.record.selections).toEqual([])
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'plant', id: 'already-selected' }])
  })

  it('a grouped or locked plant is not picked', () => {
    const { h } = rowHarness({
      plants: [
        sourcePlant({ x: 20, y: 30 }, { id: 'grouped-plant' }),
        sourcePlant({ x: 80, y: 30 }, { id: 'locked-plant', locked: true }),
      ],
      scene: { groups: [{ kind: 'group', id: 'group-1', locked: false, name: 'Grouped row', members: [{ kind: 'plant', id: 'grouped-plant' }] }] },
    })

    h.click({ x: 20, y: 30 })
    expect(row(h).phase).toBe('missed')
    h.click({ x: 80, y: 30 })
    expect(row(h).phase).toBe('missed')
    expect(h.renderer.lastDraft()).toBeNull()
  })

  it('a plant on a hidden or locked plants layer is not picked', () => {
    const { h } = rowHarness()
    const setPlantsLayer = (visible: boolean, locked: boolean): void => {
      h.store.updatePersisted((draft) => {
        draft.layers = draft.layers.map((layer) => (layer.name === 'plants' ? { ...layer, visible, locked } : layer))
      })
    }

    setPlantsLayer(false, false)
    h.click({ x: 20, y: 30 })
    expect(row(h).phase).not.toBe('row')

    setPlantsLayer(true, true)
    h.click({ x: 20, y: 30 })
    expect(row(h).phase).not.toBe('row')
    expect(h.renderer.lastDraft()).toBeNull()
  })

  it('Esc drops the row source first, then leaves', () => {
    const { h } = rowHarness()
    h.click({ x: 20, y: 30 })
    expect(row(h).phase).toBe('row')
    expect(h.host.activeToolHasEscapeTransient()).toBe(true)

    expect(h.host.command({ kind: 'escape' })).toBe('handled')
    expect(row(h).phase).toBe('pick')
    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.toolState.peek()).toBe('plant-spacing')

    // Today's order: the source goes first even while a drag from it is live.
    h.press({ x: 20, y: 30 })
    h.move({ x: 26, y: 30 })
    expect(h.host.hasLiveGesture()).toBe(true)
    expect(h.host.command({ kind: 'escape' })).toBe('handled')
    expect(row(h).phase).toBe('pick')
    h.release({ x: 26, y: 30 })
    expect(added(h)).toEqual([])

    // Nothing held: the tool's Esc passes, and the chain's tool layer leaves.
    expect(h.host.activeToolHasEscapeTransient()).toBe(false)
    expect(h.host.command({ kind: 'escape' })).toBe('pass')
    expect(h.toolState.peek()).toBe('plant-spacing')
  })

  it('a blur keeps the row source and its preview', () => {
    const { h } = rowHarness({ intervalM: 2 })
    h.click({ x: 20, y: 30 })
    h.hover({ x: 26, y: 30 })

    h.blur()

    expect(row(h)).toMatchObject({ phase: 'row', count: 3 })
    expect(ghostPositions(h)).toHaveLength(3)
  })

  it('a hover previews the row and a press commits it as one Scene Edit', () => {
    const { h } = rowHarness({ intervalM: 2, plants: [sourcePlant({ x: 20, y: 30 }, {
      color: '#884422', canopySpreadM: 3, rotationDeg: 15, notes: 'Do not copy', plantedDate: '2026-03-01', quantity: 4,
    })] })
    h.click(h.screen({ x: 20, y: 30 }))

    const start = { x: 20, y: 30 }
    const end = { x: 26, y: 30 }
    h.hover(h.screen(end))

    expect(row(h)).toMatchObject({ phase: 'row', plantName: 'Apple', count: 3, density: 'normal' })
    expect(shapesOf(h, 'circle-px')).toMatchObject([{ center: start, style: { token: 'selection', widthPx: 2 } }])
    expect(shapesOf(h, 'polyline')).toEqual([{ kind: 'polyline', points: [start, closePoint(26, 30)], style: { token: 'selection', widthPx: 2, dash: [6, 6] } }])
    const expectedRow = [2, 4, 6].map((distanceM) => steppedPoint(h, start, end, distanceM))
    expect(ghostPositions(h)).toEqual(expectedRow)
    expect(shapesOf(h, 'label')).toEqual([{ kind: 'label', anchor: closePoint(23, 30), offsetPx: { x: 0, y: 0 }, text: '6 m', tone: 'hint-primary' }])
    // The ring and the guide under the discs, the length on top; the row replaces the hover restyle.
    expect(h.renderer.lastDraft()!.shapes.map((shape) => shape.kind)).toEqual(['circle-px', 'polyline', 'ghost', 'ghost', 'ghost', 'label'])
    expect(h.chrome.tooltip).toBeNull()

    // The click adds the row's second point; Enter plants it (U58).
    h.click(h.screen(end))
    expect(added(h)).toEqual([])
    finish(h)

    expect(added(h)).toEqual(expectedRow)
    expect(h.store.persisted.plants[1]).toMatchObject({
      canonicalName: 'Malus domestica', commonName: 'Apple', color: '#884422', canopySpreadM: 3,
      rotationDeg: 15, notes: null, plantedDate: null, quantity: 1, pinnedName: false,
    })
    expect(h.store.persisted.groups).toEqual([])
    expect(h.store.session.selectedTargets.map((target) => target.id)).toEqual(h.store.persisted.plants.map((plant) => plant.id))
    expect(row(h).phase).toBe('pick')
    expect(h.renderer.lastDraft()).toBeNull()
    h.undo()
    expect(h.store.persisted.plants.map((plant) => plant.id)).toEqual(['source'])
  })

  it('a Species Key recolour after the pick reaches the card glyph and the row\'s new plants', () => {
    const { h } = rowHarness({ intervalM: 2, plants: [sourcePlant({ x: 20, y: 30 }, { color: '#884422' })] })
    h.click({ x: 20, y: 30 })
    h.hover({ x: 26, y: 30 })
    expect(row(h).glyph?.color).toBe('#884422')

    // The Species Key's swatch: one Scene Edit recolours the species and its plants; the runtime tells the host.
    h.edits.run('set-plant-color-for-species', (tx) => {
      tx.mutate((draft) => {
        draft.plants = draft.plants.map((plant) => ({ ...plant, color: '#2F6F4E' }))
        draft.plantSpeciesColors = { 'Malus domestica': '#2F6F4E' }
      })
    })
    h.host.sceneChanged()

    expect(row(h).glyph?.color).toBe('#2F6F4E')
    h.click({ x: 26, y: 30 })
    finish(h)
    expect(h.store.persisted.plants.filter((plant) => plant.id !== 'source').map((plant) => plant.color))
      .toEqual(['#2F6F4E', '#2F6F4E', '#2F6F4E'])
  })

  it('a row whose source became unavailable commits nothing and returns to picking', () => {
    const blockers: Record<string, (h: ToolHarness) => void> = {
      'a locked source': (h) => h.store.updatePersisted((draft) => {
        draft.plants = draft.plants.map((plant) => (plant.id === 'source' ? { ...plant, locked: true } : plant))
      }),
      'a removed source': (h) => h.store.updatePersisted((draft) => {
        draft.plants = []
      }),
      'a locked plants layer': (h) => h.store.updatePersisted((draft) => {
        draft.layers = draft.layers.map((layer) => (layer.name === 'plants' ? { ...layer, locked: true } : layer))
      }),
      'a hidden plants layer': (h) => h.store.updatePersisted((draft) => {
        draft.layers = draft.layers.map((layer) => (layer.name === 'plants' ? { ...layer, visible: false } : layer))
      }),
    }
    for (const [name, block] of Object.entries(blockers)) {
      const { h } = rowHarness({ intervalM: 2 })
      h.click({ x: 20, y: 30 })
      h.hover({ x: 26, y: 30 })

      block(h)
      h.click({ x: 26, y: 30 })
      finish(h)

      expect(added(h), name).toEqual([])
      expect(h.history.canUndo.value, name).toBe(false)
      expect(row(h).phase, name).toBe('missed')
      expect(h.renderer.lastDraft(), name).toBeNull()
    }
  })

  it('a dense row previews at most 250 discs and counts them all', () => {
    const { h } = rowHarness({ intervalM: 0.001 })
    h.click(h.screen({ x: 20, y: 30 }))

    h.hover(h.screen({ x: 22, y: 30 }))

    expect(row(h)).toMatchObject({ count: 2000, density: 'dense' })
    expect(ghostPositions(h)).toHaveLength(250)
  })

  it('a row above 5000 plants is blocked', () => {
    const { h } = rowHarness({ intervalM: 0.001, plants: [sourcePlant({ x: 10, y: 10 })] })
    h.click(h.screen({ x: 10, y: 10 }))
    h.hover(h.screen({ x: 20, y: 10 }))
    expect(row(h)).toMatchObject({ count: 10000, density: 'blocked' })

    h.click(h.screen({ x: 20, y: 10 }))
    finish(h)

    expect(added(h)).toEqual([])
    expect(row(h)).toMatchObject({ phase: 'row', density: 'blocked' })
    expect(shapesOf(h, 'polyline')).toHaveLength(1)
    expect(shapesOf(h, 'circle-px')).toHaveLength(1)
  })

  it('a row of exactly 5000 plants commits', () => {
    const { h } = rowHarness({ intervalM: 0.001, plants: [sourcePlant({ x: 10, y: 10 })] })
    h.click(h.screen({ x: 10, y: 10 }))
    h.hover(h.screen({ x: 15, y: 10 }))
    expect(row(h)).toMatchObject({ count: 5000, density: 'dense' })

    h.click(h.screen({ x: 15, y: 10 }))
    finish(h)

    expect(h.store.persisted.plants).toHaveLength(5001)
    expect(added(h).at(-1)).toEqual(steppedPoint(h, { x: 10, y: 10 }, { x: 15, y: 10 }, 5))
  })

  it('the row\'s discs take their size from the source\'s presentation', () => {
    const { h } = rowHarness({ scale: 10, intervalM: 2, plants: [sourcePlant({ x: 2, y: 3 }, { canopySpreadM: 4 })] })
    h.click({ x: 20, y: 30 })
    h.hover({ x: 60, y: 30 })

    const ghosts = shapesOf(h, 'ghost')
    expect(ghosts).toHaveLength(2)
    for (const ghost of ghosts) {
      expect(ghost).toMatchObject({ opacity: 0.35, entity: { kind: 'plant', mark: 'dot', sizeFrom: { x: 2, y: 3 } } })
    }

    // A zoom at the pointer redraws the row, whose discs the renderer sizes at the new scale.
    const drafts = h.renderer.drafts.length
    h.wheelZoom({ x: 60, y: 30 }, 2)
    expect(h.renderer.drafts.length).toBeGreaterThan(drafts)
    expect(shapesOf(h, 'ghost').every((ghost) => ghost.entity.kind === 'plant' && ghost.entity.sizeFrom?.x === 2)).toBe(true)
  })

  it('a row with no room for a plant previews and commits nothing', () => {
    const { h } = rowHarness({ intervalM: 2 })
    h.click(h.screen({ x: 20, y: 30 }))
    h.hover(h.screen({ x: 21.5, y: 30 }))
    expect(lengthLabel(h)).toBe('1.5 m')
    expect(ghostPositions(h)).toEqual([])

    h.click(h.screen({ x: 21, y: 30 }))
    finish(h)

    expect(added(h)).toEqual([])
    expect(h.history.canUndo.value).toBe(false)
    expect(shapesOf(h, 'polyline')).toHaveLength(1)
    expect(row(h).phase).toBe('row')
  })

  it('a zero-length row reads 0 cm and keeps the interval', () => {
    const { h } = rowHarness()
    h.click(h.screen({ x: 20, y: 30 }))

    h.hover(h.screen({ x: 20, y: 30 }))

    expect(row(h)).toMatchObject({ interval: '50 cm', count: 0 })
    expect(lengthLabel(h)).toBe('0 cm')
  })

  it('a drag released without Shift on the spot of a Shift preview commits the constrained row', () => {
    const { h } = rowHarness({ scale: 10, intervalM: 1, plants: [sourcePlant({ x: 4, y: 4 })] })

    h.press({ x: 40, y: 40 })
    h.move({ x: 71, y: 52 }, { shift: true })
    const guide = shapesOf(h, 'polyline')[0]!
    expect(guide.points[1]!.y).toBeCloseTo(4, 9)
    h.release({ x: 71, y: 52 }, { shift: false })

    expect(added(h).map((point) => point.y)).toEqual([4, 4, 4])
    expect(added(h).map((point) => point.x)).toEqual([5, 6, 7])
  })

  it('Shift keeps 45 degrees on screen at 30', () => {
    const { h } = rowHarness({ camera: { bearingDeg: 30 }, intervalM: 1 })
    const source = h.view.view().worldToScreen({ x: 20, y: 30 })

    h.press(source)
    // 31 px right and 12 px down on screen: Shift lays the row level on screen, not level with the world.
    const pointer = { x: source.x + 31, y: source.y + 12 }
    h.move(pointer, { shift: true })

    const endWorld = shapesOf(h, 'polyline')[0]!.points[1]!, end = h.view.view().worldToScreen(endWorld), rawEnd = h.world(pointer)
    expect(end.y).toBeCloseTo(source.y, 6)
    expect(end.x).toBeGreaterThan(source.x)
    expect(Math.hypot(endWorld.x - 20, endWorld.y - 30)).toBeCloseTo(Math.hypot(rawEnd.x - 20, rawEnd.y - 30), 6)
  })

  it('Ctrl or Cmd turns snapping off', () => {
    for (const mods of [{ ctrl: true }, { meta: true }]) {
      const { h } = rowHarness({ intervalM: 2, snapping: { grid: true } })
      h.click(h.screen({ x: 20, y: 30 }))

      // Scale 1: the grid is 20 m, so a snapped end would sit at (80, 40); the held key leaves it at the pointer.
      h.hover({ x: 73, y: 37 }, mods)
      expect(shapesOf(h, 'polyline')[0]!.points[1]).toEqual(h.world({ x: 73, y: 37 }))
      h.hover({ x: 73, y: 37 })
      expect(shapesOf(h, 'polyline')[0]!.points[1]).toEqual({ x: 80, y: 40 })
    }
  })

  it('a Ctrl or Cmd change at the release applies at the next move, so the row commits as its last preview drew it (B3, A17)', () => {
    const { h } = rowHarness({ intervalM: 2, snapping: { grid: true } })
    // Scale 1: the grid is 20 m, so a snapped end would sit at (80, 40); the preview, with Ctrl held, ended at the pointer.
    h.press(h.screen({ x: 20, y: 30 }))
    h.move({ x: 73, y: 37 }, { ctrl: true })
    const rawEnd = h.world({ x: 73, y: 37 })
    expect(shapesOf(h, 'polyline')[0]!.points[1]).toEqual(rawEnd)
    h.release({ x: 73, y: 37 })

    expect(added(h).at(-1)).not.toEqual({ x: 80, y: 40 })
    const last = added(h).at(-1)!
    expect(Math.hypot(last.x - 20, last.y - 30)).toBeLessThanOrEqual(Math.hypot(rawEnd.x - 20, rawEnd.y - 30))
  })

  it('a row of 100 plants commits without confirmation', () => {
    const { h } = rowHarness({ intervalM: 1, plants: [sourcePlant({ x: 10, y: 10 })] })
    h.click(h.screen({ x: 10, y: 10 }))
    h.hover(h.screen({ x: 110, y: 10 }))
    expect(row(h)).toMatchObject({ count: 100, density: 'normal' })

    h.click(h.screen({ x: 110, y: 10 }))
    finish(h)

    expect(h.store.persisted.plants).toHaveLength(101)
  })

  it('a row above 100 plants reads dense and commits directly', () => {
    const { h } = rowHarness({ intervalM: 1, plants: [sourcePlant({ x: 10, y: 10 })] })
    h.click(h.screen({ x: 10, y: 10 }))
    h.hover(h.screen({ x: 111, y: 10 }))
    expect(row(h)).toMatchObject({ count: 101, density: 'dense' })

    h.click(h.screen({ x: 111, y: 10 }))
    finish(h)

    expect(h.store.persisted.plants).toHaveLength(102)
    expect(added(h).at(-1)).toEqual(steppedPoint(h, { x: 10, y: 10 }, { x: 111, y: 10 }, 101))
  })

  it('a drag commits the row at its release point', () => {
    const { h } = rowHarness({ intervalM: 2 })

    h.press(h.screen({ x: 20, y: 30 }))
    h.move(h.screen({ x: 25, y: 30 }))
    h.release(h.screen({ x: 26, y: 30 }))

    expect(added(h)).toEqual([2, 4, 6].map((distanceM) => steppedPoint(h, { x: 20, y: 30 }, { x: 26, y: 30 }, distanceM)))
  })

  it('a dense drag commits directly', () => {
    const { h } = rowHarness({ intervalM: 1, plants: [sourcePlant({ x: 10, y: 10 })] })

    h.press(h.screen({ x: 10, y: 10 })); h.move(h.screen({ x: 111, y: 10 })); h.release(h.screen({ x: 111, y: 10 }))

    expect(h.store.persisted.plants).toHaveLength(102)
    expect(added(h).at(-1)).toEqual(steppedPoint(h, { x: 10, y: 10 }, { x: 111, y: 10 }, 101))
    expect(row(h).phase).toBe('pick')
  })

  it('the spacing field asks for focus on the release of the press that picked the source, never during its drag', () => {
    const { h } = rowHarness({ intervalM: 2 })

    // A fast press and drag: the field would take focus after the map did, and Esc, Enter and letters would go to it.
    h.press(h.screen({ x: 20, y: 30 }))
    expect(row(h)).toMatchObject({ phase: 'row', focusRequest: 0 })
    const focus = h.record.focus.length
    h.move(h.screen({ x: 25, y: 30 }))
    expect(h.record.focus.slice(focus)).toEqual(['map'])
    h.release(h.screen({ x: 26, y: 30 }))
    expect(added(h)).toEqual([2, 4, 6].map((distanceM) => steppedPoint(h, { x: 20, y: 30 }, { x: 26, y: 30 }, distanceM)))
    expect(row(h).focusRequest).toBe(0)

    // A tap picks the source and the field takes focus on its release, as today.
    h.press(h.screen({ x: 20, y: 30 }))
    expect(row(h).focusRequest).toBe(0)
    h.release(h.screen({ x: 20, y: 30 }))
    expect(row(h)).toMatchObject({ phase: 'row', focusRequest: 1 })
  })

  it('a drag from the source takes the map\'s focus', () => {
    const { h } = rowHarness({ intervalM: 2 })

    h.press({ x: 20, y: 30 })
    const focusBeforeDrag = h.record.focus.length
    h.move({ x: 25, y: 30 })

    expect(h.record.focus.slice(focusBeforeDrag)).toEqual(['map'])
  })

  it('the spacing field\'s commands reach the row', () => {
    const { h, settings } = rowHarness({ intervalM: 1.25 })
    h.click({ x: 20, y: 30 })
    expect(row(h)).toMatchObject({ phase: 'row', interval: '1.25 m', intervalValid: true, focusRequest: 1 })
    h.hover({ x: 26, y: 30 })
    expect(row(h).count).toBe(4)

    // Typing: the preview follows a valid spacing, and an invalid one leaves the row empty.
    h.host.command({ kind: 'spacing-input', text: '2 m' })
    expect(row(h)).toMatchObject({ interval: '2 m', count: 3 })
    h.host.command({ kind: 'spacing-input', text: '0' })
    expect(row(h)).toMatchObject({ interval: '0', intervalValid: false, count: 0 })

    // Enter keeps the field until the spacing is valid; leaving it moves no focus.
    const focus = h.record.focus.length
    h.host.command({ kind: 'spacing-commit', via: 'enter' })
    expect(row(h)).toMatchObject({ intervalValid: false, focusRequest: 2 })
    h.host.command({ kind: 'spacing-commit', via: 'blur' })
    expect(row(h).focusRequest).toBe(2)
    expect(settings.commitPlantSpacingIntervalM).not.toHaveBeenCalled()
    expect(h.record.focus.slice(focus)).toEqual([])

    h.host.command({ kind: 'spacing-input', text: '0.75m' })
    h.host.command({ kind: 'spacing-commit', via: 'enter' })
    expect(settings.commitPlantSpacingIntervalM).toHaveBeenCalledWith(0.75)
    expect(row(h)).toMatchObject({ phase: 'row', interval: '75 cm', intervalValid: true })
    expect(h.record.focus.slice(focus)).toEqual(['map'])
    expect(h.store.persisted.plants).toHaveLength(1)

    // Esc in the field with only the picked plant drops it and gives the map its focus back; the tool stays armed.
    h.host.command({ kind: 'spacing-cancel' })
    expect(row(h).phase).toBe('pick')
    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.record.focus.at(-1)).toBe('map')
    expect(h.toolState.peek()).toBe('plant-spacing')
  })

  it('an invalid interval at release focuses the spacing field and commits nothing', () => {
    const { h } = rowHarness({ intervalM: 2 })
    h.click({ x: 20, y: 30 })
    const picked = row(h).focusRequest
    h.host.command({ kind: 'spacing-input', text: '0' })

    // A drag from the picked plant plants a straight row at its release, which asks for the field.
    h.press({ x: 20, y: 30 })
    expect(row(h).focusRequest).toBe(picked)
    h.move({ x: 26, y: 30 })
    h.release({ x: 26, y: 30 })

    expect(added(h)).toEqual([])
    expect(row(h)).toMatchObject({ phase: 'row', intervalValid: false, count: 0, focusRequest: picked + 1 })

    // So does the finish of a clicked row.
    h.click({ x: 26, y: 30 })
    finish(h)
    expect(added(h)).toEqual([])
    expect(row(h)).toMatchObject({ phase: 'row', intervalValid: false, focusRequest: picked + 2 })
  })

  it('a clamped endpoint stays at the view\'s edge', () => {
    const { h } = rowHarness({ intervalM: 100 })
    const startScreen = h.screen({ x: 20, y: 30 })
    h.click(startScreen)

    h.hover({ x: 500, y: startScreen.y })

    const edge = h.world({ x: 400, y: startScreen.y })
    expect(lengthLabel(h)).toBe(`${Math.round(h.store.sessionPlane.groundLength({ x: 20, y: 30 }, edge))} m`)
    expect(shapesOf(h, 'polyline')[0]!.points[1]).toEqual(edge)

    h.click({ x: 500, y: startScreen.y })
    finish(h)

    expect(added(h)).toEqual([100, 200, 300].map((distanceM) => steppedPoint(h, { x: 20, y: 30 }, edge, distanceM)))
  })

  it('a picked source holds re-origin until Esc drops it', () => {
    const { h } = rowHarness({ intervalM: 1 })
    expect(h.host.holdsReorigin()).toBe(false)

    h.click({ x: 20, y: 30 })
    expect(row(h).phase).toBe('row')
    expect(h.host.holdsReorigin()).toBe(true)

    h.host.command({ kind: 'escape' })
    expect(h.host.holdsReorigin()).toBe(false)
  })
})

// ── The path (U58: plan section 4 "2.0 plant along a path", A1, A2, A17) ─────────────────────────────────────────────

/** Plant a row at 10 px per metre with the source at (2, 3) m, on screen at (20, 30), every 1 m. */
function pathHarness(options: { readonly intervalM?: number } = {}): { readonly h: ToolHarness; readonly settings: RowSettings; readonly tool: CanvasTool } {
  return rowHarness({ scale: 10, intervalM: options.intervalM ?? 1, plants: [sourcePlant({ x: 2, y: 3 })] })
}

function handleId(id: string): ToolHandleId {
  return id as ToolHandleId
}

/** The draft's handle `id` on screen. */
function screenOf(h: ToolHarness, id: string): ScreenPoint {
  const handle = h.chrome.handles.find((entry) => entry.id === id)
  if (!handle) throw new Error(`no handle ${id}; shown: ${h.chrome.handles.map((entry) => entry.id).join(', ')}`)
  return h.view.view().worldToScreen(handle.anchor)
}

function pointIds(h: ToolHarness): string[] {
  return h.chrome.handles.filter((handle) => handle.id.startsWith('point:')).map((handle) => handle.id)
}

function pointAt(h: ToolHarness, index: number): WorldPoint {
  const handle = h.chrome.handles.find((entry) => entry.id === `point:draft:${index}`)
  if (!handle) throw new Error(`no point ${index}`)
  return handle.anchor
}

function nearest(points: readonly WorldPoint[], to: WorldPoint): number {
  return Math.min(...points.map((point) => Math.hypot(point.x - to.x, point.y - to.y)))
}

describe('Plant a row along a path', () => {
  it('clicks add points the row bends through, and Enter plants it in one Scene Edit', () => {
    const { h, tool } = pathHarness()
    h.click({ x: 20, y: 30 })
    expect(tool.canFinish?.()).toBe(false)
    h.click({ x: 80, y: 30 })
    h.click({ x: 120, y: 70 })

    expect(added(h)).toEqual([])
    expect(h.history.canUndo.value).toBe(false)
    expect(row(h)).toMatchObject({ phase: 'row', points: 3, closed: false })
    expect(tool.canFinish?.()).toBe(true)
    // The picked plant has a handle from 3 points on, as the loop's close target; the placed points and the dots too.
    expect(pointIds(h)).toEqual(['point:draft:0', 'point:draft:1', 'point:draft:2'])
    expect(h.chrome.handles.filter((handle) => handle.glyph === 'midpoint').map((handle) => handle.id)).toEqual(['dot:draft:0', 'dot:draft:1'])
    // No point is touched until one is pressed.
    expect(h.chrome.activeHandle).toBeNull()
    // A curve of 64 samples per segment.
    expect(shapesOf(h, 'polyline')[0]!.points).toHaveLength(2 * 64 + 1)

    finish(h)

    const planted = added(h)
    expect(nearest(planted, { x: 8, y: 3 })).toBeLessThanOrEqual(0.5)
    expect(planted.at(-1)!.x).toBeGreaterThan(11)
    expect(h.store.session.selectedTargets.map((target) => target.id)).toEqual(h.store.persisted.plants.map((plant) => plant.id))
    expect(row(h).phase).toBe('pick')
    expect(h.chrome.handles).toEqual([])
    h.undo()
    expect(h.store.persisted.plants.map((plant) => plant.id)).toEqual(['source'])
  })

  it('plants on a double-click on the ground or on the last point, not on another point', () => {
    for (const how of ['ground', 'last point'] as const) {
      const { h } = pathHarness()
      h.click({ x: 20, y: 30 })
      h.click({ x: 80, y: 30 })
      h.click({ x: 120, y: 70 })
      if (how === 'ground') {
        h.click({ x: 120, y: 70 }, { clickCount: 2 })
      } else {
        h.click(screenOf(h, 'point:draft:1'), { target: { kind: 'handle', id: handleId('point:draft:1') }, clickCount: 2 })
        expect(added(h), 'a double-click on another point plants nothing').toEqual([])
        h.click(screenOf(h, 'point:draft:2'), { target: { kind: 'handle', id: handleId('point:draft:2') }, clickCount: 2 })
      }
      expect(added(h).length, how).toBeGreaterThan(5)
      expect(h.history.canUndo.value, how).toBe(true)
    }
  })

  it('closes a loop on a click on the first point from 3 points, and every N m rounds to equal gaps', () => {
    const { h } = pathHarness({ intervalM: 3 })
    h.click({ x: 20, y: 30 })
    h.click({ x: 120, y: 30 })
    // A click on the first point with fewer than 3 points folds nothing back.
    h.click({ x: 20, y: 30 })
    expect(row(h)).toMatchObject({ points: 2, closed: false })
    h.click({ x: 70, y: 110 })
    // The picked plant's handle closes the loop; it never moves.
    h.drag(screenOf(h, 'point:draft:0'), { x: 40, y: 60 }, { target: { kind: 'handle', id: handleId('point:draft:0') } })
    expect(row(h)).toMatchObject({ points: 3, closed: true })
    expect(pointAt(h, 0)).toEqual({ x: 2, y: 3 })
    h.host.command({ kind: 'escape' })
    expect(row(h)).toMatchObject({ points: 3, closed: false })
    // As does a click near it, on the ground.
    h.click({ x: 21, y: 31 })

    expect(row(h)).toMatchObject({ points: 3, closed: true })
    expect(h.chrome.handles.filter((handle) => handle.glyph === 'midpoint')).toHaveLength(3)
    const shown = row(h).loopSpacing!
    expect(Number.parseFloat(shown)).toBeGreaterThan(2.5)
    expect(Number.parseFloat(shown)).toBeLessThan(3.5)
    finish(h)

    // Equal gaps along the curve: their chords differ only by its bend.
    const ring = [{ x: 2, y: 3 }, ...added(h)]
    const gaps = ring.map((point, index) => Math.hypot(point.x - ring[(index + 1) % ring.length]!.x, point.y - ring[(index + 1) % ring.length]!.y))
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(0.6)
    expect(Math.abs(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length - Number.parseFloat(shown))).toBeLessThanOrEqual(0.3)
  })

  it('plants N plants evenly, the picked one included, and never writes the count as the device interval', () => {
    const { h, settings } = pathHarness()
    h.click(h.screen({ x: 2, y: 3 }))
    h.click(h.screen({ x: 10, y: 3 }))
    expect(h.host.command({ kind: 'spacing-mode', mode: 'count' })).toBe('handled')
    expect(row(h)).toMatchObject({ mode: 'count', countText: '9', countValid: true, count: 8 })
    h.host.command({ kind: 'spacing-input', text: '5' })
    h.host.command({ kind: 'spacing-commit', via: 'enter' })
    expect(h.record.focus.at(-1)).toBe('map')
    expect(row(h)).toMatchObject({ countText: '5', count: 4 })
    h.host.command({ kind: 'spacing-input', text: '1' })
    expect(row(h)).toMatchObject({ countValid: false, count: 0 })
    h.host.command({ kind: 'spacing-input', text: '5' })
    expect(settings.commitPlantSpacingIntervalM).not.toHaveBeenCalled()

    finish(h)

    expect(added(h)).toEqual([closePoint(4, 3), closePoint(6, 3), closePoint(8, 3), closePoint(10, 3)])
  })

  // Answer 29: the 5000-plant guard is the tool's own: "N plants" counts the picked plant, so 5001 plants is the most a
  // row plants, as every N m plants 5000 beside the picked one; the switch from a row above it starts at that most.
  it('takes up to 5001 plants in "N plants", the picked one counted, and starts the switch from a longer row at 5001', () => {
    const { h } = rowHarness({ intervalM: 0.001, plants: [sourcePlant({ x: 10, y: 10 })] })
    h.click(h.screen({ x: 10, y: 10 }))
    h.click(h.screen({ x: 20, y: 10 }))
    expect(row(h)).toMatchObject({ count: 10000, density: 'blocked' })
    h.host.command({ kind: 'spacing-mode', mode: 'count' })
    expect(row(h)).toMatchObject({ countText: '5001', countValid: true, count: 5000, density: 'dense' })
    h.host.command({ kind: 'spacing-input', text: '5002' })
    expect(row(h)).toMatchObject({ countValid: false, count: 0 })
    finish(h)
    expect(added(h), 'an invalid count plants nothing').toEqual([])
    h.host.command({ kind: 'spacing-input', text: '5001' })

    finish(h)

    expect(added(h)).toHaveLength(5000)
    expect(added(h).at(-1)).toEqual(closePoint(20, 10))
  })

  it('before planting, a point drags, a dot drag inserts, a dot double-click inserts in place and Alt deletes or sharpens', () => {
    const { h } = pathHarness()
    h.click(h.screen({ x: 2, y: 3 }))
    h.click(h.screen({ x: 8, y: 3 }))
    h.click(h.screen({ x: 14, y: 3 }))

    // A point drag moves it at the release; the draft follows it live.
    const second = screenOf(h, 'point:draft:2'), movedSecond = h.screen({ x: 14, y: 1 })
    h.press(second, { target: { kind: 'handle', id: handleId('point:draft:2') } })
    h.move(movedSecond); expect(pointAt(h, 2)).toEqual(closePoint(14, 1))
    h.release(movedSecond); expect(pointAt(h, 2)).toEqual(closePoint(14, 1))

    // A still press on a dot inserts nothing; its drag inserts a point where it is released.
    const dot = screenOf(h, 'dot:draft:0')
    h.click(dot, { target: { kind: 'handle', id: handleId('dot:draft:0') } })
    // The picked plant and two points: from 3 points the picked plant has a handle too.
    expect(pointIds(h)).toHaveLength(3)
    const inserted = h.screen({ x: 5, y: 6 })
    h.press(dot, { target: { kind: 'handle', id: handleId('dot:draft:0') } })
    h.move(inserted); h.release(inserted)
    expect(pointIds(h)).toHaveLength(4)
    expect(pointAt(h, 1)).toEqual(closePoint(5, 6))

    // A double-click on a dot inserts a point in place.
    const inPlace = h.chrome.handles.find((handle) => handle.id === 'dot:draft:2')!.anchor
    h.click(screenOf(h, 'dot:draft:2'), { target: { kind: 'handle', id: handleId('dot:draft:2') }, clickCount: 2 })
    expect(pointIds(h)).toHaveLength(5)
    expect(pointAt(h, 3)).toEqual(inPlace)

    // Alt+click deletes a point, down to 2 points and never the picked plant.
    h.click(screenOf(h, 'point:draft:1'), { target: { kind: 'handle', id: handleId('point:draft:1') }, mods: { alt: true } })
    expect(pointIds(h)).toHaveLength(4)
    h.click(screenOf(h, 'point:draft:0'), { target: { kind: 'handle', id: handleId('point:draft:0') }, mods: { alt: true } })
    expect(pointIds(h), 'never the picked plant').toHaveLength(4)

    // Alt while placing makes a sharp point.
    h.click({ x: 200, y: 50 }, { mods: { alt: true } })
    expect(h.chrome.handles.find((handle) => handle.id === 'point:draft:4')?.glyph).toBe('corner')
    expect(h.chrome.handles.find((handle) => handle.id === 'point:draft:3')?.glyph).toBe('vertex')
    expect(added(h)).toEqual([])
    expect(h.history.canUndo.value).toBe(false)
  })

  it('Esc, Backspace and Ctrl+Z step back one point, Ctrl+Shift+Z restores it, and Esc alone then drops the picked plant', () => {
    const { h } = pathHarness()
    h.click({ x: 20, y: 30 })
    for (const x of [60, 100, 140]) h.click({ x, y: 30 })
    expect(row(h).points).toBe(4)

    expect(h.host.command({ kind: 'escape' })).toBe('handled')
    expect(row(h).points).toBe(3)
    expect(h.host.command({ kind: 'remove-last' })).toBe('handled')
    expect(row(h).points).toBe(2)
    expect(h.host.transientHistory.undo()).toBe(true)
    expect(row(h).points).toBe(1)
    expect(h.host.transientHistory.redo()).toBe(true)
    expect(row(h).points).toBe(2)

    expect(h.host.command({ kind: 'escape' })).toBe('handled')
    expect(row(h)).toMatchObject({ phase: 'row', points: 1 })
    // Only the picked plant left: Backspace keeps it; Esc drops it, then passes.
    expect(h.host.command({ kind: 'remove-last' })).toBe('handled')
    expect(row(h)).toMatchObject({ phase: 'row', points: 1 })
    expect(h.host.command({ kind: 'escape' })).toBe('handled')
    expect(row(h).phase).toBe('pick')
    expect(h.host.transientHistory.canRedo()).toBe(false)
    expect(h.host.command({ kind: 'escape' })).toBe('pass')
    expect(added(h)).toEqual([])
  })

  it('while a plant is picked Ctrl+Z and Ctrl+Shift+Z are the draft\'s alone: three back and three forward restore every point', () => {
    const { h } = pathHarness()
    // Two earlier Design edits, the second undone: the Design has both an undo and a redo to lose.
    const recolour = (color: string): void => {
      h.edits.run('set-plant-color-for-species', (tx) => {
        tx.mutate((draft) => {
          draft.plants = draft.plants.map((plant) => ({ ...plant, color }))
        })
      })
    }
    recolour('#2F6F4E')
    recolour('#7A4E2F')
    h.undo()
    expect(h.history.canUndo.value).toBe(true)
    expect(h.history.canRedo.value).toBe(true)
    /** Edit › Undo and Redo as the command surface routes them: the draft first, else the Design. */
    const ctrlZ = (): void => {
      if (!h.host.transientHistory.undo()) h.undo()
    }
    const ctrlShiftZ = (): void => {
      if (!h.host.transientHistory.redo()) throw new Error('Ctrl+Shift+Z reached the Design')
    }

    h.click(h.screen({ x: 2, y: 3 }))
    for (const x of [6, 10, 14]) h.click(h.screen({ x, y: 3 }))
    expect(row(h).points).toBe(4)
    expect(h.host.transientHistory.canRedo()).toBe(true)

    for (let step = 0; step < 3; step += 1) ctrlZ()
    expect(row(h)).toMatchObject({ phase: 'row', points: 1 })
    // Only the pick left: Ctrl+Z is handled and does nothing, the pick and the draft's redo stack stay.
    expect(h.host.transientHistory.canUndo()).toBe(true)
    ctrlZ()
    ctrlZ()
    expect(row(h)).toMatchObject({ phase: 'row', points: 1 })

    for (let step = 0; step < 3; step += 1) ctrlShiftZ()
    expect(row(h)).toMatchObject({ phase: 'row', points: 4 })
    expect(pointAt(h, 3)).toEqual(closePoint(14, 3))
    // Nothing left to redo: Ctrl+Shift+Z is still the draft's, and does nothing.
    expect(h.host.transientHistory.canRedo()).toBe(true)
    ctrlShiftZ()
    expect(row(h).points).toBe(4)

    expect(h.store.persisted.plants.map((plant) => [plant.id, plant.color])).toEqual([['source', '#2F6F4E']])
    expect(h.history.canUndo.value).toBe(true)
    expect(h.history.canRedo.value).toBe(true)
    expect(added(h)).toEqual([])
  })

  it('a picked plant that can no longer repeat or has moved ends the draft at once, with "source missed"', () => {
    const blockers: Record<string, (draft: { plants: ScenePlantEntity[]; layers: { name: string; visible: boolean; locked: boolean }[]; groups: unknown[] }) => void> = {
      'the plants layer locked': (draft) => {
        draft.layers = draft.layers.map((layer) => (layer.name === 'plants' ? { ...layer, locked: true } : layer))
      },
      'the plants layer hidden': (draft) => {
        draft.layers = draft.layers.map((layer) => (layer.name === 'plants' ? { ...layer, visible: false } : layer))
      },
      'the plant locked': (draft) => {
        draft.plants = draft.plants.map((plant) => ({ ...plant, locked: true }))
      },
      'the plant deleted': (draft) => {
        draft.plants = []
      },
      'the plant grouped': (draft) => {
        draft.groups = [{ kind: 'group', id: 'group-1', locked: false, name: 'Row', members: [{ kind: 'plant', id: 'source' }] }]
      },
      'the plant moved': (draft) => {
        draft.plants = draft.plants.map((plant) => ({ ...plant, position: { x: plant.position.x + 1, y: plant.position.y } }))
      },
    }
    for (const [name, block] of Object.entries(blockers)) {
      const { h } = pathHarness()
      h.click({ x: 20, y: 30 })
      h.click({ x: 100, y: 30 })
      expect(row(h), name).toMatchObject({ phase: 'row', points: 2 })

      h.store.updatePersisted((draft) => block(draft as never))
      h.host.sceneChanged()

      expect(row(h).phase, name).toBe('missed')
      expect(h.renderer.lastDraft(), name).toBeNull()
      expect(h.chrome.handles, name).toEqual([])
      expect(h.host.transientHistory.canUndo(), name).toBe(false)
      expect(added(h), name).toEqual([])
    }
  })

  it('counts and draws only the row the finish plants once no pointer hovers the map: after a finger, an edit or the pointer leaving', () => {
    /** The card, the ghosts and the length chip all describe a row of `plants` plants and `metres` m. */
    const expectRow = (h: ToolHarness, plants: number, metres: string, why: string): void => {
      expect(row(h), why).toMatchObject({ count: plants, length: metres })
      expect(ghostPositions(h), why).toHaveLength(plants)
      expect(lengthLabel(h), why).toBe(metres)
    }

    // A finger's taps, then a step back: the removed point leaves no rubber band behind.
    const stepped = pathHarness().h
    for (const x of [20, 100, 200]) stepped.click({ x, y: 30 }, { pointer: 'touch' })
    expectRow(stepped, 18, '18 m', 'two taps')
    stepped.host.command({ kind: 'undo-transient' })
    expectRow(stepped, 8, '8 m', 'a step back')
    stepped.host.command({ kind: 'redo-transient' })
    expectRow(stepped, 18, '18 m', 'a step forward')
    stepped.host.command({ kind: 'escape' })
    expectRow(stepped, 8, '8 m', 'Esc')
    finish(stepped)
    expect(added(stepped)).toHaveLength(8)

    // A finger drags the last point back: the row ends at the point, not where it was.
    const dragged = pathHarness().h
    for (const x of [20, 100, 200]) dragged.click({ x, y: 30 }, { pointer: 'touch' })
    dragged.drag(screenOf(dragged, 'point:draft:2'), { x: 150, y: 30 }, { target: { kind: 'handle', id: handleId('point:draft:2') }, pointer: 'touch' })
    expectRow(dragged, 13, '13 m', 'a point drag')
    dragged.host.command({ kind: 'point-action', handle: handleId('point:draft:2'), action: 'sharp-corner' })
    dragged.host.command({ kind: 'delete-handle' })
    expectRow(dragged, 8, '8 m', 'a deleted point')

    // A finger drag on the ground adds its point at the press; the lift adds none.
    const ground = pathHarness().h
    ground.click({ x: 20, y: 30 }, { pointer: 'touch' })
    ground.drag({ x: 100, y: 30 }, { x: 200, y: 30 }, { pointer: 'touch' })
    expect(row(ground).points).toBe(2)
    expectRow(ground, 8, '8 m', 'a ground drag')

    // A mouse hovers past the last point, then leaves the map (for the card): the band goes with it.
    const left = pathHarness().h
    left.click({ x: 20, y: 30 })
    left.click({ x: 100, y: 30 })
    left.hover({ x: 400, y: 30 })
    expectRow(left, 38, '38 m', 'the hovering mouse')
    left.leave()
    expectRow(left, 8, '8 m', 'the mouse gone')
    // "N plants" starts from the row the finish plants.
    left.host.command({ kind: 'spacing-mode', mode: 'count' })
    expect(row(left)).toMatchObject({ countText: '9', count: 8 })
    finish(left)
    expect(added(left)).toHaveLength(8)
  })

  it('Esc in the card\'s field steps back one point as Esc on the map does, and gives the map its focus', () => {
    const { h } = pathHarness()
    h.click({ x: 20, y: 30 })
    for (const x of [60, 100]) h.click({ x, y: 30 })
    h.host.command({ kind: 'spacing-mode', mode: 'count' })
    expect(row(h).points).toBe(3)

    expect(h.host.command({ kind: 'spacing-cancel' })).toBe('handled')
    expect(row(h)).toMatchObject({ phase: 'row', points: 2, mode: 'count' })
    expect(h.record.focus.at(-1)).toBe('map')
    expect(h.host.transientHistory.redo()).toBe(true)
    expect(row(h).points).toBe(3)

    // Down to the picked plant, then the picked plant goes; the tool stays armed.
    h.host.command({ kind: 'spacing-cancel' })
    h.host.command({ kind: 'spacing-cancel' })
    expect(row(h)).toMatchObject({ phase: 'row', points: 1 })
    h.host.command({ kind: 'spacing-cancel' })
    expect(row(h).phase).toBe('pick')
    expect(h.toolState.peek()).toBe('plant-spacing')
    expect(added(h)).toEqual([])
  })

  it('offers Delete point and Sharp or Smooth corner for a point from its menu; Delete takes the focused or last-touched point', () => {
    const { h, tool } = pathHarness()
    h.click({ x: 20, y: 30 })
    h.click({ x: 80, y: 30 })
    expect(tool.pointMenu?.(handleId('point:draft:1'))).toEqual([
      { action: 'delete-point', disabled: true },
      { action: 'sharp-corner', disabled: false },
    ])
    h.click({ x: 140, y: 30 })
    expect(tool.pointMenu?.(handleId('point:draft:1'))).toEqual([
      { action: 'delete-point', disabled: false },
      { action: 'sharp-corner', disabled: false },
    ])
    expect(tool.pointMenu?.(handleId('point:draft:0')), 'the picked plant').toEqual([])
    expect(tool.pointMenu?.(handleId('dot:draft:0')), 'a dot').toEqual([])

    expect(h.host.command({ kind: 'point-action', handle: handleId('point:draft:1'), action: 'sharp-corner' })).toBe('handled')
    expect(h.chrome.handles.find((handle) => handle.id === 'point:draft:1')?.glyph).toBe('corner')
    expect(tool.pointMenu?.(handleId('point:draft:1'))?.[1]).toEqual({ action: 'smooth-corner', disabled: false })

    // With no point focused, Delete takes the last-touched point: a still click on a point touches it.
    h.click(screenOf(h, 'point:draft:2'), { target: { kind: 'handle', id: handleId('point:draft:2') } })
    expect(h.chrome.activeHandle).toBe('point:draft:2')
    expect(h.host.command({ kind: 'delete-handle' })).toBe('handled')
    expect(pointIds(h)).toEqual(['point:draft:1'])
    expect(h.chrome.activeHandle).toBeNull()
    expect(h.host.command({ kind: 'point-action', handle: handleId('point:draft:1'), action: 'delete-point' }), 'below the minimum').toBe('pass')

    // Delete takes the focused point, else the last-touched one.
    h.click(h.screen({ x: 14, y: 3 }))
    h.chrome.focusedHandle = handleId('point:draft:1')
    expect(h.host.command({ kind: 'delete-handle' })).toBe('handled')
    expect(pointAt(h, 1)).toEqual(closePoint(14, 3))
    expect(added(h)).toEqual([])
  })

  it('leads the canvas menu with Finish shape from 2 points', () => {
    const { h } = pathHarness()
    h.click({ x: 20, y: 30 })
    h.menu({ x: 200, y: 200 })
    expect(h.record.menus.at(-1)?.finishShape).toBeUndefined()
    h.click({ x: 80, y: 30 })
    h.menu({ x: 200, y: 200 })
    const finishShape = h.record.menus.at(-1)?.finishShape
    expect(finishShape).toBeTypeOf('function')
    finishShape!()
    expect(added(h).length).toBeGreaterThan(5)
  })

  it('turns the next point to 45 degree steps from the last one under Shift, never a point drag', () => {
    const { h } = pathHarness()
    h.click(h.screen({ x: 2, y: 3 }))
    h.click(h.screen({ x: 8, y: 3 }))
    h.hover(h.screen({ x: 14, y: 4.5 }), { shift: true })
    expect(shapesOf(h, 'polyline')[0]!.points.at(-1)!.y).toBeCloseTo(3, 6)
    h.click(h.screen({ x: 14, y: 4.5 }), { mods: { shift: true } })
    expect(pointAt(h, 2).y).toBeCloseTo(3, 6)

    const point = screenOf(h, 'point:draft:1')
    const dragTarget = { x: point.x + 13, y: point.y + 31 }
    h.press(point, { target: { kind: 'handle', id: handleId('point:draft:1') }, mods: { shift: true } })
    h.move(dragTarget, { shift: true })
    h.release(dragTarget, { shift: true })
    expect(pointAt(h, 1)).toEqual(h.world(dragTarget))
  })

  it('grows the points and dots to 44 px after a finger', () => {
    const { h } = pathHarness()
    h.click({ x: 20, y: 30 }, { pointer: 'touch' })
    h.click({ x: 100, y: 30 }, { pointer: 'touch' })
    h.click({ x: 260, y: 30 }, { pointer: 'touch' })
    // The picked plant and two points, and the one dot with 132 px of room.
    expect(h.chrome.handles.map((handle) => [handle.id, handle.hitRadiusPx])).toEqual([
      ['point:draft:0', 22], ['point:draft:1', 22], ['point:draft:2', 22], ['dot:draft:1', 22],
    ])
    expect(row(h).touch).toBe(true)
  })

  it('sets the length chip beside a dot that sits under it', () => {
    const { h } = pathHarness()
    h.click(h.screen({ x: 2, y: 3 }))
    h.hover(h.screen({ x: 10, y: 3 }))
    expect(shapesOf(h, 'label')[0]).not.toHaveProperty('beside')
    h.click(h.screen({ x: 10, y: 3 }))
    const [label] = shapesOf(h, 'label')
    expect(label).toMatchObject({ anchor: closePoint(6, 3), text: '8 m', beside: { gapPx: 6 } })
    expect(Math.abs(label!.beside!.normalPx.y)).toBeCloseTo(1, 9)
  })
})
