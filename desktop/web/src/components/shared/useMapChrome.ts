import type { RefObject } from 'preact'
import { useLayoutEffect, useRef } from 'preact/hooks'
import {
  refreshVisibleMapArea,
  registerMapArea,
  registerMapOccluder,
  registerRail,
  registerUnderRail,
  type ChromeRail,
  type MapOccluderOptions,
  type MapOccluderSide,
} from '../../app/shell/visible-map-area'

/** Registers the element the map fills, so chrome can frame and centre into what stays visible. */
export function useMapArea(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current
    return element ? registerMapArea(element) : undefined
  }, [ref])
}

/**
 * Registers floating chrome that covers an edge of the map (inferred from its
 * box when `side` is absent); `covers` false leaves it out, for chrome placed
 * from the visible map frame itself (the phone zoom group). `frames: false`
 * keeps status chrome that comes and goes with load state out of the camera's
 * framing (see `MapOccluderOptions`).
 */
export function useMapOccluder(
  ref: RefObject<HTMLElement | null>,
  side?: MapOccluderSide,
  covers = true,
  { frames = true }: MapOccluderOptions = {},
): void {
  useLayoutEffect(() => {
    const element = covers ? ref.current : null
    return element ? registerMapOccluder(element, side, { frames }) : undefined
  }, [ref, side, covers, frames])
}

/** Registers a rail, which covers its edge and folds its last entries into More when short. */
export function useRail(ref: RefObject<HTMLElement | null>, kind: ChromeRail): void {
  useLayoutEffect(() => {
    const element = ref.current
    return element ? registerRail(kind, element) : undefined
  }, [ref, kind])
}

/**
 * Registers chrome under a rail's column that the rail ends above
 * (`mounted` follows an element rendered only some of the time).
 */
export function useUnderRail(ref: RefObject<HTMLElement | null>, kind: ChromeRail, mounted = true): void {
  useLayoutEffect(() => {
    const element = mounted ? ref.current : null
    return element ? registerUnderRail(kind, element) : undefined
  }, [ref, kind, mounted])
}

/**
 * Publishes the element's width as a custom property on its parent (the map
 * area), so map-owned DOM such as the MapLibre attribution can be placed
 * beside the chrome.
 */
export function usePublishedWidth(ref: RefObject<HTMLElement | null>, property: `--${string}`): void {
  useLayoutEffect(() => {
    const element = ref.current
    const host = element?.parentElement
    if (!element || !host || typeof ResizeObserver === 'undefined') return
    const publish = () => host.style.setProperty(property, `${element.offsetWidth}px`)
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(element)
    return () => {
      observer.disconnect()
      host.style.removeProperty(property)
    }
  }, [ref, property])
}

/** The primary pointer whose press is held (`button` 0, `isPrimary`), or null. */
let heldPress: number | null = null
/** Layout changes waiting for the held press to end, one per owner: a later change replaces an earlier one. */
const afterPress = new Map<object, () => void>()

function releasePress(): void {
  heldPress = null
  // In a later task, after the press's own mouseup and click: their target is the control the press began on.
  setTimeout(() => {
    if (heldPress !== null) return
    const due = [...afterPress.values()]
    afterPress.clear()
    for (const apply of due) apply()
  }, 0)
}

if (typeof document !== 'undefined') {
  // Capture phase, so a handler that stops propagation cannot hide a press from the gate.
  document.addEventListener('pointerdown', (event) => {
    if (event.isPrimary && event.button === 0) heldPress = event.pointerId
  }, true)
  const release = (event: PointerEvent) => { if (event.pointerId === heldPress) releasePress() }
  document.addEventListener('pointerup', release, true)
  document.addEventListener('pointercancel', release, true)
  // A press can end where the page cannot see it (another window takes the focus).
  window.addEventListener('blur', () => { if (heldPress !== null) releasePress() })
}

/** Runs `apply` now, or once the held primary press ends, so no control moves under a finger or a held button. */
function whenNoPress(owner: object, apply: () => void): void {
  if (heldPress !== null) {
    afterPress.set(owner, apply)
    return
  }
  afterPress.delete(owner)
  apply()
}

/**
 * An app-wide notice's own row below the title bar. Everything that starts
 * under the title bar (rails, dock, tool cards, chips, the start screen) is
 * placed from `--chrome-rail-top`, so the row lowers that line on its
 * container while it shows instead of covering controls; fitting and chips
 * keep below it too. It reserves again when it resizes and when `top`, where
 * it is placed (the title bar's bottom), changes: a moved row resizes nothing.
 * A row that comes, goes or resizes during a held primary press moves the line
 * once the press ends, so the press's pointerup lands on the control it began on.
 */
export function useChromeRow(ref: RefObject<HTMLElement | null>, top?: number | null): void {
  useMapOccluder(ref, 'top')
  const reserveRow = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    const row = ref.current
    const host = row?.parentElement
    if (!row || !host) return
    const owner = {}
    const reserve = () => whenNoPress(owner, () => {
      host.style.setProperty('--chrome-rail-top', `calc(${row.offsetTop + row.offsetHeight}px + var(--space-2))`)
      // The rails moved without resizing; measure the room they have again.
      refreshVisibleMapArea()
    })
    reserve()
    reserveRow.current = reserve
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reserve)
    observer?.observe(row)
    return () => {
      reserveRow.current = null
      observer?.disconnect()
      whenNoPress(owner, () => {
        host.style.removeProperty('--chrome-rail-top')
        refreshVisibleMapArea()
      })
    }
  }, [ref])
  // Moved in place, not remounted: focus and the live region stay. The first run is the mount's reserve above.
  const placedTop = useRef(top)
  useLayoutEffect(() => {
    if (placedTop.current === top) return
    placedTop.current = top
    reserveRow.current?.()
  }, [top])
}
