// app/shell/phone-layout.ts
// Owner of the layout breakpoints (no-shell-breakpoint-media-query, ADR 0028; §18 F25).
// Invariant: the phone layout is decided only here (data-layout); no width media query elsewhere.

import { signal } from '@preact/signals'

/**
 * The Web Edition's phone layout (board WebPhone): a floating 44 px top bar, a
 * short tool strip on the left, the zoom buttons and scale on the right, and
 * the panels in a sheet (at the bottom in portrait, at the right in
 * landscape) instead of the floating dock and panel rail. Only the Web shell
 * installs it (`installPhoneLayout`), so on Desktop, on tablets and in wide
 * windows `phoneLayout` stays null and today's layout is untouched.
 */
export type PhoneLayout = 'portrait' | 'landscape'

/** Where the panel sheet rests: its tabs only, half the height, or all of it below the top bar. */
export type PhoneSheetHeight = 'peek' | 'half' | 'full'

/** Narrower than this is a phone held upright. */
const PHONE_MAX_WIDTH_PX = 640
/** Shorter than this, and wider than tall, is a phone on its side. */
const PHONE_LANDSCAPE_MAX_HEIGHT_PX = 480
/** A short window at least this wide is a desktop window, not a phone. */
const PHONE_LANDSCAPE_MAX_WIDTH_PX = 960

const SHEET_HEIGHTS: readonly PhoneSheetHeight[] = ['peek', 'half', 'full']

/** The current phone layout; null keeps the desktop, tablet and wide-window layout. */
export const phoneLayout = signal<PhoneLayout | null>(null)
/** The height the sheet opens to while a panel is open; with no panel it rests at peek. */
export const phoneSheetOpenHeight = signal<Exclude<PhoneSheetHeight, 'peek'>>('half')
/**
 * The armed tool's options in the panel sheet (answer 30): the height they show at in place of the open panel, or null
 * while they are closed. Closing them gives the sheet back to its panel and height as they were.
 */
export const phoneToolOptions = signal<Exclude<PhoneSheetHeight, 'peek'> | null>(null)

/** Pure: the phone layout for a viewport of this size, or null for everything else. */
export function classifyPhoneLayout(width: number, height: number): PhoneLayout | null {
  if (width <= 0 || height <= 0) return null
  if (width > height && height < PHONE_LANDSCAPE_MAX_HEIGHT_PX && width < PHONE_LANDSCAPE_MAX_WIDTH_PX) return 'landscape'
  if (width < PHONE_MAX_WIDTH_PX) return 'portrait'
  return null
}

/**
 * Pure: the height a key on the sheet's handle moves to (ArrowUp and PageUp
 * raise it one stop, ArrowDown and PageDown lower it, Home rests it at peek,
 * End opens it fully); null for any other key.
 */
export function stepPhoneSheet(current: PhoneSheetHeight, key: string): PhoneSheetHeight | null {
  const index = SHEET_HEIGHTS.indexOf(current)
  switch (key) {
    case 'ArrowUp':
    case 'PageUp':
      return SHEET_HEIGHTS[Math.min(SHEET_HEIGHTS.length - 1, index + 1)]!
    case 'ArrowDown':
    case 'PageDown':
      return SHEET_HEIGHTS[Math.max(0, index - 1)]!
    case 'Home':
      return 'peek'
    case 'End':
      return 'full'
    default:
      return null
  }
}

/** Pure: a press on the handle moves peek to half, half to full and full back to peek. */
export function cyclePhoneSheet(current: PhoneSheetHeight): PhoneSheetHeight {
  return current === 'peek' ? 'half' : current === 'half' ? 'full' : 'peek'
}

/**
 * Pure: the stop nearest to the size a drag let go at, in CSS pixels. A
 * quick flick (`velocity`, px/ms, positive when growing) carries on to the
 * next stop in its direction.
 */
export function snapPhoneSheet(
  size: number,
  stops: Readonly<Record<PhoneSheetHeight, number>>,
  velocity = 0,
): PhoneSheetHeight {
  const nearest = SHEET_HEIGHTS.reduce((best, height) =>
    Math.abs(stops[height] - size) < Math.abs(stops[best] - size) ? height : best, 'peek' as PhoneSheetHeight)
  if (Math.abs(velocity) < FLICK_PX_PER_MS) return nearest
  // A flick goes on to the next stop past where it was let go.
  if (velocity > 0) return SHEET_HEIGHTS.find((height) => stops[height] > size) ?? 'full'
  return [...SHEET_HEIGHTS].reverse().find((height) => stops[height] < size) ?? 'peek'
}

/** A drag faster than this when let go is a flick. */
const FLICK_PX_PER_MS = 0.6

/**
 * Follows the window's size into `phoneLayout` until the returned disposer
 * runs, which puts the desktop layout back. One owner at a time: the Web shell.
 */
export function installPhoneLayout(target: Window = window): () => void {
  const update = () => {
    const next = classifyPhoneLayout(target.innerWidth, target.innerHeight)
    if (phoneLayout.peek() !== next) phoneLayout.value = next
  }
  update()
  target.addEventListener('resize', update)
  target.addEventListener('orientationchange', update)
  return () => {
    target.removeEventListener('resize', update)
    target.removeEventListener('orientationchange', update)
    phoneLayout.value = null
  }
}
