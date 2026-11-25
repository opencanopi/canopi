import { describe, expect, it } from 'vitest'
import type { ScenePlantEntity, ScenePoint } from '../canvas/runtime/scene'
import { computePinnedPlantNameLabels, computeSelectionLabels } from '../canvas/runtime/selection-labels'
import { createTestRendererView } from './support/scene-renderer-snapshot'
import './support/camera-tolerance'

function createViewport(overrides: Partial<{ x: number; y: number; scale: number }> = {}) {
  return { x: 0, y: 0, scale: 8, ...overrides }
}

/** Where a label lands in a bearing-0 frame at `viewport`: its projected anchor plus its offset. */
function landing(label: { anchor: ScenePoint; offsetPx: ScenePoint }, viewport = createViewport()): ScenePoint {
  const anchor = createTestRendererView(viewport).worldToScreen(label.anchor)
  return { x: anchor.x + label.offsetPx.x, y: anchor.y + label.offsetPx.y }
}

function createPlant(overrides: Partial<ScenePlantEntity> = {}): ScenePlantEntity {
  return {
    kind: 'plant' as const,
    id: 'plant-1',
    canonicalName: 'Malus domestica',
    commonName: 'Apple',
    color: null,
    canopySpreadM: null,
    position: { x: 10, y: 20 },
    rotationDeg: null,
    notes: null,
    plantedDate: null,
    quantity: null,
    ...overrides,
    locked: overrides.locked ?? false,
  }
}

describe('selection labels', () => {
  it('returns empty array when no plants are selected', () => {
    const result = computeSelectionLabels(
      [createPlant()],
      new Set(),
      createViewport().scale,
      new Map(),
    )
    expect(result).toEqual([])
  })

  it('computes one label for a single selected unpinned plant', () => {
    const plants = [createPlant({ id: 'a', position: { x: 10, y: 20 } })]
    const viewport = createViewport({ scale: 1 })
    const anchor = createTestRendererView(viewport).worldToScreen({ x: 10, y: 20 })
    const result = computeSelectionLabels(
      plants,
      new Set(['a']),
      viewport.scale,
      new Map(),
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.canonicalName).toBe('Malus domestica')
    expect(landing(result[0]!, viewport).x).toBeCloseTo(anchor.x, 6)
  })

  it('places a selected plant label below the glyph at low zoom', () => {
    const viewport = createViewport({ scale: 1 })
    const anchor = createTestRendererView(viewport).worldToScreen({ x: 10, y: 20 })
    const result = computeSelectionLabels(
      [createPlant({ id: 'a', position: { x: 10, y: 20 } })],
      new Set(['a']),
      viewport.scale,
      new Map(),
    )

    expect(landing(result[0]!, viewport).x).toBeCloseTo(anchor.x, 6)
    expect(landing(result[0]!, viewport).y).toBeCloseTo(anchor.y + 5, 2)
  })

  it('hangs the selected plant label 2 px under its symbol at high zoom', () => {
    const viewport = createViewport({ scale: 1000 })
    const anchor = createTestRendererView(viewport).worldToScreen({ x: 10, y: 20 })
    const result = computeSelectionLabels(
      [createPlant({ id: 'a', position: { x: 10, y: 20 } })],
      new Set(['a']),
      viewport.scale,
      new Map(),
    )

    expect(landing(result[0]!, viewport).x).toBeCloseTo(anchor.x, 5)
    expect(landing(result[0]!, viewport).y).toBeCloseTo(anchor.y + 16, 2)
  })

  it('returns empty array when multiple plants are selected', () => {
    const plants = [
      createPlant({ id: 'a', canonicalName: 'Malus domestica', position: { x: 0, y: 0 } }),
      createPlant({ id: 'b', canonicalName: 'Pyrus communis', position: { x: 10, y: 0 } }),
    ]
    const result = computeSelectionLabels(
      plants,
      new Set(['a', 'b']),
      createViewport({ scale: 1 }).scale,
      new Map(),
    )
    expect(result).toEqual([])
  })

  it('returns empty array when one plant is selected with another design object', () => {
    const result = computeSelectionLabels(
      [createPlant({ id: 'a' })],
      new Set(['a', 'zone-1']),
      createViewport().scale,
      new Map(),
    )
    expect(result).toEqual([])
  })

  it('returns empty array when the single selected plant already has a pinned name', () => {
    const result = computeSelectionLabels(
      [createPlant({ id: 'a', pinnedName: true })],
      new Set(['a']),
      createViewport().scale,
      new Map(),
    )
    expect(result).toEqual([])
  })

  it('uses localized common name when available', () => {
    const result = computeSelectionLabels(
      [createPlant({ id: 'a' })],
      new Set(['a']),
      createViewport().scale,
      new Map([['Malus domestica', 'Pommier']]),
    )
    expect(result[0]!.text).toBe('Pommier')
    expect(result[0]!.fontStyle).toBe('normal')
  })

  it('falls back to abbreviated canonical name when no common name exists', () => {
    const plant = createPlant({ id: 'a', commonName: null, canonicalName: 'Lavandula angustifolia' })
    const result = computeSelectionLabels(
      [plant],
      new Set(['a']),
      createViewport().scale,
      new Map(),
    )
    expect(result[0]!.text).toBe('L. ang.')
    expect(result[0]!.fontStyle).toBe('italic')
  })

  it('fades pinned names smoothly on zoom reversal without changing saved pinning', () => {
    const plants = [createPlant({ pinnedName: true })]
    const before = structuredClone(plants)
    const visible = [20, 14, 8, 14, 20].map((scale) =>
      computePinnedPlantNameLabels(plants, createViewport({ scale }).scale, new Map(), new Set()),
    )
    expect(visible.map((labels) => labels[0]?.opacity ?? 0)).toEqual([1, 0.5, 0, 0.5, 1])
    expect(visible[2]).toEqual([])
    expect(plants).toEqual(before)
  })

  it('reveals only a singleton selected pinned name at overview scale', () => {
    const plants = [createPlant({ id: 'a', pinnedName: true }), createPlant({ id: 'b', pinnedName: true })]
    const labels = computePinnedPlantNameLabels(plants, createViewport().scale, new Map(), new Set(['a']))
    expect(labels.map(({ plantId, opacity }) => ({ plantId, opacity }))).toEqual([{ plantId: 'a', opacity: 1 }])
    expect(computePinnedPlantNameLabels(plants, createViewport().scale, new Map(), new Set(['a', 'b']))).toEqual([])
  })

  it('does not nudge overlapping pinned plant names', () => {
    const plants = [
      createPlant({ id: 'a', pinnedName: true, position: { x: 0, y: 0 } }),
      createPlant({ id: 'b', pinnedName: true, position: { x: 0, y: 0 } }),
    ]
    const result = computePinnedPlantNameLabels(
      plants,
      createViewport({ scale: 20 }).scale,
      new Map(),
      new Set(),
    )
    expect(result).toHaveLength(2)
    expect(landing(result[1]!, createViewport({ scale: 20 }))).toEqual(landing(result[0]!, createViewport({ scale: 20 })))
  })
})
