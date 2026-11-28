// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installEditionPorts } from '../platform/edition-ports'
import { createTestEditionPorts } from './support/test-edition-ports'

const coverage = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../ipc/lidar', () => ({ lidarImportCoverage: coverage.read }))

import { checkImportCoverage, compareCoverage, coverageCanvas } from '../app/data-library/import-coverage'
import { createDefaultScenePersistedState } from '../canvas/runtime/scene'
import { setCurrentCanvasSession } from '../canvas/session'
import { createSessionPlane } from '../geo/session-plane'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import type { PlacedPlant } from '../types/design'

const orchardPlants: readonly PlacedPlant[] = [
  { id: 'p1', canonical_name: 'Malus domestica', position: { lon: 0.100, lat: 47.000 } },
  { id: 'p2', canonical_name: 'Malus domestica', position: { lon: 0.102, lat: 47.001 } },
] as unknown as PlacedPlant[]

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

  it('returns null without calling IPC when the runtime outline is empty or unsettled', async () => {
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({ plants: [] }),
    }))
    expect(await checkImportCoverage(['/d/a.tif'])).toBeNull()
    expect(coverage.read).not.toHaveBeenCalled()

    const unsettled = createTestCanvasQuerySurface({ plants: orchardPlants })
    unsettled.setSettled(false)
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: unsettled }))
    expect(await checkImportCoverage(['/d/a.tif'])).toBeNull()
    expect(coverage.read).not.toHaveBeenCalled()
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
      queries: createTestCanvasQuerySurface({ plants: orchardPlants }),
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

  it('a plant whose canopy extends past the raster edge reports partial instead of covers (2.1-Q45)', async () => {
    const plane = createSessionPlane({ lon: 2.35, lat: 48.85 })
    // Trunk at (0, 0) with 20 m canopy spread (radius 10 m): canopy reaches ±10 m in x and y.
    const scene = {
      ...createDefaultScenePersistedState(),
      plants: [{
        kind: 'plant' as const,
        id: 'edge-walnut',
        locked: false,
        canonicalName: 'Juglans regia',
        commonName: 'Walnut',
        color: null,
        canopySpreadM: 20,
        position: { x: 0, y: 0 },
        rotationDeg: null,
        notes: null,
        plantedDate: null,
        quantity: null,
      }],
    }
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({ scene, sessionPlane: plane }),
    }))

    // Raster covers the trunk [-15, +5] x [-15, +15] m but clips the eastern canopy (+10 m).
    const swClipped = plane.toGeo({ x: -15, y: -15 })
    const neClipped = plane.toGeo({ x: 5, y: 15 })
    coverage.read.mockResolvedValueOnce({
      bounds: [Math.min(swClipped.lon, neClipped.lon), Math.min(swClipped.lat, neClipped.lat), Math.max(swClipped.lon, neClipped.lon), Math.max(swClipped.lat, neClipped.lat)],
      unreadable_files: 0,
    })
    expect(await checkImportCoverage(['/d/canopy-clipped.tif'])).toMatchObject({ kind: 'partial' })

    // Raster covers [-15, +15] x [-15, +15] m, enclosing the full canopy.
    const swFull = plane.toGeo({ x: -15, y: -15 })
    const neFull = plane.toGeo({ x: 15, y: 15 })
    coverage.read.mockResolvedValueOnce({
      bounds: [Math.min(swFull.lon, neFull.lon), Math.min(swFull.lat, neFull.lat), Math.max(swFull.lon, neFull.lon), Math.max(swFull.lat, neFull.lat)],
      unreadable_files: 0,
    })
    expect(await checkImportCoverage(['/d/canopy-full.tif'])).toMatchObject({ kind: 'covers' })
  })
})
