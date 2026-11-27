import type { ComponentChildren } from 'preact'
import { storyPresentationActive } from '../../app/story-presentation'
import { useFocusRegion } from './useFocusRegion'
import type { MenuDefinition } from '../../app/shell-commands/menus'
import { t } from '../../i18n'
import { ButtonTooltip } from './ButtonTooltip'
import { ControlIcon, type ControlIconName } from './ControlIcon'
import { MenuBar } from './MenuBar'
import { useRef } from 'preact/hooks'
import { useMapOccluder } from './useMapChrome'
import { useModalInertRegion } from './useModalLayer'
import styles from './WorkspaceTitleBar.module.css'

/** A title-bar command button: label, shortcut and action come from the command projection. */
export interface TitleBarCommand {
  readonly label: string
  readonly shortcut?: string
  readonly ariaShortcut?: string
  readonly disabled?: boolean
  action(): void
}

interface WorkspaceTitleBarProps {
  readonly menus: readonly MenuDefinition[]
  readonly onMenuOpen?: (menuId: string) => void
  /** Design name field and save status; absent on the start screen. */
  readonly design?: ComponentChildren
  /** Edition file actions before the search field (Web: Open a .canopi file). */
  readonly fileActions?: ComponentChildren
  readonly search?: ComponentChildren
  readonly help: TitleBarCommand
  readonly settings: TitleBarCommand
  /** Desktop window controls; the frameless window draws its own. */
  readonly windowControls?: ComponentChildren
  readonly onMouseDown?: (event: MouseEvent) => void
}

/**
 * The floating title bar both editions share: logo, menu bar, Design name
 * with its save status, place search, Help and Settings.
 */
export function WorkspaceTitleBar(props: WorkspaceTitleBarProps) {
  // A presented story fills the window: the title bar steps aside until it ends.
  return storyPresentationActive.value ? null : <WorkspaceTitleBarContent {...props} />
}

function WorkspaceTitleBarContent({
  menus,
  onMenuOpen,
  design,
  fileActions,
  search,
  help,
  settings,
  windowControls,
  onMouseDown,
}: WorkspaceTitleBarProps) {
  const titleBar = useRef<HTMLElement>(null)
  useMapOccluder(titleBar, 'top')
  useModalInertRegion(titleBar)
  useFocusRegion(titleBar, 'title-bar')
  return (
    <header ref={titleBar} className={styles.titleBar} onMouseDown={onMouseDown} data-workspace-title-bar>
      <img
        src={new URL('../../assets/canopi-logo.svg', import.meta.url).href}
        className={styles.logo}
        alt="Canopi"
        draggable={false}
      />
      <MenuBar menus={menus} label={t('titleBar.menus')} compactLabel={t('titleBar.menu')} onMenuOpen={onMenuOpen} />
      {design && (
        <>
          <span className={styles.rule} aria-hidden="true" data-design-chrome />
          <div className={styles.design} data-design-chrome>{design}</div>
        </>
      )}
      <span className={styles.spacer} />
      <span className={`${styles.wide} ${styles.fileActions}`}>{fileActions}</span>
      {search}
      <span className={styles.wide}>
        <TitleBarIconButton command={help} icon="help" />
        <TitleBarIconButton command={settings} icon="gear" />
      </span>
      {windowControls && (
        <>
          <span className={styles.rule} aria-hidden="true" />
          {windowControls}
        </>
      )}
    </header>
  )
}

export function TitleBarIconButton({ command, icon, dataWebCommandId }: {
  readonly command: TitleBarCommand
  readonly icon: ControlIconName
  readonly dataWebCommandId?: string
}) {
  return (
    <button
      type="button"
      className={styles.iconButton}
      data-web-command-id={dataWebCommandId}
      aria-label={command.label}
      aria-keyshortcuts={command.ariaShortcut}
      aria-disabled={command.disabled ? true : undefined}
      onClick={() => { if (!command.disabled) command.action() }}
    >
      <ControlIcon name={icon} size={20} />
      <ButtonTooltip label={command.label} shortcut={command.shortcut} side="bottom" />
    </button>
  )
}
