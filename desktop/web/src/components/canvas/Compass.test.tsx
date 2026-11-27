// @vitest-environment jsdom

// The compass (spec §4.2, ADR 0015): always in the zoom group, a click or Enter/Space resets north, a drag on its face
// turns the view about the screen centre with Shift for 15° steps, and Esc during a drag restores the starting camera
// through the real key router (fixture I9).
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceCanvasCommandProjection } from '../../app/workspace-commands/canvas-actions'
import type { KeyRouterHandle } from '../../app/keyboard/key-router'
import { createCanvasKeyboardPort } from '../../canvas/runtime/keyboard-port'
import type { ToolHost } from '../../canvas/runtime/interaction-ports'
import type { CanvasKeyboardPort } from '../../canvas/runtime/runtime'
import { createViewReadSurface } from '../../geo/view/frame-source'
import { setCurrentCanvasSession } from '../../canvas/session'
import { createSessionPlane } from '../../geo/session-plane'
import { createTestCanvasQuerySurface } from '../../__tests__/support/canvas-query-surface'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from '../../__tests__/support/canvas-runtime-surfaces'
import { installCanvasKeyRouter } from '../../__tests__/support/key-router'
import { createTestView, type TestView } from '../../__tests__/support/test-view'
import { Compass } from './Compass'
import { hoveredTooltip } from '../../__tests__/support/tooltip'

/** The compass's centre on screen; its box is a 28 px button about it. */
const CENTRE = { x: 100, y: 100 }

let container: HTMLDivElement
let view: TestView
let router: KeyRouterHandle | null

function mount(bearingDeg: number): void {
  const plane = createSessionPlane({ lon: 0, lat: 0 })
  view = createTestView({ plane, screen: { width: 800, height: 600 }, camera: { bearingDeg } })
  const { navigation } = view
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
    queries: { ...createTestCanvasQuerySurface(), view: createViewReadSurface(view.frames) },
    commands: createTestCanvasCommandSurface({
      viewport: {
        resetNorth: () => navigation.resetNorth(),
        rotateBy: (direction) => navigation.rotateBy(direction),
        beginRotation: (pivot) => navigation.beginRotation(pivot),
      },
    }),
  }))
  const command = workspaceCanvasCommandProjection.value.viewActions.find((action) => action.id === 'reset-north')!
  act(() => { render(<Compass command={command} className="button" />, container) })
  compass().getBoundingClientRect = () => new DOMRect(CENTRE.x - 14, CENTRE.y - 14, 28, 28)
}

const compass = () => container.querySelector<HTMLButtonElement>('button[data-compass]')!
const bearing = () => view.view().camera.bearingDeg
/** The bearing the compass describes itself by: the first node its aria-describedby names (its tooltip's hint follows). */
const description = () => document.getElementById(compass().getAttribute('aria-describedby')?.split(' ')[0] ?? '')?.textContent
const describedBy = () => (compass().getAttribute('aria-describedby') ?? '').split(' ')
  .map((id) => document.getElementById(id)?.textContent).join(' ')

/** The point at `deg` around the compass centre on screen (0 = right, 90 = down: clockwise as the screen turns). */
function around(deg: number, radius = 12): { x: number; y: number } {
  const rad = deg * Math.PI / 180
  return { x: CENTRE.x + radius * Math.cos(rad), y: CENTRE.y + radius * Math.sin(rad) }
}

function pointer(
  target: EventTarget,
  type: string,
  point: { x: number; y: number },
  { pointerType = 'mouse', ...init }: MouseEventInit & { pointerType?: 'mouse' | 'pen' | 'touch' } = {},
): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: point.x, clientY: point.y, ...init })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  Object.defineProperty(event, 'isPrimary', { value: true })
  act(() => { target.dispatchEvent(event) })
}

/** The click a browser sends for a pointer press: its detail counts the presses, unlike a screen reader's or a script's. */
function pointerClick(): void {
  act(() => { compass().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 })) })
}

function key(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => { target.dispatchEvent(event) })
  return event
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  router = null
})

afterEach(() => {
  router?.dispose()
  act(() => { render(null, container) })
  setCurrentCanvasSession(null)
  view.dispose()
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('Compass', () => {
  it('always visible', () => {
    mount(0)
    expect(compass()).not.toBeNull()
    expect(compass().getAttribute('aria-label')).toBe('Reset north')
    expect(compass().getAttribute('aria-disabled')).toBeNull()
    expect(compass().hasAttribute('title')).toBe(false)
    expect(compass().getAttribute('aria-keyshortcuts')?.split(' ')).toEqual(expect.arrayContaining(['N', 'Shift+N']))
    expect(description()).toBe('North is up')
    expect(describedBy()).toBe('North is up Click to reset north. Drag the ring to turn the view; hold Shift for 15° steps.')
    expect(compass().dataset.turned).toBeUndefined()
    // The tooltip names the command with its key and the hint as its second line.
    const tooltip = hoveredTooltip(compass()!)!
    expect(tooltip.textContent).toContain('Reset north')
    expect(tooltip.textContent).toContain('Drag the ring to turn the view')

    act(() => { view.navigation.showCamera({ ...view.view().camera, bearingDeg: 30 }) })
    expect(description()).toBe('View turned 30° from north')
    expect(compass().dataset.turned).toBe('true')
    // The needle points to true north: turned by −bearing.
    expect(compass().querySelector('[data-needle]')?.getAttribute('transform')).toBe('rotate(-30 10 10)')
  })

  it('takes the zoom group\'s button class, which no caller may leave out (p1-24)', () => {
    mount(0)
    expect(compass().classList.contains('button')).toBe(true)
    // @ts-expect-error className is required: a compass without it would miss the group's button size.
    const withoutClass: Parameters<typeof Compass>[0] = { command: workspaceCanvasCommandProjection.value.viewActions[0]! }
    expect(withoutClass.className).toBeUndefined()
  })

  it('reads the bearing in whole degrees, and a turn within half a degree of north to its tenth', () => {
    mount(0)
    act(() => { view.navigation.showCamera({ ...view.view().camera, bearingDeg: 37.5 }) })
    expect(description()).toBe('View turned 38° from north')
    act(() => { view.navigation.showCamera({ ...view.view().camera, bearingDeg: 359.7 }) })
    expect(description()).toBe('View turned 359.7° from north')
  })

  it('click resets north', () => {
    mount(30)
    act(() => { compass().click() })
    expect(bearing()).toBe(0)
  })

  it('ring drag turns and Shift steps on each move', () => {
    mount(30)
    pointer(compass(), 'pointerdown', around(-90))
    expect(document.activeElement).toBe(compass())
    // 22° counter-clockwise around the face raises the bearing by 22°.
    pointer(compass(), 'pointermove', around(-112))
    expect(bearing()).toBeCloseTo(52, 6)
    expect(compass().dataset.dragging).toBe('true')
    pointer(compass(), 'pointermove', around(-112), { shiftKey: true })
    expect(bearing()).toBeCloseTo(45, 6)
    pointer(compass(), 'pointermove', around(-112))
    expect(bearing()).toBeCloseTo(52, 6)
    pointer(compass(), 'pointerup', around(-112))
    pointerClick()
    // A drag is not a click: the release keeps the turned view.
    expect(bearing()).toBeCloseTo(52, 6)
    expect(compass().dataset.dragging).toBeUndefined()
  })

  it('a clockwise drag around the face lowers the bearing', () => {
    mount(30)
    pointer(compass(), 'pointerdown', around(-90))
    pointer(compass(), 'pointermove', around(-70))
    expect(bearing()).toBeCloseTo(10, 6)
    // On round the face and past its left, where the pointer's angle wraps, without a jump: 290° swept in all.
    for (const deg of [0, 90, 170, 200]) pointer(compass(), 'pointermove', around(deg))
    expect(bearing()).toBeCloseTo(100, 6)
  })

  it('a press on the needle that drifts past 3 px turns nothing and is no click', () => {
    mount(30)
    // A press lands on the needle beside the centre and rolls 3.6 px across it: past 3 px it is a drag (spec §4.2), and
    // near the centre the pointer's angle means nothing, so the view does not turn.
    pointer(compass(), 'pointerdown', { x: CENTRE.x + 1, y: CENTRE.y })
    pointer(compass(), 'pointermove', { x: CENTRE.x - 2, y: CENTRE.y + 2 })
    expect(bearing()).toBe(30)
    pointer(compass(), 'pointerup', { x: CENTRE.x - 2, y: CENTRE.y + 2 })
    pointerClick()
    expect(bearing()).toBe(30)
  })

  it('a drag from the face into the needle is no click', () => {
    mount(30)
    // 10 px of travel straight in to the centre: a drag, so its release does not reset north.
    pointer(compass(), 'pointerdown', { x: CENTRE.x + 10, y: CENTRE.y })
    pointer(compass(), 'pointermove', { x: CENTRE.x + 5, y: CENTRE.y })
    pointer(compass(), 'pointermove', CENTRE)
    pointer(compass(), 'pointerup', CENTRE)
    pointerClick()
    expect(bearing()).toBe(30)
  })

  it('a drag that stays on the needle across the centre is no click', () => {
    mount(30)
    // From 5 px on one side of the centre to 5 px on the other: 10 px of travel, all of it inside the needle.
    pointer(compass(), 'pointerdown', { x: CENTRE.x - 5, y: CENTRE.y })
    pointer(compass(), 'pointermove', CENTRE)
    pointer(compass(), 'pointermove', { x: CENTRE.x + 5, y: CENTRE.y })
    pointer(compass(), 'pointerup', { x: CENTRE.x + 5, y: CENTRE.y })
    pointerClick()
    expect(bearing()).toBe(30)
  })

  it('a drag across the centre takes up the angle again on the far side and never flips the view', () => {
    mount(30)
    // A straight drag from the left of the face to its right, half a pixel below the centre.
    for (const [index, x] of [88, 93, 100, 107, 112].entries()) {
      pointer(compass(), index === 0 ? 'pointerdown' : 'pointermove', { x, y: CENTRE.y + 0.5 })
    }
    expect(compass().dataset.dragging).toBe('true')
    // Only the small sweeps outside the centre count: about 3°, never the 180° the crossing passes through.
    expect(Math.abs(bearing() - 30)).toBeLessThan(5)
  })

  it('a touch tap that rolls 5 px is still a tap and resets north', () => {
    vi.useFakeTimers()
    mount(30)
    const touch = { pointerType: 'touch' } as const
    // A finger lands 12 px above the centre and rolls 5 px sideways: past the mouse's 3 px, inside a finger's 8 px.
    const start = around(-90)
    const rolled = { x: start.x + 5, y: start.y }
    pointer(compass(), 'pointerdown', start, touch)
    pointer(compass(), 'pointermove', rolled, touch)
    expect(compass().dataset.dragging).toBeUndefined()
    expect(bearing()).toBe(30)
    pointer(compass(), 'pointerup', rolled, touch)
    // The tap's click comes from its own gesture, a task after the release.
    act(() => { vi.advanceTimersByTime(50) })
    pointerClick()
    expect(bearing()).toBe(0)
  })

  it('a pen press past 3 px turns, like a mouse', () => {
    mount(30)
    const pen = { pointerType: 'pen' } as const
    const start = around(-90)
    pointer(compass(), 'pointerdown', start, pen)
    pointer(compass(), 'pointermove', { x: start.x + 5, y: start.y }, pen)
    expect(compass().dataset.dragging).toBe('true')
    expect(bearing()).not.toBe(30)
  })

  it('a short touch drag keeps its turn when the click of the tap comes in a later task', () => {
    vi.useFakeTimers()
    mount(0)
    const touch = { pointerType: 'touch' } as const
    // 10 px around the face: past a finger's 8 px, so a drag, but inside a touch screen's tap slop, so the browser still
    // sends a click, from its tap gesture, after the release's task.
    pointer(compass(), 'pointerdown', around(-90, 15), touch)
    pointer(compass(), 'pointermove', around(-50, 15), touch)
    pointer(compass(), 'pointerup', around(-50, 15), touch)
    expect(bearing()).toBeCloseTo(320, 6)
    act(() => { vi.advanceTimersByTime(50) })
    pointerClick()
    expect(bearing()).toBeCloseTo(320, 6)
    // The next press is a click again.
    pointer(compass(), 'pointerdown', around(-90, 15), touch)
    pointer(compass(), 'pointerup', around(-90, 15), touch)
    pointerClick()
    expect(bearing()).toBe(0)
  })

  it('a screen reader activation after a drag that sent no click resets north', () => {
    mount(30)
    // A touch drag past the tap slop: the browser sends no click after its release.
    pointer(compass(), 'pointerdown', around(-90))
    pointer(compass(), 'pointermove', around(-120))
    pointer(compass(), 'pointerup', around(-120))
    expect(bearing()).toBeCloseTo(60, 6)
    // A screen reader activates the button with a click of detail 0.
    act(() => { compass().click() })
    expect(bearing()).toBe(0)
  })

  it.each([0.5, -0.5])('a fast swipe that jumps over the centre between two moves never flips the view (%s px off centre)', (offset) => {
    mount(30)
    const y = CENTRE.y + offset
    // One sample each side of the centre, both just outside its dead zone: the pointer's angle jumps by about 172°, one
    // way or the other by half a pixel, but the step between them crosses the centre, so it turns nothing.
    pointer(compass(), 'pointerdown', { x: CENTRE.x - 10, y })
    pointer(compass(), 'pointermove', { x: CENTRE.x + 6.1, y })
    expect(compass().dataset.dragging).toBe('true')
    expect(bearing()).toBeCloseTo(30, 6)
    // The angle is taken up again on the far side.
    pointer(compass(), 'pointermove', { x: CENTRE.x + 6.1, y: y + 3 })
    expect(Math.abs(bearing() - 30)).toBeGreaterThan(10)
  })

  it('Enter and Space reset', () => {
    mount(30)
    compass().focus()
    expect(key(compass(), { key: 'Enter', code: 'Enter' }).defaultPrevented).toBe(true)
    expect(bearing()).toBe(0)

    act(() => { view.navigation.showCamera({ ...view.view().camera, bearingDeg: 60 }) })
    expect(key(compass(), { key: ' ', code: 'Space' }).defaultPrevented).toBe(true)
    expect(bearing()).toBe(0)
  })

  it('an Esc before 3 px ends the press with no reset', () => {
    mount(30)
    router = installCanvasKeyRouter(() => null)
    pointer(compass(), 'pointerdown', around(-90))
    pointer(compass(), 'pointermove', { x: around(-90).x + 2, y: around(-90).y })
    expect(key(compass(), { key: 'Escape', code: 'Escape' }).defaultPrevented).toBe(true)
    pointer(compass(), 'pointerup', around(-90))
    pointerClick()
    expect(bearing()).toBe(30)
    // The next press is a click again.
    pointer(compass(), 'pointerdown', around(-90))
    pointer(compass(), 'pointerup', around(-90))
    pointerClick()
    expect(bearing()).toBe(0)
  })

  it('pointer cancel, lost capture and blur cancel the drag', () => {
    mount(30)
    for (const [target, type] of [[compass(), 'pointercancel'], [compass(), 'lostpointercapture'], [window, 'blur']] as const) {
      pointer(compass(), 'pointerdown', around(-90))
      pointer(compass(), 'pointermove', around(-120))
      expect(bearing()).toBeCloseTo(60, 6)
      if (type === 'blur') act(() => { window.dispatchEvent(new Event('blur')) })
      else pointer(target, type, around(-120))
      expect(bearing()).toBeCloseTo(30, 6)
      pointer(compass(), 'pointermove', around(-150))
      expect(bearing()).toBeCloseTo(30, 6)
      expect(compass().dataset.dragging).toBeUndefined()
    }
  })

  it('Esc with map or body focus restores the starting camera and keeps the selection (I9)', () => {
    mount(30)
    const host = document.createElement('div')
    host.tabIndex = 0
    document.body.append(host)
    const canvas = { selected: true, tool: 'select' }
    const port = selectPort(host, canvas)
    router = installCanvasKeyRouter(() => port)
    const start = view.view().camera

    for (const focus of ['map', 'body'] as const) {
      pointer(compass(), 'pointerdown', around(-90))
      pointer(compass(), 'pointermove', around(-130))
      expect(bearing()).toBeCloseTo(70, 6)
      if (focus === 'map') host.focus()
      else (document.activeElement as HTMLElement | null)?.blur()
      expect(key(focus === 'map' ? host : document.body, { key: 'Escape', code: 'Escape' }).defaultPrevented).toBe(true)
      expect(view.view().camera).toEqual(start)
      expect(canvas.selected).toBe(true)
      // The press is over: a move turns nothing, and the release is no click.
      pointer(compass(), 'pointermove', around(-160))
      pointer(compass(), 'pointerup', around(-160))
      expect(view.view().camera).toEqual(start)
    }
  })
})

/** The live keyboard port over a Select tool with a selection: its selection layer clears the selection from the map. */
function selectPort(host: HTMLElement, canvas: { selected: boolean, tool: string }): CanvasKeyboardPort {
  const toolHost = {
    command: () => 'pass',
    hasNudgeSeries: () => false,
    endNudgeSeries: () => {},
    activeToolIsSelect: () => canvas.tool === 'select',
    activeToolHasEscapeTransient: () => false,
    textEntryOpen: () => false,
    activeToolEscSteps: () => ['gesture', 'nudge-series', 'tool-transient', 'tool', 'selection'],
    interrupted: () => {},
  } as unknown as ToolHost
  return createCanvasKeyboardPort({
    host,
    toolHost,
    hasSelection: () => canvas.selected,
    navigation: { panByPx: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), resetNorth: vi.fn(), rotateBy: vi.fn() },
    session: {
      pointerSessionLive: () => false,
      overview: () => false,
      handleFocused: () => false,
      spaceHeld: () => false,
      keyState: () => {},
      escapeGesture: () => {},
      escapeTool: () => { canvas.tool = 'select' },
      clearSelection: () => { canvas.selected = false },
    },
  })
}
