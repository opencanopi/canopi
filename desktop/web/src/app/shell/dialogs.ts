import { signal } from '@preact/signals'

/** Workspace dialogs opened by commands; each dialog component owns its focus and Escape. */
export const settingsDialogOpen = signal(false)
export const keyboardShortcutsDialogOpen = signal(false)

export function openSettingsDialog(): void {
  settingsDialogOpen.value = true
}

export function closeSettingsDialog(): void {
  settingsDialogOpen.value = false
}

/** A section Help › Keyboard shortcuts can open at: the welcome screen's Moving around opens the gestures (2.1-Q310). */
export type KeyboardShortcutsSection = 'gestures'

/**
 * The section the latest open asked for, a new object per request so asking again while the dialog is open moves to it
 * again. The dialog scrolls to it, focuses its heading and clears it: not sticky, so a plain reopen starts at the top.
 */
export const keyboardShortcutsSectionRequest = signal<{ readonly section: KeyboardShortcutsSection } | null>(null)

/** Opens Help › Keyboard shortcuts at the top, or at `section`; an open dialog moves to the section. */
export function openKeyboardShortcutsDialog(options: { readonly section?: KeyboardShortcutsSection } = {}): void {
  keyboardShortcutsSectionRequest.value = options.section ? { section: options.section } : null
  keyboardShortcutsDialogOpen.value = true
}

export function closeKeyboardShortcutsDialog(): void {
  keyboardShortcutsSectionRequest.value = null
  keyboardShortcutsDialogOpen.value = false
}

export const gettingStartedDialogOpen = signal(false)

export function openGettingStartedDialog(): void {
  gettingStartedDialogOpen.value = true
}

export function closeGettingStartedDialog(): void {
  gettingStartedDialogOpen.value = false
}

/** The command palette (Help › Command palette, Ctrl Shift P); Desktop only. */
export const commandPaletteOpen = signal(false)

export function openCommandPalette(): void {
  commandPaletteOpen.value = true
}

export function closeCommandPalette(): void {
  commandPaletteOpen.value = false
}
