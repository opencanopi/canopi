// canvas/runtime/chrome/handle-layer.ts
//
// Owns the DOM handles the ToolHost publishes (ToolHostDeps.chrome.setHandles, spec §1.4): each ToolHandle is drawn at its
// anchor projected through the view frame plus its screen offset, and moves with every camera frame ('overlays'). The
// points (zone corners and vertices, guide ends) are a hit box sized by Select (20 px, 44 px after a touch) around an 8 px
// mark that grows under the pointer,
// in the tab order, so Delete can reach a focused corner (focusedHandle), and focus on a handle that goes passes to the
// active one (U37); a polygon edge's midpoint dot is fainter
// (opacity 0.5, a 1 px ring: GeoLibre's edge marker), drawn under the corners and left out of the tab order. The rotate handle is a 28 px button
// in a hit box of its own size or larger (44 px after a touch, Q4), kept inside the visible map area, with its key swallow
// and click stop (handle-layer.test.ts). A handle's readout shows as a chip
// under it, and the active handle (the one dragged, or Select's selected corner) is marked and its mark drawn hollow. Presses on a handle are
// the DOM input source's, which reads data-canvas-handle (input/dom-input-source.ts); the layer listens only on
// its own elements (P6).

import { CANVAS_CHROME_FONT_FAMILY } from '../../chrome-fonts'
import { runCanvasRuntimeCleanups } from '../cleanup'
import type { ToolHandleId } from '../interaction-types'
import type { ToolHandle } from '../tools/draft'
import type { ViewFrame, ViewFrameSource } from '../../../geo/view/types'

export interface HandleLayerOptions {
  readonly container: HTMLElement
  readonly frames: ViewFrameSource
}

export interface HandleLayer {
  setHandles(handles: readonly ToolHandle[], active: ToolHandleId | null): void
  /** The handle that holds keyboard focus, or null. */
  focusedHandle(): ToolHandleId | null
  dispose(): void
}

interface DrawnHandle {
  handle: ToolHandle
  readonly element: HTMLElement
  readonly readout: HTMLElement
  /** A point's mark; the rotate button has none. */
  readonly mark: HTMLElement | null
}

const POINT_MARK_SIZE_PX = 8
const POINT_RING_PX = 2
const MIDPOINT_RING_PX = 1
const MIDPOINT_OPACITY = '0.5'
const POINT_Z_INDEX = 29
/** Under the corners, so a corner wins where its target meets a dot's. */
const MIDPOINT_Z_INDEX = 28
const ROTATE_SIZE_PX = 28
const ROTATE_Z_INDEX = 27
/** The rotate button's distance from the visible map area's edge. */
const ROTATE_MARGIN_PX = 8
const SVG_NS = 'http://www.w3.org/2000/svg'

export function createHandleLayer(options: HandleLayerOptions): HandleLayer {
  const root = document.createElement('div')
  root.dataset.canvasHandleLayer = 'true'
  Object.assign(root.style, {
    position: 'absolute',
    inset: '0',
    display: 'none',
    pointerEvents: 'none',
  })
  const drawn = new Map<string, DrawnHandle>()
  let active: ToolHandleId | null = null
  let stopFollowing: () => void
  options.container.appendChild(root)
  try {
    stopFollowing = options.frames.onViewFrame('overlays', (frame) => placeAll(frame))
  } catch (error) {
    root.remove()
    throw error
  }

  function setHandles(handles: readonly ToolHandle[], next: ToolHandleId | null): void {
    active = next
    const kept = new Set(handles.map((handle) => handle.id as string))
    const focusedId = focusedHandle()
    for (const [handleId, entry] of drawn) {
      if (kept.has(handleId)) continue
      entry.element.remove()
      drawn.delete(handleId)
    }
    const frame = options.frames.viewFrame.peek()
    for (const handle of handles) {
      const existing = drawn.get(handle.id)
      const entry = existing && existing.handle.glyph === handle.glyph ? existing : draw(handle)
      if (entry !== existing) {
        existing?.element.remove()
        drawn.set(handle.id, entry)
      }
      entry.handle = handle
      decorate(entry)
      place(entry, frame)
      if (entry.element.parentNode !== root) root.appendChild(entry.element)
    }
    root.style.display = handles.length > 0 ? 'block' : 'none'
    // Focus on a handle that went passes to the active one: Delete on a focused corner goes on with the next (U37).
    const focusNext = focusedId !== null && !kept.has(focusedId) && next !== null ? drawn.get(next) : undefined
    focusNext?.element.focus()
  }

  function focusedHandle(): ToolHandleId | null {
    const focused = root.ownerDocument.activeElement
    if (!(focused instanceof HTMLElement) || !root.contains(focused)) return null
    return (focused.dataset.canvasHandle as ToolHandleId | undefined) ?? null
  }

  function placeAll(frame: ViewFrame): void {
    for (const entry of drawn.values()) place(entry, frame)
  }

  function decorate({ handle, element, readout, mark }: DrawnHandle): void {
    element.dataset.canvasHandle = handle.id
    element.dataset.canvasHandleGlyph = handle.glyph
    element.setAttribute('aria-label', handle.label)
    const isActive = handle.id === active
    if (isActive) element.dataset.canvasHandleActive = 'true'
    else delete element.dataset.canvasHandleActive
    if (isRotate(handle)) element.style.cursor = isActive ? 'grabbing' : 'grab'
    if (mark) {
      mark.style.background = isActive ? 'var(--color-surface)' : 'var(--color-primary)'
      mark.style.borderColor = isActive ? 'var(--color-primary)' : 'var(--color-surface)'
    }
    readout.textContent = handle.readout ?? ''
    readout.style.display = handle.readout ? 'inline-flex' : 'none'
  }

  return {
    setHandles,
    focusedHandle,
    dispose() {
      runCanvasRuntimeCleanups([
        () => stopFollowing(),
        () => root.remove(),
      ], 'Handle layer disposal failed')
      drawn.clear()
    },
  }
}

function draw(handle: ToolHandle): DrawnHandle {
  return isRotate(handle) ? drawRotate(handle) : drawPoint(handle)
}

/** A point: a transparent hit box around a mark that grows under the pointer; a midpoint's mark is fainter and thinner. */
function drawPoint(handle: ToolHandle): DrawnHandle {
  const midpoint = handle.glyph === 'midpoint'
  const element = document.createElement('div')
  element.setAttribute('role', 'button')
  element.tabIndex = midpoint ? -1 : 0
  Object.assign(element.style, {
    position: 'absolute',
    zIndex: String(midpoint ? MIDPOINT_Z_INDEX : POINT_Z_INDEX),
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    border: '0',
    borderRadius: 'var(--radius-full)',
    background: 'transparent',
    cursor: 'grab',
    pointerEvents: 'auto',
    touchAction: 'none',
    userSelect: 'none',
  })
  const mark = document.createElement('span')
  Object.assign(mark.style, {
    width: `${POINT_MARK_SIZE_PX}px`,
    height: `${POINT_MARK_SIZE_PX}px`,
    display: 'block',
    borderWidth: `${midpoint ? MIDPOINT_RING_PX : POINT_RING_PX}px`,
    borderStyle: 'solid',
    borderColor: 'var(--color-surface)',
    borderRadius: 'var(--radius-full)',
    background: 'var(--color-primary)',
    boxSizing: 'border-box',
    ...(midpoint ? { opacity: MIDPOINT_OPACITY } : {}),
  })
  element.appendChild(mark)
  element.addEventListener('pointerenter', () => {
    mark.style.transform = 'scale(1.35)'
  })
  element.addEventListener('pointerleave', () => {
    mark.style.transform = ''
  })
  const readout = createReadout()
  element.appendChild(readout)
  return { handle, element, readout, mark }
}

/** The rotation handle: a 28 px round button centred in its transparent hit box (44 px after a touch, Q4), the box
 *  swallowing keys and clicks, so neither reaches the map; its readout hangs under the button. */
function drawRotate(handle: ToolHandle): DrawnHandle {
  const element = document.createElement('div')
  element.setAttribute('role', 'button')
  element.tabIndex = -1
  Object.assign(element.style, {
    position: 'absolute',
    zIndex: String(ROTATE_Z_INDEX),
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    borderRadius: 'var(--radius-full)',
    cursor: 'grab',
    pointerEvents: 'auto',
    touchAction: 'none',
    userSelect: 'none',
  })
  const button = document.createElement('span')
  Object.assign(button.style, {
    position: 'relative',
    width: `${ROTATE_SIZE_PX}px`,
    height: `${ROTATE_SIZE_PX}px`,
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0',
    background: 'var(--color-primary)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'var(--color-primary-hover)',
    borderRadius: 'var(--radius-full)',
    boxShadow: 'var(--shadow-md)',
    boxSizing: 'border-box',
    color: 'var(--color-primary-contrast)',
    outlineWidth: '2px',
    outlineStyle: 'solid',
    outlineColor: 'var(--color-surface)',
    outlineOffset: '1px',
  })
  button.appendChild(createRotateIcon())
  const readout = createReadout()
  button.appendChild(readout)
  element.appendChild(button)
  element.addEventListener('click', (event) => event.stopPropagation())
  element.addEventListener('keydown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  return { handle, element, readout, mark: null }
}

/** The rotate handle's readout chip ('+15°'), under its handle. */
function createReadout(): HTMLElement {
  const readout = document.createElement('span')
  readout.dataset.canvasHandleReadout = 'true'
  readout.setAttribute('aria-hidden', 'true')
  Object.assign(readout.style, {
    position: 'absolute',
    left: '50%',
    top: 'calc(100% + var(--space-1))',
    display: 'none',
    minWidth: '42px',
    justifyContent: 'center',
    padding: 'var(--space-1) var(--space-2)',
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border-strong, var(--color-border))',
    borderRadius: 'var(--radius-sm)',
    boxShadow: 'var(--shadow-sm)',
    boxSizing: 'border-box',
    color: 'var(--color-text)',
    fontFamily: CANVAS_CHROME_FONT_FAMILY,
    fontSize: 'var(--text-xs)',
    fontWeight: '600',
    lineHeight: '1.2',
    transform: 'translateX(-50%)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  })
  return readout
}

/** Centred on the anchor's screen point plus its offset; the rotate button stays inside the visible map area. */
function place({ handle, element }: DrawnHandle, frame: ViewFrame): void {
  const anchor = frame.view.worldToScreen(handle.anchor)
  const centre = { x: anchor.x + (handle.offsetPx?.x ?? 0), y: anchor.y + (handle.offsetPx?.y ?? 0) }
  const size = isRotate(handle) ? Math.max(ROTATE_SIZE_PX, handle.hitRadiusPx * 2) : handle.hitRadiusPx * 2
  let left = centre.x - size / 2
  let top = centre.y - size / 2
  if (isRotate(handle)) {
    const { insets, view } = frame
    const minLeft = insets.left + ROTATE_MARGIN_PX
    const minTop = insets.top + ROTATE_MARGIN_PX
    left = clamp(left, minLeft, Math.max(minLeft, view.screen.width - insets.right - size - ROTATE_MARGIN_PX))
    top = clamp(top, minTop, Math.max(minTop, view.screen.height - insets.bottom - size - ROTATE_MARGIN_PX))
  }
  element.dataset.canvasHandleScreenX = String(anchor.x)
  element.dataset.canvasHandleScreenY = String(anchor.y)
  Object.assign(element.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${size}px`,
    height: `${size}px`,
  })
}

function isRotate(handle: ToolHandle): boolean {
  return handle.glyph === 'rotate'
}

function createRotateIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M15 8a5 5 0 10-1.5 3.6M15 8h-4M15 8V4')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.8')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(path)
  return svg
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
