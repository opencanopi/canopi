// app/keyboard/escape-chain.ts
//
// Owns Esc (spec §3.7, ADR 0020): every surface an Esc can close or cancel is a layer with a priority, and one Esc runs
// the highest active layer that takes it. The key router runs the chain (§1.6: in bubble after element handlers, step
// 8; in capture while a drag or nudge series is live, step 4) and prevents and stops a key a layer took. Popovers
// register at 100 while open (components through use-popover-escape-layer.ts), the compass at 70 for the whole press,
// pending phase included (it runs outside the input pipeline, so the canvas gesture layer cannot see it; fixture I9),
// the Site data profile at 25 while a line is shown and its pin at 20 while a point is pinned (canopi-f47t.42); the
// canvas port's layers register here, since the runtime never imports app code, from the key router's install.

import type { CanvasEscapeLayer, CanvasKeyboardPort } from '../../canvas/runtime/runtime'
import type { KeyboardEventLike } from './key-chord'
import type { FocusClass } from './target-class'

interface EscapeLayer {
  readonly priority: number          // higher runs first
  isActive(): boolean
  /** The Esc being dispatched; false when it consumed nothing and the next active layer runs. */
  escape(key: EscapeKey): boolean
}

/** The Esc being dispatched, with where focus is (the router's class of the target). */
interface EscapeKey {
  readonly event: KeyboardEventLike
  readonly focus: FocusClass
}

/** Spec §3.7's priorities. */
export const ESCAPE_PRIORITY = {
  popover: 100,
  gesture: 70,
  'nudge-series': 65,
  'tool-transient': 60,
  tool: 50,
  selection: 30,
  profile: 25,
  'site-pin': 20,
} as const satisfies Readonly<Record<'popover' | 'profile' | 'site-pin' | CanvasEscapeLayer, number>>

interface Registered { readonly layer: EscapeLayer; readonly order: number }

const registered: Registered[] = []
let nextOrder = 0

export function registerEscapeLayer(layer: EscapeLayer): () => void {
  const entry = { layer, order: nextOrder++ }
  registered.push(entry)
  return () => {
    const index = registered.indexOf(entry)
    if (index >= 0) registered.splice(index, 1)
  }
}

/** The active layers, the highest priority first; of equal priority, the latest registered (the popover opened last). */
function activeLayers(): EscapeLayer[] {
  return registered
    .filter((entry) => entry.layer.isActive())
    .sort((a, b) => b.layer.priority - a.layer.priority || b.order - a.order)
    .map((entry) => entry.layer)
}

/** The router's Esc step: active layers by priority until one consumes the key. */
export function runEscape(key: EscapeKey): boolean {
  for (const layer of activeLayers()) {
    if (layer.escape(key)) return true
  }
  return false
}

const CANVAS_LAYERS: readonly CanvasEscapeLayer[] = ['gesture', 'nudge-series', 'tool-transient', 'tool', 'selection']

/**
 * The canvas port's layers (spec §3.7, U10), each live while the port lists it. None runs from a text field, whose own
 * handler cancels its entry (the note editor, Plant a row's spacing field), or under a modal. A live drag, a nudge series,
 * the tool's draft or source and the tool itself run from any other focus; the selection only from the map (nothing
 * focused counts as the map only after a press or focus in it), so a side panel keeps the selection it shows. Leaving the tool and clearing the selection take an Esc
 * with no modifier, as before.
 */
export function registerCanvasEscapeLayers(canvas: () => CanvasKeyboardPort | null): () => void {
  const disposers = CANVAS_LAYERS.map((id) => registerEscapeLayer({
    priority: ESCAPE_PRIORITY[id],
    isActive: () => canvas()?.escapeLayers().includes(id) ?? false,
    escape(key) {
      const port = canvas()
      if (!port || !admits(id, key)) return false
      port.escape(id)
      return true
    },
  }))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

function admits(layer: CanvasEscapeLayer, { event, focus }: EscapeKey): boolean {
  if (focus === 'modal' || focus === 'text') return false
  if (layer === 'gesture' || layer === 'nudge-series' || layer === 'tool-transient') return true
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false
  return layer === 'tool' || focus === 'map'
}
