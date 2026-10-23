import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import {
  cancelDeleteView,
  closeManageViewsDialog,
  closeSaveViewDialog,
  confirmDeleteView,
  confirmSaveViewDialog,
  currentSavedViews,
  dismissDeleteViewUndo,
  goToSavedView,
  manageViewsDialogOpen,
  renameView,
  requestDeleteView,
  savedViewDeleteConfirmation,
  savedViewUndo,
  saveViewDialog,
  undoDeleteView,
  type SavedViewDeleteConfirmation,
  type SaveViewDialogRequest,
} from '../../app/saved-views'
import { t } from '../../i18n'
import type { SavedView } from '../../types/design'
import { SavedViewThumbnail } from './SavedViewThumbnail'
import { Toast } from './Toast'
import { WorkspaceDialog } from './WorkspaceDialog'
import styles from './SavedViewDialogs.module.css'

/** Save current view, Manage views and the Undo toast after a delete; both editions mount this. */
export function SavedViewDialogs() {
  const manageOpen = manageViewsDialogOpen.value
  return (
    <>
      <SaveViewDialog />
      {manageOpen && <ManageViewsDialog />}
      {!manageOpen && <SavedViewUndoToast floating />}
    </>
  )
}

function SaveViewDialog() {
  const request = saveViewDialog.value
  if (!request) return null
  return <SaveViewDialogContent request={request} />
}

function SaveViewDialogContent({ request }: { readonly request: SaveViewDialogRequest }) {
  const [name, setName] = useState(request.defaultName)
  const [title, setTitle] = useState('')
  const formId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const canSave = name.trim().length > 0

  // Selected as the dialog commits, once WorkspaceDialog has focused it, so typing at once replaces the default name.
  useLayoutEffect(() => {
    nameRef.current?.select()
  }, [])

  return (
    <WorkspaceDialog
      title={t('savedViews.saveTitle')}
      onClose={closeSaveViewDialog}
      footer={(
        <>
          <button type="button" className={styles.button} onClick={closeSaveViewDialog}>
            {t('savedViews.cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            className={`${styles.button} ${styles.primary}`}
            disabled={!canSave}
          >
            {t('savedViews.save')}
          </button>
        </>
      )}
    >
      <form
        id={formId}
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          if (canSave) confirmSaveViewDialog({ name, title })
        }}
      >
        <p className={styles.message}>{t('savedViews.saveMessage')}</p>
        <label className={styles.field}>
          <span className={styles.label}>{t('savedViews.nameLabel')}</span>
          <input
            ref={nameRef}
            className={styles.input}
            data-dialog-initial-focus
            required
            value={name}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t('savedViews.titleLabel')}</span>
          <input
            className={styles.input}
            value={title}
            aria-describedby={`${formId}-title-hint`}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
          <span className={styles.hint} id={`${formId}-title-hint`}>{t('savedViews.titleHint')}</span>
        </label>
      </form>
    </WorkspaceDialog>
  )
}

function ManageViewsDialog() {
  const views = currentSavedViews()
  const confirmation = savedViewDeleteConfirmation.value
  const listRef = useRef<HTMLUListElement>(null)
  const previousCount = useRef(views.length)

  // After a delete the row and its focused button are gone: keep focus in the list, as the change commits, so an Esc
  // at once is the dialog's (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
    if (views.length < previousCount.current) {
      const next = listRef.current?.querySelector<HTMLElement>('button')
      if (next) next.focus()
      else listRef.current?.closest('[role="dialog"]')?.querySelector<HTMLElement>('button')?.focus()
    }
    previousCount.current = views.length
  }, [views.length])

  return (
    <WorkspaceDialog
      title={t('savedViews.manageTitle')}
      onClose={closeManageViewsDialog}
      footer={(
        <button type="button" className={styles.button} onClick={closeManageViewsDialog}>
          {t('savedViews.done')}
        </button>
      )}
    >
      {confirmation && <DeleteConfirmation confirmation={confirmation} />}
      {views.length === 0
        ? <p className={styles.message}>{t('savedViews.empty')}</p>
        : (
          <ul ref={listRef} className={styles.list} aria-label={t('savedViews.listLabel')}>
            {views.map((view) => <ManagedViewRow key={view.id} view={view} />)}
          </ul>
        )}
      <SavedViewUndoToast />
    </WorkspaceDialog>
  )
}

function ManagedViewRow({ view }: { readonly view: SavedView }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(view.name)
  const renameButton = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const wasEditing = useRef(false)

  // Focus follows the control that replaced the focused one as it commits, so an Esc at once is the rename's or the
  // dialog's (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
    if (editing) {
      field.current?.focus()
      field.current?.select()
    }
    else if (wasEditing.current) renameButton.current?.focus()
    wasEditing.current = editing
  }, [editing])

  if (editing) {
    const finish = (commit: boolean) => {
      if (commit) renameView(view.id, draft)
      setEditing(false)
    }
    return (
      <li className={styles.row}>
        <form
          className={styles.rowField}
          onSubmit={(event) => {
            event.preventDefault()
            finish(true)
          }}
        >
          <input
            ref={field}
            className={`${styles.input} ${styles.rowInput}`}
            aria-label={t('savedViews.renameField', { name: view.name })}
            value={draft}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              // Esc cancels the rename, not the dialog.
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              finish(false)
            }}
          />
        </form>
        <div className={styles.rowActions}>
          <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => finish(true)}>
            {t('savedViews.renameSave')}
          </button>
          <button type="button" className={styles.button} onClick={() => finish(false)}>
            {t('savedViews.cancel')}
          </button>
        </div>
      </li>
    )
  }

  return (
    <li className={styles.row}>
      <SavedViewThumbnail view={view} />
      <span className={styles.rowName}>
        {view.name}
        {view.title && <span className={styles.rowTitle}>{view.title}</span>}
      </span>
      <div className={styles.rowActions}>
        <button
          type="button"
          className={styles.button}
          aria-label={t('savedViews.goToAria', { name: view.name })}
          onClick={() => {
            closeManageViewsDialog()
            goToSavedView(view.id)
          }}
        >
          {t('savedViews.goTo')}
        </button>
        <button
          ref={renameButton}
          type="button"
          className={styles.button}
          aria-label={t('savedViews.renameAria', { name: view.name })}
          onClick={() => {
            setDraft(view.name)
            setEditing(true)
          }}
        >
          {t('savedViews.rename')}
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.danger}`}
          aria-label={t('savedViews.deleteAria', { name: view.name })}
          onClick={() => requestDeleteView(view.id)}
        >
          {t('savedViews.delete')}
        </button>
      </div>
    </li>
  )
}

function DeleteConfirmation({ confirmation }: { readonly confirmation: SavedViewDeleteConfirmation }) {
  const cancel = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  // Cancel takes focus as the confirmation commits, so an Esc at once is the dialog's (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
    cancel.current?.focus()
  }, [confirmation.viewId])
  return (
    <div className={styles.confirm} role="alertdialog" aria-labelledby={titleId}>
      <p className={styles.confirmTitle} id={titleId}>
        {t('savedViews.deleteConfirmTitle', { name: confirmation.viewName })}
      </p>
      <p className={styles.confirmText}>{t('savedViews.deleteConfirmStories')}</p>
      <ul className={styles.confirmStories}>
        {confirmation.stories.map((story, index) => <li key={index}>{story}</li>)}
      </ul>
      <div className={styles.confirmActions}>
        <button ref={cancel} type="button" className={styles.button} onClick={cancelDeleteView}>
          {t('savedViews.cancel')}
        </button>
        <button type="button" className={`${styles.button} ${styles.danger}`} onClick={confirmDeleteView}>
          {t('savedViews.deleteConfirmAction')}
        </button>
      </div>
    </div>
  )
}

function SavedViewUndoToast({ floating = false }: { readonly floating?: boolean }) {
  const undo = savedViewUndo.value
  if (!undo) return null
  return (
    <div className={floating ? styles.floatingToast : styles.toastSlot}>
      <Toast
        message={undo.message}
        icon={undo.deletion ? 'check' : 'alert'}
        actionLabel={undo.deletion ? t('savedViews.undo') : undefined}
        onAction={undo.deletion ? undoDeleteView : undefined}
        onDismiss={() => dismissDeleteViewUndo(undo)}
      />
    </div>
  )
}
