// canvas/runtime/input/recognise.ts  (the recogniser: its two state types and its two functions)
//
// Owns gesture recognition: a pure reducer from one RawInput to gestures and the effects the DOM source applies to the
// event it is handling. No clock, timer or DOM: time is `RawInput.t`, the platform and thresholds come in the config.
// PointerSession and TouchPair are type exports imported only inside input/; RecogniserState is opaque to callers.
// raw-input.ts and recognise.ts import each other's types with `import type` only (no runtime cycle).
//
// It implements spec §2.2 and §5 (fixtures in __fixtures__/sequences.ts): one pointer session at a time, or two fingers;
// a secondary press (the right button, a Mac Control-click, a pen's barrel) pending until it passes 3 px: a still release
// opens the menu at the release point (none in overview), carrying the handle it pressed (A16), a drag pans, and with Shift at the press it turns the view,
// stepped while mod is held; no native contextmenu reaches it (the DOM source's listener prevents them); a middle drag, a
// press with Space held (on a handle too), a primary press in overview and the Pan tool's primary drag pan, a pointer pan
// carrying the pointer's point and a Pan-tool press ending with cancel('navigate') after its drag; an overview press, which
// no tool hears, released within its slop ending in a tap with no press (the Design pin's, canopi-n2cg, whose fit consumes the rest of its click series); a Shift+middle drag
// rotating about its press once it passes 3 px (silent before, so a still click turns nothing), stepped while mod is
// held, with the wheel ignored while a pointer rotate lives;
// a button-less move over owned chrome, the text entry or a handle ends the hover; wheels, over the map or a handle, zoom
// or pan by the pointing-device setting; a WebKit trackpad twist rotating past 10° as a session of its own.
// A touch press is held (spec §2.2 "Touch", A2): the host hears nothing until the finger passes 8 px (its press at
// the down point, then the drag) or lifts (its press and tap at the down point), so a pinch never reaches a tool; a
// second finger before the slop ends the held press silently, and one after the drag started cancels it ('multitouch');
// the fingers left resume nothing until every one is up. Two fingers pan by their centroid, zoom about it past 0.1 zoom
// level and turn about it past 25 px of arc (MapLibre's two-finger rules), and a pair ends in place, whatever ends it
// (A5, A6, A12, A14). A held press still for 500 ms opens the menu (the 'tick' of the
// deadline the source schedules) and goes spent: its lift emits nothing and stops propagation, so the open menu never
// hears it (A4).

import type { CancelReason, Modifiers, PointerKind, ToolHandleId } from '../interaction-types'
import { ROTATE_DEG_PER_PX } from '../../../geo/view/navigation-policy'
import type { ScreenPoint } from '../../../geo/view/types'
import type { Gesture, NavigationSource, PressTarget } from './gestures'
import { modKeyIsCmd, type InputPlatform } from './platform'
import type { AdapterEffect, ButtonRole, RawInput, RecogniserConfig, RecogniserState } from './raw-input'

export interface PointerSession {
  readonly pointerId: number
  readonly pointer: PointerKind
  readonly role: ButtonRole
  /** 'pending' is a primary press within slop; 'secondary' a secondary press within 3 px (a menu on release, a pan past
   *  it); 'primary' a primary drag past slop; 'pan' a navigation pan; 'rotate' a rotate, which turns the view only once
   *  `slopPassed` (until then it is pending and silent, and a secondary one still opens the menu on release); 'held' a
   *  touch press within its slop, which the host has not heard; 'pair' one of two fingers navigating (the pair's state is
   *  `RecogniserState.touchPair`); 'spent' a finger that does nothing more until it lifts. */
  readonly mode: 'pending' | 'secondary' | 'primary' | 'pan' | 'rotate' | 'held' | 'pair' | 'spent'
  readonly start: ScreenPoint
  readonly last: ScreenPoint
  readonly slopPassed: boolean
  readonly captured: boolean
  /** The pan's or the rotate's source while `mode` is 'pan' or 'rotate'. */
  readonly navigation: NavigationSource | null
  /** True when a `press` reached the host, which owes it one end: a `tap` within slop, else `cancel('navigate')` for a pan
   *  (the Pan tool's press). */
  readonly pressed: boolean
  /** The press's click count: the platform's pointerdown `detail`, or the recogniser's own count when that is higher
   *  (clickCountOf). */
  readonly clickCount: number
  /** The PointerEvent.buttons bit of the button the press holds: the primary one for a consumed Mac Control press. A
   *  navigation or still secondary session whose move lacks it lost its release (spec §2.2 "Drag end"). */
  readonly buttonBit: number
  /** A held touch press's press, sent when it resolves (past its slop or at its lift); null when the host hears none (an
   *  overview or Space pan). */
  readonly heldPress: { readonly target: PressTarget; readonly mods: Modifiers } | null
  /** The handle the press landed on, or null: a still secondary release or a long press carries it on its menu request,
   *  so the host can offer that point's menu (A16). */
  readonly pressHandle: ToolHandleId | null
}

/** Two fingers navigating, per MapLibre's two-finger handlers (two_fingers_touch.ts): each move pans by the centroid's
 *  movement, zooms about the centroid once the distance has changed 0.1 zoom level from the start, and turns about it once
 *  the vector has turned 25 px of arc over the smallest diameter seen, each counted from the last move once active. */
export interface TouchPair {
  readonly ids: readonly [number, number]
  readonly points: readonly [ScreenPoint, ScreenPoint]
  readonly startDistancePx: number
  readonly startVector: ScreenPoint
  readonly minDiameterPx: number
  readonly zooming: boolean
  /** The turn since it started (rotate's totalDeltaDeg), or null before the twist passes its threshold. */
  readonly twistDeg: number | null
}

const ZERO: ScreenPoint = Object.freeze({ x: 0, y: 0 })
/** A finger's own modes: no button bit ends them early (a touch lift always comes). */
const TOUCH_MODES: ReadonlySet<PointerSession['mode']> = new Set(['held', 'pair', 'spent'])
/** Wheel zoom: today's exp(clamp(−dy × 0.002, ±1)) per event. */
const WHEEL_ZOOM_PER_PX = 0.002
/** A secondary press, and a pointer rotate, start past this travel from the press (MapLibre's clickTolerance); a tool's
 *  own slop never applies. */
const NAVIGATION_SLOP_PX = 3
/** The session id of a WebKit trackpad twist, which has no pointer: browsers number pointers from 0. */
const TRACKPAD_TWIST_ID = -1
/** PointerEvent.buttons bits. */
const BUTTON_BITS: Readonly<Record<ButtonRole, number>> = Object.freeze({ primary: 1, secondary: 2, auxiliary: 4 })

export function initialRecogniserState(): RecogniserState {
  return {
    sessions: new Map(),
    touchPair: null,
    held: { space: false },
    trackpadTwistDeg: 0,
    deadlines: { longPressAt: null },
    lastPrimaryPress: null,
    context: { tool: 'select', mode: 'site', pointingDevice: 'mouse' },
  }
}

interface Step {
  state: RecogniserState
  readonly gestures: Gesture[]
  readonly effects: AdapterEffect[]
}

export function recognise(
  state: RecogniserState,
  input: RawInput,
  config: RecogniserConfig,
): { readonly state: RecogniserState; readonly gestures: readonly Gesture[]; readonly effects: readonly AdapterEffect[] } {
  const step: Step = { state, gestures: [], effects: [] }
  switch (input.kind) {
    case 'down': down(step, input, config); break
    case 'move': move(step, input, config); break
    case 'up': up(step, input, config); break
    case 'cancel': cancel(step, input); break
    case 'reject': reject(step, input.id); break
    case 'consume-click-series': {
      const previous = step.state.lastPrimaryPress
      if (previous) step.state = { ...step.state, lastPrimaryPress: { ...previous, consumed: true } }
      break
    }
    case 'leave': step.gestures.push({ kind: 'hover-end' }); break
    case 'escape':
      endLiveSessions(step, 'escape')
      releaseSpace(step)
      break
    case 'key-state':
      step.state = { ...step.state, held: { space: input.space } }
      restepRotate(step, input.mods, config.platform)
      break
    case 'configure': configure(step, input.context); break
    case 'wheel': wheel(step, input); break
    case 'drop':
      // Dragover and drop are always default-prevented (the drop target); dragleave is only observed.
      if (input.phase !== 'leave') step.effects.push({ kind: 'prevent-default' })
      step.gestures.push({ kind: 'drop', phase: input.phase, at: input.at, payload: input.payload })
      break
    case 'platform-gesture': platformGesture(step, input, config); break
    case 'focus-out':
      // The session ends the nudge series (ToolHost.endNudgeSeries); no pointer state changes.
      break
    case 'tick': tick(step, input.t); break
  }
  settleDeadline(step)
  return { state: step.state, gestures: step.gestures, effects: step.effects }
}

type RawOf<K extends RawInput['kind']> = Extract<RawInput, { kind: K }>

function down(step: Step, input: RawOf<'down'>, config: RecogniserConfig): void {
  // The note editor, the canvas's own buttons and fields, and anything outside the map keep their own presses.
  if (input.target.kind === 'owned-text' || input.target.kind === 'owned-chrome' || input.target.kind === 'foreign') return

  const live = step.state.sessions.get(input.id)
  // A down for a live pointer id: its up was lost. End that session first.
  if (live) endSession(step, live, 'pointercancel')
  if (input.pointer === 'touch' && input.role === 'primary' && step.state.sessions.size > 0) {
    otherFinger(step, input)
    return
  }
  // One pointer session at a time: a second pointer is ignored for the rest of the session.
  if (step.state.sessions.size > 0) return

  const consumed = step.state.lastPrimaryPress?.consumed === true
  const clickCount = clickCountOf(step, input, config)
  if (consumed && input.role === 'primary' && clickCount > 1) {
    // A later press of a click series the host consumed (the Design pin's fit, canopi-n2cg): captured, it does nothing
    // until it lifts, and the series stays consumed.
    step.state = { ...step.state, lastPrimaryPress: { ...step.state.lastPrimaryPress!, consumed: true } }
    step.effects.push({ kind: 'prevent-default' }, { kind: 'capture', pointerId: input.id })
    putSession(step, {
      pointerId: input.id, pointer: input.pointer, role: input.role, start: input.at, last: input.at, slopPassed: false,
      clickCount, buttonBit: BUTTON_BITS.primary, heldPress: null, pressHandle: null, mode: 'spent', captured: true,
      navigation: null, pressed: false,
    })
    return
  }
  const { context, held } = step.state
  const base = {
    pointerId: input.id,
    pointer: input.pointer,
    role: input.role,
    start: input.at,
    last: input.at,
    slopPassed: false,
    clickCount,
    buttonBit: input.ctrlConsumed ? BUTTON_BITS.primary : BUTTON_BITS[input.role],
    heldPress: null,
    pressHandle: input.target.kind === 'handle' ? input.target.id : null,
  } as const

  const pressTarget: PressTarget = input.target.kind === 'handle' ? { kind: 'handle', id: input.target.id } : { kind: 'surface' }

  if (input.role === 'secondary') {
    // Pending and silent until it passes 3 px, in every tool and in overview: a still release opens the menu, a drag
    // pans, or turns the view when Shift was held at the press (only Shift at the press decides; spec §2.2).
    step.effects.push({ kind: 'prevent-default' }, { kind: 'capture', pointerId: input.id })
    putSession(step, { ...base, mode: input.mods.shift ? 'rotate' : 'secondary', captured: true, navigation: 'secondary-drag', pressed: false })
    return
  }

  if (input.role === 'auxiliary' && input.mods.shift) {
    // Shift+middle (checked before overview, fixture G9c): a pending rotate, silent until it passes its slop, so a still
    // click turns nothing (G9b). Shift at the press decides the mode for the whole session.
    step.effects.push({ kind: 'prevent-default' }, { kind: 'capture', pointerId: input.id })
    putSession(step, { ...base, mode: 'rotate', captured: true, navigation: 'auxiliary-drag', pressed: false })
    return
  }

  let navigation: NavigationSource | null = null
  let pressed = true
  if (input.role === 'auxiliary') {
    // A plain middle drag pans; a middle tap does nothing.
    navigation = 'auxiliary-drag'
    pressed = false
  } else if (context.mode === 'overview') {
    // Overview draws no zones or notes, so a left press pans in every tool, for every pointer, and its press never reaches
    // the host (U36); a still one ends in a tap, which only the Design pin hears (canopi-n2cg).
    navigation = 'primary-drag'
    pressed = false
  } else if (held.space) {
    // Space at the press pans, a press on a handle included (fixture G3b).
    navigation = 'space-drag'
    pressed = false
  } else if (pressTarget.kind === 'handle') {
    // A handle drags before the Pan tool pans (today's order).
  } else if (context.tool === 'hand') {
    // The Pan tool: the drag pans, and the press and tap still reach the host.
    navigation = 'primary-drag'
  }

  // A primary or middle press is always default-prevented (no text selection, autoscroll or Linux paste) and captured.
  step.effects.push({ kind: 'prevent-default' }, { kind: 'capture', pointerId: input.id })
  if (input.pointer === 'touch' && input.role === 'primary') {
    // The finger's press waits for its slop or its lift (A2); a pan of its own starts only past the slop.
    putSession(step, {
      ...base,
      mode: 'held',
      captured: true,
      navigation,
      pressed: false,
      heldPress: pressed ? { target: pressTarget, mods: input.mods } : null,
    })
    // A press the host would hear opens the menu if it stays still (none in overview or with Space).
    if (pressed) {
      const longPressAt = input.t + config.thresholds.longPressMs
      step.state = { ...step.state, deadlines: { longPressAt } }
      step.effects.push({ kind: 'set-timer', atMs: longPressAt })
    }
    return
  }
  putSession(step, {
    ...base,
    mode: navigation ? 'pan' : 'pending',
    captured: true,
    navigation,
    pressed,
  })
  if (pressed) step.gestures.push(pressOf(input, pressTarget, clickCount))
  if (navigation) step.gestures.push({ kind: 'pan', phase: 'start', deltaPx: ZERO, source: navigation, at: input.at })
}

function move(step: Step, input: RawOf<'move'>, config: RecogniserConfig): void {
  const session = step.state.sessions.get(input.id)
  if (!session) {
    // A finger whose session ended while it stayed down (Esc or a tool change mid-pinch, a refused press) moves nothing:
    // touch never hovers.
    if (step.state.sessions.size > 0 || input.pointer === 'touch') return
    hover(step, input)
    return
  }

  // A navigation or still secondary session whose move lacks its button lost its release (MapLibre's isValidMoveEvent):
  // it ends as a release would, then the host hears the press end. A primary session waits for the next down instead,
  // so a Mac Control-drag is never cut short (spec §2.2 "Drag end").
  if (session.mode !== 'pending' && session.mode !== 'primary' && !TOUCH_MODES.has(session.mode)
    && (input.buttonMask & session.buttonBit) === 0) {
    endWithLostRelease(step, session)
    return
  }
  if (session.mode === 'spent') return
  if (session.mode === 'pair') {
    pairMove(step, session.pointerId, input.at, config)
    return
  }
  // Any other button added or dropped mid-session changes nothing (the session keeps its mode until its up).
  if (session.mode === 'rotate') {
    rotateMove(step, session, input, config.platform)
    return
  }
  const slopPassed = session.slopPassed || passesSlop(session, input.at, config)
  if (session.mode === 'secondary') {
    if (Math.hypot(input.at.x - session.start.x, input.at.y - session.start.y) < NAVIGATION_SLOP_PX) return
    // Past the slop the pan starts at the press, and its first move carries the whole travel so far.
    putSession(step, { ...session, mode: 'pan', last: input.at, slopPassed: true })
    step.gestures.push(
      { kind: 'pan', phase: 'start', deltaPx: ZERO, source: 'secondary-drag', at: session.start },
      { kind: 'pan', phase: 'move', deltaPx: { x: input.at.x - session.start.x, y: input.at.y - session.start.y }, source: 'secondary-drag', at: input.at },
    )
    return
  }
  if (session.mode === 'held') {
    // Silent within its slop, but tracked: a second finger seeds the pair from where this one is.
    if (!slopPassed) {
      putSession(step, { ...session, last: input.at })
      return
    }
    if (session.navigation) {
      // Overview, the Pan tool or Space: the pan starts at the press, and its first move carries the whole travel so far.
      putSession(step, { ...session, mode: 'pan', last: input.at, slopPassed: true, heldPress: null })
      step.gestures.push(
        { kind: 'pan', phase: 'start', deltaPx: ZERO, source: session.navigation, at: session.start },
        { kind: 'pan', phase: 'move', deltaPx: { x: input.at.x - session.start.x, y: input.at.y - session.start.y }, source: session.navigation, at: input.at },
      )
      return
    }
    putSession(step, { ...session, mode: 'primary', last: input.at, slopPassed: true, pressed: true, heldPress: null })
    step.gestures.push(heldPressOf(session), { kind: 'drag-start', id: session.pointerId, at: input.at, mods: input.mods })
    return
  }
  if (session.mode === 'pan') {
    const deltaPx = { x: input.at.x - session.last.x, y: input.at.y - session.last.y }
    putSession(step, { ...session, last: input.at, slopPassed })
    if ((deltaPx.x !== 0 || deltaPx.y !== 0) && session.navigation) {
      step.gestures.push({ kind: 'pan', phase: 'move', deltaPx, source: session.navigation, at: input.at })
    }
    return
  }
  if (session.mode === 'pending') {
    if (!slopPassed) return
    putSession(step, { ...session, mode: 'primary', last: input.at, slopPassed: true })
    step.gestures.push({ kind: 'drag-start', id: session.pointerId, at: input.at, mods: input.mods })
    return
  }
  if (session.mode === 'primary') {
    putSession(step, { ...session, last: input.at })
    step.gestures.push({ kind: 'drag-move', id: session.pointerId, at: input.at, mods: input.mods })
  }
}

function up(step: Step, input: RawOf<'up'>, config: RecogniserConfig): void {
  const session = step.state.sessions.get(input.id)
  if (!session) return
  if (session.mode === 'pair') {
    // One finger lifts: the pair ends in place, and the other finger resumes nothing.
    endPair(step, session.pointerId, null)
    return
  }
  dropSession(step, session)
  if (session.mode === 'spent') {
    // The lift after a long press (or of a finger left from a pair) reaches nothing: the menu it opened stays open.
    step.effects.push({ kind: 'prevent-default' }, { kind: 'stop-propagation' })
    return
  }
  if (session.mode === 'held') {
    // A lift within the slop: the press and its tap, both at the down point (A2), unless the host hears none.
    if (session.heldPress) {
      step.gestures.push(heldPressOf(session), { kind: 'tap', id: session.pointerId, at: session.start, pointer: session.pointer, mods: input.mods, clickCount: session.clickCount })
    } else if (isOverviewPress(step, session)) {
      step.gestures.push({ kind: 'tap', id: session.pointerId, at: session.start, pointer: session.pointer, mods: input.mods, clickCount: session.clickCount })
    }
    return
  }
  if (session.role === 'secondary' && !session.slopPassed) {
    // A still secondary click: the menu at the release point (convention), Shift or not; overview has none.
    if (step.state.context.mode !== 'overview') step.gestures.push(menuRequestOf(session, input.at, 'mouse'))
    return
  }
  if (session.mode === 'rotate') {
    // A rotate that never passed its slop ends as it began: silently.
    if (session.slopPassed) step.gestures.push(rotateOf(session, 'end', session.last, stepsRotate(input.mods, config.platform)))
    return
  }
  if (session.mode === 'pan') {
    if (session.navigation) step.gestures.push(panEndOf(session))
    // A Pan-tool press the host saw ends once: a tap after a still click, or cancel('navigate') after its drag panned.
    if (session.pressed) step.gestures.push(session.slopPassed ? { kind: 'cancel', reason: 'navigate' } : tapOf(session, input))
    else if (!session.slopPassed && isOverviewPress(step, session)) step.gestures.push(tapOf(session, input))
    return
  }
  if (session.mode === 'pending') {
    step.gestures.push(tapOf(session, input))
    return
  }
  step.gestures.push({ kind: 'drag-end', id: session.pointerId, at: input.at, mods: input.mods })
}

function cancel(step: Step, input: RawOf<'cancel'>): void {
  if (input.id === 'all') {
    endLiveSessions(step, input.reason)
    releaseSpace(step)
    return
  }
  const session = step.state.sessions.get(input.id)
  if (!session) return
  if (input.reason === 'lost-capture') {
    // Only a capture the session holds can be lost; the browser already released it.
    if (!session.captured) return
    const lost = { ...session, captured: false }
    putSession(step, lost)
    endSession(step, lost, 'lost-capture')
  } else {
    endSession(step, session, input.reason)
  }
  releaseSpace(step)
}

/** The host refused the press: the session ends with no gesture (its later moves are hovers). A session whose press the
 *  host never heard (a pan or rotate of its own) has nothing to refuse, so a live rotate always ends with its camera. */
function reject(step: Step, id: number): void {
  const session = step.state.sessions.get(id)
  if (!session?.pressed) return
  dropSession(step, session)
}

/**
 * The session sends one configure per setTool call, per overview change and per pointing-device change. Each ends the
 * live sessions ('tool-change') except one that, for the same tool, only leaves overview or only changes the pointing
 * device: today's setTool cancels the live gesture whatever the tool, so re-arming the armed tool is a fence too, and
 * entering overview cancels it and releases Space. A touch pair is the exception: its own zoom publishes the overview
 * frame mid-pinch, so entering overview leaves a pinch going (the pair is the only live session then).
 */
function configure(step: Step, context: RawOf<'configure'>['context']): void {
  const previous = step.state.context
  const enteringOverview = context.mode === 'overview' && previous.mode !== 'overview'
  const leavingOverview = context.mode !== 'overview' && previous.mode === 'overview'
  const deviceChanged = context.pointingDevice !== previous.pointingDevice
  const settingOnly = context.tool === previous.tool
    && (enteringOverview ? step.state.touchPair !== null : leavingOverview || deviceChanged)
  if (!settingOnly) endLiveSessions(step, 'tool-change')
  if (enteringOverview) releaseSpace(step)
  step.state = {
    ...step.state,
    context: {
      tool: context.tool,
      mode: context.mode,
      pointingDevice: context.pointingDevice,
    },
  }
}

function wheel(step: Step, input: RawOf<'wheel'>): void {
  // The note editor and the canvas's own chrome keep their wheels (not prevented); no handle uses the wheel, so a wheel over
  // one is a map wheel (U38, fixture F15b).
  if (input.target.kind !== 'surface' && input.target.kind !== 'handle') return
  step.effects.push({ kind: 'prevent-default' })
  // A pointer rotate owns the camera from its press, so Esc restores exactly the camera it pressed on (fixture F18).
  if (pointerRotateLive(step.state)) return
  const { dxPx, dyPx, mods } = input
  if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return
  const scrollPans = step.state.context.pointingDevice === 'trackpad'
  // A pinch arrives as a Ctrl wheel: it, Ctrl and Cmd wheels zoom whatever the setting says, continuously by their delta (one
  // path, no notch detection: a 100 px notch is ×1.22).
  if (mods.ctrl || mods.meta || (!scrollPans && !mods.shift)) {
    const factor = Math.exp(Math.max(-1, Math.min(1, -dyPx * WHEEL_ZOOM_PER_PX)))
    if (factor !== 1) step.gestures.push({ kind: 'zoom', anchorPx: input.at, factor, source: 'wheel' })
    return
  }
  // A mouse wheel has one axis: under the Trackpad setting Shift turns its scroll sideways.
  const deltaPx = scrollPans && mods.shift && dxPx === 0 ? { x: -dyPx, y: 0 } : { x: -dxPx, y: -dyPx }
  if (deltaPx.x === 0 && deltaPx.y === 0) return
  step.gestures.push({ kind: 'pan', phase: 'move', deltaPx: withoutNegativeZero(deltaPx), source: 'wheel' })
}

/**
 * A move with no live session (buttons or not) is a hover wherever the source heard it: over the map, off it at the point a
 * hover left it (carried by the leave), or off it while the source still follows a pressed pointer whose session ended
 * (an Esc mid-press); off the map the host clears its own hover and the tool's still runs. Over the canvas's own things (owned chrome such as the attribution, the text entry,
 * a handle) it ends the hover and its tooltip (spec §2.2 "Hover", U6).
 */
function hover(step: Step, input: RawOf<'move'>): void {
  const { target } = input
  if (target.kind === 'owned-text' || target.kind === 'handle' || target.kind === 'owned-chrome') {
    step.gestures.push({ kind: 'hover-end' })
    return
  }
  step.gestures.push({ kind: 'hover', at: input.at, pointer: input.pointer, mods: input.mods, target })
}

/** −0 (a negated zero delta) reads as 0, so a pan's delta compares equal to the plain vector. */
function withoutNegativeZero(point: ScreenPoint): ScreenPoint {
  return { x: point.x === 0 ? 0 : point.x, y: point.y === 0 ? 0 : point.y }
}

function passesSlop(session: PointerSession, at: ScreenPoint, config: RecogniserConfig): boolean {
  const slop = config.thresholds.dragSlopPx[session.pointer]
  const distance = Math.hypot(at.x - session.start.x, at.y - session.start.y)
  return distance >= slop && distance > 0
}

/**
 * The press's click count: the platform's `detail`, or one more than the previous primary press's count when this primary
 * press comes within `multiClickMs` and `multiClickSlopPx` of it from the same kind of pointer, whichever is higher, so a
 * double-click finishes a polygon, adds a corner or opens a note on an engine whose pointerdown sends `detail` 0. Any
 * other press starts the count again.
 */
function clickCountOf(step: Step, input: RawOf<'down'>, config: RecogniserConfig): number {
  const previous = step.state.lastPrimaryPress
  if (input.role !== 'primary') {
    step.state = { ...step.state, lastPrimaryPress: null }
    return input.detail
  }
  const follows = previous !== null
    && previous.pointer === input.pointer
    && input.t - previous.t <= config.thresholds.multiClickMs
    && Math.hypot(input.at.x - previous.at.x, input.at.y - previous.at.y) <= config.thresholds.multiClickSlopPx[input.pointer]
  const count = Math.max(input.detail, follows ? previous.count + 1 : 1)
  step.state = { ...step.state, lastPrimaryPress: { t: input.t, at: input.at, pointer: input.pointer, count, consumed: false } }
  return count
}

/**
 * A touch down while another pointer is live (spec §2.2 "Touch"): a second finger on a held press ends it silently, the
 * host having heard nothing; on a finger past its slop it cancels the drag or pan ('multitouch'). Either way the pair
 * starts. A third finger, a finger beside a spent one (a long press) or beside a mouse or pen session is ignored.
 */
function otherFinger(step: Step, input: RawOf<'down'>): void {
  const others = [...step.state.sessions.values()]
  const first = others[0]!
  if (others.length > 1 || first.pointer !== 'touch' || first.mode === 'spent') return
  if (first.mode !== 'held') endGestures(step, first, 'multitouch')
  const points: [ScreenPoint, ScreenPoint] = [first.last, input.at]
  const vector = minus(points[0], points[1])
  putSession(step, { ...first, mode: 'pair', heldPress: null, navigation: 'touch-two-finger' })
  // A tap after the pair is a first click.
  step.state = {
    ...step.state,
    lastPrimaryPress: null,
    touchPair: {
      ids: [first.pointerId, input.id],
      points,
      startDistancePx: Math.hypot(vector.x, vector.y),
      startVector: vector,
      minDiameterPx: Math.hypot(vector.x, vector.y),
      zooming: false,
      twistDeg: null,
    },
  }
  step.effects.push({ kind: 'prevent-default' }, { kind: 'capture', pointerId: input.id })
  putSession(step, {
    pointerId: input.id,
    pointer: input.pointer,
    role: input.role,
    mode: 'pair',
    start: input.at,
    last: input.at,
    slopPassed: false,
    captured: true,
    navigation: 'touch-two-finger',
    pressed: false,
    clickCount: 0,
    buttonBit: BUTTON_BITS.primary,
    heldPress: null,
    pressHandle: null,
  })
  // Pair pans carry no point: a touch never moves the resting hover (A14).
  step.gestures.push({ kind: 'pan', phase: 'start', deltaPx: ZERO, source: 'touch-two-finger' })
}

/**
 * One finger of the pair moved: pan by the centroid's movement, zoom about the new centroid, then turn about it (MapLibre's
 * pinchAround order, A5). The zoom starts once the distance is 0.1 zoom level from its start, and the twist once the
 * vector has turned `twistStartArcPx` of arc over the smallest diameter seen; each then counts from the last move, so
 * the view never jumps by the threshold (MapLibre 6.10.0 two_fingers_touch.ts `_move` and `_isBelowThreshold`,
 * BSD-3-Clause, Copyright (c) 2023 MapLibre contributors; A12).
 */
function pairMove(step: Step, id: number, at: ScreenPoint, config: RecogniserConfig): void {
  const pair = step.state.touchPair
  if (!pair) return
  const index = pair.ids[0] === id ? 0 : 1
  const last = pair.points
  const points: [ScreenPoint, ScreenPoint] = index === 0 ? [at, last[1]] : [last[0], at]
  const centroid = midpoint(points[0], points[1])
  const lastCentroid = midpoint(last[0], last[1])
  const deltaPx = withoutNegativeZero(minus(centroid, lastCentroid))
  if (deltaPx.x !== 0 || deltaPx.y !== 0) step.gestures.push({ kind: 'pan', phase: 'move', deltaPx, source: 'touch-two-finger' })

  const vector = minus(points[0], points[1])
  const lastVector = minus(last[0], last[1])
  const distance = Math.hypot(vector.x, vector.y)
  const lastDistance = Math.hypot(lastVector.x, lastVector.y)
  let { zooming, twistDeg, minDiameterPx } = pair
  if (distance > 0 && lastDistance > 0 && pair.startDistancePx > 0) {
    zooming = zooming || Math.abs(Math.log2(distance / pair.startDistancePx)) >= config.thresholds.pinchZoomStartLevels
    if (zooming && distance !== lastDistance) {
      step.gestures.push({ kind: 'zoom', anchorPx: centroid, factor: distance / lastDistance, source: 'touch-two-finger' })
    }
  }
  if (twistDeg === null) {
    minDiameterPx = Math.min(minDiameterPx, distance)
    const thresholdDeg = (config.thresholds.twistStartArcPx / (Math.PI * minDiameterPx)) * 360
    if (!(Math.abs(angleBetweenDeg(vector, pair.startVector)) < thresholdDeg)) {
      twistDeg = 0
      step.gestures.push({ kind: 'rotate', phase: 'start', anchorPx: centroid, totalDeltaDeg: 0, step: false, source: 'touch-two-finger' })
    }
  }
  if (twistDeg !== null) {
    // The ground follows the fingers: a clockwise twist on screen lowers the bearing (MapLibre's bearingDelta).
    twistDeg += angleBetweenDeg(vector, lastVector)
    step.gestures.push({ kind: 'rotate', phase: 'move', anchorPx: centroid, totalDeltaDeg: twistDeg, step: false, source: 'touch-two-finger' })
  }
  step.state = { ...step.state, touchPair: { ...pair, points, zooming, twistDeg, minDiameterPx } }
  const session = step.state.sessions.get(id)
  if (session) putSession(step, { ...session, last: at })
}

/**
 * The pair ends in place, whatever ends it (A6): the pan ends and a live turn ends with its north snap, never restoring
 * the camera; a fence (`reason`) also sends the host its cancel. `liftedId` is the finger that lifted or was taken: the
 * other one goes spent; with none, both fingers end.
 */
function endPair(step: Step, liftedId: number | null, reason: CancelReason | null): void {
  const pair = step.state.touchPair
  if (!pair) return
  const centroid = midpoint(pair.points[0], pair.points[1])
  step.state = { ...step.state, touchPair: null }
  for (const id of pair.ids) {
    const session = step.state.sessions.get(id)
    if (!session) continue
    if (liftedId === null || id === liftedId) dropSession(step, session)
    else putSession(step, { ...session, mode: 'spent', navigation: null })
  }
  step.gestures.push({ kind: 'pan', phase: 'end', deltaPx: ZERO, source: 'touch-two-finger' })
  if (pair.twistDeg !== null) {
    step.gestures.push({ kind: 'rotate', phase: 'end', anchorPx: centroid, totalDeltaDeg: pair.twistDeg, step: false, source: 'touch-two-finger' })
  }
  if (reason) step.gestures.push({ kind: 'cancel', reason })
}

function minus(a: ScreenPoint, b: ScreenPoint): ScreenPoint {
  return { x: a.x - b.x, y: a.y - b.y }
}

function midpoint(a: ScreenPoint, b: ScreenPoint): ScreenPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** MapLibre's getBearingDelta: Point#angleWith(b), in degrees. */
function angleBetweenDeg(a: ScreenPoint, b: ScreenPoint): number {
  return (Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) * 180) / Math.PI
}

/** The long press: a held press still at its deadline opens the menu at its down point, and goes spent (A4). */
function tick(step: Step, t: number): void {
  const { longPressAt } = step.state.deadlines
  if (longPressAt === null || t < longPressAt) return
  step.state = { ...step.state, deadlines: { longPressAt: null } }
  const held = [...step.state.sessions.values()].find((session) => session.mode === 'held' && session.heldPress !== null)
  if (!held) return
  putSession(step, { ...held, mode: 'spent', heldPress: null })
  step.gestures.push(menuRequestOf(held, held.start, 'long-press'))
}

/** A pointer's menu request, carrying the handle its press landed on (A16). */
function menuRequestOf(session: PointerSession, at: ScreenPoint, source: 'mouse' | 'long-press'): Gesture {
  return session.pressHandle === null
    ? { kind: 'menu-request', at, source }
    : { kind: 'menu-request', at, source, handle: session.pressHandle }
}

/** The long-press deadline lives only while a held press waits for it: anything that resolves or ends it clears it. */
function settleDeadline(step: Step): void {
  if (step.state.deadlines.longPressAt === null) return
  for (const session of step.state.sessions.values()) {
    if (session.mode === 'held' && session.heldPress !== null) return
  }
  step.state = { ...step.state, deadlines: { longPressAt: null } }
  step.effects.push({ kind: 'clear-timer' })
}

/** A held touch press as the host hears it once it resolves: at the down point, with the down's modifiers and target. */
function heldPressOf(session: PointerSession): Gesture {
  const held = session.heldPress!
  return { kind: 'press', id: session.pointerId, at: session.start, pointer: session.pointer, mods: held.mods, clickCount: session.clickCount, target: held.target }
}

function pressOf(input: RawOf<'down'>, target: PressTarget, clickCount: number): Gesture {
  return { kind: 'press', id: input.id, at: input.at, pointer: input.pointer, mods: input.mods, clickCount, target }
}

/** A pointer pan's end, where the pointer last was: the router moves the host's resting pointer there. */
function panEndOf(session: PointerSession): Gesture {
  return { kind: 'pan', phase: 'end', deltaPx: ZERO, source: session.navigation!, at: session.last }
}

/**
 * A WebKit trackpad twist (gesturestart, gesturechange, gestureend; spec §2.2): only its rotation is used, since WKWebView
 * delivers the pinch as Ctrl wheels, which zoom as everywhere. It is a session under TRACKPAD_TWIST_ID, so Esc, blur and
 * configure end it like a pointer rotate: silent until the twist exceeds the threshold, then a rotate about the gesture's
 * point with the threshold subtracted, the ground following the fingers (WebKit's rotation is clockwise-positive; a
 * clockwise twist lowers the bearing). `trackpadTwistDeg` holds the rotation up to the change that crossed the threshold,
 * whose sign says which way the threshold is subtracted. One session at a time: a twist that starts during a pointer
 * session is ignored to its end, and a press during a twist is ignored (`down`). On iOS the pointers are the one source:
 * every gesture event is prevented and ignored. Every gesture event is prevented, so the page never zooms itself.
 */
function platformGesture(step: Step, input: RawOf<'platform-gesture'>, config: RecogniserConfig): void {
  step.effects.push({ kind: 'prevent-default' })
  if (config.platform.os === 'ios') return
  const live = step.state.sessions.get(TRACKPAD_TWIST_ID)
  if (input.phase === 'start') {
    // A start with a twist still live: its end was lost.
    if (live) endSession(step, live, 'pointercancel')
    if (step.state.sessions.size > 0) return
    putSession(step, {
      pointerId: TRACKPAD_TWIST_ID,
      // No button or pointer kind: the twist reads neither.
      pointer: 'mouse',
      role: 'auxiliary',
      mode: 'rotate',
      start: input.at,
      last: input.at,
      slopPassed: false,
      captured: false,
      navigation: 'trackpad-twist',
      pressed: false,
      clickCount: 0,
      buttonBit: 0,
      heldPress: null,
      pressHandle: null,
    })
    step.state = { ...step.state, trackpadTwistDeg: 0 }
    return
  }
  if (!live) return
  if (!live.slopPassed && input.phase === 'change') {
    step.state = { ...step.state, trackpadTwistDeg: input.rotationDeg }
    if (!(Math.abs(input.rotationDeg) > config.thresholds.trackpadTwistStartDeg)) return
    putSession(step, { ...live, slopPassed: true })
    step.gestures.push(twistOf(live, 'start', 0))
  }
  const subtractedDeg = Math.sign(step.state.trackpadTwistDeg) * config.thresholds.trackpadTwistStartDeg
  const totalDeltaDeg = subtractedDeg - input.rotationDeg
  if (input.phase === 'change') {
    step.gestures.push(twistOf(live, 'move', totalDeltaDeg))
    return
  }
  dropSession(step, live)
  if (live.slopPassed) step.gestures.push(twistOf(live, 'end', totalDeltaDeg))
}

function twistOf(session: PointerSession, phase: 'start' | 'move' | 'end', totalDeltaDeg: number): Gesture {
  return { kind: 'rotate', phase, anchorPx: session.start, totalDeltaDeg, step: false, source: 'trackpad-twist' }
}

/**
 * A pointer rotate's move: nothing within its slop; past it, `rotate{start}` about the press point, then the turn since
 * the press (rightward raises the bearing), stepped while mod is held.
 */
function rotateMove(step: Step, session: PointerSession, input: RawOf<'move'>, platform: InputPlatform): void {
  const starting = !session.slopPassed
  if (starting && Math.hypot(input.at.x - session.start.x, input.at.y - session.start.y) < NAVIGATION_SLOP_PX) return
  const live = { ...session, last: input.at, slopPassed: true }
  putSession(step, live)
  const stepped = stepsRotate(input.mods, platform)
  if (starting) step.gestures.push(rotateOf(live, 'start', live.start, stepped))
  step.gestures.push(rotateOf(live, 'move', input.at, stepped))
}

/** A key change during a live pointer rotate: the turn so far again, with the step the keys now give. */
function restepRotate(step: Step, mods: Modifiers, platform: InputPlatform): void {
  for (const session of step.state.sessions.values()) {
    if (session.mode !== 'rotate' || !session.slopPassed || session.navigation === 'trackpad-twist') continue
    step.gestures.push(rotateOf(session, 'move', session.last, stepsRotate(mods, platform)))
  }
}

function rotateOf(session: PointerSession, phase: 'start' | 'move' | 'end' | 'cancel', at: ScreenPoint, stepped: boolean): Gesture {
  return {
    kind: 'rotate',
    phase,
    anchorPx: session.start,
    totalDeltaDeg: phase === 'start' ? 0 : ROTATE_DEG_PER_PX * (at.x - session.start.x),
    step: stepped,
    source: session.navigation!,
  }
}

/** mod steps a rotate: Cmd where mod is Cmd (Ctrl never steps there), Ctrl elsewhere. */
function stepsRotate(mods: Modifiers, platform: InputPlatform): boolean {
  return modKeyIsCmd(platform) ? mods.meta : mods.ctrl
}

function pointerRotateLive(state: RecogniserState): boolean {
  for (const session of state.sessions.values()) {
    if (session.mode === 'rotate' && session.navigation !== 'trackpad-twist') return true
  }
  return false
}

/** An overview press, which pans and reaches no tool: released within its slop while the view is still in overview, it ends
 *  in a tap with no press, which only the Design pin hears (canopi-n2cg). */
function isOverviewPress(step: Step, session: PointerSession): boolean {
  return !session.pressed && session.navigation === 'primary-drag' && step.state.context.mode === 'overview'
}

function tapOf(session: PointerSession, input: RawOf<'up'>): Gesture {
  return {
    kind: 'tap',
    id: session.pointerId,
    at: input.at,
    pointer: session.pointer,
    mods: input.mods,
    clickCount: session.clickCount,
  }
}

/** Ends a session without completing it: a pan ends where it is, then the host hears the cancel. A held touch press or a
 *  spent finger ends silently: the host heard no press of it. A pair ends in place (A6). */
function endSession(step: Step, session: PointerSession, reason: CancelReason): void {
  if (session.mode === 'pair') {
    endPair(step, session.pointerId, reason)
    return
  }
  dropSession(step, session)
  if (session.mode !== 'held' && session.mode !== 'spent') endGestures(step, session, reason)
}

function endGestures(step: Step, session: PointerSession, reason: CancelReason): void {
  if (session.mode === 'pan' && session.navigation) step.gestures.push(panEndOf(session))
  // The router restores the camera the rotate started from; the input router does not cancel it on a plain cancel.
  if (session.mode === 'rotate' && session.slopPassed) step.gestures.push(rotateOf(session, 'cancel', session.last, false))
  step.gestures.push({ kind: 'cancel', reason })
}

/** A navigation or still secondary session whose release was lost: a pan ends where it is and a turn ends kept, never
 *  restored; no menu opens; then cancel('pointercancel') ends any press of the host's (the Pan tool's). */
function endWithLostRelease(step: Step, session: PointerSession): void {
  dropSession(step, session)
  step.effects.push({ kind: 'disown', pointerId: session.pointerId })
  if (session.mode === 'pan' && session.navigation) step.gestures.push(panEndOf(session))
  if (session.mode === 'rotate' && session.slopPassed) step.gestures.push(rotateOf(session, 'end', session.last, false))
  step.gestures.push({ kind: 'cancel', reason: 'pointercancel' })
}

function endLiveSessions(step: Step, reason: CancelReason): void {
  endPair(step, null, reason)
  for (const session of [...step.state.sessions.values()]) endSession(step, session, reason)
}

function dropSession(step: Step, session: PointerSession): void {
  const sessions = new Map(step.state.sessions)
  sessions.delete(session.pointerId)
  step.state = { ...step.state, sessions }
  if (session.captured) step.effects.push({ kind: 'release-capture', pointerId: session.pointerId })
}

function putSession(step: Step, session: PointerSession): void {
  const sessions = new Map(step.state.sessions)
  sessions.set(session.pointerId, session)
  step.state = { ...step.state, sessions }
}

function releaseSpace(step: Step): void {
  if (!step.state.held.space) return
  step.state = { ...step.state, held: { space: false } }
}
