import { describe, expect, it } from 'vitest'
import type { DraftId } from '../../platform/design-home'
import { createGalleryEditionPorts } from './ports'

describe('createGalleryEditionPorts', () => {
  it('provides stub ports for desktop and web gallery fixtures without side effects', async () => {
    const ports = createGalleryEditionPorts('desktop')
    expect(ports.settings.load()).toBeDefined()
    await expect(ports.settings.save({} as never)).resolves.toBeUndefined()
    expect(ports.problemReport.currentDesign()).toBeNull()
    await expect(ports.problemReport.write({} as never)).resolves.toEqual({ file_name: 'gallery-report.zip' })
    await expect(ports.geocoding('Paris')).resolves.toEqual([])
    const pdf = ports.canvasPdfDelivery()
    await expect(pdf.save(new Uint8Array(), 'plan.pdf', new AbortController().signal)).resolves.toBe('downloaded')
    pdf.dispose()
    await expect(ports.budgetExportDelivery('{}', 'budget.csv')).resolves.toBeUndefined()
    await expect(ports.designHome.read('k')).resolves.toEqual({ kind: 'absent' })
    await expect(ports.designHome.write('k', new Uint8Array(), null)).resolves.toEqual({ kind: 'written', version: 'gallery-v1' })
    if ('listDrafts' in ports.designHome) {
      await expect(ports.designHome.listDrafts()).resolves.toEqual([])
      await expect(ports.designHome.deleteDraft('d' as DraftId)).resolves.toEqual({ ok: true })
      ports.designHome.onVersionChange(() => {})()
    }
    await expect(ports.fileAccess.pickOpen('canopi')).resolves.toEqual({ kind: 'cancelled' })
    await expect(ports.fileAccess.pickHomeTarget('x')).resolves.toEqual({ kind: 'cancelled' })
    ports.appLifecycle.subscribe(() => {})()
    await expect(ports.designCore.readNewerDesign('{}')).rejects.toThrow(/Gallery edition/)
  })
})
