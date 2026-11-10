// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LidarDisplayDescriptor } from '../ipc/lidar'
import type { LidarPresentationItem } from '../app/lidar/library-store'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
const requestCutOutlierRange = vi.fn()
const cutRanges = new Map<string, readonly [number, number]>()
vi.mock('../app/lidar/display-range', () => ({
  requestCutOutlierRange: (...args: unknown[]) => requestCutOutlierRange(...args),
  cutOutlierRange: (key: string) => cutRanges.get(key) ?? null,
  resetCutOutlierRanges: () => cutRanges.clear(),
}))

const display = await import('../app/lidar/display')
const { lidarLibrary } = await import('../app/lidar/library-store')
const { setStoryPresentationOverrides } = await import('../app/story-presentation/overrides')
const { designSessionFixture } = await import('./support/design-session-state')
const { createDefaultMapLayers } = await import('../app/map-layers/state')
const { librarySnapshot, sourceItem } = await import('./support/library-fixtures')

function item(overrides: Partial<LidarPresentationItem> = {}): LidarPresentationItem {
  return {
    kind: 'Source',
    id: 'lyr-1',
    name: 'Orchard terrain',
    availability: 'present',
    itemType: { kind: 'Raster', quantity: 'GroundElevation' },
    units: 'm',
    state: 'Ready',
    visible: true,
    shown: true,
    opacity: 0.8,
    order: 0,
    ramp: null,
    reversed: false,
    range: null,
    bounds: [0, 0, 1, 1],
    generationId: 'gen-2',
    displayRange: [104, 132],
    freshness: { state: 'Current' },
    definitionId: null,
    analysisId: null,
    outputKey: null,
    run: null,
    inputId: null,
    parentId: null,
    depth: 0,
    ...overrides,
  }
}

function descriptor(overrides: Partial<LidarDisplayDescriptor> = {}): LidarDisplayDescriptor {
  return {
    kind: 'Source',
    entity_id: 'lyr-1',
    generation_id: 'gen-2',
    profile: 'display-cog-3857-v2',
    relief: false,
    state: 'Ready',
    message: null,
    assets: [
      { path: '/data/lidar/display-cog/asset-top.tif', bounds: [0, 0, 0.6, 1] },
      { path: '/data/lidar/display-cog/asset under.tif', bounds: [0.4, -0.1, 1, 1] },
    ],
    prepared_assets: 2,
    total_assets: 2,
    ...overrides,
  }
}

describe('LiDAR display projection', () => {
  it('keys a descriptor by its derivative too, so relief and elevation never share one', () => {
    expect(display.displayKey('Source', 'lyr-1', 'gen-2', 'relief')).not.toBe(display.displayKey('Source', 'lyr-1', 'gen-2', 'elevation'))
    expect(display.displayKey('Source', 'lyr-1', 'gen-2', 'elevation')).not.toBe(display.displayKey('Derived', 'lyr-1', 'gen-2', 'elevation'))
  })

  it('draws a ready generation in Colours from its ordered asset URLs with one layer-wide stretch', () => {
    const descriptors = new Map([[display.displayKey('Source', 'lyr-1', 'gen-2', 'elevation'), descriptor()]])
    const [layer] = display.lidarDisplayLayers([item({ ramp: 'Terrain' })], descriptors, null, (path) => `asset://localhost/${encodeURIComponent(path)}`)
    expect(layer).toEqual({
      id: 'lidar-source-lyr-1-gen-2',
      name: 'Orchard terrain',
      assets: [
        { url: 'asset://localhost/%2Fdata%2Flidar%2Fdisplay-cog%2Fasset-top.tif', bbox: [0, 0, 0.6, 1] },
        { url: 'asset://localhost/%2Fdata%2Flidar%2Fdisplay-cog%2Fasset%20under.tif', bbox: [0.4, -0.1, 1, 1] },
      ],
      bounds: [0, -0.1, 1, 1],
      opacity: 0.8,
      rescale: [104, 132],
      colormap: 'schwarzwald',
      reversed: false,
    })
  })

  it('draws nothing for hidden, unavailable, preparing or other-generation references', () => {
    const ready = descriptor()
    const descriptors = new Map([
      [display.displayKey('Source', 'lyr-1', 'gen-2', 'elevation'), ready],
      [display.displayKey('Source', 'lyr-3', 'gen-9', 'elevation'), descriptor({ entity_id: 'lyr-3', generation_id: 'gen-9', state: 'Preparing' })],
    ])
    expect(display.lidarDisplayLayers([
      item({ visible: false, shown: false }),
      item({ shown: false }),
      item({ id: 'lyr-2', availability: 'not-in-library', state: null }),
      item({ id: 'lyr-3', generationId: 'gen-9' }),
      item({ generationId: 'gen-3' }),
    ], descriptors, null)).toEqual([])
  })

  it('draws what a presented story step shows, whatever the Design stores', () => {
    const descriptors = new Map([
      [display.displayKey('Source', 'lyr-1', 'gen-2', 'elevation'), descriptor()],
      [display.displayKey('Source', 'lyr-2', 'gen-2', 'elevation'), descriptor({ entity_id: 'lyr-2' })],
    ])
    const items = [item({ ramp: 'Terrain', visible: false, shown: false }), item({ id: 'lyr-2', ramp: 'Terrain' })]
    const drawn = (presented: ReadonlySet<string> | null) =>
      display.lidarDisplayLayers(items, descriptors, presented, (path) => path).map((layer) => layer.id)

    expect(drawn(null)).toEqual(['lidar-source-lyr-2-gen-2'])
    expect(drawn(new Set(['lyr-1']))).toEqual(['lidar-source-lyr-1-gen-2'])
    expect(drawn(new Set())).toEqual([])
  })

  it('styles each reference by its item type, its own units and its own display, and a missing one not at all', () => {
    const slope = { kind: 'Derived' as const, itemType: { kind: 'Raster' as const, quantity: 'Slope' as const } }
    expect(display.lidarDisplayStyle(item({ ...slope, units: '%' })))
      .toMatchObject({ colormap: 'ylorrd', reversed: false, rescale: [0, 57.7], units: '%' })
    expect(display.lidarDisplayStyle(item({ ramp: 'Earth', reversed: true, range: { mode: 'Custom', min: 110, max: 120 } })))
      .toMatchObject({ ramp: 'Earth', colormap: 'turbid', reversed: true, rescale: [110, 120] })
    expect(display.lidarDisplayStyle(item({ itemType: null, availability: 'not-in-library', state: null, units: '' }))).toBeNull()
  })

  /** An elevation descriptor beside its relief one, as the library answers each variant. */
  function bothVariants(): Map<string, LidarDisplayDescriptor> {
    return new Map([
      [display.displayKey('Source', 'lyr-1', 'gen-2', 'elevation'), descriptor()],
      [display.displayKey('Source', 'lyr-1', 'gen-2', 'relief'), descriptor({
        relief: true,
        assets: [{ path: '/data/lidar/display-cog/asset-top-relief.tif', bounds: [0, 0, 0.6, 1] }],
        prepared_assets: 1,
        total_assets: 1,
      })],
    ])
  }

  it('draws an MNT, MNS or MNH at its default ramp in gray over 0–255 from its relief derivative', () => {
    for (const quantity of ['GroundElevation', 'SurfaceElevation', 'AboveGroundHeight'] as const) {
      const [layer] = display.lidarDisplayLayers([item({ itemType: { kind: 'Raster', quantity } })], bothVariants(), null, (path) => path)
      expect(layer).toMatchObject({
        id: 'lidar-source-lyr-1-gen-2-relief',
        assets: [{ url: '/data/lidar/display-cog/asset-top-relief.tif', bbox: [0, 0, 0.6, 1] }],
        colormap: 'gray',
        reversed: false,
        rescale: [0, 255],
      })
    }
  })

  it('draws an entry switched to Terrain from its elevation derivative', () => {
    const [layer] = display.lidarDisplayLayers([item({ ramp: 'Terrain' })], bothVariants(), null, (path) => path)
    expect(layer).toMatchObject({ id: 'lidar-source-lyr-1-gen-2', colormap: 'schwarzwald', rescale: [104, 132] })
    expect(layer!.assets.map((asset) => asset.url)).toEqual(['/data/lidar/display-cog/asset-top.tif', '/data/lidar/display-cog/asset under.tif'])
  })

  it('names a derived layer as a result, keyed by its role', () => {
    const derived = item({ kind: 'Derived', id: 'slope-1', itemType: { kind: 'Raster', quantity: 'Slope' }, units: '°' })
    const descriptors = new Map([[display.displayKey('Derived', 'slope-1', 'gen-2', 'elevation'), descriptor({ kind: 'Derived', entity_id: 'slope-1' })]])
    const [layer] = display.lidarDisplayLayers([derived], descriptors, null, (path) => path)
    expect(layer).toMatchObject({ id: 'lidar-result-slope-1-gen-2', colormap: 'ylorrd', reversed: false, rescale: [0, 30] })
  })
})

describe('LiDAR display descriptor requests', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    invoke.mockReset()
    display.disposeLidarDisplayDescriptors()
    display.lidarDisplayDescriptors.value = new Map()
  })
  afterEach(() => {
    display.disposeLidarDisplayDescriptors()
    vi.useRealTimers()
  })

  it('polls a preparing generation until its derivatives are ready, then stops asking', async () => {
    invoke
      .mockResolvedValueOnce(descriptor({ state: 'Preparing', assets: [], prepared_assets: 1 }))
      .mockResolvedValueOnce(descriptor())
    display.requestLidarDisplay('Source', 'lyr-1', 'gen-2', 'elevation')
    await vi.advanceTimersByTimeAsync(0)
    expect(display.readLidarDisplay('Source', 'lyr-1', 'gen-2', 'elevation')?.state).toBe('Preparing')
    await vi.advanceTimersByTimeAsync(800)
    expect(display.readLidarDisplay('Source', 'lyr-1', 'gen-2', 'elevation')?.state).toBe('Ready')
    display.requestLidarDisplay('Source', 'lyr-1', 'gen-2', 'elevation')
    await vi.advanceTimersByTimeAsync(5000)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledWith('lidar_display_descriptor', {
      request: { kind: 'Source', entity_id: 'lyr-1', expected_generation_id: 'gen-2', retry: false, relief: false },
    })
  })

  // canopi-f47t.51: the story override reached the map but not the
  // descriptor requests, so a step showing an entry hidden in the Design drew
  // nothing unless its descriptor was cached earlier.
  it('requests the descriptor of an entry a presented story step shows while the Design hides it', async () => {
    invoke.mockResolvedValue(descriptor())
    lidarLibrary.value = librarySnapshot([sourceItem('lyr-1', 'Orchard terrain', { generation_id: 'gen-2' })])
    designSessionFixture.file = {
      version: 9, name: 'Orchard', description: null,
      plant_species_colors: {}, plant_species_symbols: {}, plant_species_codes: {},
      layers: [], plants: [], zones: [], annotations: [], measurement_guides: [],
      consortiums: [], groups: [], timeline: [], budget: [], budget_currency: 'EUR',
      lidar: { visible: true, entries: [
        { kind: 'Source', id: 'lyr-1', name: 'Orchard terrain', visible: false, opacity: 1, order: 0, ramp: null, reversed: false, range: null },
      ] },
      created_at: '', updated_at: '', extra: {},
    }
    try {
      display.installLidarDisplayDescriptors()
      await vi.advanceTimersByTimeAsync(0)
      expect(invoke).not.toHaveBeenCalled()

      setStoryPresentationOverrides({
        mapLayers: createDefaultMapLayers(), siteDataIds: new Set(['lyr-1']), plantLabels: 'names', targets: [],
      })
      await vi.advanceTimersByTimeAsync(0)
      // The ground elevation draws Relief, its default.
      expect(invoke).toHaveBeenCalledWith('lidar_display_descriptor', {
        request: { kind: 'Source', entity_id: 'lyr-1', expected_generation_id: 'gen-2', retry: false, relief: true },
      })
    } finally {
      setStoryPresentationOverrides(null)
      designSessionFixture.file = null
      lidarLibrary.value = null
    }
  })

  it('never stores a late answer after the owner is disposed', async () => {
    let answer!: (value: LidarDisplayDescriptor) => void
    invoke.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    display.requestLidarDisplay('Source', 'lyr-1', 'gen-2', 'elevation')
    display.disposeLidarDisplayDescriptors()
    answer(descriptor())
    await vi.advanceTimersByTimeAsync(0)
    expect(display.readLidarDisplay('Source', 'lyr-1', 'gen-2', 'elevation')).toBeNull()
  })

  it('reads Cut outliers\' range only for an entry set to it with a ready display, by generation, and draws it', async () => {
    requestCutOutlierRange.mockClear()
    invoke.mockImplementation(async (_command: string, args: { request: { entity_id: string, expected_generation_id: string } }) =>
      descriptor({ entity_id: args.request.entity_id, generation_id: args.request.expected_generation_id }))
    lidarLibrary.value = librarySnapshot([
      sourceItem('lyr-1', 'Orchard terrain', { generation_id: 'gen-2' }),
      sourceItem('lyr-2', 'Canopy', { generation_id: 'gen-5' }),
    ])
    const entry = (id: string, range: unknown) => ({ kind: 'Source', id, name: id, visible: true, opacity: 1, order: 0, ramp: 'Terrain', reversed: false, range })
    designSessionFixture.file = {
      version: 9, name: 'Orchard', description: null,
      plant_species_colors: {}, plant_species_symbols: {}, plant_species_codes: {},
      layers: [], plants: [], zones: [], annotations: [], measurement_guides: [],
      consortiums: [], groups: [], timeline: [], budget: [], budget_currency: 'EUR',
      lidar: { visible: true, entries: [entry('lyr-1', { mode: 'CutOutliers' }), entry('lyr-2', null)] as never },
      created_at: '', updated_at: '', extra: {},
    }
    try {
      display.installLidarDisplayDescriptors((path) => `served:${path}`)
      await vi.advanceTimersByTimeAsync(0)
      // requestCutOutlierRange reads a key once; the effect may ask again as descriptors land.
      expect([...new Set(requestCutOutlierRange.mock.calls.map((call) => JSON.stringify(call)))].map((call) => JSON.parse(call))).toEqual([[
        display.displayKey('Source', 'lyr-1', 'gen-2', 'elevation'),
        [
          { url: 'served:/data/lidar/display-cog/asset-top.tif', bbox: [0, 0, 0.6, 1] },
          { url: 'served:/data/lidar/display-cog/asset under.tif', bbox: [0.4, -0.1, 1, 1] },
        ],
      ]])
      cutRanges.set(display.displayKey('Source', 'lyr-1', 'gen-2', 'elevation'), [106, 129])
      expect(display.lidarDisplayStyle(item({ ramp: 'Terrain', range: { mode: 'CutOutliers' } }))?.rescale).toEqual([106, 129])
      expect(display.lidarDisplayStyle(item({ ramp: 'Terrain', range: { mode: 'CutOutliers' }, generationId: 'gen-3' }))?.rescale).toEqual([104, 132])
    } finally {
      display.disposeLidarDisplayDescriptors()
      invoke.mockReset()
      designSessionFixture.file = null
      lidarLibrary.value = null
    }
  })

  it('asks for the relief of an entry drawing Relief, and reads Cut outliers only from an elevation drawn in Colours', async () => {
    requestCutOutlierRange.mockClear()
    invoke.mockImplementation(async (_command: string, args: { request: { entity_id: string, expected_generation_id: string, relief?: boolean } }) =>
      descriptor({ entity_id: args.request.entity_id, generation_id: args.request.expected_generation_id, relief: args.request.relief ?? false }))
    lidarLibrary.value = librarySnapshot([
      sourceItem('lyr-1', 'Orchard terrain', { generation_id: 'gen-2' }),
      sourceItem('lyr-2', 'Canopy', { generation_id: 'gen-5' }),
    ])
    const entry = (id: string, ramp: unknown) => ({ kind: 'Source', id, name: id, visible: true, opacity: 1, order: 0, ramp, reversed: false, range: { mode: 'CutOutliers' } })
    designSessionFixture.file = {
      version: 9, name: 'Orchard', description: null,
      plant_species_colors: {}, plant_species_symbols: {}, plant_species_codes: {},
      layers: [], plants: [], zones: [], annotations: [], measurement_guides: [],
      consortiums: [], groups: [], timeline: [], budget: [], budget_currency: 'EUR',
      lidar: { visible: true, entries: [entry('lyr-1', null), entry('lyr-2', 'Terrain')] as never },
      created_at: '', updated_at: '', extra: {},
    }
    try {
      display.installLidarDisplayDescriptors((path) => `served:${path}`)
      await vi.advanceTimersByTimeAsync(0)
      const asked = invoke.mock.calls.map(([, args]) => (args as { request: { entity_id: string, relief?: boolean } }).request)
      expect(asked.find((request) => request.entity_id === 'lyr-1')?.relief).toBe(true)
      expect(new Set(requestCutOutlierRange.mock.calls.map(([key]) => key))).toEqual(new Set([display.displayKey('Source', 'lyr-2', 'gen-5', 'elevation')]))
    } finally {
      display.disposeLidarDisplayDescriptors()
      invoke.mockReset()
      designSessionFixture.file = null
      lidarLibrary.value = null
    }
  })

  it('a library preview of an MNT asks for its relief, the kind\'s default look', async () => {
    invoke.mockResolvedValue(descriptor({ relief: true }))
    const { h, render } = await import('preact')
    const { act } = await import('preact/test-utils')
    const { LibraryPreview } = await import('../components/panels/lidar/LibraryPreview')
    const { libraryItems } = await import('../app/lidar/library-items')
    const [preview] = libraryItems(librarySnapshot([sourceItem('lyr-1', 'Orchard terrain', { generation_id: 'gen-2' })]))
    const host = document.createElement('div')
    try {
      act(() => { render(h(LibraryPreview, { item: preview!, client: null, width: 64, height: 64 }), host) })
      await vi.advanceTimersByTimeAsync(0)
      expect(invoke).toHaveBeenCalledWith('lidar_display_descriptor', {
        request: { kind: 'Source', entity_id: 'lyr-1', expected_generation_id: 'gen-2', retry: false, relief: true },
      })
    } finally {
      render(null, host)
    }
  })

  // A hidden entry set to Cut outliers still shows its range in its fields and legend, and Custom starts from it.
  it('reads Cut outliers\' range of an entry the map hides, and only for that mode', async () => {
    requestCutOutlierRange.mockClear()
    invoke.mockImplementation(async (_command: string, args: { request: { entity_id: string, expected_generation_id: string } }) =>
      descriptor({ entity_id: args.request.entity_id, generation_id: args.request.expected_generation_id }))
    lidarLibrary.value = librarySnapshot([
      sourceItem('lyr-1', 'Orchard terrain', { generation_id: 'gen-2' }),
      sourceItem('lyr-2', 'Canopy', { generation_id: 'gen-5' }),
    ])
    const entry = (id: string, range: unknown) => ({ kind: 'Source', id, name: id, visible: false, opacity: 1, order: 0, ramp: 'Terrain', reversed: false, range })
    designSessionFixture.file = {
      version: 9, name: 'Orchard', description: null,
      plant_species_colors: {}, plant_species_symbols: {}, plant_species_codes: {},
      layers: [], plants: [], zones: [], annotations: [], measurement_guides: [],
      consortiums: [], groups: [], timeline: [], budget: [], budget_currency: 'EUR',
      lidar: { visible: true, entries: [entry('lyr-1', { mode: 'CutOutliers' }), entry('lyr-2', null)] as never },
      created_at: '', updated_at: '', extra: {},
    }
    try {
      display.installLidarDisplayDescriptors((path) => `served:${path}`)
      await vi.advanceTimersByTimeAsync(0)
      expect(invoke.mock.calls.map(([, args]) => (args as { request: { entity_id: string } }).request.entity_id)).toEqual(['lyr-1'])
      expect(requestCutOutlierRange).toHaveBeenCalledWith(display.displayKey('Source', 'lyr-1', 'gen-2', 'elevation'), expect.any(Array))
      expect(display.lidarDisplayLayers([item({ ramp: 'Terrain', visible: false, shown: false, range: { mode: 'CutOutliers' } })], display.lidarDisplayDescriptors.value, null)).toEqual([])
    } finally {
      display.disposeLidarDisplayDescriptors()
      invoke.mockReset()
      designSessionFixture.file = null
      lidarLibrary.value = null
    }
  })
})

describe('LiDAR display descriptor refusals', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    invoke.mockReset()
    display.disposeLidarDisplayDescriptors()
    display.lidarDisplayDescriptors.value = new Map()
    const { resetFrontendDiagnosticsForTests } = await import('../failures/ring')
    resetFrontendDiagnosticsForTests()
    const { resetFailureNoticesForTests } = await import('../failures/report')
    resetFailureNoticesForTests()
  })
  afterEach(() => {
    display.disposeLidarDisplayDescriptors()
    vi.useRealTimers()
  })

  const busy = new Error('Native user-data operations are busy; try again')

  // Until R13 reaches 0 the transport records every String-command rejection once, redacted, under the command's op
  // and with no notice (2.1-M409, 2.1-M433): a busy refusal is one such entry, never a Display failed.
  async function refusalRecord(): Promise<{ sources: string[], noticeCount: number }> {
    const { ringEntries } = await import('../failures/ring')
    const { failureNoticesForTests } = await import('../failures/report')
    return {
      sources: ringEntries().map((entry) => entry.source),
      noticeCount: failureNoticesForTests().notices.length,
    }
  }

  // A busy executor refused the call: that is no answer about the derivative, so it is asked again, and the
  // map and the preview that share the key draw it once the library answers.
  it('asks again after a refused call instead of keeping it as Display failed, and records a refusal that clears once with no notice', async () => {
    const { recentFrontendDiagnostics } = await import('../app/problem-report/diagnostics')
    invoke.mockRejectedValueOnce(busy).mockResolvedValueOnce(descriptor({ relief: true }))
    display.requestLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')
    await vi.advanceTimersByTimeAsync(0)
    expect(display.readLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')?.state).not.toBe('Failed')
    await vi.advanceTimersByTimeAsync(800)
    expect(display.readLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')?.state).toBe('Ready')
    expect(invoke).toHaveBeenCalledTimes(2)
    // The re-ask is no Retry of a failed preparation.
    expect(invoke).toHaveBeenLastCalledWith('lidar_display_descriptor', {
      request: { kind: 'Source', entity_id: 'lyr-1', expected_generation_id: 'gen-2', retry: false, relief: true },
    })
    expect(recentFrontendDiagnostics()).toEqual([
      expect.objectContaining({ source: 'ipc.lidar_display_descriptor', message: 'Native user-data operations are busy; try again' }),
    ])
    expect(await refusalRecord()).toEqual({ sources: ['ipc.lidar_display_descriptor'], noticeCount: 0 })
  })

  // The executor's busy text for each of its five classes, byte for byte as the Rust test
  // a_full_class_refuses_a_string_command_with_its_exact_busy_text pins it: Tauri rejects a String command with the
  // bare string, and the busy matcher stays until N1 and N2 type their commands (2.1-M41, canopi-f47t.52.35).
  it.each([
    'Native catalog operations are busy; try again',
    'Native user-data operations are busy; try again',
    'Native local operations are busy; try again',
    'Native network operations are busy; try again',
    'Native raster operations are busy; try again',
  ])('waits out the executor busy refusal %j and records it once with no notice (canopi-f47t.52.35)', async (text) => {
    const { recentFrontendDiagnostics } = await import('../app/problem-report/diagnostics')
    invoke.mockRejectedValueOnce(text).mockResolvedValueOnce(descriptor({ relief: true }))
    display.requestLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')
    await vi.advanceTimersByTimeAsync(0)
    expect(display.readLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')?.state).not.toBe('Failed')
    await vi.advanceTimersByTimeAsync(800)
    expect(display.readLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')?.state).toBe('Ready')
    expect(recentFrontendDiagnostics()).toEqual([
      expect.objectContaining({ source: 'ipc.lidar_display_descriptor', message: text }),
    ])
    expect(await refusalRecord()).toEqual({ sources: ['ipc.lidar_display_descriptor'], noticeCount: 0 })
  })

  it('shows Display failed for a call that keeps failing, records each failed call once and the shown one surfaced, keeps asking ever more slowly and clears on an answer', async () => {
    const { recentFrontendDiagnostics } = await import('../app/problem-report/diagnostics')
    invoke.mockRejectedValue(new Error('catalogue: database disk image is malformed'))
    display.requestLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(display.readLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')?.state).toBe('Failed')
    // Backing off: far fewer calls than one per poll.
    const calls = invoke.mock.calls.length
    expect(calls).toBeGreaterThan(2)
    expect(calls).toBeLessThan(10)
    // The page reads only Display failed; the reason is in diagnostics, each failed call recorded by the transport
    // (2.1-M409) and counted on one entry (canopi-vsey, 2.1-Q294), which the call that turned the row to Display
    // failed marked surfaced, never a second entry.
    expect(recentFrontendDiagnostics()).toEqual([expect.objectContaining({
      source: 'ipc.lidar_display_descriptor', message: 'catalogue: database disk image is malformed', count: calls })])
    const { ringEntries } = await import('../failures/ring')
    expect(ringEntries().map((entry) => entry.surfaced)).toEqual([true])
    expect((await refusalRecord()).noticeCount).toBe(0)
    // Effects asking again while it is failing never add a call outside the back-off.
    display.requestLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')
    expect(invoke.mock.calls.length).toBe(calls)
    invoke.mockReset()
    invoke.mockResolvedValue(descriptor({ relief: true }))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(display.readLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')?.state).toBe('Ready')
    expect(recentFrontendDiagnostics()).toEqual([expect.objectContaining({ count: calls })])
  })

  // A Data library mounts a preview for every ready row at once; the user-data executor admits 8 calls and runs 1.
  it('a library of forty ready previews asked at once never reads Display failed, records nothing and leaves the executor room', async () => {
    const { recentFrontendDiagnostics } = await import('../app/problem-report/diagnostics')
    let running = 0
    let peak = 0
    invoke.mockImplementation((_command: string, args: { request: { entity_id: string } }) => {
      if (running >= 8) return Promise.reject(busy)
      running += 1
      peak = Math.max(peak, running)
      return new Promise((resolve) => setTimeout(() => {
        running -= 1
        resolve(descriptor({ entity_id: args.request.entity_id, relief: true }))
      }, 40))
    })
    const ids = Array.from({ length: 40 }, (_, index) => `lyr-${index}`)
    for (const id of ids) display.requestLidarDisplay('Source', id, 'gen-2', 'relief')
    for (let elapsed = 0; elapsed < 30_000; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100)
      for (const id of ids) expect(display.readLidarDisplay('Source', id, 'gen-2', 'relief')?.state).not.toBe('Failed')
    }
    for (const id of ids) expect(display.readLidarDisplay('Source', id, 'gen-2', 'relief')?.state).toBe('Ready')
    expect(recentFrontendDiagnostics()).toEqual([])
    // A Rename or Delete on the same executor still finds an admission slot.
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('a busy executor is never Display failed and records each refusal once with no notice, however long it stays busy', async () => {
    const { recentFrontendDiagnostics } = await import('../app/problem-report/diagnostics')
    invoke.mockRejectedValue(busy)
    display.requestLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(display.readLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')?.state).not.toBe('Failed')
    const calls = invoke.mock.calls.length
    expect(recentFrontendDiagnostics()).toEqual([expect.objectContaining({
      source: 'ipc.lidar_display_descriptor', message: 'Native user-data operations are busy; try again', count: calls })])
    expect((await refusalRecord()).noticeCount).toBe(0)
    expect(calls).toBeGreaterThan(2)
    expect(calls).toBeLessThan(15)
  })

  it('stops asking a failing key once its last asker lets it go, and asks afresh when it is wanted again', async () => {
    invoke.mockRejectedValue(new Error('catalogue: database disk image is malformed'))
    const release = display.requestLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(display.readLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')?.state).toBe('Failed')
    release()
    const calls = invoke.mock.calls.length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(invoke.mock.calls.length).toBe(calls)
    // Wanted again (the preview reopens): no stale Display failed blocks a fresh ask.
    invoke.mockReset()
    invoke.mockResolvedValue(descriptor({ relief: true }))
    display.requestLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(display.readLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')?.state).toBe('Ready')
  })

  it('stops asking a failing entry once the map no longer draws it', async () => {
    invoke.mockRejectedValue(new Error('catalogue: database disk image is malformed'))
    lidarLibrary.value = librarySnapshot([sourceItem('lyr-1', 'Orchard terrain', { generation_id: 'gen-2' })])
    designSessionFixture.file = {
      version: 9, name: 'Orchard', description: null,
      plant_species_colors: {}, plant_species_symbols: {}, plant_species_codes: {},
      layers: [], plants: [], zones: [], annotations: [], measurement_guides: [],
      consortiums: [], groups: [], timeline: [], budget: [], budget_currency: 'EUR',
      lidar: { visible: true, entries: [
        { kind: 'Source', id: 'lyr-1', name: 'Orchard terrain', visible: false, opacity: 1, order: 0, ramp: null, reversed: false, range: null },
      ] },
      created_at: '', updated_at: '', extra: {},
    }
    try {
      display.installLidarDisplayDescriptors()
      setStoryPresentationOverrides({
        mapLayers: createDefaultMapLayers(), siteDataIds: new Set(['lyr-1']), plantLabels: 'names', targets: [],
      })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(invoke.mock.calls.length).toBeGreaterThan(1)
      // The story step ends: the Design hides the entry, so nothing draws it any more.
      setStoryPresentationOverrides(null)
      await vi.advanceTimersByTimeAsync(0)
      const calls = invoke.mock.calls.length
      await vi.advanceTimersByTimeAsync(300_000)
      expect(invoke.mock.calls.length).toBe(calls)
    } finally {
      setStoryPresentationOverrides(null)
      designSessionFixture.file = null
      lidarLibrary.value = null
    }
  })

  it('shows a failed preparation as Display failed once, without asking again', async () => {
    invoke.mockResolvedValue(descriptor({ state: 'Failed', message: 'relief failed', assets: [] }))
    display.requestLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')
    await vi.advanceTimersByTimeAsync(60_000)
    display.requestLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(display.readLidarDisplay('Source', 'lyr-1', 'gen-2', 'relief')?.state).toBe('Failed')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
