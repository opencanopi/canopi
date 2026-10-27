import { useId, useRef, useState } from 'preact/hooks'
import {
  applyRotateSelection,
  closeRotateSelectionDialog,
  parseRotationDegrees,
  rotateSelectionDialog,
  stepRotationDegrees,
} from '../../app/rotate-selection/state'
import { locale } from '../../app/settings/state'
import { t } from '../../i18n'
import { WorkspaceDialog } from '../shared/WorkspaceDialog'
import styles from './RotateSelectionDialog.module.css'

const STEP_DEGREES = 15

/**
 * Rotate… (Edit menu, right-click menu, Ctrl Alt R): turns the selection
 * about its centre by a typed angle, as one undoable edit. Both editions
 * mount it with the other workspace dialogs.
 */
export function RotateSelectionDialog() {
  if (!rotateSelectionDialog.value) return null
  return <RotateSelectionDialogContent />
}

function RotateSelectionDialogContent() {
  const [text, setText] = useState('0')
  const [invalid, setInvalid] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const formId = useId()
  const hintId = `${formId}-hint`
  const errorId = `${formId}-error`
  const activeLocale = locale.value

  const step = (delta: number) => {
    const next = stepRotationDegrees(text, delta)
    setText(new Intl.NumberFormat(activeLocale, { maximumFractionDigits: 2, useGrouping: false }).format(next))
    setInvalid(false)
  }

  return (
    <WorkspaceDialog
      title={t('canvas.rotateDialog.title')}
      onClose={closeRotateSelectionDialog}
      footer={(
        <>
          <button type="button" className={styles.button} onClick={closeRotateSelectionDialog}>
            {t('canvas.rotateDialog.cancel')}
          </button>
          <button type="submit" form={formId} className={`${styles.button} ${styles.primary}`}>
            {t('canvas.rotateDialog.rotate')}
          </button>
        </>
      )}
    >
      <form
        id={formId}
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          if (applyRotateSelection(text)) return
          setInvalid(true)
          input.current?.focus()
        }}
      >
        <label className={styles.label} htmlFor={`${formId}-angle`}>{t('canvas.rotateDialog.angle')}</label>
        <div className={styles.row}>
          <button
            type="button"
            className={`${styles.button} ${styles.step}`}
            aria-label={t('canvas.rotateDialog.subtract', { degrees: STEP_DEGREES })}
            data-rotate-step={-STEP_DEGREES}
            onClick={() => step(-STEP_DEGREES)}
          >
            −{STEP_DEGREES}°
          </button>
          <span className={styles.field} data-invalid={invalid ? 'true' : undefined}>
            <input
              ref={input}
              id={`${formId}-angle`}
              className={styles.input}
              inputMode="decimal"
              autoComplete="off"
              data-dialog-initial-focus
              value={text}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={invalid ? `${errorId} ${hintId}` : hintId}
              onFocusIn={(event) => event.currentTarget.select()}
              onInput={(event) => {
                const value = event.currentTarget.value
                setText(value)
                if (invalid && parseRotationDegrees(value) !== null) setInvalid(false)
              }}
            />
            <span className={styles.unit} aria-hidden="true">°</span>
          </span>
          <button
            type="button"
            className={`${styles.button} ${styles.step}`}
            aria-label={t('canvas.rotateDialog.add', { degrees: STEP_DEGREES })}
            data-rotate-step={STEP_DEGREES}
            onClick={() => step(STEP_DEGREES)}
          >
            +{STEP_DEGREES}°
          </button>
        </div>
        {invalid && <p className={styles.error} id={errorId} role="alert">{t('canvas.rotateDialog.invalid')}</p>}
        <p className={styles.hint} id={hintId}>{t('canvas.rotateDialog.hint')}</p>
      </form>
    </WorkspaceDialog>
  )
}
