import { signal } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setCurrentCanvasSession } from '../../canvas/session'
import type { CanvasRuntimeSurfaces } from '../../canvas/runtime/runtime'
import type { CanopiFile } from '../../types/design'
import { designSessionStore } from '../document-session/store'
import { runEscape } from '../keyboard/escape-chain'
import type { KeyboardEventLike } from '../keyboard/key-chord'
import type { FocusClass } from '../keyboard/target-class'
import { activePanel, selectPanel, sidePanel } from '../shell/state'
import {
  clearProfile,
  endSiteDataTransients,
  pin,
  profileLine,
  setPin,
  setProfileLine,
  unpin,
} from './site-transients'

const PARIS = { lon: 2.35211, lat: 48.85123 }
const LINE = [{ lon: 2.35, lat: 48.85 }, { lon: 2.36, lat: 48.86 }]

function esc(focus: FocusClass, shiftKey = false): boolean {
  const event: KeyboardEventLike = {
    type: 'keydown', key: 'Escape', code: 'Escape', keyCode: 27,
    shiftKey, ctrlKey: false, altKey: false, metaKey: false,
    isComposing: false, defaultPrevented: false, cancelable: true, timeStamp: 0, target: null,
    preventDefault() {}, stopPropagation() {},
  }
  return runEscape({ event, focus })
}

function escape(): boolean {
  return esc('map')
}

function openDesign(name: string): void {
  designSessionStore.replaceCurrentDesignState({ name } as CanopiFile, null, name)
}

/** A canvas session whose view mode the test drives; site-transients reads only `queries.view.mode`. */
function canvasInMode(mode: 'site' | 'overview') {
  const viewMode = signal(mode)
  setCurrentCanvasSession({ queries: { view: { mode: viewMode } } } as unknown as CanvasRuntimeSurfaces)
  return viewMode
}

describe('the Site data transients (canopi-f47t.42, U49)', () => {
  beforeEach(() => {
    openDesign('Orchard')
    selectPanel('site-data')
  })

  afterEach(() => {
    endSiteDataTransients()
    setCurrentCanvasSession(null)
    sidePanel.value = null
    activePanel.value = 'canvas'
  })

  it('holds the pin and the profile line in lon/lat while Site data is the open panel', () => {
    setPin(PARIS)
    setProfileLine(LINE)

    expect(pin.value).toEqual(PARIS)
    expect(profileLine.value).toEqual(LINE)
  })

  it('pins nothing and draws no profile while Site data is not the open panel', () => {
    selectPanel('layers')

    setPin(PARIS)
    setProfileLine(LINE)

    expect(pin.value).toBeNull()
    expect(profileLine.value).toBeNull()
  })

  it('keeps a profile only of two or more finite points, and a pin only at a finite point', () => {
    setProfileLine([LINE[0]!])
    setPin({ lon: Number.NaN, lat: 1 })

    expect(profileLine.value).toBeNull()
    expect(pin.value).toBeNull()
  })

  it('one Esc clears the profile (layer 25), the next unpins (layer 20), and a third finds nothing to do', () => {
    setPin(PARIS)
    setProfileLine(LINE)

    expect(escape()).toBe(true)
    expect(profileLine.value).toBeNull()
    expect(pin.value).toEqual(PARIS)

    expect(escape()).toBe(true)
    expect(pin.value).toBeNull()

    expect(escape()).toBe(false)
  })

  it('leaves Esc to a text field and to a modified Esc', () => {
    setPin(PARIS)

    expect(esc('text')).toBe(false)
    expect(esc('map', true)).toBe(false)
    expect(pin.value).toEqual(PARIS)
  })

  it('Unpin and the chart\'s × end one transient each', () => {
    setPin(PARIS)
    setProfileLine(LINE)

    clearProfile()
    expect(profileLine.value).toBeNull()
    expect(pin.value).toEqual(PARIS)

    setProfileLine(LINE)
    unpin()
    expect(pin.value).toBeNull()
    expect(profileLine.value).toEqual(LINE)
  })

  it('switching the dock to another panel (Ctrl 1) ends the pin and the profile', () => {
    setPin(PARIS)
    setProfileLine(LINE)

    selectPanel('layers')
    selectPanel('site-data')

    expect(pin.value).toBeNull()
    expect(profileLine.value).toBeNull()
  })

  it('closing Site data ends them', () => {
    setPin(PARIS)
    setProfileLine(LINE)

    sidePanel.value = null

    expect(pin.value).toBeNull()
    expect(profileLine.value).toBeNull()
  })

  it('replacing the Design ends them, with Site data still open', () => {
    setPin(PARIS)
    setProfileLine(LINE)

    openDesign('Meadow')

    expect(sidePanel.value).toBe('site-data')
    expect(pin.value).toBeNull()
    expect(profileLine.value).toBeNull()
  })

  it('leaving Canvas ends them', () => {
    setPin(PARIS)
    setProfileLine(LINE)

    selectPanel('templates')

    expect(pin.value).toBeNull()
    expect(profileLine.value).toBeNull()
  })

  it('entering overview ends them, and overview pins nothing', () => {
    const mode = canvasInMode('site')
    setPin(PARIS)
    setProfileLine(LINE)

    mode.value = 'overview'

    expect(pin.value).toBeNull()
    expect(profileLine.value).toBeNull()
    setPin(PARIS)
    expect(pin.value).toBeNull()

    mode.value = 'site'
    setPin(PARIS)
    expect(pin.value).toEqual(PARIS)
  })
})
