import type { PlantLabels } from '../../generated/contracts'
import { SETTINGS_PLANT_LABELS } from '../../generated/settings'
import { normalizeHexColor } from '../plant-colors'

/**
 * How plants are shown on the map ("Display on the map" in Plants in this
 * Design). Display never changes stored plant colours or symbols: it only
 * decides which colour, size, outline and label each plant is drawn with.
 */
export type PlantColorMode = 'species' | 'stratum' | 'one-color'
/** Plant labels: the one stored enum, shared by device settings, a Design's display and its saved views. */
export type PlantLabelMode = PlantLabels
/** The Design's stratum for a species, as Consortium assigns it. */
export type PlantDisplayStratum = 'emergent' | 'high' | 'medium' | 'low'
/** A stratum colour key: a stratum, or `none` for "No stratum yet". */
export type StratumColorKey = PlantDisplayStratum | 'none'
/** The user's colour for some strata (#RRGGBB); the others keep their default colour. */
export type StratumColors = { readonly [K in StratumColorKey]?: string }

export interface PlantDisplay {
  readonly colorBy: PlantColorMode
  /** #RRGGBB used for every plant in `one-color` mode. */
  readonly oneColor: string
  /** Multiplies the symbolic plant radius; 1 is the default size. */
  readonly symbolScale: number
  /** Draw the halo around each symbol. */
  readonly outline: boolean
  readonly labels: PlantLabelMode
  /** Colour by stratum: the user's colour for a whole stratum, over the defaults. */
  readonly stratumColors: StratumColors
  /** Consortium stratum per canonical name; absent means "No stratum yet". */
  readonly strata: ReadonlyMap<string, PlantDisplayStratum>
}

export const PLANT_COLOR_MODES: readonly PlantColorMode[] = ['species', 'stratum', 'one-color']
export const PLANT_LABEL_MODES: readonly PlantLabelMode[] = SETTINGS_PLANT_LABELS
export const PLANT_DISPLAY_STRATA: readonly PlantDisplayStratum[] = ['emergent', 'high', 'medium', 'low']
export const STRATUM_COLOR_KEYS: readonly StratumColorKey[] = [...PLANT_DISPLAY_STRATA, 'none']

/**
 * The smallest map scale (px per metre) at which automatic labels show:
 * codes are short, so they show from further out than names.
 */
export const PLANT_LABEL_MIN_SCALE: { readonly [K in Exclude<PlantLabelMode, 'none'>]: number } = {
  codes: 50,
  names: 100,
}

export const PLANT_SYMBOL_SCALE_MIN = 0.5
export const PLANT_SYMBOL_SCALE_MAX = 2

/**
 * Stratum colours, ordered by sunlight need from the sunniest layer down:
 * Okabe-Ito hues (Emergent gold, High bluish green, Mid blue, Low reddish
 * purple) plus a dark warm grey for species with no stratum yet. The grey
 * stays at least ΔE 15 from each hue with normal vision and under
 * protanopia, deuteranopia and tritanopia, and at least 3:1 against the PDF
 * paper and the light map (U48). They are plant data colours drawn
 * on the map, so they do not follow the UI theme.
 */
export const STRATUM_DISPLAY_COLORS: { readonly [K in PlantDisplayStratum]: string } = {
  emergent: '#E69F00',
  high: '#009E73',
  medium: '#0072B2',
  low: '#CC79A7',
}
export const NO_STRATUM_DISPLAY_COLOR = '#5E5A52'

export const DEFAULT_PLANT_DISPLAY: PlantDisplay = Object.freeze({
  colorBy: 'species',
  oneColor: '#27231D',
  symbolScale: 1,
  outline: true,
  labels: 'names',
  stratumColors: Object.freeze({}),
  strata: new Map<string, PlantDisplayStratum>(),
})

/** The colour a stratum (or `none`, "No stratum yet") is drawn with: the user's, else its default. */
export function stratumDisplayColor(key: StratumColorKey, display: Pick<PlantDisplay, 'stratumColors'>): string {
  return display.stratumColors[key] ?? defaultStratumColor(key)
}

function defaultStratumColor(key: StratumColorKey): string {
  return key === 'none' ? NO_STRATUM_DISPLAY_COLOR : STRATUM_DISPLAY_COLORS[key]
}

/** Valid overrides only (#RRGGBB for a known key), without the ones that match their default. */
export function normalizeStratumColors(value: unknown): StratumColors {
  const colors: { [K in StratumColorKey]?: string } = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze(colors)
  const stored = value as Record<string, unknown>
  for (const key of STRATUM_COLOR_KEYS) {
    const color = normalizeHexColor(stored[key] as string | undefined)
    if (color && color !== defaultStratumColor(key)) colors[key] = color
  }
  return Object.freeze(colors)
}

export function stratumColorsEqual(left: StratumColors, right: StratumColors): boolean {
  return STRATUM_COLOR_KEYS.every((key) => left[key] === right[key])
}

/** The colour a plant is drawn with: its stored colour, its stratum's, or the one colour. */
export function resolveDisplayedPlantColor(
  storedColor: string,
  canonicalName: string,
  display: PlantDisplay,
): string {
  if (display.colorBy === 'one-color') return display.oneColor
  if (display.colorBy === 'stratum') return stratumDisplayColor(display.strata.get(canonicalName) ?? 'none', display)
  return storedColor
}

export function clampPlantSymbolScale(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(PLANT_SYMBOL_SCALE_MAX, Math.max(PLANT_SYMBOL_SCALE_MIN, value))
}

/** The next mode for View › Labels (N): None, Codes, Names, then None again. */
export function nextPlantLabelMode(mode: PlantLabelMode): PlantLabelMode {
  return PLANT_LABEL_MODES[(PLANT_LABEL_MODES.indexOf(mode) + 1) % PLANT_LABEL_MODES.length]!
}

export function plantDisplaysEqual(left: PlantDisplay, right: PlantDisplay): boolean {
  if (
    left.colorBy !== right.colorBy
    || left.oneColor !== right.oneColor
    || left.symbolScale !== right.symbolScale
    || left.outline !== right.outline
    || left.labels !== right.labels
    || !stratumColorsEqual(left.stratumColors, right.stratumColors)
    || left.strata.size !== right.strata.size
  ) return false
  for (const [name, stratum] of left.strata) if (right.strata.get(name) !== stratum) return false
  return true
}

/** Normalizes untrusted values (a Design's stored display) to a valid display. */
export function normalizePlantDisplay(value: Partial<PlantDisplay>): PlantDisplay {
  return Object.freeze({
    colorBy: PLANT_COLOR_MODES.includes(value.colorBy as PlantColorMode)
      ? value.colorBy as PlantColorMode
      : DEFAULT_PLANT_DISPLAY.colorBy,
    oneColor: normalizeHexColor(value.oneColor) ?? DEFAULT_PLANT_DISPLAY.oneColor,
    symbolScale: typeof value.symbolScale === 'number'
      ? clampPlantSymbolScale(value.symbolScale)
      : DEFAULT_PLANT_DISPLAY.symbolScale,
    outline: typeof value.outline === 'boolean' ? value.outline : DEFAULT_PLANT_DISPLAY.outline,
    labels: PLANT_LABEL_MODES.includes(value.labels as PlantLabelMode)
      ? value.labels as PlantLabelMode
      : DEFAULT_PLANT_DISPLAY.labels,
    stratumColors: normalizeStratumColors(value.stratumColors),
    strata: value.strata ?? DEFAULT_PLANT_DISPLAY.strata,
  })
}
