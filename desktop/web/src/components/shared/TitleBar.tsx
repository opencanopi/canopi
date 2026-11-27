import { useEffect } from 'preact/hooks'
import { setDesignName } from '../../app/design-edit'
import { currentDesign, designName } from '../../app/document-session/store'
import {
  designSaveFailureReason,
  designSaveStatus,
  resolveDesignConflict,
  retryDesignSave,
  saveAsCurrentDesign,
} from '../../app/document-session/actions'
import {
  closeAppWindow,
  minimizeAppWindow,
  startDraggingAppWindow,
  toggleMaximizeAppWindow,
} from '../../app/shell/window-actions'
import { designNotebookWorkbench } from '../../app/design-notebook'
import { appCommandGraphChromeProjection } from '../../commands/registry'
import { t } from '../../i18n'
import { PlaceSearchField } from '../canvas/PlaceSearch'
import { ControlIcon } from './ControlIcon'
import { DesignNameField, visibleDesignName } from './DesignNameField'
import { SaveStatusLabel } from './SaveStatusLabel'
import { TitleBarIconButton, WorkspaceTitleBar } from './WorkspaceTitleBar'
import styles from './WorkspaceTitleBar.module.css'

/** Desktop title bar: the shared floating bar over the command graph, plus window controls. */
export function TitleBar() {
  const projection = appCommandGraphChromeProjection.value
  const hasDesign = currentDesign.value !== null
  const saveStatus = designSaveStatus.value

  useEffect(() => {
    void designNotebookWorkbench.loadRecentDesigns()
  }, [])

  // Frameless window: a press on empty title-bar space drags; a double press maximizes.
  const handleMouseDown = (event: MouseEvent) => {
    if (event.buttons !== 1) return
    const target = event.target as HTMLElement
    if (target.closest('button, input, label, [role="menu"], [role="menubar"], [role="dialog"], [role="listbox"]')) return
    if (event.detail === 2) void toggleMaximizeAppWindow()
    else void startDraggingAppWindow()
  }

  return (
    <WorkspaceTitleBar
      menus={projection.menus}
      onMenuOpen={(menuId) => {
        if (menuId === 'file') void designNotebookWorkbench.loadRecentDesigns()
      }}
      design={hasDesign ? (
        <>
          {/* A read-only Design is shown, never renamed (2.1-Q315, Q347). */}
          {saveStatus === 'read-only'
            ? <span className={styles.nameText}>{visibleDesignName(designName.value)}</span>
            : <DesignNameField name={designName.value} onRename={setDesignName} />}
          <SaveStatusLabel
            status={saveStatus}
            failureReason={designSaveFailureReason.value}
            draftLabel={t('saveStatus.draft')}
            draftAction={{ label: t('saveStatus.saveAs'), style: 'button', run: saveAs }}
            saveElsewhere={{ label: t('saveStatus.saveAs'), run: saveAs }}
            onRetry={() => { void retryDesignSave() }}
            onResolveConflict={() => { void resolveDesignConflict().catch(logSaveCommandError) }}
          />
        </>
      ) : undefined}
      fileActions={(
        <TitleBarIconButton
          command={{ ...projection.titleBar.openDesign, label: t('webShell.openCanopiFile') }}
          icon="folder-open"
        />
      )}
      search={hasDesign ? <PlaceSearchField /> : undefined}
      help={projection.titleBar.help}
      settings={projection.titleBar.settings}
      onMouseDown={handleMouseDown}
      windowControls={(
        <>
          {([
            [minimizeAppWindow, 'window.minimize', 'window-minimize'],
            [toggleMaximizeAppWindow, 'window.maximize', 'window-maximize'],
            [closeAppWindow, 'window.close', 'close'],
          ] as const).map(([run, label, icon]) => (
            <button key={icon} type="button" className={styles.iconButton} onClick={() => void run()} aria-label={t(label)} tabIndex={-1}>
              <ControlIcon name={icon} />
            </button>
          ))}
        </>
      )}
    />
  )
}

function saveAs(): void {
  void saveAsCurrentDesign().catch(logSaveCommandError)
}

function logSaveCommandError(error: unknown): void {
  console.error('Design save command failed:', error)
}
