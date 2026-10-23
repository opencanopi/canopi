import { useId } from 'preact/hooks'
import { uniqueItemName } from '../../../app/lidar/library-items'
import { t } from '../../../i18n'
import styles from './data-library.module.css'

/** Whether `name` is one the library already uses (see `takenItemNames`). */
export function isItemNameTaken(name: string, taken: ReadonlySet<string>): boolean {
  const trimmed = name.trim()
  return trimmed !== '' && taken.has(trimmed.toLocaleLowerCase())
}

/**
 * A library item's Name field for Import and Rename: a name another item
 * already uses is marked invalid and a free one is suggested, so two items
 * are never told apart by name alone.
 */
export function LibraryItemNameField({ value, taken, onInput, initialFocus }: {
  readonly value: string
  /** Names other items use, from `takenItemNames`. */
  readonly taken: ReadonlySet<string>
  readonly onInput: (value: string) => void
  /** Whether the field takes the surrounding WorkspaceDialog's initial focus (`data-dialog-initial-focus`). */
  readonly initialFocus?: boolean
}) {
  const errorId = useId()
  const trimmed = value.trim()
  const duplicate = isItemNameTaken(value, taken)
  return (
    <label className={styles.field}>
      <span>{t('canvas.lidar.library.name')}</span>
      <input
        name="name"
        required
        value={value}
        data-dialog-initial-focus={initialFocus ? 'true' : undefined}
        aria-invalid={duplicate ? 'true' : undefined}
        aria-describedby={duplicate ? errorId : undefined}
        onInput={(event) => onInput(event.currentTarget.value)}
      />
      {duplicate && (
        <span id={errorId} className={styles.fieldError}>
          {t('canvas.lidar.import.nameTaken', { name: trimmed, suggestion: uniqueItemName(trimmed, taken) })}
        </span>
      )}
    </label>
  )
}
