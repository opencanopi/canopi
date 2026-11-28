import { afterEach, describe, expect, it } from 'vitest'
import type { NewDesignInputContract, SavedObjectStampPayload } from '../../generated/contracts'
import { installCommandTransport } from '../../types/command-transport'
import { createGalleryEditionPorts } from './ports'

describe('createGalleryEditionPorts', () => {
  let disposeTransport: (() => void) | null = null

  afterEach(() => {
    disposeTransport?.()
    disposeTransport = null
  })

  it('provides inert gallery ports and refuses DesignCore codec calls', async () => {
    const ports = createGalleryEditionPorts('web')
    expect(ports.settings.load()).toBeDefined()
    await ports.settings.save({} as never)
    expect(ports.problemReport.currentDesign()).toBeNull()
    expect(await ports.problemReport.write({} as never)).toEqual({ file_name: 'gallery-report.zip' })
    expect(await ports.geocoding('test', {} as never)).toEqual([])
    expect(await ports.fileDelivery.deliverFile('pdf', 'plan', { bytes: new Uint8Array() }, new AbortController().signal)).toBe('downloaded')
    ports.fileDelivery.dispose?.()
    expect(await ports.fileDelivery.deliverFile('budget-csv', 'budget', { text: 'a,b' })).toBe('downloaded')
    expect(await ports.designHome.read({} as never)).toEqual({ kind: 'absent' })
    expect(await ports.designHome.write({} as never, new Uint8Array(), null)).toEqual({
      kind: 'written',
      version: 'gallery-v1',
    })
    if ('listDrafts' in ports.designHome) {
      expect(await ports.designHome.listDrafts()).toEqual([])
      expect(await ports.designHome.deleteDraft('d' as never)).toEqual({ ok: true })
      ports.designHome.onVersionChange(() => {})()
    }
    expect(await ports.fileAccess.pickOpen('canopi')).toEqual({ kind: 'cancelled' })
    expect(await ports.fileAccess.pickHomeTarget({} as never)).toEqual({ kind: 'cancelled' })
    ports.appLifecycle.subscribe(() => {})()

    const stamp: SavedObjectStampPayload = {
      version: 3,
      anchor: { x: 0, y: 0 },
      plants: [],
      zones: [],
      annotations: [],
      measurement_guides: [],
      groups: [],
    }
    const input: NewDesignInputContract = { name: 'A', created_at: '2026-11-26T00:00:00Z' }
    expect(await ports.designCore.version()).toBe('gallery')
    await expect(ports.designCore.decode(new Uint8Array())).rejects.toThrow()
    await expect(ports.designCore.encode({})).rejects.toThrow()
    await expect(ports.designCore.newDesign(input)).rejects.toThrow()
    await expect(ports.designCore.draftSummary(new Uint8Array(), '2026-11-26T00:00:00Z')).rejects.toThrow()
    await expect(ports.designCore.decodeStamp('{}')).rejects.toThrow()
    await expect(ports.designCore.encodeStamp(stamp)).rejects.toThrow()
  })

  it('lists the Data library through the installed Gallery command transport and resolves asset URLs without throwing', async () => {
    const calls: string[] = []
    disposeTransport = installCommandTransport(async (command) => {
      calls.push(command)
      if (command === 'lidar_list_library') {
        return {
          items: [
            {
              id: 'lidar-ground',
              name: 'IGN ground elevation',
              role: 'Source',
              item_type: { kind: 'Raster', quantity: 'GroundElevation' },
              units: 'm',
              state: 'Ready',
              generation_id: 'lidar-ground-g1',
              bounds: [12.9998, 22.9998, 13.0001, 23.0002],
              value_range: [131.2, 287.8],
              display_range: { min: 131.2, max: 287.8, basis: 'Exact' },
              resolution_m: 0.5,
              coverage_cells: '4000000',
              import_job: null,
              provenance: null,
              freshness: { state: 'Current' },
              run: null,
              offers: [],
              dependents: 0,
              created_at: '1789205400000',
            },
          ],
          read_only: false,
          read_only_reason: null,
        }
      }
      return null
    })

    const ports = createGalleryEditionPorts('desktop')
    const snapshot = await ports.dataLibrary.listLibrary()
    expect(calls).toEqual(['lidar_list_library'])
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]?.id).toBe('lidar-ground')
    expect(ports.dataLibrary.resolveAssetUrl('/assets/cog.tif')).toBe('/assets/cog.tif')
  })
})
