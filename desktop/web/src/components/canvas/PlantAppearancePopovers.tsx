import type { RefObject } from 'preact'
import { useEffect, useMemo } from 'preact/hooks'
import {
  closePlantAppearance,
  plantAppearanceAnchor,
  type PlantAppearanceAnchor,
} from '../../app/canvas-context-menu/state'
import { focusOwner } from '../../app/keyboard/focus-owner'
import { plantColorMenuOpen } from '../../canvas/plant-color-menu-state'
import { plantSymbolMenuOpen } from '../../canvas/plant-symbol-menu-state'
import { currentCanvasQuerySurface, currentCanvasSelection } from '../../canvas/session'
import { PlantColorMenu } from './PlantColorMenu'
import { PlantSymbolMenu } from './PlantSymbolMenu'

/** Where a popover opens when nothing anchored it: the map's top-left corner. */
const FALLBACK_OFFSET_PX = { right: 64, top: 72 }

/**
 * Plant colour and symbol popovers for the selected plants, opened from the
 * right-click menu beside the item that opened them. They close when no plant
 * stays selected.
 */
export function PlantAppearancePopovers({ canvasRef }: { readonly canvasRef: RefObject<HTMLDivElement | null> }) {
  void currentCanvasSelection.value
  const querySurface = currentCanvasQuerySurface.value
  const hasSelectedPlants = (querySurface?.getSelectedPlantColorContext().plantIds.length ?? 0) > 0
  const colorOpen = plantColorMenuOpen.value
  const symbolOpen = plantSymbolMenuOpen.value
  const anchor = plantAppearanceAnchor.value

  useEffect(() => {
    if (!hasSelectedPlants) closePlantAppearance()
  }, [hasSelectedPlants])

  const anchorRef = useMemo(
    () => ({ current: anchor ?? mapCornerAnchor(canvasRef) }),
    [anchor, canvasRef],
  )

  if (!hasSelectedPlants) return null
  if (colorOpen) return <PlantColorMenu buttonRef={anchorRef} />
  if (symbolOpen) return <PlantSymbolMenu buttonRef={anchorRef} />
  return null
}

function mapCornerAnchor(canvasRef: RefObject<HTMLDivElement | null>): PlantAppearanceAnchor {
  return {
    getBoundingClientRect: () => {
      const rect = canvasRef.current?.getBoundingClientRect()
      return {
        top: (rect?.top ?? 0) + FALLBACK_OFFSET_PX.top,
        right: (rect?.left ?? 0) + FALLBACK_OFFSET_PX.right,
      }
    },
    // Closing gives focus back to the map, through the focus owner.
    focus: () => focusOwner.focusMap(),
  }
}
