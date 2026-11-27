import { createPortal } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
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
import styles from './CanopiColorPicker.module.css'

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

export interface CanopiColorPickerProps {
  /** Normalized hex color currently selected, or null when custom input is invalid. */
  readonly value: string | null
  /** External reset key; changing it collapses the custom section and syncs internal state to `value`. */
  readonly resetKey?: string | number | boolean
  /** Accessible label for the palette listbox. */
  readonly paletteLabel?: string
  /** Called on swatch click, HSL drag/keyboard move, or hex input change. */
  readonly onChange: (hex: string | null, rawInput: string) => void
}

/**
 * The one Canopi colour picker (2.1-Q105): 12 curated swatches plus an expandable
 * 2D saturation/lightness square, vertical hue strip, and hex input.
 */
export function CanopiColorPicker({
  value,
  resetKey,
  paletteLabel,
  onChange,
}: CanopiColorPickerProps) {
  const normalizedProp = normalizeHexColor(value)
  const initialHex = normalizedProp ?? DEFAULT_PLANT_COLOR
  const [customInput, setCustomInput] = useState(initialHex)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [pickerColor, setPickerColor] = useState<HslColor>(() => hexToHsl(initialHex) ?? DEFAULT_HSL)

  const pickerColorRef = useRef<HslColor>(pickerColor)
  const squareRef = useRef<HTMLDivElement>(null)
  const hueRef = useRef<HTMLDivElement>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const lastEmittedRef = useRef<string | null>(normalizedProp)
  const latestValueRef = useRef<string | null>(value)
  latestValueRef.current = value

  useLayoutEffect(() => () => dragCleanupRef.current?.(), [advancedOpen, resetKey])

  useEffect(() => {
    pickerColorRef.current = pickerColor
  }, [pickerColor])

  useEffect(() => {
    const nextNormalized = normalizeHexColor(latestValueRef.current)
    const nextHex = nextNormalized ?? DEFAULT_PLANT_COLOR
    const nextHsl = hexToHsl(nextHex) ?? DEFAULT_HSL
    pickerColorRef.current = nextHsl
    lastEmittedRef.current = nextNormalized
    setPickerColor(nextHsl)
    setCustomInput(nextHex)
    setAdvancedOpen(false)
  }, [resetKey])

  useEffect(() => {
    if (normalizedProp === null || normalizedProp === lastEmittedRef.current) return
    const nextHsl = hexToHsl(normalizedProp) ?? DEFAULT_HSL
    pickerColorRef.current = nextHsl
    lastEmittedRef.current = normalizedProp
    setPickerColor(nextHsl)
    setCustomInput(normalizedProp)
  }, [normalizedProp])

  function emitHex(nextHex: string): void {
    const normalized = normalizeHexColor(nextHex)
    if (!normalized) {
      lastEmittedRef.current = null
      setCustomInput(nextHex)
      onChange(null, nextHex)
      return
    }
    const nextHsl = hexToHsl(normalized) ?? DEFAULT_HSL
    pickerColorRef.current = nextHsl
    lastEmittedRef.current = normalized
    setPickerColor(nextHsl)
    setCustomInput(normalized)
    onChange(normalized, normalized)
  }

  function emitHsl(nextHsl: HslColor): void {
    pickerColorRef.current = nextHsl
    setPickerColor(nextHsl)
    const nextHex = hslToHex(nextHsl)
    lastEmittedRef.current = nextHex
    setCustomInput(nextHex)
    onChange(nextHex, nextHex)
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

  const previewColor = normalizedProp ?? hslToHex(pickerColor)
  const squareCursorLeft = `${pickerColor.s}%`
  const squareCursorTop = `${100 - pickerColor.l}%`
  const hueCursorTop = `${(pickerColor.h / 360) * 100}%`
  const paletteHasActiveColor = PLANT_COLOR_PALETTE.some(
    (entry) => normalizeHexColor(entry.hex) === normalizedProp,
  )

  return (
    <>
      <div className={styles.palette} role="listbox" aria-label={paletteLabel ?? t('canvas.plantColor.label')}>
        {PLANT_COLOR_PALETTE.map((color) => {
          const active = normalizeHexColor(color.hex) === normalizedProp
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
              onClick={() => emitHex(color.hex)}
            />
          )
        })}
      </div>

      <div className={styles.moreColorsRow}>
        <button
          type="button"
          className={styles.moreColorsButton}
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
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
              onKeyDown={(event) => {
                const step = event.shiftKey ? 10 : 1
                const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key]
                if (!delta) return
                event.preventDefault()
                event.stopPropagation()
                emitHsl({
                  ...pickerColorRef.current,
                  s: Math.max(0, Math.min(100, pickerColorRef.current.s + delta[0]!)),
                  l: Math.max(0, Math.min(100, pickerColorRef.current.l + delta[1]!)),
                })
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
                  emitHsl({ ...pickerColorRef.current, s, l })
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
              onKeyDown={(event) => {
                const step = event.shiftKey ? 10 : 1
                const delta = { ArrowUp: -step, ArrowDown: step, ArrowLeft: -step, ArrowRight: step }[event.key]
                if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return
                event.preventDefault()
                event.stopPropagation()
                const h = event.key === 'Home' ? 0 : event.key === 'End' ? 360
                  : Math.max(0, Math.min(360, pickerColorRef.current.h + (delta ?? 0)))
                emitHsl({ ...pickerColorRef.current, h })
              }}
              className={styles.hueStrip}
              aria-label={t('canvas.plantColor.hue')}
              style={{ background: HUE_STRIP_BACKGROUND }}
              onPointerDown={(event) => {
                beginPointerDrag(event, hueRef, (nextEvent, rect) => {
                  const nextHue = pointerPositionToHue(nextEvent.clientY, rect)
                  emitHsl({ ...pickerColorRef.current, h: nextHue })
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
                const raw = event.currentTarget.value
                emitHex(raw)
              }}
              placeholder="#C44230"
              aria-label={t('canvas.plantColor.customHex')}
              aria-invalid={!normalizedProp}
              spellcheck={false}
            />
          </div>
        </div>
      )}
    </>
  )
}

export interface CanopiColorSwatchPickerProps {
  readonly value: string
  readonly ariaLabel: string
  readonly compact?: boolean
  readonly disabled?: boolean
  readonly onChange: (hex: string) => void
}

function navigateSwatchGrid(event: KeyboardEvent, columns: number): void {
  const target = event.target
  if (!(target instanceof HTMLButtonElement) || target.getAttribute('role') !== 'option') return
  const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }
  const options = Array.from(target.closest('[role="dialog"]')?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
  const index = options.indexOf(target)
  const step = steps[event.key]
  if (index < 0 || (step === undefined && event.key !== 'Home' && event.key !== 'End')) return
  event.preventDefault()
  event.stopPropagation()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (step ?? 0) + options.length) % options.length
  options[next]?.focus()
  options[next]?.click()
}

/**
 * A colour swatch button that opens the portalled Canopi colour picker popover (2.1-Q105).
 */
export function CanopiColorSwatchPicker({
  value,
  ariaLabel,
  compact = false,
  disabled = false,
  onChange,
}: CanopiColorSwatchPickerProps) {
  const [open, setOpen] = useState(false)
  const [activeValue, setActiveValue] = useState<string | null>(() => normalizeHexColor(value) ?? value)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setActiveValue(normalizeHexColor(value) ?? value)
  }, [value])

  const close = (returnFocus = false) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }

  usePopoverEscapeLayer(open, () => close(true))

  useLayoutEffect(() => {
    const popover = popoverRef.current
    const trigger = triggerRef.current
    if (!open || !popover || !trigger) return
    const place = () => {
      const anchor = trigger.getBoundingClientRect()
      const bounds = popover.getBoundingClientRect()
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))
      const below = anchor.bottom + 6
      const top = below + bounds.height <= window.innerHeight - 8
        ? below
        : Math.max(8, anchor.top - bounds.height - 6)
      popover.style.left = `${left}px`
      popover.style.top = `${top}px`
    }
    place()
    ;(popover.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?? popover.querySelector<HTMLElement>('[role="option"], button:not(:disabled)'))?.focus({ preventScroll: true })
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    observer?.observe(popover)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      close(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  const displayColor = normalizeHexColor(value) ?? value

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.swatchTrigger}${compact ? ` ${styles.swatchTriggerCompact}` : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-color-value={displayColor}
        disabled={disabled}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className={styles.swatchFill} style={{ backgroundColor: displayColor }} />
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          className={styles.popover}
          role="dialog"
          aria-label={ariaLabel}
          data-popup=""
          data-preserve-overlays="true"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close(true)
            } else {
              navigateSwatchGrid(event, 6)
            }
          }}
        >
          <CanopiColorPicker
            value={activeValue}
            resetKey={open}
            paletteLabel={ariaLabel}
            onChange={(nextHex) => {
              setActiveValue(nextHex)
              if (nextHex) onChange(nextHex)
            }}
          />
        </div>,
        document.body,
      )}
    </>
  )
}
