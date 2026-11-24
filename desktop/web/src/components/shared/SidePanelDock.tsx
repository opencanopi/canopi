import type { ComponentChildren } from 'preact'
import { useFocusRegion } from './useFocusRegion'
import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import { sidePanelWidth } from '../../app/settings/state'
import { commitSidePanelWidth } from '../../app/shell/controller'
import { DOCK_KEY_REGION } from '../../app/keyboard/target-class'
import { t } from '../../i18n'
import { usePointerResize } from './usePointerResize'
import { useMapOccluder } from './useMapChrome'
import type { MapOccluderSide } from '../../app/shell/visible-map-area'
import styles from './SidePanelDock.module.css'

const MIN_SIDEBAR_WIDTH = 320
const DEFAULT_SIDEBAR_WIDTH = 380
const DEFAULT_WIDE_SIDEBAR_WIDTH = 440
const MAX_SIDEBAR_RATIO = 0.9
const MAX_EXPANDED_SIDEBAR_WIDTH = 800
const KEYBOARD_RESIZE_STEP = 20
/** SidePanelDock.module.css's bottom-sheet query: below it a responsive edition's dock is a sheet at the bottom. */
const BOTTOM_SHEET_QUERY = '(max-width: 760px)'

interface SidebarResizeSession {
  readonly panel: HTMLDivElement
  readonly startX: number
  readonly startWidth: number
  readonly previousInlineWidth: string
}

/**
 * The floating dock beside the panel rail: one panel at a time, 380 px wide
 * (440 px for Site data, Budget, Consortium and Stories) until the user resizes it. Narrow
 * responsive editions turn it into a bottom sheet.
 */
export function SidePanelDock({
  children,
  responsive = false,
  wide = false,
  expanded = false,
  onManualResize,
}: {
  readonly children: ComponentChildren
  readonly responsive?: boolean
  readonly wide?: boolean
  readonly expanded?: boolean
  readonly onManualResize?: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useMapOccluder(panelRef, useDockSide(responsive))
  useFocusRegion(panelRef, 'dock')
  const width = sidePanelWidth.value
  const baseWidth = width === null ? `${wide ? DEFAULT_WIDE_SIDEBAR_WIDTH : DEFAULT_SIDEBAR_WIDTH}px` : `${width}px`
  return (
    <div
      ref={panelRef}
      className={`${styles.dock} ${responsive ? styles.responsive : ''}`}
      data-dock-width={wide ? 'wide' : 'default'}
      data-key-region={DOCK_KEY_REGION}
      style={{
        '--side-panel-width': expanded
          ? `max(${baseWidth}, min(${MAX_EXPANDED_SIDEBAR_WIDTH}px, 90%))`
          : baseWidth,
      } as Record<string, string>}
    >
      <SidePanelResizeHandle panelRef={panelRef} onManualResize={onManualResize} />
      <div className={styles.panel}>{children}</div>
    </div>
  )
}

/**
 * The map edge the dock covers: the right, beside the panel rail, however wide
 * it grows (the expanded calendar is wider than the inferred-band share); the
 * bottom while a responsive edition shows it as the bottom sheet.
 */
function useDockSide(responsive: boolean): MapOccluderSide {
  const [sheet, setSheet] = useState(() => bottomSheetQuery(responsive)?.matches ?? false)
  useLayoutEffect(() => {
    const query = bottomSheetQuery(responsive)
    const update = () => setSheet(query?.matches ?? false)
    update()
    query?.addEventListener('change', update)
    return () => query?.removeEventListener('change', update)
  }, [responsive])
  return sheet ? 'bottom' : 'right'
}

function bottomSheetQuery(responsive: boolean): MediaQueryList | null {
  return responsive && typeof window.matchMedia === 'function' ? window.matchMedia(BOTTOM_SHEET_QUERY) : null
}

function SidePanelResizeHandle({
  panelRef,
  onManualResize,
}: {
  panelRef: { current: HTMLDivElement | null }
  onManualResize?: () => void
}) {
  const onPointerDown = usePointerResize<SidebarResizeSession>({
    cursor: 'col-resize',
    begin: (event) => {
      const panel = panelRef.current
      if (!panel) return null
      return {
        panel,
        startX: event.clientX,
        startWidth: currentSidebarWidth(panel),
        previousInlineWidth: panel.style.width,
      }
    },
    preview: (session, event) => {
      const width = resolveSidebarWidth(session, event.clientX)
      session.panel.style.width = `${width}px`
      return width !== session.startWidth
    },
    commit: (session, event) => {
      onManualResize?.()
      commitSidePanelWidth(resolveSidebarWidth(session, event.clientX))
      // The setting now drives --side-panel-width; a leftover inline width
      // would override it and freeze later keyboard or Expand resizes.
      session.panel.style.width = session.previousInlineWidth
    },
    rollback: (session) => {
      session.panel.style.width = session.previousInlineWidth
    },
  })

  return (
    <div
      onPointerDown={onPointerDown}
      className={styles.dragHandle}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        const panel = panelRef.current
        if (!panel) return
        event.preventDefault()
        onManualResize?.()
        const width = currentSidebarWidth(panel)
          + (event.key === 'ArrowLeft' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP)
        commitSidePanelWidth(
          Math.max(
            MIN_SIDEBAR_WIDTH,
            Math.min(window.innerWidth * MAX_SIDEBAR_RATIO, width),
          ),
        )
      }}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={Math.max(MIN_SIDEBAR_WIDTH, Math.floor(window.innerWidth * MAX_SIDEBAR_RATIO))}
      aria-valuenow={Math.round(sidePanelWidth.value ?? DEFAULT_SIDEBAR_WIDTH)}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('sidebar.resize')}
    />
  )
}

function currentSidebarWidth(panel: HTMLDivElement): number {
  const measured = panel.getBoundingClientRect().width
  if (Number.isFinite(measured) && measured > 0) return measured
  return sidePanelWidth.peek() ?? DEFAULT_SIDEBAR_WIDTH
}

function resolveSidebarWidth(
  session: SidebarResizeSession,
  clientX: number,
): number {
  // Right-side dock: dragging left widens it.
  const delta = session.startX - clientX
  const maxWidth = Math.floor(window.innerWidth * MAX_SIDEBAR_RATIO)
  return Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(maxWidth, session.startWidth + delta),
  )
}
