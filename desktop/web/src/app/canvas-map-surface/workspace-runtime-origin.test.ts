// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createDetachedCanvasRuntimeAppAdapter } from '../../canvas/runtime/app-adapter'
import { createDetachedSceneRuntimePanelTargetAdapter } from '../../canvas/runtime/scene-runtime/panel-target-adapter'
import { createSessionPlane, DEFAULT_NEW_DESIGN_VIEW } from '../../geo/session-plane'
import type { SharedMapSceneRendererComposition } from '../../maplibre/shared-scene-renderer'
import type { WorkspaceActivationOptions } from './workspace-activation'
import type { WorkspaceGenerationLifecycle } from './workspace-generation-reconciler'
import { createWorkspaceRuntimeComposition } from './workspace-runtime-composition'
import { createTestCanvasRuntimeSurfaces } from '../../__tests__/support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from '../../__tests__/support/canvas-query-surface'
import { createTestView } from '../../__tests__/support/test-view'

// Moved from __tests__/workspace-camera-refresh-origin.test.ts: the composition gives the workspace the live plane origin. (The
// camera follows each new session plane in the runtime's own plane effect: scene-runtime/view-surfaces.test.ts.)
describe('workspace runtime composition origin effect', () => {
  function compositionFixture() {
    const queries = createTestCanvasQuerySurface({ sessionPlane: null })
    const sessionPlane = queries.sessionPlane
    const surfaces = createTestCanvasRuntimeSurfaces({ queries })
    const runtime = {
      cameraHost: createTestView().host,
      commandSurface: surfaces.commands,
      querySurface: surfaces.queries,
      documentSurface: surfaces.documents,
      init: vi.fn(async () => {}),
      unmountRenderer: vi.fn(async () => {}),
      remountRenderer: vi.fn(async () => {}),
      destroy: vi.fn(),
      connectRenderTarget: vi.fn(() => () => {}),
    }
    const workspace = {
      requestGenerationDisconnect: vi.fn(async () => {}),
      activate: vi.fn(async () => 'shared-ready' as const),
      teardown: vi.fn(async () => {}),
      retry: vi.fn(() => false),
      canRetry: vi.fn(() => false),
      updateMapContributions: vi.fn(),
      updateBackgroundPresentation: vi.fn(),
    } satisfies WorkspaceGenerationLifecycle & {
      canRetry(): boolean
      updateMapContributions(snapshot: unknown): void
      updateBackgroundPresentation(presentation: unknown): void
    }
    const createWorkspace = vi.fn((_input: WorkspaceActivationOptions) => workspace)
    const readSnapshot = vi.fn(
      (_readInitialCenter: () => { readonly lat: number; readonly lon: number }) => null,
    )
    const composition = createWorkspaceRuntimeComposition({
      container: document.createElement('div'),
      appAdapter: createDetachedCanvasRuntimeAppAdapter(),
      targetPresentation: createDetachedSceneRuntimePanelTargetAdapter(),
      mapContributions: { read: () => null },
      readSnapshot,
      readBackgroundPresentation: () => ({
        basemap: { style: 'liberty', visible: true, opacity: 1 },
        satellite: { visible: false, opacity: 1 },
        locale: 'en',
      }),
    }, {
      createRendererComposition: () => ({ createLayer: vi.fn() }) as unknown as SharedMapSceneRendererComposition,
      createRuntime: () => runtime,
      createControls: () => ({
        createMap: vi.fn(),
        releaseMap: vi.fn(),
        getWebGL2Context: vi.fn(() => null),
        updateMapContributions: vi.fn(),
        updateBackgroundPresentation: vi.fn(),
        setAttributionCompact: vi.fn(),
        retryBasemap: vi.fn(),
        reconcileLayerStack: vi.fn(),
        watchFailure: vi.fn(() => () => {}),
      }),
      createWorkspace,
    })
    return { composition, sessionPlane, createWorkspace, readSnapshot }
  }

  it('reads the live session plane origin for the workspace and the initial map centre', async () => {
    const fixture = compositionFixture()
    await fixture.composition.start()
    const readOrigin = fixture.createWorkspace.mock.calls[0]![0].readOrigin
    const readInitialCenter = fixture.readSnapshot.mock.calls[0]![0]

    expect(readOrigin()).toEqual({ lat: DEFAULT_NEW_DESIGN_VIEW.lat, lon: DEFAULT_NEW_DESIGN_VIEW.lon })
    expect(readInitialCenter()).toEqual({ lat: DEFAULT_NEW_DESIGN_VIEW.lat, lon: DEFAULT_NEW_DESIGN_VIEW.lon })

    fixture.sessionPlane.value = createSessionPlane({ lon: 2.3522, lat: 48.8566 })
    expect(readOrigin()).toEqual({ lat: 48.8566, lon: 2.3522 })
    expect(readInitialCenter()).toEqual({ lat: 48.8566, lon: 2.3522 })
    await fixture.composition.dispose()
  })
})
