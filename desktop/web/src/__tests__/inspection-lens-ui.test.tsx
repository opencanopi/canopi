// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import type { CanvasInspectionHandle, InspectionSourceQuad } from '../canvas/inspection'
import { setCurrentCanvasSession } from '../canvas/session'
import { InspectionLens } from '../components/canvas/InspectionLens'
import { createTestCanvasDocumentSurface, createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { SceneCanvasInspectionOwner } from '../canvas/runtime/inspection-lens'
import { createSessionPlane } from '../canvas/session-plane'
import { createTestSceneRendererSnapshot } from './support/scene-renderer-snapshot'
import { createTestView } from './support/test-view'

const root = document.createElement('div')
afterEach(() => { render(null, root); setCurrentCanvasSession(null); root.remove() })

it('opens the optional lens, identifies plants and releases the view on Escape', async () => {
  document.body.appendChild(root)
  const view: CanvasInspectionHandle = {
    state: signal({ point: { x: 0, y: 0 }, scale: 10, zoomPercent: 700, previewAvailable: true, frame: { width: 430, height: 390 },
      plants: [{ id: 'mint', name: 'Menthe verte',
        screenPosition: { x: 215, y: 195 }, label: { x: 160, y: 208, width: 110, height: 24, lines: ['Menthe verte'] } }] }),
    // Today's rect at the identity main view: the 430 x 390 px preview at 10 px/m is 43 x 39 m about the origin.
    sourceQuad: signal<InspectionSourceQuad | null>([{ x: -21.5, y: -19.5 }, { x: 21.5, y: -19.5 }, { x: 21.5, y: 19.5 }, { x: -21.5, y: 19.5 }]),
    inspectAtScreenPoint: vi.fn(), inspectAtWorldPoint: vi.fn(), centerOnCanvas: vi.fn(), panByScreen: vi.fn(), zoomBy: vi.fn(), highlightPlant: vi.fn(), focusPlant: vi.fn(), dispose: vi.fn(),
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  host.getBoundingClientRect = () => new DOMRect(40, 60, 800, 600)
  const attachInspectionTo = vi.fn(() => view)
  // The interaction session publishes the pointer's world and screen points over the map (ToolHost.subscribePointerWorld).
  const queries = createTestCanvasQuerySurface()
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries, documents: createTestCanvasDocumentSurface({ attachInspectionTo }) }))
  await act(async () => render(<InspectionLens canvasRef={{ current: host }} />, root))
  const launcher = root.querySelector<HTMLButtonElement>('button[aria-expanded]')
  expect(launcher).not.toBeNull()
  await act(async () => launcher!.click())
  expect(root.textContent).toContain('Menthe verte')
  // The name sits on its label box, in px (Preact 11 adds no unit to a number).
  const nameBox = document.querySelector<HTMLElement>('button[data-plant-id="mint"]')!
  expect([nameBox.style.left, nameBox.style.top, nameBox.style.width, nameBox.style.height]).toEqual(['160px', '208px', '110px', '24px'])
  expect(root.textContent).not.toContain('Hold view')
  expect(root.textContent).not.toContain('Follow pointer')
  await act(async () => { queries.emitPointerWorld({ world: { x: 100, y: 100 }, screen: { x: 300, y: 250 }, pointerKind: 'mouse' }) })
  expect(view.inspectAtWorldPoint).toHaveBeenLastCalledWith({ x: 100, y: 100 })
  // Leaving the map (or moving over the canvas's own buttons, which publish nothing) keeps the lens where it is.
  queries.emitPointerWorld(null)
  expect(view.inspectAtWorldPoint).toHaveBeenCalledTimes(1)
  expect(view.inspectAtScreenPoint).not.toHaveBeenCalled()
  expect(view.panByScreen).not.toHaveBeenCalled()
  expect(view.centerOnCanvas).not.toHaveBeenCalled()
  expect(host.querySelector('[data-inspection-source] polygon')?.getAttribute('points')).toBe('-21.5,-19.5 21.5,-19.5 21.5,19.5 -21.5,19.5')
  const frame = root.querySelector<HTMLElement>('[data-inspection-frame]')!
  await act(async () => { frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
  expect(view.panByScreen).toHaveBeenCalledWith({ x: 20, y: 0 })
  const pointer = (target: EventTarget, type: string, x: number) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 0 })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    target.dispatchEvent(event)
  }
  await act(async () => { pointer(frame, 'pointerdown', 100); pointer(document, 'pointermove', 80) })
  expect(view.panByScreen).toHaveBeenLastCalledWith({ x: 20, y: 0 })
  // While the lens's own view is dragged, the map pointer does not move it.
  queries.emitPointerWorld({ world: { x: 7, y: 7 }, screen: { x: 207, y: 157 }, pointerKind: 'mouse' })
  expect(view.inspectAtWorldPoint).toHaveBeenCalledTimes(1)
  const calls = vi.mocked(view.panByScreen).mock.calls.length
  await act(async () => { window.dispatchEvent(new Event('blur')); pointer(document, 'pointermove', 60) })
  expect(view.panByScreen).toHaveBeenCalledTimes(calls)
  expect(calls).toBe(2)
  for (const terminal of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    await act(async () => {
      pointer(frame, 'pointerdown', 100)
      pointer(terminal === 'lostpointercapture' ? frame : document, terminal, 100)
      pointer(document, 'pointermove', 60)
    })
    expect(view.panByScreen).toHaveBeenCalledTimes(calls)
  }
  await act(async () => root.querySelector<HTMLButtonElement>('[aria-label="Centre on canvas view"]')!.click())
  expect(view.centerOnCanvas).toHaveBeenCalledTimes(1)
  expect(attachInspectionTo).toHaveBeenCalledTimes(1)
  const expand = root.querySelector<HTMLButtonElement>('button[aria-label="Expand lens"]')!
  expect(expand).not.toBeNull()
  await act(async () => expand.click())
  expect(root.querySelector('[data-expanded="true"]')).not.toBeNull()
  expect(attachInspectionTo).toHaveBeenCalledTimes(1)
  const name = root.querySelector<HTMLButtonElement>('button[data-plant-id="mint"]')!
  expect(root.querySelector('[data-inspection-frame]')?.contains(name)).toBe(true)
  expect(root.querySelector('ol')).toBeNull()
  expect(name.style.left).toBe('160px')
  expect(root.querySelector('[data-inspection-frame] line')?.getAttribute('x1')).toBe('215')
  await act(async () => name.click())
  expect(view.focusPlant).toHaveBeenCalledWith('mint')
  await act(async () => { pointer(frame, 'pointerdown', 100) })
  await act(async () => { name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  pointer(document, 'pointermove', 50)
  expect(view.panByScreen).toHaveBeenCalledTimes(calls)
  expect(view.dispose).toHaveBeenCalledTimes(1)
  expect(host.querySelector('[data-inspection-source]')).toBeNull()
  queries.emitPointerWorld({ world: { x: 200, y: 0 }, screen: { x: 400, y: 150 }, pointerKind: 'mouse' })
  expect(view.inspectAtWorldPoint).toHaveBeenCalledTimes(1)
  host.remove()
  expect(root.querySelector('button[aria-expanded="false"]')).not.toBeNull()
  expect(document.activeElement).toBe(launcher)
})

it("draws the source outline from the lens handle's sourceQuad", async () => {
  document.body.appendChild(root)
  const sourceQuad = signal<InspectionSourceQuad | null>(null)
  const view: CanvasInspectionHandle = {
    state: signal({ point: { x: 0, y: 0 }, scale: 10, zoomPercent: 700, previewAvailable: true, frame: { width: 430, height: 390 }, plants: [] }),
    sourceQuad,
    inspectAtScreenPoint: vi.fn(), inspectAtWorldPoint: vi.fn(), centerOnCanvas: vi.fn(), panByScreen: vi.fn(), zoomBy: vi.fn(), highlightPlant: vi.fn(), focusPlant: vi.fn(), dispose: vi.fn(),
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
    queries: createTestCanvasQuerySurface(),
    documents: createTestCanvasDocumentSurface({ attachInspectionTo: vi.fn(() => view) }),
  }))
  await act(async () => render(<InspectionLens canvasRef={{ current: host }} />, root))
  await act(async () => root.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
  const outline = () => host.querySelector('[data-inspection-source] polygon')

  // No footprint yet: nothing is drawn on the map.
  expect(outline()).toBeNull()

  // The four corners as published, in order; at bearing 0 they are the bounding rectangle's.
  await act(async () => { sourceQuad.value = [{ x: 100, y: 50 }, { x: 143, y: 50 }, { x: 143, y: 89 }, { x: 100, y: 89 }] })
  expect(outline()?.getAttribute('points')).toBe('100,50 143,50 143,89 100,89')

  // A main-map frame moves the outline with no lens repaint, and a turned quad draws as published.
  await act(async () => { sourceQuad.value = [{ x: 120, y: 40 }, { x: 160, y: 60 }, { x: 140, y: 100 }, { x: 100, y: 80 }] })
  expect(outline()?.getAttribute('points')).toBe('120,40 160,60 140,100 100,80')

  await act(async () => { sourceQuad.value = null })
  expect(outline()).toBeNull()
  host.remove()
})

it('arrows move the lens along the screen; mod is the large step', async () => {
  document.body.appendChild(root)
  const view: CanvasInspectionHandle = {
    state: signal({ point: { x: 0, y: 0 }, scale: 10, zoomPercent: 700, previewAvailable: true, frame: { width: 430, height: 390 }, plants: [] }),
    sourceQuad: signal<InspectionSourceQuad | null>(null),
    inspectAtScreenPoint: vi.fn(), inspectAtWorldPoint: vi.fn(), centerOnCanvas: vi.fn(), panByScreen: vi.fn(), zoomBy: vi.fn(), highlightPlant: vi.fn(), focusPlant: vi.fn(), dispose: vi.fn(),
  }
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
    queries: createTestCanvasQuerySurface(),
    documents: createTestCanvasDocumentSurface({ attachInspectionTo: vi.fn(() => view) }),
  }))
  await act(async () => render(<InspectionLens canvasRef={{ current: document.createElement('div') }} />, root))
  await act(async () => root.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
  const frame = root.querySelector<HTMLElement>('[data-inspection-frame]')!
  // The preview owns its arrows, Shift+arrows included: the key router leaves them to it (spec §1.6, fixture H19).
  expect(frame.getAttribute('data-owns-keys')).toBe('arrows')
  expect(frame.getAttribute('aria-label')).toBe('Inspection preview. Drag or use arrow keys to explore; Ctrl moves farther.')
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    act(() => { frame.dispatchEvent(event) })
    return event
  }

  // Screen directions in lens pixels: the lens turns with the map, so up on screen is up in the lens.
  expect(press('ArrowUp').defaultPrevented).toBe(true)
  expect(view.panByScreen).toHaveBeenLastCalledWith({ x: 0, y: -20 })
  press('ArrowLeft')
  expect(view.panByScreen).toHaveBeenLastCalledWith({ x: -20, y: 0 })
  press('ArrowRight', { ctrlKey: true })
  expect(view.panByScreen).toHaveBeenLastCalledWith({ x: 60, y: 0 })
  // Shift is no longer the large step: Shift+arrow moves by the plain step.
  press('ArrowDown', { shiftKey: true })
  expect(view.panByScreen).toHaveBeenLastCalledWith({ x: 0, y: 20 })
  expect(view.panByScreen).toHaveBeenCalledTimes(4)
})

it('a drag on the preview pans the lens, through the real lens owner', async () => {
  vi.useFakeTimers()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  document.body.appendChild(root)
  const camera = createTestView({ screen: { width: 800, height: 600 }, viewport: { x: 100, y: 0, scale: 6 } })
  const owner = new SceneCanvasInspectionOwner({ frames: camera.frames, revision: { scene: signal(0), plantNames: signal(0), transientHistory: signal(0) },
    readSessionPlane: () => createSessionPlane({ lon: 0, lat: 0 }),
    getSnapshot: () => createTestSceneRendererSnapshot(), setHoveredTarget() {} })
  let view: CanvasInspectionHandle | null = null
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
    queries: createTestCanvasQuerySurface(),
    documents: createTestCanvasDocumentSurface({ attachInspectionTo: (container: HTMLElement) => (view = owner.mount(container)) }),
  }))
  await act(async () => render(<InspectionLens canvasRef={{ current: document.createElement('div') }} />, root))
  await act(async () => root.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
  const frame = root.querySelector<HTMLElement>('[data-inspection-frame]')!
  // Before the first paint an arrow moves nothing and throws nothing.
  act(() => { frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
  await act(async () => { vi.advanceTimersByTime(20) })
  const before = view!.state.value!.point
  const scale = view!.state.value!.scale
  const pointer = (target: EventTarget, type: string, x: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 0 })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    target.dispatchEvent(event)
  }
  await act(async () => { pointer(frame, 'pointerdown', 100); pointer(document, 'pointermove', 70); vi.advanceTimersByTime(20) })
  // Dragging 30 px right moves the inspected ground 30 px left of the lens's screen at bearing 0.
  expect(view!.state.value!.point.x).toBeCloseTo(before.x + 30 / scale, 9)
  expect(view!.state.value!.point.y).toBeCloseTo(before.y, 9)
  await act(async () => { pointer(document, 'pointerup', 70) })
  owner.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('marks the inspected point with a crosshair at the preview centre, never announces the names count, and gives touch its hint (canopi-n54g)', async () => {
  document.body.appendChild(root)
  const state = signal({ point: { x: 0, y: 0 }, scale: 10, zoomPercent: 700, previewAvailable: true, frame: { width: 430, height: 390 },
    plants: [{ id: 'mint', name: 'Menthe verte', screenPosition: { x: 215, y: 195 }, label: { x: 160, y: 208, width: 110, height: 24, lines: ['Menthe verte'] } }] })
  const view: CanvasInspectionHandle = {
    state, sourceQuad: signal<InspectionSourceQuad | null>(null),
    inspectAtScreenPoint: vi.fn(), inspectAtWorldPoint: vi.fn(), centerOnCanvas: vi.fn(), panByScreen: vi.fn(), zoomBy: vi.fn(), highlightPlant: vi.fn(), focusPlant: vi.fn(), dispose: vi.fn(),
  }
  const coarse = { value: false }
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)' && coarse.value, media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
    queries: createTestCanvasQuerySurface(),
    documents: createTestCanvasDocumentSurface({ attachInspectionTo: vi.fn(() => view) }),
  }))
  try {
    await act(async () => render(<InspectionLens canvasRef={{ current: host }} />, root))
    await act(async () => root.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
    const centre = () => root.querySelector<SVGGElement>('[data-inspection-frame] [data-inspection-centre]')
    expect(centre()).not.toBeNull()
    expect(centre()!.getAttribute('transform')).toBe('translate(215 195)')
    // Hollow: four arms, none reaching the centre point.
    const arms = Array.from(centre()!.querySelectorAll('path')).map((path) => path.getAttribute('d'))
    expect(arms.length).toBeGreaterThan(0)
    for (const d of arms) expect(d).not.toMatch(/[ML]0 0\b/)
    // The mark follows the preview's size, and stays when no plant is in view.
    await act(async () => { state.value = { ...state.value, frame: { width: 620, height: 480 }, plants: [] } })
    expect(centre()!.getAttribute('transform')).toBe('translate(310 240)')

    const count = Array.from(root.querySelectorAll('span')).find((span) => span.textContent === 'Names 0 / 0')!
    expect(count).not.toBeUndefined()
    expect(count.closest('[role="status"], [aria-live="polite"], [aria-live="assertive"]'), 'the count is read on demand, not on every move').toBeNull()
    expect(root.textContent).toContain('Move over canvas to inspect · Drag here to explore')
  } finally {
    render(null, root)
  }
  coarse.value = true
  try {
    await act(async () => render(<InspectionLens canvasRef={{ current: host }} />, root))
    await act(async () => root.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
    expect(root.textContent).toContain('Tap the map to inspect · Drag here to explore')
    expect(root.textContent).not.toContain('Move over canvas to inspect')
  } finally {
    vi.unstubAllGlobals()
    host.remove()
  }
})
