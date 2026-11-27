/**
 * platform/clipboard.ts: Owner of system clipboard writes (`clipboard-only-in-adapter`, ADR 0022, contracts §18 F14).
 * Invariant: `navigator.clipboard` is reached only through this adapter; callers receive a settled Promise even if the
 * runtime throws synchronously or lacks `navigator.clipboard`.
 */

/** Writes plain text to the system clipboard, returning a rejected Promise when unavailable or denied. */
export function writeClipboardText(text: string): Promise<void> {
  try {
    return navigator.clipboard.writeText(text)
  } catch (error) {
    return Promise.reject(error)
  }
}
