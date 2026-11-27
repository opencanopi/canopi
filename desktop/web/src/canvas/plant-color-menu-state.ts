import { signal } from '@preact/signals'

// Component-scoped canvas UI state. The menu open flag is not part of scene or document authority.
export const plantColorMenuOpen = signal<boolean>(false)

export function setPlantColorMenuOpen(open: boolean): void {
  plantColorMenuOpen.value = open
}
