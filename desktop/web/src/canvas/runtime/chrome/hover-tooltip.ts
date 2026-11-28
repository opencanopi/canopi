// canvas/runtime/chrome/hover-tooltip.ts
//
// Owns the plant tooltip of the ToolHost's passive hover (ToolHostDeps.chrome.setTooltip, spec §1.4): the plant's common and
// scientific names beside the pointer, with the look it had before v2 (at a4c86d39). It is drawn in the window-level
// hover card layer (utils/tooltip-layer.ts), so no frame over the map covers it, every full-window surface covers it and
// it hides while any menu, popover or dialog is open (styles/global.css), and kept inside the window; the element joins the layer at its first
// show, so a map whose tools never show it adds none.

import { hoverCardLayer } from '../../../utils/tooltip-layer'
import { CANVAS_CHROME_FONT_FAMILY } from '../../chrome-fonts'

export interface HoverTooltipController {
  show(screenX: number, screenY: number, title: string | null, subtitle: string, subtitleItalic?: boolean): void
  hide(): void
  dispose(): void
}

const OFFSET_PX = 12
const MAX_WIDTH_PX = 260
/** Its distance from the window's edges. */
const MARGIN_PX = 8

export function createHoverTooltip(container: HTMLElement): HoverTooltipController {
  const el = document.createElement('div')
  el.dataset.hoverTooltip = 'true'
  el.dataset.canvasChrome = 'hover-tooltip'
  el.style.cssText = [
    'position: absolute',
    'pointer-events: none',
    'display: none',
    'padding: var(--space-1) var(--space-2)',
    'background: var(--color-surface)',
    'border: 1px solid var(--color-border)',
    'border-radius: var(--radius-md)',
    'white-space: nowrap',
    `max-width: ${MAX_WIDTH_PX}px`,
    `font-family: ${CANVAS_CHROME_FONT_FAMILY}`,
  ].join(';')

  const commonEl = document.createElement('div')
  commonEl.style.cssText = [
    'font-weight: 600',
    'font-size: var(--text-sm)',
    'color: var(--color-text)',
    'overflow: hidden',
    'text-overflow: ellipsis',
  ].join(';')

  const scientificEl = document.createElement('div')
  scientificEl.style.cssText = [
    'font-style: italic',
    'font-size: var(--text-xs)',
    'color: var(--color-text-muted)',
  ].join(';')

  el.appendChild(commonEl)
  el.appendChild(scientificEl)

  return {
    show(screenX, screenY, commonName, scientificName, subtitleItalic = true) {
      const layer = hoverCardLayer()
      if (el.parentNode !== layer) layer.appendChild(el)
      commonEl.textContent = commonName || ''
      commonEl.style.display = commonName ? '' : 'none'
      scientificEl.textContent = scientificName
      scientificEl.style.fontStyle = subtitleItalic ? 'italic' : 'normal'

      // Show first so offsetWidth/offsetHeight are accurate for clamping
      el.style.display = 'block'

      // The pointer in window pixels; below and right of it, else on the side with room, then inside the window.
      const origin = container.getBoundingClientRect()
      const pointerX = origin.left + screenX
      const pointerY = origin.top + screenY
      const ew = el.offsetWidth
      const eh = el.offsetHeight
      let x = pointerX + OFFSET_PX
      let y = pointerY + OFFSET_PX
      if (x + ew > window.innerWidth - MARGIN_PX) x = pointerX - ew - OFFSET_PX
      if (y + eh > window.innerHeight - MARGIN_PX) y = pointerY - eh - OFFSET_PX
      x = Math.max(MARGIN_PX, Math.min(x, window.innerWidth - MARGIN_PX - ew))
      y = Math.max(MARGIN_PX, Math.min(y, window.innerHeight - MARGIN_PX - eh))

      el.style.left = `${x}px`
      el.style.top = `${y}px`
    },
    hide() {
      el.style.display = 'none'
    },
    dispose() {
      el.remove()
    },
  }
}
