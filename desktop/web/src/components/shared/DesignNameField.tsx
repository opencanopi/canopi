import { useSignalEffect } from '@preact/signals'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { designRenameRequest } from '../../app/shell/requests'
import { t } from '../../i18n'
import styles from './WorkspaceTitleBar.module.css'

const FALLBACK_DESIGN_NAME = 'Untitled'

/**
 * The Design name in the title bar: a button that turns into a field to
 * rename the Design (also File › Rename…, F2). Enter keeps the new name,
 * Escape restores the old one.
 */
export function DesignNameField({ name, onRename }: {
  readonly name: string
  onRename(name: string): void
}) {
  const visibleName = visibleDesignName(name)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(visibleName)
  const input = useRef<HTMLInputElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const seenRequest = useRef(designRenameRequest.peek())

  useSignalEffect(() => {
    const request = designRenameRequest.value
    if (request === seenRequest.current) return
    seenRequest.current = request
    setDraft(visibleDesignName(name))
    setEditing(true)
  })

  useEffect(() => {
    if (!editing) setDraft(visibleName)
  }, [editing, visibleName])
  // The field takes focus as it replaces the button, so an Esc at once ends the rename (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
    if (!editing) return
    input.current?.focus()
    input.current?.select()
  }, [editing, visibleName])

  function finish(commit: boolean): void {
    const next = draft.trim()
    if (commit && next.length > 0 && next !== name && !(name === FALLBACK_DESIGN_NAME && next === t('titleBar.untitledDesign'))) {
      onRename(next)
    }
    setEditing(false)
    requestAnimationFrame(() => button.current?.focus())
  }

  if (editing) {
    return (
      <input
        ref={input}
        className={styles.nameInput}
        aria-label={t('titleBar.designNameInput')}
        value={draft}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onFocusOut={() => { if (editing) finish(true) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            finish(true)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            finish(false)
          }
        }}
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
