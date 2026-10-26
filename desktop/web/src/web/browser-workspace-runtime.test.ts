// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestCanvasQuerySurface } from '../__tests__/support/canvas-query-surface'
import type {
  WorkspaceRuntimeCompositionOptions,
  WorkspaceRuntimeComposition,
} from '../app/canvas-map-surface/workspace-runtime-composition'
import type { DesignSessionStore } from '../app/document-session/store'
import { createSessionPlane } from '../canvas/session-plane'
import { createBrowserWorkspaceRuntimeComposition } from './browser-workspace-runtime'
import type * as WorkspaceRuntimeCompositionModule from '../app/canvas-map-surface/workspace-runtime-composition'

const workspaceMocks = vi.hoisted(() => ({
  createComposition: vi.fn(),
}))

vi.mock('../app/canvas-map-surface/workspace-runtime-composition', async (importOriginal) => ({
  ...await importOriginal<typeof WorkspaceRuntimeCompositionModule>(),
  createWorkspaceRuntimeComposition: workspaceMocks.createComposition,
}))

beforeEach(() => {
  workspaceMocks.createComposition.mockReset()
})

describe('browser workspace runtime composition', () => {
  it('binds one injected Design store to activation and contribution snapshots', () => {
    const sessionIdentity = {}
    const hasCurrentDesign = vi.fn(() => true)
    const store: Pick<DesignSessionStore, 'sessionIdentity' | 'hasCurrentDesign'> = {
      sessionIdentity: signal(sessionIdentity),
      hasCurrentDesign,
    }
    const composition = {} as WorkspaceRuntimeComposition
    workspaceMocks.createComposition.mockReturnValue(composition)

    const result = createBrowserWorkspaceRuntimeComposition({
      container: document.createElement('div'),
      store,
    })

    expect(result).toBe(composition)
    const options = workspaceMocks.createComposition.mock.calls[0]![0] as
      WorkspaceRuntimeCompositionOptions
    const readInitialCenter = vi.fn(() => ({ lat: 48, lon: 2 }))
    const activation = options.readSnapshot!(readInitialCenter)
    const contributions = options.mapContributions.read(
      createTestCanvasQuerySurface({ sessionPlane: createSessionPlane({ lat: 48, lon: 2 }) }),
    )

    expect(activation?.sessionIdentity).toBe(sessionIdentity)
    expect(activation?.map).toMatchObject({ initialCenter: { lat: 48, lon: 2 } })
    expect(readInitialCenter).toHaveBeenCalledOnce()
    expect(contributions?.sessionIdentity).toBe(sessionIdentity)
    expect(contributions?.overlays.location).toEqual({ lat: 48, lon: 2 })
    expect(hasCurrentDesign).toHaveBeenCalledTimes(2)
  })
})
