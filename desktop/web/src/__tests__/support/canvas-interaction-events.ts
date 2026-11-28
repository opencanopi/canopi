import { vi } from 'vitest'
import type { ScenePoint } from '../../canvas/runtime/scene'

interface SceneInteractionBounds {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

interface SceneInteractionPointerOptions extends MouseEventInit {
  readonly pointerId?: number
  readonly pointerType?: string
  readonly isPrimary?: boolean
  readonly target?: EventTarget
  /** The event's timeStamp (jsdom's is Date.now()): 0 puts a press long before the next, so the recogniser's click count
   *  does not join them into a double-click. */
  readonly timeStamp?: number
}

export interface SceneInteractionEventHarnessOptions {
  readonly bounds?: SceneInteractionBounds
  readonly pointerCapture?: {
    readonly available?: boolean
    readonly setThrows?: Error
    readonly releaseThrows?: Error
    readonly synchronousLossOnSet?: boolean
    readonly synchronousLossOnRelease?: boolean
  }
}

interface SceneInteractionKeyboardOptions extends KeyboardEventInit {
  readonly target?: EventTarget
}

export interface SceneInteractionEventHarness {
  readonly pointerCapture: {
    readonly setCalls: ReturnType<typeof vi.fn>
    readonly releaseCalls: ReturnType<typeof vi.fn>
    has(pointerId: number): boolean
  }
  setBounds(bounds: SceneInteractionBounds): void
  boundsReads(): number
  clientPoint(screen: ScenePoint): ScenePoint
  screenPointFrom(event: Pick<MouseEvent, 'clientX' | 'clientY'>, rect?: DOMRect): ScenePoint
  pointerDown(screen: ScenePoint, options?: SceneInteractionPointerOptions): PointerEvent
  pointerDownClient(client: ScenePoint, options?: SceneInteractionPointerOptions): PointerEvent
  pointerMove(screen: ScenePoint, options?: SceneInteractionPointerOptions): PointerEvent
  pointerMoveClient(client: ScenePoint, options?: SceneInteractionPointerOptions): PointerEvent
  pointerUp(screen: ScenePoint, options?: SceneInteractionPointerOptions): PointerEvent
  pointerUpClient(client: ScenePoint, options?: SceneInteractionPointerOptions): PointerEvent
  pointerCancel(screen: ScenePoint, options?: SceneInteractionPointerOptions): PointerEvent
  lostPointerCapture(pointerId: number): PointerEvent
  pointerLeave(screen: ScenePoint, options?: SceneInteractionPointerOptions): PointerEvent
  wheel(screen: ScenePoint, options?: WheelEventInit): WheelEvent
  keyDown(options: string | SceneInteractionKeyboardOptions): KeyboardEvent
  keyUp(options: string | SceneInteractionKeyboardOptions): KeyboardEvent
  holdSpace(): KeyboardEvent
  releaseSpace(): KeyboardEvent
  windowBlur(): Event
  dispose(): void
}

const DEFAULT_BOUNDS: SceneInteractionBounds = {
  left: 0,
  top: 0,
  width: 400,
  height: 300,
}

export function createSceneInteractionEventHarness(
  container: HTMLElement,
  options: SceneInteractionEventHarnessOptions = {},
): SceneInteractionEventHarness {
  let bounds = options.bounds ?? DEFAULT_BOUNDS
  let boundsReadCount = 0
  // A pointer over the map is over a page: the host's events reach the window only from a connected element.
  const appended = !container.isConnected
  if (appended) document.body.appendChild(container)
  const originalGetBoundingClientRect = container.getBoundingClientRect
  Object.defineProperty(container, 'getBoundingClientRect', {
    configurable: true,
    value: () => {
      boundsReadCount += 1
      return createRect(bounds)
    },
  })

  const pointerCapture = installPointerCaptureHarness(container, options.pointerCapture)

  function setBounds(next: SceneInteractionBounds): void {
    bounds = next
  }

  function clientPoint(screen: ScenePoint): ScenePoint {
    return {
      x: bounds.left + screen.x,
      y: bounds.top + screen.y,
    }
  }

  function currentRect(): DOMRect {
    return createRect(bounds)
  }

  function screenPointFrom(event: Pick<MouseEvent, 'clientX' | 'clientY'>, rect = currentRect()): ScenePoint {
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    }
  }

  function pointerDown(screen: ScenePoint, eventOptions: SceneInteractionPointerOptions = {}): PointerEvent {
    return dispatchPointer(container, 'pointerdown', clientPoint(screen), eventOptions)
  }

  function pointerDownClient(client: ScenePoint, eventOptions: SceneInteractionPointerOptions = {}): PointerEvent {
    return dispatchPointer(container, 'pointerdown', client, eventOptions)
  }

  // A move is dispatched on the map host unless it names its target: the host hears a hover, and the window's capture
  // listener a pointer the canvas owns (a press on the map), as a browser delivers them.
  function pointerMove(screen: ScenePoint, eventOptions: SceneInteractionPointerOptions = {}): PointerEvent {
    return dispatchPointer(container, 'pointermove', clientPoint(screen), eventOptions)
  }

  function pointerMoveClient(client: ScenePoint, eventOptions: SceneInteractionPointerOptions = {}): PointerEvent {
    return dispatchPointer(container, 'pointermove', client, eventOptions)
  }

  function pointerUp(screen: ScenePoint, eventOptions: SceneInteractionPointerOptions = {}): PointerEvent {
    return dispatchPointer(window, 'pointerup', clientPoint(screen), eventOptions)
  }

  function pointerUpClient(client: ScenePoint, eventOptions: SceneInteractionPointerOptions = {}): PointerEvent {
    return dispatchPointer(window, 'pointerup', client, eventOptions)
  }

  function pointerCancel(screen: ScenePoint, eventOptions: SceneInteractionPointerOptions = {}): PointerEvent {
    return dispatchPointer(window, 'pointercancel', clientPoint(screen), eventOptions)
  }

  function lostPointerCapture(pointerId: number): PointerEvent {
    return dispatchPointer(container, 'lostpointercapture', clientPoint({ x: 0, y: 0 }), { pointerId })
  }

  function pointerLeave(screen: ScenePoint, eventOptions: SceneInteractionPointerOptions = {}): PointerEvent {
    return dispatchPointer(container, 'pointerleave', clientPoint(screen), eventOptions)
  }

  function wheel(screen: ScenePoint, eventOptions: WheelEventInit = {}): WheelEvent {
    const point = clientPoint(screen)
    const event = createWheelEvent(point, eventOptions)
    container.dispatchEvent(event)
    return event
  }

  function keyDown(eventOptions: string | SceneInteractionKeyboardOptions): KeyboardEvent {
    return dispatchKeyboard('keydown', eventOptions)
  }

  function keyUp(eventOptions: string | SceneInteractionKeyboardOptions): KeyboardEvent {
    return dispatchKeyboard('keyup', eventOptions)
  }

  function holdSpace(): KeyboardEvent {
    return keyDown({ key: ' ', code: 'Space' })
  }

  function releaseSpace(): KeyboardEvent {
    return keyUp({ key: ' ', code: 'Space' })
  }

  function windowBlur(): Event {
    const event = new Event('blur')
    window.dispatchEvent(event)
    return event
  }

  return {
    pointerCapture: pointerCapture.api,
    setBounds,
    boundsReads: () => boundsReadCount,
    clientPoint,
    screenPointFrom,
    pointerDown,
    pointerDownClient,
    pointerMove,
    pointerMoveClient,
    pointerUp,
    pointerUpClient,
    pointerCancel,
    lostPointerCapture,
    pointerLeave,
    wheel,
    keyDown,
    keyUp,
    holdSpace,
    releaseSpace,
    windowBlur,
    dispose: () => {
      if (appended) container.remove()
      pointerCapture.restore()
      Object.defineProperty(container, 'getBoundingClientRect', {
        configurable: true,
        value: originalGetBoundingClientRect,
      })
    },
  }
}

function installPointerCaptureHarness(
  container: HTMLElement,
  options: SceneInteractionEventHarnessOptions['pointerCapture'],
): {
  readonly api: SceneInteractionEventHarness['pointerCapture']
  readonly restore: () => void
} {
  const setCalls = vi.fn()
  const releaseCalls = vi.fn()
  const captured = new Set<number>()
  const descriptors = {
    setPointerCapture: Object.getOwnPropertyDescriptor(container, 'setPointerCapture'),
    hasPointerCapture: Object.getOwnPropertyDescriptor(container, 'hasPointerCapture'),
    releasePointerCapture: Object.getOwnPropertyDescriptor(container, 'releasePointerCapture'),
  }
  const available = options?.available ?? true

  if (available) {
    Object.defineProperties(container, {
      setPointerCapture: {
        configurable: true,
        value: (pointerId: number) => {
          setCalls(pointerId)
          if (options?.setThrows) throw options.setThrows
          captured.add(pointerId)
          if (options?.synchronousLossOnSet) {
            captured.delete(pointerId)
            dispatchPointer(container, 'lostpointercapture', { x: 0, y: 0 }, { pointerId })
          }
        },
      },
      hasPointerCapture: {
        configurable: true,
        value: (pointerId: number) => captured.has(pointerId),
      },
      releasePointerCapture: {
        configurable: true,
        value: (pointerId: number) => {
          releaseCalls(pointerId)
          captured.delete(pointerId)
          if (options?.synchronousLossOnRelease) {
            dispatchPointer(container, 'lostpointercapture', { x: 0, y: 0 }, { pointerId })
          }
          if (options?.releaseThrows) throw options.releaseThrows
        },
      },
    })
  } else {
    Object.defineProperties(container, {
      setPointerCapture: { configurable: true, value: undefined },
      hasPointerCapture: { configurable: true, value: undefined },
      releasePointerCapture: { configurable: true, value: undefined },
    })
  }

  const restore = (): void => {
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(container, name, descriptor)
      else delete (container as unknown as Record<string, unknown>)[name]
    }
  }

  return {
    api: { setCalls, releaseCalls, has: (pointerId) => captured.has(pointerId) },
    restore,
  }
}

function dispatchPointer(
  defaultTarget: EventTarget,
  type: string,
  client: ScenePoint,
  options: SceneInteractionPointerOptions,
): PointerEvent {
  const event = createPointerEvent(type, client, options)
  ;(options.target ?? defaultTarget).dispatchEvent(event)
  return event
}

function createPointerEvent(
  type: string,
  client: ScenePoint,
  options: SceneInteractionPointerOptions,
): PointerEvent {
  const {
    pointerId = 1,
    pointerType = 'mouse',
    isPrimary = true,
    target: _target,
    timeStamp,
    button = 0,
    buttons = defaultPointerButtons(type, button),
    bubbles = true,
    cancelable = true,
    ...mouseOptions
  } = options
  const event = new MouseEvent(type, {
    ...mouseOptions,
    bubbles,
    cancelable,
    button,
    buttons,
    clientX: client.x,
    clientY: client.y,
  })
  definePointerFields(event, {
    pointerId,
    pointerType,
    isPrimary,
  })
  if (timeStamp !== undefined) Object.defineProperty(event, 'timeStamp', { configurable: true, value: timeStamp })
  return event as PointerEvent
}

function defaultPointerButtons(type: string, button: number): number {
  if (type === 'pointerup' || type === 'pointercancel') return 0
  if (button === 0) return 1
  if (button === 1) return 4
  if (button === 2) return 2
  return 0
}

function definePointerFields(
  event: MouseEvent,
  fields: Pick<PointerEvent, 'pointerId' | 'pointerType' | 'isPrimary'>,
): void {
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: fields.pointerId },
    pointerType: { configurable: true, value: fields.pointerType },
    isPrimary: { configurable: true, value: fields.isPrimary },
  })
}

function createWheelEvent(client: ScenePoint, options: WheelEventInit): WheelEvent {
  if (typeof WheelEvent === 'function') {
    return new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ...options,
      clientX: client.x,
      clientY: client.y,
    })
  }
  const event = new MouseEvent('wheel', {
    bubbles: true,
    cancelable: true,
    ...options,
    clientX: client.x,
    clientY: client.y,
  })
  Object.defineProperty(event, 'deltaY', {
    configurable: true,
    value: options.deltaY ?? 0,
  })
  return event as WheelEvent
}

function dispatchKeyboard(type: string, options: string | SceneInteractionKeyboardOptions): KeyboardEvent {
  const init = typeof options === 'string'
    ? { key: options, code: options }
    : options
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  ;(init.target ?? window).dispatchEvent(event)
  return event
}

function createRect(bounds: SceneInteractionBounds): DOMRect {
  const right = bounds.left + bounds.width
  const bottom = bounds.top + bounds.height
  return {
    x: bounds.left,
    y: bounds.top,
    left: bounds.left,
    top: bounds.top,
    right,
    bottom,
    width: bounds.width,
    height: bounds.height,
    toJSON: () => ({
      x: bounds.left,
      y: bounds.top,
      left: bounds.left,
      top: bounds.top,
      right,
      bottom,
      width: bounds.width,
      height: bounds.height,
    }),
  } as DOMRect
}
