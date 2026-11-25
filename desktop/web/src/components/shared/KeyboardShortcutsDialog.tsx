import type { MenuDefinition } from '../../app/shell-commands/menus'
export type { MenuDefinition }
import { flattenMenuActions } from '../../app/shell-commands/menus'
import { useLayoutEffect, useRef } from 'preact/hooks'
import {
  closeKeyboardShortcutsDialog,
  keyboardShortcutsDialogOpen,
  keyboardShortcutsSectionRequest,
  keyboardShortcutsSectionShown,
} from '../../app/shell/dialogs'
import { singleKeyShortcuts } from '../../app/settings/state'
import { t } from '../../i18n'
import { formatShortcut, modKeyName } from '../../app/shell-commands/shortcut-text'
import type { InputPlatform } from '../../canvas/runtime/input/platform'
import { WorkspaceDialog } from './WorkspaceDialog'
import styles from './KeyboardShortcutsDialog.module.css'
import type { LocaleKey } from '../../generated/locale-keys'

/** The View menu's rotation rows (app/canvas-commands/index.ts), which F1 shows as its two static rows instead. */
const MENU_ROTATION_ROWS: ReadonlySet<string> = new Set(['view.resetNorth', 'view.turnViewLeft', 'view.turnViewRight'])

/** View › Fit to Design, which F1 shows with every fit key (Home too) after a row for the map's + and −. */
const MENU_FIT_ROW = 'view.fitToDesign'

interface KeyboardShortcutsDialogProps {
  readonly menus: readonly MenuDefinition[]
  /** The platform the gesture rows describe: a Mac's pan, Option and Control-click, the trackpad twist where WebKit delivers it. */
  readonly platform?: Pick<InputPlatform, 'os' | 'gestureEvents'>
  /** Desktop on Linux: WebKitGTK delivers no trackpad pinch. */
  readonly linuxPinchNote?: boolean
}

interface ShortcutRow {
  readonly id: string
  readonly label: string
  readonly shortcut: string
}

/**
 * Help › Keyboard shortcuts (F1): every menu command that has a shortcut,
 * grouped by menu, generated from the same menus so it cannot drift, then the
 * mouse, trackpad and pen gestures as a static list (not generated from the
 * input pipeline), then Touch (every device: touch laptops too), then the keys that are not commands (F6 between areas,
 * arrow-key nudges, turning a stamp). View shows turning the view and Reset
 * north as two static rows with every chord, in place of the menu's three
 * rotation rows, and Fit the Design with Home after the map's + and −. With
 * Settings › Keyboard › Single-key shortcuts off, the menus drop those keys,
 * so the list does too (N leaves Reset north), and the footnote says how to
 * turn them back on and that Shift N still resets north. Opened at a section (the welcome screen's Moving around:
 * the gestures), it scrolls that section's heading to the top and focuses it, after the dialog's own first focus; an
 * open dialog asked again moves there; the request is used once, so a plain reopen starts at the top.
 */
export function KeyboardShortcutsDialog({ menus, platform, linuxPinchNote = false }: KeyboardShortcutsDialogProps) {
  const open = keyboardShortcutsDialogOpen.value
  const request = keyboardShortcutsSectionRequest.value
  const grid = useRef<HTMLDivElement>(null)
  // A parent's layout effect runs after its children's, so this focus follows WorkspaceDialog's initial focus.
  useLayoutEffect(() => {
    if (!open || !request) return
    const heading = grid.current?.querySelector<HTMLElement>(`#shortcuts-${request.section}`)
    heading?.scrollIntoView?.({ block: 'start' })
    heading?.focus({ preventScroll: true })
    keyboardShortcutsSectionShown()
  }, [open, request])
  if (!open) return null
  const key = (shortcut: string) => formatShortcut(shortcut, t)
  const single = singleKeyShortcuts.value
  const rotationRows: ShortcutRow[] = [
    row('turn-view', t('shortcuts.turnView'), [key('Shift+ArrowLeft'), key('Shift+ArrowRight')].join(' · ')),
    row('reset-north', t('shortcuts.resetNorth'), [...single ? [key('N')] : [], key('Shift+N'), key('Shift+ArrowUp')].join(' · ')),
  ]
  // + and − and Home act only with the map focused, so they stay with the switch off; Shift F follows it.
  const fitRows: ShortcutRow[] = [
    row('zoom-step', t('shortcuts.zoomStep'), [key('Plus'), key('Minus')].join(' · ')),
    row('fit-home', t('shortcuts.fitHome'), [key('Home'), ...single ? [key('Shift+F')] : [], key('Ctrl+0')].join(' · ')),
  ]
  // A tool command View lists too (Pan) shows once, under Tools.
  const toolIds = new Set(menus.filter((menu) => menu.id === 'tools').flatMap((menu) => menuRows(menu).map((r) => r.id)))
  const sections = menus
    .map((menu) => ({
      id: menu.id,
      label: menu.id === 'tools' ? t('shortcuts.toolsHeading', { menu: menu.label }) : menu.label,
      rows: menu.id === 'tools' ? menuRows(menu)
        : menu.id === 'view' ? viewRows(menuRows(menu), rotationRows, fitRows).filter((r) => !toolIds.has(r.id))
          : menuRows(menu),
    }))
    .filter((section) => section.rows.length > 0)
  const gestures = { id: 'gestures', label: t('shortcuts.gestures.heading'), rows: gestureRows(platform) }
  const touch = { id: 'touch', label: t('shortcuts.gestures.touchHeading'), rows: touchRows() }
  // Keys that are not menu commands: moving between areas (F6), nudging or panning on the map and turning a stamp.
  const arrows = t('shortcuts.arrowKeys')
  // The large step is mod: Ctrl, or Cmd on macOS.
  const modArrows = `${modKeyName(t)} ${arrows}`
  const workspaceRows = [
    row('next-region', t('shortcuts.nextRegion'), key('F6')),
    row('previous-region', t('shortcuts.previousRegion'), key('Shift+F6')),
    row('nudge', t('shortcuts.nudge'), arrows),
    row('nudge-large', t('shortcuts.nudgeLarge'), modArrows),
    row('pan', t('shortcuts.pan'), arrows),
    row('pan-large', t('shortcuts.panLarge'), modArrows),
    // Place a stamp's [ and ]: while the map has focus even with single-key shortcuts off, like the arrows.
    row('rotate-stamp', t('shortcuts.rotateStamp'), '[ ]'),
  ]
  const allSections = [...sections, gestures, touch, { id: 'workspace', label: t('shortcuts.workspaceHeading'), rows: workspaceRows }]

  return (
    <WorkspaceDialog
      title={t('shortcuts.title')}
      onClose={closeKeyboardShortcutsDialog}
      wide
      footer={(
        <>
          <span className={styles.footnote} data-single-key-shortcuts={singleKeyShortcuts.value ? 'on' : 'off'}>
            {singleKeyShortcuts.value
              ? `${t('shortcuts.footnote')} ${t('shortcuts.singleKeysOn')}`
              : t('shortcuts.singleKeysOff')}
            {` ${t('shortcuts.resetNorthAlways', { shortcut: key('Shift+N') })}`}
          </span>
          <button type="button" className={styles.closeButton} onClick={closeKeyboardShortcutsDialog} data-dialog-initial-focus>
            {t('window.close')}
          </button>
        </>
      )}
    >
      <div ref={grid} className={styles.grid}>
        {allSections.map((section) => (
          <section key={section.id} className={styles.section} aria-labelledby={`shortcuts-${section.id}`}>
            {/* Focusable by script only, for an open at its section. */}
            <h3 className={styles.heading} id={`shortcuts-${section.id}`} tabIndex={-1}>{section.label}</h3>
            <dl className={styles.rows}>
              {section.rows.map((row) => (
                <div key={row.id} className={styles.row}>
                  <dt>{row.label}</dt>
                  <dd><kbd className={section.id === 'gestures' || section.id === 'touch' ? `${styles.key} ${styles.wraps}` : styles.key}>{row.shortcut}</kbd></dd>
                </div>
              ))}
            </dl>
            {section.id === 'gestures' && linuxPinchNote && <p className={styles.footnote}>{t('shortcuts.gestures.linuxPinch')}</p>}
          </section>
        ))}
      </div>
      <p className={styles.escape}>{t('shortcuts.escape')}</p>
    </WorkspaceDialog>
  )
}

/** A menu's rows that show a key: its actions, then a submenu whose key acts on it as a whole (View › Labels, Shift L). */
function menuRows(menu: MenuDefinition): ShortcutRow[] {
  return [
    ...flattenMenuActions([menu]).flatMap((action) => action.shortcut
      ? [{ id: action.id, label: action.label, shortcut: action.shortcut }]
      : []),
    ...menu.items.flatMap((entry) => entry.type === 'submenu' && entry.shortcut
      ? [{ id: entry.id, label: entry.label, shortcut: entry.shortcut }]
      : []),
  ]
}

/**
 * View's rows with the static rotation rows where the menu's first rotation row was (Reset north always shows a key),
 * and the zoom-step and fit rows in place of Fit to Design.
 */
function viewRows(rows: readonly ShortcutRow[], rotation: readonly ShortcutRow[], fit: readonly ShortcutRow[]): ShortcutRow[] {
  const at = rows.findIndex((row) => MENU_ROTATION_ROWS.has(row.id))
  const kept = rows.filter((row) => !MENU_ROTATION_ROWS.has(row.id))
  return [...kept.slice(0, at), ...rotation, ...kept.slice(at)]
    .flatMap((row) => row.id === MENU_FIT_ROW ? fit : [row])
}

/** A gesture's name under `shortcuts.gestures` in the interface strings. */
type GestureName = LocaleKey extends infer Key ? Key extends `shortcuts.gestures.${infer Name}` ? Name : never : never

/**
 * The mouse, trackpad and pen gestures: a static list, so it names only what the input pipeline does on every
 * platform, plus a Mac's Control-click and, where WebKit delivers it, the trackpad twist. A Mac says what Select's hint
 * says (app/tool-card/content.ts): it pans with two fingers or the Pan tool, since right-drag, Control-drag and
 * Space-drag are not yet checked in real Mac browsers (canopi-pqxl), and it removes with Option-click. The pen row is
 * a note: its side button drags to pan and taps for the menu.
 */
const row = (id: string, label: string, shortcut: string): ShortcutRow => ({ id, label, shortcut })

function gestureRows(platform: Pick<InputPlatform, 'os' | 'gestureEvents'> | undefined): ShortcutRow[] {
  const g = (name: GestureName) => t(`shortcuts.gestures.${name}`)
  const mac = platform?.os === 'mac'
  // A Mac names only gestures checked in real Mac browsers (canopi-pqxl): no right- or middle-button drag, so it turns
  // the view by the trackpad twist where WebKit delivers it (which never steps) and otherwise by the compass row.
  const turnRows: ShortcutRow[] = !mac
    ? [row('turn-view', t('shortcuts.gestures.turnView', { mod: modKeyName(t) }), g('shiftDrag'))]
    : platform?.gestureEvents ? [row('turn-view', g('turn'), g('trackpadTwist'))] : []
  return [
    row('pan', g('pan'), g(mac ? 'trackpadPan' : 'rightDrag')),
    ...turnRows,
    row('compass', g('compassAction'), g('compass')),
    row('menu', g('menu'), [g('rightClick'), ...mac ? [g('macCtrlClick')] : []].join(' · ')),
    row('zoom', g('zoom'), g('pinch')),
    row('remove', g('removeFromSelection'), g(mac ? 'optionClick' : 'altClick')),
    row('pen', `${g('pan')} · ${g('menu')}`, g('penButton')),
  ]
}

/** The touch gestures (spec §9.4): shown on every device, since a touch laptop runs Desktop with a mouse too. */
function touchRows(): ShortcutRow[] {
  const g = (name: GestureName) => t(`shortcuts.gestures.${name}`)
  return [
    row('one-finger', g('oneFingerAction'), g('oneFinger')),
    row('two-fingers', g('touchNavigate'), g('twoFingers')),
    row('long-press', g('menu'), g('longPress')),
  ]
}
