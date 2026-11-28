// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDetachedCanvasRuntimeAppAdapter } from '../../__tests__/support/detached-canvas-app-adapter'
import { createTestCanvasQuerySurface } from '../../__tests__/support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from '../../__tests__/support/canvas-runtime-surfaces'
import { createDetachedSceneRuntimePanelTargetAdapter } from '../../canvas/runtime/scene-runtime/panel-target-adapter'
import { setCurrentCanvasSession } from '../../canvas/session'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import type { CanopiFile } from '../../types/design'
import { endSiteDataTransients, pin, profileLine, setPin, setProfileLine } from '../data-library/site-transients'
import { clearCurrentDesignState, replaceCurrentDesignState } from '../../__tests__/support/design-session-state'
import { sidePanel } from '../shell/state'
import { leaveStoryPresentation, presentStory } from '../story-presentation'
import { createDesktopWorkspaceMapContributionAdapter } from './desktop-workspace-map-contribution-adapter'
import type { ContributionFeed } from './workspace-map-contributions'
import { createWorkspaceRuntimeComposition } from './workspace-runtime-composition'

function storyDesign(): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Site presentation',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    views: [{
      id: 'v1',
      name: 'View 1',
      camera: { lon: 2.35, lat: 48.85, zoom: 17, bearing: 0, ground_size_m: { width: 100, height: 75 } },
      visible_layers: {
        background: { kind: 'basemap', style: 'liberty' },
        terrain: { contours: false, hillshade: false },
        site_data_ids: [],
        design_layers: [],
      },
      highlighted: { species: [], objects: [] },
      plant_labels: 'names',
      focused_species: null,
      thumbnail: null,
    } as never],
    stories: [{
      id: 'tour',
      name: 'Tour',
      steps: [{ id: 's1', view_id: 'v1', title: 'Intro', text: [], images: [] }],
    }],
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  }
}

describe('desktop workspace map contribution presentation hiding (2.1-Q106)', () => {
  afterEach(() => {
    leaveStoryPresentation()
    endSiteDataTransients()
    sidePanel.value = null
    setCurrentCanvasSession(null)
    clearCurrentDesignState()
  })

  it('2.1-Q106: hides the Site data pin, profile line and hover ring while presenting and restores them without losing state', async () => {
    const queries = createTestCanvasQuerySurface()
    const surfaces = createTestCanvasRuntimeSurfaces({ queries })
    setCurrentCanvasSession(surfaces)
    replaceCurrentDesignState(storyDesign(), null, 'Site presentation')
    sidePanel.value = 'site-data'

    const pinPoint = { lon: 2.35, lat: 48.85 }
    const linePoints = [{ lon: 2.35, lat: 48.85 }, { lon: 2.36, lat: 48.86 }]
    setPin(pinPoint)
    setProfileLine(linePoints)

    const hover = signal<readonly [number, number] | null>([2.355, 48.855])
    const desktopAdapter = createDesktopWorkspaceMapContributionAdapter({ locationEnabled: false })
    let siteHoverFeed: ContributionFeed<readonly [number, number] | null> | undefined

    const composition = createWorkspaceRuntimeComposition({
      container: document.createElement('div'),
      appAdapter: createDetachedCanvasRuntimeAppAdapter(),
      targetPresentation: createDetachedSceneRuntimePanelTargetAdapter(),
      mapContributions: {
        ...desktopAdapter,
        readSiteHover: () => hover.value,
      },
      readSnapshot: () => null,
    }, {
      createControls: (controlOptions) => {
        siteHoverFeed = controlOptions.contributions.siteHover
        return {
          ensureAttached: vi.fn(async () => ({}) as never),
          setBackgroundPresentation: vi.fn(),
          setAttributionCompact: vi.fn(),
          retryBasemap: vi.fn(),
          retryLayer: vi.fn(),
          updateContributions: vi.fn(),
          dispose: vi.fn(),
        } as never
      },
      createRuntime: () => ({
        init: vi.fn(async () => {}),
        connectRenderTarget: vi.fn(() => () => {}),
        unmountRenderer: vi.fn(),
        remountRenderer: vi.fn(),
        destroy: vi.fn(),
        cameraHost: { current: () => ({ setScreen: vi.fn() }) } as never,
        commandSurface: surfaces.commands,
        querySurface: queries,
        documentSurface: surfaces.documents,
      }),
      createWorkspace: () => ({
        activate: vi.fn(async () => 'shared-ready' as const),
        requestGenerationDisconnect: vi.fn(),
        retry: vi.fn(() => false),
        teardown: vi.fn(async () => {}),
        updateBackgroundPresentation: vi.fn(),
        updateMapContributions: vi.fn(),
      }),
    })

    await composition.start()
    try {
      const before = desktopAdapter.read(queries)
      expect(before?.overlays.site).toEqual({
        pin: [2.35, 48.85],
        profileLine: [[2.35, 48.85], [2.36, 48.86]],
      })
      expect(siteHoverFeed?.current()).toEqual([2.355, 48.855])

      expect(presentStory('tour', 0)).toBe(true)

      expect(desktopAdapter.read(queries)?.overlays.site, 'pin and profile line hide while presenting').toBeNull()
      expect(siteHoverFeed?.current(), 'profile hover ring hides while presenting').toBeNull()

      // Moving the hover while presenting stays hidden and preserves the latest hover state.
      hover.value = [2.358, 48.858]
      expect(siteHoverFeed?.current()).toBeNull()
      expect(pin.value).toEqual(pinPoint)
      expect(profileLine.value).toEqual(linePoints)

      leaveStoryPresentation()

      expect(desktopAdapter.read(queries)?.overlays.site, 'pin and profile line return after presenting').toEqual({
        pin: [2.35, 48.85],
        profileLine: [[2.35, 48.85], [2.36, 48.86]],
      })
      expect(siteHoverFeed?.current(), 'profile hover ring returns after presenting').toEqual([2.358, 48.858])
    } finally {
      await composition.dispose()
    }
  })
})
