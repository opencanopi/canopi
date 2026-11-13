import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { t } from '../i18n'
import { openKeyboardShortcutsDialog, openSettingsDialog } from '../app/shell/dialogs'
import { formatShortcut } from '../app/shell-commands/shortcut-text'
import { StartScreen, type StartScreenDraft } from '../components/shared/StartScreen'
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
import type { BrowserDraftSummary } from './browser-app-data'
import { presentBrowserDraftDownloadFailure } from './browser-notices'

interface WebWelcomeScreenProps {
  readonly controller?: BrowserDesignSessionController
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
  controller = browserDesignSessionController,
  persistence = browserDraftPersistence,
}: WebWelcomeScreenProps) {
  // The launch's listing shows at once; each mount reads 2.1's Drafts afresh.
  const [listing, setListing] = useState<DraftListing>(() => {
    const listed = controller.listedNewerDrafts()
    return { editable: controller.listDrafts(), readOnly: listed ?? [], loading: listed === null }
  })
  // Unmounted while listing (a Design opened meanwhile): the answer is dropped.
  const mounted = useRef(true)
  const relist = useCallback(() => {
    void controller.listNewerDrafts().then((readOnly) => {
      if (mounted.current) setListing({ editable: controller.listDrafts(), readOnly, loading: false })
    }).catch(logWebWelcomeError)
  }, [controller])
  useEffect(() => {
    mounted.current = true
    relist()
    return () => { mounted.current = false }
  }, [relist])
  const view = persistence.view.value
  const line = view.notice
  const keepOffered = canKeepDrafts(view)
  // The reason is on screen: a first visit's New or Open, or Keep my Drafts, may ask (R2-7).
  const reasonShown = line === 'reason' || keepOffered
  useEffect(() => reasonShown ? persistence.showReason() : undefined, [reasonShown, persistence])
  const draftRow = (draft: BrowserDraftSummary, readOnly: boolean): StartScreenDraft => ({
    id: draft.id,
    name: draft.name,
    updatedAt: draft.updatedAt,
    readOnly,
    // A Draft gone meanwhile (deleted by 2.1 or another tab) opens nothing and the rows re-list.
    open: () => { void controller.openDraft(draft.id).then((opened) => { if (!opened) relist() }).catch(logWebWelcomeError) },
    actions: [{
      label: t('webShell.downloadCopy'),
      run: () => {
        // A Draft gone from this browser (another tab, or the browser cleared it) fails visibly and the rows re-list (review F4).
        void controller.downloadDraft(draft.id).catch((error: unknown) => {
          logWebWelcomeError(error)
          presentBrowserDraftDownloadFailure()
          relist()
        }).catch(logWebWelcomeError)
      },
    }],
    // A 2.1 Draft has no Delete: the 2.0 delete never reaches its id (design check F7).
    ...(readOnly ? {} : {
      // Refused, and logged, for an id 2.1 keeps or before one 2.1 listing completed (design check A18).
      delete: () => {
        void controller.deleteDraft(draft.id).then((deleted) => {
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
        newDesign={{ label: t('menu.file.new'), run: () => { void controller.newDesign().catch(logWebWelcomeError) } }}
        openDesign={{ label: t('webShell.openCanopi'), shortcut: formatShortcut('Ctrl+O', t), run: () => { void controller.openCanopi().catch(logWebWelcomeError) } }}
        links={[
          { icon: 'gear', label: t('menu.file.settings'), run: openSettingsDialog },
          { icon: 'keyboard', label: t('menu.help.shortcuts'), run: () => openKeyboardShortcutsDialog() },
        ]}
        // Help's gestures, one line under the links: no card opens by itself and no new button (2.1-Q310, Q311).
        helpLine={{ label: t('start.movingAround'), run: () => openKeyboardShortcutsDialog({ section: 'gestures' }) }}
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
        loading={listing.loading}
        drafts={drafts}
      />
    </div>
  )
}

function logWebWelcomeError(error: unknown): void {
  console.error('Browser Web welcome command failed:', error)
}
