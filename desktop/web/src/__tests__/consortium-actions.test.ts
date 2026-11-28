import { beforeEach, describe, expect, it } from 'vitest'
import {
  designDirty,
  designSessionFixture,
  currentDesign,
} from './support/design-session-state'
import { moveConsortiumEntry } from '../app/design-edit'
import { consortiumTarget } from '../target'
import type { Consortium } from '../types/design'

function consortium(canonicalName: string, overrides: Partial<Omit<Consortium, 'target'>> = {}): Consortium {
  return {
    target: consortiumTarget(canonicalName),
    stratum: 'high',
    start_phase: 0,
    end_phase: 3,
    ...overrides,
  }
}

beforeEach(() => {
  designSessionFixture.file = {
    version: 9,
    name: 'test',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [{
      id: 'plant-1',
      canonical_name: 'Quercus robur',
      common_name: 'English oak',
      color: null,
      position: { lon: 13, lat: 23 },
      rotation: null,
      canopy_spread_m: null,
      notes: null,
      planted_date: null,
      quantity: null,
      locked: false,
    }],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '',
    updated_at: '',
    extra: {},
  }
})

function seedConsortiums(...entries: Consortium[]): void {
  designSessionFixture.file = { ...currentDesign.value!, consortiums: entries }
}

describe('moveConsortiumEntry', () => {
  it('moves an entry to a new stratum and phase range', () => {
    seedConsortiums(consortium('Quercus robur'))
    moveConsortiumEntry('Quercus robur', { stratum: 'medium', startPhase: 2, endPhase: 5 })

    const entry = currentDesign.value!.consortiums[0]!
    expect(entry.stratum).toBe('medium')
    expect(entry.start_phase).toBe(2)
    expect(entry.end_phase).toBe(5)
    expect(designDirty.value).toBe(true)
  })

  it('preserves existing stratum when stratum is omitted', () => {
    seedConsortiums(consortium('Quercus robur'))
    moveConsortiumEntry('Quercus robur', { startPhase: 1, endPhase: 4 })

    expect(currentDesign.value!.consortiums[0]!.stratum).toBe('high')
  })

  it('is a no-op when canonical_name not found', () => {
    seedConsortiums(consortium('Quercus robur'))
    moveConsortiumEntry('Nonexistent', { stratum: 'medium', startPhase: 1, endPhase: 4 })

    expect(designDirty.value).toBe(false)
  })

  it('is a no-op when values unchanged', () => {
    seedConsortiums(consortium('Quercus robur'))
    moveConsortiumEntry('Quercus robur', { stratum: 'high', startPhase: 0, endPhase: 3 })

    expect(designDirty.value).toBe(false)
  })
})
