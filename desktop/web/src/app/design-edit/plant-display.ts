import type { CanopiFile } from '../../types/design'
import {
  DEFAULT_PLANT_DISPLAY,
  PLANT_COLOR_MODES,
  PLANT_LABEL_MODES,
  clampPlantSymbolScale,
  normalizeStratumColors,
  stratumColorsEqual,
  type PlantColorMode,
  type PlantLabelMode,
  type StratumColorKey,
  type StratumColors,
} from '../../canvas/runtime/plant-display'
import { normalizeHexColor } from '../../canvas/plant-colors'
import { editCurrentDesign } from './core'
import { DESIGN_EDIT_EXTRA_KEYS, readExtra, reportExtraRepair, withExtra } from './extra-keys'

/**
 * Display on the map, as a Design stores it in `extra.plant_display`: how
 * this Design's plants are coloured, sized, outlined and labelled. It is
 * Design Edit data (continuous save, never undoable) and never changes a
 * stored plant colour. The key is absent while every option is the default.
 */
const PLANT_DISPLAY_EXTRA_KEY = DESIGN_EDIT_EXTRA_KEYS.plantDisplay

export interface PlantDisplayOptions {
  readonly colorBy: PlantColorMode
  readonly oneColor: string
  readonly symbolScale: number
  readonly outline: boolean
  readonly labels: PlantLabelMode
  /** Colour by stratum: the user's colour for whole strata. */
  readonly stratumColors: StratumColors
}

interface StoredPlantDisplay {
  color_by: 'species' | 'stratum' | 'one_color'
  one_color: string
  symbol_scale: number
  outline: boolean
  labels: PlantLabelMode
  /** Only the recoloured strata (`none` is "No stratum yet"); absent when none is. */
  stratum_colors?: StratumColors
}

const DEFAULT_PLANT_DISPLAY_OPTIONS: PlantDisplayOptions = Object.freeze({
  colorBy: DEFAULT_PLANT_DISPLAY.colorBy,
  oneColor: DEFAULT_PLANT_DISPLAY.oneColor,
  symbolScale: DEFAULT_PLANT_DISPLAY.symbolScale,
  outline: DEFAULT_PLANT_DISPLAY.outline,
  labels: DEFAULT_PLANT_DISPLAY.labels,
  stratumColors: DEFAULT_PLANT_DISPLAY.stratumColors,
})

/** The Design's display options; unknown or invalid stored values fall back to defaults, reported as a repair. */
export function readPlantDisplayOptions(design: Pick<CanopiFile, 'extra'> | null): PlantDisplayOptions {
  const stored = readExtra(design, PLANT_DISPLAY_EXTRA_KEY) as Partial<Record<keyof StoredPlantDisplay, unknown>> | null
  if (!stored) return DEFAULT_PLANT_DISPLAY_OPTIONS
  const colorBy = stored.color_by === 'one_color' ? 'one-color' : stored.color_by
  const oneColor = typeof stored.one_color === 'string' ? normalizeHexColor(stored.one_color) : null
  const repaired = [
    PLANT_COLOR_MODES.includes(colorBy as PlantColorMode) ? null : 'color_by',
    oneColor ? null : 'one_color',
    typeof stored.symbol_scale === 'number' ? null : 'symbol_scale',
    typeof stored.outline === 'boolean' ? null : 'outline',
    PLANT_LABEL_MODES.includes(stored.labels as PlantLabelMode) ? null : 'labels',
  ].filter((field): field is string => field !== null)
  if (repaired.length > 0) reportExtraRepair(design, PLANT_DISPLAY_EXTRA_KEY, `${repaired.join(', ')} defaulted`)
  return Object.freeze({
    colorBy: PLANT_COLOR_MODES.includes(colorBy as PlantColorMode)
      ? colorBy as PlantColorMode
      : DEFAULT_PLANT_DISPLAY_OPTIONS.colorBy,
    oneColor: oneColor ?? DEFAULT_PLANT_DISPLAY_OPTIONS.oneColor,
    symbolScale: typeof stored.symbol_scale === 'number'
      ? clampPlantSymbolScale(stored.symbol_scale)
      : DEFAULT_PLANT_DISPLAY_OPTIONS.symbolScale,
    outline: typeof stored.outline === 'boolean' ? stored.outline : DEFAULT_PLANT_DISPLAY_OPTIONS.outline,
    labels: PLANT_LABEL_MODES.includes(stored.labels as PlantLabelMode)
      ? stored.labels as PlantLabelMode
      : DEFAULT_PLANT_DISPLAY_OPTIONS.labels,
    stratumColors: normalizeStratumColors(stored.stratum_colors),
  })
}

function sameOptions(left: PlantDisplayOptions, right: PlantDisplayOptions): boolean {
  return left.colorBy === right.colorBy
    && left.oneColor === right.oneColor
    && left.symbolScale === right.symbolScale
    && left.outline === right.outline
    && left.labels === right.labels
    && stratumColorsEqual(left.stratumColors, right.stratumColors)
}

function storedFrom(options: PlantDisplayOptions): StoredPlantDisplay {
  return {
    color_by: options.colorBy === 'one-color' ? 'one_color' : options.colorBy,
    one_color: options.oneColor,
    symbol_scale: options.symbolScale,
    outline: options.outline,
    labels: options.labels,
    ...Object.keys(options.stratumColors).length > 0 ? { stratum_colors: { ...options.stratumColors } } : {},
  }
}

/** The Design with some display options changed; a change to nothing returns it untouched. */
export function withPlantDisplayOptions<T extends Pick<CanopiFile, 'extra'>>(
  design: T,
  change: Partial<PlantDisplayOptions>,
): T {
  const current = readPlantDisplayOptions(design)
  const next = readPlantDisplayOptions({
    extra: { [PLANT_DISPLAY_EXTRA_KEY]: storedFrom({ ...current, ...change }) },
  })
  if (sameOptions(current, next)) return design
  return withExtra(design, PLANT_DISPLAY_EXTRA_KEY, sameOptions(next, DEFAULT_PLANT_DISPLAY_OPTIONS) ? null : { ...storedFrom(next) })
}

/** Changes some display options of the current Design; a change to nothing leaves it untouched. */
export function setPlantDisplayOptions(change: Partial<PlantDisplayOptions>): void {
  editPlantDisplay(() => change)
}

/**
 * Recolours a whole stratum (or `none`, "No stratum yet") while colouring by
 * stratum; null or its default colour restores the default. Stored species
 * colours never change.
 */
export function setStratumDisplayColor(key: StratumColorKey, color: string | null): void {
  editPlantDisplay((current) => ({ stratumColors: { ...current.stratumColors, [key]: color ?? undefined } }))
}

/** Every stratum back to its default colour. */
export function resetStratumDisplayColors(): void {
  setPlantDisplayOptions({ stratumColors: {} })
}

function editPlantDisplay(change: (current: PlantDisplayOptions) => Partial<PlantDisplayOptions>): void {
  editCurrentDesign((design) => withPlantDisplayOptions(design, change(readPlantDisplayOptions(design))), 'plantDisplay.edit')
}
