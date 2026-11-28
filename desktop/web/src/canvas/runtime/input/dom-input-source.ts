// canvas/runtime/input/dom-input-source.ts
//
// Owns every DOM listener for canvas input: the map host's pointer (hover moves included), wheel, drag and focus events,
// the one document-capture contextmenu listener, WebKit's gesture events (only on a platform that has them), the window
// blur, the window pointer listeners while it owns a pointer and the copied GeoLibre selection-drag guard on the host
// (keys are the key router's, app/keyboard). A press it delivers on the map owns that pointer until its release, its
// cancel or a window blur: only then does it listen on window, and only to that pointer, so presses, moves and releases
// that start elsewhere in the app reach the page untouched. While attached, the host takes `touch-action: none` and no
// WebKit callout, so a finger is the canvas's (A13). A finger lifted from the map (a tap, a drag's or a pinch's end, a long
// press's lift) swallows the one click the browser then makes from it, wherever it lands, so chrome that came up under the
// finger (the finished zone's chip) never takes it (MapLibre's DOM.suppressClick). It turns each event into host-relative, classified fields
// for `normalise`, hands the raw input to the sink, and applies the effects the sink sends back to the event being
// handled: prevent-default, stop-propagation, pointer capture, the drop effect. The native contextmenu reaches no sink:
// the listener only prevents it where a canvas press made it, or over the map (spec §2.2 "Native menu", U34), and the
// canvas menu opens from the secondary release instead. Detaching releases every capture it still holds. A sink that
// throws on a press on the map host quarantines that event, then rethrows; on any other event it rethrows and leaves
// the event to the app. It is the one module of input/ that touches the browser (policy P7); the input core stays pure.

import { hasPlantStampDragData, hasSavedObjectStampDragData, readPlantStampDropSource, readSavedObjectStampDragPreviewSource, readSavedObjectStampDropSource } from '../../stamp-drag-data'
import { runCanvasRuntimeCleanups } from '../cleanup'
import type { DomInputSource, DomInputSourceDeps, GestureOutcome } from '../interaction-ports'
import type { CanvasDropPayload, ToolHandleId } from '../interaction-types'
import { isEditableTarget } from './editable-target'
import { normalise, type DomEventLike } from './normalise'
import type { AdapterEffect, RawInput, TargetClass } from './raw-input'
import { installSelectionDragGuard } from './selection-drag-guard'

/** The note's text entry (chrome/text-entry-host.ts). */
const TEXT_ENTRY_SELECTOR = '[data-canvas-text-entry]'
/** The canvas's own controls and fields inside the map: the inspection lens's skip set and the chrome. */
const OWNED_CHROME_SELECTOR = [
  '[data-canvas-chrome]',
  'button',
  'input',
  'select',
  'textarea',
  '[contenteditable="true"]',
  '[data-preserve-overlays="true"]',
].join(', ')
/** MapLibre's controls in the host (the attribution): owned chrome for presses and hovers, so a press opens it or follows
 *  its link and never starts a band, and a hover moving onto it ends; a wheel or pinch over it still zooms the map. */
const MAP_CONTROL_SELECTOR = '.maplibregl-ctrl'
const SURFACE: TargetClass = Object.freeze({ kind: 'surface' })
const OWNED_TEXT: TargetClass = Object.freeze({ kind: 'owned-text' })
const OWNED_CHROME: TargetClass = Object.freeze({ kind: 'owned-chrome' })
const FOREIGN: TargetClass = Object.freeze({ kind: 'foreign' })
const NO_RECT = Object.freeze({ left: 0, top: 0, width: 0, height: 0 })
/** A secondary release's native menu may trail it this long (WebView2 sends it after the release, retargeted to <html> or
 *  to the menu just opened; Safari and Firefox after a Mac Control-click), measured on the events' own timeStamp. */
const NATIVE_MENU_TRAIL_MS = 500
/** PointerEvent.button for the right button and a pen's barrel. */
const BUTTON_SECONDARY = 2
/** Its PointerEvent.buttons bit. */
const BUTTONS_SECONDARY_BIT = 2
/** WebKit's long-press callout (the link and image sheet); not in CSSStyleDeclaration's typed properties. */
const TOUCH_CALLOUT = '-webkit-touch-callout'
/** How long a finger's lift from the map waits for the click the browser makes from it; a new press ends the wait first. */
const TRAILING_CLICK_MS = 500

type HostRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>

/** A canvas press the source owns: whether it normalised as secondary, whether a move over the canvas has since
 *  reported the right or barrel button held (a real chord, U37), and whether it is a finger on the map's surface or a
 *  handle, whose lift swallows the click that trails it. */
interface CanvasPress {
  readonly secondary: boolean
  readonly finger: boolean
  chorded: boolean
}

interface HandledEvent {
  readonly event: Event
  /** The host rect this event's points were read against; a captured session keeps it until it ends (today). */
  readonly rect: HostRect | null
}

/** The browser keeps its own context menu (and wheel) over text fields, menus and dialogs, in the map or not. */
function allowsNativeContextMenuTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement
    ? target
    : (target instanceof Node ? target.parentElement : null)
  if (!element) return false
  if (isEditableTarget(element)) return true
  return element.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], dialog') !== null
}

/**
 * The effects to apply for one handled event: the recogniser's, less the press's capture when the host rejected the
 * press, plus the host's answer (a quarantine prevents and stops the event; a drop effect is written to dataTransfer).
 */
export function outcomeEffects(recognised: readonly AdapterEffect[], outcome: GestureOutcome): readonly AdapterEffect[] {
  const effects = outcome.rejectSession ? recognised.filter((effect) => effect.kind !== 'capture') : [...recognised]
  if (outcome.quarantine) effects.push({ kind: 'prevent-default' }, { kind: 'stop-propagation' })
  if (outcome.dropEffect) effects.push({ kind: 'drop-effect', dropEffect: outcome.dropEffect })
  return effects
}

export function createDomInputSource(deps: DomInputSourceDeps): DomInputSource {
  const { host } = deps
  const handling: HandledEvent[] = []
  /** Pointers whose capture the host holds; the loss of any other pointer's capture is stale. */
  const captured = new Set<number>()
  /** Covers the synchronous `lostpointercapture` a browser may dispatch while capture is being acquired. */
  let acquiring: number | null = null
  const sessionRects = new Map<number, HostRect>()
  let sink: ((input: RawInput) => void) | null = null
  let tickTimer: number | null = null
  /** The `t` of the last input delivered (an event's timeStamp, a tick's deadline): a deadline is scheduled from it, so the
   *  timer needs no clock on the events' base (A1; a browser's timeStamp is not Date.now()). */
  let lastT = 0
  /** Pointers pressed on the map, until their release or cancel: the window listeners follow only these. */
  const owned = new Set<number>()
  /** The pointer type of the last press or move the source heard; boundary events never change it (onPointerLeave). */
  let heardPointerType: string | undefined
  /** The owned pointers whose press was a canvas press (not the note editor's, a field's or a menu's): their native menus
   *  are prevented anywhere until NATIVE_MENU_TRAIL_MS after a secondary release (a secondary press's, or one that reports
   *  the right or barrel button after a real chord, U36, U37). */
  const canvasPresses = new Map<number, CanvasPress>()
  /** When the last canvas secondary press was released (its event's timeStamp). */
  let secondaryReleasedAt: number | null = null
  /** Installs the window pointer listeners (set while attached); returns their removal. */
  let listenOnWindow: (() => () => void) | null = null
  let removeWindowListeners: (() => void) | null = null
  /** Ends the wait for the click that trails a finger's lift (suppressTrailingClick), while one is armed. */
  let endTrailingClick: (() => void) | null = null

  /**
   * Swallows the next pointer click anywhere in the page, in the capture phase on window, unless a new press or
   * TRAILING_CLICK_MS comes first: the one the browser makes from a finger lifted from the map, which would land on
   * whatever came up under the finger. A keyboard or assistive click (detail 0) passes. After MapLibre's
   * DOM.suppressClick (maplibre-gl-js src/util/dom.ts, BSD-3-Clause), which removes its one-shot listener at the next
   * timeout; a finger's click trails its lift by more than a tick, so this one waits for a press or its deadline.
   */
  function suppressTrailingClick(): void {
    endTrailingClick?.()
    const onClick = (event: MouseEvent): void => {
      if (event.detail === 0) return
      event.preventDefault()
      event.stopPropagation()
      end()
    }
    const end = (): void => {
      endTrailingClick = null
      deps.timers.clear(timer)
      window.removeEventListener('click', onClick as EventListener, { capture: true })
      window.removeEventListener('pointerdown', end, { capture: true })
    }
    endTrailingClick = end
    const timer = deps.timers.set(TRAILING_CLICK_MS, end)
    window.addEventListener('click', onClick as EventListener, { capture: true })
    window.addEventListener('pointerdown', end, { capture: true })
  }

  function own(pointerId: number): void {
    owned.add(pointerId)
    if (!removeWindowListeners && listenOnWindow) removeWindowListeners = listenOnWindow()
  }

  /** `release` is the up, cancel or button-dropping move that ends the pointer; a canvas press's secondary release starts
   *  the native-menu trail. */
  function disown(pointerId: number | 'all', release: Pick<MouseEvent, 'button' | 'timeStamp'> | null = null): void {
    if (pointerId === 'all') {
      owned.clear()
      canvasPresses.clear()
    } else {
      owned.delete(pointerId)
      const press = canvasPresses.get(pointerId)
      // A right release that ends a stale primary press, its button never seen over the canvas, starts none (U37).
      if (release && press && (press.secondary || (press.chorded && release.button === BUTTON_SECONDARY))) {
        secondaryReleasedAt = release.timeStamp
      }
      canvasPresses.delete(pointerId)
    }
    if (owned.size > 0 || !removeWindowListeners) return
    const remove = removeWindowListeners
    removeWindowListeners = null
    remove()
  }

  /**
   * Hands one input to the sink while its event is the one being handled. `onError` is the one rule for a failure:
   * rethrow on every event kind, quarantining only a press on the map host (so a failing hover sink, for instance,
   * never stops every pointermove in the app).
   */
  function deliver(event: Event, rect: HostRect | null, input: RawInput | null, onError: 'quarantine' | 'rethrow' = 'rethrow'): void {
    if (!input || !sink) return
    lastT = input.t
    handling.push({ event, rect })
    try {
      sink(input)
    } catch (error) {
      if (onError === 'quarantine') quarantine(event)
      throw error
    } finally {
      handling.pop()
    }
  }

  function pointerInput(event: PointerEvent, type: DomEventLike['type'], rect: HostRect): RawInput | null {
    return normalise(domEventLike(event, type, rect, classifyTarget(event.target, host)), deps.platform, rect)
  }

  function sessionRect(pointerId: number): HostRect {
    return sessionRects.get(pointerId) ?? host.getBoundingClientRect()
  }

  const onPointerDown = (event: PointerEvent): void => {
    heardPointerType = event.pointerType
    const rect = host.getBoundingClientRect()
    const input = pointerInput(event, 'pointerdown', rect)
    // Owned first: a sink that fails on the press may still have opened its session, whose release must reach it.
    own(event.pointerId)
    if (isCanvasPressTarget(event.target, host)) {
      const target = input?.kind === 'down' ? input.target.kind : null
      canvasPresses.set(event.pointerId, {
        secondary: input?.kind === 'down' && input.role === 'secondary',
        finger: event.pointerType === 'touch' && (target === 'surface' || target === 'handle'),
        chorded: false,
      })
    }
    deliver(event, rect, input, 'quarantine')
  }
  /** A move of a pointer the source does not own, over the map: a hover (an owned pointer's moves come from window). */
  const onHostPointerMove = (event: PointerEvent): void => {
    if (owned.has(event.pointerId)) return
    heardPointerType = event.pointerType
    const rect = host.getBoundingClientRect()
    deliver(event, rect, pointerInput(event, 'pointermove', rect))
  }
  const onPointerMove = (event: PointerEvent): void => {
    if (!owned.has(event.pointerId)) return
    heardPointerType = event.pointerType
    const press = canvasPresses.get(event.pointerId)
    if (press && (event.buttons & BUTTONS_SECONDARY_BIT) !== 0 && isCanvasPressTarget(event.target, host)) press.chorded = true
    const rect = sessionRect(event.pointerId)
    deliver(event, rect, pointerInput(event, 'pointermove', rect))
  }
  const onPointerUp = (event: PointerEvent): void => {
    if (!owned.has(event.pointerId)) return
    const rect = sessionRect(event.pointerId)
    if (canvasPresses.get(event.pointerId)?.finger) suppressTrailingClick()
    try {
      deliver(event, rect, pointerInput(event, 'pointerup', rect))
    } finally {
      disown(event.pointerId, event)
    }
  }
  const onPointerCancel = (event: PointerEvent): void => {
    if (!owned.has(event.pointerId)) return
    try {
      deliver(event, null, pointerInput(event, 'pointercancel', NO_RECT))
    } finally {
      disown(event.pointerId, event)
    }
  }
  const onLostPointerCapture = (event: PointerEvent): void => {
    const id = event.pointerId
    if (!captured.has(id) && acquiring !== id) return
    // Fence first: a release may dispatch this event synchronously, after the session has already ended.
    captured.delete(id)
    if (acquiring === id) acquiring = null
    sessionRects.delete(id)
    deliver(event, null, pointerInput(event, 'lostpointercapture', NO_RECT))
  }
  /**
   * The move that takes a hover off the map lands beside it, where the host no longer hears it; the leave carries its
   * point (classified by where it landed), so a tool's preview follows the pointer there before the hover ends, rather
   * than staying at the last move the map heard (a coalesced move can lie well inside it). An owned pointer's moves come
   * from window, and a touch has no hover. A leave is a boundary event, which never changes the pointer kind: after a
   * tap a browser sends mouse-typed boundary events as the handles re-render under the finger (canopi-94o3), so a leave
   * carries a move only for the pointer kind the map last heard press or move (or any, before it has heard one).
   */
  const onPointerLeave = (event: PointerEvent): void => {
    try {
      if (!owned.has(event.pointerId) && event.pointerType !== 'touch'
        && (heardPointerType === undefined || event.pointerType === heardPointerType)) {
        const rect = host.getBoundingClientRect()
        deliver(event, rect, normalise(domEventLike(event, 'pointermove', rect, classifyTarget(event.relatedTarget, host)), deps.platform, rect))
      }
    } finally {
      deliver(event, null, pointerInput(event, 'pointerleave', NO_RECT))
    }
  }
  const onFocusOut = (event: FocusEvent): void => {
    // Focus moving inside the map (to the note editor or a handle) does not leave it.
    const next = event.relatedTarget
    if (next instanceof Node && host.contains(next)) return
    deliver(event, null, { kind: 'focus-out', t: event.timeStamp })
  }
  const onBlur = (event: Event): void => {
    // The blur ends every session, so the source owns no pointer after it.
    try {
      deliver(event, null, { kind: 'cancel', t: event.timeStamp, id: 'all', reason: 'blur' })
    } finally {
      disown('all')
    }
  }
  const onWheel = (event: WheelEvent): void => {
    if (allowsNativeContextMenuTarget(event.target)) return
    const rect = host.getBoundingClientRect()
    deliver(event, rect, normalise(domEventLike(event, 'wheel', rect, classifyTarget(event.target, host, 'surface')), deps.platform, rect))
  }
  /**
   * The one contextmenu listener (document capture): it opens nothing and reaches no sink. It prevents the native menu
   * (1) over the map, except over the note editor and the map's fields, menus and dialogs; (2) anywhere while a canvas
   * press is held (Linux and macOS send it at the press, a right press during a left drag included); (3) anywhere within
   * NATIVE_MENU_TRAIL_MS of a canvas secondary release, or of a canvas release that reports the right or barrel button
   * (Windows sends it after the release, a chorded right button released last included). "Anywhere" is the event's own
   * target, so the trail WebView2 retargets to <html> or to the menu just opened is prevented too.
   */
  const onContextMenu = (event: MouseEvent): void => {
    const trailing = secondaryReleasedAt !== null && event.timeStamp - secondaryReleasedAt < NATIVE_MENU_TRAIL_MS
    if (!trailing && canvasPresses.size === 0 && !isCanvasPressTarget(event.target, host)) return
    if (event.cancelable) event.preventDefault()
  }
  const dragHandler = (type: 'dragover' | 'dragleave' | 'drop') => (event: DragEvent): void => {
    const rect = type === 'dragleave' ? NO_RECT : host.getBoundingClientRect()
    const like: DomEventLike = { ...domEventLike(event, type, rect, classifyTarget(event.target, host)), dropPayload: dropPayloadOf(event, type) }
    deliver(event, rect, normalise(like, deps.platform, rect))
  }
  /** True from a gesturestart the canvas does not take (over the note editor or the canvas's own chrome; MapLibre's
   *  controls count as map, as for a wheel) to its gestureend: the source prevents that twist's events and delivers none. */
  let ignoringTwist = false
  /** WebKit's trackpad gesture events (WKWebView and Safari); the recogniser prevents each one and uses its rotation. */
  const gestureHandler = (type: 'gesturestart' | 'gesturechange' | 'gestureend') => (event: Event): void => {
    if (type === 'gesturestart') ignoringTwist = classifyTarget(event.target, host, 'surface').kind !== 'surface'
    if (ignoringTwist) {
      event.preventDefault()
      if (type === 'gestureend') ignoringTwist = false
      return
    }
    const rect = host.getBoundingClientRect()
    deliver(event, rect, normalise(gestureEventLike(event, type, rect), deps.platform, rect))
  }
  const onDragOver = dragHandler('dragover')
  const onDragLeave = dragHandler('dragleave')
  const onDrop = dragHandler('drop')

  function capture(pointerId: number, rect: HostRect | null): void {
    if (rect) sessionRects.set(pointerId, rect)
    if (typeof host.setPointerCapture !== 'function' || typeof host.hasPointerCapture !== 'function') return
    acquiring = pointerId
    try {
      host.setPointerCapture(pointerId)
      if (acquiring === pointerId && host.hasPointerCapture(pointerId)) captured.add(pointerId)
    } catch {
      // Capture is a delivery aid: the window listeners still follow the pointer when it is unavailable or refused.
    } finally {
      if (acquiring === pointerId) acquiring = null
    }
  }

  function release(pointerId: number): void {
    sessionRects.delete(pointerId)
    // Clear ownership before release: a loss dispatched by the release itself is stale by design.
    if (!captured.delete(pointerId)) return
    try {
      host.releasePointerCapture(pointerId)
    } catch {
      // The session has ended either way; a failed release cannot strand an edit.
    }
  }

  function clearTickTimer(): void {
    if (tickTimer === null) return
    deps.timers.clear(tickTimer)
    tickTimer = null
  }

  return {
    attach(nextSink) {
      if (sink) throw new Error('The DOM input source is already attached')
      sink = nextSink
      const previousTouchAction = host.style.touchAction
      const previousCallout = host.style.getPropertyValue(TOUCH_CALLOUT)
      const removals: Array<() => void> = []
      const listen = (
        target: EventTarget,
        type: string,
        listener: EventListener,
        options?: boolean | AddEventListenerOptions,
      ): void => {
        target.addEventListener(type, listener, options)
        const removeOptions = typeof options === 'object' ? { capture: options.capture ?? false } : options
        removals.push(() => target.removeEventListener(type, listener, removeOptions))
      }
      const detach = (): void => {
        sink = null
        listenOnWindow = null
        clearTickTimer()
        endTrailingClick?.()
        disown('all')
        const pending = removals.splice(0)
        runCanvasRuntimeCleanups([
          // Every capture the source still holds goes with it (a live press at disposal, today's _clearPointerGesture);
          // the sink is gone first, so the loss a release dispatches reaches nobody.
          ...[...captured].map((pointerId) => () => release(pointerId)),
          ...pending,
          () => {
            host.style.touchAction = previousTouchAction
            if (previousCallout) host.style.setProperty(TOUCH_CALLOUT, previousCallout)
            else host.style.removeProperty(TOUCH_CALLOUT)
          },
        ], 'DOM input source listener removal failed')
      }
      try {
        listen(host, 'pointerdown', onPointerDown as EventListener, { capture: true })
        listen(host, 'pointermove', onHostPointerMove as EventListener)
        listen(host, 'pointerleave', onPointerLeave as EventListener)
        listen(host, 'lostpointercapture', onLostPointerCapture as EventListener)
        listen(window, 'blur', onBlur)
        listen(host, 'wheel', onWheel as EventListener, { passive: false })
        listen(host, 'dragover', onDragOver as EventListener)
        listen(host, 'dragleave', onDragLeave as EventListener)
        listen(host, 'drop', onDrop as EventListener)
        listen(host, 'focusout', onFocusOut as EventListener)
        listen(host.ownerDocument, 'contextmenu', onContextMenu as EventListener, { capture: true })
        if (deps.platform.gestureEvents) {
          for (const type of ['gesturestart', 'gesturechange', 'gestureend'] as const) listen(host, type, gestureHandler(type))
        }
        // A map drag never selects or drags page text; the note editor and the map's fields keep their own.
        removals.push(installSelectionDragGuard(host, (target) => keepsTextSelection(target, host)))
        // A finger on the map is the canvas's: the browser neither scrolls, zooms nor pulls the page, and shows no callout
        // (A13). The note editor turns its callout back on (text-entry-host.ts); touch-action is not inherited.
        host.style.touchAction = 'none'
        host.style.setProperty(TOUCH_CALLOUT, 'none')
        listenOnWindow = () => {
          const windowRemovals: Array<() => void> = []
          const listenWindow = (type: string, listener: EventListener): void => {
            window.addEventListener(type, listener, { capture: true })
            windowRemovals.push(() => window.removeEventListener(type, listener, { capture: true }))
          }
          const remove = (): void => runCanvasRuntimeCleanups(windowRemovals.splice(0), 'DOM input source window listener removal failed')
          try {
            listenWindow('pointermove', onPointerMove as EventListener)
            listenWindow('pointerup', onPointerUp as EventListener)
            listenWindow('pointercancel', onPointerCancel as EventListener)
          } catch (error) {
            remove()
            throw error
          }
          return remove
        }
      } catch (error) {
        try {
          detach()
        } catch {
          // Preserve the installation failure after attempting every removal.
        }
        throw error
      }
      let detached = false
      return () => {
        if (detached) return
        detached = true
        detach()
      }
    },

    apply(effects) {
      const handled = handling.at(-1) ?? null
      const event = handled?.event ?? null
      for (const effect of effects) {
        switch (effect.kind) {
          case 'prevent-default':
            if (event?.cancelable) event.preventDefault()
            break
          case 'stop-propagation':
            event?.stopImmediatePropagation()
            break
          case 'capture':
            if (effect.pointerId !== undefined) capture(effect.pointerId, handled?.rect ?? null)
            break
          case 'release-capture':
            if (effect.pointerId !== undefined) release(effect.pointerId)
            break
          case 'disown':
            // Its release was lost: no up will end it, so its native menus are the page's again (B4). The move that
            // dropped its button is its release, so a secondary press's trail starts there (a chorded right button
            // released first, U37).
            if (effect.pointerId !== undefined) disown(effect.pointerId, event instanceof MouseEvent ? event : null)
            break
          case 'drop-effect': {
            const transfer = event && 'dataTransfer' in event ? (event as DragEvent).dataTransfer : null
            if (transfer && effect.dropEffect) transfer.dropEffect = effect.dropEffect
            break
          }
          case 'set-timer':
            clearTickTimer()
            if (effect.atMs !== undefined) {
              const atMs = effect.atMs
              tickTimer = deps.timers.set(atMs - lastT, () => {
                tickTimer = null
                lastT = atMs
                sink?.({ kind: 'tick', t: atMs })
              })
            }
            break
          case 'clear-timer':
            clearTickTimer()
            break
        }
      }
    },
  }
}

function quarantine(event: Event): void {
  if (event.cancelable) event.preventDefault()
  event.stopImmediatePropagation()
}

function domEventLike(event: MouseEvent, type: DomEventLike['type'], rect: HostRect, target: TargetClass): DomEventLike {
  const pointer = event as Partial<PointerEvent>
  const wheel = event as Partial<WheelEvent>
  return {
    type,
    timeStamp: event.timeStamp,
    clientX: event.clientX - rect.left,
    clientY: event.clientY - rect.top,
    pointerId: pointer.pointerId,
    pointerType: pointer.pointerType,
    button: event.button,
    buttons: event.buttons,
    detail: event.detail,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    deltaX: wheel.deltaX,
    deltaY: wheel.deltaY,
    deltaMode: wheel.deltaMode,
    target,
  }
}

/** WebKit's GestureEvent: a UIEvent with the pointer's client point and the rotation in degrees (its scale is never read: the
 *  pinch arrives as Ctrl wheels). */
interface GestureEventFields {
  readonly clientX: number
  readonly clientY: number
  readonly rotation: number
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
}

function gestureEventLike(event: Event, type: 'gesturestart' | 'gesturechange' | 'gestureend', rect: HostRect): DomEventLike {
  const gesture = event as Event & GestureEventFields
  return {
    type,
    timeStamp: event.timeStamp,
    clientX: gesture.clientX - rect.left,
    clientY: gesture.clientY - rect.top,
    shiftKey: gesture.shiftKey,
    ctrlKey: gesture.ctrlKey,
    altKey: gesture.altKey,
    metaKey: gesture.metaKey,
    rotation: gesture.rotation,
    target: SURFACE,
  }
}

/** What a panel drag carries. On dragover the browser hides the data: a species drag is known by its type only. */
function dropPayloadOf(event: DragEvent, type: 'dragover' | 'dragleave' | 'drop'): CanvasDropPayload {
  if (type === 'dragleave') return { kind: 'unknown' }
  if (type === 'dragover') {
    if (hasSavedObjectStampDragData(event.dataTransfer)) {
      const stamp = readSavedObjectStampDragPreviewSource(event.dataTransfer)
      return stamp ? { kind: 'saved-stamp', stamp } : { kind: 'unknown' }
    }
    return hasPlantStampDragData(event.dataTransfer) ? { kind: 'species', species: null } : { kind: 'unknown' }
  }
  const stamp = readSavedObjectStampDropSource(event)
  if (stamp) return { kind: 'saved-stamp', stamp }
  const species = readPlantStampDropSource(event)
  return species ? { kind: 'species', species } : { kind: 'unknown' }
}

/** A canvas press's target: the map's surface, a handle or its own chrome, but not the note editor nor a field, menu or
 *  dialog in the map, whose native menu (copy and paste) stays. */
function isCanvasPressTarget(target: EventTarget | null, host: HTMLElement): boolean {
  const kind = classifyTarget(target, host).kind
  return kind !== 'foreign' && kind !== 'owned-text' && !allowsNativeContextMenuTarget(target)
}

/** A text field in the map, the note editor included: its own selection and text drags stay the browser's. */
function keepsTextSelection(target: EventTarget | null, host: HTMLElement): boolean {
  const element = elementOf(target)
  if (!element) return false
  return isEditableTarget(element) || closestInside(element, `${TEXT_ENTRY_SELECTOR}, input, textarea, [contenteditable="true"]`, host) !== null
}

/** Classifies an event target from data attributes (spec §1.2 `TargetClass`); a wheel reads MapLibre's controls as surface. */
function classifyTarget(target: EventTarget | null, host: HTMLElement, mapControls: 'chrome' | 'surface' = 'chrome'): TargetClass {
  const element = elementOf(target)
  if (!element) return FOREIGN
  if (!host.contains(element)) return FOREIGN
  if (closestInside(element, TEXT_ENTRY_SELECTOR, host)) return OWNED_TEXT
  const handle = handleIdOf(element, host)
  if (handle) return { kind: 'handle', id: handle }
  if (closestInside(element, OWNED_CHROME_SELECTOR, host)) return OWNED_CHROME
  if (mapControls === 'chrome' && closestInside(element, MAP_CONTROL_SELECTOR, host)) return OWNED_CHROME
  return SURFACE
}

/** The handle layer (chrome/handle-layer.ts) names each handle it shows. */
function handleIdOf(element: Element, host: HTMLElement): ToolHandleId | null {
  const handle = closestInside(element, '[data-canvas-handle]', host)
  return handle ? handle.getAttribute('data-canvas-handle') as ToolHandleId : null
}

function closestInside(element: Element, selector: string, host: HTMLElement): Element | null {
  const match = element.closest(selector)
  return match && host.contains(match) ? match : null
}

function elementOf(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target
  return target instanceof Node ? target.parentElement : null
}
