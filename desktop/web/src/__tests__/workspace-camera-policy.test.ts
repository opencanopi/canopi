import { describe, expect, it } from 'vitest'
import { createSessionPlane, mapZoomToStageScale } from '../geo/session-plane'
import {
  isWorkspaceOverviewScale,
  WORKSPACE_OVERVIEW_SCALE_THRESHOLD,
} from '../geo/workspace-camera-policy'

describe('workspace camera policy', () => {
  it('a scale placed at exactly the overview threshold is not overview, though it reads back a hair under', () => {
    const threshold = WORKSPACE_OVERVIEW_SCALE_THRESHOLD
    const readBack = mapZoomToStageScale(createSessionPlane({ lon: 0, lat: 52.52 }).zoomForPixelsPerMetre(threshold), 52.52)
    expect(readBack).toBeLessThan(threshold)
    expect(isWorkspaceOverviewScale(readBack)).toBe(false)
    expect(isWorkspaceOverviewScale(threshold * 0.999)).toBe(true)
  })
})
