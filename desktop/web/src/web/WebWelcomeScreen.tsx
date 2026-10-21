import type { ReadonlySignal } from '@preact/signals'
import { useState } from 'preact/hooks'
import { t } from '../i18n'
import { openKeyboardShortcutsDialog, openSettingsDialog } from '../app/shell/dialogs'
import { formatShortcut } from '../app/shell-commands/shortcut-text'
import { StartScreen } from '../components/shared/StartScreen'
import {
  browserDesignSessionController,
  type BrowserDesignSessionController,
} from './browser-design-session'
import { browserDraftPersistence, DRAFT_PERSISTENCE_REASON, type BrowserDraftPersistenceView } from './browser-draft-persistence'
import { showBrowserShellNotice } from './browser-shell-notice'

interface WebWelcomeScreenProps {
  readonly controller?: BrowserDesignSessionController
  /** Whether the browser keeps Drafts (2.1-Q82): the reason before the ask, or the warning. */
  readonly persistence?: ReadonlySignal<BrowserDraftPersistenceView>
}

/** Web start screen: Designs live as Drafts in this browser; files come and go as downloads. */
export function WebWelcomeScreen({
  controller = browserDesignSessionController,
  persistence = browserDraftPersistence.view,
}: WebWelcomeScreenProps) {
  const [drafts, setDrafts] = useState(() => controller.listDrafts())
  const line = persistence.value.notice
  return (
    <div data-testid="web-welcome-screen">
      <StartScreen
        newDesign={{ label: t('menu.file.new'), run: () => { void controller.newDesign().catch(logWebWelcomeError) } }}
        openDesign={{ label: t('webShell.openCanopi'), shortcut: formatShortcut('Ctrl+O', t), run: () => { void controller.openCanopi().catch(logWebWelcomeError) } }}
        links={[
          { icon: 'gear', label: t('menu.file.settings'), run: openSettingsDialog },
          { icon: 'keyboard', label: t('menu.help.shortcuts'), run: openKeyboardShortcutsDialog },
        ]}
        footer={t('start.footerWeb')}
        notice={line === 'warning'
          // With no Draft row listed there is no Draft menu to point to (review F3).
          ? { tone: 'warning', text: t(drafts.length > 0 ? 'webStorage.warning' : 'webStorage.warningNoDrafts') }
          // The reason, before New or Open asks; amber when unkept Drafts already exist (review F1).
          : line === 'reason'
            ? { tone: persistence.value.warn ? 'warning' : 'info', text: t('webStorage.reason'), id: DRAFT_PERSISTENCE_REASON }
            : null}
        recent={null}
        drafts={drafts.map((draft) => ({
          id: draft.id,
          name: draft.name,
          updatedAt: draft.updatedAt,
          open: () => { void controller.openDraft(draft.id).catch(logWebWelcomeError) },
          actions: [{
            label: t('webShell.downloadCopy'),
            run: () => {
              // A Draft gone from this browser (another tab, or the browser cleared it) fails visibly and the rows re-list (review F4).
              void controller.downloadDraft(draft.id).catch((error: unknown) => {
                logWebWelcomeError(error)
                showBrowserShellNotice({
                  tone: 'error',
                  title: t('webStorage.downloadFailedTitle'),
                  message: t('webStorage.downloadFailedMessage'),
                })
                setDrafts(controller.listDrafts())
              })
            },
          }],
          delete: () => {
            const deleted = controller.deleteDraft(draft.id)
            if (!deleted.ok) logWebWelcomeError(deleted.error)
            setDrafts(controller.listDrafts())
          },
        }))}
      />
    </div>
  )
}

function logWebWelcomeError(error: unknown): void {
  console.error('Browser Web welcome command failed:', error)
}
