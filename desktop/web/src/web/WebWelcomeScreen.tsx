import { useEffect, useState } from 'preact/hooks'
import { t } from '../i18n'
import { openKeyboardShortcutsDialog, openSettingsDialog } from '../app/shell/dialogs'
import { formatShortcut } from '../app/shell-commands/shortcut-text'
import { StartScreen } from '../components/shared/StartScreen'
import {
  browserDesignSessionController,
  type BrowserDesignSessionController,
} from './browser-design-session'
import {
  browserDraftPersistence,
  canKeepDrafts,
  DRAFT_PERSISTENCE_REASON,
  type BrowserDraftPersistence,
} from './browser-draft-persistence'
import { showBrowserShellNotice } from './browser-shell-notice'

interface WebWelcomeScreenProps {
  readonly controller?: BrowserDesignSessionController
  /** Whether the browser keeps Drafts (2.1-Q82): the reason before the ask, or the warning with Keep my Drafts. */
  readonly persistence?: Pick<BrowserDraftPersistence, 'view' | 'keep' | 'showReason'>
}

/** Web start screen: Designs live as Drafts in this browser; files come and go as downloads. */
export function WebWelcomeScreen({
  controller = browserDesignSessionController,
  persistence = browserDraftPersistence,
}: WebWelcomeScreenProps) {
  const [drafts, setDrafts] = useState(() => controller.listDrafts())
  const view = persistence.view.value
  const line = view.notice
  const keepOffered = canKeepDrafts(view)
  // The reason is on screen: a first visit's New or Open, or Keep my Drafts, may ask (R2-7).
  const reasonShown = line === 'reason' || keepOffered
  useEffect(() => reasonShown ? persistence.showReason() : undefined, [reasonShown, persistence])
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
          ? {
              tone: 'warning',
              // With no Draft row listed there is no Draft menu to point to (review F3).
              text: t(drafts.length > 0 ? 'webStorage.warning' : 'webStorage.warningNoDrafts'),
              // Unkept Drafts at launch, not yet asked: the reason and Keep my Drafts (2.1-Q190, Q198; R2-2).
              detail: keepOffered ? { text: t('webStorage.reason'), id: DRAFT_PERSISTENCE_REASON } : null,
              action: keepOffered ? { label: t('webStorage.keepDrafts'), run: () => persistence.keep() } : null,
            }
          : line === 'reason' ? { tone: 'info', text: t('webStorage.reason'), id: DRAFT_PERSISTENCE_REASON } : null}
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
