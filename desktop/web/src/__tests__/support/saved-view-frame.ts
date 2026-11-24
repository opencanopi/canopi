// __tests__/support/saved-view-frame.ts  (test support)
//
// What a saved view framed, measured through real views: the ground under the four corners of the window it was saved in, and
// where those corners land in another window at the camera going to the view shows. Both views are test views (the production
// camera host) over one session plane at the view's centre, so the plane's metres are the ground's there.

import { mapZoomToStageScale, createSessionPlane } from '../../geo/session-plane'
import type { ScreenPoint, ViewCamera } from '../../geo/view/types'
import type { SavedView } from '../../generated/contracts'
import { createTestView } from './test-view'

type SavedViewCamera = SavedView['camera']

export interface WindowSize { readonly width: number; readonly height: number }

/** The ground a window of `screen` CSS px shows at a saved camera, in metres: what saving the view records. */
export function groundSizeShown(camera: Pick<SavedViewCamera, 'lat' | 'zoom'>, screen: WindowSize): { width: number; height: number } {
  const pixelsPerMetre = mapZoomToStageScale(camera.zoom, camera.lat)
  return { width: screen.width / pixelsPerMetre, height: screen.height / pixelsPerMetre }
}

/** Where the four corners of what `saved` showed in `savedScreen` land in `shownScreen` at the camera `shown`. */
export function framedCornersOnScreen(
  saved: SavedViewCamera,
  savedScreen: WindowSize,
  shown: ViewCamera,
  shownScreen: WindowSize,
): ScreenPoint[] {
  const plane = createSessionPlane({ lon: saved.lon, lat: saved.lat })
  const before = createTestView({
    plane,
    screen: savedScreen,
    camera: { center: { lon: saved.lon, lat: saved.lat }, zoom: saved.zoom, bearingDeg: saved.bearing },
  })
  const after = createTestView({ plane, screen: shownScreen, camera: shown })
  try {
    return before.view().visibleWorldQuad().map((corner) => after.view().worldToScreen(corner))
  } finally {
    before.dispose()
    after.dispose()
  }
}
