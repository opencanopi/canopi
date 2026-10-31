import { useEffect, useLayoutEffect, useState } from 'preact/hooks'
import { currentCanvasPlantPresentationCommandSurface, currentCanvasQuerySurface, currentCanvasSelection } from '../../canvas/session'
import { plantSymbolMenuOpen } from '../../canvas/plant-symbol-menu-state'
import { DEFAULT_PLANT_COLOR, normalizeHexColor } from '../../canvas/plant-colors'
import {
  DEFAULT_PLANT_SYMBOL_ID,
  type PlantSymbolId,
} from '../../canvas/runtime/scene'
import { PLANT_SYMBOL_FAMILIES, type PlantSymbolFamily } from '../../canvas/runtime/plant-symbol-recipes'
import { t } from '../../i18n'
import { usePopoverEscapeLayer } from '../../app/keyboard/use-popover-escape-layer'
import { PlantSymbolGlyph } from './PlantSymbolGlyph'
import { navigateAppearanceChoices, useAppearancePopover, type AppearanceAnchorRef } from './useAppearancePopover'
import { createPortal } from 'preact'
import { SurfaceHeader } from '../shared/SurfaceHeader'
import { AppearanceSelection } from './AppearanceSelection'
import shared from './appearance.module.css'
import styles from './PlantSymbolMenu.module.css'

interface PlantSymbolMenuProps {
  buttonRef: AppearanceAnchorRef
}

const SYMBOL_GRID_COLUMNS = 5

function closeMenu(buttonRef?: AppearanceAnchorRef) {
  plantSymbolMenuOpen.value = false
  buttonRef?.current?.focus()
}

export function PlantSymbolMenu({ buttonRef }: PlantSymbolMenuProps) {
  void currentCanvasSelection.value
  const commandSurface = currentCanvasPlantPresentationCommandSurface.value
  const querySurface = currentCanvasQuerySurface.value
  void querySurface?.revision.plantNames.value
  const menuOpen = plantSymbolMenuOpen.value
  const menuRef = useAppearancePopover(menuOpen, buttonRef)
  const context = querySurface?.getSelectedPlantSymbolContext() ?? {
    plantIds: [],
    singleSpeciesCanonicalName: null,
    singleSpeciesCommonName: null,
    sharedCurrentSymbol: null,
    sharedEffectiveSymbol: DEFAULT_PLANT_SYMBOL_ID,
    inheritedSymbol: null,
    singleSpeciesDefaultSymbol: null,
    canClearSelectedSymbol: false,
  }
  const [activeSymbol, setActiveSymbol] = useState<PlantSymbolId>(() => resolveInitialSymbol(context.sharedCurrentSymbol, context.inheritedSymbol, context.sharedEffectiveSymbol))
  const selectionKey = context.plantIds.join('|')
  const hasSelectedPlants = context.plantIds.length > 0

  useLayoutEffect(() => {
    if (!menuOpen) return
    const initial = resolveInitialSymbol(
      context.sharedCurrentSymbol,
      context.inheritedSymbol,
      context.sharedEffectiveSymbol,
    )
    setActiveSymbol(initial)
    const focused = document.activeElement
    if (focused instanceof HTMLElement && menuRef.current?.contains(focused) && focused.getAttribute('role') === 'option') {
      menuRef.current.querySelector<HTMLButtonElement>(`[data-symbol="${initial}"]`)?.focus({ preventScroll: true })
    }
  }, [menuOpen, selectionKey, context.sharedCurrentSymbol, context.sharedEffectiveSymbol, context.inheritedSymbol])

  useEffect(() => {
    if (!menuOpen) return

    const handlePointerUp = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('[data-preserve-overlays="true"]')) return
      closeMenu()
    }

    document.addEventListener('pointerup', handlePointerUp)
    return () => document.removeEventListener('pointerup', handlePointerUp)
  }, [menuOpen])

  // An Esc from outside the menu closes it, and only it (the Esc chain's popover layer, fixture I8); inside, the
  // menu's own handler takes the Esc first.
  usePopoverEscapeLayer(menuOpen && hasSelectedPlants, () => closeMenu(buttonRef))

  if (!menuOpen || !hasSelectedPlants) return null

  const singleSpeciesLabel = context.singleSpeciesCommonName ?? context.singleSpeciesCanonicalName
  const selectionSummary =
    singleSpeciesLabel
      ? singleSpeciesLabel
      : t('canvas.plantSymbol.selectedCount', { count: context.plantIds.length })
  const statusText = describeCurrentSymbol(
    context.sharedCurrentSymbol,
    context.inheritedSymbol,
    context.sharedEffectiveSymbol,
  )
  const previewColor = resolvePreviewColor(context.plantIds[0] ?? null)

  const applyToSelection = () => {
    commandSurface?.setSelectedPlantSymbol(activeSymbol)
    closeMenu(buttonRef)
  }

  const applyToSpecies = () => {
    if (!context.singleSpeciesCanonicalName) return
    commandSurface?.setPlantSymbolForSpecies(context.singleSpeciesCanonicalName, activeSymbol)
    closeMenu(buttonRef)
  }

  return createPortal(
    <div
      ref={menuRef}
      className={`${shared.menu} ${shared.menuWide}`}
      role="dialog"
      aria-label={t('canvas.plantSymbol.label')}
      data-preserve-overlays="true"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(buttonRef) }
        else navigateAppearanceChoices(event, SYMBOL_GRID_COLUMNS)
      }}
    >
      <SurfaceHeader title={t('canvas.plantSymbol.label')} closeLabel={t('window.close')} onClose={() => closeMenu(buttonRef)} />
      <AppearanceSelection
        commonName={context.singleSpeciesCommonName}
        canonicalName={context.singleSpeciesCanonicalName}
        summary={selectionSummary}
        count={context.plantIds.length}
        countLabel={t('canvas.plantSymbol.selectedCount', { count: context.plantIds.length })}
        preview={<span style={{ color: previewColor }}><PlantSymbolGlyph symbol={activeSymbol} size={32} /></span>}
        detail={statusText}
      />
      <div className={shared.body}>
        <div role="listbox" aria-label={t('canvas.plantSymbol.label')}>
          {(Object.entries(PLANT_SYMBOL_FAMILIES) as [PlantSymbolFamily, readonly PlantSymbolId[]][]).map(([family, symbols]) => (
            <SymbolGrid key={family} family={family} label={t(`canvas.plantSymbol.families.${family}`)} symbols={symbols} activeSymbol={activeSymbol} onSelect={setActiveSymbol} />
          ))}
        </div>
      </div>

      <div className={shared.actions}>
        <button type="button" className={shared.primaryAction} onClick={applyToSelection}>
          {t('canvas.plantSymbol.applySelection', { count: context.plantIds.length })}
        </button>
        {context.singleSpeciesCanonicalName && singleSpeciesLabel && (
          <button type="button" className={shared.secondaryAction} onClick={applyToSpecies}>
            {t('canvas.plantSymbol.setSymbolForSpecies', { species: singleSpeciesLabel })}
          </button>
        )}
      </div>
    </div>, document.body,
  )
}

function SymbolGrid({
  family,
  label,
  symbols,
  activeSymbol,
  onSelect,
}: {
  family: PlantSymbolFamily
  label: string
  symbols: readonly PlantSymbolId[]
  activeSymbol: PlantSymbolId
  onSelect(symbol: PlantSymbolId): void
}) {
  return (
    <div className={styles.symbolGroup} role="group" aria-label={label} data-symbol-family={family}>
      <div className={styles.groupLabel} aria-hidden="true">{label}</div>
      <div className={styles.grid}>
        {symbols.map((symbol) => {
          const active = symbol === activeSymbol
          const label = symbolLabel(symbol)
          return (
            <button
              key={symbol}
              type="button"
              className={`${styles.symbolButton}${active ? ` ${styles.symbolButtonActive}` : ''}`}
              data-symbol={symbol}
              aria-label={label}
              aria-selected={active}
              role="option"
              tabIndex={active ? 0 : -1}
              title={label}
              onClick={() => onSelect(symbol)}
            >
              <PlantSymbolGlyph symbol={symbol} size={24} className={styles.symbolGlyph} />
              <span className={styles.symbolLabel}>{label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function symbolLabel(symbol: PlantSymbolId): string {
  return t(`canvas.plantSymbol.names.${symbol}`)
}

function resolveInitialSymbol(
  current: PlantSymbolId | 'mixed' | null,
  inherited: PlantSymbolId | null,
  effective: PlantSymbolId | 'mixed',
): PlantSymbolId {
  if (current === 'mixed') {
    return inherited ?? (effective === 'mixed' ? DEFAULT_PLANT_SYMBOL_ID : effective)
  }
  return current ?? inherited ?? (effective === 'mixed' ? DEFAULT_PLANT_SYMBOL_ID : effective)
}

function describeCurrentSymbol(
  current: PlantSymbolId | 'mixed' | null,
  inherited: PlantSymbolId | null,
  effective: PlantSymbolId | 'mixed',
): string {
  if (current === 'mixed') return t('canvas.plantSymbol.mixed')
  if (current) return t('canvas.plantSymbol.current', { symbol: symbolLabel(current) })
  if (inherited) return t('canvas.plantSymbol.inherited', { symbol: symbolLabel(inherited) })
  if (effective === 'mixed') return t('canvas.plantSymbol.mixed')
  return t('canvas.plantSymbol.inherited', { symbol: symbolLabel(effective) })
}

function resolvePreviewColor(plantId: string | null): string {
  const scene = currentCanvasQuerySurface.value?.getSceneSnapshot()
  const plant = plantId ? scene?.plants.find((entry) => entry.id === plantId) : null
  const speciesColor = plant ? scene?.plantSpeciesColors[plant.canonicalName] : null
  return normalizeHexColor(plant?.color ?? speciesColor ?? null) ?? DEFAULT_PLANT_COLOR
}
