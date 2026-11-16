// @vitest-environment jsdom
//
// Phase 2 commit 0: 2.1-Q359's exported file names, written before 2a-4 builds them (it.fails until then). A
// character a file system forbids becomes a space and runs of spaces collapse, so "Kitchen / garden: north" exports as
// "Kitchen garden north.geojson". 2a-4 turns it.fails into it and moves the old "Kitchen _ garden" expectation in
// __tests__/geojson-workflow.test.ts to the new rule.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import type { CanopiFile } from '../../types/design'
import { geoAt } from '../../__tests__/support/geo-design'
import { createLiveTestCanvasRuntimeHost, type CanvasRuntimeHost } from '../../__tests__/support/live-canvas-runtime'
import { createGeoJsonWorkflow, type GeoJsonFileAdapter } from './workflow'

const hosts: CanvasRuntimeHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.destroy()
})

function designWithOneZone(): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Kitchen / garden: north',
    description: null,
    plant_species_colors: {},
    layers: [{ name: 'zones', visible: true, locked: false, opacity: 1 }],
    plants: [],
    zones: [{
      id: 'bed', name: 'Bed', locked: false, zone_type: 'polygon', rotation: 0, fill_color: null, notes: null,
      points: [geoAt(0, 0), geoAt(4, 0), geoAt(4, 3), geoAt(0, 3)],
    }],
    annotations: [],
    measurement_guides: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    extra: {},
  }
}

describe('2.1-Q359 exported file names', () => {
  it.fails('Q359 (2a-4): a forbidden character in the Design name becomes a space and spaces collapse in the GeoJSON file name', async () => {
    const host = createLiveTestCanvasRuntimeHost()
    hosts.push(host)
    host.surfaces.documents.loadDocument(designWithOneZone())
    const names: string[] = []
    const files: GeoJsonFileAdapter = {
      pickGeoJsonFile: vi.fn(async () => null),
      writeGeoJsonFile: vi.fn(async (_text: string, fileName: string) => { names.push(fileName); return 'written' as const }),
    }
    const workflow = createGeoJsonWorkflow({
      files,
      notify: () => {},
      designName: () => 'Kitchen / garden: north',
      canvas: () => host.surfaces,
    })

    await expect(workflow.exportGeoJson()).resolves.toMatchObject({ status: 'written' })
    expect(names).toEqual(['Kitchen garden north.geojson'])
  })
})
