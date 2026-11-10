import { useEffect, useMemo, useState } from 'preact/hooks'
import { t } from '../../i18n'
import {
  newDesignAction,
  openDesign,
  openDesignDraft,
  openDesignFromPath,
} from '../../app/document-session/actions'
import { createDesignDraftsController } from '../../app/design-drafts'
import { createRecentFilesController } from '../../app/recent-files'
import { openKeyboardShortcutsDialog, openSettingsDialog } from '../../app/shell/dialogs'
import { openProblemReportDialog } from '../../app/problem-report/submission'
import { formatShortcut } from '../../app/shell-commands/shortcut-text'
import { StartScreen } from './StartScreen'
import { SlotToast } from './ToastSlot'

/** Desktop start screen: recent Design files and Design Drafts from app data. */
export function WelcomeScreen() {
  const recentFilesController = useMemo(() => createRecentFilesController(), [])
  const draftsController = useMemo(() => createDesignDraftsController(), [])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let live = true
    // Both loads settle (they fall back to empty lists), so first run shows its empty state once.
    void Promise.all([recentFilesController.load(), draftsController.load()]).then(() => {
      if (live) setLoaded(true)
    })
    return () => {
      live = false
      recentFilesController.dispose()
      draftsController.dispose()
    }
  }, [recentFilesController, draftsController])

  const revealFailure = recentFilesController.revealFailure.value

  return (
    <>
    <StartScreen
      newDesign={{ label: t('menu.file.new'), shortcut: formatShortcut('Ctrl+N', t), run: () => { void newDesignAction().catch(logWelcomeError) } }}
      openDesign={{ label: t('menu.file.open'), shortcut: formatShortcut('Ctrl+O', t), run: () => { void openDesign().catch(logWelcomeError) } }}
      links={[
        { icon: 'gear', label: t('menu.file.settings'), run: openSettingsDialog },
        { icon: 'keyboard', label: t('menu.help.shortcuts'), run: openKeyboardShortcutsDialog },
        { icon: 'bug', label: t('menu.help.reportProblem'), run: openProblemReportDialog },
      ]}
      footer={t('start.footerDesktop')}
      loading={!loaded}
      recent={recentFilesController.recentFiles.value.map((file) => ({
        id: file.path,
        name: file.name,
        path: file.path,
        updatedAt: file.updated_at,
        preview: recentFilesController.previews.value.get(file.path),
        open: () => { void openDesignFromPath(file.path).catch(logWelcomeError) },
        showInFolder: () => { void recentFilesController.showInFolder(file.path) },
        remove: () => { void recentFilesController.remove(file.path).catch(logWelcomeError) },
      }))}
      drafts={draftsController.drafts.value.map((draft) => ({
        id: draft.id,
        name: draft.name,
        updatedAt: draft.updated_at,
        open: () => { void openDesignDraft(draft.id).catch(logWelcomeError) },
        delete: () => { void draftsController.remove(draft.id).catch(logWelcomeError) },
      }))}
    />
    {revealFailure && (
      // A failed Show in folder (2.1-Q227) says so without the path, in the window's toast position; the Start screen
      // has no map, so it registers with no visible-map-area seam.
      <SlotToast
        key={revealFailure.id}
        icon="info"
        message={t('start.showInFolderFailed')}
        onDismiss={() => recentFilesController.dismissRevealFailure(revealFailure)}
      />
    )}
    </>
  )
}

function logWelcomeError(error: unknown): void {
  console.error('Welcome screen command failed:', error)
}
