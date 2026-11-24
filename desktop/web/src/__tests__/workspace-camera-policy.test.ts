import { describe, expect, it } from 'vitest'
import { createSessionPlane } from '../geo/session-plane'
import {
  isWorkspaceOverviewScale,
  WORKSPACE_OVERVIEW_SCALE_THRESHOLD,
} from '../geo/workspace-camera-policy'

describe('workspace camera policy', () => {
  it('a scale placed at exactly the overview threshold is not overview, though it reads back a hair under', () => {
    const threshold = WORKSPACE_OVERVIEW_SCALE_THRESHOLD
    const readBack = createSessionPlane({ lon: 0, lat: 52.52 }).pixelsPerMetre(createSessionPlane({ lon: 0, lat: 52.52 }).zoomForPixelsPerMetre(threshold)).mean
    expect(readBack).toBeLessThan(threshold)
    expect(isWorkspaceOverviewScale(readBack)).toBe(false)
    expect(isWorkspaceOverviewScale(threshold * 0.999)).toBe(true)
  })
})
