import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlantDetailController } from '../app/plant-detail'
import type { SpeciesDetail } from '../types/species'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function createDetail(canonicalName: string, commonName: string | null = null) {
  return {
    canonical_name: canonicalName,
    locked: false,
	    common_name: commonName,
	    uses: [],
	  } as unknown as SpeciesDetail
	}

describe('plant detail controller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('loads detail and locale common names for the current target', async () => {
    const loadDetail = vi.fn().mockResolvedValue(createDetail('Lavandula angustifolia', 'Lavender'))
    const loadLocaleCommonNames = vi.fn().mockResolvedValue([{ name: 'Lavande', locale: 'fr' }])
    const controller = createPlantDetailController({ loadDetail, loadLocaleCommonNames })

    controller.setTarget('Lavandula angustifolia', 'fr')
    await flushMicrotasks()

    expect(loadDetail).toHaveBeenCalledWith('Lavandula angustifolia', 'fr')
    expect(loadLocaleCommonNames).toHaveBeenCalledWith('Lavandula angustifolia', 'fr')
    expect(controller.loadState.value).toBe('loaded')
    expect(controller.detail.value?.canonical_name).toBe('Lavandula angustifolia')
    expect(controller.secondaryNames.value).toEqual([{ name: 'Lavande', locale: 'fr' }])
  })

  it('ignores stale detail responses after the target changes', async () => {
    const firstDetail = createDeferred<SpeciesDetail>()
    const secondDetail = createDeferred<SpeciesDetail>()
    const loadDetail = vi.fn()
      .mockReturnValueOnce(firstDetail.promise)
      .mockReturnValueOnce(secondDetail.promise)
    const loadLocaleCommonNames = vi.fn().mockResolvedValue([])
    const controller = createPlantDetailController({ loadDetail, loadLocaleCommonNames })

    controller.setTarget('Lavandula angustifolia', 'en')
    controller.setTarget('Thymus vulgaris', 'en')

    secondDetail.resolve(createDetail('Thymus vulgaris', 'Thyme'))
    await flushMicrotasks()
    expect(controller.detail.value?.canonical_name).toBe('Thymus vulgaris')

    firstDetail.resolve(createDetail('Lavandula angustifolia', 'Lavender'))
    await flushMicrotasks()
    expect(controller.detail.value?.canonical_name).toBe('Thymus vulgaris')
  })

  it('allows retry after an error and treats locale-common-name failure as optional', async () => {
    const loadDetail = vi.fn()
      .mockRejectedValueOnce(new Error('detail failed'))
      .mockResolvedValueOnce(createDetail('Lavandula angustifolia', 'Lavender'))
    const loadLocaleCommonNames = vi.fn()
      .mockRejectedValueOnce(new Error('names failed'))
      .mockResolvedValueOnce([{ name: 'Lavande', locale: 'fr' }])
    const controller = createPlantDetailController({ loadDetail, loadLocaleCommonNames })

    controller.setTarget('Lavandula angustifolia', 'fr')
    await flushMicrotasks()

    expect(controller.loadState.value).toBe('error')
    expect(controller.errorMessage.value).toContain('detail failed')

    controller.retry()
    await flushMicrotasks()

    expect(controller.loadState.value).toBe('loaded')
    expect(controller.detail.value?.canonical_name).toBe('Lavandula angustifolia')
    expect(controller.secondaryNames.value).toEqual([{ name: 'Lavande', locale: 'fr' }])
  })

  it('reloads when the locale changes for the same canonical name and ignores updates after disposal', async () => {
    const deferredDetail = createDeferred<SpeciesDetail>()
    const loadDetail = vi.fn()
      .mockResolvedValueOnce(createDetail('Lavandula angustifolia', 'Lavender'))
      .mockReturnValueOnce(deferredDetail.promise)
    const loadLocaleCommonNames = vi.fn()
      .mockResolvedValueOnce([{ name: 'Lavender', locale: 'en' }])
      .mockResolvedValueOnce([{ name: 'Lavande', locale: 'fr' }])
    const controller = createPlantDetailController({ loadDetail, loadLocaleCommonNames })

    controller.setTarget('Lavandula angustifolia', 'en')
    await flushMicrotasks()

    controller.setTarget('Lavandula angustifolia', 'fr')
    controller.dispose()
    deferredDetail.resolve(createDetail('Lavandula angustifolia', 'Lavande'))
    await flushMicrotasks()

    expect(loadDetail).toHaveBeenNthCalledWith(1, 'Lavandula angustifolia', 'en')
    expect(loadDetail).toHaveBeenNthCalledWith(2, 'Lavandula angustifolia', 'fr')
    expect(controller.detail.value).toBe(null)
  })

  it('publishes an English fallback name with the detail when the language has none', async () => {
    const loadDetail = vi.fn().mockResolvedValue(createDetail('Ribes nigrum', null))
    const resolveDisplayNames = vi.fn().mockResolvedValue({ names: { 'Ribes nigrum': 'Blackcurrant' }, englishFallbacks: ['Ribes nigrum'] })
    const loadHabits = vi.fn().mockResolvedValue({ 'Ribes nigrum': 'Shrub' })
    const controller = createPlantDetailController({
      loadDetail,
      loadLocaleCommonNames: vi.fn().mockResolvedValue([]),
      resolveDisplayNames,
      loadHabits,
    })

    controller.setTarget('Ribes nigrum', 'fr')
    await flushMicrotasks()
    await flushMicrotasks()

    expect(resolveDisplayNames).toHaveBeenCalledWith(['Ribes nigrum'], 'fr')
    expect(controller.loadState.value).toBe('loaded')
    expect(controller.englishName.value).toBe('Blackcurrant')
    expect(controller.habitKey.value).toBe('Shrub')
  })

  it('asks for no English fallback in English or when the language has a name', async () => {
    const resolveDisplayNames = vi.fn().mockResolvedValue({ names: {}, englishFallbacks: [] })
    const controller = createPlantDetailController({
      loadDetail: vi.fn()
        .mockResolvedValueOnce(createDetail('Ribes nigrum', null))
        .mockResolvedValueOnce(createDetail('Ribes nigrum', 'Cassissier')),
      loadLocaleCommonNames: vi.fn().mockResolvedValue([]),
      resolveDisplayNames,
      loadHabits: vi.fn().mockResolvedValue({}),
    })

    controller.setTarget('Ribes nigrum', 'en')
    await flushMicrotasks()
    controller.setTarget('Ribes nigrum', 'fr')
    await flushMicrotasks()

    expect(resolveDisplayNames).not.toHaveBeenCalled()
    expect(controller.englishName.value).toBeNull()
  })
})
