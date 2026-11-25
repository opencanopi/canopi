// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { describe, expect, it, vi } from 'vitest'
import { createTestCanvasQuerySurface } from '../../__tests__/support/canvas-query-surface'
import type { DesignSessionStore } from '../../app/document-session/store'
import { createSessionPlane } from '../../geo/session-plane'
import { createBrowserCanvasHostRuntime } from './browser-workspace-runtime'

describe('browser workspace runtime adapters', () => {
  it('binds one injected Design store to activation and contribution snapshots without a per-edition createComposition', () => {
    const sessionIdentity = {}
    const hasCurrentDesign = vi.fn(() => true)
    const store: Pick<DesignSessionStore, 'sessionIdentity' | 'hasCurrentDesign'> = {
      sessionIdentity: signal(sessionIdentity),
      hasCurrentDesign,
    }

    const runtime = createBrowserCanvasHostRuntime(store)
    expect(runtime.createComposition).toBeUndefined()
    expect(runtime.adapters).toBeDefined()

    const readInitialCenter = vi.fn(() => ({ lat: 48, lon: 2 }))
    const activation = runtime.adapters!.readSnapshot!(readInitialCenter)
    const contributions = runtime.adapters!.mapContributions.read(
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
