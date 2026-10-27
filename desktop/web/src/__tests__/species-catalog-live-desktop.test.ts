import { describe, expect, it, vi } from 'vitest'

const getSpeciesHabits = vi.hoisted(() => vi.fn(async (names: string[]) => (
  Object.fromEntries(names.map((name) => [name, 'Tree']))
)))
const getCommonNames = vi.hoisted(() => vi.fn(async (names: string[], locale: string) => (
  Object.fromEntries(names.map((name) => [name, `${name} (${locale})`]))
)))
const searchSpecies = vi.hoisted(() => vi.fn(async () => ({ items: [], next_cursor: null, total_estimate: null })))

vi.mock('../ipc/species', async (importOriginal) => ({
  ...await importOriginal<typeof IpcSpeciesModule>(),
  getCommonNames,
  getSpeciesHabits,
  searchSpecies,
}))

import { plantDbStatus } from '../app/health/state'
import type * as IpcSpeciesModule from '../ipc/species'

describe('Desktop species catalog workbench', () => {
  it('reads catalog habits in batches the native lookup accepts', async () => {
    const { speciesCatalogWorkbench } = await import('../app/plant-browser/live.desktop')
    const names = Array.from({ length: 1201 }, (_, index) => `Species ${index}`)

    const habits = await speciesCatalogWorkbench.resolveHabits(names)

    expect(getSpeciesHabits.mock.calls.map(([batch]) => batch.length)).toEqual([500, 500, 201])
    expect(Object.keys(habits)).toHaveLength(1201)
  })

  it('reads common names in batches the native lookup accepts', async () => {
    const { speciesCatalogWorkbench } = await import('../app/plant-browser/live.desktop')
    const names = Array.from({ length: 701 }, (_, index) => `Species ${index}`)

    const common = await speciesCatalogWorkbench.resolveCommonNames(names, 'fr')

    expect(getCommonNames.mock.calls.map(([batch, locale]) => [batch.length, locale])).toEqual([[500, 'fr'], [201, 'fr']])
    expect(Object.keys(common)).toHaveLength(701)
    expect(common['Species 700']).toBe('Species 700 (fr)')
  })

  // The plant DB health gate is the adapter's: the transport is a plain IPC wrapper.
  it('answers nothing over IPC while the plant DB is missing or corrupt', async () => {
    const { speciesCatalogWorkbench } = await import('../app/plant-browser/live.desktop')
    plantDbStatus.value = 'corrupt'
    try {
      getCommonNames.mockClear()
      getSpeciesHabits.mockClear()
      await expect(speciesCatalogWorkbench.resolveCommonNames(['Malus domestica'], 'fr'))
        .rejects.toThrow('Plant database unavailable: bundled plant database is corrupt')
      await expect(speciesCatalogWorkbench.resolveHabits(['Malus domestica'])).resolves.toEqual({})
      await expect(speciesCatalogWorkbench.searchCloseMatches('apple', 5))
        .rejects.toThrow('Plant database unavailable: bundled plant database is corrupt')
      expect(getCommonNames).not.toHaveBeenCalled()
      expect(getSpeciesHabits).not.toHaveBeenCalled()
      expect(searchSpecies).not.toHaveBeenCalled()
    } finally {
      plantDbStatus.value = 'available'
    }
    await speciesCatalogWorkbench.resolveHabits(['Malus domestica'])
    expect(getSpeciesHabits).toHaveBeenCalledOnce()
  })
})
