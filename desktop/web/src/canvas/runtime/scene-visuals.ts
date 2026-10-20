import { CANVAS_CHROME_FONT_FAMILY } from '../chrome-fonts'
import { getCanvasColor, isThemeManagedZoneFill, markCanvasPaintChanged } from '../theme-refresh'
import { contrastRatio } from '../plant-colors'
import { getCanvasPlantDisplay } from './plant-display'
import type {
  ScenePersistedState,
  SceneZoneEntity,
} from './scene'
import type { DraftFill, DraftShape, DraftStroke } from './tools/draft'

export interface SceneLayerStyle {
  visible: boolean
  locked: boolean
  opacity: number
}

export interface SceneZoneVisual {
  fill: string
  stroke: string
  /** Drawn under the stroke so the zone edge reads on bright or dark imagery. */
  casing: string
}

export type CanvasInteractionVisualState =
  | 'hover'
  /** A plant a panel points at (finder matches, panel hover and selection). */
  | 'highlight'
  | 'selected'
  | 'locked-design-object'
  | 'locked-layer'

/** Plant rings never shrink below this on screen, so a ring reads at the whole-Design zoom. */
export const MIN_PLANT_RING_RADIUS_PX = 8

export interface CanvasInteractionStrokeVisual {
  color: string
  widthPx: number
  alpha: number
  /** Drawn first, under the stroke, at the same alpha. */
  casingColor: string
  casingWidthPx: number
}

/** Light overlay strokes (zones, guides, drafts) sit on a casing this much wider. */
export const OVERLAY_CASING_EXTRA_PX = 2

export function getSceneLayerStyle(
  scene: ScenePersistedState,
  layerName: string,
): SceneLayerStyle {
  const layer = scene.layers.find((entry) => entry.name === layerName)
  return {
    visible: layer?.visible ?? true,
    locked: layer?.locked ?? false,
    opacity: layer?.opacity ?? 1,
  }
}

/** Whether the Plants layer shows anything: visible and above zero opacity. Every plant drawing and label reads this one test. */
export function isPlantLayerShown(scene: ScenePersistedState): boolean {
  const layer = getSceneLayerStyle(scene, 'plants')
  return layer.visible && layer.opacity > 0
}

export function resolveZoneVisual(zone: SceneZoneEntity): SceneZoneVisual {
  const fill = zone.fillColor && !isThemeManagedZoneFill(zone.fillColor)
    ? zone.fillColor
    : getCanvasColor('zone-fill')

  return {
    fill,
    stroke: getCanvasColor('zone-stroke'),
    casing: getCanvasColor('overlay-casing'),
  }
}

/** Guides and drawing previews over the map: a light stroke on a dark casing. */
export function getGuideLineVisual(): { color: string; casing: string } {
  return { color: getCanvasColor('guide-line'), casing: getCanvasColor('overlay-casing') }
}

/** A draft stroke's colour over a casing `OVERLAY_CASING_EXTRA_PX` wider. */
export interface DraftStrokeVisual {
  readonly color: string
  readonly casing: string
}

export interface DraftFillVisual {
  readonly color: string
}

/**
 * Draft tokens (tools/draft.ts) in the colours today's DOM previews use: a
 * light draft on the dark overlay casing, the ochre band on the interaction
 * casing and its translucent fill.
 */
export function getDraftVisual(token: DraftStroke['token']): DraftStrokeVisual
export function getDraftVisual(token: DraftFill['token']): DraftFillVisual
export function getDraftVisual(token: DraftStroke['token'] | DraftFill['token']): DraftStrokeVisual | DraftFillVisual {
  switch (token) {
    case 'selection':
      return { color: getCanvasColor('selection-stroke'), casing: getCanvasColor('interaction-casing') }
    case 'draft':
      return getGuideLineVisual()
    case 'selection-fill':
      return { color: getCanvasColor('selection-fill') }
    case 'draft-fill':
      return { color: getCanvasColor('zone-fill') }
  }
}

export type DraftLabelTone = Extract<DraftShape, { kind: 'label' }>['tone']

/** A CSS box shadow: offsets and blur in CSS px. */
export interface CanvasShadowVisual {
  readonly offsetXPx: number
  readonly offsetYPx: number
  readonly blurPx: number
  readonly color: string
}

/** A draft label's chip: today's DOM chip, drawn upright in Pixi. */
export interface DraftLabelVisual {
  /** Centred on the point, or bottom-centre `gapPx` above it. */
  readonly placement: 'centre' | 'above'
  readonly gapPx: number
  readonly fontFamily: string
  readonly fontWeight: '400' | '600'
  readonly fontSizePx: number
  /** The text's line box; the chip's height is this plus padding and border. */
  readonly lineHeightPx: number
  readonly paddingPx: { readonly x: number; readonly y: number }
  readonly color: string
  readonly background: string
  readonly border: string
  readonly borderWidthPx: number
  readonly radiusPx: number
  readonly shadow: CanvasShadowVisual | null
}

// `--text-xs`, `--radius-sm` and `--space-1` in styles/global.css, where
// `:root:lang(zh|ja|ko)` raises `--text-xs` to the 13 px CJK floor.
const DRAFT_LABEL_FONT_SIZE_PX = 12.5
const DRAFT_LABEL_CJK_FONT_SIZE_PX = 13
const CJK_LANGUAGE = /^(zh|ja|ko)(-|$)/i
const DRAFT_LABEL_RADIUS_PX = 5
const DRAFT_LABEL_GAP_PX = 4
// Today's hint chips set no line-height and sit in the map container, so they inherit the 20 px of
// `.maplibregl-map { font: 12px/20px … }` (maplibre-gl.css) at every font size.
const DRAFT_LABEL_HINT_LINE_HEIGHT_PX = 20

/** `--text-xs` in the page language, which utils/theme.ts keeps on the root element. */
function draftLabelFontSizePx(): number {
  return CJK_LANGUAGE.test(document.documentElement.lang) ? DRAFT_LABEL_CJK_FONT_SIZE_PX : DRAFT_LABEL_FONT_SIZE_PX
}

/**
 * The chip each label tone names (canvas v2 spec §1.4, label tones), with
 * today's padding, all in the chrome's Source Sans 3: measurements are centred chips on the muted surface
 * (today's (a4c86d39) zone-measurement-overlay.ts), the area at 600 and edges and dimensions at 400, hints bottom-centre chips on the surface
 * (today's (a4c86d39) plant-placement-preview.ts), Plant a row's length in the
 * primary colour (today's (a4c86d39) plant-spacing-overlay.ts).
 */
export function getDraftLabelVisual(tone: DraftLabelTone): DraftLabelVisual {
  const fontSizePx = draftLabelFontSizePx()
  const chip = {
    gapPx: DRAFT_LABEL_GAP_PX,
    fontSizePx,
    border: getCanvasColor('chip-border'),
    borderWidthPx: 1,
    radiusPx: DRAFT_LABEL_RADIUS_PX,
    shadow: parseCanvasShadow(getCanvasColor('chip-shadow')),
  }
  if (tone === 'measure' || tone === 'measure-quiet') {
    return {
      ...chip,
      placement: 'centre',
      fontFamily: CANVAS_CHROME_FONT_FAMILY,
      fontWeight: tone === 'measure' ? '600' : '400',
      lineHeightPx: fontSizePx * 1.2,
      paddingPx: { x: 5, y: 2 },
      color: getCanvasColor('chip-text'),
      background: getCanvasColor('chip-surface-muted'),
    }
  }
  return {
    ...chip,
    placement: 'above',
    fontFamily: CANVAS_CHROME_FONT_FAMILY,
    fontWeight: '600',
    lineHeightPx: DRAFT_LABEL_HINT_LINE_HEIGHT_PX,
    paddingPx: tone === 'hint-primary' ? { x: 8, y: 4 } : { x: 6, y: 2 },
    color: getCanvasColor(tone === 'hint-primary' ? 'chip-primary' : 'chip-text'),
    background: getCanvasColor('chip-surface'),
  }
}

/** The first shadow of a CSS `box-shadow` value (`x y blur [spread] colour`); null for `none` or anything else. */
function parseCanvasShadow(value: string): CanvasShadowVisual | null {
  const match = value.trim().match(/^(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+([\d.]+)(?:px)?\s+(?:-?[\d.]+(?:px)?\s+)?(#[0-9a-f]+|rgba?\([^)]*\))/i)
  if (!match) return null
  return {
    offsetXPx: Number.parseFloat(match[1]!),
    offsetYPx: Number.parseFloat(match[2]!),
    blurPx: Number.parseFloat(match[3]!),
    color: match[4]!,
  }
}

/**
 * What shows under the Design on the map. The UI theme never decides label
 * ink: the basemap stays light in a dark UI and satellite imagery stays dark
 * in a light one, so text, halos, badges and the grid follow the backdrop.
 */
export type CanvasMapBackdrop = 'basemap' | 'dark-basemap' | 'satellite' | 'paper'

/**
 * A representative colour for each backdrop. `paper` equals the background
 * layer of the map's empty style (`maplibre/config.ts`), which does not
 * follow the UI theme.
 */
export const CANVAS_MAP_BACKDROP_COLORS: { readonly [K in CanvasMapBackdrop]: string } = {
  basemap: '#F8F4F0',
  'dark-basemap': '#1A1A1A',
  satellite: '#3B4232',
  paper: '#F3EFE4',
}

export interface CanvasBackdropInk {
  readonly text: string
  /** Drawn under text and markers so they read on busy imagery. */
  readonly halo: string
  readonly badgeBackground: string
  readonly badgeText: string
  readonly grid: string
  readonly gridMajor: string
}

// Dark ink on a cream halo for light backdrops; cream ink on a dark halo
// (the zone and guide stroke colours) for dark ones.
const INK_FOR_LIGHT_BACKDROP: CanvasBackdropInk = {
  text: '#27231D',
  halo: '#FFF8EC',
  badgeBackground: '#27231D',
  badgeText: '#FBF3E4',
  grid: 'rgba(39, 35, 29, 0.07)',
  gridMajor: 'rgba(39, 35, 29, 0.14)',
}

/**
 * The Site data pin on the map: an ink core inside a white ring, so it reads on light maps and dark imagery alike. Map
 * overlays sit on imagery, so its two tones are fixed and never follow the theme or the backdrop (spec §1.10, the
 * board's MAPINK).
 */
export const SITE_PIN_VISUAL: { readonly core: string; readonly ring: string } = Object.freeze({
  core: INK_FOR_LIGHT_BACKDROP.text,
  ring: '#FFFFFF',
})

/**
 * Show my location's dot (U54 Q11): a platform blue core in a cream ring, the convention phone users know and the one
 * exception to blue = focus or water (system.md). Its accuracy area is the core at 15 %. Fixed, like the Site data pin:
 * it sits on imagery and never follows the theme or the backdrop.
 */
export const USER_LOCATION_VISUAL: { readonly core: string; readonly ring: string; readonly accuracyOpacity: number } = Object.freeze({
  core: '#1A73E8',
  ring: '#FFF8EC',
  accuracyOpacity: 0.15,
})

const INK_FOR_DARK_BACKDROP: CanvasBackdropInk = {
  text: '#FFF3D6',
  halo: '#14100A',
  badgeBackground: '#EFE8DA',
  badgeText: '#1D1A14',
  grid: 'rgba(239, 232, 218, 0.06)',
  gridMajor: 'rgba(239, 232, 218, 0.12)',
}

// The workspace map's backdrop, set by the runtime from its app adapter.
let mapBackdrop: CanvasMapBackdrop = 'basemap'

/** Returns true when the backdrop changed and the canvas must redraw. */
export function setCanvasMapBackdrop(backdrop: CanvasMapBackdrop): boolean {
  if (backdrop === mapBackdrop) return false
  mapBackdrop = backdrop
  markCanvasPaintChanged()
  return true
}

/** The ink that contrasts more with `background` (a #RRGGBB colour). */
export function resolveBackdropInk(background: string): CanvasBackdropInk {
  return contrastRatio(INK_FOR_LIGHT_BACKDROP.text, background) >= contrastRatio(INK_FOR_DARK_BACKDROP.text, background)
    ? INK_FOR_LIGHT_BACKDROP
    : INK_FOR_DARK_BACKDROP
}

function mapBackdropColor(): string {
  return CANVAS_MAP_BACKDROP_COLORS[mapBackdrop]
}

/** The ink for text and chrome drawn over the workspace map. */
export function getMapBackdropInk(): CanvasBackdropInk {
  return resolveBackdropInk(mapBackdropColor())
}

/** The one ink of map text (plant names, notes, measurement labels), from the map backdrop. */
export function getMapTextColor(): string {
  return getMapBackdropInk().text
}

/** The halo stroked under map text of this size; the stroke is centred on the glyph edge. */
export function getLabelHalo(fontSizePx: number): { color: string; widthPx: number } {
  return { color: getMapBackdropInk().halo, widthPx: Math.max(3, Math.round(fontSizePx / 4)) }
}

export function getCanvasInteractionStrokeVisual(
  state: CanvasInteractionVisualState,
): CanvasInteractionStrokeVisual {
  // Selected: 2.5 px ochre over a 5.5 px casing; every state keeps its casing
  // so rings and outlines read on satellite imagery and plain basemaps alike.
  if (state === 'selected') return interactionStroke('selection-stroke', 2.5, 1, 5.5)
  // Highlight rings must read at any zoom and on any backdrop: solid ochre on a full halo.
  if (state === 'highlight') return interactionStroke('selection-stroke', 2, 1, 5)
  if (state === 'locked-design-object') return interactionStroke('locked-object-stroke', 2.25, 0.86, 4.25)
  if (state === 'locked-layer') return interactionStroke('locked-layer-stroke', 2.25, 0.9, 4.25)
  return interactionStroke('hover-stroke', 2, 0.72, 4)
}

function interactionStroke(
  token: 'selection-stroke' | 'locked-object-stroke' | 'locked-layer-stroke' | 'hover-stroke',
  widthPx: number,
  alpha: number,
  casingWidthPx: number,
): CanvasInteractionStrokeVisual {
  return {
    color: getCanvasColor(token),
    widthPx,
    alpha,
    casingColor: getCanvasColor('interaction-casing'),
    casingWidthPx,
  }
}

export function getStackBadgeBackgroundColor(background = mapBackdropColor()): string {
  return resolveBackdropInk(background).badgeBackground
}

export function getStackBadgeTextColor(background = mapBackdropColor()): string {
  return resolveBackdropInk(background).badgeText
}

/**
 * The halo and cut-out colour of a plant symbol: the backdrop it sits on, or
 * the backdrop's ink when the plant colour is too close to the backdrop.
 */
export function getPlantSymbolEdgeColor(color: string, background = mapBackdropColor()): string {
  return contrastRatio(color, background) < 3 ? resolveBackdropInk(background).text : background
}

/** The halo width around a plant symbol; 0 when Display › Outline is off. */
export function getPlantSymbolEdgeWidth(diameterPx: number): number {
  if (!getCanvasPlantDisplay().outline) return 0
  return diameterPx < 10 ? .5 : .7
}

