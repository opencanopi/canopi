// Phase 2 commit 0: 2.1-Q358, written before 2a-2 builds it (it.fails until then). Web's menus follow M163: a command
// Web lacks (the Data library, Desktop only) stays in the menu bar greyed, with its note, instead of vanishing.
// 2a-2 turns it.fails into it (2c-1 owns the right-click side, which leaves a lacking command out).

import { describe, expect, it, vi } from 'vitest'
import { t } from '../../i18n'
import { createBrowserShellCatalog } from '../../web/browser-shell-commands'
import { projectShellCommandCatalog } from './index'

describe('2.1-Q358 commands Web lacks', () => {
  it.fails('Q358 (2a-2): the Web File menu shows Open Data library greyed, not left out', () => {
    const catalog = createBrowserShellCatalog({
      newDesign: vi.fn(), openCanopi: vi.fn(), downloadCanopi: vi.fn(), revertDesign: vi.fn(),
      importGeoJson: vi.fn(), exportGeoJson: vi.fn(), exportBudgetCsv: vi.fn(), closeDesign: vi.fn(), navigate: vi.fn(),
    }, { templatesEnabled: false, canvasReady: () => true })
    const projection = projectShellCommandCatalog(catalog, { hasDesign: true, revertAvailable: false, activePanel: 'canvas', sidePanel: null }, t)

    const fileMenu = projection.menus.find((menu) => menu.id === 'file')
    const library = fileMenu?.sections.flat().find((command) => (command.id as string) === 'file.dataLibrary')
    expect(library, 'the Data library command is in the Web File menu').toBeDefined()
    expect(library?.disabled).toBe(true)
  })
})
