// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createDetachedCanvasRuntimeAppAdapter } from '../../__tests__/support/detached-canvas-app-adapter'
import { createDetachedSceneRuntimePanelTargetAdapter } from '../../canvas/runtime/scene-runtime/panel-target-adapter'
import { createSharedMapSceneRendererComposition, type SharedMapSceneRendererComposition } from '../../maplibre/shared-scene-renderer'
import { WorkspaceMapControls } from './workspace-map-controls'
import { createWorkspaceRuntimeComposition } from './workspace-runtime-composition'
import type { WorkspaceActivationSnapshot } from './workspace-activation'

function workspaceSnapshot(): WorkspaceActivationSnapshot {
  return {
    sessionIdentity: {},
    map: {
      initialCenter: { lat: 48.86, lon: 2.35 },
      background: {
        basemap: { style: 'liberty', visible: true, opacity: 1 },
        satellite: { visible: false, opacity: 1 },
        locale: 'en',
      },
    },
  }
}

describe('shared workspace without WebGL2', () => {
  it('shows the map-unavailable state, mounts no renderer and offers no Retry', async () => {
    const container = document.createElement('div')
    const createLayer = vi.fn<SharedMapSceneRendererComposition['createLayer']>()
    const onFailure = vi.fn()
    const canCreateWebGL2Context = vi.fn(() => false)
    const composition = createWorkspaceRuntimeComposition({
      container,
      appAdapter: createDetachedCanvasRuntimeAppAdapter(),
      targetPresentation: createDetachedSceneRuntimePanelTargetAdapter(),
      mapContributions: { read: () => null },
      onFailure,
      readSnapshot: () => workspaceSnapshot(),
    }, {
      createRendererComposition: (connect) => {
        const rendererComposition = createSharedMapSceneRendererComposition(connect)
        createLayer.mockImplementation((options) => rendererComposition.createLayer(options))
        return { createLayer }
      },
      createControls: (options) => new WorkspaceMapControls({
        ...options,
        canCreateWebGL2Context,
      }),
    })

    await expect(composition.start()).resolves.toBe('map-unavailable')

    expect(composition.mapLifetime.state.peek()).toMatchObject({
      kind: 'failed',
      cause: 'no-webgl2',
    })
    // "Map unavailable" stays: Retry is refused and builds no map.
    expect(composition.mapLifetime.restart()).toBe(false)
    await Promise.resolve()
    expect(canCreateWebGL2Context).toHaveBeenCalledOnce()
    expect(composition.mapLifetime.state.peek()).toMatchObject({ kind: 'failed', cause: 'no-webgl2' })
    expect(createLayer, 'no scene layer, so nothing draws').not.toHaveBeenCalled()
    expect(container.querySelector('canvas')).toBeNull()
    expect(container.childElementCount).toBe(0)
    expect(onFailure).not.toHaveBeenCalled()
    await composition.dispose()
  })
})
