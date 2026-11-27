import { batch, signal } from '@preact/signals'
import type { CanvasContextMenuRequest } from '../../canvas/runtime/app-adapter'

// Component-scoped canvas UI state. The menu open flags are not part of scene or document authority.
export const plantColorMenuOpen = signal<boolean>(false)

export function setPlantColorMenuOpen(open: boolean): void {
  plantColorMenuOpen.value = open
}

export const plantSymbolMenuOpen = signal<boolean>(false)

export function setPlantSymbolMenuOpen(open: boolean): void {
  plantSymbolMenuOpen.value = open
}

/** The open right-click menu, or null. The canvas runtime opens and closes it. */
export const canvasContextMenuRequest = signal<CanvasContextMenuRequest | null>(null)

/** Opens `request`'s menu; a menu it replaces has closed (its request's `closed`). */
export function openCanvasContextMenu(request: CanvasContextMenuRequest): void {
  const replaced = canvasContextMenuRequest.peek()
  batch(() => {
    closePlantAppearance()
    canvasContextMenuRequest.value = request
  })
  if (replaced && replaced !== request) replaced.closed?.()
}

/**
 * Closes `request`'s menu if it is still open; with no argument, whatever is open. Every close of the menu, the app's
 * own and the runtime's, comes here and tells the closed request (`closed`).
 */
export function closeCanvasContextMenu(request?: CanvasContextMenuRequest): void {
  const open = canvasContextMenuRequest.peek()
  if (!open || (request && open !== request)) return
  canvasContextMenuRequest.value = null
  open.closed?.()
}

/** Where a plant colour or symbol popover opens and where Escape returns focus. */
export interface PlantAppearanceAnchor {
  getBoundingClientRect(): { readonly top: number; readonly right: number }
  focus(options?: FocusOptions): void
}

/** Null until the right-click menu opens a popover; the popovers then fall back to the map. */
export const plantAppearanceAnchor = signal<PlantAppearanceAnchor | null>(null)

export type PlantAppearanceKind = 'color' | 'symbol'

export function openPlantAppearance(kind: PlantAppearanceKind, anchor: PlantAppearanceAnchor): void {
  batch(() => {
    plantAppearanceAnchor.value = anchor
    setPlantColorMenuOpen(kind === 'color')
    setPlantSymbolMenuOpen(kind === 'symbol')
  })
}

export function closePlantAppearance(): void {
  batch(() => {
    setPlantColorMenuOpen(false)
    setPlantSymbolMenuOpen(false)
  })
}
