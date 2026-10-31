// The location session's state machine (canopi-f47t.53; U54 Q13, Q16, Q17, Q12; design check A3, A4): Off, Following,
// Moved away, Blocked, and stale, over a stubbed browser geolocation and Permissions API and a fake view.
import { signal } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeoPoint } from '../../generated/contracts'
import type { ViewCamera } from '../../canvas/runtime/view/types'
import type { FollowView } from './follow'
import type { CanopiFile } from '../../types/design'
import { designSessionStore } from '../document-session/store'
import { MyLocationSession, myLocation } from './session'

const FIX = { coords: { longitude: 12.3456789, latitude: 45.6789012, accuracy: 25 }, timestamp: 1_760_000_000_000 }
const MOVED = { coords: { longitude: 12.3476789, latitude: 45.6789012, accuracy: 50 }, timestamp: 1_760_000_001_000 }

const descriptors = {
  geolocation: Object.getOwnPropertyDescriptor(navigator, 'geolocation'),
  permissions: Object.getOwnPropertyDescriptor(navigator, 'permissions'),
}

/** The browser's geolocation: one watch at a time, driven by the test. */
class FakeGeolocation {
  watches = 0
  cleared: number[] = []
  private success: PositionCallback | null = null
  private failure: PositionErrorCallback | null = null
  watchPosition = vi.fn((success: PositionCallback, failure: PositionErrorCallback) => {
    this.success = success
    this.failure = failure
    this.watches += 1
    return this.watches
  })
  clearWatch = vi.fn((id: number) => {
    this.cleared.push(id)
    this.success = null
    this.failure = null
  })
  get watching(): boolean { return this.success !== null }
  fix(position: typeof FIX) { this.success?.(position as unknown as GeolocationPosition) }
  error(code: 1 | 2 | 3) { this.failure?.({ code, message: '' } as GeolocationPositionError) }
}

/** A PermissionStatus whose state the test changes, firing `change` as the browser does. */
class FakePermissionStatus extends EventTarget {
  constructor(public state: PermissionState) { super() }
  set(next: PermissionState) {
    this.state = next
    this.dispatchEvent(new Event('change'))
  }
}

let geolocation: FakeGeolocation
let permission: FakePermissionStatus | null

beforeEach(() => {
  geolocation = new FakeGeolocation()
  permission = new FakePermissionStatus('prompt')
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: geolocation })
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: vi.fn(async () => { if (!permission) throw new TypeError('unsupported'); return permission }) },
  })
})

afterEach(() => {
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(navigator, name, descriptor)
    else delete (navigator as unknown as Record<string, unknown>)[name]
  }
})

function fakeView() {
  let live: ViewCamera = { center: { lon: 3.87, lat: 43.61 }, zoom: 14, bearingDeg: 0, pitchDeg: 0 }
  const settledCamera = signal<ViewCamera>(live)
  const showPlace = vi.fn((place: GeoPoint, zoom: number) => {
    live = { ...live, center: { ...place }, zoom }
    return true
  })
  const view: FollowView = { settledCamera, captureCamera: () => live, showPlace, showCamera: (camera) => { live = { ...camera } } }
  return {
    view, showPlace,
    pan() { live = { ...live, center: { lon: live.center.lon + 0.01, lat: live.center.lat } }; settledCamera.value = live },
    settle() { settledCamera.value = { ...live } },
    centre: () => live.center,
  }
}

function setup() {
  const view = fakeView()
  const designIdentity = signal<object>({})
  const presenting = signal(false)
  const designOpen = signal(true)
  const session = new MyLocationSession({ view: signal(view.view), designIdentity, designOpen, presenting })
  return { session, view, designIdentity, designOpen, presenting }
}

async function settlePermission() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('the location session', () => {
  it('starts Off with no reading; a click watches and follows: the first fix is centred at max(zoom, 17), later ones at the zoom', () => {
    const s = setup()
    expect(s.session.mode.value).toBe('off')
    expect(s.session.reading.value).toBeNull()

    s.session.press()
    expect(s.session.mode.value).toBe('following')
    expect(geolocation.watching).toBe(true)
    expect(s.session.reading.value, 'no dot before the first fix').toBeNull()

    geolocation.fix(FIX)
    expect(s.session.reading.value).toEqual({ lon: 12.3456789, lat: 45.6789012, accuracy: 25, timestamp: 1_760_000_000_000, stale: false })
    expect(s.view.showPlace).toHaveBeenLastCalledWith({ lon: 12.3456789, lat: 45.6789012 }, 17, { motion: 'jump' })
    s.view.settle()
    geolocation.fix(MOVED)
    expect(s.view.showPlace).toHaveBeenLastCalledWith({ lon: 12.3476789, lat: 45.6789012 }, 17, { motion: 'jump' })
    expect(s.session.mode.value).toBe('following')
  })

  it('a click while Following turns location off: the watch is cleared and the reading goes', () => {
    const s = setup()
    s.session.press()
    geolocation.fix(FIX)
    s.session.press()
    expect(s.session.mode.value).toBe('off')
    expect(s.session.reading.value).toBeNull()
    expect(geolocation.clearWatch).toHaveBeenCalledOnce()
    expect(geolocation.watching).toBe(false)
  })

  it('an outside move is Moved away: fixes still update the dot without moving the camera, and a click re-centres and follows', () => {
    const s = setup()
    s.session.press()
    geolocation.fix(FIX)
    s.view.settle()
    s.view.pan()
    expect(s.session.mode.value).toBe('moved-away')
    const jumps = s.view.showPlace.mock.calls.length
    geolocation.fix(MOVED)
    expect(s.session.reading.value?.lon).toBe(12.3476789)
    expect(s.view.showPlace).toHaveBeenCalledTimes(jumps)

    s.session.press()
    expect(s.session.mode.value).toBe('following')
    expect(s.view.showPlace).toHaveBeenLastCalledWith({ lon: 12.3476789, lat: 45.6789012 }, 17, { motion: 'jump' })
    expect(geolocation.watches, 'the same watch goes on').toBe(1)
    s.view.settle()
    expect(s.session.mode.value).toBe('following')
  })

  it('keeps running across a Design switch with follow ended, and a story presentation ends follow (U54 Q17, Q12)', () => {
    const s = setup()
    s.session.press()
    geolocation.fix(FIX)
    s.designIdentity.value = {}
    expect(s.session.mode.value).toBe('moved-away')
    expect(s.session.reading.value).not.toBeNull()
    expect(geolocation.watching).toBe(true)

    s.session.press()
    expect(s.session.mode.value).toBe('following')
    s.presenting.value = true
    expect(s.session.mode.value).toBe('moved-away')
  })

  it('closing the Design turns location off, so no watch outlives the button; opening one later leaves it off', () => {
    for (const mode of ['following', 'moved-away'] as const) {
      const s = setup()
      s.session.press()
      geolocation.fix(FIX)
      if (mode === 'moved-away') s.designIdentity.value = {}
      expect(s.session.mode.value).toBe(mode)
      s.designIdentity.value = {}
      s.designOpen.value = false
      expect(s.session.mode.value).toBe('off')
      expect(s.session.reading.value).toBeNull()
      expect(geolocation.watching).toBe(false)
      s.designOpen.value = true
      expect(s.session.mode.value).toBe('off')
      expect(geolocation.watching).toBe(false)
    }
  })

  it('a pan while waiting for the first fix is Moved away: the fix shows the dot without moving the camera, and a click re-centres', () => {
    const s = setup()
    s.session.press()
    s.view.pan()
    expect(s.session.mode.value).toBe('moved-away')
    geolocation.fix(FIX)
    expect(s.session.reading.value?.lon).toBe(12.3456789)
    expect(s.view.showPlace).not.toHaveBeenCalled()

    s.session.press()
    expect(s.session.mode.value).toBe('following')
    expect(s.view.showPlace).toHaveBeenLastCalledWith({ lon: 12.3456789, lat: 45.6789012 }, 17, { motion: 'jump' })
  })

  it('codes 2 and 3 mark the reading stale and location unavailable, keep the watch and follow; the next fix clears them (Q16)', () => {
    const s = setup()
    s.session.press()
    geolocation.error(3)
    expect(s.session.unavailable.value, 'unavailable before any fix').toBe(true)
    expect(s.session.reading.value).toBeNull()
    geolocation.fix(FIX)
    expect(s.session.unavailable.value).toBe(false)
    geolocation.error(2)
    expect(s.session.reading.value?.stale).toBe(true)
    expect(s.session.unavailable.value).toBe(true)
    expect(s.session.mode.value).toBe('following')
    expect(geolocation.watching).toBe(true)
    geolocation.fix(FIX)
    expect(s.session.reading.value?.stale).toBe(false)
  })

  it('a code 2 burst before each fix never ends Following, and each fix is followed (Chromium\'s setGeolocation, design check §6)', () => {
    const s = setup()
    s.session.press()
    for (const position of [FIX, MOVED, FIX, MOVED]) {
      geolocation.error(2)
      geolocation.error(2)
      geolocation.fix(position)
      s.view.settle()
      expect(s.session.mode.value).toBe('following')
      expect(s.view.centre().lon).toBe(position.coords.longitude)
    }
  })

  it('code 1 with the permission denied is Blocked: a click does nothing until the permission changes, which gives Off (A4)', async () => {
    permission = new FakePermissionStatus('denied')
    const s = setup()
    s.session.press()
    geolocation.fix(FIX)
    geolocation.error(1)
    expect(geolocation.watching).toBe(false)
    expect(s.session.reading.value).toBeNull()
    await settlePermission()
    expect(s.session.mode.value).toBe('blocked')

    s.session.press()
    expect(geolocation.watches).toBe(1)
    expect(s.session.mode.value).toBe('blocked')

    permission.set('prompt')
    expect(s.session.mode.value).toBe('off')
    s.session.press()
    expect(s.session.mode.value).toBe('following')
    expect(geolocation.watches).toBe(2)
  })

  it.each([
    ['prompt (a dismissed prompt; Chromium in Playwright)', 'prompt'],
    ['granted (the OS location is off)', 'granted'],
    ['no Permissions API', null],
  ] as const)('every other code 1 answer is Off: %s', async (_name, state) => {
    permission = state === null ? null : new FakePermissionStatus(state)
    const s = setup()
    s.session.press()
    geolocation.error(1)
    await settlePermission()
    expect(s.session.mode.value).toBe('off')
    expect(geolocation.watching).toBe(false)
    s.session.press()
    expect(s.session.mode.value).toBe('following')
  })

  it('a permission answer that arrives after the user pressed again is ignored', async () => {
    permission = new FakePermissionStatus('denied')
    const s = setup()
    s.session.press()
    geolocation.error(1)
    s.session.press()
    await settlePermission()
    expect(s.session.mode.value).toBe('following')
  })

  it('leaves Blocked\'s permission listener when it turns off, so a later change does nothing', async () => {
    permission = new FakePermissionStatus('denied')
    const s = setup()
    s.session.press()
    geolocation.error(1)
    await settlePermission()
    permission.set('granted')
    expect(s.session.mode.value).toBe('off')
    s.session.press()
    permission.set('prompt')
    expect(s.session.mode.value).toBe('following')
  })
})

describe('the app\'s location session', () => {
  it('turns off when the Design session store closes the Design (File › Close)', () => {
    const design = { version: 9, name: 'Here', layers: [], plants: [], zones: [], annotations: [] } as unknown as CanopiFile
    designSessionStore.replaceCurrentDesignState(design, null, 'Here')
    try {
      myLocation.press()
      geolocation.fix(FIX)
      expect(myLocation.mode.value).toBe('following')
      designSessionStore.clearCurrentDesign()
      expect(myLocation.mode.value).toBe('off')
      expect(myLocation.reading.value).toBeNull()
      expect(geolocation.clearWatch).toHaveBeenCalledOnce()
    } finally {
      if (myLocation.mode.peek() !== 'off') myLocation.press()
      designSessionStore.clearCurrentDesign()
    }
  })
})
