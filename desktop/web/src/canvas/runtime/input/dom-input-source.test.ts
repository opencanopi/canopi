// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureWindowErrors } from '../../../__tests__/support/canvas-interaction-setup'
import {
  createSceneInteractionEventHarness,
  type SceneInteractionEventHarness,
} from '../../../__tests__/support/canvas-interaction-events'
import { writePlantStampDragData } from '../../stamp-drag-data'
import type { DomInputSourceDeps } from '../interaction-ports'
import { createDomInputSource, outcomeEffects } from './dom-input-source'
import type { Gesture } from './gestures'
import type { RawInput, RecogniserConfig } from './raw-input'
import { initialRecogniserState, recognise } from './recognise'
import { DEFAULT_THRESHOLDS } from './thresholds'

const PLATFORM = { os: 'linux', gestureEvents: false } as const
const RECOGNISER_CONFIG: RecogniserConfig = { platform: PLATFORM, thresholds: DEFAULT_THRESHOLDS }

let host: HTMLDivElement
let events: SceneInteractionEventHarness
let received: RawInput[]

beforeEach(() => {
  host = document.createElement('div')
  host.setAttribute('style', 'position: relative; cursor: default;')
  document.body.appendChild(host)
  events = createSceneInteractionEventHarness(host, { bounds: { left: 10, top: 20, width: 400, height: 300 } })
  received = []
})

afterEach(() => {
  events.dispose()
  host.remove()
  document.body.innerHTML = ''
})

function deps(overrides: Partial<DomInputSourceDeps> = {}): DomInputSourceDeps {
  return {
    host,
    platform: PLATFORM,
    timers: { set: vi.fn(() => 1), clear: vi.fn() },
    ...overrides,
  }
}

function attachRecording(source: ReturnType<typeof createDomInputSource>, onInput?: (input: RawInput) => void): () => void {
  return source.attach((input) => {
    received.push(input)
    onInput?.(input)
  })
}

function listenerCalls(spy: { mock: { calls: unknown[][] } }): Array<[string, unknown, unknown]> {
  return spy.mock.calls.map((call) => [call[0] as string, call[1], call[2]])
}

function captureFlag(options: unknown): boolean {
  return typeof options === 'boolean' ? options : Boolean((options as { capture?: boolean } | undefined)?.capture)
}

describe('createDomInputSource', () => {
  it('installs and removes each listener exactly once', () => {
    const spies = {
      hostAdd: vi.spyOn(host, 'addEventListener'),
      hostRemove: vi.spyOn(host, 'removeEventListener'),
      windowAdd: vi.spyOn(window, 'addEventListener'),
      windowRemove: vi.spyOn(window, 'removeEventListener'),
      documentAdd: vi.spyOn(document, 'addEventListener'),
      documentRemove: vi.spyOn(document, 'removeEventListener'),
    }
    const source = createDomInputSource(deps())
    const dispose = attachRecording(source)

    const hostAdds = listenerCalls(spies.hostAdd)
    expect(hostAdds.map(([type, , options]) => [type, captureFlag(options)])).toEqual([
      ['pointerdown', true],
      ['pointermove', false],
      ['pointerleave', false],
      ['lostpointercapture', false],
      ['wheel', false],
      ['dragover', false],
      ['dragleave', false],
      ['drop', false],
      ['focusout', false],
      // The selection-drag guard (selection-drag-guard.test.ts).
      ['pointerdown', true],
      ['dragstart', true],
      ['selectstart', true],
    ])
    expect(hostAdds.find(([type]) => type === 'wheel')?.[2]).toEqual({ passive: false })
    expect(listenerCalls(spies.windowAdd).map(([type, , options]) => [type, captureFlag(options)])).toEqual([['blur', false]])
    // The one contextmenu listener: at document capture, so a menu retargeted off the map is heard too.
    expect(listenerCalls(spies.documentAdd).map(([type, , options]) => [type, captureFlag(options)])).toEqual([['contextmenu', true]])
    // A press on the map owns its pointer: the window listeners follow it, and detach removes them with the rest.
    events.pointerDown({ x: 10, y: 10 })
    expect(listenerCalls(spies.windowAdd).map(([type, , options]) => [type, captureFlag(options)])).toEqual([
      ['blur', false],
      ['pointermove', true],
      ['pointerup', true],
      ['pointercancel', true],
    ])

    dispose()
    dispose()

    for (const [add, remove] of [
      [spies.hostAdd, spies.hostRemove],
      [spies.windowAdd, spies.windowRemove],
      [spies.documentAdd, spies.documentRemove],
    ] as const) {
      // Each removed once, in any order (the window's session listeners go first).
      const byType = (calls: Array<[string, unknown, unknown]>) => calls
        .map(([type, listener, options]) => [type, listener, captureFlag(options)] as const)
        .sort(([a], [b]) => a.localeCompare(b))
      expect(byType(listenerCalls(remove))).toEqual(byType(listenerCalls(add)))
    }
    for (const spy of Object.values(spies)) spy.mockRestore()
  })

  it('installs no key listener (the key router owns them), and only the contextmenu listener on the document', () => {
    const windowAdd = vi.spyOn(window, 'addEventListener')
    const documentAdd = vi.spyOn(document, 'addEventListener')
    const dispose = attachRecording(createDomInputSource(deps()))
    expect(listenerCalls(windowAdd).map(([type]) => type)).toEqual(['blur'])
    expect(listenerCalls(documentAdd).map(([type]) => type)).toEqual(['contextmenu'])
    dispose()
    windowAdd.mockRestore()
    documentAdd.mockRestore()
  })

  it('removes every listener it added when one installation fails', () => {
    const failure = new Error('wheel installation failed')
    const originalAdd = host.addEventListener.bind(host)
    const hostAdd = vi.spyOn(host, 'addEventListener').mockImplementation(((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
      if (type === 'wheel') throw failure
      originalAdd(type, listener, options)
    }) as typeof host.addEventListener)
    const windowRemove = vi.spyOn(window, 'removeEventListener')
    const hostRemove = vi.spyOn(host, 'removeEventListener')

    expect(() => createDomInputSource(deps()).attach(() => {})).toThrow(failure)
    expect(listenerCalls(hostRemove).map(([type]) => type)).toEqual(['pointerdown', 'pointermove', 'pointerleave', 'lostpointercapture'])
    expect(listenerCalls(windowRemove).map(([type]) => type)).toEqual(['blur'])
    for (const spy of [hostAdd, windowRemove, hostRemove]) spy.mockRestore()
  })

  it('window listeners exist only during an owned session', () => {
    const downstream = vi.fn((event: Event) => event.defaultPrevented)
    window.addEventListener('pointerup', downstream)
    const windowAdd = vi.spyOn(window, 'addEventListener')
    const windowRemove = vi.spyOn(window, 'removeEventListener')
    const types = (spy: typeof windowAdd): string[] => listenerCalls(spy).map(([type]) => type).filter((type) => type !== 'blur')
    const source = createDomInputSource(deps())
    const dispose = attachRecording(source, (input) => {
      if (input.kind === 'down') source.apply([{ kind: 'prevent-default' }, { kind: 'capture', pointerId: input.id }])
      if (input.kind === 'up') source.apply([{ kind: 'release-capture', pointerId: input.id }])
    })
    const panel = document.createElement('div')
    document.body.appendChild(panel)

    try {
      // A press, move and release that start outside the map belong to the page: nothing is installed, heard or stopped.
      events.pointerDown({ x: 10, y: 10 }, { target: panel, pointerId: 3 })
      events.pointerMove({ x: 20, y: 10 }, { target: panel, pointerId: 3, buttons: 1 })
      const foreignUp = events.pointerUp({ x: 20, y: 10 }, { target: panel, pointerId: 3 })
      expect(types(windowAdd)).toEqual([])
      expect(received).toEqual([])
      expect(foreignUp.defaultPrevented).toBe(false)
      expect(downstream).toHaveBeenCalledTimes(1)

      // A press on the map owns its pointer until its release: the window follows it there, and only it.
      events.pointerDown({ x: 10, y: 10 }, { pointerId: 4 })
      expect(types(windowAdd)).toEqual(['pointermove', 'pointerup', 'pointercancel'])
      events.pointerMove({ x: 500, y: 10 }, { target: panel, pointerId: 4, buttons: 1 })
      events.pointerMove({ x: 30, y: 10 }, { target: panel, pointerId: 3 })
      events.pointerUp({ x: 500, y: 10 }, { target: panel, pointerId: 4 })
      expect(received.map((input) => `${input.kind}:${'id' in input ? input.id : ''}`)).toEqual(['down:4', 'move:4', 'up:4'])
      expect(types(windowRemove)).toEqual(['pointermove', 'pointerup', 'pointercancel'])
      expect(downstream).toHaveBeenCalledTimes(2)

      // A cancel and a window blur end the ownership too.
      events.pointerDown({ x: 10, y: 10 }, { pointerId: 5 })
      events.pointerCancel({ x: 10, y: 10 }, { pointerId: 5 })
      events.pointerDown({ x: 10, y: 10 }, { pointerId: 6 })
      events.windowBlur()
      expect(types(windowAdd)).toHaveLength(9)
      expect(types(windowRemove)).toHaveLength(9)
    } finally {
      panel.remove()
      dispose()
      windowAdd.mockRestore()
      windowRemove.mockRestore()
      window.removeEventListener('pointerup', downstream)
    }
  })

  it('a hover move on the host reaches the recogniser', () => {
    const dispose = attachRecording(createDomInputSource(deps()))
    const inside = document.createElement('canvas')
    host.appendChild(inside)
    const panel = document.createElement('div')
    document.body.appendChild(panel)

    events.pointerMove({ x: 30, y: 40 }, { target: inside })
    events.pointerMove({ x: 30, y: 40 }, { target: panel })

    expect(received).toEqual([expect.objectContaining({ kind: 'move', at: { x: 30, y: 40 }, target: { kind: 'surface' } })])
    panel.remove()
    dispose()
  })

  it('a hover leaving the map reaches the point where it left before it ends', () => {
    let state = initialRecogniserState()
    const gestures: string[] = []
    const dispose = attachRecording(createDomInputSource(deps()), (input) => {
      const result = recognise(state, input, RECOGNISER_CONFIG)
      state = result.state
      gestures.push(...result.gestures.map((gesture) => gesture.kind === 'hover' ? `hover:${gesture.at.x},${gesture.at.y}` : gesture.kind))
    })
    const panel = document.createElement('div')
    document.body.appendChild(panel)

    try {
      // A quick flick: the last move the map heard is well inside it; the move that left lands on the panel, which the map
      // never hears, so the leave carries its point. A tool's preview (a rubber band, a row, a stamp's ghost) follows the
      // pointer to it, as the window's moves once carried it, and only then does the hover end.
      events.pointerMove({ x: 200, y: 150 })
      events.pointerLeave({ x: 430, y: 150 }, { relatedTarget: panel })
      expect(received.map((input) => input.kind === 'move' ? `move:${input.at.x},${input.at.y}:${input.target.kind}` : input.kind))
        .toEqual(['move:200,150:surface', 'move:430,150:foreign', 'leave'])
      expect(gestures).toEqual(['hover:200,150', 'hover:430,150', 'hover-end'])

      // A pointer the map owns (a press on it) follows on window, so its leave adds no move; a touch has no hover.
      received.length = 0
      events.pointerDown({ x: 10, y: 10 }, { pointerId: 4 })
      events.pointerLeave({ x: 430, y: 10 }, { pointerId: 4, relatedTarget: panel })
      events.pointerUp({ x: 430, y: 10 }, { pointerId: 4, target: panel })
      events.pointerLeave({ x: 430, y: 10 }, { pointerId: 5, pointerType: 'touch', relatedTarget: panel })
      expect(received.map((input) => input.kind)).toEqual(['down', 'leave', 'up', 'leave'])
    } finally {
      panel.remove()
      dispose()
    }
  })

  it('reads host-relative points and keeps a captured session\'s press rect', () => {
    const source = createDomInputSource(deps())
    const dispose = attachRecording(source, (input) => {
      if (input.kind === 'down') source.apply([{ kind: 'capture', pointerId: input.id }])
    })

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 12 })
    events.setBounds({ left: 30, top: 40, width: 400, height: 300 })
    events.pointerMoveClient({ x: 55, y: 75 }, { pointerId: 12, buttons: 1 })
    events.pointerMoveClient({ x: 55, y: 75 }, { pointerId: 13 })

    expect(received.map((input) => 'at' in input ? input.at : null)).toEqual([
      { x: 20, y: 30 },
      { x: 45, y: 55 },
      { x: 25, y: 35 },
    ])
    expect(events.pointerCapture.setCalls).toHaveBeenCalledWith(12)
    dispose()
  })

  it('classifies targets from data attributes', () => {
    const child = (html: string): HTMLElement => {
      const wrapper = document.createElement('div')
      wrapper.innerHTML = html
      const element = wrapper.firstElementChild as HTMLElement
      host.appendChild(element)
      return element
    }
    const plainHandle = child('<div data-canvas-handle="vertex:zone-1:2"></div>')
    const rotation = child('<div data-canvas-handle="rotate"><span data-canvas-handle-readout="true">+15°</span></div>')
    const controlPoint = child('<button data-canvas-handle="rect-corner:zone-1:ne"></button>')
    const editor = child('<textarea data-canvas-text-entry data-preserve-overlays="true"></textarea>')
    const chrome = child('<div data-canvas-chrome><span>©</span></div>')
    const surface = child('<canvas></canvas>')
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    const dispose = attachRecording(createDomInputSource(deps()))

    for (const target of [
      plainHandle,
      rotation.firstElementChild!,
      controlPoint,
      editor,
      chrome.firstElementChild!,
      surface,
      host,
    ]) {
      events.pointerMove({ x: 5, y: 5 }, { target })
    }

    expect(received.map((input) => input.kind === 'move' && input.target)).toEqual([
      { kind: 'handle', id: 'vertex:zone-1:2' },
      { kind: 'handle', id: 'rotate' },
      { kind: 'handle', id: 'rect-corner:zone-1:ne' },
      { kind: 'owned-text' },
      { kind: 'owned-chrome' },
      { kind: 'surface' },
      { kind: 'surface' },
    ])

    // An up carries its target too: the session keeps today's release cleanup off the note editor and a handle by it, and
    // a release outside the map is foreign.
    received.length = 0
    for (const target of [editor, plainHandle, chrome.firstElementChild!, surface, outside]) {
      events.pointerDown({ x: 5, y: 5 })
      events.pointerUp({ x: 5, y: 5 }, { target })
    }
    expect(received.flatMap((input) => input.kind === 'up' ? [input.target] : [])).toEqual([
      { kind: 'owned-text' },
      { kind: 'handle', id: 'vertex:zone-1:2' },
      { kind: 'owned-chrome' },
      { kind: 'surface' },
      { kind: 'foreign' },
    ])
    dispose()
  })

  it('a press on the attribution is not a canvas press', () => {
    // MapLibre's attribution control sits inside the map host (the zoom group and compass sit beside it).
    host.insertAdjacentHTML('beforeend', [
      '<div class="maplibregl-control-container"><div class="maplibregl-ctrl-bottom-right">',
      '<details class="maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact" open>',
      '<summary class="maplibregl-ctrl-attrib-button" title="Toggle attribution"></summary>',
      '<div class="maplibregl-ctrl-attrib-inner"><a href="https://maplibre.org/">MapLibre</a> <span>© OpenStreetMap</span></div>',
      '</details></div></div>',
    ].join(''))
    const attribution = host.querySelector('details')!
    let state = initialRecogniserState()
    const gestures: string[] = []
    const source = createDomInputSource(deps())
    const dispose = attachRecording(source, (input) => {
      const result = recognise(state, input, RECOGNISER_CONFIG)
      state = result.state
      gestures.push(...result.gestures.map((gesture) => gesture.kind))
      source.apply(result.effects)
    })

    const presses = [
      attribution.querySelector('summary')!,
      attribution.querySelector('a')!,
      attribution.querySelector('span')!,
      attribution.querySelector('.maplibregl-ctrl-attrib-inner')!,
    ].map((target) => {
      const press = events.pointerDown({ x: 380, y: 290 }, { target })
      events.pointerMove({ x: 300, y: 200 }, { target, buttons: 1 })
      events.pointerUp({ x: 300, y: 200 }, { target })
      return press
    })

    expect(received.filter((input) => input.kind === 'down').map((input) => input.kind === 'down' && input.target))
      .toEqual(Array(4).fill({ kind: 'owned-chrome' }))
    // No band starts, and the press keeps its default (the summary opens and the link follows).
    expect(gestures.filter((kind) => kind !== 'hover' && kind !== 'hover-end')).toEqual([])
    expect(presses.map((press) => press.defaultPrevented)).toEqual([false, false, false, false])
    expect(events.pointerCapture.setCalls).not.toHaveBeenCalled()
    dispose()
  })

  it('a wheel or pinch over the attribution zooms the map, not the page', () => {
    host.insertAdjacentHTML('beforeend', [
      '<div class="maplibregl-control-container"><div class="maplibregl-ctrl-bottom-right">',
      '<details class="maplibregl-ctrl maplibregl-ctrl-attrib" open>',
      '<summary class="maplibregl-ctrl-attrib-button" title="Toggle attribution"></summary>',
      '<div class="maplibregl-ctrl-attrib-inner"><a href="https://maplibre.org/">MapLibre</a> <span>© OpenStreetMap</span></div>',
      '</details></div></div>',
    ].join(''))
    let state = initialRecogniserState()
    const gestures: string[] = []
    const source = createDomInputSource(deps())
    const dispose = attachRecording(source, (input) => {
      const result = recognise(state, input, RECOGNISER_CONFIG)
      state = result.state
      gestures.push(...result.gestures.map((gesture) => gesture.kind))
      source.apply(result.effects)
    })

    // Only presses and hovers treat the attribution as the map's own chrome; a wheel there is a map wheel.
    const wheels = [...host.querySelectorAll('summary, a, span')].flatMap((target) => [false, true].map((ctrlKey) => {
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 380, clientY: 300, deltaY: 10, ctrlKey })
      target.dispatchEvent(wheel)
      return wheel
    }))

    expect(received.map((input) => input.kind === 'wheel' && input.target)).toEqual(Array(6).fill({ kind: 'surface' }))
    expect(gestures).toEqual(Array(6).fill('zoom'))
    expect(wheels.map((wheel) => wheel.defaultPrevented)).toEqual(Array(6).fill(true))
    dispose()
  })

  it('leaves text fields, menus and dialogs their own contextmenu and wheel', () => {
    const field = document.createElement('input')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const inDialog = document.createElement('span')
    dialog.appendChild(inDialog)
    host.append(field, dialog)
    const dispose = attachRecording(createDomInputSource(deps()))

    for (const target of [field, inDialog]) {
      const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      target.dispatchEvent(menu)
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 10 })
      target.dispatchEvent(wheel)
      expect(menu.defaultPrevented).toBe(false)
      expect(wheel.defaultPrevented).toBe(false)
    }
    expect(received).toEqual([])
    events.wheel({ x: 5, y: 5 }, { deltaY: 10 })
    expect(received.map((input) => input.kind)).toEqual(['wheel'])
    dispose()
  })

  describe('the native contextmenu (spec §2.2 "Native menu"; U34)', () => {
    /** A contextmenu at an event time, as the browser sends it after a press, a release or a key. */
    function contextMenu(target: EventTarget, timeStamp: number): MouseEvent {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 40 })
      Object.defineProperty(event, 'timeStamp', { value: timeStamp })
      target.dispatchEvent(event)
      return event
    }

    function pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', target: EventTarget, timeStamp: number, init: MouseEventInit = {}): void {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 30, clientY: 40, ...init })
      Object.defineProperties(event, {
        pointerId: { value: 1 }, pointerType: { value: 'mouse' }, timeStamp: { value: timeStamp },
      })
      target.dispatchEvent(event)
    }

    it('C5, C1: over the map, with no press (a pen press-and-hold, VO+Shift+M, the Menu key\'s own), it is prevented and opens nothing', () => {
      const handle = document.createElement('div')
      handle.setAttribute('data-canvas-handle', 'rotate')
      host.append(handle)
      const dispose = attachRecording(createDomInputSource(deps()))
      expect(contextMenu(host, 10).defaultPrevented).toBe(true)
      expect(contextMenu(handle, 20).defaultPrevented).toBe(true)
      expect(received).toEqual([])
      dispose()
    })

    it('A15, C4: the note editor and the map\'s fields keep their native menu in all three orderings, and outside the map it is the page\'s', () => {
      const editor = document.createElement('div')
      editor.setAttribute('data-canvas-text-entry', '')
      const text = document.createElement('textarea')
      editor.append(text)
      const field = document.createElement('input')
      host.append(editor, field)
      const panel = document.createElement('div')
      document.body.append(panel)
      const linux = attachRecording(createDomInputSource(deps()))
      for (const target of [text, field]) {
        // Linux and macOS: the menu at the press.
        pointer('pointerdown', target, 100, { button: 2, buttons: 2 })
        expect(contextMenu(target, 101).defaultPrevented).toBe(false)
        pointer('pointerup', target, 102, { button: 2 })
        // Windows: the menu after the release.
        pointer('pointerdown', target, 200, { button: 2, buttons: 2 })
        pointer('pointerup', target, 201, { button: 2 })
        expect(contextMenu(target, 260).defaultPrevented).toBe(false)
      }
      expect(contextMenu(panel, 300).defaultPrevented).toBe(false)
      linux()
      // Mac Control-click: the press is secondary, the menu at the press.
      const mac = attachRecording(createDomInputSource(deps({ platform: { os: 'mac', gestureEvents: true } })))
      pointer('pointerdown', text, 400, { button: 0, buttons: 1, ctrlKey: true })
      expect(contextMenu(text, 401).defaultPrevented).toBe(false)
      pointer('pointerup', text, 402, { button: 0, ctrlKey: true })
      mac()
      panel.remove()
    })

    it('A8, A11: anywhere while a canvas press is held, and within 500 ms of a secondary release, the menu is prevented', () => {
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      document.body.append(menu)
      const dispose = attachRecording(createDomInputSource(deps()))
      // A11: a right press during a left drag, whose menu (Linux, at the press) lands wherever the pointer is.
      pointer('pointerdown', host, 100, { button: 0, buttons: 1 })
      expect(contextMenu(document.documentElement, 150).defaultPrevented).toBe(true)
      pointer('pointerup', document.body, 200, { button: 0 })
      // A primary release leaves no trail: the page's own menu opens off the map.
      expect(contextMenu(menu, 250).defaultPrevented).toBe(false)
      // A8: the WebView2 trail after a right release, retargeted to <html> or to the menu just opened.
      pointer('pointerdown', host, 1000, { button: 2, buttons: 2 })
      pointer('pointerup', document.body, 1100, { button: 2 })
      expect(contextMenu(document.documentElement, 1166).defaultPrevented).toBe(true)
      expect(contextMenu(menu, 1599).defaultPrevented).toBe(true)
      expect(contextMenu(menu, 1600).defaultPrevented).toBe(false)
      expect(received.map((input) => input.kind)).toEqual(['down', 'up', 'down', 'up'])
      menu.remove()
      dispose()
    })

    it('a canvas pointer whose release reports the right or pen-barrel button starts the trail too (a chorded right button released last, U36)', () => {
      const dispose = attachRecording(createDomInputSource(deps()))
      // A left press on the map, the right button chorded over it (buttons 3) and released last: the pointerup reports
      // button 2. Without the chord over the canvas a button-2 release starts none (U37, canvas-interaction-e2e.pointer).
      pointer('pointerdown', host, 100, { button: 0, buttons: 1 })
      pointer('pointermove', host, 150, { button: 2, buttons: 3 })
      pointer('pointerup', document.body, 200, { button: 2 })
      expect(contextMenu(document.documentElement, 260).defaultPrevented).toBe(true)
      expect(contextMenu(document.body, 699).defaultPrevented).toBe(true)
      expect(contextMenu(document.body, 700).defaultPrevented).toBe(false)
      dispose()
    })

    it('B7: a Mac Control press on the map is secondary: its menu at the press is prevented, and its trail after the release', () => {
      const dispose = attachRecording(createDomInputSource(deps({ platform: { os: 'mac', gestureEvents: true } })))
      pointer('pointerdown', host, 100, { button: 0, buttons: 1, ctrlKey: true })
      expect(contextMenu(host, 101).defaultPrevented).toBe(true)
      pointer('pointerup', document.body, 300, { button: 0, ctrlKey: true })
      expect(contextMenu(document.body, 320).defaultPrevented).toBe(true)
      expect(received[0]).toMatchObject({ kind: 'down', role: 'secondary', ctrlConsumed: true })
      dispose()
    })
  })

  it('a quarantine outcome prevents and stops the event', () => {
    const source = createDomInputSource(deps())
    const dispose = attachRecording(source, () => source.apply(outcomeEffects([], { quarantine: true })))
    const downstream = vi.fn()
    host.addEventListener('drop', downstream)

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    host.dispatchEvent(drop)

    expect(drop.defaultPrevented).toBe(true)
    expect(downstream).not.toHaveBeenCalled()
    host.removeEventListener('drop', downstream)
    dispose()
  })

  it('a drop outcome sets dataTransfer.dropEffect', () => {
    const source = createDomInputSource(deps())
    const dispose = attachRecording(source, () => source.apply(outcomeEffects([{ kind: 'prevent-default' }], { dropEffect: 'copy' })))
    const data = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      get types() { return [...data.keys()] },
      setData(type: string, value: string) { data.set(type, value) },
      getData(type: string) { return data.get(type) ?? '' },
    }
    writePlantStampDragData(dataTransfer, { canonical_name: 'Pyrus communis', common_name: 'Pear', stratum: 'mid', width_max_m: 3 })
    const drag = (type: string): DragEvent => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
      Object.defineProperties(event, {
        clientX: { configurable: true, value: 80 },
        clientY: { configurable: true, value: 90 },
        dataTransfer: { configurable: true, value: dataTransfer },
      })
      host.dispatchEvent(event)
      return event
    }

    const over = drag('dragover')
    expect(over.defaultPrevented).toBe(true)
    expect(dataTransfer.dropEffect).toBe('copy')
    drag('drop')

    expect(received).toEqual([
      expect.objectContaining({ kind: 'drop', phase: 'over', at: { x: 70, y: 70 }, payload: { kind: 'species', species: null } }),
      expect.objectContaining({
        kind: 'drop',
        phase: 'drop',
        payload: { kind: 'species', species: expect.objectContaining({ canonical_name: 'Pyrus communis' }) },
      }),
    ])
    dispose()
  })

  it('a rejected press takes no capture', () => {
    const source = createDomInputSource(deps())
    const dispose = attachRecording(source, (input) => {
      if (input.kind !== 'down') return
      source.apply(outcomeEffects(
        [{ kind: 'prevent-default' }, { kind: 'capture', pointerId: input.id }],
        { quarantine: true, rejectSession: true },
      ))
    })
    const downstream = vi.fn()
    host.addEventListener('pointerdown', downstream)

    const press = events.pointerDown({ x: 10, y: 10 })

    expect(events.pointerCapture.setCalls).not.toHaveBeenCalled()
    expect(press.defaultPrevented).toBe(true)
    expect(downstream).not.toHaveBeenCalled()
    host.removeEventListener('pointerdown', downstream)
    dispose()
  })

  it('a throwing sink rethrows, and only a press on the map host is quarantined', () => {
    const failure = new Error('sink failed')
    const dispose = createDomInputSource(deps()).attach(() => {
      throw failure
    })
    const downstream = vi.fn()
    host.addEventListener('pointerdown', downstream)

    let press: PointerEvent | null = null
    const errors = captureWindowErrors(() => {
      press = events.pointerDown({ x: 10, y: 10 })
    })

    expect(errors).toEqual([failure])
    expect(press!.defaultPrevented).toBe(true)
    expect(downstream).not.toHaveBeenCalled()
    host.removeEventListener('pointerdown', downstream)
    dispose()
  })

  it('a sink that throws on any other event rethrows and leaves the event to the app', () => {
    const failure = new Error('sink failed')
    const dispose = createDomInputSource(deps()).attach(() => {
      throw failure
    })
    const panel = document.createElement('div')
    document.body.appendChild(panel)
    const heard: string[] = []
    const removals: Array<() => void> = []
    const listen = (target: EventTarget, type: string): void => {
      const listener = (event: Event): void => { heard.push(`${type}:${event.defaultPrevented}`) }
      target.addEventListener(type, listener)
      removals.push(() => target.removeEventListener(type, listener))
    }
    listen(panel, 'pointermove')
    listen(panel, 'pointercancel')
    listen(host, 'pointerleave')
    listen(host, 'wheel')
    listen(window, 'blur')
    listen(window, 'pointerup')
    listen(host, 'contextmenu')
    listen(host, 'dragover')
    listen(host, 'drop')

    let errors: unknown[] = []
    try {
      errors = captureWindowErrors(() => {
        // The press is quarantined (above); its pointer is owned all the same, so the window hears its moves and release.
        events.pointerDown({ x: 10, y: 10 })
        events.pointerMove({ x: 10, y: 10 }, { target: panel })
        events.pointerCancel({ x: 10, y: 10 }, { target: panel })
        events.pointerLeave({ x: 10, y: 10 })
        events.wheel({ x: 10, y: 10 }, { deltaY: 4 })
        events.pointerDown({ x: 10, y: 10 })
        events.pointerUp({ x: 10, y: 10 })
        events.windowBlur()
        for (const type of ['contextmenu', 'dragover', 'drop']) {
          host.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
        }
      })
    } finally {
      for (const remove of removals) remove()
      panel.remove()
      dispose()
    }

    // The one rule: rethrow on every event kind; only a press on the map host (covered above) is quarantined. The
    // contextmenu reaches no sink: the source's own listener prevents it over the map.
    expect(errors).toEqual(Array(10).fill(failure))
    expect(heard).toEqual([
      'pointermove:false',
      'pointercancel:false',
      'pointerleave:false',
      'wheel:false',
      'pointerup:false',
      'blur:false',
      'contextmenu:true',
      'dragover:false',
      'drop:false',
    ])
  })

  it('an overview pointerup elsewhere still reaches the page', () => {
    let state = recognise(
      initialRecogniserState(),
      { kind: 'configure', t: 0, context: { tool: 'select', mode: 'overview', pointingDevice: 'mouse' } },
      RECOGNISER_CONFIG,
    ).state
    const source = createDomInputSource(deps())
    const dispose = source.attach((input) => {
      const result = recognise(state, input, RECOGNISER_CONFIG)
      state = result.state
      source.apply(result.effects)
    })
    const downstream = vi.fn()
    window.addEventListener('pointerup', downstream)

    let handled: PointerEvent | undefined
    try {
      handled = new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 7, clientX: 999, clientY: 999 })
      document.body.dispatchEvent(handled)
    } finally {
      window.removeEventListener('pointerup', downstream)
      dispose()
    }

    expect(handled.defaultPrevented).toBe(false)
    expect(downstream).toHaveBeenCalledTimes(1)
  })

  it('pointerleave becomes its last move and a leave, and focusout becomes focus-out', () => {
    const dispose = attachRecording(createDomInputSource(deps()))
    const inside = document.createElement('button')
    host.appendChild(inside)

    events.pointerLeave({ x: 0, y: 0 })
    host.dispatchEvent(new FocusEvent('focusout', { relatedTarget: document.body }))
    // Focus moving to the note editor or a handle stays in the map.
    host.dispatchEvent(new FocusEvent('focusout', { relatedTarget: inside }))
    window.dispatchEvent(new Event('blur'))

    expect(received.map((input) => input.kind === 'cancel' ? `${input.kind}:${String(input.id)}:${input.reason}` : input.kind))
      .toEqual(['move', 'leave', 'focus-out', 'cancel:all:blur'])
    dispose()
  })

  it('forwards a lost capture only for a pointer the host holds, and a release makes its own loss stale', () => {
    events.dispose()
    events = createSceneInteractionEventHarness(host, { pointerCapture: { synchronousLossOnRelease: true } })
    const source = createDomInputSource(deps())
    const dispose = attachRecording(source, (input) => {
      if (input.kind === 'down') source.apply([{ kind: 'capture', pointerId: input.id }])
      if (input.kind === 'up') source.apply([{ kind: 'release-capture', pointerId: input.id }])
    })

    events.lostPointerCapture(4)
    events.pointerDown({ x: 10, y: 10 }, { pointerId: 4 })
    events.pointerUp({ x: 10, y: 10 }, { pointerId: 4 })
    events.pointerDown({ x: 10, y: 10 }, { pointerId: 4 })
    events.lostPointerCapture(4)

    expect(received.map((input) => input.kind === 'cancel' ? input.reason : input.kind)).toEqual(['down', 'up', 'down', 'lost-capture'])
    expect(events.pointerCapture.releaseCalls).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('a synchronous loss while capturing is forwarded and the capture is not kept', () => {
    events.dispose()
    events = createSceneInteractionEventHarness(host, { pointerCapture: { synchronousLossOnSet: true } })
    const source = createDomInputSource(deps())
    const dispose = attachRecording(source, (input) => {
      if (input.kind === 'down') source.apply([{ kind: 'capture', pointerId: input.id }])
    })

    events.pointerDown({ x: 10, y: 10 }, { pointerId: 8 })
    events.lostPointerCapture(8)

    expect(received.map((input) => input.kind === 'cancel' ? input.reason : input.kind)).toEqual(['down', 'lost-capture'])
    dispose()
  })

  it('detach releases every capture the source holds, before its own loss can reach a sink', () => {
    events.dispose()
    events = createSceneInteractionEventHarness(host, { pointerCapture: { synchronousLossOnRelease: true } })
    const source = createDomInputSource(deps())
    const dispose = attachRecording(source, (input) => {
      if (input.kind === 'down') source.apply([{ kind: 'capture', pointerId: input.id }])
    })

    events.pointerDown({ x: 10, y: 10 }, { pointerId: 5 })
    events.pointerDown({ x: 20, y: 20 }, { pointerId: 6 })
    source.apply([{ kind: 'release-capture', pointerId: 6 }])
    expect(events.pointerCapture.has(5)).toBe(true)
    dispose()

    expect(events.pointerCapture.releaseCalls.mock.calls).toEqual([[6], [5]])
    expect(events.pointerCapture.has(5)).toBe(false)
    expect(received.map((input) => input.kind)).toEqual(['down', 'down'])
  })

  it('schedules a deadline from the last input\'s time and delivers its tick at the deadline (A1: base-free)', () => {
    let fire: (() => void) | null = null
    const timers = { set: vi.fn((_delayMs: number, callback: () => void) => { fire = callback; return 7 }), clear: vi.fn() }
    const source = createDomInputSource(deps({ timers }))
    // Event times on a base far from Date.now(), as a browser's performance-based timeStamp is.
    const dispose = attachRecording(source, (input) => {
      if (input.kind === 'down') source.apply([{ kind: 'set-timer', atMs: input.t + 400 }, { kind: 'set-timer', atMs: input.t + 500 }])
    })

    events.pointerDown({ x: 10, y: 10 }, { pointerType: 'touch', timeStamp: 1234 })
    expect(timers.clear).toHaveBeenCalledWith(7)
    expect(timers.set).toHaveBeenLastCalledWith(500, expect.any(Function))
    fire!()
    source.apply([{ kind: 'clear-timer' }])

    expect(received.map((input) => input.kind === 'tick' ? input : input.kind)).toEqual(['down', { kind: 'tick', t: 1734 }])
    dispose()
  })

  it('gesture listeners attach only on WebKit, copy the rotation, prevent the default and detach', () => {
    const MAC_WEBKIT = { os: 'mac', gestureEvents: true } as const
    const GESTURE_TYPES = ['gesturestart', 'gesturechange', 'gestureend']
    const gestureListeners = (spy: { mock: { calls: unknown[][] } }) =>
      listenerCalls(spy).map(([type]) => type).filter((type) => GESTURE_TYPES.includes(type))
    const elsewhere = vi.spyOn(host, 'addEventListener')
    createDomInputSource(deps({ platform: PLATFORM })).attach(() => {})()
    expect(gestureListeners(elsewhere)).toEqual([])
    elsewhere.mockRestore()

    const add = vi.spyOn(host, 'addEventListener')
    const remove = vi.spyOn(host, 'removeEventListener')
    let state = initialRecogniserState()
    const config: RecogniserConfig = { ...RECOGNISER_CONFIG, platform: MAC_WEBKIT }
    const source = createDomInputSource(deps({ platform: MAC_WEBKIT }))
    const dispose = attachRecording(source, (input) => {
      const result = recognise(state, input, config)
      state = result.state
      source.apply(result.effects)
    })
    expect(gestureListeners(add)).toEqual(GESTURE_TYPES)
    const dispatch = (type: string, rotation: number): Event => {
      // jsdom has no GestureEvent: WebKit's carries the pointer's client point, scale and rotation (degrees, clockwise).
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, {
        clientX: { value: 210 }, clientY: { value: 170 }, scale: { value: 1.3 }, rotation: { value: rotation },
        shiftKey: { value: false }, ctrlKey: { value: false }, altKey: { value: false }, metaKey: { value: false },
      })
      host.dispatchEvent(event)
      return event
    }
    const events = [dispatch('gesturestart', 0), dispatch('gesturechange', 12.5), dispatch('gestureend', 12.5)]

    // The scale is never read: the pinch zooms through WebKit's Ctrl wheels.
    expect(received).toEqual([
      { kind: 'platform-gesture', t: expect.any(Number), phase: 'start', at: { x: 200, y: 150 }, rotationDeg: 0 },
      { kind: 'platform-gesture', t: expect.any(Number), phase: 'change', at: { x: 200, y: 150 }, rotationDeg: 12.5 },
      { kind: 'platform-gesture', t: expect.any(Number), phase: 'end', at: { x: 200, y: 150 }, rotationDeg: 12.5 },
    ])
    expect(events.map((event) => event.defaultPrevented)).toEqual([true, true, true])
    dispose()
    expect(gestureListeners(remove)).toEqual(GESTURE_TYPES)
    dispatch('gesturechange', 20)
    expect(received).toHaveLength(3)
    add.mockRestore()
    remove.mockRestore()
  })

  it('a twist that starts over the text entry or owned chrome is prevented and never delivered; over the map it turns the view, the entry open or not (P31)', () => {
    const MAC_WEBKIT = { os: 'mac', gestureEvents: true } as const
    const config: RecogniserConfig = { ...RECOGNISER_CONFIG, platform: MAC_WEBKIT }
    let state = initialRecogniserState()
    const turns: number[] = []
    const source = createDomInputSource(deps({ platform: MAC_WEBKIT }))
    const dispose = attachRecording(source, (input) => {
      const result = recognise(state, input, config)
      state = result.state
      source.apply(result.effects)
      for (const gesture of result.gestures) if (gesture.kind === 'rotate') turns.push(gesture.totalDeltaDeg)
    })
    const dispatch = (target: Element, type: string, rotation: number): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, {
        clientX: { value: 210 }, clientY: { value: 170 }, scale: { value: 1 }, rotation: { value: rotation },
        shiftKey: { value: false }, ctrlKey: { value: false }, altKey: { value: false }, metaKey: { value: false },
      })
      target.dispatchEvent(event)
      return event
    }
    const twist = (target: Element): Event[] =>
      [dispatch(target, 'gesturestart', 0), dispatch(target, 'gesturechange', 30), dispatch(target, 'gestureend', 30)]
    const surface = document.createElement('canvas')
    const chrome = document.createElement('div')
    chrome.setAttribute('data-canvas-chrome', '')
    const entry = document.createElement('textarea')
    entry.setAttribute('data-canvas-text-entry', 'create')
    host.append(surface, chrome, entry)

    // Over the entry and over owned chrome: the page never zooms or turns, and nothing reaches the recogniser.
    const ignored = [...twist(entry), ...twist(chrome)]
    expect(received).toEqual([])
    expect(turns).toEqual([])
    expect(ignored.every((event) => event.defaultPrevented)).toBe(true)

    // Over the map the view turns with the entry open (the entry follows its note), and after it closes.
    twist(surface)
    entry.remove()
    twist(surface)
    expect(received.map((input) => input.kind)).toEqual(Array(6).fill('platform-gesture'))
    expect(turns).toEqual([0, -20, -20, 0, -20, -20])
    dispose()
  })

  it('the map host has touch-action none and no callout while attached (A13)', () => {
    const before = host.getAttribute('style')
    const setProperty = vi.spyOn(host.style, 'setProperty')
    const removeProperty = vi.spyOn(host.style, 'removeProperty')
    const source = createDomInputSource(deps())
    const dispose = attachRecording(source, (input) => {
      if (input.kind === 'down') source.apply([{ kind: 'prevent-default' }, { kind: 'capture', pointerId: input.id }])
      if (input.kind === 'up') source.apply([{ kind: 'release-capture', pointerId: input.id }])
    })
    // The browser neither scrolls, zooms nor pulls the page under a finger on the map, and shows no callout there (WebKit).
    expect(host.style.touchAction).toBe('none')
    expect(setProperty).toHaveBeenCalledWith('-webkit-touch-callout', 'none')
    const attached = host.getAttribute('style')
    events.pointerDown({ x: 10, y: 10 })
    events.pointerMove({ x: 20, y: 10 }, { buttons: 1 })
    events.pointerUp({ x: 20, y: 10 })
    events.wheel({ x: 20, y: 10 }, { deltaY: 5 })
    expect(host.getAttribute('style')).toBe(attached)
    dispose()
    expect(host.getAttribute('style')).toBe(before)
    expect(removeProperty).toHaveBeenCalledWith('-webkit-touch-callout')
    setProperty.mockRestore()
    removeProperty.mockRestore()
  })

  describe('touch (spec §2.2 "Touch" and "Long press")', () => {
    /** Event times on a base far from Date.now(), as a browser's performance-based timeStamp is (A1). */
    const BASE = 5_000_000

    function touch(type: 'pointerdown' | 'pointerup', target: EventTarget, timeStamp: number): PointerEvent {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 60, clientY: 70, button: 0, buttons: type === 'pointerdown' ? 1 : 0 })
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'touch' }, timeStamp: { value: timeStamp } })
      target.dispatchEvent(event)
      return event as PointerEvent
    }

    /** The real recogniser behind the source, with real timers (faked by vitest). */
    function attachRecogniser(): { readonly gestures: Gesture[]; readonly dispose: () => void } {
      const gestures: Gesture[] = []
      let state = initialRecogniserState()
      const source = createDomInputSource(deps({
        timers: { set: (delayMs, callback) => window.setTimeout(callback, delayMs), clear: (id) => window.clearTimeout(id) },
      }))
      const dispose = attachRecording(source, (input) => {
        const result = recognise(state, input, RECOGNISER_CONFIG)
        state = result.state
        gestures.push(...result.gestures)
        source.apply(result.effects)
      })
      return { gestures, dispose }
    }

    afterEach(() => {
      vi.useRealTimers()
    })

    it('a 100 ms touch tap opens no menu; a 600 ms hold opens one, and its lift reaches nothing else (A1, A4)', () => {
      vi.useFakeTimers()
      const { gestures, dispose } = attachRecogniser()
      const lifts: Event[] = []
      const onLift = (event: Event): void => {
        lifts.push(event)
      }
      document.addEventListener('pointerup', onLift)

      touch('pointerdown', host, BASE)
      vi.advanceTimersByTime(100)
      touch('pointerup', host, BASE + 100)
      vi.advanceTimersByTime(600)
      expect(gestures.map((gesture) => gesture.kind)).toEqual(['press', 'tap'])
      expect(lifts).toHaveLength(1)

      touch('pointerdown', host, BASE + 1000)
      vi.advanceTimersByTime(499)
      expect(gestures.map((gesture) => gesture.kind)).toEqual(['press', 'tap'])
      vi.advanceTimersByTime(1)
      expect(gestures.at(-1)).toEqual({ kind: 'menu-request', at: { x: 50, y: 50 }, source: 'long-press' })
      vi.advanceTimersByTime(100)
      // The lift emits nothing and never reaches the page, so the open menu's outside-press close cannot hear it.
      const lift = touch('pointerup', host, BASE + 1600)
      expect(gestures).toHaveLength(3)
      expect(lift.defaultPrevented).toBe(true)
      expect(lifts).toHaveLength(1)

      document.removeEventListener('pointerup', onLift)
      dispose()
    })

    it('a long press in the note editor opens no canvas menu', () => {
      vi.useFakeTimers()
      const editor = document.createElement('textarea')
      editor.setAttribute('data-canvas-text-entry', 'create')
      host.append(editor)
      const { gestures, dispose } = attachRecogniser()

      touch('pointerdown', editor, BASE)
      vi.advanceTimersByTime(600)
      touch('pointerup', editor, BASE + 600)

      expect(gestures).toEqual([])
      dispose()
    })

    it('the click that trails a finger\'s lift from the map is swallowed wherever it lands, once; a new press, a keyboard click and a tap on chrome keep theirs', () => {
      vi.useFakeTimers()
      const { dispose } = attachRecogniser()
      // Chrome that appears under the finger at the lift (a tap that finishes a zone brings up its chip there).
      const chrome = document.createElement('button')
      document.body.append(chrome)
      const clicks = vi.fn()
      chrome.addEventListener('click', clicks)
      const click = (detail: number): MouseEvent => {
        const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail })
        chrome.dispatchEvent(event)
        return event
      }

      touch('pointerdown', host, BASE)
      touch('pointerup', host, BASE + 80)
      // A keyboard or assistive click (detail 0) is not the tap's.
      click(0)
      expect(clicks).toHaveBeenCalledTimes(1)
      const ghost = click(1)
      expect(ghost.defaultPrevented).toBe(true)
      expect(clicks).toHaveBeenCalledTimes(1)
      click(1)
      expect(clicks).toHaveBeenCalledTimes(2)

      // A long press's lift, after its menu opened.
      touch('pointerdown', host, BASE + 1000)
      vi.advanceTimersByTime(600)
      touch('pointerup', host, BASE + 1700)
      click(1)
      expect(clicks).toHaveBeenCalledTimes(2)

      // A new press owns the click that follows it.
      touch('pointerdown', host, BASE + 3000)
      touch('pointerup', host, BASE + 3080)
      events.pointerDown({ x: 10, y: 10 }, { target: chrome, pointerType: 'mouse' })
      click(1)
      expect(clicks).toHaveBeenCalledTimes(3)

      // A click that never came leaves nothing armed.
      touch('pointerdown', host, BASE + 5000)
      touch('pointerup', host, BASE + 5080)
      vi.advanceTimersByTime(1000)
      click(1)
      expect(clicks).toHaveBeenCalledTimes(4)

      // A finger's tap on the map's own chrome is that chrome's click.
      const zoom = document.createElement('button')
      host.append(zoom)
      touch('pointerdown', zoom, BASE + 7000)
      touch('pointerup', zoom, BASE + 7080)
      click(1)
      expect(clicks).toHaveBeenCalledTimes(5)
      dispose()
    })

    it('a touch press\'s contextmenu is prevented', () => {
      const { dispose } = attachRecogniser()
      touch('pointerdown', host, BASE)
      // Android sends its own contextmenu during a held press, wherever the finger is.
      const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 60, clientY: 70 })
      document.documentElement.dispatchEvent(menu)
      expect(menu.defaultPrevented).toBe(true)
      dispose()
    })
  })

  it('rejects a second attach while attached', () => {
    const source = createDomInputSource(deps())
    const dispose = source.attach(() => {})
    expect(() => source.attach(() => {})).toThrow('already attached')
    dispose()
    source.attach(() => {})()
  })
})
