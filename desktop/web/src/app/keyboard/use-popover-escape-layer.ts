// app/keyboard/use-popover-escape-layer.ts
//
// The one way a component gives an open popover or menu its Esc chain layer (spec §3.7, ADR 0020). The layer
// registers in the commit that shows the popover, a layout effect, so it is live on the first painted frame: Preact 11
// runs `useEffect`, and `useSignalEffect` re-runs, after paint, and WebKit can deliver an Esc in between, which then
// reached the canvas and left the menu open (canopi-f47t.52.228.20). A popover that takes focus moves it in a layout
// effect for the same reason.

import { useLayoutEffect, useRef } from 'preact/hooks'
import { ESCAPE_PRIORITY, registerEscapeLayer } from './escape-chain'

/**
 * While `shown`, an Esc from outside the popover runs `close` and nothing else (inside, its own handler takes the Esc
 * first). `isActive` narrows when it takes one (a popover hidden with its host leaves the Esc to the next layer).
 */
export function usePopoverEscapeLayer(shown: boolean, close: () => void, isActive: () => boolean = always): void {
  const latest = useRef({ close, isActive })
  latest.current = { close, isActive }
  useLayoutEffect(() => {
    if (!shown) return
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.popover,
      isActive: () => latest.current.isActive(),
      escape: () => {
        latest.current.close()
        return true
      },
    })
  }, [shown])
}

function always(): boolean {
  return true
}
