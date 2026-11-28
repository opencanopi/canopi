import type {
  CanvasContextMenuAnchor,
  CanvasContextMenuCommands,
  CanvasContextMenuRequest,
  CanvasRuntimeContextMenuAdapter,
} from '../app-adapter'
import type { CanvasDesignObjectSelectionModel } from '../runtime'
import type { ScenePoint } from '../scene'
import type { ViewTransform, WorldQuad } from '../../../geo/view/types'

/** The optional entries the host carries onto a request; the keyboard menu never has Turn view to this edge. */
type PointerMenuEntries = Pick<CanvasContextMenuRequest, 'finishShape' | 'turnViewToEdge' | 'holdsSelectionDeletes' | 'pointActions'>
type KeyboardMenuEntries = Omit<PointerMenuEntries, 'turnViewToEdge' | 'pointActions'>

interface CanvasContextMenuOptions {
  readonly container: HTMLElement
  /** The live frame's view, read when the menu opens. */
  readonly view: () => ViewTransform
  readonly adapter: CanvasRuntimeContextMenuAdapter | undefined
  readonly commands: CanvasContextMenuCommands
  readonly saveSelectionAsObjectStamp?: () => void
  readonly placePlantsAt?: (world: ScenePoint) => void
  /** Focuses the map: a request's returnFocus when nothing inside the map held focus at the open, or it has gone. */
  readonly returnFocus: () => void
}

/**
 * Turns a right-click or the Menu key into one menu request for the app to
 * render. The session owns this controller; the app owns the menu's DOM.
 */
export interface CanvasContextMenuController {
  /** `screen` is container-relative; `selection` is null on the empty map. `entries`: the request's optional entries from
   *  the host, Finish shape (a polygon draft that can finish) and Turn view to this edge (the pointer on a zone's edge,
   *  spec §4.16), holdsSelectionDeletes (U39), and a point menu's entries (A16, with a null selection). */
  openAtPointer(screen: ScenePoint, selection: CanvasDesignObjectSelectionModel | null, entries?: PointerMenuEntries): void
  /** Menu key or Shift F10: beside the selection's projected hull (`hull`, the world quad of the screen box of the shapes it
   *  draws, tools/select/selection-hull.ts; tool-host.test.ts "the keyboard menu opens beside a shape drawn level at 45"),
   *  else mid-map (the empty-map menu without a selection). `entries`: Finish shape and holdsSelectionDeletes, as a
   *  pointer menu's; never Turn view to this edge (spec §4.16). */
  openFromKeyboard(selection: CanvasDesignObjectSelectionModel, hull: WorldQuad | null, entries?: KeyboardMenuEntries): void
  /** True from an open until the app closes the menu (the request's `closed`) or close() closes it. */
  isOpen(): boolean
  /** `restoreFocus`: when focus is outside the map (in the menu), the request's returnFocus runs after the close. */
  close(options?: { readonly restoreFocus?: boolean }): void
  dispose(): void
}

export function createCanvasContextMenu(options: CanvasContextMenuOptions): CanvasContextMenuController {
  let openRequest: CanvasContextMenuRequest | null = null

  function open(
    anchor: CanvasContextMenuAnchor,
    world: ScenePoint,
    selection: CanvasDesignObjectSelectionModel | null,
    entries: PointerMenuEntries = {},
  ): void {
    const adapter = options.adapter
    if (!adapter) return
    const opener = focusedInside(options.container)
    const request: CanvasContextMenuRequest = {
      anchor,
      world,
      selection,
      commands: options.commands,
      ...(options.saveSelectionAsObjectStamp
        ? { saveSelectionAsObjectStamp: options.saveSelectionAsObjectStamp }
        : {}),
      ...(options.placePlantsAt ? { placePlantsAt: options.placePlantsAt } : {}),
      ...(entries.finishShape ? { finishShape: entries.finishShape } : {}),
      ...(entries.turnViewToEdge ? { turnViewToEdge: entries.turnViewToEdge } : {}),
      ...(entries.holdsSelectionDeletes ? { holdsSelectionDeletes: true as const } : {}),
      ...(entries.pointActions ? { pointActions: entries.pointActions } : {}),
      // Focus goes back to its opener inside the map while that is still there (a corner focused for Shift+F10, so
      // Delete then reaches the corner, U37), else to the map. The app restores focus before it runs the chosen
      // command (ActionMenu.activate), so the check repeats once that command has run: one that removed the opener
      // (Delete on a line's end) and left focus nowhere hands it to the map.
      returnFocus: () => {
        if (!opener || !options.container.contains(opener)) {
          options.returnFocus()
          return
        }
        opener.focus({ preventScroll: true })
        queueMicrotask(() => {
          if (!options.container.contains(opener) && focusIsLost(options.container.ownerDocument)) options.returnFocus()
        })
      },
      closed: () => {
        if (openRequest === request) openRequest = null
      },
    }
    openRequest = request
    adapter.open(request)
  }

  function containerOrigin(): { left: number; top: number } {
    const rect = options.container.getBoundingClientRect()
    return { left: rect.left, top: rect.top }
  }

  return {
    openAtPointer(screen, selection, entries) {
      const world = options.view().screenToWorld(screen)
      const origin = containerOrigin()
      const x = origin.left + screen.x
      const y = origin.top + screen.y
      open({ left: x, top: y, right: x, bottom: y }, world, selection, entries)
    },
    openFromKeyboard(selection, hull, entries) {
      const origin = containerOrigin()
      const target = hasSelectedObjects(selection) ? selection : null
      const bounds = target?.bounds ?? null
      const view = options.view()
      if (!bounds || !hull) {
        const centre = { x: view.screen.width / 2, y: view.screen.height / 2 }
        const world = view.screenToWorld(centre)
        const x = origin.left + centre.x
        const y = origin.top + centre.y
        open({ left: x, top: y, right: x, bottom: y }, world, target, entries)
        return
      }
      // The hull's four projected corners: two would miss its box on a turned map.
      const corners = view.worldQuadToScreen(hull)
      const xs = corners.map((corner) => corner.x)
      const ys = corners.map((corner) => corner.y)
      open(
        {
          left: origin.left + Math.min(...xs),
          top: origin.top + Math.min(...ys),
          right: origin.left + Math.max(...xs),
          bottom: origin.top + Math.max(...ys),
        },
        { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
        selection,
        entries,
      )
    },
    isOpen: () => openRequest !== null,
    close(closeOptions) {
      const request = openRequest
      openRequest = null
      if (!request) return
      const focusInMenu = closeOptions?.restoreFocus === true && focusIsOutside(options.container)
      options.adapter?.close(request)
      if (focusInMenu) request.returnFocus()
    },
    dispose() {
      this.close()
    },
  }
}

/** The element inside the map, not the map itself, that holds focus. */
function focusedInside(container: HTMLElement): HTMLElement | null {
  const focused = container.ownerDocument.activeElement
  return focused instanceof HTMLElement && focused !== container && container.contains(focused) ? focused : null
}

/** Focus is on an element outside the map: an open menu holds it, as focus leaving the menu closes it. */
function focusIsOutside(container: HTMLElement): boolean {
  const focused = container.ownerDocument.activeElement
  return focused instanceof HTMLElement && focused !== container.ownerDocument.body && !container.contains(focused)
}

function focusIsLost(document: Document): boolean {
  return document.activeElement === null || document.activeElement === document.body
}

function hasSelectedObjects(selection: CanvasDesignObjectSelectionModel): boolean {
  return selection.editableTargets.length + selection.lockedTargets.length > 0
}
