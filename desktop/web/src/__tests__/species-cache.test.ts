import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isPlantDbUnavailableError } from '../ipc/plant-db-errors'
import { CanvasSpeciesCache, installSpeciesCacheLoader } from '../app/canvas-runtime/species-cache'

const mocks = vi.hoisted(() => ({
  getSpeciesBatch: vi.fn(async () => []),
}))

describe('CanvasSpeciesCache', () => {
  beforeEach(() => {
    mocks.getSpeciesBatch.mockReset()
    mocks.getSpeciesBatch.mockResolvedValue([] as any)
    installSpeciesCacheLoader({
      getSpeciesBatch: mocks.getSpeciesBatch,
      isPlantDbUnavailableError,
    })
  })

  it('loads missing entries once', async () => {
    mocks.getSpeciesBatch.mockResolvedValueOnce([
      {
        canonical_name: 'Malus domestica',
        locked: false,
        flower_color: 'White',
        family: 'Rosaceae',
      },
    ] as any)

    const cache = new CanvasSpeciesCache()
    const loaded = await cache.ensureEntries(['Malus domestica'], 'en')

    expect(loaded).toBe(true)
    expect(mocks.getSpeciesBatch).toHaveBeenCalledWith(['Malus domestica'], 'en')
    expect(cache.getCache().get('Malus domestica')).toMatchObject({
      canonical_name: 'Malus domestica',
      locked: false,
      flower_color: 'White',
    })
  })

  it('skips fetches when all requested entries are already cached', async () => {
    const cache = new CanvasSpeciesCache()
    mocks.getSpeciesBatch.mockResolvedValueOnce([{ canonical_name: 'Malus domestica' }] as any)

    await cache.ensureEntries(['Malus domestica'], 'en')
    const loaded = await cache.ensureEntries(['Malus domestica', 'Malus domestica'], 'en')

    expect(loaded).toBe(false)
    expect(mocks.getSpeciesBatch).toHaveBeenCalledTimes(1)
  })

  it('seeds placeholder entries when plant db is unavailable', async () => {
    mocks.getSpeciesBatch.mockRejectedValueOnce(
      new Error('Plant database unavailable: bundled plant database is missing'),
    )

    const cache = new CanvasSpeciesCache()
    const loaded = await cache.ensureEntries(['Malus domestica'], 'en')
    const secondLoad = await cache.ensureEntries(['Malus domestica'], 'en')

    expect(loaded).toBe(true)
    expect(secondLoad).toBe(false)
    expect(mocks.getSpeciesBatch).toHaveBeenCalledTimes(1)
    expect(cache.getCache().get('Malus domestica')).toMatchObject({
      canonical_name: 'Malus domestica',
    })
  })
})
