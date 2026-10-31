import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeCanopiDesign } from '../app/contracts/design-ingestion'
import { encodeCanopiDesign } from '../app/contracts/canopi-design-wire'
import { composeDocumentForSave } from '../app/contracts/document'
import {
  readPlantDisplayOptions,
  resetStratumDisplayColors,
  setPlantDisplayOptions,
  setStratumDisplayColor,
} from '../app/design-edit/plant-display'
import { currentDesign, designSessionStore } from '../app/document-session/store'
import { cyclePlantLabels } from '../app/plant-display/actions'
import { currentPlantDisplay, designStrata } from '../app/plant-display/state'
import { createAppCanvasRuntimeAppAdapter } from '../app/canvas-runtime/app-adapter'
import { readWorkspaceBackgroundPresentation } from '../app/canvas-map-surface/workspace-activation-snapshot'
import { createDefaultMapLayers, mapLayers } from '../app/map-layers/state'
import {
  buildPlantPresentationEntries,
  hitTestPlant,
  resolvePlantBaseColor,
  resolvePlantDisplayColor,
} from '../canvas/runtime/plant-presentation'
import {
  DEFAULT_PLANT_DISPLAY,
  NO_STRATUM_DISPLAY_COLOR,
  PLANT_LABEL_MODES,
  STRATUM_DISPLAY_COLORS,
  nextPlantLabelMode,
  normalizePlantDisplay,
  plantDisplaysEqual,
  stratumDisplayColor,
  resolveDisplayedPlantColor,
  setCanvasPlantDisplay,
  type PlantDisplay,
} from '../canvas/runtime/plant-display'
import { getPlantSymbolEdgeWidth } from '../canvas/runtime/scene-visuals'
import { buildCanvasPrintSnapshot } from '../canvas/runtime/print-snapshot'
import { contrastRatio } from '../canvas/plant-colors'
import type { ScenePlantEntity } from '../canvas/runtime/scene'
import type { CanopiFile } from '../types/design'
import { SETTINGS_PLANT_LABELS } from '../generated/settings'
import { designSessionFixture, replaceCurrentDesignState } from './support/design-session-state'

function design(overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: 9,
    name: 'Display',
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    plant_species_codes: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    views: [],
    stories: [],
    created_at: '2026-09-27T00:00:00Z',
    updated_at: '2026-09-27T00:00:00Z',
    extra: {},
    ...overrides,
  }
}

function plant(id: string, canonicalName: string, x: number, color: string | null = '#3E8E4E'): ScenePlantEntity {
  return {
    kind: 'plant',
    id,
    locked: false,
    canonicalName,
    commonName: null,
    color,
    canopySpreadM: null,
    position: { x, y: 0 },
    rotationDeg: null,
    notes: null,
    plantedDate: null,
    quantity: 1,
  }
}

const consortium = (canonicalName: string, stratum: string) => ({
  target: { kind: 'species' as const, canonical_name: canonicalName },
  stratum,
  start_phase: 0,
  end_phase: 2,
})

afterEach(() => {
  setCanvasPlantDisplay(DEFAULT_PLANT_DISPLAY)
  designSessionFixture.file = null
  // A display change dirties the Design; the next test opens its own clean one.
  designSessionStore.clearCurrentDesign()
  mapLayers.value = createDefaultMapLayers()
})

describe('plant display rules', () => {
  it('draws the stored colour, the Consortium stratum colour or the one colour', () => {
    const display = normalizePlantDisplay({
      strata: new Map([['Malus domestica', 'high'], ['Mentha spicata', 'low']]),
    })
    expect(resolveDisplayedPlantColor('#3E8E4E', 'Malus domestica', display)).toBe('#3E8E4E')
    const stratum = { ...display, colorBy: 'stratum' as const }
    expect(resolveDisplayedPlantColor('#3E8E4E', 'Malus domestica', stratum)).toBe(STRATUM_DISPLAY_COLORS.high)
    expect(resolveDisplayedPlantColor('#3E8E4E', 'Mentha spicata', stratum)).toBe(STRATUM_DISPLAY_COLORS.low)
    expect(resolveDisplayedPlantColor('#3E8E4E', 'Rubus idaeus', stratum)).toBe(NO_STRATUM_DISPLAY_COLOR)
    const one = { ...display, colorBy: 'one-color' as const, oneColor: '#AA3355' }
    expect(resolveDisplayedPlantColor('#3E8E4E', 'Malus domestica', one)).toBe('#AA3355')
  })

  it('recolours a whole stratum, or No stratum yet, over the default stratum colours', () => {
    const display = normalizePlantDisplay({
      colorBy: 'stratum',
      strata: new Map([['Malus domestica', 'high'], ['Mentha spicata', 'low']]),
      stratumColors: { high: '#112233', none: '#445566' },
    })
    expect(resolveDisplayedPlantColor('#3E8E4E', 'Malus domestica', display)).toBe('#112233')
    expect(resolveDisplayedPlantColor('#3E8E4E', 'Mentha spicata', display)).toBe(STRATUM_DISPLAY_COLORS.low)
    expect(resolveDisplayedPlantColor('#3E8E4E', 'Rubus idaeus', display)).toBe('#445566')
    expect(stratumDisplayColor('high', display)).toBe('#112233')
    expect(stratumDisplayColor('emergent', display)).toBe(STRATUM_DISPLAY_COLORS.emergent)
    // Only while colouring by stratum: species colours stay as stored otherwise.
    expect(resolveDisplayedPlantColor('#3E8E4E', 'Malus domestica', { ...display, colorBy: 'species' })).toBe('#3E8E4E')
    expect(normalizePlantDisplay({ stratumColors: { high: 'teal', canopy: '#112233' } as never }).stratumColors).toEqual({})
    expect(plantDisplaysEqual(display, { ...display, stratumColors: { high: '#112233' } })).toBe(false)
  })

  it('keeps the stratum colours apart from each other and from the no-stratum grey', () => {
    const colors = [...Object.values(STRATUM_DISPLAY_COLORS), NO_STRATUM_DISPLAY_COLOR]
    expect(new Set(colors).size).toBe(5)
    // Each colour stays visible on the light paper the softened background shows.
    for (const color of colors) expect(contrastRatio(color, '#F3EFE4')).toBeGreaterThan(1.8)
  })

  it('orders the stratum defaults by sunlight need, with a grey no hue is mistaken for', () => {
    // Sunniest first: Emergent gold, High bluish green, Mid blue, Low reddish purple (Okabe-Ito).
    expect(Object.entries(STRATUM_DISPLAY_COLORS)).toEqual([
      ['emergent', '#E69F00'],
      ['high', '#009E73'],
      ['medium', '#0072B2'],
      ['low', '#CC79A7'],
    ])
    // Not the old #8C8577, which matched High's green under deuteranopia (U48).
    expect(NO_STRATUM_DISPLAY_COLOR).toBe('#5E5A52')
    // The grey reads as a graphic object (WCAG 1.4.11) on the PDF paper and the light map.
    expect(contrastRatio(NO_STRATUM_DISPLAY_COLOR, '#ffffff')).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(NO_STRATUM_DISPLAY_COLOR, '#F3EFE4')).toBeGreaterThanOrEqual(3)
  })

  it('keeps a stored stratum colour over the new defaults, even the old default', () => {
    const display = readPlantDisplayOptions(design({
      extra: { plant_display: { color_by: 'stratum', stratum_colors: { emergent: '#0072B2', none: '#8C8577' } } },
    }))
    expect(stratumDisplayColor('emergent', display)).toBe('#0072B2')
    expect(stratumDisplayColor('none', display)).toBe('#8C8577')
    expect(stratumDisplayColor('medium', display)).toBe('#0072B2')
  })

  it('cycles labels None, Codes, Names and repairs invalid display values', () => {
    expect(nextPlantLabelMode('none')).toBe('codes')
    expect(nextPlantLabelMode('codes')).toBe('names')
    expect(nextPlantLabelMode('names')).toBe('none')
    expect(normalizePlantDisplay({ colorBy: 'rainbow' as never, oneColor: 'red', symbolScale: 9, labels: 'all' as never }))
      .toMatchObject({ colorBy: 'species', oneColor: DEFAULT_PLANT_DISPLAY.oneColor, symbolScale: 2, labels: 'names' })
  })

  it('reads labels from the one stored enum that settings, Display on the map and saved views share', () => {
    expect(PLANT_LABEL_MODES).toBe(SETTINGS_PLANT_LABELS)
  })

  it('draws, hit tests and prints with the display colour and size, never changing stored colours', () => {
    const plants = [plant('a', 'Malus domestica', 0), plant('b', 'Mentha spicata', 40)]
    const context = { plants, pixelsPerMetre: 20, speciesCache: new Map() }
    const before = buildPlantPresentationEntries(plants, context, new Set())
    // The scaled symbol's hit radius: its drawn radius plus the 4 px padding.
    const scaledHitMetres = (before[0]!.radiusScreenPx * 1.5 + 4) / context.pixelsPerMetre
    const hitsAt = (distance: number) => hitTestPlant(
      plants[0]!,
      { x: plants[0]!.position.x + distance, y: plants[0]!.position.y },
      context,
    )
    expect(hitsAt(scaledHitMetres * 0.999)).toBe(false)

    const display: PlantDisplay = normalizePlantDisplay({
      colorBy: 'stratum',
      symbolScale: 1.5,
      strata: new Map([['Malus domestica', 'emergent']]),
    })
    expect(setCanvasPlantDisplay(display)).toBe(true)
    expect(setCanvasPlantDisplay(normalizePlantDisplay({ ...display, strata: new Map(display.strata) }))).toBe(false)
    const after = buildPlantPresentationEntries(plants, context, new Set())
    expect(after.map((entry) => entry.color)).toEqual([STRATUM_DISPLAY_COLORS.emergent, NO_STRATUM_DISPLAY_COLOR])
    expect(plants.map((entry) => resolvePlantBaseColor(entry, new Map()))).toEqual(['#3E8E4E', '#3E8E4E'])
    expect(after[0]!.radiusScreenPx).toBeCloseTo(before[0]!.radiusScreenPx * 1.5)
    expect(hitsAt(scaledHitMetres * 0.999)).toBe(true)
    expect(hitsAt(scaledHitMetres * 1.001)).toBe(false)
    expect(plants.every((entry) => entry.color === '#3E8E4E')).toBe(true)
    expect(resolvePlantDisplayColor(plants[1]!, new Map())).toBe(NO_STRATUM_DISPLAY_COLOR)

    const print = buildCanvasPrintSnapshot({
      plantSpeciesColors: {}, plantSpeciesSymbols: {}, plantSpeciesCodes: {}, layers: [], plants,
      zones: [], annotations: [], measurementGuides: [], groups: [],
    }, context)
    expect(print.plants.map((entry) => entry.color)).toEqual([STRATUM_DISPLAY_COLORS.emergent, NO_STRATUM_DISPLAY_COLOR])
  })

  it('drops the symbol halo when Outline is off', () => {
    expect(getPlantSymbolEdgeWidth(20)).toBeGreaterThan(0)
    setCanvasPlantDisplay({ ...DEFAULT_PLANT_DISPLAY, outline: false })
    expect(getPlantSymbolEdgeWidth(20)).toBe(0)
  })
})

describe('plant display as Design data', () => {
  it('stores changed options in extra.plant_display, dirties the Design and round-trips through the file', () => {
    replaceCurrentDesignState(design(), null, 'Display')
    expect(designSessionStore.designDirty.value).toBe(false)

    setPlantDisplayOptions({ colorBy: 'one-color', oneColor: '#aa3355', labels: 'codes', symbolScale: 1.3, outline: false })
    expect(designSessionStore.designDirty.value).toBe(true)
    expect(currentDesign.value?.extra?.plant_display).toEqual({
      color_by: 'one_color', one_color: '#AA3355', symbol_scale: 1.3, outline: false, labels: 'codes',
    })

    const saved = composeDocumentForSave({
      metadata: { name: 'Display', description: null },
      document: currentDesign.value!,
      canvas: design(),
    } as never)
    const wire = encodeCanopiDesign(saved)
    expect(wire.plant_display).toMatchObject({ color_by: 'one_color' })
    expect(readPlantDisplayOptions(decodeCanopiDesign(wire))).toEqual({
      colorBy: 'one-color', oneColor: '#AA3355', symbolScale: 1.3, outline: false, labels: 'codes', stratumColors: {},
    })
  })

  it('leaves the Design untouched when nothing changes and drops the key at the defaults', () => {
    replaceCurrentDesignState(design(), null, 'Display')
    const before = currentDesign.value
    setPlantDisplayOptions({ labels: 'names', colorBy: 'species' })
    expect(currentDesign.value).toBe(before)

    setPlantDisplayOptions({ labels: 'none' })
    setPlantDisplayOptions({ labels: 'names' })
    expect(currentDesign.value?.extra).not.toHaveProperty('plant_display')
  })

  it('stores a stratum colour with the display, never touching stored species colours', () => {
    replaceCurrentDesignState(design({ plant_species_colors: { 'Malus domestica': '#3E8E4E' } }), null, 'Display')

    setStratumDisplayColor('high', '#112233')
    setStratumDisplayColor('none', '#445566')
    expect(currentDesign.value?.extra?.plant_display).toMatchObject({ stratum_colors: { high: '#112233', none: '#445566' } })
    expect(currentPlantDisplay.value.stratumColors).toEqual({ high: '#112233', none: '#445566' })
    expect(currentDesign.value?.plant_species_colors).toEqual({ 'Malus domestica': '#3E8E4E' })

    // Its default colour again, or a reset, drops the override; no overrides leave the key out.
    setStratumDisplayColor('high', STRATUM_DISPLAY_COLORS.high)
    expect(currentPlantDisplay.value.stratumColors).toEqual({ none: '#445566' })
    resetStratumDisplayColors()
    expect(currentDesign.value?.extra).not.toHaveProperty('plant_display')
  })

  it('reads invalid stored options as defaults', () => {
    expect(readPlantDisplayOptions(design({ extra: { plant_display: 'loud' } }))).toMatchObject({ colorBy: 'species', labels: 'names' })
    expect(readPlantDisplayOptions(design({
      extra: { plant_display: { color_by: 'stratum', one_color: 'nope', symbol_scale: 40, outline: 'yes', labels: 'codes' } },
    }))).toEqual({ colorBy: 'stratum', oneColor: DEFAULT_PLANT_DISPLAY.oneColor, symbolScale: 2, outline: true, labels: 'codes', stratumColors: {} })
  })

  it('cycles labels from the Design value', () => {
    replaceCurrentDesignState(design(), null, 'Display')
    cyclePlantLabels()
    expect(currentPlantDisplay.value.labels).toBe('none')
    cyclePlantLabels()
    expect(currentPlantDisplay.value.labels).toBe('codes')
  })

  it('colours by the Design Consortium strata, not catalog data', () => {
    const file = design({
      consortiums: [
        consortium('Malus domestica', 'high'),
        consortium('Mentha spicata', 'unassigned'),
        consortium('Juglans regia', 'emergent'),
      ],
    })
    expect([...designStrata(file)]).toEqual([['Malus domestica', 'high'], ['Juglans regia', 'emergent']])
    replaceCurrentDesignState(file, null, 'Display')
    expect(currentPlantDisplay.value.strata.get('Mentha spicata')).toBeUndefined()
  })

  it('hands the runtime every display change through the app adapter', () => {
    replaceCurrentDesignState(design(), null, 'Display')
    const adapter = createAppCanvasRuntimeAppAdapter({ presentationData: {} })
    const onDisplay = vi.fn()
    const dispose = adapter.plantDisplay!.subscribe(onDisplay)
    expect(onDisplay).toHaveBeenLastCalledWith(expect.objectContaining({ labels: 'names' }))
    setPlantDisplayOptions({ colorBy: 'stratum' })
    expect(onDisplay).toHaveBeenLastCalledWith(expect.objectContaining({ colorBy: 'stratum' }))
    dispose()
  })
})

describe('soften background', () => {
  it('dims the Basemap or Satellite band and makes labels read on paper', () => {
    const base = createDefaultMapLayers()
    const satellite = { ...base, satellite: { visible: true, opacity: 1 } }
    expect(readWorkspaceBackgroundPresentation({ readMapLayers: () => satellite }).satellite.opacity).toBe(1)
    const softened = { ...satellite, softenBackground: true }
    const presentation = readWorkspaceBackgroundPresentation({ readMapLayers: () => softened })
    expect(presentation.satellite.opacity).toBeCloseTo(0.4)
    expect(readWorkspaceBackgroundPresentation({ readMapLayers: () => ({ ...base, softenBackground: true }) }).basemap.opacity)
      .toBeCloseTo(0.4)

    const adapter = createAppCanvasRuntimeAppAdapter({ presentationData: {} })
    const onBackdrop = vi.fn()
    mapLayers.value = satellite
    const dispose = adapter.settings.subscribeMapBackdrop(onBackdrop)
    expect(onBackdrop).toHaveBeenLastCalledWith('satellite')
    mapLayers.value = softened
    expect(onBackdrop).toHaveBeenLastCalledWith('paper')
    dispose()
  })
})
