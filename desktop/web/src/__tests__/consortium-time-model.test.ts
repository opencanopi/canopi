import { buildConsortiumPlanningProjection } from '../app/planning-projection/consortium'
import { describe, expect, it } from 'vitest'
import {
  CONSORTIUM_STRATA,
  CONSORTIUM_SUCCESSION_PHASES,
  DEFAULT_CONSORTIUM_END_PHASE,
  DEFAULT_CONSORTIUM_START_PHASE,
  DEFAULT_CONSORTIUM_STRATUM,
  SUCCESSION_PHASE_COUNT,
} from '../planning/time-model'
import { getConsortiumCanonicalName } from '../target'

describe('Consortium time model', () => {
  it('owns Succession Phase labels, durations, and count', () => {
    expect(CONSORTIUM_SUCCESSION_PHASES.map((phase) => phase.key)).toEqual([
      'placenta1',
      'placenta2',
      'placenta3',
      'secondaire1',
      'secondaire2',
      'secondaire3',
      'climax',
    ])
    expect(CONSORTIUM_SUCCESSION_PHASES[0]).toMatchObject({
      labelKey: 'canvas.consortium.phase_placenta1',
      durationKey: 'canvas.consortium.duration_90d',
    })
    expect(SUCCESSION_PHASE_COUNT).toBe(7)
  })

  it('owns Stratum ordering and the default Stratum', () => {
    expect(CONSORTIUM_STRATA).toEqual(['emergent', 'high', 'medium', 'low', 'unassigned'])
    expect(DEFAULT_CONSORTIUM_STRATUM).toBe('unassigned')
  })

  it('creates default Consortium entries for newly placed species', () => {
    const projection = buildConsortiumPlanningProjection({
      consortiums: [],
      plants: [{
        id: 'p-1',
        canonical_name: 'Quercus robur',
        common_name: null,
        color: null,
        locked: false,
        position: { lon: 0, lat: 0 },
        rotation: null,
        canopy_spread_m: 4,
        notes: null,
        planted_date: null,
        quantity: 1,
      }],
    })
    const entry = projection.activeEntries[0]!

    expect(getConsortiumCanonicalName(entry)).toBe('Quercus robur')
    expect(entry.stratum).toBe(DEFAULT_CONSORTIUM_STRATUM)
    expect(entry.start_phase).toBe(DEFAULT_CONSORTIUM_START_PHASE)
    expect(entry.end_phase).toBe(DEFAULT_CONSORTIUM_END_PHASE)
  })
})
