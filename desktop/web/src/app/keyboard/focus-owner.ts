// app/keyboard/focus-owner.ts
// Owner of focus moves outside modals (§18 F34, ADR 0020). Invariant: no other module moves focus between regions.
//
// The one owner of focus moves outside modals (spec §1.6, ADR 0020): the workspace's F6 regions (the title bar, the
// tool rail, the map and the open dock panel, registered while mounted through components/shared/useFocusRegion.ts),
// the map's focus after arming, a drop, a closed chooser or menu, a story's end or a tool's request (the runtime's
// CanvasFocusPort, passed by app/canvas-runtime/app-adapter.ts), and the first field of a component a user opened.
// F6 moves to the next showing region, Shift+F6 to the previous one, returning to the control last focused there (else
// the region's own tab stop); the map is always entered at its host. Focus after a modal closes stays with useModalLayer.

import type { CanvasFocusPort } from '../../canvas/runtime/app-adapter'
import { currentCanvasKeyboardPort } from '../../canvas/session'
import { modalLayerOpen } from '../shell/modal-layer'

export type FocusRegion = 'title-bar' | 'tool-rail' | 'map' | 'dock'

export interface FocusOwner extends CanvasFocusPort {
  /** The map host itself, never a control inside it. */
  focusMap(): void
  /** A component opened by a user action focuses its first field through here; content-derived UI cannot. */
  focusOnOpen(el: HTMLElement): void
  /** A mounted region; returns its release. */
  registerRegion(region: FocusRegion, el: HTMLElement): () => void
  /** F6 (1) and Shift+F6 (-1); false while the modal layer is held or no other region shows. */
  cycleRegion(step: 1 | -1): boolean
}

const ORDER: readonly FocusRegion[] = ['title-bar', 'tool-rail', 'map', 'dock']
const FOCUSABLE = [
  '[tabindex="0"]',
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
].join(',')

const regions = new Map<FocusRegion, HTMLElement>()
const lastFocused = new WeakMap<HTMLElement, HTMLElement>()

function focusTarget(region: HTMLElement): HTMLElement | null {
  const last = lastFocused.get(region)
  if (last && region.contains(last) && showing(last) && last.matches(FOCUSABLE)) return last
  if (region.tabIndex >= 0 && region.hasAttribute('tabindex')) return region
  for (const candidate of region.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (showing(candidate)) return candidate
  }
  return null
}

function enter(region: FocusRegion): boolean {
  const element = regions.get(region)
  if (!element || !showing(element)) return false
  // The map is entered at its host, never a control inside it (a handle), so the canvas keys reach it.
  const target = region === 'map' ? element : focusTarget(element)
  if (!target) return false
  target.focus({ preventScroll: true })
  return document.activeElement === target
}

/** The app's focus owner; both editions' key routers and the canvas runtime share it. */
export const focusOwner: FocusOwner = {
  focusMap() {
    const region = regions.get('map')
    // A map that registered no region (a detached test runtime) is focused at the live canvas's host.
    const host = region && showing(region) ? region : currentCanvasKeyboardPort()?.host ?? null
    host?.focus({ preventScroll: true })
  },
  focusOnOpen(el) {
    if (!el.isConnected || el.closest('[inert]') !== null) return
    el.focus({ preventScroll: true })
  },
  registerRegion(region, element) {
    regions.set(region, element)
    const remember = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== element) lastFocused.set(element, event.target)
    }
    element.addEventListener('focusin', remember)
    return () => {
      element.removeEventListener('focusin', remember)
      if (regions.get(region) === element) regions.delete(region)
    }
  },
  cycleRegion(step) {
    if (modalLayerOpen.peek()) return false
    const active = document.activeElement
    const current = ORDER.findIndex((id) => {
      const element = regions.get(id)
      return !!element && active instanceof Node && element.contains(active)
    })
    for (let offset = 1; offset <= ORDER.length; offset += 1) {
      const start = current < 0 ? (step === 1 ? -1 : 0) : current
      const index = (start + step * offset + ORDER.length * 2) % ORDER.length
      if (index === current) continue
      if (enter(ORDER[index]!)) return true
    }
    return false
  },
}

/** Rendered and not inert: an ancestor's display:none hides a control too (the compact title bar's Menu button). */
function showing(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[inert]') !== null) return false
  if (typeof element.checkVisibility === 'function') return element.checkVisibility()
  // Engines without checkVisibility (and jsdom): no element up to the root is hidden or display:none.
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || getComputedStyle(node).display === 'none') return false
  }
  return true
}
