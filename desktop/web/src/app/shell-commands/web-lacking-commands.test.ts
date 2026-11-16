// Phase 2 commit 0: 2.1-Q358, written before 2a-2 builds it (it.fails until then). Web's menus follow M163: a command
// Web lacks (the Data library, Desktop only) stays in the menu bar and the palette greyed, with its note (the row's
// Instead text), instead of vanishing. 2a-2 turns it.fails into it (2c-1 owns the right-click side, which leaves a
// lacking command out). The projected command has no note field yet: `note` is this test's name for it, which 2a-2
// may rename with the test.

import { describe, expect, it, vi } from 'vitest'
import { t } from '../../i18n'
import { createBrowserShellCatalog } from '../../web/browser-shell-commands'
import { projectShellCommandCatalog, type ShellCommandState } from './index'

const STATE: ShellCommandState = { hasDesign: true, revertAvailable: false, activePanel: 'canvas', sidePanel: null }

function noteOf(command: unknown): unknown {
  return typeof command === 'object' && command !== null && 'note' in command ? command.note : undefined
}

describe('2.1-Q358 commands Web lacks', () => {
  it.fails('Q358 (2a-2): Web shows Open Data library greyed with its note in the File menu and the palette, not left out', () => {
    const catalog = createBrowserShellCatalog({
      newDesign: vi.fn(), openCanopi: vi.fn(), downloadCanopi: vi.fn(), revertDesign: vi.fn(),
      importGeoJson: vi.fn(), exportGeoJson: vi.fn(), exportBudgetCsv: vi.fn(), closeDesign: vi.fn(), navigate: vi.fn(),
    }, { templatesEnabled: false, canvasReady: () => true })
    const projection = projectShellCommandCatalog(catalog, STATE, t)

    const fileMenu = projection.menus.find((menu) => menu.id === 'file')
    const library = fileMenu?.sections.flat().find((command) => (command.id as string) === 'file.dataLibrary')
    expect(library, 'the Data library command is in the Web File menu').toBeDefined()
    expect(library?.disabled).toBe(true)
    const note = noteOf(library)
    expect(typeof note === 'string' && note.trim().length > 0, 'the menu row carries its note').toBe(true)

    // The palette lists the catalogue's palette rows: the lacking row is one of them, greyed, with the same note.
    const entry = catalog.find((row) => (row.id as string) === 'file.dataLibrary')
    expect(entry?.palette, 'the Data library command is in the Web palette').toBe(true)
    expect(entry?.isProjectionDisabled(STATE), 'greyed in the palette').toBe(true)
    expect(noteOf(projection.commands.get(entry!.id)), 'the palette row carries the same note').toBe(note)
  })
})
