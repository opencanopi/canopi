import { describe, expect, it } from 'vitest'
import type { NewDesignInputContract, SavedObjectStampPayload } from '../../generated/contracts'
import { createGalleryEditionPorts } from './ports'

describe('createGalleryEditionPorts', () => {
  it('provides inert gallery ports and refuses DesignCore codec calls', async () => {
    const ports = createGalleryEditionPorts('web')
    expect(ports.settings.load()).toBeDefined()
    await ports.settings.save({} as never)
    expect(ports.problemReport.currentDesign()).toBeNull()
    expect(await ports.problemReport.write({} as never)).toEqual({ file_name: 'gallery-report.zip' })
    expect(await ports.geocoding('test', {} as never)).toEqual([])
    const pdf = ports.canvasPdfDelivery()
    expect(await pdf.save(new Uint8Array(), 'plan.pdf', new AbortController().signal)).toBe('downloaded')
    pdf.dispose()
    await ports.budgetExportDelivery('a,b', 'budget.csv')
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
    await expect(ports.designCore.readNewerDesign('{}')).rejects.toThrow()
  })
})
