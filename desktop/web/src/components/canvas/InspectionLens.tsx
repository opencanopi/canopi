import { SurfaceHeader } from '../shared/SurfaceHeader'
import type { ReadonlySignal } from '@preact/signals'
import { createPortal, type RefObject } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { signal, useSignal } from '@preact/signals'
import type { CanvasInspectionHandle, InspectionSourceQuad } from '../../canvas/inspection'
import { detectPlatform, modKeyIsCmd } from '../../canvas/runtime/input/platform'
import type { CanvasDocumentSurface, CanvasQuerySurface } from '../../canvas/runtime/runtime'
import { currentCanvasDocumentSurface, currentCanvasQuerySurface } from '../../canvas/session'
import { modKeyName } from '../../app/shell-commands/shortcut-text'
import { phoneLayout } from '../../app/shell/phone-layout'
import { leftChromeCrowdsMap, visibleMapFrame } from '../../app/shell/visible-map-area'
import { t } from '../../i18n'
import { ControlIcon } from '../shared/ControlIcon'
import { ButtonTooltip } from '../shared/ButtonTooltip'
import { useCoarsePointer } from '../shared/useCoarsePointer'
import { useMapOccluder, useUnderRail } from '../shared/useMapChrome'
import styles from './InspectionLens.module.css'

/** The lens's arrow steps in preview pixels: plain, and with mod (Cmd on macOS, else Ctrl; spec §4.13). */
const ARROW_STEP_PX = 20
const LARGE_ARROW_STEP_PX = 60
const MOD_IS_CMD = typeof navigator !== 'undefined'
  && modKeyIsCmd(detectPlatform(navigator, window as unknown as { readonly GestureEvent?: unknown }))

/**
 * The hollow crosshair on the preview's centre, the inspected point: four arms 4 px clear of the centre, so the point
 * itself stays visible. inspection-layout.ts keeps plant names off it.
 */
const CENTRE_MARK = 'M0 -10V-4M0 4V10M-10 0H-4M4 0H10'

/** Whether the lens is open: its one launcher (floating, or on a phone a button of the zoom column) toggles it. */
const lensOpen = signal(false)
/** The one lens panel, which its launcher controls. */
const LENS_PANEL_ID = 'canopi-inspection-lens'

/**
 * The inspection lens and, beside the zoom group under the panel rail, its launcher; on a phone the launcher is a
 * button of the zoom column (ZoomControls), so nothing but the column floats there (answer 25).
 */
export function InspectionLens({ canvasRef }: { canvasRef: RefObject<HTMLDivElement | null> }) {
  const documents = currentCanvasDocumentSurface.value
  const queries = currentCanvasQuerySurface.value
  const open = lensOpen.value
  const wasOpen = useRef(false)
  // Opening hands focus to the map host, not the lens (U34, canopi-f47t.24): the launcher hides as the lens opens, and the
  // map keeps its arrows and Esc until a click or Tab moves focus into the lens. Closing returns focus to the launcher.
  useLayoutEffect(() => {
    if (open && !wasOpen.current) canvasRef.current?.focus({ preventScroll: true })
    wasOpen.current = open
  }, [open])
  // A lens left open closes with the Design that showed it.
  useEffect(() => () => { lensOpen.value = false }, [])
  if (!documents || !queries) return null
  return <>
    {phoneLayout.value === null && <InspectionLauncher className={styles.launcher} underRail />}
    {open && <InspectionPanel id={LENS_PANEL_ID} documents={documents} queries={queries} canvasRef={canvasRef} onClose={() => { lensOpen.value = false }} />}
  </>
}

/** The lens's launcher, which hides while the lens is open and takes focus back when it closes. */
export function InspectionLauncher({ className, underRail = false }: {
  readonly className: string | undefined
  /** In the panel rail's column, which ends above it (the floating launcher; the phone's column registers itself). */
  readonly underRail?: boolean
}) {
  const shown = currentCanvasDocumentSurface.value !== null && currentCanvasQuerySurface.value !== null
  const open = lensOpen.value
  const launcher = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(open)
  useLayoutEffect(() => {
    if (wasOpen.current && !open) launcher.current?.focus()
    wasOpen.current = open
  }, [open])
  useUnderRail(launcher, 'panel', underRail && shown)
  if (!shown) return null
  return (
    <button ref={launcher} type="button" className={className} hidden={open} aria-expanded={open} aria-controls={LENS_PANEL_ID}
      data-inspection-launcher aria-label={t('canvas.inspection.title')} onClick={() => { lensOpen.value = !open }}>
      <ControlIcon name="search" size={20} />
      <ButtonTooltip label={t('canvas.inspection.title')} side="left" />
    </button>
  )
}

function InspectionPanel({ id, documents, queries, canvasRef, onClose }: {
  id: string
  documents: CanvasDocumentSurface
  queries: CanvasQuerySurface
  canvasRef: RefObject<HTMLDivElement | null>
  onClose(): void
}) {
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const preview = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLElement>(null)
  const handle = useSignal<CanvasInspectionHandle | null>(null)
  const failed = useSignal(false)
  const coarsePointer = useCoarsePointer()
  // The open panel covers the map's left edge: Home, Fit and framing land right of it (canopi-f47t.28), when it leaves
  // the labelled tool rail's least map width before the right chrome. With less (a phone, a tablet, a window beside the
  // open dock) it stays out, or the chips would squeeze off screen and framing would fall back to the whole window.
  // Measures on every render: the panel also moves without resizing when the tool rail switches between names and icons
  // (the tool card's left follows it), and that switch re-renders the lens through the frame's left edge. Reads only the
  // frame's width and right edge (the map fills the window), so its own cover cannot feed back.
  const frame = visibleMapFrame.value
  const [covers, setCovers] = useState(false)
  useLayoutEffect(() => {
    const edge = panel.current?.getBoundingClientRect().right
    setCovers(edge !== undefined && !leftChromeCrowdsMap(frame, edge))
  })
  useMapOccluder(panel, 'left', covers)
  useLayoutEffect(() => {
    if (!preview.current) return
    let view: CanvasInspectionHandle
    try { view = documents.attachInspectionTo(preview.current) }
    catch (error) { console.error('Unable to open the inspection lens:', error); failed.value = true; return }
    handle.value = view
    const frame = panel.current?.querySelector<HTMLElement>('[data-inspection-frame]')
    let drag: { id: number; x: number; y: number } | null = null
    const stop = () => {
      const previous = drag
      drag = null
      frame?.removeAttribute('data-dragging')
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', end)
      document.removeEventListener('pointercancel', end)
      window.removeEventListener('blur', stop)
      if (previous && frame?.hasPointerCapture?.(previous.id)) {
        try { frame.releasePointerCapture(previous.id) } catch { /* Capture can end during element teardown. */ }
      }
    }
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return
      event.preventDefault()
      view.panByScreen({ x: drag.x - event.clientX, y: drag.y - event.clientY })
      drag.x = event.clientX; drag.y = event.clientY
    }
    const end = (event: PointerEvent) => { if (event.pointerId === drag?.id) stop() }
    const start = (event: PointerEvent) => {
      if (event.button !== 0 || drag || !view.state.peek() || (event.target instanceof Element && event.target.closest('button'))) return
      event.preventDefault(); event.stopPropagation(); frame?.focus()
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY }
      frame?.setAttribute('data-dragging', 'true')
      try { frame?.setPointerCapture(event.pointerId) } catch { /* Document listeners also support hosts without capture. */ }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', end)
      document.addEventListener('pointercancel', end)
      window.addEventListener('blur', stop)
    }
    // The pointer's world point over the map (the interaction session's hovers, not over the canvas's own buttons and
    // fields); the lens keeps its point when the pointer leaves or presses.
    const stopInspecting = queries.subscribePointerWorld((point) => {
      if (drag || !point) return
      view.inspectAtWorldPoint(point.world)
    })
    frame?.addEventListener('pointerdown', start)
    frame?.addEventListener('lostpointercapture', end)
    return () => {
      stop()
      stopInspecting()
      frame?.removeEventListener('pointerdown', start)
      frame?.removeEventListener('lostpointercapture', end)
      handle.value = null; view.dispose()
    }
  }, [documents, queries])
  const state = handle.value?.state.value
  const expandLabel = t(expanded ? 'canvas.inspection.compact' : 'canvas.inspection.expand')
  return <>
    {handle.value && canvasRef.current && <SourceOutline quad={handle.value.sourceQuad} host={canvasRef.current} />}
    <section ref={panel} id={id} className={styles.panel} data-expanded={expanded} aria-label={t('canvas.inspection.title')}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }}>
    <SurfaceHeader title={t('canvas.inspection.title')} closeLabel={t('canvas.inspection.close')} onClose={onClose}
      actions={<button type="button" className={styles.expandButton} aria-label={expandLabel}
        aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
          <path d={expanded ? 'M14 2 9 7m0-4v4h4M2 14l5-5m0 4V9H3' : 'M9 7l5-5m-4 0h4v4M7 9l-5 5m0-4v4h4'} />
        </svg>
        <ButtonTooltip label={expandLabel} side="left" />
      </button>} />
    {/* The preview owns its arrows, Shift+arrows included, so they never turn the map (spec §1.6). Its arrows and drags
        move the lens along its own screen, which turns with the map; mod is the large step, Shift adds nothing. */}
    <div className={styles.preview} data-inspection-frame data-owns-keys="arrows" role="group" tabIndex={0}
      aria-label={t('canvas.inspection.panHint', { mod: modKeyName(t) })}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        const step = (MOD_IS_CMD ? event.metaKey : event.ctrlKey) ? LARGE_ARROW_STEP_PX : ARROW_STEP_PX
        const delta = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 },
          ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } }[event.key]
        if (!delta) return
        event.preventDefault(); event.stopPropagation(); handle.value?.panByScreen(delta)
      }}>
      <div ref={preview} className={styles.artwork} />
      {state && <svg className={styles.connectors} viewBox={`0 0 ${state.frame.width} ${state.frame.height}`} aria-hidden="true">
        {state.plants.map(plant => <g key={plant.id} data-active={highlighted === plant.id}>
          {!state.previewAvailable && <circle cx={plant.screenPosition.x} cy={plant.screenPosition.y} r="4" fill="var(--color-text-muted)" />}
          {plant.label && <line x1={plant.screenPosition.x} y1={plant.screenPosition.y}
            x2={Math.max(plant.label.x, Math.min(plant.label.x + plant.label.width, plant.screenPosition.x))}
            y2={Math.max(plant.label.y, Math.min(plant.label.y + plant.label.height, plant.screenPosition.y))} />}
          {highlighted === plant.id && <circle cx={plant.screenPosition.x} cy={plant.screenPosition.y} r="11" fill="none" stroke="var(--color-primary)" stroke-width="2" />}
        </g>)}
        <g className={styles.centre} data-inspection-centre transform={`translate(${state.frame.width / 2} ${state.frame.height / 2})`}>
          <path className={styles.centreHalo} d={CENTRE_MARK} />
          <path className={styles.centreInk} d={CENTRE_MARK} />
        </g>
      </svg>}
      {state?.plants.map(plant => plant.label && <button key={plant.id} type="button" data-plant-id={plant.id}
        className={styles.plantName} style={{ left: `${plant.label.x}px`, top: `${plant.label.y}px`, width: `${plant.label.width}px`, height: `${plant.label.height}px` }}
        aria-label={t('canvas.inspection.locate', { name: plant.name })}
        onMouseEnter={() => { setHighlighted(plant.id); handle.value?.highlightPlant(plant.id) }}
        onMouseLeave={() => { setHighlighted(null); handle.value?.highlightPlant(null) }}
        onFocusIn={() => { setHighlighted(plant.id); handle.value?.highlightPlant(plant.id) }}
        onFocusOut={() => { setHighlighted(null); handle.value?.highlightPlant(null) }}
        onClick={() => handle.value?.focusPlant(plant.id)}>{plant.label.lines.map((line, i) => <span key={i}>{line}</span>)}</button>)}

    </div>
    {(failed.value || state?.previewAvailable === false) && <p role="status">{t('canvas.inspection.unavailable')}</p>}

    <div className={styles.controls}>
      {/* Read on demand: it changes on every pointer move, so a live region would chatter. */}
      <span aria-live="off">{t('canvas.inspection.namesCount', { shown: state?.plants.filter(plant => plant.label).length ?? 0, total: state?.plants.length ?? 0 })}</span>
      <button type="button" disabled={!handle.value} aria-label={t('canvas.inspection.recenter')} onClick={() => handle.value?.centerOnCanvas()}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="4" stroke="currentColor" /><path d="M8 1v4m0 6v4M1 8h4m6 0h4" stroke="currentColor" /></svg>
        <ButtonTooltip label={t('canvas.inspection.recenter')} side="top" />
      </button>
      <button type="button" disabled={!handle.value} aria-label={t('canvas.inspection.widen')} onClick={() => handle.value?.zoomBy(1 / 1.25)}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 7h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        <ButtonTooltip label={t('canvas.inspection.widen')} side="top" />
      </button>
      {state && <span>{state.zoomPercent}%</span>}
      <button type="button" disabled={!handle.value} aria-label={t('canvas.inspection.magnify')} onClick={() => handle.value?.zoomBy(1.25)}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 3v8M3 7h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        <ButtonTooltip label={t('canvas.inspection.magnify')} side="top" />
      </button>
    </div>
    {state?.plants.length === 0 && <p>{t('canvas.inspection.empty')}</p>}
    <p>{t(coarsePointer ? 'canvas.inspection.hintTouch' : 'canvas.inspection.hint')}</p>
  </section></>
}

/**
 * Where the lens samples, outlined on the main map. Its own component: the quad follows every main-map frame, and only this
 * outline re-renders for it. The four corners are drawn as published, so a turned view needs no change here.
 */
function SourceOutline({ quad, host }: { quad: ReadonlySignal<InspectionSourceQuad | null>; host: HTMLElement }) {
  const corners = quad.value
  if (!corners) return null
  return createPortal(<svg className={styles.source} aria-hidden="true" data-inspection-source>
    <polygon points={corners.map((corner) => `${corner.x},${corner.y}`).join(' ')} />
  </svg>, host)
}
