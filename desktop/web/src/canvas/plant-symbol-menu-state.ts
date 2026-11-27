import { signal } from '@preact/signals'

// Component-scoped canvas UI state. The menu open flag is not part of scene or document authority.
export const plantSymbolMenuOpen = signal<boolean>(false)

export function setPlantSymbolMenuOpen(open: boolean): void {
  plantSymbolMenuOpen.value = open
}
