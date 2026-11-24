import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isPlantDbUnavailableError } from '../ipc/plant-db-errors'
import { CanvasSpeciesCache, installSpeciesCacheLoader } from '../app/canvas-runtime/species-cache'

const mocks = vi.hoisted(() => ({
  getSpeciesBatch: vi.fn(async () => []),
  getFlowerColorBatch: vi.fn(async () => []),
}))

describe('CanvasSpeciesCache', () => {
  beforeEach(() => {
    mocks.getSpeciesBatch.mockReset()
    mocks.getFlowerColorBatch.mockReset()
    mocks.getSpeciesBatch.mockResolvedValue([] as any)
    mocks.getFlowerColorBatch.mockResolvedValue([] as any)
    installSpeciesCacheLoader({
      getSpeciesBatch: mocks.getSpeciesBatch,
      getFlowerColorBatch: mocks.getFlowerColorBatch,
      isPlantDbUnavailableError,
    })
  })

  it('loads missing entries once and stores resolved flower color fields', async () => {
    mocks.getSpeciesBatch.mockResolvedValueOnce([
      {
        canonical_name: 'Malus domestica',
        locked: false,
        flower_color: 'White',
        family: 'Rosaceae',
      },
    ] as any)
    mocks.getFlowerColorBatch.mockResolvedValueOnce([
      {
        canonical_name: 'Malus domestica',
        locked: false,
        flower_color: 'Pink',
        source: 'genus',
      },
    ] as any)

    const cache = new CanvasSpeciesCache()
    const loaded = await cache.ensureEntries(['Malus domestica'], 'en')

    expect(loaded).toBe(true)
    expect(mocks.getSpeciesBatch).toHaveBeenCalledWith(['Malus domestica'], 'en')
    expect(mocks.getFlowerColorBatch).toHaveBeenCalledWith(['Malus domestica'])
    expect(cache.getCache().get('Malus domestica')).toMatchObject({
      canonical_name: 'Malus domestica',
      locked: false,
      flower_color: 'White',
      resolved_flower_color: 'Pink',
      resolved_flower_color_source: 'genus',
    })
    expect(cache.getSuggestedPlantColor('Malus domestica')).toBe('#C25B82')
  })

  it('skips fetches when all requested entries are already cached', async () => {
    const cache = new CanvasSpeciesCache()
    mocks.getSpeciesBatch.mockResolvedValueOnce([{ canonical_name: 'Malus domestica' }] as any)

    await cache.ensureEntries(['Malus domestica'], 'en')
    const loaded = await cache.ensureEntries(['Malus domestica', 'Malus domestica'], 'en')

    expect(loaded).toBe(false)
    expect(mocks.getSpeciesBatch).toHaveBeenCalledTimes(1)
    expect(mocks.getFlowerColorBatch).toHaveBeenCalledTimes(1)
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
      resolved_flower_color: null,
      resolved_flower_color_source: 'none',
    })
  })
})
