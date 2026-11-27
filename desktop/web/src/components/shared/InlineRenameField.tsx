// components/shared/InlineRenameField.tsx
//
// One inline rename field used across Design title bars, views, stories and
// stamps (2.1-Q87, 2.1-Q360): Enter and click-away commit, Escape cancels, and
// a refused rename keeps/reopens the field with the error while preserving the
// user's typed text.

import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import { normaliseObjectName } from '../../app/design-edit'

export type RenameCommitResult = void | null | { readonly error: string } | Promise<void | null | { readonly error: string }>

export interface InlineRenameFieldProps {
  readonly value: string
  readonly ariaLabel: string
  readonly className?: string | undefined
  readonly errorClassName?: string | undefined
  /** If true, an unchanged or empty value cancels silently instead of calling `onCommit`. */
  readonly unchangedName?: string | undefined
  /** Optional fallback display name that should not be persisted when unchanged. */
  readonly fallbackDisplayName?: string | undefined
  /** Optional predicate to cancel instead of commit when focus moves to a matching target (e.g., an inline Cancel button). */
  readonly cancelOnFocusOutTarget?: (relatedTarget: EventTarget | null) => boolean
  readonly onCommit: (name: string) => RenameCommitResult
  readonly onCancel: () => void
}

export function InlineRenameField({
  value,
  ariaLabel,
  className,
  errorClassName,
  unchangedName,
  fallbackDisplayName,
  cancelOnFocusOutTarget,
  onCommit,
  onCancel,
}: InlineRenameFieldProps) {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const settled = useRef(false)

  useLayoutEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  function reopenWithError(raw: string, message: string): void {
    settled.current = false
    setDraft(raw)
    setError(message)
    requestAnimationFrame(() => input.current?.focus())
  }

  function commit(): void {
    if (settled.current) return
    // Read the live DOM value: a value set and Enter pressed in the same task arrive before Preact re-renders.
    const raw = input.current?.value ?? draft
    const normalised = normaliseObjectName(raw)
    if (!normalised.ok) {
      settled.current = true
      onCancel()
      return
    }
    const next = normalised.name
    if (
      (unchangedName !== undefined && next === unchangedName)
      || (fallbackDisplayName !== undefined && next === fallbackDisplayName)
    ) {
      settled.current = true
      onCancel()
      return
    }
    settled.current = true
    let result: RenameCommitResult
    try {
      result = onCommit(next)
    } catch (err) {
      reopenWithError(raw, err instanceof Error ? err.message : String(err))
      return
    }
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      void (result as Promise<void | null | { readonly error: string }>).then(
        (resolved) => {
          if (resolved && 'error' in resolved && resolved.error) {
            reopenWithError(raw, resolved.error)
          }
        },
        (err: unknown) => {
          reopenWithError(raw, err instanceof Error ? err.message : String(err))
        },
      )
    } else if (result && typeof result === 'object' && 'error' in result && result.error) {
      reopenWithError(raw, result.error)
    }
  }

  function cancel(): void {
    if (settled.current) return
    settled.current = true
    onCancel()
  }

  return (
    <>
      <input
        ref={input}
        className={className}
        aria-label={ariaLabel}
        aria-invalid={error ? 'true' : undefined}
        value={draft}
        onInput={(event) => {
          setDraft(event.currentTarget.value)
          if (error) setError(null)
        }}
        onFocusOut={(event) => {
          if (cancelOnFocusOutTarget?.(event.relatedTarget)) {
            cancel()
            return
          }
          commit()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            cancel()
          }
        }}
      />
      {error && (
        <span role="alert" className={errorClassName}>
          {error}
        </span>
      )}
    </>
  )
}
