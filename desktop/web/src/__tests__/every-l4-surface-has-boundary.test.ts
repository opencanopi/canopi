// Every L4 surface (each WorkspaceSurfaces entry, each useModalLayer caller and each root) renders inside an error
// boundary that reports through the failure sink (contracts §2; ADR 0025). The boundary, failures/boundary.tsx,
// arrives in 1b-c3; until then this test fails on its absence. A cross-module suite: it reads the surfaces' table and
// the boundary module together.
import { describe, expect, it } from 'vitest'

type BoundaryModule = Record<string, unknown>

describe('error boundaries', () => {
  it.fails('[1b-c3 canopi-f47t.52.36] every L4 surface has an error boundary', async () => {
    const loaders = import.meta.glob<BoundaryModule>('../failures/boundary.tsx')
    const load = loaders['../failures/boundary.tsx']
    expect(load, 'failures/boundary.tsx, the surface error boundary').toBeDefined()
    const boundary = await load!()
    expect(typeof boundary.SurfaceBoundary).toBe('function')
    expect(typeof boundary.RootBoundary).toBe('function')
    expect(boundary.BOUNDED_SURFACES, 'the surfaces the boundary wraps, checked against WorkspaceSurfaces').toBeDefined()
  })
})
