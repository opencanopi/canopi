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
import { browserDraftPersistence, type BrowserDraftPersistenceView } from './browser-draft-persistence'

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
          ? { tone: 'warning', text: t('webStorage.warning') }
          : line === 'reason' ? { tone: 'info', text: t('webStorage.reason') } : null}
        recent={null}
        drafts={drafts.map((draft) => ({
          id: draft.id,
          name: draft.name,
          updatedAt: draft.updatedAt,
          open: () => { void controller.openDraft(draft.id).catch(logWebWelcomeError) },
          actions: [{ label: t('webShell.downloadCopy'), run: () => { void controller.downloadDraft(draft.id).catch(logWebWelcomeError) } }],
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
