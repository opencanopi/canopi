// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installEditionPorts } from '../platform/edition-ports'
import { createTestEditionPorts } from './support/test-edition-ports'

const coverage = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../ipc/lidar', () => ({ lidarImportCoverage: coverage.read }))

import { checkImportCoverage, compareCoverage, coverageCanvas, designGroundBox } from '../app/data-library/import-coverage'
import { setCurrentCanvasSession } from '../canvas/session'
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
})
