export interface PlantPaletteColor {
  name: string
  hex: string
}

export interface HslColor {
  h: number
  s: number
  l: number
}

export const DEFAULT_PLANT_COLOR = '#4CAF50'

export const PLANT_COLOR_PALETTE: readonly PlantPaletteColor[] = [
  { name: 'Clover', hex: '#3E8E4E' },
  { name: 'Poppy', hex: '#C44230' },
  { name: 'Calendula', hex: '#D4822A' },
  { name: 'Goldenrod', hex: '#C8A51E' },
  { name: 'Walnut', hex: '#7A5C30' },
  { name: 'Verdigris', hex: '#2E8B7A' },
  { name: 'Cornflower', hex: '#4A82C2' },
  { name: 'Chicory', hex: '#3FA0C0' },
  { name: 'Wisteria', hex: '#7B5EA7' },
  { name: 'Elderberry', hex: '#8B3A6E' },
  { name: 'Peony', hex: '#C25B82' },
  { name: 'Flint', hex: '#71716A' },
] as const

export function normalizeHexColor(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toUpperCase()
  return /^#[0-9A-F]{6}$/.test(trimmed) ? trimmed : null
}

/** WCAG relative luminance of a #RRGGBB colour. */
export function hexLuminance(color: string): number {
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
  return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722
}

export function contrastRatio(a: string, b: string): number {
  const la = hexLuminance(a)
  const lb = hexLuminance(b)
  return (Math.max(la, lb) + .05) / (Math.min(la, lb) + .05)
}

/** Whichever of `light` and `dark` contrasts more with `color`; `dark` when `color` is not #RRGGBB. */
export function contrastingInk(color: string, light: string, dark: string): string {
  if (normalizeHexColor(color) === null) return dark
  return contrastRatio(color, light) >= contrastRatio(color, dark) ? light : dark
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeHslColor(color: HslColor): HslColor {
  const h = ((color.h % 360) + 360) % 360
  return {
    h,
    s: clamp(color.s, 0, 100),
    l: clamp(color.l, 0, 100),
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = normalizeHexColor(hex)
  if (!normalized) return null
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  }
}

function rgbChannelToHex(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0').toUpperCase()
}

export function hexToHsl(hex: string): HslColor | null {
  const rgb = hexToRgb(hex)
  if (!rgb) return null

  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const lightness = (max + min) / 2

  let hue = 0
  let saturation = 0

  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1))

    switch (max) {
      case r:
        hue = 60 * (((g - b) / delta) % 6)
        break
      case g:
        hue = 60 * (((b - r) / delta) + 2)
        break
      default:
        hue = 60 * (((r - g) / delta) + 4)
        break
    }
  }

  return normalizeHslColor({
    h: hue,
    s: saturation * 100,
    l: lightness * 100,
  })
}

export function hslToHex(color: HslColor): string {
  const { h, s, l } = normalizeHslColor(color)
  const saturation = s / 100
  const lightness = l / 100
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const huePrime = h / 60
  const second = chroma * (1 - Math.abs((huePrime % 2) - 1))
  const match = lightness - chroma / 2

  let red = 0
  let green = 0
  let blue = 0

  if (huePrime >= 0 && huePrime < 1) {
    red = chroma
    green = second
  } else if (huePrime < 2) {
    red = second
    green = chroma
  } else if (huePrime < 3) {
    green = chroma
    blue = second
  } else if (huePrime < 4) {
    green = second
    blue = chroma
  } else if (huePrime < 5) {
    red = second
    blue = chroma
  } else {
    red = chroma
    blue = second
  }

  return `#${rgbChannelToHex((red + match) * 255)}${rgbChannelToHex((green + match) * 255)}${rgbChannelToHex((blue + match) * 255)}`
}

export function pointerPositionToHue(clientY: number, rect: DOMRect): number {
  if (rect.height <= 0) return 0
  const ratio = clamp((clientY - rect.top) / rect.height, 0, 1)
  return ratio * 360
}

export function pointerPositionToSaturationLightness(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): Pick<HslColor, 's' | 'l'> {
  if (rect.width <= 0 || rect.height <= 0) {
    return { s: 100, l: 50 }
  }

  const xRatio = clamp((clientX - rect.left) / rect.width, 0, 1)
  const yRatio = clamp((clientY - rect.top) / rect.height, 0, 1)

  return {
    s: xRatio * 100,
    l: (1 - yRatio) * 100,
  }
}
