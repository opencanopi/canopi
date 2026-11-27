// components/shared/InlineRenameField.tsx
//
// One inline rename field used across Design title bars, views, stories and
// stamps (2.1-Q87, 2.1-Q360): Enter and click-away commit, Escape cancels, and
// a refused rename keeps/reopens the field with the error while preserving the
// user's typed text.

import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import { normaliseObjectName } from '../../utils/object-name'

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
    const result = onCommit(next)
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      void (result as Promise<void | null | { readonly error: string }>).then(
        (resolved) => {
          if (resolved && 'error' in resolved && resolved.error) {
            settled.current = false
            setDraft(raw)
            setError(resolved.error)
            requestAnimationFrame(() => input.current?.focus())
          }
        },
        (err: unknown) => {
          settled.current = false
          setDraft(raw)
          setError(err instanceof Error ? err.message : String(err))
          requestAnimationFrame(() => input.current?.focus())
        },
      )
    } else if (result && typeof result === 'object' && 'error' in result && result.error) {
      settled.current = false
      setDraft(raw)
      setError(result.error)
      requestAnimationFrame(() => input.current?.focus())
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
        onFocusOut={() => commit()}
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
