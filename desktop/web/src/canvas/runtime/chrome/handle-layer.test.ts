// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestView, type TestView } from '../../../__tests__/support/test-view'
import type { ToolHandleId } from '../interaction-types'
import type { ToolHandle } from '../tools/draft'
import type { ScreenInsets, ViewFrameSource } from '../../../geo/view/types'
import { CANVAS_CHROME_FONT_FAMILY } from '../../chrome-fonts'
import { createHandleLayer, type HandleLayer } from './handle-layer'
import { expectScreenPx } from '../../../__tests__/support/camera-tolerance'

const id = (value: string) => value as ToolHandleId

const VERTEX: ToolHandle = {
  id: id('vertex:zone-1:2'),
  anchor: { x: 10, y: 20 },
  hitRadiusPx: 10,
  glyph: 'vertex',
  label: 'Zone control point 3',
}
const CORNER: ToolHandle = {
  id: id('rect-corner:zone-1:ne'),
  anchor: { x: 40, y: 20 },
  hitRadiusPx: 10,
  glyph: 'corner',
  label: 'Zone control point 2',
}
const ROTATE: ToolHandle = {
  id: id('rotate'),
  anchor: { x: 100, y: 50 },
  offsetPx: { x: 0, y: -28 },
  hitRadiusPx: 14,
  glyph: 'rotate',
  label: 'Rotate selection',
}

const MIDPOINT: ToolHandle = {
  id: id('edge-mid:zone-1:0'),
  anchor: { x: 25, y: 20 },
  hitRadiusPx: 8,
  glyph: 'midpoint',
  label: 'Add a corner on edge 1',
}

let container: HTMLDivElement
let view: TestView
let layer: HandleLayer | null = null

function mount(insets?: ScreenInsets): HandleLayer {
  container = document.createElement('div')
  document.body.appendChild(container)
  view = createTestView({ viewport: { x: 5, y: 7, scale: 2 }, insets })
  layer = createHandleLayer({ container, frames: view.frames })
  return layer
}

function handle(handleId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-canvas-handle="${handleId}"]`)
}

afterEach(() => {
  layer?.dispose()
  layer = null
  view?.dispose()
  container?.remove()
})

describe('the handle layer', () => {
  it('draws each handle at its projected anchor with its id, glyph, label and today\'s hit box', () => {
    mount().setHandles([VERTEX, CORNER], null)

    const vertex = handle('vertex:zone-1:2')!
    expect(vertex.dataset.canvasHandleGlyph).toBe('vertex')
    expect(vertex.getAttribute('role')).toBe('button')
    expect(vertex.getAttribute('aria-label')).toBe('Zone control point 3')
    expectScreenPx(vertex.dataset.canvasHandleScreenX, 25)
    expectScreenPx(vertex.dataset.canvasHandleScreenY, 47)
    expectScreenPx(vertex.style.left, 15)
    expectScreenPx(vertex.style.top, 37)
    expect(vertex.style.width).toBe('20px')
    expect(vertex.style.height).toBe('20px')
    expect(vertex.style.zIndex).toBe('29')
    const mark = vertex.firstElementChild as HTMLElement
    expect(mark.style.width).toBe('8px')
    expect(mark.style.background).toBe('var(--color-primary)')
    expectScreenPx(handle('rect-corner:zone-1:ne')!.style.left, 75)
  })

  it('draws the rotate handle as today\'s 28 px button centred on its offset anchor', () => {
    mount().setHandles([ROTATE], null)

    const rotate = handle('rotate')!
    expect(rotate.getAttribute('role')).toBe('button')
    expect(rotate.tabIndex).toBe(-1)
    expect(rotate.getAttribute('aria-label')).toBe('Rotate selection')
    expect(rotate.style.width).toBe('28px')
    expect(rotate.style.zIndex).toBe('27')
    // (100, 50) is (205, 107) on screen; 28 px above is the button's centre.
    expectScreenPx(rotate.style.left, 191)
    expectScreenPx(rotate.style.top, 65)
    expect(rotate.querySelector('svg')).not.toBeNull()
  })

  it('a touch-sized rotate handle keeps its 28 px button, centred in a transparent 44 px box (Q4)', () => {
    mount().setHandles([{ ...ROTATE, hitRadiusPx: 22, readout: '+15°' }], id('rotate'))

    const rotate = handle('rotate')!
    expect(rotate.style.width).toBe('44px')
    expect(rotate.style.height).toBe('44px')
    expect(rotate.style.background).toBe('transparent')
    // The same centre: 28 px above (205, 107).
    expectScreenPx(rotate.style.left, 183)
    expectScreenPx(rotate.style.top, 57)
    const button = rotate.firstElementChild as HTMLElement
    expect(button.style.width).toBe('28px')
    expect(button.style.height).toBe('28px')
    expect(button.style.background).toBe('var(--color-primary)')
    expect(button.querySelector('svg')).not.toBeNull()
    // The readout hangs under the button, not under the box.
    expect(button.querySelector('[data-canvas-handle-readout]')?.textContent).toBe('+15°')
  })

  it('keeps the rotate handle inside the visible map area, as today', () => {
    mount({ top: 40, right: 0, bottom: 0, left: 60 }).setHandles([{ ...ROTATE, anchor: { x: 0, y: 0 } }], null)

    const rotate = handle('rotate')!
    expectScreenPx(rotate.style.left, 68)
    expectScreenPx(rotate.style.top, 48)
  })

  it('marks the active handle and shows its readout', () => {
    const handles = mount()
    handles.setHandles([{ ...ROTATE, readout: '+15°' }, VERTEX], id('rotate'))

    const rotate = handle('rotate')!
    const readout = rotate.querySelector<HTMLElement>('[data-canvas-handle-readout]')!
    expect(rotate.dataset.canvasHandleActive).toBe('true')
    expect(rotate.style.cursor).toBe('grabbing')
    expect(readout.textContent).toBe('+15°')
    expect(readout.style.display).toBe('inline-flex')
    // The readout is a canvas chip like the measure chips: Source Sans 3, whose digits are tabular (probe P-E1).
    expect(readout.style.fontFamily.replace(/"/g, "'")).toBe(CANVAS_CHROME_FONT_FAMILY)
    expect(readout.style.fontWeight).toBe('600')
    expect(handle('vertex:zone-1:2')!.dataset.canvasHandleActive).toBeUndefined()

    handles.setHandles([ROTATE, VERTEX], null)
    expect(rotate.dataset.canvasHandleActive).toBeUndefined()
    expect(rotate.style.cursor).toBe('grab')
    expect(readout.style.display).toBe('none')
  })

  it('keeps a handle\'s element while its id stays and drops the handles that go', () => {
    const handles = mount()
    handles.setHandles([VERTEX, ROTATE], null)
    const vertex = handle('vertex:zone-1:2')!
    const rotate = handle('rotate')!

    handles.setHandles([{ ...VERTEX, anchor: { x: 20, y: 20 }, label: 'Moved' }], null)

    expect(handle('vertex:zone-1:2')).toBe(vertex)
    expectScreenPx(vertex.style.left, 35)
    expect(vertex.getAttribute('aria-label')).toBe('Moved')
    expect(rotate.isConnected).toBe(false)
    expect(handle('rotate')).toBeNull()
  })

  it('follows the camera frame', () => {
    mount().setHandles([VERTEX], null)

    view.setViewport({ x: 0, y: 0, scale: 1 })

    const vertex = handle('vertex:zone-1:2')!
    expectScreenPx(vertex.style.left, 0)
    expectScreenPx(vertex.style.top, 10)
    expectScreenPx(vertex.dataset.canvasHandleScreenX, 10)
  })

  it('a frame moves handles and creates no element', () => {
    mount().setHandles([VERTEX, ROTATE], null)
    const root = container.querySelector<HTMLElement>('[data-canvas-handle-layer]')!
    const elements = [...root.querySelectorAll('*')]
    const created = vi.spyOn(document, 'createElement')
    const createdNs = vi.spyOn(document, 'createElementNS')
    const added = vi.fn()
    const observer = new MutationObserver((records) => added(records.flatMap((record) => [...record.addedNodes])))
    observer.observe(root, { childList: true, subtree: true })

    view.setViewport({ x: 45, y: -13, scale: 2 })
    view.setViewport({ x: 0, y: 0, scale: 1 })

    expectScreenPx(handle('vertex:zone-1:2')!.style.left, 0)
    expectScreenPx(handle('rotate')!.style.left, 86)
    expect([...root.querySelectorAll('*')]).toEqual(elements)
    expect(created).not.toHaveBeenCalled()
    expect(createdNs).not.toHaveBeenCalled()
    observer.takeRecords().forEach((record) => expect(record.addedNodes).toHaveLength(0))
    observer.disconnect()
    expect(added).not.toHaveBeenCalled()
  })

  it('swallows keys and stops clicks on the rotate handle', () => {
    mount().setHandles([ROTATE], null)
    const rotate = handle('rotate')!
    const heard = vi.fn()
    container.addEventListener('keydown', heard)
    container.addEventListener('click', heard)

    const key = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    rotate.dispatchEvent(key)
    rotate.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(key.defaultPrevented).toBe(true)
    expect(heard).not.toHaveBeenCalled()
  })

  it('enlarges a point\'s mark under the pointer', () => {
    mount().setHandles([VERTEX], null)
    const vertex = handle('vertex:zone-1:2')!
    const mark = vertex.firstElementChild as HTMLElement

    vertex.dispatchEvent(new Event('pointerenter'))
    expect(mark.style.transform).toBe('scale(1.35)')
    vertex.dispatchEvent(new Event('pointerleave'))
    expect(mark.style.transform).toBe('')
  })

  it('hides with no handles, and dispose removes it and stops following the camera', () => {
    const handles = mount()
    handles.setHandles([VERTEX], null)
    const root = container.querySelector<HTMLElement>('[data-canvas-handle-layer]')!
    expect(root.style.display).toBe('block')

    handles.setHandles([], null)
    expect(root.style.display).toBe('none')
    expect(root.children).toHaveLength(0)

    handles.setHandles([VERTEX], null)
    const vertex = handle('vertex:zone-1:2')!
    handles.dispose()
    layer = null
    view.setViewport({ x: 0, y: 0, scale: 1 })
    expect(root.isConnected).toBe(false)
    expectScreenPx(vertex.style.left, 15)
  })

  it('removes its root when it cannot follow the camera', () => {
    container = document.createElement('div')
    view = createTestView()
    const frames: ViewFrameSource = {
      ...view.frames,
      onViewFrame: () => {
        expect(container.querySelector('[data-canvas-handle-layer]')).not.toBeNull()
        throw new Error('frame subscription failed')
      },
    }

    expect(() => createHandleLayer({ container, frames })).toThrow('frame subscription failed')

    expect(container.children).toHaveLength(0)
  })

  it("draws a polygon edge's midpoint as a fainter, smaller dot than a corner, out of the tab order", () => {
    mount().setHandles([VERTEX, MIDPOINT], null)
    const dot = handle(MIDPOINT.id)!
    const mark = dot.firstElementChild as HTMLElement
    const cornerMark = handle(VERTEX.id)!.firstElementChild as HTMLElement

    expect(dot.getAttribute('aria-label')).toBe('Add a corner on edge 1')
    expect(dot.dataset.canvasHandleGlyph).toBe('midpoint')
    expect(mark.style.opacity).toBe('0.5')
    expect(mark.style.width).toBe('8px')
    expect(parseFloat(mark.style.borderWidth)).toBeLessThan(parseFloat(cornerMark.style.borderWidth))
    expect(dot.tabIndex).toBe(-1)
  })

  it('draws a midpoint dot under the corners, whatever order the handles come in', () => {
    mount().setHandles([MIDPOINT, VERTEX], null)
    expect(Number(handle(MIDPOINT.id)!.style.zIndex)).toBeLessThan(Number(handle(VERTEX.id)!.style.zIndex))
  })

  it('corners are tabbable, report the focused one and draw the active one filled', () => {
    const drawn = mount()
    drawn.setHandles([VERTEX, CORNER, ROTATE], id('vertex:zone-1:2'))
    expect(handle(VERTEX.id)!.tabIndex).toBe(0)
    expect(handle(CORNER.id)!.tabIndex).toBe(0)
    expect(handle(ROTATE.id)!.tabIndex).toBe(-1)
    expect(drawn.focusedHandle()).toBeNull()

    handle(CORNER.id)!.focus()
    expect(drawn.focusedHandle()).toBe(CORNER.id)

    const active = handle(VERTEX.id)!.firstElementChild as HTMLElement
    const idle = handle(CORNER.id)!.firstElementChild as HTMLElement
    expect(active.style.background).toBe('var(--color-surface)')
    expect(active.style.borderColor).toBe('var(--color-primary)')
    expect(idle.style.background).toBe('var(--color-primary)')
  })
})
