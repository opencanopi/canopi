// app/command-table/command-table.test.ts
// Policy and unit tests for the unified command table, keymap, and reserved-chord table
// (canopi-f47t.52.76, 2.1-Q117, 2.1-Q132, 2.1-Q343, 2.1-Q358).
import { describe, expect, it, vi } from 'vitest'
import type { ToolId as RuntimeToolId } from '../../canvas/runtime/interaction-types'
import { DESKTOP_SHELL_COMMAND_CATALOG } from '../../commands/graph/catalog'
import { DESKTOP_KEYMAP } from '../../commands/graph/shortcuts'
import { createBrowserShellCatalog } from '../../editions/web/browser-shell-commands'
import { t } from '../../i18n'
import { chordMatches, chordsOfShortcut } from '../keyboard/key-chord'
import { CANVAS_KEYMAP_ROWS, shellKeymapRows, type KeymapRow } from '../keyboard/keymap'
import { projectShellCommandCatalog, type ShellCommandState } from '../shell-commands'
import { PANEL_DESCRIPTORS } from './panels'
import { BROWSER_RESERVED_CHORDS, resolveDisplayedShortcut } from './reserved-chords'
import type { ToolId as CommandTableToolId } from './tools'

const STATE: ShellCommandState = {
  hasDesign: true,
  revertAvailable: false,
  activePanel: 'canvas',
  sidePanel: null,
}

function isRouted(keymap: readonly KeymapRow[], commandId: string, canonicalShortcut: string): boolean {
  const expected = chordsOfShortcut(canonicalShortcut)
  return keymap.some((row) =>
    (row.command === commandId || row.fallback === commandId)
    && expected.every((chord) => row.chords.some((rowChord) => chordMatches(rowChord, chord))),
  )
}

describe('command-table keymap & reserved chords (canopi-f47t.52.76, 2.1-Q343)', () => {
  it('every shown shell chord on Desktop and Web is a routed chord in that edition keymap', () => {
    const desktopProjection = projectShellCommandCatalog(DESKTOP_SHELL_COMMAND_CATALOG, STATE, t)
    for (const entry of DESKTOP_SHELL_COMMAND_CATALOG) {
      const shown = resolveDisplayedShortcut(entry.shortcuts ?? (entry.shortcut ? [entry.shortcut] : undefined))
      if (!shown) continue
      expect(desktopProjection.commands.get(entry.id)?.shortcut).toBeDefined()
      expect(isRouted(DESKTOP_KEYMAP, entry.id, shown), `Desktop shown chord '${shown}' for '${entry.id}' is not routed`).toBe(true)
    }

    const webCatalog = createBrowserShellCatalog({
      newDesign: vi.fn(), openCanopi: vi.fn(), downloadCanopi: vi.fn(), revertDesign: vi.fn(),
      importGeoJson: vi.fn(), exportGeoJson: vi.fn(), exportBudgetCsv: vi.fn(), closeDesign: vi.fn(), navigate: vi.fn(),
    }, { canvasReady: () => true })
    const webKeymap = [...shellKeymapRows(webCatalog, { omit: BROWSER_RESERVED_CHORDS }), ...CANVAS_KEYMAP_ROWS]
    const webProjection = projectShellCommandCatalog(webCatalog, STATE, t, { unavailableShortcuts: BROWSER_RESERVED_CHORDS })

    for (const entry of webCatalog) {
      const shown = resolveDisplayedShortcut(
        entry.shortcuts ?? (entry.shortcut ? [entry.shortcut] : undefined),
        BROWSER_RESERVED_CHORDS,
      )
      if (!shown) continue
      expect(BROWSER_RESERVED_CHORDS.has(shown), `Web shown chord '${shown}' collides with BROWSER_RESERVED_CHORDS`).toBe(false)
      expect(webProjection.commands.get(entry.id)?.shortcut).toBeDefined()
      expect(isRouted(webKeymap, entry.id, shown), `Web shown chord '${shown}' for '${entry.id}' is not routed`).toBe(true)
    }
  })

  it('CommandTable ToolId stays bidirectionally identical to canvas/runtime/tool-id.ts', () => {
    const runtimeToTable = (id: RuntimeToolId): CommandTableToolId => id
    const tableToRuntime = (id: CommandTableToolId): RuntimeToolId => id
    expect([runtimeToTable('select'), tableToRuntime('profile')]).toEqual(['select', 'profile'])
  })

  it('PANEL_DESCRIPTORS lists all 11 panels with unique ids and browser-safe Alt+Shift chords', () => {
    expect(PANEL_DESCRIPTORS).toHaveLength(11)
    expect(new Set(PANEL_DESCRIPTORS.map((p) => p.panel)).size).toBe(11)
    for (const desc of PANEL_DESCRIPTORS) {
      if (!desc.shortcuts) continue
      const shared = resolveDisplayedShortcut(desc.shortcuts, BROWSER_RESERVED_CHORDS)
      expect(shared, `Panel '${desc.panel}' lacks a browser-safe shortcut`).toBeDefined()
      expect(BROWSER_RESERVED_CHORDS.has(shared!)).toBe(false)
    }
  })
})
