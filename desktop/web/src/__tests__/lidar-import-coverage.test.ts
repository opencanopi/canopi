// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installEditionPorts } from '../platform/edition-ports'
import { createTestEditionPorts } from './support/test-edition-ports'

const coverage = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../ipc/lidar', () => ({ lidarImportCoverage: coverage.read }))

import { checkImportCoverage, compareCoverage, coverageCanvas, designGroundBox } from '../app/data-library/import-coverage'
import { createDefaultScenePersistedState } from '../canvas/runtime/scene'
import { setCurrentCanvasSession } from '../canvas/session'
import { createSessionPlane } from '../geo/session-plane'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import type { CanvasDesignObjects } from '../canvas/runtime/runtime'

const orchard: CanvasDesignObjects = {
  plants: [
    { id: 'p1', canonical_name: 'Malus domestica', position: { lon: 0.100, lat: 47.000 } },
    { id: 'p2', canonical_name: 'Malus domestica', position: { lon: 0.102, lat: 47.001 } },
  ] as unknown as CanvasDesignObjects['plants'],
  zones: [{ id: 'z1', zone_type: 'polygon', points: [{ lon: 0.099, lat: 46.999 }, { lon: 0.101, lat: 47.002 }] }] as unknown as CanvasDesignObjects['zones'],
  annotations: [],
  measurementGuides: [],
  groups: [],
}

describe('Import coverage', () => {
  let disposePorts: () => void = () => undefined
  beforeEach(() => {
    disposePorts = installEditionPorts(createTestEditionPorts())
  })
  afterEach(() => {
    disposePorts()
    setCurrentCanvasSession(null)
    coverage.read.mockReset()
  })

  it('boxes every placed object of the Design', () => {
    expect(designGroundBox(orchard)).toEqual([0.099, 46.999, 0.102, 47.002])
    expect(designGroundBox({ ...orchard, plants: [], zones: [] })).toBeNull()
  })

  it('tells covering, partial and distant files apart', () => {
    const design = [0.1, 47, 0.102, 47.002] as const
    const covers = compareCoverage([0.09, 46.99, 0.11, 47.01], design)
    expect(covers.kind).toBe('covers')
    if (covers.kind !== 'apart') {
      expect(covers.widthM).toBeCloseTo(1518, -1)
      expect(covers.heightM).toBeCloseTo(2223, -1)
    }
    expect(compareCoverage([0.101, 46.99, 0.11, 47.01], design).kind).toBe('partial')
    const apart = compareCoverage([0.2, 47, 0.21, 47.002], design)
    expect(apart).toEqual({ kind: 'apart', distanceM: expect.closeTo(7_440, -2) })
  })

  it('compares the files with the open Design and stays quiet when it cannot', async () => {
    expect(coverageCanvas()).toBeNull()
    expect(await checkImportCoverage(['/d/a.tif'])).toBeNull()
    expect(coverage.read).not.toHaveBeenCalled()

    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({ plants: orchard.plants }),
    }))
    expect(coverageCanvas()).not.toBeNull()
    coverage.read.mockResolvedValueOnce({ bounds: [0.05, 46.95, 0.15, 47.05], unreadable_files: 0 })
    expect(await checkImportCoverage(['/d/a.tif'])).toMatchObject({ kind: 'covers' })
    expect(coverage.read).toHaveBeenCalledWith(['/d/a.tif'])

    coverage.read.mockResolvedValueOnce({ bounds: null, unreadable_files: 1 })
    expect(await checkImportCoverage(['/d/a.tif'])).toBeNull()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    coverage.read.mockRejectedValueOnce(new Error('the file is not a readable raster'))
    expect(await checkImportCoverage(['/d/a.tif'])).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a rotated rectangle zone at the site edge derives coverage from the runtime outline (2.1-Q45)', async () => {
    const plane = createSessionPlane({ lon: 2.35, lat: 48.85 })
    // Unrotated 100 m x 20 m rectangle centred on origin: y stays within [-10, +10] m.
    // Rotated 45°, its corners reach y ≈ ±42.43 m — outside a raster covering [-60, +60] x [-20, +20] m.
    const scene = {
      ...createDefaultScenePersistedState(),
      zones: [{
        kind: 'zone' as const,
        id: 'rect-edge',
        name: 'Edge bed',
        zoneType: 'rect',
        rotationDeg: 45,
        points: [
          { x: -50, y: -10 },
          { x: 50, y: -10 },
          { x: 50, y: 10 },
          { x: -50, y: 10 },
        ],
        fillColor: null,
        notes: null,
        locked: false,
      }],
    }
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({ scene, sessionPlane: plane }),
    }))

    const swTight = plane.toGeo({ x: -60, y: -20 })
    const neTight = plane.toGeo({ x: 60, y: 20 })
    coverage.read.mockResolvedValueOnce({
      bounds: [Math.min(swTight.lon, neTight.lon), Math.min(swTight.lat, neTight.lat), Math.max(swTight.lon, neTight.lon), Math.max(swTight.lat, neTight.lat)],
      unreadable_files: 0,
    })
    expect(await checkImportCoverage(['/d/edge-tight.tif'])).toMatchObject({ kind: 'partial' })

    const swWide = plane.toGeo({ x: -60, y: -50 })
    const neWide = plane.toGeo({ x: 60, y: 50 })
    coverage.read.mockResolvedValueOnce({
      bounds: [Math.min(swWide.lon, neWide.lon), Math.min(swWide.lat, neWide.lat), Math.max(swWide.lon, neWide.lon), Math.max(swWide.lat, neWide.lat)],
      unreadable_files: 0,
    })
    expect(await checkImportCoverage(['/d/edge-wide.tif'])).toMatchObject({ kind: 'covers' })
  })
})
