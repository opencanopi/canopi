// app/command-table/reserved-chords.ts  (L2 rank 2, pure)
//
// Authoritative browser-reserved chord table (2.1-Q117, 2.1-Q132, 2.1-Q343):
// chords that Chromium, Firefox or WebKit keep for the browser itself, so Web
// never shows or listens for them and both editions share browser-safe Alt+Shift
// chords instead while Desktop keeps the Ctrl chords as aliases.

export const BROWSER_RESERVED_CHORDS: ReadonlySet<string> = new Set([
  'Ctrl+N',
  'Ctrl+Q',
  'Ctrl+T',
  'Ctrl+W',
  'Ctrl+Shift+P',
  'Ctrl+1',
  'Ctrl+2',
  'Ctrl+3',
  'Ctrl+4',
  'Ctrl+5',
  'Ctrl+6',
  'Ctrl+7',
  'Ctrl+8',
  'Ctrl+9',
])

/**
 * Single keymap query for shortcut text (canopi-f47t.52.76): returns the first
 * live shortcut from a row's canonical list after omitting any chords the
 * edition cannot receive.
 */
export function resolveDisplayedShortcut(
  shortcuts: readonly string[] | undefined,
  unavailable?: ReadonlySet<string>,
): string | undefined {
  if (!shortcuts || shortcuts.length === 0) return undefined
  for (const shortcut of shortcuts) {
    if (!unavailable?.has(shortcut)) return shortcut
  }
  return undefined
}
