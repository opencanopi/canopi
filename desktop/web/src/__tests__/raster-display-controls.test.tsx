// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LidarPresentationItem } from '../app/lidar/library-store'

const setLidarEntryDisplay = vi.hoisted(() => vi.fn())
vi.mock('../app/lidar/actions', () => ({ setLidarEntryDisplay }))

import { RasterDisplayControls } from '../components/panels/lidar/RasterDisplayControls'
import { locale } from '../app/settings/state'

let container: HTMLDivElement

function item(overrides: Partial<LidarPresentationItem> = {}): LidarPresentationItem {
  return {
    kind: 'Source', id: 'a', name: 'Ground', availability: 'present',
    itemType: { kind: 'Raster', quantity: 'GroundElevation' }, units: 'm', state: 'Ready',
    visible: true, shown: true, opacity: 1, order: 0, ramp: null, reversed: false, range: null,
    bounds: [0, 0, 1, 1], generationId: 'a-g1', displayRange: [100, 200], freshness: { state: 'Current' },
    definitionId: null, analysisId: null, outputKey: null, run: null, inputId: null, parentId: null, depth: 0,
    ...overrides,
  }
}

/** An elevation drawn in Colours: Terrain, the first ramp after Relief. */
const terrain = { ramp: 'Terrain' as const }

const slope = { kind: 'Derived' as const, itemType: { kind: 'Raster' as const, quantity: 'Slope' as const }, units: '°', displayRange: [0, 41.6] as [number, number] }

function mount(entry: LidarPresentationItem): void {
  act(() => { render(<RasterDisplayControls item={entry} />, container) })
}

function radios(group: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(`[role="radiogroup"][aria-label="${group}"] [role="radio"]`))
}

function named(name: string): HTMLElement {
  const found = Array.from(container.querySelectorAll<HTMLElement>('button, input'))
    .find((candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === name)
  if (!found) throw new Error(`no control ${name}`)
  return found
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

async function type(field: HTMLInputElement, text: string, commit: 'Enter' | 'blur'): Promise<void> {
  await act(async () => {
    field.value = text
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    if (commit === 'Enter') field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    else field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

function legend(): string[] {
  return Array.from(container.querySelectorAll('[aria-label="Legend"] [data-legend-end]')).map((end) => end.textContent ?? '')
}

beforeEach(() => {
  locale.value = 'en'
  setLidarEntryDisplay.mockClear()
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

describe('an open item\'s Colors', () => {
  it('offers an elevation Relief, then its Colours, as swatches, the default chosen, and writes a choice', async () => {
    mount(item())
    expect(radios('Colors').map((radio) => [radio.getAttribute('aria-label'), radio.getAttribute('aria-checked')]))
      .toEqual([['Relief', 'true'], ['Terrain', 'false'], ['Earth', 'false'], ['Gray', 'false']])
    const swatch = (index: number) => radios('Colors')[index]!.querySelector<HTMLElement>('[data-swatch]')!.style.backgroundImage
    expect(swatch(0)).toContain('radial-gradient')
    expect(swatch(1)).toContain('linear-gradient')
    await click(radios('Colors')[1]!)
    expect(setLidarEntryDisplay).toHaveBeenCalledWith('a', { ramp: 'Terrain' })
  })

  it('offers a slope Yellow–red, Magma and Gray, and a height Relief, Greens, Magma and Gray', () => {
    mount(item(slope))
    expect(radios('Colors').map((radio) => radio.getAttribute('aria-label'))).toEqual(['Yellow–red', 'Magma', 'Gray'])
    mount(item({ itemType: { kind: 'Raster', quantity: 'AboveGroundHeight' } }))
    expect(radios('Colors').map((radio) => radio.getAttribute('aria-label'))).toEqual(['Relief', 'Greens', 'Magma', 'Gray'])
  })

  it('reverses the ramp as a pressed toggle', async () => {
    mount(item({ ...terrain, reversed: true }))
    const reverse = named('Reverse')
    expect(reverse.getAttribute('aria-pressed')).toBe('true')
    await click(reverse)
    expect(setLidarEntryDisplay).toHaveBeenCalledWith('a', { reversed: false })
  })

  it('labels the legend with the range in use, marked ≤ and ≥ where it cuts the data', () => {
    mount(item(terrain))
    expect(legend()).toEqual(['100 m', '200 m'])
    mount(item({ ...terrain, range: { mode: 'Custom', min: 110, max: 190 } }))
    expect(legend()).toEqual(['≤ 110 m', '≥ 190 m'])
  })
})

describe('an open item drawn as Relief', () => {
  it('opens an MNT, MNS or MNH on Relief, hiding Reverse, Legend and Range', () => {
    for (const quantity of ['GroundElevation', 'SurfaceElevation', 'AboveGroundHeight'] as const) {
      mount(item({ itemType: { kind: 'Raster', quantity } }))
      const [first] = radios('Colors')
      expect([first!.getAttribute('aria-label'), first!.getAttribute('aria-checked')]).toEqual(['Relief', 'true'])
      expect(() => named('Reverse')).toThrow()
      expect(container.querySelector('[aria-label="Legend"]')).toBeNull()
      expect(radios('Range')).toEqual([])
    }
  })

  it('shows Reverse, Legend and the stored range again once Colours is picked', () => {
    mount(item({ ramp: 'Terrain', reversed: true, range: { mode: 'Custom', min: 110, max: 190 } }))
    expect(named('Reverse').getAttribute('aria-pressed')).toBe('true')
    expect(legend()).toEqual(['≤ 110 m', '≥ 190 m'])
    expect(radios('Range').find((radio) => radio.getAttribute('aria-checked') === 'true')?.textContent).toBe('Custom')
  })

  it('keeps Reset reachable under Relief while a Colours setting is stored', async () => {
    mount(item({ reversed: true, range: { mode: 'Custom', min: 110, max: 190 } }))
    expect(radios('Colors')[0]!.getAttribute('aria-label')).toBe('Relief')
    expect(() => named('Reverse')).toThrow()
    await click(named('Reset'))
    expect(setLidarEntryDisplay).toHaveBeenCalledWith('a', { ramp: null, reversed: false, range: null })
  })
})

describe('an open item\'s Range', () => {
  it('shows the mode and the values in use, and switches mode with one write', async () => {
    mount(item(terrain))
    expect(radios('Range').map((radio) => [radio.textContent, radio.getAttribute('aria-checked')]))
      .toEqual([['Data range', 'true'], ['Cut outliers', 'false'], ['Custom', 'false']])
    expect((named('Minimum') as HTMLInputElement).value).toBe('100')
    expect((named('Maximum') as HTMLInputElement).value).toBe('200')
    await click(radios('Range')[1]!)
    expect(setLidarEntryDisplay).toHaveBeenLastCalledWith('a', { range: { mode: 'CutOutliers' } })
    await click(radios('Range')[2]!)
    expect(setLidarEntryDisplay).toHaveBeenLastCalledWith('a', { range: { mode: 'Custom', min: 100, max: 200 } })
  })

  it('shows a float raster\'s range in use to two decimals, so it fits its field', () => {
    mount(item({ ...terrain, displayRange: [312.4700012207031, 1408.0999755859375] }))
    expect((named('Minimum') as HTMLInputElement).value).toBe('312.47')
    expect((named('Maximum') as HTMLInputElement).value).toBe('1408.1')
    locale.value = 'fr'
    mount(item({ ...slope, range: { mode: 'Data' }, displayRange: [0, 67.83412170410156] }))
    expect((named('Maximum') as HTMLInputElement).value).toBe('67,83')
  })

  it('shows a small-valued range to three significant digits, and a typed end as it is stored', async () => {
    locale.value = 'fr'
    const other = { itemType: { kind: 'Raster' as const, quantity: 'OtherContinuous' as const }, units: 'mg/kg' }
    mount(item({ ...other, displayRange: [0.0012, 0.008712345] }))
    expect((named('Minimum') as HTMLInputElement).value).toBe('0,0012')
    expect((named('Maximum') as HTMLInputElement).value).toBe('0,00871')
    const maximum = named('Maximum') as HTMLInputElement
    await type(maximum, '0,005', 'Enter')
    expect(setLidarEntryDisplay).toHaveBeenCalledWith('a', { range: { mode: 'Custom', min: 0.0012, max: 0.005 } })
    expect(maximum.value).toBe('0,005')
  })

  it('shows a slope\'s default 0–30° as Custom, with no Reset', () => {
    mount(item(slope))
    expect(radios('Range').find((radio) => radio.getAttribute('aria-checked') === 'true')?.textContent).toBe('Custom')
    expect((named('Maximum') as HTMLInputElement).value).toBe('30')
    expect(() => named('Reset')).toThrow()
  })

  it('commits Custom only for a pair that parses in the locale with minimum below maximum, else reverts', async () => {
    locale.value = 'fr'
    mount(item(terrain))
    const minimum = named('Minimum') as HTMLInputElement
    await type(minimum, '110,5', 'Enter')
    expect(setLidarEntryDisplay).toHaveBeenCalledWith('a', { range: { mode: 'Custom', min: 110.5, max: 200 } })
    setLidarEntryDisplay.mockClear()
    await type(minimum, '250', 'blur')
    expect(setLidarEntryDisplay).not.toHaveBeenCalled()
    expect(minimum.value).toBe('100')
    await type(named('Maximum') as HTMLInputElement, 'deux cents', 'Enter')
    expect(setLidarEntryDisplay).not.toHaveBeenCalled()
    expect((named('Maximum') as HTMLInputElement).value).toBe('200')
  })

  it('commits a typed pair above or below the range in use, whichever end is typed first', async () => {
    mount(item(terrain))
    const minimum = named('Minimum') as HTMLInputElement
    const maximum = named('Maximum') as HTMLInputElement
    await act(async () => {
      minimum.value = '300'
      minimum.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { minimum.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: maximum })) })
    expect(setLidarEntryDisplay).not.toHaveBeenCalled()
    expect(minimum.value).toBe('300')
    await type(maximum, '400', 'Enter')
    expect(setLidarEntryDisplay).toHaveBeenCalledTimes(1)
    expect(setLidarEntryDisplay).toHaveBeenCalledWith('a', { range: { mode: 'Custom', min: 300, max: 400 } })
    setLidarEntryDisplay.mockClear()
    mount(item({ ...terrain, range: { mode: 'Custom', min: 300, max: 400 } }))
    await act(async () => {
      maximum.value = '50'
      maximum.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { maximum.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: minimum })) })
    expect(maximum.value).toBe('50')
    await type(minimum, '20', 'blur')
    expect(setLidarEntryDisplay).toHaveBeenCalledTimes(1)
    expect(setLidarEntryDisplay).toHaveBeenCalledWith('a', { range: { mode: 'Custom', min: 20, max: 50 } })
  })

  it('reverts both ends when focus leaves the pair while it would not keep minimum below maximum', async () => {
    mount(item(terrain))
    const minimum = named('Minimum') as HTMLInputElement
    const maximum = named('Maximum') as HTMLInputElement
    await act(async () => {
      minimum.value = '300'
      minimum.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { minimum.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: maximum })) })
    await act(async () => { maximum.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(setLidarEntryDisplay).not.toHaveBeenCalled()
    expect([minimum.value, maximum.value]).toEqual(['100', '200'])
  })

  it('shows Reset only when the display differs from the kind\'s, and Reset restores colours, Reverse and range', async () => {
    mount(item())
    expect(() => named('Reset')).toThrow()
    mount(item({ ramp: 'Gray' }))
    await click(named('Reset'))
    expect(setLidarEntryDisplay).toHaveBeenCalledWith('a', { ramp: null, reversed: false, range: null })
    mount(item({ reversed: true }))
    expect(named('Reset')).toBeTruthy()
  })

  it('keeps the field and its focus when an Enter commit or a new range in use lands, and a draft being typed', async () => {
    mount(item(terrain))
    const minimum = named('Minimum') as HTMLInputElement
    minimum.focus()
    await type(minimum, '150', 'Enter')
    expect(setLidarEntryDisplay).toHaveBeenCalledWith('a', { range: { mode: 'Custom', min: 150, max: 200 } })
    mount(item({ ...terrain, range: { mode: 'Custom', min: 150, max: 200 } }))
    expect(named('Minimum')).toBe(minimum)
    expect(document.activeElement).toBe(minimum)
    expect(minimum.value).toBe('150')
    // A range that lands while Maximum holds a draft keeps the draft; an untouched field shows the new value.
    const maximum = named('Maximum') as HTMLInputElement
    await act(async () => {
      maximum.value = '18'
      maximum.dispatchEvent(new Event('input', { bubbles: true }))
    })
    mount(item({ ...terrain, range: { mode: 'Custom', min: 120, max: 190 } }))
    expect(named('Maximum')).toBe(maximum)
    expect(maximum.value).toBe('18')
    expect(minimum.value).toBe('120')
  })

  it('keeps the keyboard on the ramp Reset checks once Reset removes itself, Range shown or not', async () => {
    for (const [entry, ramp] of [[item({ ramp: 'Gray' }), 'Relief'], [item({ ...slope, ramp: 'Gray' }), 'Yellow–red']] as const) {
      mount(entry)
      const reset = named('Reset')
      reset.focus()
      await click(reset)
      mount({ ...entry, ramp: null })
      expect(document.activeElement).toBe(radios('Colors').find((radio) => radio.getAttribute('aria-checked') === 'true'))
      expect(document.activeElement?.getAttribute('aria-label')).toBe(ramp)
    }
  })

  it('writes opacity live as the slider moves', async () => {
    mount(item())
    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Opacity: Ground"]')!
    await act(async () => {
      slider.value = '40'
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(setLidarEntryDisplay).toHaveBeenCalledWith('a', { opacity: 0.4 })
  })
})
