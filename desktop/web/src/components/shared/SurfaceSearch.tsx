import type { Ref, TargetedKeyboardEvent } from 'preact'
import { useImperativeHandle, useRef } from 'preact/hooks'
import { t } from '../../i18n'
import { ControlIcon } from './ControlIcon'
import styles from './SurfaceSearch.module.css'

/**
 * A panel search field. The clear button replaces the optional key hint (e.g. "Ctrl F")
 * once there is text; `keyShortcuts` is the matching `aria-keyshortcuts` value.
 */
export function SurfaceSearch({ value, onChange, label, placeholder, shortcutHint, keyShortcuts, inputRef, onKeyDown, controls }: {
  value: string
  onChange(value: string): void
  label: string
  /** Visible prompt; defaults to the label. */
  placeholder?: string
  shortcutHint?: string
  keyShortcuts?: string
  inputRef?: Ref<HTMLInputElement | null>
  onKeyDown?: (event: TargetedKeyboardEvent<HTMLInputElement>) => void
  /** The id of the list the field filters (`aria-controls`). */
  controls?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  useImperativeHandle(inputRef ?? null, () => input.current, [])
  return <div className={styles.search}>
    <ControlIcon name="search" className={styles.icon} />
    <input ref={input} type="search" value={value} aria-label={label} placeholder={placeholder ?? label}
      aria-keyshortcuts={keyShortcuts} aria-controls={controls} onKeyDown={onKeyDown}
      onInput={event => onChange(event.currentTarget.value)} />
    {value
      ? <button type="button" className={styles.clear} aria-label={t('speciesKey.clearSearch')}
        onClick={() => { onChange(''); input.current?.focus() }}><ControlIcon name="close" /></button>
      : shortcutHint && <kbd className={styles.hint} aria-hidden="true">{shortcutHint}</kbd>}
  </div>
}
