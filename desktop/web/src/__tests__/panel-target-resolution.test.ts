import { describe, expect, it } from 'vitest'
import { MANUAL_TARGET, speciesTarget } from '../target'
import { indexTargetScene, resolveTargetsInScene, type TargetSceneInput } from '../target/identity'
import type { PanelTarget } from '../types/design'

const NONE_TARGET = { kind: 'none' } as const

/** The resolution the canvas overlays project, without its resolved references. */
function resolveTargets(values: readonly PanelTarget[], scene: TargetSceneInput) {
  const { plantIds, zoneIds } = resolveTargetsInScene(values, indexTargetScene(scene))
  return { plantIds, zoneIds }
}

function createScene(overrides: Partial<TargetSceneInput> = {}): TargetSceneInput {
  return {
    plants: [
      { id: 'plant-1', canonicalName: 'Malus domestica' },
      { id: 'plant-2', canonicalName: 'Prunus avium' },
      { id: 'plant-3', canonicalName: 'Malus domestica' },
    ],
    zones: [
      { id: 'orchard' },
      { id: 'pond-edge' },
    ],
    ...overrides,
  }
}

describe('resolveTargets', () => {
  it('resolves a species target to all matching placed plants in scene order', () => {
    const result = resolveTargets([speciesTarget('Malus domestica')], createScene())

    expect(result).toEqual({
      plantIds: ['plant-1', 'plant-3'],
      zoneIds: [],
    })
  })

  it('resolves a placed plant target only when the plant ID exists', () => {
    const target: PanelTarget = { kind: 'placed_plant', plant_id: 'plant-2' }

    const result = resolveTargets([target], createScene())

    expect(result).toEqual({
      plantIds: ['plant-2'],
      zoneIds: [],
    })
  })

  it('resolves a zone target by zone id', () => {
    const target: PanelTarget = { kind: 'zone', zone_id: 'orchard' }

    const result = resolveTargets([target], createScene())

    expect(result).toEqual({
      plantIds: [],
      zoneIds: ['orchard'],
    })
  })

  it('treats manual and none targets as intentionally empty', () => {
    const result = resolveTargets([MANUAL_TARGET, NONE_TARGET], createScene())

    expect(result).toEqual({
      plantIds: [],
      zoneIds: [],
    })
  })

  it('resolves mixed targets and skips missing scene-backed targets', () => {
    const missingSpecies = speciesTarget('Pyrus communis')
    const missingPlant: PanelTarget = { kind: 'placed_plant', plant_id: 'plant-missing' }
    const missingZone: PanelTarget = { kind: 'zone', zone_id: 'missing-zone' }

    const result = resolveTargets(
      [
        speciesTarget('Malus domestica'),
        { kind: 'placed_plant', plant_id: 'plant-2' },
        { kind: 'zone', zone_id: 'pond-edge' },
        MANUAL_TARGET,
        NONE_TARGET,
        missingSpecies,
        missingPlant,
        missingZone,
      ],
      createScene(),
    )

    expect(result).toEqual({
      plantIds: ['plant-1', 'plant-3', 'plant-2'],
      zoneIds: ['pond-edge'],
    })
  })

  it('deduplicates plant IDs while preserving first discovery order', () => {
    const result = resolveTargets(
      [
        { kind: 'placed_plant', plant_id: 'plant-3' },
        speciesTarget('Malus domestica'),
        { kind: 'placed_plant', plant_id: 'plant-1' },
      ],
      createScene(),
    )

    expect(result).toEqual({
      plantIds: ['plant-3', 'plant-1'],
      zoneIds: [],
    })
  })

  it('keeps plant and zone IDs typed when names collide', () => {
    const result = resolveTargets(
      [
        { kind: 'zone', zone_id: 'plant-1' },
        { kind: 'placed_plant', plant_id: 'orchard' },
      ],
      createScene({
        plants: [
          { id: 'plant-1', canonicalName: 'Malus domestica' },
          { id: 'orchard', canonicalName: 'Prunus avium' },
        ],
        zones: [
          { id: 'plant-1' },
          { id: 'orchard' },
        ],
      }),
    )

    expect(result).toEqual({
      plantIds: ['orchard'],
      zoneIds: ['plant-1'],
    })
  })
})
