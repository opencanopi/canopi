import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { PrintBounds, PrintPoint } from '../../canvas/print'
import type { PdfPage, PdfPlan } from '../../app/canvas-pdf/types'
import { areaFromFrame, pageFrame } from '../../app/canvas-pdf/page-frame'
import { detectPlatform } from '../../canvas/runtime/input/platform'
import { t } from '../../i18n'
import { PdfPageArtwork } from './PdfPagePreview'

interface EditorProps {
  readonly page: PdfPage
  readonly plan: PdfPlan
  readonly adding?: boolean
  readonly disabled?: boolean
  readonly inspecting?: boolean
  readonly navigationOnly?: boolean
  readonly highlightedPage?: string | null
  /** Find in key: the matching key entries on this page, ringed. */
  readonly keyMatches?: readonly PrintBounds[]
  /** The entry Find in key showed last, ringed more strongly and scrolled into view. */
  readonly keyCurrent?: PrintBounds | null
  /** The drawn area in plan metres: an unturned box about its centre (`PdfPrintArea`). */
  readonly onPrintArea?: (bounds: PrintBounds) => void
  readonly onPage?: (id: string) => void
  /** Delta of the view centre in plan metres, committed once per completed gesture or arrow press. */
  readonly onMove?: (delta: PrintPoint) => void
  /** Cmd is mod on a Mac, else Ctrl; defaults to the browser's platform. */
  readonly mac?: boolean
}
interface Gesture {
  readonly start: PrintPoint
  readonly pointerId: number
  readonly bounds: DOMRect
  readonly pageId?: string
}
export function PdfPageEditor({ page, plan, adding = false, disabled = false, inspecting = false, navigationOnly = false, highlightedPage,
  keyMatches = NO_KEY_MATCHES, keyCurrent = null, onPrintArea, onPage, onMove, mac = MAC }: EditorProps) {
  const root = useRef<SVGSVGElement>(null)
  const currentKeyMatch = useRef<SVGRectElement>(null)
  useEffect(() => {
    currentKeyMatch.current?.scrollIntoView?.({ block: 'center', inline: 'center' })
  }, [keyCurrent?.x, keyCurrent?.y, page.id, inspecting])
  const drag = useRef<Gesture | null>(null)
  const [selection, setSelection] = useState<PrintBounds | null>(null)
  const clipId = useId()
  // Page grounds are in the layout's turned frame; what the editor reports goes back to plan metres.
  const frame = pageFrame(plan.angleDeg)
  const move = (x: number, y: number) => onMove?.(frame.fromFrame({ x: x / page.pointsPerMeter, y: y / page.pointsPerMeter }))
  const interactive = !disabled && !inspecting && page.kind !== 'legend'
  function cancel() {
    const previous = drag.current; drag.current = null; setSelection(null)
    root.current?.style.removeProperty('--pdf-drag-x'); root.current?.style.removeProperty('--pdf-drag-y')
    if (previous && root.current?.hasPointerCapture(previous.pointerId)) root.current.releasePointerCapture(previous.pointerId)
  }
  // A new plan, mode, or unmount cancels gestures against the old geometry. A layout effect, so the unmount cancel
  // still has the element (Preact 11 runs useEffect cleanups after paint, once refs are null).
  useLayoutEffect(() => { cancel(); return cancel }, [page, adding, disabled, inspecting, navigationOnly])
  function point(event: PointerEvent, bounds: DOMRect): PrintPoint {
    const scale = Math.min(bounds.width / page.width, bounds.height / page.height)
    return { x: (event.clientX - bounds.left - (bounds.width - page.width * scale) / 2) / scale,
      y: (event.clientY - bounds.top - (bounds.height - page.height * scale) / 2) / scale }
  }
  function rectangle(end: PrintPoint): PrintBounds {
    const start = drag.current!.start
    const x = Math.max(page.frame.x, Math.min(page.frame.x + page.frame.width, end.x))
    const y = Math.max(page.frame.y, Math.min(page.frame.y + page.frame.height, end.y))
    return { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) }
  }
  function pointerDown(event: PointerEvent) {
    if (!interactive || event.button !== 0 || drag.current) return
    const bounds = root.current!.getBoundingClientRect(), start = point(event, bounds)
    if (![start.x, start.y].every(Number.isFinite) || start.x < page.frame.x || start.x > page.frame.x + page.frame.width
      || start.y < page.frame.y || start.y > page.frame.y + page.frame.height) return
    const target = event.target instanceof Element ? event.target : null
    if (navigationOnly && !target?.getAttribute('data-pdf-target')) return
    event.preventDefault(); event.stopPropagation(); root.current!.focus()
    drag.current = { start, bounds, pointerId: event.pointerId,
      pageId: target?.getAttribute('data-pdf-target') ?? undefined }
    root.current!.setPointerCapture(event.pointerId)
  }
  function pointerMove(event: PointerEvent) {
    const gesture = drag.current
    if (!gesture || gesture.pointerId !== event.pointerId || navigationOnly) return
    event.preventDefault()
    const end = point(event, gesture.bounds)
    if (adding) setSelection(rectangle(end))
    else {
      root.current!.style.setProperty('--pdf-drag-x', `${end.x - gesture.start.x}px`)
      root.current!.style.setProperty('--pdf-drag-y', `${end.y - gesture.start.y}px`)
    }
  }
  function pointerUp(event: PointerEvent) {
    const gesture = drag.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const end = point(event, gesture.bounds), bounds = rectangle(end)
    const scale = Math.min(gesture.bounds.width / page.width, gesture.bounds.height / page.height)
    const moved = Math.hypot(end.x - gesture.start.x, end.y - gesture.start.y) * scale >= 4
    cancel()
    if (!moved) { if (!adding && gesture.pageId) onPage?.(gesture.pageId); return }
    if (navigationOnly) return
    if (adding) {
      if (bounds.width < 2 || bounds.height < 2) return
      onPrintArea?.(areaFromFrame(frame, { x: page.ground.x + (bounds.x - page.frame.x) / page.pointsPerMeter,
        y: page.ground.y + (bounds.y - page.frame.y) / page.pointsPerMeter,
        width: bounds.width / page.pointsPerMeter, height: bounds.height / page.pointsPerMeter }))
    } else move(gesture.start.x - end.x, gesture.start.y - end.y)
  }
  return <svg ref={root} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${page.width} ${page.height}`}
    role="group" tabindex={0} aria-label={t('pdf.pageCount', { page: page.number, count: plan.pages.length })}
    aria-describedby="pdf-editor-hint" data-pdf-editor data-pdf-page={page.number}
    width={inspecting ? page.width * 2 : '100%'} height={inspecting ? page.height * 2 : '100%'}
    style={{ touchAction: interactive ? 'none' : undefined, cursor: interactive && !navigationOnly ? adding ? 'crosshair' : 'grab' : undefined }}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancel} onLostPointerCapture={cancel}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); cancel(); return }
      // Arrows move the content their way, as a drag does (U12); mod is the large step, and Shift, Alt and the other
      // of Ctrl and Cmd do nothing (spec §4.12).
      const mod = mac ? event.metaKey : event.ctrlKey, other = mac ? event.ctrlKey : event.metaKey
      if (!interactive || navigationOnly || adding || event.altKey || event.shiftKey || other) return
      const delta = mod ? 30 : 5
      const direction = { ArrowLeft: [delta, 0], ArrowRight: [-delta, 0], ArrowUp: [0, delta], ArrowDown: [0, -delta] }[event.key]
      if (direction) { event.preventDefault(); move(direction[0]!, direction[1]!) }
    }}>
    <desc>{page.legend.map((entry) => entry.name).join('; ')}</desc>
    <PdfPageArtwork page={page} plan={plan} />
    <defs><clipPath id={clipId}><rect {...page.frame} /></clipPath></defs>
    <g clip-path={`url(#${clipId})`}>
      {!adding && page.kind === 'overview' && plan.pages.filter((detail) => detail.kind === 'detail').map((detail) => <rect key={detail.id}
        x={page.frame.x + (detail.ground.x - page.ground.x) * page.pointsPerMeter} y={page.frame.y + (detail.ground.y - page.ground.y) * page.pointsPerMeter}
        width={detail.ground.width * page.pointsPerMeter} height={detail.ground.height * page.pointsPerMeter} data-pdf-target={detail.id}
        fill={highlightedPage === detail.id ? 'var(--color-primary-bg)' : 'transparent'} stroke={highlightedPage === detail.id ? 'var(--color-primary)' : 'none'} stroke-width="2"
        style={{ pointerEvents: interactive ? 'all' : 'none', cursor: 'pointer', transform: 'translate(var(--pdf-drag-x, 0px), var(--pdf-drag-y, 0px))' }}>
        <title>{detail.areaName}</title></rect>)}
      {selection && <rect data-print-area-draft {...selection} fill="var(--color-primary-bg)" stroke="var(--color-primary)" stroke-width="1" stroke-dasharray="4 2" pointer-events="none" />}
    </g>
    {keyMatches.map((bounds) => {
      const current = keyCurrent !== null && bounds.x === keyCurrent.x && bounds.y === keyCurrent.y
      return <rect key={`${bounds.x}:${bounds.y}`} ref={current ? currentKeyMatch : undefined} data-pdf-key-match={current ? 'current' : 'match'}
        x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} rx="2"
        fill={current ? 'var(--color-accent-soft)' : 'none'} stroke="var(--color-accent)" stroke-width={current ? 2 : 1}
        vector-effect="non-scaling-stroke" pointer-events="none" />
    })}
  </svg>
}

const NO_KEY_MATCHES: readonly PrintBounds[] = []
const MAC = typeof navigator !== 'undefined'
  && ['mac', 'ios'].includes(detectPlatform(navigator, window as unknown as { readonly GestureEvent?: unknown }).os)
