import { useId, useState } from 'preact/hooks'
import {
  applyRenameZone,
  closeRenameZoneDialog,
  renameZoneDialog,
} from '../../app/rename-zone/state'
import { t } from '../../i18n'
import { WorkspaceDialog } from '../shared/WorkspaceDialog'
import styles from './RenameZoneDialog.module.css'

/**
 * Rename zone… (right-click menu, selection chip): gives a lone zone a
 * display name as one undoable edit. An empty name clears it, and the zone is
 * then named by its type and size. Both editions mount it with the other
 * workspace dialogs.
 */
export function RenameZoneDialog() {
  const target = renameZoneDialog.value
  if (!target) return null
  return <RenameZoneDialogContent key={target.zoneId} initialName={target.name ?? ''} />
}

function RenameZoneDialogContent({ initialName }: { readonly initialName: string }) {
  const [text, setText] = useState(initialName)
  const formId = useId()
  const hintId = `${formId}-hint`

  return (
    <WorkspaceDialog
      title={t('canvas.renameZoneDialog.title')}
      onClose={closeRenameZoneDialog}
      footer={(
        <>
          <button type="button" className={styles.button} onClick={closeRenameZoneDialog}>
            {t('canvas.renameZoneDialog.cancel')}
          </button>
          <button type="submit" form={formId} className={`${styles.button} ${styles.primary}`}>
            {t('canvas.renameZoneDialog.rename')}
          </button>
        </>
      )}
    >
      <form
        id={formId}
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          applyRenameZone(text)
        }}
      >
        <label className={styles.label} htmlFor={`${formId}-name`}>{t('canvas.renameZoneDialog.name')}</label>
        <input
          id={`${formId}-name`}
          className={styles.input}
          autoComplete="off"
          spellcheck={false}
          data-dialog-initial-focus
          value={text}
          aria-describedby={hintId}
          onFocusIn={(event) => event.currentTarget.select()}
          onInput={(event) => setText(event.currentTarget.value)}
        />
        <p className={styles.hint} id={hintId}>{t('canvas.renameZoneDialog.hint')}</p>
      </form>
    </WorkspaceDialog>
  )
}
