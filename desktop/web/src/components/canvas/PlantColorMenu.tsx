import { locale } from '../../app/settings/state'
import { plantColorMenuOpen } from '../../canvas/plant-color-menu-state'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import {
  currentCanvasPlantPresentationCommandSurface,
  currentCanvasQuerySurface,
  currentCanvasSelection,
} from '../../canvas/session'
import {
  DEFAULT_PLANT_COLOR,
  PLANT_COLOR_PALETTE,
  hexToHsl,
  hslToHex,
  normalizeHexColor,
  pointerPositionToHue,
  pointerPositionToSaturationLightness,
  type HslColor,
} from '../../canvas/plant-colors'
import { t } from '../../i18n'
import { usePopoverEscapeLayer } from '../../app/keyboard/use-popover-escape-layer'
import { PlantSymbolGlyph } from './PlantSymbolGlyph'
import { navigateAppearanceChoices, useAppearancePopover, type AppearanceAnchorRef } from './useAppearancePopover'
import { createPortal } from 'preact'
import { SurfaceHeader } from '../shared/SurfaceHeader'
import { AppearanceSelection } from './AppearanceSelection'
import shared from './appearance.module.css'
import styles from './PlantColorMenu.module.css'

interface PlantColorMenuProps {
  buttonRef: AppearanceAnchorRef
}

const DEFAULT_HSL = hexToHsl(DEFAULT_PLANT_COLOR) ?? { h: 122, s: 39, l: 49 }
const HUE_STRIP_BACKGROUND = `
  linear-gradient(
    to bottom,
    #FF0000 0%,
    #FFFF00 17%,
    #00FF00 33%,
    #00FFFF 50%,
    #0000FF 67%,
    #FF00FF 83%,
    #FF0000 100%
  )
`

function closeMenu(buttonRef?: AppearanceAnchorRef) {
  plantColorMenuOpen.value = false
  buttonRef?.current?.focus()
}

export function PlantColorMenu({ buttonRef }: PlantColorMenuProps) {
  void currentCanvasSelection.value
  const commandSurface = currentCanvasPlantPresentationCommandSurface.value
  const querySurface = currentCanvasQuerySurface.value
  // A species colour set elsewhere, or undone, moves the scene revision.
  void querySurface?.revision.scene.value
  void querySurface?.revision.plantNames.value
  const activeLocale = locale.value
  const menuOpen = plantColorMenuOpen.value
  const menuRef = useAppearancePopover(menuOpen, buttonRef)
  const context = querySurface?.getSelectedPlantColorContext() ?? {
    plantIds: [],
    singleSpeciesCanonicalName: null,
    singleSpeciesCommonName: null,
    sharedCurrentColor: null,
    suggestedColor: null,
    singleSpeciesDefaultColor: null,
  }

  const [activeColor, setActiveColor] = useState<string | null>(DEFAULT_PLANT_COLOR)
  const [customInput, setCustomInput] = useState(DEFAULT_PLANT_COLOR)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [pickerColor, setPickerColor] = useState<HslColor>(DEFAULT_HSL)
  const [, setCacheVersion] = useState(0)

  const pickerColorRef = useRef<HslColor>(DEFAULT_HSL)
  const selectionKey = context.plantIds.join('|')
  const hasSelectedPlants = context.plantIds.length > 0
  const squareRef = useRef<HTMLDivElement>(null)
  const hueRef = useRef<HTMLDivElement>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => () => dragCleanupRef.current?.(), [menuOpen, advancedOpen, selectionKey])

  useEffect(() => {
    pickerColorRef.current = pickerColor
  }, [pickerColor])

  function syncPickerFromHex(nextHex: string): void {
    const normalized = normalizeHexColor(nextHex)
    if (!normalized) {
      setActiveColor(null)
      setCustomInput(nextHex)
      return
    }

    const nextHsl = hexToHsl(normalized) ?? DEFAULT_HSL
    pickerColorRef.current = nextHsl
    setPickerColor(nextHsl)
    setCustomInput(normalized)
    setActiveColor(normalized)
  }

  function syncPickerFromHsl(nextHsl: HslColor): void {
    pickerColorRef.current = nextHsl
    setPickerColor(nextHsl)
    const nextHex = hslToHex(nextHsl)
    setCustomInput(nextHex)
    setActiveColor(nextHex)
  }

  function beginPointerDrag(
    event: PointerEvent,
    ref: { current: HTMLElement | null },
    update: (nextEvent: PointerEvent, rect: DOMRect) => void,
  ): void {
    if (event.button !== 0) return
    event.preventDefault()
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    dragCleanupRef.current?.()
    update(event, rect)

    const handleMove = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== event.pointerId) return
      update(nextEvent, rect)
    }
    const cleanup = () => {
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
      document.removeEventListener('pointercancel', handleUp)
      window.removeEventListener('blur', cleanup)
      dragCleanupRef.current = null
    }
    const handleUp = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId === event.pointerId) cleanup()
    }

    dragCleanupRef.current = cleanup
    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
    document.addEventListener('pointercancel', handleUp)
    window.addEventListener('blur', cleanup)
  }

  useEffect(() => {
    if (!menuOpen) return

    const initialColor =
      context.sharedCurrentColor === 'mixed'
        ? context.singleSpeciesDefaultColor ?? context.suggestedColor ?? DEFAULT_PLANT_COLOR
        : context.sharedCurrentColor
          ?? context.singleSpeciesDefaultColor
          ?? context.suggestedColor
          ?? DEFAULT_PLANT_COLOR

    const initialHsl = hexToHsl(initialColor) ?? DEFAULT_HSL
    pickerColorRef.current = initialHsl
    setPickerColor(initialHsl)
    setActiveColor(initialColor)
    setCustomInput(initialColor)
    setAdvancedOpen(false)
  }, [menuOpen, selectionKey, context.sharedCurrentColor, context.singleSpeciesDefaultColor, context.suggestedColor])

  useEffect(() => {
    if (!menuOpen || !context.singleSpeciesCanonicalName || context.suggestedColor) return

    const pending = commandSurface?.ensureSpeciesCacheEntries([context.singleSpeciesCanonicalName], activeLocale)
    if (!pending) return

    let active = true
    void pending.then((loaded) => {
      if (active && loaded) {
        setCacheVersion((value) => value + 1)
      }
    }).catch(error => { if (active) console.error('Unable to load suggested plant color:', error) })
    return () => { active = false }
  }, [menuOpen, activeLocale, commandSurface, context.singleSpeciesCanonicalName, context.suggestedColor])

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

  const normalizedActiveColor = normalizeHexColor(activeColor)
  const canApply = normalizedActiveColor !== null
  const singleSpeciesLabel = context.singleSpeciesCommonName ?? context.singleSpeciesCanonicalName
  const selectionSummary =
    singleSpeciesLabel
      ? singleSpeciesLabel
      : t('canvas.plantColor.selectedCount', { count: context.plantIds.length })
  const previewColor =
    normalizedActiveColor
    ?? hslToHex(pickerColor)
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

  const squareCursorLeft = `${pickerColor.s}%`
  const squareCursorTop = `${100 - pickerColor.l}%`
  const hueCursorTop = `${(pickerColor.h / 360) * 100}%`
  const effectiveSymbol = querySurface?.getSelectedPlantSymbolContext().sharedEffectiveSymbol
  const previewSymbol = !effectiveSymbol || effectiveSymbol === 'mixed' ? 'round' : effectiveSymbol
  const paletteHasActiveColor = PLANT_COLOR_PALETTE.some(entry => normalizeHexColor(entry.hex) === normalizedActiveColor)

  return createPortal(
    <div
      ref={menuRef}
      className={shared.menu}
      role="dialog"
      aria-label={t('canvas.plantColor.label')}
      data-preserve-overlays="true"
      onKeyDown={event => {
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
      {context.suggestedColor && context.sharedCurrentColor !== 'mixed' && (
        <button type="button" className={styles.suggestion} onClick={() => syncPickerFromHex(context.suggestedColor!)}>
          <span className={styles.suggestionSwatch} style={{ backgroundColor: context.suggestedColor }} />
          {t('canvas.plantColor.suggested')}
        </button>
      )}

      <div className={styles.palette} role="listbox" aria-label={t('canvas.plantColor.label')}>
        {PLANT_COLOR_PALETTE.map((color) => {
          const active = normalizeHexColor(color.hex) === normalizedActiveColor
          return (
            <button
              key={color.hex}
              type="button"
              className={`${styles.swatch}${active ? ` ${styles.swatchActive}` : ''}`}
              style={{ backgroundColor: color.hex }}
              aria-label={color.name}
              aria-selected={active}
              role="option"
              tabIndex={active || (color === PLANT_COLOR_PALETTE[0] && !paletteHasActiveColor) ? 0 : -1}
              title={color.name}
              onClick={() => {
                syncPickerFromHex(color.hex)
              }}
            />
          )
        })}
      </div>

      <div className={styles.moreColorsRow}>
        <button
          type="button"
          className={styles.moreColorsButton}
          aria-expanded={advancedOpen}
          onClick={() => { setAdvancedOpen((value) => !value) }}
        >
          {t('canvas.plantColor.moreColors')}
        </button>
      </div>

      {advancedOpen && (
        <div className={styles.advancedSection}>
          <div className={styles.advancedControls}>
            <div
              ref={squareRef}
              tabIndex={0}
              role="slider"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pickerColor.s)}
              aria-valuetext={`${t('canvas.plantColor.saturationLightness')}: ${Math.round(pickerColor.s)}%, ${Math.round(pickerColor.l)}%`}
              onKeyDown={event => {
                const step = event.shiftKey ? 10 : 1
                const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key]
                if (!delta) return
                event.preventDefault(); event.stopPropagation()
                syncPickerFromHsl({ ...pickerColorRef.current,
                  s: Math.max(0, Math.min(100, pickerColorRef.current.s + delta[0]!)),
                  l: Math.max(0, Math.min(100, pickerColorRef.current.l + delta[1]!)) })
              }}
              className={styles.colorSquare}
              aria-label={t('canvas.plantColor.saturationLightness')}
              style={{
                background: `
                  linear-gradient(to top, rgb(0 0 0 / 1), rgb(0 0 0 / 0) 50%),
                  linear-gradient(to bottom, rgb(255 255 255 / 1), rgb(255 255 255 / 0) 50%),
                  linear-gradient(to right, hsl(${pickerColor.h} 0% 50%), hsl(${pickerColor.h} 100% 50%))
                `,
              }}
              onPointerDown={(event) => {
                beginPointerDrag(event, squareRef, (nextEvent, rect) => {
                  const { s, l } = pointerPositionToSaturationLightness(nextEvent.clientX, nextEvent.clientY, rect)
                  syncPickerFromHsl({ ...pickerColorRef.current, s, l })
                })
              }}
            >
              <span
                className={styles.squareCursor}
                style={{ left: squareCursorLeft, top: squareCursorTop }}
              />
            </div>

            <div
              ref={hueRef}
              tabIndex={0}
              role="slider"
              aria-orientation="vertical"
              aria-valuemin={0}
              aria-valuemax={360}
              aria-valuenow={Math.round(pickerColor.h)}
              onKeyDown={event => {
                const step = event.shiftKey ? 10 : 1
                const delta = { ArrowUp: -step, ArrowDown: step, ArrowLeft: -step, ArrowRight: step }[event.key]
                if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return
                event.preventDefault(); event.stopPropagation()
                const h = event.key === 'Home' ? 0 : event.key === 'End' ? 360
                  : Math.max(0, Math.min(360, pickerColorRef.current.h + (delta ?? 0)))
                syncPickerFromHsl({ ...pickerColorRef.current, h })
              }}
              className={styles.hueStrip}
              aria-label={t('canvas.plantColor.hue')}
              style={{ background: HUE_STRIP_BACKGROUND }}
              onPointerDown={(event) => {
                beginPointerDrag(event, hueRef, (nextEvent, rect) => {
                  const nextHue = pointerPositionToHue(nextEvent.clientY, rect)
                  syncPickerFromHsl({ ...pickerColorRef.current, h: nextHue })
                })
              }}
            >
              <span className={styles.hueCursor} style={{ top: hueCursorTop }} />
            </div>
          </div>

          <div className={styles.hexRow}>
            <span
              className={styles.previewSwatch}
              style={{ backgroundColor: previewColor }}
              aria-label={t('canvas.plantColor.preview')}
            />
            <input
              className={styles.customInput}
              type="text"
              value={customInput}
              onInput={(event) => {
                const value = (event.currentTarget as HTMLInputElement).value
                setCustomInput(value)
                const normalized = normalizeHexColor(value)
                if (!normalized) {
                  setActiveColor(null)
                  return
                }
                syncPickerFromHex(normalized)
              }}
              placeholder="#C44230"
              aria-label={t('canvas.plantColor.customHex')}
              aria-invalid={!normalizedActiveColor}
              spellcheck={false}
            />
          </div>
        </div>
      )}

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
