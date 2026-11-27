import { signal } from '@preact/signals'
import { describe, expect, it } from 'vitest'
import { SAVED_VIEW_MAX_ZOOM } from '../generated/canopi-design-format'
import { createSessionPlane } from '../geo/session-plane'
import { createNavigationPolicy } from '../geo/view/navigation-policy'
import {
  isWorkspaceOverviewScale,
  WORKSPACE_OVERVIEW_SCALE_THRESHOLD,
} from '../geo/workspace-camera-policy'

describe('workspace camera policy', () => {
  it('the navigation policy maxZoom equals SAVED_VIEW_MAX_ZOOM (2.1-Q45)', () => {
    const policy = createNavigationPolicy(45.52, signal(false))
    expect(policy.maxZoom).toBe(SAVED_VIEW_MAX_ZOOM)
  })

  it('a scale placed at exactly the overview threshold is not overview, though it reads back a hair under', () => {
    const threshold = WORKSPACE_OVERVIEW_SCALE_THRESHOLD
    const readBack = createSessionPlane({ lon: 0, lat: 52.52 }).pixelsPerMetre(createSessionPlane({ lon: 0, lat: 52.52 }).zoomForPixelsPerMetre(threshold)).mean
    expect(readBack).toBeLessThan(threshold)
    expect(isWorkspaceOverviewScale(readBack)).toBe(false)
    expect(isWorkspaceOverviewScale(threshold * 0.999)).toBe(true)
  })
})
