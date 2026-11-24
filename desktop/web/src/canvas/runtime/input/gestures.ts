// canvas/runtime/input/gestures.ts

import type { CancelReason, CanvasDropPayload, Modifiers, PointerKind, ToolHandleId } from '../interaction-types'
import type { ScreenPoint } from '../../../geo/view/types'
import type { TargetClass } from './raw-input'

export type NavigationSource =
  | 'secondary-drag' | 'auxiliary-drag' | 'space-drag' | 'primary-drag'   // primary-drag: the Pan tool
  | 'wheel' | 'trackpad-twist' | 'touch-two-finger'                         // a pinch is a 'wheel' (P14)

export type MenuSource = 'mouse' | 'long-press' | 'keyboard'
// CancelReason, PointerKind, Modifiers, ToolHandleId, CanvasDropPayload: from ../interaction-types.ts (§1.2a); TargetClass: from ./raw-input.ts (§1.2)

export type PressTarget =
  | { readonly kind: 'surface' }
  | { readonly kind: 'handle'; readonly id: ToolHandleId }

export type Gesture =
  // editing: primary role only; the ToolHost converts to world space
  /** target: the class the recogniser saw under the pointer; the host publishes to subscribePointerWorld only for 'surface'. */
  | { kind: 'hover'; at: ScreenPoint; pointer: PointerKind; mods: Modifiers; target: TargetClass }
  | { kind: 'hover-end' }
  | { kind: 'press'; id: number; at: ScreenPoint; pointer: PointerKind; mods: Modifiers; clickCount: number; target: PressTarget }
  /** A press's release within its slop; in overview, also a still overview press's, which no `press` came before (the
   *  Design pin's tap, canopi-n2cg). */
  | { kind: 'tap'; id: number; at: ScreenPoint; pointer: PointerKind; mods: Modifiers; clickCount: number }
  | { kind: 'drag-start'; id: number; at: ScreenPoint; mods: Modifiers }
  | { kind: 'drag-move'; id: number; at: ScreenPoint; mods: Modifiers }
  | { kind: 'drag-end'; id: number; at: ScreenPoint; mods: Modifiers }
  | { kind: 'drop'; phase: 'over' | 'leave' | 'drop'; at: ScreenPoint; payload: CanvasDropPayload }
  // navigation: never reaches tools
  /** deltaPx is content movement (the ground follows the pointer). at: the pointer's screen point for a one-pointer source,
   *  which the router hands to ToolHost.notePointer; absent for a wheel pan and a two-finger pan, which move no resting
   *  hover (A14). */
  | { kind: 'pan'; phase: 'start' | 'move' | 'end'; deltaPx: ScreenPoint; source: NavigationSource; at?: ScreenPoint }
  | { kind: 'zoom'; anchorPx: ScreenPoint; factor: number; source: NavigationSource }
  | { kind: 'rotate'; phase: 'start' | 'move' | 'end' | 'cancel'; anchorPx: ScreenPoint; totalDeltaDeg: number; step: boolean; source: NavigationSource }
  // requests
  /** handle: the handle a still secondary press or a long press landed on (A16): the host asks the armed tool for its point
   *  menu; absent on the map's surface and for the keyboard (the host reads the focused handle). */
  | { kind: 'menu-request'; at: ScreenPoint | 'selection'; source: MenuSource; handle?: ToolHandleId }
  | { kind: 'cancel'; reason: CancelReason }
