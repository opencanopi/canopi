// Behavioural unit tests for Desktop host adapters (open-failure, problem-report, species-catalog).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dialogMessageMock = vi.hoisted(() => vi.fn(async () => {}))
const createProblemReportMock = vi.hoisted(() => vi.fn(async () => ({ kind: 'written' as const, path: '/reports/r.zip' })))
const showProblemReportFolderMock = vi.hoisted(() => vi.fn(async () => {}))
const plantCatalogCauseMock = vi.hoisted(() => vi.fn<() => 'missing' | 'corrupt' | null>(() => null))
const searchSpeciesMock = vi.hoisted(() => vi.fn(async () => ({
  total: 0,
  results: [],
  filterCounts: {},
})))
const getDynamicFilterOptionsMock = vi.hoisted(() => vi.fn(async () => [{ field: 'family', values: ['Rosaceae'] }]))
const getFilterOptionsMock = vi.hoisted(() => vi.fn(async () => null))
const getCommonNamesMock = vi.hoisted(() => vi.fn(async (names: string[]) => Object.fromEntries(names.map((n) => [n, `Common ${n}`]))))
const getSpeciesHabitsMock = vi.hoisted(() => vi.fn(async (names: string[]) => Object.fromEntries(names.map((n) => [n, 'tree']))))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  message: dialogMessageMock,
}))

vi.mock('../../ipc/problem-report', () => ({
  createProblemReport: createProblemReportMock,
  showProblemReportFolder: showProblemReportFolderMock,
}))

vi.mock('../../failures/health', () => ({
  plantCatalogCause: plantCatalogCauseMock,
}))

vi.mock('../../ipc/species', () => ({
  searchSpecies: searchSpeciesMock,
  supersedeSpeciesSearch: vi.fn(async () => {}),
  getDynamicFilterOptions: getDynamicFilterOptionsMock,
  getFilterOptions: getFilterOptionsMock,
  getCommonNames: getCommonNamesMock,
  getSpeciesHabits: getSpeciesHabitsMock,
}))

vi.mock('../../ipc/favorites', () => ({
  getFavorites: vi.fn(async () => []),
  getRecentlyViewed: vi.fn(async () => []),
  toggleFavorite: vi.fn(async () => true),
}))

import { presentDesktopDesignOpenFailure } from './open-failure'
import { desktopProblemReport } from './problem-report'
import { speciesCatalogWorkbench } from './species-catalog'

describe('Desktop host adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    plantCatalogCauseMock.mockReturnValue(null)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('presents Design open failures via native error dialog', async () => {
    await presentDesktopDesignOpenFailure({
      tone: 'error',
      title: 'start.cantOpenTitle',
      message: 'start.cantRead',
    })
    expect(dialogMessageMock).toHaveBeenCalledOnce()
    expect(dialogMessageMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: 'error' }))
  })

  it('forwards only included non-design sections and optional design text to createProblemReport', async () => {
    await desktopProblemReport.write({
      entries: [
        { section: 'frontend_errors', status: 'included', text: 'err-log' },
        { section: 'ui_state', status: 'empty', text: null },
        { section: 'design', status: 'included', text: '{"name":"Orchard"}' },
      ],
    } as never)

    expect(createProblemReportMock).toHaveBeenCalledWith({
      sections: [{ id: 'frontend_errors', text: 'err-log' }],
      current_design: '{"name":"Orchard"}',
    })
  })

  it('gates Desktop species catalog queries on plant DB health and batches name/habit lookups', async () => {
    // Healthy DB: queries flow through and 501 names split into 2 IPC batches.
    const names = Array.from({ length: 501 }, (_, i) => `Species_${i}`)
    await speciesCatalogWorkbench.resolveCommonNames(names, 'en')
    await speciesCatalogWorkbench.resolveHabits(names)
    expect(getCommonNamesMock).toHaveBeenCalledTimes(2)
    expect(getSpeciesHabitsMock).toHaveBeenCalledTimes(2)

    await speciesCatalogWorkbench.loadFilterOptions()
    await speciesCatalogWorkbench.loadDynamicOptions(['family'])
    await speciesCatalogWorkbench.searchCloseMatches('Malus', 5)
    expect(getFilterOptionsMock).toHaveBeenCalled()
    expect(getDynamicFilterOptionsMock).toHaveBeenCalled()
    expect(searchSpeciesMock).toHaveBeenCalled()

    // Missing DB: short-circuits without IPC (names and search reject; habits and dynamic options answer empty).
    vi.clearAllMocks()
    plantCatalogCauseMock.mockReturnValue('missing')
    await expect(speciesCatalogWorkbench.resolveCommonNames(['Malus_domestica'], 'en')).rejects.toThrow(/unavailable/i)
    await expect(speciesCatalogWorkbench.resolveHabits(['Malus_domestica'])).resolves.toEqual({})
    await speciesCatalogWorkbench.loadDynamicOptions(['family'])
    await expect(speciesCatalogWorkbench.searchCloseMatches('Malus', 5)).rejects.toThrow(/unavailable/i)
    expect(getCommonNamesMock).not.toHaveBeenCalled()
    expect(getSpeciesHabitsMock).not.toHaveBeenCalled()
    expect(getDynamicFilterOptionsMock).not.toHaveBeenCalled()
    expect(searchSpeciesMock).not.toHaveBeenCalled()
  })
})
