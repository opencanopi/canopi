/**
 * failures/toasts.ts: the transient results the one window-level toast slot shows for a raiser that is not a component
 * (notice-only-in-failures, contracts §18 F3, design check F16, 2.1-Q292). Invariant: a toast confirms what the user
 * just did ("Import cancelled", 2.1-Q298) and leaves by itself; it never waits in the notice row's queue, so notices
 * queued there never hide it; a toast whose key is already shown restarts it instead of adding one. A toast holds locale
 * keys, never words, so it re-renders in the current locale. components/shared/ToastSlot.tsx draws them.
 */
import { signal, type ReadonlySignal } from '@preact/signals'
import type { LocaleKey } from '../generated/locale-keys'

interface ToastSpec {
  /** The raiser's name for this result: a toast with the same key replaces the one shown. */
  readonly key: string
  readonly message: LocaleKey
  readonly params?: Readonly<Record<string, string | number>>
  /** How long it stays when nobody hovers or focuses it; the slot's default when omitted. */
  readonly timeoutMs?: number
}

interface ShownToast extends ToastSpec {
  readonly id: number
}

const shown = signal<readonly ShownToast[]>([])
let nextId = 1

/** The toasts on screen, oldest first. */
export const toasts: ReadonlySignal<readonly ShownToast[]> = shown

/** Shows a transient result; one already shown under the same key is replaced (and its countdown restarts). */
export function showToast(spec: ToastSpec): number {
  const toast: ShownToast = { ...spec, id: nextId++ }
  shown.value = [...shown.peek().filter((other) => other.key !== spec.key), toast]
  return toast.id
}

/** Removes a toast that timed out or that the user dismissed. */
export function dismissToast(id: number): void {
  if (!shown.peek().some((toast) => toast.id === id)) return
  shown.value = shown.peek().filter((toast) => toast.id !== id)
}

/** @testonly */
export function resetToastsForTests(): void {
  shown.value = []
  nextId = 1
}
