import type { ComponentChildren } from 'preact'
import { useEffect, useId, useRef } from 'preact/hooks'
import {
  cyclePhoneSheet,
  phoneSheetOpenHeight,
  phoneToolOptions,
  snapPhoneSheet,
  stepPhoneSheet,
  type PhoneLayout,
  type PhoneSheetHeight,
} from '../../app/shell/phone-layout'
import { isSidePanel } from '../../app/shell/state'
import { currentCanvasTool, currentCanvasToolGuidance } from '../../canvas/session-state'
import type { ToolId } from '../../canvas/runtime/tool-id'
import { framingMapFrame } from '../../app/shell/visible-map-area'
import { DOCK_KEY_REGION } from '../../app/keyboard/target-class'
import { t } from '../../i18n'
import { ActionMenu } from './ActionMenu'
import type { PanelRailCommand } from './PanelRail'
import { useFocusRegion } from './useFocusRegion'
import { useMapOccluder, useUnderRail } from './useMapChrome'
import { usePointerResize } from './usePointerResize'
import styles from './PhoneSheet.module.css'
import type { LocaleKey } from '../../generated/locale-keys'

/** Panel tabs shown before More; the rest wait in More, in order. */
export const PHONE_SHEET_TABS = 3
/** A handle press that moves less than this (CSS px) is a tap, not a drag. */
const DRAG_SLOP_PX = 6
/** The gap between the top bar and a full sheet, as `--chrome-rail-top` leaves it. */
const FULL_GAP_PX = 8
/** The tools that draw a draft point by point: while one holds a draft, the sheet drops to its peek (answer 17). */
const DRAWING_TOOLS: ReadonlySet<ToolId> = new Set(['plant-spacing', 'polygon', 'profile'])

interface SheetDrag {
  readonly sheet: HTMLElement
  readonly startY: number
  readonly startSize: number
  readonly startTime: number
  readonly stops: Readonly<Record<PhoneSheetHeight, number>>
  size: number
}

/**
 * The Web Edition's panels on a phone (board WebPhone): a sheet at the bottom
 * in portrait, at the right in landscape (resting in the bottom right corner),
 * in place of the floating dock and panel rail. It rests at peek (the handle and the panel tabs) while no panel
 * is open, and opens a panel at half height or all the way up to the top bar.
 * The handle is a 44 px button: a press steps peek → half → full → peek,
 * ArrowUp and ArrowDown (PageUp, PageDown, Home, End) move between the
 * heights (the handle owns its arrows, so Shift+arrows there never turn the
 * map), and in portrait a drag lets go at the nearest one. Resting at peek
 * closes the open panel; raising the sheet with none open opens the first
 * tab. The sheet covers the map's bottom (or right) edge in the visible map
 * area, so fitting, chips and cards keep above it. When a drawing tool starts
 * a draft (Plant a row's pick, a polygon's or profile's first point) the sheet
 * drops to its peek, so the draft is drawn on the map; raised again during the
 * draft, it stays. The armed tool's options (answer 30) show in place of the
 * open panel, which stays mounted under them, while `phoneToolOptions` holds their height: a panel opened by any
 * route (a tab, More, the chooser's catalog link, a shortcut) shows in front of
 * them, since `selectPanel` closes them even for the panel already open; a
 * press on the open panel's tab or More item shows it, and closing them gives
 * the sheet back its panel and height as they were.
 *
 * Its first row is the context bar (answers 18, 22 and 30): what the map's
 * context shows on a phone, one touch row (and the map notice's row) that never
 * scrolls or grows, so peek is predictable and half is half the workspace.
 * Being part of the sheet, the bar moves with peek, half, full and a finger
 * drag with no position of its own, and the sheet's one registration covers
 * it. The bar sits outside the dock's key region, so a key
 * from a control in it is the map's as a tool card's is. In landscape the sheet
 * always covers the right edge, its corner box at peek included: with the bar
 * it stands taller than a bottom band, and the zoom column then keeps the
 * window's height beside it.
 */
export function PhoneSheet({ layout, tabs, bar, options, children }: {
  readonly layout: PhoneLayout
  /**
   * The panel commands, in rail order; the first `PHONE_SHEET_TABS` show as
   * tabs and the rest wait in More under their full names.
   */
  readonly tabs: readonly PanelRailCommand[]
  /** The context bar's content; the row takes no room while it renders nothing. */
  readonly bar?: ComponentChildren
  /** The armed tool's options (ToolOptions), shown in place of the open panel while `phoneToolOptions` is set. */
  readonly options?: ComponentChildren
  /** The open panel, when there is one. */
  readonly children?: ComponentChildren
}) {
  const sheet = useRef<HTMLElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  // Set by a drag, so the click that ends it is not taken for a press.
  const dragged = useRef(false)
  const panelId = useId()
  const optionsId = useId()
  const portrait = layout === 'portrait'
  const panels = tabs.filter((command) => command.panel)
  // Only side panels open the sheet; a primary view (Templates) just switches the map.
  const sidePanels = panels.filter((command) => isSidePanel(command.panel!))
  const openPanel = sidePanels.find((command) => command.active)?.panel ?? null
  const open = openPanel !== null
  // The tool's options stand in front of the open panel, which comes back as it was once they close.
  const optionsHeight = options ? phoneToolOptions.value : null
  const height: PhoneSheetHeight = optionsHeight ?? (open && children ? phoneSheetOpenHeight.value : 'peek')
  // On its side the sheet rests in the bottom right corner and opens along the right edge.
  useMapOccluder(sheet, portrait ? 'bottom' : 'right')
  // The tool strip ends above the sheet rather than behind it.
  useUnderRail(sheet, 'tool', portrait)
  useFocusRegion(dock, 'dock')
  // The tool's gesture flag is its held draft (a picked plant, a placed point); it is read from the tool's guidance.
  const drafting = DRAWING_TOOLS.has(currentCanvasTool.value) && currentCanvasToolGuidance.value.gesture
  useEffect(() => {
    if (drafting) moveTo('peek')
  }, [drafting])

  function moveTo(next: PhoneSheetHeight): void {
    if (next === 'peek') {
      phoneToolOptions.value = null
      sidePanels.find((command) => command.active)?.action()
      return
    }
    if (optionsHeight) {
      phoneToolOptions.value = next
      return
    }
    phoneSheetOpenHeight.value = next
    if (!open) sidePanels.find((command) => !command.disabled)?.action()
  }

  const onPointerDown = usePointerResize<SheetDrag>({
    cursor: 'row-resize',
    begin: (event) => {
      dragged.current = false
      const element = sheet.current
      const host = element?.offsetParent
      if (!portrait || !element || !(host instanceof HTMLElement)) return null
      const box = element.getBoundingClientRect()
      const hostBox = host.getBoundingClientRect()
      // Peek is the sheet without its open panel: the bar, the handle, the tabs and the sheet's own edges.
      const peek = box.height - (element.querySelector<HTMLElement>('[data-sheet-panel]:not([hidden])')?.offsetHeight ?? 0)
      return {
        sheet: element,
        startY: event.clientY,
        startSize: box.height,
        startTime: event.timeStamp,
        // Full rests just below the top bar, which the framing frame measures; top status chrome (the lock toast) is
        // not counted, as the sheet stands over it.
        stops: { peek, half: hostBox.height / 2, full: box.bottom - hostBox.top - framingMapFrame.peek().top - FULL_GAP_PX },
        size: box.height,
      }
    },
    preview: (session, event) => {
      const moved = session.startY - event.clientY
      if (Math.abs(moved) < DRAG_SLOP_PX) return false
      session.size = Math.max(session.stops.peek, Math.min(session.stops.full, session.startSize + moved))
      session.sheet.style.height = `${session.size}px`
      session.sheet.dataset.dragging = 'true'
      return true
    },
    commit: (session, event) => {
      release(session.sheet)
      dragged.current = true
      const elapsed = Math.max(1, event.timeStamp - session.startTime)
      moveTo(snapPhoneSheet(session.size, session.stops, (session.size - session.startSize) / elapsed))
    },
    rollback: (session) => release(session.sheet),
  })

  const shown = panels.slice(0, PHONE_SHEET_TABS)
  const folded = panels.slice(PHONE_SHEET_TABS)
  const handleLabel = height === 'peek' ? t('webPhone.sheetShow')
    : height === 'half' ? t('webPhone.sheetExpand')
      : t('webPhone.sheetHide')

  function onTabKeyDown(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(sheet.current?.querySelectorAll<HTMLElement>('[data-sheet-tab]') ?? [])
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
    items.forEach((item, itemIndex) => { item.tabIndex = itemIndex === next ? 0 : -1 })
    items[next]?.focus()
  }

  /** A tab or More item: over the tool's options its open panel shows; elsewhere a press on the open one rests the sheet,
   *  as the rail closes the dock. Any other panel opens, which shows it in front of the options. */
  function press(command: PanelRailCommand): void {
    if (command.disabled) return
    if (optionsHeight && command.active) {
      phoneToolOptions.value = null
      return
    }
    command.action()
  }

  const focusIndex = Math.max(0, shown.findIndex((command) => command.active))

  return (
    <section
      ref={sheet}
      className={styles.sheet}
      aria-label={t('panelRail.label')}
      data-phone-sheet={height}
      data-orientation={layout}
    >
      <div className={styles.bar} data-phone-context-bar>{bar}</div>
      <div ref={dock} className={styles.dock} data-key-region={DOCK_KEY_REGION}>
        <button
          type="button"
          className={styles.handle}
          aria-label={handleLabel}
          aria-expanded={height !== 'peek'}
          aria-controls={optionsHeight ? optionsId : open ? panelId : undefined}
          aria-keyshortcuts="ArrowUp ArrowDown"
          data-owns-keys="arrows"
          data-sheet-handle
          onPointerDown={onPointerDown}
          onClick={() => {
            if (dragged.current) {
              dragged.current = false
              return
            }
            moveTo(cyclePhoneSheet(height))
          }}
          onKeyDown={(event) => {
            dragged.current = false
            const next = stepPhoneSheet(height, event.key)
            if (!next) return
            event.preventDefault()
            if (next !== height) moveTo(next)
          }}
        >
          <span className={styles.grip} aria-hidden="true" />
        </button>
        <div className={styles.tabRow}>
          <div className={styles.tabs} role="tablist" aria-label={t('panelRail.label')} onKeyDown={onTabKeyDown}>
            {shown.map((command, index) => (
              <button
                key={command.panel}
                type="button"
                role="tab"
                className={styles.tab}
                data-sheet-tab
                data-panel={command.panel}
                data-command-id={command.id ?? command.commandId}
                aria-selected={!optionsHeight && (command.active ?? false)}
                aria-controls={!optionsHeight && command.active && open ? panelId : undefined}
                aria-disabled={command.disabled ? true : undefined}
                tabIndex={index === focusIndex ? 0 : -1}
                onClick={() => press(command)}
              >
                <span className={styles.tabLabel}>{tabLabel(command)}</span>
              </button>
            ))}
          </div>
          {folded.length > 0 && (
            <ActionMenu
              label={t('panelRail.more')}
              triggerClassName={styles.tab}
              iconSize={20}
              triggerLabel={<span className={styles.tabLabel}>{t('webPhone.more')}</span>}
              triggerData={{
                'data-sheet-more': '',
                'data-holds-active': folded.some((command) => command.active) ? '' : undefined,
              }}
              items={folded.map((command) => ({
                id: command.id ?? command.commandId,
                label: command.label,
                checked: command.active ?? false,
                disabled: command.disabled,
                run: () => press(command),
              }))}
            />
          )}
        </div>
        {optionsHeight && (
          <div id={optionsId} className={styles.panel} role="region" aria-label={t('canvas.toolCard.options')} data-sheet-panel="options">
            {options}
          </div>
        )}
        {/* Kept mounted under the options, so the panel's own state (a search, an opened species) is there when they close. */}
        {open && children && (
          <div id={panelId} className={styles.panel} role="tabpanel" hidden={optionsHeight !== null} data-sheet-panel>
            {children}
          </div>
        )}
      </div>
    </section>
  )
}

function release(sheet: HTMLElement): void {
  sheet.style.removeProperty('height')
  delete sheet.dataset.dragging
}

/** The short tab names; a panel without one shows its full name, as More does. */
const TAB_LABEL_KEYS: Readonly<Partial<Record<string, LocaleKey>>> = {
  budget: 'webPhone.tabs.budget',
  calendar: 'webPhone.tabs.calendar',
  consortium: 'webPhone.tabs.consortium',
  favorites: 'webPhone.tabs.favorites',
  layers: 'webPhone.tabs.layers',
  'plant-db': 'webPhone.tabs.plant-db',
  'species-key': 'webPhone.tabs.species-key',
  stories: 'webPhone.tabs.stories',
}

function tabLabel(command: PanelRailCommand): string {
  const key = command.panel ? TAB_LABEL_KEYS[command.panel] : undefined
  return key ? t(key) : command.label
}
