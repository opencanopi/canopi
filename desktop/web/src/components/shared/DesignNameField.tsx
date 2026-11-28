import { useSignalEffect } from '@preact/signals'
import { useRef, useState } from 'preact/hooks'
import { designRenameRequest } from '../../app/shell/requests'
import { t } from '../../i18n'
import { InlineRenameField, type RenameCommitResult } from './InlineRenameField'
import styles from './WorkspaceTitleBar.module.css'

const FALLBACK_DESIGN_NAME = 'Untitled'

/**
 * The Design name in the title bar: a button that turns into the shared
 * `InlineRenameField` to rename the Design (also File › Rename…, F2).
 * Enter and click-away keep the new name, Escape restores the old one, and a
 * refused rename reopens the field with the error keeping the typed name
 * (2.1-Q87, 2.1-Q360).
 */
export function DesignNameField({ name, onRename }: {
  readonly name: string
  onRename(name: string): RenameCommitResult
}) {
  const visibleName = visibleDesignName(name)
  const [editing, setEditing] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const seenRequest = useRef(designRenameRequest.peek())

  useSignalEffect(() => {
    const request = designRenameRequest.value
    if (request === seenRequest.current) return
    seenRequest.current = request
    setEditing(true)
  })

  function closeEditing(): void {
    setEditing(false)
    requestAnimationFrame(() => button.current?.focus())
  }

  if (editing) {
    return (
      <InlineRenameField
        value={visibleName}
        ariaLabel={t('titleBar.designNameInput')}
        className={styles.nameInput}
        unchangedName={name}
        fallbackDisplayName={name === FALLBACK_DESIGN_NAME ? t('titleBar.untitledDesign') : undefined}
        onCommit={(next) => {
          const result = onRename(next)
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            return (result as Promise<void | null | { readonly error: string }>).then((resolved) => {
              if (!resolved || !('error' in resolved) || !resolved.error) closeEditing()
              return resolved
            })
          }
          if (!result || !('error' in result) || !result.error) closeEditing()
          return result
        }}
        onCancel={closeEditing}
      />
    )
  }

  return (
    <button
      ref={button}
      type="button"
      className={styles.nameButton}
      aria-label={t('titleBar.renameDesign', { name: visibleName })}
      aria-keyshortcuts="F2"
      onClick={() => setEditing(true)}
    >
      <span className={styles.nameText}>{visibleName}</span>
    </button>
  )
}

export function visibleDesignName(name: string): string {
  return !name || name === FALLBACK_DESIGN_NAME ? t('titleBar.untitledDesign') : name
}
