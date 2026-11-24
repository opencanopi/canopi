// canvas/runtime/input/raw-input.ts  (PointerKind, Modifiers, ToolId, ToolHandleId, CanvasDropPayload come from ../interaction-types.ts, §1.2a)

import type { CanvasDropPayload, Modifiers, PointerKind, ToolHandleId, ToolId } from '../interaction-types'
import type { ScreenPoint } from '../../../geo/view/types'
import type { InputPlatform } from './platform'
import type { PointerSession, TouchPair } from './recognise'
import type { Thresholds } from './thresholds'

export type ButtonRole = 'primary' | 'secondary' | 'auxiliary'

/** What was under the pointer at a down, a move or an up (a hover carries it, §1.3), classified by the source from data attributes. */
export type TargetClass =
  | { readonly kind: 'surface' }                                   // host or [data-canvas-surface]
  | { readonly kind: 'handle'; readonly id: ToolHandleId }         // [data-canvas-handle] in the handle layer
  | { readonly kind: 'owned-chrome' }                              // the session chrome ([data-canvas-chrome]), MapLibre's attribution (.maplibregl-ctrl, presses and hovers only: a wheel there is surface); any other button, input, select,
                                                                   // [contenteditable] or [data-preserve-overlays] in the host (the inspection lens's skip set)
  | { readonly kind: 'owned-text' }                                // the text-entry host
  | { readonly kind: 'foreign' }

interface At { readonly t: number }
export type RawInput =
  | At & { kind: 'down'; id: number; pointer: PointerKind; role: ButtonRole; at: ScreenPoint; mods: Modifiers; target: TargetClass; detail: number; ctrlConsumed: boolean }
  | At & { kind: 'move'; id: number; pointer: PointerKind; at: ScreenPoint; mods: Modifiers; target: TargetClass
      buttonMask: number }                                                    // PointerEvent.buttons as delivered, every bit: the lens's held-button rule (§1.4 "Hover")
  | At & { kind: 'up'; id: number; pointer: PointerKind; role: ButtonRole; at: ScreenPoint; mods: Modifiers; target: TargetClass }
  | At & { kind: 'cancel'; id: number | 'all'; reason: 'pointercancel' | 'lost-capture' | 'blur' | 'hidden' }
  | At & { kind: 'leave' }                                                    // host pointerleave: hover-end (the host's passive hover; the tool decides on its preview)
  | At & { kind: 'focus-out' }                                                // host focusout: the host ends the nudge series
  | At & { kind: 'reject'; id: number }                                       // the session, on a GestureOutcome.rejectSession: ends that session with no gesture
  | At & { kind: 'consume-click-series' }                                     // the session, on a GestureOutcome.consumeClickSeries: the series' later presses do nothing
  | At & { kind: 'wheel'; at: ScreenPoint; dxPx: number; dyPx: number; mods: Modifiers; target: TargetClass }
  | At & { kind: 'platform-gesture'; phase: 'start' | 'change' | 'end'; at: ScreenPoint; rotationDeg: number }
  | At & { kind: 'key-state'; space: boolean; mods: Modifiers }               // from the KeyRouter
  | At & { kind: 'escape' }                                                   // from the Esc chain's 'gesture' layer
  | At & { kind: 'drop'; phase: 'over' | 'leave' | 'drop'; at: ScreenPoint; payload: CanvasDropPayload }
  | At & { kind: 'configure'; context: { readonly tool: ToolId; readonly mode: 'site' | 'overview'; readonly pointingDevice: 'mouse' | 'trackpad' } }
  | At & { kind: 'tick' }

export interface RecogniserConfig {
  readonly platform: InputPlatform
  readonly thresholds: Thresholds
}

/** Applied by the source to the event it is handling. 'stop-propagation' (stopImmediatePropagation) and 'drop-effect' come from
 *  a GestureOutcome (§1.2a): a quarantine is 'prevent-default' plus 'stop-propagation'. 'disown': the pointer's session
 *  ended with its release lost (spec §2.2 "Drag end"), so the source stops following it as a press of the map's. */
export interface AdapterEffect {
  readonly kind: 'prevent-default' | 'stop-propagation' | 'capture' | 'release-capture' | 'disown' | 'set-timer' | 'clear-timer' | 'drop-effect'
  readonly pointerId?: number
  readonly atMs?: number
  readonly dropEffect?: 'copy' | 'move' | 'none'                // 'drop-effect': dataTransfer.dropEffect on dragover and drop
}
/** Opaque to callers; the recogniser owns its shape. Plain data (structured-clone safe), so the property test can snapshot it. */
export interface RecogniserState {
  readonly sessions: ReadonlyMap<number, PointerSession>        // by pointerId: pointer kind, role, mode ('pending' | 'secondary' | 'primary' | 'pan' | 'rotate', and a finger's 'held' | 'pair' | 'spent'), start, last point, slop passed, capture held
  readonly touchPair: TouchPair | null                          // two touch ids, their last points, the smallest diameter seen, whether the zoom and the twist are active (A12)
  readonly held: { readonly space: boolean }                    // the only gesture-state record of a held key (ADR 0017)
  readonly trackpadTwistDeg: number                             // WebKit gesture rotation accumulated before the 10° threshold
  readonly deadlines: { readonly longPressAt: number | null }
  readonly lastPrimaryPress: {                                  // the click count's previous press; `consumed`: its series' later presses do nothing
    readonly t: number; readonly at: ScreenPoint; readonly pointer: PointerKind; readonly count: number; readonly consumed: boolean
  } | null
  readonly context: { readonly tool: ToolId; readonly mode: 'site' | 'overview'; readonly pointingDevice: 'mouse' | 'trackpad' }
}
