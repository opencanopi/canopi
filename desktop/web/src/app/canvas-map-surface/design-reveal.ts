// When the canvas shows an open Design rather than the start screen (CanvasPanel, WebCanvasWorkspace).

import { useRef } from 'preact/hooks'
import { currentCanvasDocumentSurface } from '../../canvas/session'
import type { CanvasSurfaceState } from './canvas-host'

interface DesignReveal {
  /**
   * The open Design's chrome shows; until then it is laid out but transparent, so it registers what it covers. Chrome outside
   * the canvas area waits too when marked `data-design-chrome` (global.css).
   */
  readonly shown: boolean
  /** The start screen shows: no Design is open, or one opened from it has not shown yet. */
  readonly startScreen: boolean
}

function isSurfaceUnavailable(surface: CanvasSurfaceState): boolean {
  return surface.kind === 'unavailable' || (surface.kind === 'map' && surface.map.kind === 'failed')
}

/**
 * An open Design shows (its chrome over its map) in the frame its first scene is drawn, so the chrome never sits over an
 * empty map. One opened from the start screen keeps it up until then; one already open when the canvas mounts (a reload
 * restoring a Draft) never shows it, since its buttons would replace that Design. A map that failed, or a canvas that could
 * not start (reported as the map unavailable), draws nothing: the Design shows at once, over the map notice. Once shown, an
 * open Design stays shown until it is closed: opening another over it, or a Retry rebuilding the map, never brings the start
 * screen back. While `launching` (the Web launch reading which Draft it may reopen) with no Design open, neither shows;
 * a Draft the launch reopens is one already open, and a launch that reopens none brings the start screen.
 */
export function useDesignReveal(hasDesign: boolean, surface: CanvasSurfaceState, launching = false): DesignReveal {
  const shown = useRef(false)
  const openedFromStartScreen = useRef(!hasDesign)
  if (!hasDesign) {
    shown.current = false
    openedFromStartScreen.current = !launching
  } else if (!shown.current) {
    shown.current = currentCanvasDocumentSurface.value?.presented.value === true || isSurfaceUnavailable(surface)
  }
  return { shown: shown.current, startScreen: !shown.current && openedFromStartScreen.current }
}
