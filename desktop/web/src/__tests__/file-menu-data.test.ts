import { afterEach, describe, expect, it, vi } from 'vitest'

const navigation = vi.hoisted(() => ({
  beginDataImport: vi.fn(async () => undefined),
  openDataLibrary: vi.fn(),
}))

vi.mock('../app/lidar/library-navigation', async (importOriginal) => ({
  ...await importOriginal<typeof LibraryNavigationModule>(),
  ...navigation,
}))

const fileActions = vi.hoisted(() => ({
  closeDesign: vi.fn(async () => undefined),
  exportCurrentBudgetCsv: vi.fn(async () => undefined),
}))

vi.mock('../app/document-session/actions', async (importOriginal) => ({
  ...await importOriginal<typeof DocumentSessionActionsModule>(),
  closeDesign: fileActions.closeDesign,
}))

vi.mock('../app/budget/export', async (importOriginal) => ({
  ...await importOriginal<typeof BudgetExportModule>(),
  exportCurrentBudgetCsv: fileActions.exportCurrentBudgetCsv,
}))

import { DESKTOP_SHELL_COMMAND_CATALOG } from '../commands/graph/catalog'
import type { ShellCommandState } from '../app/shell-commands'
import { t } from '../i18n'
import type * as LibraryNavigationModule from '../app/lidar/library-navigation'
import type * as DocumentSessionActionsModule from '../app/document-session/actions'
import type * as BudgetExportModule from '../app/budget/export'

const withDesign: ShellCommandState = { hasDesign: true, revertAvailable: false, activePanel: 'canvas', sidePanel: null }
const command = (id: string) => DESKTOP_SHELL_COMMAND_CATALOG.find((entry) => entry.id === id)!

describe('File menu (Desktop)', () => {
  afterEach(() => vi.clearAllMocks())

  it('lists the two imports and the Data library flat, in one section (U49 Q8)', () => {
    const imports = DESKTOP_SHELL_COMMAND_CATALOG
      .filter((entry) => entry.menu?.id === 'file' && entry.menu.section === 2 && !('submenu' in entry.menu && entry.menu.submenu))
      .map((entry) => t(entry.labelKey))
    expect(imports).toEqual(['Import terrain or height data…', 'Import GeoJSON…', 'Data library…'])
  })

  it('imports terrain or height data into the open Design, and needs a Design', () => {
    const addData = command('file.addData')
    expect(addData.isExecutionDisabled({ ...withDesign, hasDesign: false })).toBe(true)
    expect(addData.isExecutionDisabled(withDesign)).toBe(false)

    addData.execute()

    expect(navigation.beginDataImport).toHaveBeenCalledOnce()
    expect(navigation.beginDataImport).toHaveBeenCalledWith()
  })

  it('opens the Data library, with or without a Design', () => {
    const library = command('file.dataLibrary')
    expect(library.isExecutionDisabled({ ...withDesign, hasDesign: false })).toBe(false)

    library.execute()

    expect(navigation.openDataLibrary).toHaveBeenCalledWith()
  })

  it('closes the Design and exports the Budget from the File menu, each needing a Design', () => {
    for (const id of ['file.close', 'file.exportBudgetCsv']) {
      expect(command(id).isExecutionDisabled({ ...withDesign, hasDesign: false }), id).toBe(true)
      command(id).execute()
    }
    expect(command('file.close').shortcut).toBe('Ctrl+W')
    expect(fileActions.closeDesign).toHaveBeenCalledOnce()
    expect(fileActions.exportCurrentBudgetCsv).toHaveBeenCalledOnce()
  })
})
