import { effect, signal } from '@preact/signals'
import { currentCanvasViewportCommandSurface } from '../../canvas/session'

/**
 * The part of the map the workspace's floating chrome leaves visible. The map
 * fills the window; the title bar, the tool and panel rails, the open dock and
 * the bottom chrome float over it. Each registers here, and this module is the
 * one source of the visible map frame: fitting and temporary focus frame into
 * it (through the camera), status chips centre in it (through `--map-inset-*`
 * on the map area), and the map credits fold when the bottom band leaves them
 * too little room. Status chrome that comes and goes with load state (the map
 * notice) registers with `frames: false`: chips avoid it, but the camera
 * frames from the other chrome only, so a Design opened while it shows is
 * framed as one opened after it goes. That framing frame is also published as
 * `--map-framing-inset-*`, where status chrome places itself: clear of all
 * other chrome, and never standing on its own box. The credits' fold measures
 * only the bottom band, so status chrome standing above it takes none of
 * their room. Both rails also
 * register the room they have above the chrome under their column (the view
 * chip under the tool rail; the inspection launcher and the zoom group under
 * the panel rail), so a short window folds their last entries into a More
 * button instead of covering that chrome. A page that scrolls under the
 * chrome (the start screen) keeps clear of it through `--map-clear-*`: chrome
 * whose top stands in the map's lower half (the landscape panel sheet's corner
 * box at its peek) is room at the bottom, where the page's end scrolls above
 * it, and other chrome is room at its own edge. An open Design's chrome waiting
 * to show (the map area marked `data-design-hidden`: chrome inside the map area,
 * and `data-design-chrome` outside it) frames the camera but keeps no room from
 * the page: the start screen covers that wait, and its layout must not shift
 * beside chrome nobody sees.
 */
export interface VisibleMapFrame {
  /** The map area's size, in CSS pixels. */
  readonly width: number
  readonly height: number
  /** How far chrome covers each edge of the map area, in CSS pixels. */
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

export type MapOccluderSide = 'top' | 'right' | 'bottom' | 'left'

export interface MapOccluderBox {
  readonly rect: DOMRect
  /** The edge it covers; inferred from its shape and place when absent. */
  readonly side?: MapOccluderSide
}

export interface MapOccluderOptions {
  /** False for status chrome that comes and goes with load state: chips avoid it, the camera's framing does not. */
  readonly frames?: boolean
}

interface Occluder {
  readonly side: MapOccluderSide | undefined
  readonly frames: boolean
}

/** The least map width the labelled tool rail may leave between itself and the right chrome. */
const MIN_VISIBLE_MAP_WIDTH_PX = 360
/**
 * The least room the map credits need on one line between the view chip and
 * the zoom group; with less they fold into MapLibre's (i) button instead of
 * wrapping up under a panel.
 */
const MAP_ATTRIBUTION_MIN_ROOM_PX = 360

/** The least gap between a rail's bottom and the chrome under its column. */
const RAIL_BOTTOM_GAP_PX = 8

/** The two floating rails: tools on the left, panels on the right. */
export type ChromeRail = 'tool' | 'panel'

const NO_FRAME: VisibleMapFrame = Object.freeze({ width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 })
/** A floating band at least this share of the map's width covers the top or the bottom edge. */
const HORIZONTAL_BAND_SHARE = 0.6
const INSET_PROPERTIES = ['top', 'right', 'bottom', 'left'] as const

export const visibleMapFrame = signal<VisibleMapFrame>(NO_FRAME)
/**
 * The frame the camera fits into and status chrome stands in: `visibleMapFrame` without the chrome registered with
 * `frames: false`. Chrome placed from `--map-framing-inset-*` (the phone zoom column, the phone sheet's full stop)
 * measures its room here, so status chrome that comes and goes never hides or shortens it.
 */
export const framingMapFrame = signal<VisibleMapFrame>(NO_FRAME)
/** Whether the map credits fold into their (i) button (see `MAP_ATTRIBUTION_MIN_ROOM_PX`). */
export const mapAttributionFolded = signal(false)
/**
 * The height each rail may take from its top edge before the chrome under its
 * column, in CSS pixels; null when nothing sits under it (see
 * `measureRailRoom`).
 */
export const panelRailRoom = signal<number | null>(null)
export const toolRailRoom = signal<number | null>(null)
const RAIL_ROOM = { tool: toolRailRoom, panel: panelRailRoom } as const
const RAIL_SIDE = { tool: 'left', panel: 'right' } as const

/** Pure: how far each registered chrome box covers each edge of the map rectangle. */
export function measureVisibleMapFrame(map: DOMRect, occluders: Iterable<MapOccluderBox>): VisibleMapFrame {
  const edges = { top: 0, right: 0, bottom: 0, left: 0 }
  for (const { rect, side } of occluders) {
    if (rect.width <= 0 || rect.height <= 0) continue
    if (rect.right <= map.left || rect.left >= map.right || rect.bottom <= map.top || rect.top >= map.bottom) continue
    const edge = side ?? inferSide(map, rect)
    const cover = edge === 'top' ? rect.bottom - map.top
      : edge === 'bottom' ? map.bottom - rect.top
        : edge === 'left' ? rect.right - map.left
          : map.right - rect.left
    edges[edge] = Math.max(edges[edge], Math.round(cover))
  }
  return { width: Math.round(map.width), height: Math.round(map.height), ...edges }
}

/**
 * Pure: the free width of the bottom band, between the bottom chrome on the
 * left (the view chip) and on the right (the zoom group), where the map
 * credits sit, right-aligned beside the zoom group. Chrome standing wholly
 * above the band takes none of its room: the narrow edition's bottom sheet
 * covers the bottom edge but stops above the band, and the map notice stands
 * above it.
 * The whole map width when no bottom chrome is registered.
 */
export function measureBottomBandRoom(map: DOMRect, occluders: Iterable<MapOccluderBox>): number {
  const bottom = [...occluders].filter(({ rect, side }) =>
    rect.width > 0 && rect.height > 0 && (side ?? inferSide(map, rect)) === 'bottom')
  const bandTop = Math.max(-Infinity, ...bottom.map(({ rect }) => rect.top))
  let left = map.left
  let right = map.right
  const middle = map.left + map.width / 2
  for (const { rect } of bottom) {
    if (rect.bottom <= bandTop) continue
    if (rect.left + rect.width / 2 < middle) left = Math.max(left, rect.right)
    else right = Math.min(right, rect.left)
  }
  return Math.round(right - left)
}

/**
 * Pure: the height a rail may take from its top edge before the highest
 * chrome under its column (the view chip; the inspection launcher, the zoom
 * group), less `RAIL_BOTTOM_GAP_PX`. Null without a rail or chrome under it.
 * Reads only the rail's top and sides, so the rail's own height cannot feed
 * back into it.
 */
export function measureRailRoom(rail: DOMRect | null, below: Iterable<DOMRect>): number | null {
  if (!rail || rail.width <= 0 || rail.height <= 0) return null
  let floor = Infinity
  for (const rect of below) {
    if (rect.width <= 0 || rect.height <= 0) continue
    if (rect.right <= rail.left || rect.left >= rail.right || rect.top < rail.top) continue
    floor = Math.min(floor, rect.top)
  }
  return floor === Infinity ? null : Math.max(0, Math.floor(floor - RAIL_BOTTOM_GAP_PX - rail.top))
}

/**
 * Whether left chrome (the labelled tool rail, the open inspection lens) whose
 * right edge would sit `leftChromeEdgePx` from the map's left edge would leave
 * less than `MIN_VISIBLE_MAP_WIDTH_PX` of map before the right chrome. Reads
 * only the right edge of the frame, so that chrome's own cover of the left
 * edge cannot feed back into it.
 */
export function leftChromeCrowdsMap(frame: VisibleMapFrame, leftChromeEdgePx: number): boolean {
  if (frame.width <= 0) return false
  return frame.width - frame.right - leftChromeEdgePx < MIN_VISIBLE_MAP_WIDTH_PX
}

/**
 * Pure: how far chrome on the bottom edge whose box spans part of the column from `left` to `right` covers the map
 * there (the narrow edition's bottom sheet over the pinned-names legend's place); 0 when none does.
 */
export function measureBottomCoverOver(
  map: DOMRect,
  occluders: Iterable<MapOccluderBox>,
  left: number,
  right: number,
): number {
  const column = [...occluders].filter(({ rect }) => rect.left < right && rect.right > left)
  return measureVisibleMapFrame(map, column.filter(({ rect, side }) =>
    rect.width > 0 && rect.height > 0 && (side ?? inferSide(map, rect)) === 'bottom')).bottom
}

/**
 * How far the registered framing chrome on the bottom edge covers the column from `left` to `right` (see
 * `measureBottomCoverOver`); 0 without a map area. Status chrome (`frames: false`) is left out, as it places itself
 * from the framing frame, and so is chrome on the other edges: left chrome placed from this reading (the pinned-names
 * legend) never measures its own registration.
 */
export function bottomChromeCoverOver(left: number, right: number): number {
  if (!area) return 0
  return measureBottomCoverOver(
    area.getBoundingClientRect(),
    [...occluders].filter(([, { frames }]) => frames).map(([element, { side }]) => ({ rect: element.getBoundingClientRect(), side })),
    left,
    right,
  )
}

/**
 * Pure: the room a page scrolling under the chrome keeps at each edge. As `measureVisibleMapFrame`, except that chrome
 * whose top stands in the map's lower half covers the bottom edge: the page's end scrolls above it, so it takes no
 * width from every row.
 */
function measureScrollClearance(map: DOMRect, occluders: Iterable<MapOccluderBox>): VisibleMapFrame {
  const middle = map.top + map.height / 2
  return measureVisibleMapFrame(map, [...occluders].map(({ rect, side }) => ({
    rect,
    side: rect.top >= middle ? 'bottom' as const : side,
  })))
}

function inferSide(map: DOMRect, rect: DOMRect): MapOccluderSide {
  if (rect.width >= map.width * HORIZONTAL_BAND_SHARE) {
    return rect.top + rect.height / 2 < map.top + map.height / 2 ? 'top' : 'bottom'
  }
  return rect.left + rect.width / 2 < map.left + map.width / 2 ? 'left' : 'right'
}

let area: HTMLElement | null = null
const occluders = new Map<HTMLElement, Occluder>()
const rails: Record<ChromeRail, HTMLElement | null> = { tool: null, panel: null }
const underRail: Record<ChromeRail, Set<HTMLElement>> = { tool: new Set(), panel: new Set() }
let observer: ResizeObserver | null = null
/** The frame a chrome resize is measured on; null when none is due. */
let pendingFrame: number | null = null
let stopCameraSync: (() => void) | null = null

function recompute(): void {
  if (!area) return
  const map = area.getBoundingClientRect()
  const measure = () => [...occluders].map(([element, { side, frames }]) => ({ element, rect: element.getBoundingClientRect(), side, frames }))
  let boxes = measure()
  const framing = measureVisibleMapFrame(map, boxes.filter(({ frames }) => frames))
  let framingMoved = false
  for (const edge of INSET_PROPERTIES) {
    const value = `${framing[edge]}px`
    if (area.style.getPropertyValue(`--map-framing-inset-${edge}`) === value) continue
    area.style.setProperty(`--map-framing-inset-${edge}`, value)
    framingMoved = true
  }
  // Status chrome stands from the framing insets just written; measured before them, it would be where it stood, and
  // moving without resizing it brings no observation to correct the chips' insets.
  if (framingMoved && boxes.some(({ frames }) => !frames)) boxes = measure()
  const next = measureVisibleMapFrame(map, boxes)
  const folded = map.width > 0 && measureBottomBandRoom(map, boxes) < MAP_ATTRIBUTION_MIN_ROOM_PX
  if (mapAttributionFolded.peek() !== folded) mapAttributionFolded.value = folded
  for (const edge of INSET_PROPERTIES) area.style.setProperty(`--map-inset-${edge}`, `${next[edge]}px`)
  const page = area
  const clearance = measureScrollClearance(map, page.hasAttribute('data-design-hidden')
    ? boxes.filter(({ element }) => !page.contains(element) && !element.closest('[data-design-chrome]'))
    : boxes)
  for (const edge of INSET_PROPERTIES) area.style.setProperty(`--map-clear-${edge}`, `${clearance[edge]}px`)
  for (const kind of ['tool', 'panel'] as const) {
    const room = measureRailRoom(
      rails[kind]?.getBoundingClientRect() ?? null,
      [...underRail[kind]].map((element) => element.getBoundingClientRect()),
    )
    if (RAIL_ROOM[kind].peek() !== room) RAIL_ROOM[kind].value = room
  }
  publishFrame(framingMapFrame, framing)
  publishFrame(visibleMapFrame, next)
}

function publishFrame(target: typeof visibleMapFrame, next: VisibleMapFrame): void {
  const current = target.peek()
  if (
    current.width !== next.width || current.height !== next.height || current.top !== next.top
    || current.right !== next.right || current.bottom !== next.bottom || current.left !== next.left
  ) target.value = next
}

/**
 * A chrome resize is measured on the next frame, never inside the observer's delivery: the insets and rail rooms it
 * writes resize chrome this observer watches (the top chip slot reflows when the tool rail drops its names), which
 * WebKit reports as "ResizeObserver loop completed with undelivered notifications". On the next frame that resize is an
 * ordinary new observation. Resizes delivered together are measured once.
 */
function recomputeNextFrame(): void {
  if (pendingFrame !== null) return
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null
    recompute()
  })
}

function observe(element: HTMLElement): void {
  observer?.observe(element)
}

function startWatching(): void {
  if (typeof ResizeObserver !== 'undefined' && !observer) {
    // The map area is full-bleed, so the window's resize covers it; the
    // observer watches the chrome, whose size changes on its own.
    observer = new ResizeObserver(recomputeNextFrame)
    for (const element of [...occluders.keys(), ...underRail.tool, ...underRail.panel]) observer.observe(element)
  }
  window.addEventListener('resize', recompute)
  stopCameraSync = effect(() => {
    const frame = framingMapFrame.value
    currentCanvasViewportCommandSurface.value?.setFramingInsets({
      top: frame.top,
      right: frame.right,
      bottom: frame.bottom,
      left: frame.left,
    })
  })
}

function stopWatching(): void {
  observer?.disconnect()
  observer = null
  if (pendingFrame !== null) cancelAnimationFrame(pendingFrame)
  pendingFrame = null
  window.removeEventListener('resize', recompute)
  stopCameraSync?.()
  stopCameraSync = null
}

/** The map area: the element the map fills. One at a time; returns its release. */
export function registerMapArea(element: HTMLElement): () => void {
  if (area && area !== element) releaseArea(area)
  area = element
  startWatching()
  recompute()
  return () => releaseArea(element)
}

function releaseArea(element: HTMLElement): void {
  if (area !== element) return
  for (const edge of INSET_PROPERTIES) {
    element.style.removeProperty(`--map-inset-${edge}`)
    element.style.removeProperty(`--map-framing-inset-${edge}`)
    element.style.removeProperty(`--map-clear-${edge}`)
  }
  area = null
  stopWatching()
  visibleMapFrame.value = NO_FRAME
  framingMapFrame.value = NO_FRAME
  mapAttributionFolded.value = false
  panelRailRoom.value = null
  toolRailRoom.value = null
}

/** Floating chrome over the map; returns its release. */
export function registerMapOccluder(element: HTMLElement, side?: MapOccluderSide, options: MapOccluderOptions = {}): () => void {
  occluders.set(element, { side, frames: options.frames ?? true })
  observe(element)
  recompute()
  return () => {
    if (!occluders.delete(element)) return
    if (!underRail.tool.has(element) && !underRail.panel.has(element)) observer?.unobserve(element)
    recompute()
  }
}

/** A rail: an edge occluder (tools left, panels right) whose room is measured; returns its release. */
export function registerRail(kind: ChromeRail, element: HTMLElement): () => void {
  rails[kind] = element
  const release = registerMapOccluder(element, RAIL_SIDE[kind])
  return () => {
    if (rails[kind] === element) rails[kind] = null
    release()
  }
}

/**
 * Chrome under a rail's column that the rail must end above (the view chip
 * under the tool rail; the inspection launcher and the zoom group under the
 * panel rail); returns its release.
 */
export function registerUnderRail(kind: ChromeRail, element: HTMLElement): () => void {
  underRail[kind].add(element)
  observe(element)
  recompute()
  return () => {
    if (!underRail[kind].delete(element)) return
    if (!occluders.has(element) && !underRail.tool.has(element) && !underRail.panel.has(element)) observer?.unobserve(element)
    recompute()
  }
}

/**
 * Measures again after chrome moved without changing size, such as the rails
 * when a notice row lowers `--chrome-rail-top`.
 */
export function refreshVisibleMapArea(): void {
  recompute()
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => stopWatching())
}
