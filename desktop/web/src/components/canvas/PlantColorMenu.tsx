import { plantColorMenuOpen, setPlantColorMenuOpen } from '../../app/canvas-context-menu/state'
import { useEffect, useState } from 'preact/hooks'
import {
  currentCanvasPlantPresentationCommandSurface,
  currentCanvasQuerySurface,
  currentCanvasSelection,
} from '../../canvas/session'
import {
  DEFAULT_PLANT_COLOR,
  normalizeHexColor,
} from '../../canvas/plant-colors'
import { t } from '../../i18n'
import { usePopoverEscapeLayer } from '../../app/keyboard/use-popover-escape-layer'
import { PlantSymbolGlyph } from './PlantSymbolGlyph'
import { navigateAppearanceChoices, useAppearancePopover, type AppearanceAnchorRef } from './useAppearancePopover'
import { createPortal } from 'preact'
import { SurfaceHeader } from '../shared/SurfaceHeader'
import { CanopiColorPicker } from './CanopiColorPicker'
import { AppearanceSelection } from './AppearanceSelection'
import shared from './appearance.module.css'

interface PlantColorMenuProps {
  buttonRef: AppearanceAnchorRef
}

function closeMenu(buttonRef?: AppearanceAnchorRef) {
  setPlantColorMenuOpen(false)
  buttonRef?.current?.focus()
}

export function PlantColorMenu({ buttonRef }: PlantColorMenuProps) {
  void currentCanvasSelection.value
  const commandSurface = currentCanvasPlantPresentationCommandSurface.value
  const querySurface = currentCanvasQuerySurface.value
  // A species colour set elsewhere, or undone, moves the scene revision.
  void querySurface?.revision.scene.value
  void querySurface?.revision.plantNames.value
  const menuOpen = plantColorMenuOpen.value
  const menuRef = useAppearancePopover(menuOpen, buttonRef, {
    onOutsidePointer: () => closeMenu(),
  })
  const context = querySurface?.getSelectedPlantColorContext() ?? {
    plantIds: [],
    singleSpeciesCanonicalName: null,
    singleSpeciesCommonName: null,
    sharedCurrentColor: null,
    singleSpeciesDefaultColor: null,
  }

  const [activeColor, setActiveColor] = useState<string | null>(DEFAULT_PLANT_COLOR)
  const [customInput, setCustomInput] = useState(DEFAULT_PLANT_COLOR)

  const selectionKey = context.plantIds.join('|')
  const hasSelectedPlants = context.plantIds.length > 0

  useEffect(() => {
    if (!menuOpen) return

    const initialColor =
      context.sharedCurrentColor === 'mixed'
        ? context.singleSpeciesDefaultColor ?? DEFAULT_PLANT_COLOR
        : context.sharedCurrentColor
          ?? context.singleSpeciesDefaultColor
          ?? DEFAULT_PLANT_COLOR

    setActiveColor(initialColor)
    setCustomInput(initialColor)
  }, [menuOpen, selectionKey, context.sharedCurrentColor, context.singleSpeciesDefaultColor])

  // An Esc from outside the menu closes it, and only it (the Esc chain's popover layer, fixture I8); inside, the
  // menu's own handler takes the Esc first.
  usePopoverEscapeLayer(menuOpen && hasSelectedPlants, () => closeMenu(buttonRef))

  if (!menuOpen || !hasSelectedPlants) return null

  const normalizedActiveColor = normalizeHexColor(activeColor)
  const canApply = normalizedActiveColor !== null
  const singleSpeciesLabel = context.singleSpeciesCommonName ?? context.singleSpeciesCanonicalName
  const selectionSummary =
    singleSpeciesLabel
      ? singleSpeciesLabel
      : t('canvas.plantColor.selectedCount', { count: context.plantIds.length })
  const previewColor = normalizedActiveColor ?? DEFAULT_PLANT_COLOR
  const applyToSelection = () => {
    if (!normalizedActiveColor) return
    commandSurface?.setSelectedPlantColor(normalizedActiveColor)
    closeMenu(buttonRef)
  }

  const applyToSpecies = () => {
    if (!normalizedActiveColor || !context.singleSpeciesCanonicalName) return
    commandSurface?.setPlantColorForSpecies(context.singleSpeciesCanonicalName, normalizedActiveColor)
    closeMenu(buttonRef)
  }

  const effectiveSymbol = querySurface?.getSelectedPlantSymbolContext().sharedEffectiveSymbol
  const previewSymbol = !effectiveSymbol || effectiveSymbol === 'mixed' ? 'round' : effectiveSymbol

  return createPortal(
    <div
      ref={menuRef}
      className={shared.menu}
      role="dialog"
      aria-label={t('canvas.plantColor.label')}
      data-preserve-overlays="true"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(buttonRef) }
        else navigateAppearanceChoices(event, 6)
      }}
    >
      <SurfaceHeader title={t('canvas.plantColor.label')} closeLabel={t('window.close')} onClose={() => closeMenu(buttonRef)} />
      <AppearanceSelection
        commonName={context.singleSpeciesCommonName}
        canonicalName={context.singleSpeciesCanonicalName}
        summary={selectionSummary}
        count={context.plantIds.length}
        countLabel={t('canvas.plantColor.selectedCount', { count: context.plantIds.length })}
        preview={<span style={{ color: previewColor }}><PlantSymbolGlyph symbol={previewSymbol} size={32} /></span>}
        detail={normalizedActiveColor ?? customInput}
      />
      <div className={shared.body}>
        <CanopiColorPicker
          value={activeColor}
          resetKey={`${menuOpen}:${selectionKey}`}
          paletteLabel={t('canvas.plantColor.label')}
          onChange={(nextHex, raw) => {
            setActiveColor(nextHex)
            setCustomInput(raw)
          }}
        />
      </div>
      <div className={shared.actions}>
        <button
          type="button"
          className={shared.primaryAction}
          disabled={!canApply}
          onClick={applyToSelection}
        >
          {t('canvas.plantColor.applySelection', { count: context.plantIds.length })}
        </button>
        {context.singleSpeciesCanonicalName && singleSpeciesLabel && (
          <button type="button" className={shared.secondaryAction} disabled={!canApply} onClick={applyToSpecies}>
            {t('canvas.plantColor.setColorForSpecies', { species: singleSpeciesLabel })}
          </button>
        )}
      </div>
    </div>, document.body,
  )
}
