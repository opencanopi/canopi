import { beforeEach, describe, expect, it } from 'vitest'
import { hoveredPanelTargets, selectedPanelTargets } from '../app/panel-targets/state'
import {
  MANUAL_TARGET,
  targetIdentity,
  type TargetSceneInput,
} from '../target'
import type { PanelTarget } from '../types/design'

const NONE_TARGET = { kind: 'none' } as const

function createScene(overrides: Partial<TargetSceneInput> = {}): TargetSceneInput {
  return {
    plants: [
      { id: 'plant-1', canonicalName: 'Malus domestica', position: { x: 0, y: 0 } },
      { id: 'plant-2', canonicalName: 'Prunus avium', position: { x: 12, y: -6 } },
      { id: 'plant-3', canonicalName: 'Malus domestica', position: { x: 10, y: 20 } },
    ],
    zones: [
      {
        id: 'orchard',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
      },
    ],
    ...overrides,
  }
}

describe('targets identity seam', () => {
  beforeEach(() => {
    hoveredPanelTargets.value = []
    selectedPanelTargets.value = []
  })

  it('centralizes constructors, keys, equality, and list equality', () => {
    const species = targetIdentity.species('Malus domestica')
    const sameSpecies = targetIdentity.species('Malus domestica')
    const otherSpecies = targetIdentity.species('Prunus avium')

    expect(species).toEqual({ kind: 'species', canonical_name: 'Malus domestica' })
    expect(targetIdentity.key(species)).toBe('species:Malus domestica')
    expect(targetIdentity.key({ kind: 'placed_plant', plant_id: 'plant-1' })).toBe('placed_plant:plant-1')
    expect(targetIdentity.key({ kind: 'zone', zone_id: 'orchard' })).toBe('zone:orchard')
    expect(targetIdentity.key(MANUAL_TARGET)).toBe('manual')
    expect(targetIdentity.key(NONE_TARGET)).toBe('none')

    expect(targetIdentity.equals(species, sameSpecies)).toBe(true)
    expect(targetIdentity.equals(species, otherSpecies)).toBe(false)
    expect(targetIdentity.listEquals([species, MANUAL_TARGET], [sameSpecies, MANUAL_TARGET])).toBe(true)
    expect(targetIdentity.listEquals([species, MANUAL_TARGET], [MANUAL_TARGET, sameSpecies])).toBe(false)
  })

  it('resolves scene-backed targets without owning map projection', () => {
    const missingSpecies = targetIdentity.species('Pyrus communis')
    const missingPlant: PanelTarget = { kind: 'placed_plant', plant_id: 'missing-plant' }
    const missingZone: PanelTarget = { kind: 'zone', zone_id: 'missing-zone' }
    const index = targetIdentity.indexScene(createScene())

    const resolution = targetIdentity.resolve(
      [
        targetIdentity.species('Malus domestica'),
        { kind: 'placed_plant', plant_id: 'plant-2' },
        { kind: 'zone', zone_id: 'orchard' },
        MANUAL_TARGET,
        NONE_TARGET,
        missingSpecies,
        missingPlant,
        missingZone,
      ],
      index,
    )

    expect(resolution.plantIds).toEqual(['plant-1', 'plant-3', 'plant-2'])
    expect(resolution.zoneIds).toEqual(['orchard'])
    expect(resolution.resolvedRefs.map((ref) => ({ kind: ref.kind, id: ref.id }))).toEqual([
      { kind: 'plant', id: 'plant-1' },
      { kind: 'plant', id: 'plant-3' },
      { kind: 'plant', id: 'plant-2' },
      { kind: 'zone', id: 'orchard' },
    ])
    expect('toMapFeatures' in resolution).toBe(false)
  })

  it('deduplicates resolved scene refs while preserving first discovery order', () => {
    const resolution = targetIdentity.resolve(
      [
        { kind: 'placed_plant', plant_id: 'plant-3' },
        targetIdentity.species('Malus domestica'),
        { kind: 'placed_plant', plant_id: 'plant-1' },
        { kind: 'zone', zone_id: 'orchard' },
        { kind: 'zone', zone_id: 'orchard' },
      ],
      targetIdentity.indexScene(createScene()),
    )

    expect(resolution.plantIds).toEqual(['plant-3', 'plant-1'])
    expect(resolution.zoneIds).toEqual(['orchard'])
    expect(resolution.resolvedRefs.map((ref) => ({ kind: ref.kind, id: ref.id }))).toEqual([
      { kind: 'plant', id: 'plant-3' },
      { kind: 'plant', id: 'plant-1' },
      { kind: 'zone', id: 'orchard' },
    ])
  })

  it('resolves missing targets to nothing without mutating panel hover or selection state', () => {
    const hovered = [targetIdentity.species('Hovered')]
    const selected = [targetIdentity.species('Selected')]
    hoveredPanelTargets.value = hovered
    selectedPanelTargets.value = selected

    const resolution = targetIdentity.resolve(
      [
        targetIdentity.species('Missing species'),
        { kind: 'placed_plant', plant_id: 'missing-plant' },
        { kind: 'zone', zone_id: 'missing-zone' },
      ],
      targetIdentity.indexScene(createScene()),
    )

    expect(resolution.plantIds).toEqual([])
    expect(resolution.zoneIds).toEqual([])
    expect(resolution.resolvedRefs).toEqual([])
    expect(hoveredPanelTargets.value).toBe(hovered)
    expect(selectedPanelTargets.value).toBe(selected)
  })
})
