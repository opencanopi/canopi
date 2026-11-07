import { beforeEach, describe, expect, it } from 'vitest'
import { DESIGN_EDIT_EXTRA_KEYS, readExtra, withExtra } from '../app/design-edit/extra-keys'
import { readPlantDisplayOptions, withPlantDisplayOptions } from '../app/design-edit/plant-display'
import { recentFrontendDiagnostics } from '../app/problem-report/diagnostics'
import { resetFrontendDiagnosticsForTests } from '../failures/ring'
import type { CanopiFile } from '../types/design'

function design(overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: 9, name: 'Extra', description: null,
    plant_species_colors: {}, plant_species_symbols: {}, plant_species_codes: {},
    layers: [], plants: [], zones: [], annotations: [], measurement_guides: [], consortiums: [], groups: [],
    timeline: [], budget: [], budget_currency: 'EUR', views: [], stories: [],
    created_at: '', updated_at: '', extra: {},
    ...overrides,
  }
}

const repairs = () => recentFrontendDiagnostics().filter((entry) => entry.source === 'design-edit:extra')

describe('Design Edit extra keys', () => {
  beforeEach(() => resetFrontendDiagnosticsForTests())

  it('reads and writes one key through the accessor pair, leaving an unchanged Design untouched', () => {
    const empty = design()
    expect(readExtra(empty, DESIGN_EDIT_EXTRA_KEYS.plantDisplay)).toBeNull()
    expect(withExtra(empty, DESIGN_EDIT_EXTRA_KEYS.plantDisplay, null)).toBe(empty)

    const written = withExtra(empty, DESIGN_EDIT_EXTRA_KEYS.plantDisplay, { labels: 'codes' })
    expect(written.extra).toEqual({ plant_display: { labels: 'codes' } })
    expect(withExtra(written, DESIGN_EDIT_EXTRA_KEYS.plantDisplay, { labels: 'codes' })).toBe(written)
    expect(withExtra(written, DESIGN_EDIT_EXTRA_KEYS.plantDisplay, null).extra).toEqual({})
    expect(readExtra(written, DESIGN_EDIT_EXTRA_KEYS.plantDisplay)).toEqual({ labels: 'codes' })
    expect(repairs()).toEqual([])
  })

  it('reports a stored value that is not an object once per stored value, and reads it as absent', () => {
    const broken = design({ extra: { plant_display: 'nope' } })
    expect(readPlantDisplayOptions(broken).labels).toBe(readPlantDisplayOptions(design()).labels)
    readPlantDisplayOptions(broken)
    expect(repairs().map((entry) => entry.message)).toEqual([
      'Repaired extra.plant_display on read: the stored value is not an object.',
    ])
  })

  it('reports fields defaulted on read', () => {
    const odd = design({ extra: { plant_display: { color_by: 'rainbow', one_color: '#C44230', symbol_scale: 1, outline: true, labels: 'names' } } })
    expect(readPlantDisplayOptions(odd).colorBy).toBe('species')
    expect(repairs().map((entry) => entry.message)).toEqual(['Repaired extra.plant_display on read: color_by defaulted.'])
    expect(readPlantDisplayOptions(withPlantDisplayOptions(odd, { outline: false })).outline).toBe(false)
  })
})
