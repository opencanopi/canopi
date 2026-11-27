import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { t } from '../../i18n'
import { openKeyboardShortcutsDialog, openSettingsDialog } from '../../app/shell/dialogs'
import { formatShortcut } from '../../app/shell-commands/shortcut-text'
import { StartScreen, type StartScreenDraft } from '../../components/shared/StartScreen'
import {
  browserDraftPersistence,
  canKeepDrafts,
  DRAFT_PERSISTENCE_REASON,
  type BrowserDraftPersistence,
} from '../../web/browser-draft-persistence'
import type { BrowserDraftSummary } from '../../web/browser-app-data'
import { presentBrowserDraftDownloadFailure } from '../../web/browser-notices'
import {
  deleteWebDraft,
  downloadWebDraft,
  initialWebDraftListing,
  isWebStorageUnchecked,
  listWebDraftsAsync,
  newWebDesign,
  openWebCanopiFile,
  openWebDraft,
} from './web-session'

interface WebWelcomeScreenProps {
  /** Whether the browser keeps Drafts (2.1-Q82): the reason before the ask, or the warning with Keep my Drafts. */
  readonly persistence?: Pick<BrowserDraftPersistence, 'view' | 'keep' | 'showReason'>
}

/** The Draft rows: the 2.0 Drafts editable, 2.1's read-only beside them (2.1-Q321), newest first. */
interface DraftListing {
  readonly editable: readonly BrowserDraftSummary[]
  readonly readOnly: readonly BrowserDraftSummary[]
  /** While 2.1's Drafts are read the rows wait, so no 2.0 Draft they hide flashes in (2.1-Q322). */
  readonly loading: boolean
}

/** Web start screen: Designs live as Drafts in this browser; files come and go as downloads. */
export function WebWelcomeScreen({
  persistence = browserDraftPersistence,
}: WebWelcomeScreenProps) {
  const [listing, setListing] = useState<DraftListing>(() => initialWebDraftListing())
  const mounted = useRef(true)
  const relist = useCallback(() => {
    void listWebDraftsAsync().then(({ editable, readOnly }) => {
      if (mounted.current) setListing({ editable, readOnly, loading: false })
    }).catch((error: unknown) => {
      logWebWelcomeError(error)
      if (mounted.current) setListing((prev) => ({ ...prev, loading: false }))
    })
  }, [])
  useEffect(() => {
    mounted.current = true
    relist()
    return () => { mounted.current = false }
  }, [relist])
  const view = persistence.view.value
  const line = view.notice
  const keepOffered = canKeepDrafts(view)
  const reasonShown = line === 'reason' || keepOffered
  useEffect(() => reasonShown ? persistence.showReason() : undefined, [reasonShown, persistence])
  const draftRow = (draft: BrowserDraftSummary, readOnly: boolean): StartScreenDraft => ({
    id: draft.id,
    name: draft.name,
    updatedAt: draft.updatedAt,
    readOnly,
    open: () => { void openWebDraft(draft.id).then((opened) => { if (!opened) relist() }).catch(logWebWelcomeError) },
    actions: [{
      label: t('webShell.downloadCopy'),
      run: () => {
        void downloadWebDraft(draft.id).catch((error: unknown) => {
          logWebWelcomeError(error)
          presentBrowserDraftDownloadFailure()
          relist()
        }).catch(logWebWelcomeError)
      },
    }],
    ...(readOnly || isWebStorageUnchecked() ? {} : {
      delete: () => {
        void deleteWebDraft(draft.id).then((deleted) => {
          if (!deleted.ok) logWebWelcomeError(deleted.error)
          relist()
        }).catch(logWebWelcomeError)
      },
    }),
  })
  const drafts = [...listing.readOnly.map((draft) => draftRow(draft, true)), ...listing.editable.map((draft) => draftRow(draft, false))]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  return (
    <div data-testid="web-welcome-screen">
      <StartScreen
        newDesign={{ label: t('menu.file.new'), run: () => { void newWebDesign().catch(logWebWelcomeError) } }}
        openDesign={{ label: t('webShell.openCanopi'), shortcut: formatShortcut('Ctrl+O', t), run: () => { void openWebCanopiFile().catch(logWebWelcomeError) } }}
        links={[
          { icon: 'gear', label: t('menu.file.settings'), run: openSettingsDialog },
          { icon: 'keyboard', label: t('menu.help.shortcuts'), run: () => openKeyboardShortcutsDialog() },
        ]}
        helpLine={{ label: t('start.movingAround'), run: () => openKeyboardShortcutsDialog({ section: 'gestures' }) }}
        footer={t('start.footerWeb')}
        notice={line === 'warning'
          ? {
              tone: 'warning',
              text: t(drafts.length > 0 ? 'webStorage.warning' : 'webStorage.warningNoDrafts'),
              detail: keepOffered ? { text: t('webStorage.reason'), id: DRAFT_PERSISTENCE_REASON } : null,
              action: keepOffered ? { label: t('webStorage.keepDrafts'), run: () => persistence.keep() } : null,
            }
          : line === 'reason' ? { tone: 'info', text: t('webStorage.reason'), id: DRAFT_PERSISTENCE_REASON } : null}
        recent={null}
        loading={listing.loading}
        drafts={drafts}
      />
    </div>
  )
}

function logWebWelcomeError(error: unknown): void {
  console.error('Web welcome screen action failed:', error)
}
