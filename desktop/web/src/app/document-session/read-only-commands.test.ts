// @vitest-environment jsdom

// A read-only Design offers Close only (2.1-Q315, M478; canopi-f47t.52.270): Rename, Save, Save as, Revert, the
// imports, the exports, Download a copy and the saved-view edits are off in both editions' command catalogs, so the
// menus, the palette and the keys leave them; Close and the panels stay. Read through the real Desktop catalog and the
// real Web catalog over the one Design Session store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isCatalogCommandDisabled, type AppCommandId } from '../../commands/graph/catalog'
import { createBrowserShellCatalog } from '../../web/browser-shell-commands'
import { createDesignSessionStoreTestFixture, designSessionStore, EDITING_DESIGN_SESSION } from './store'
import type { CanopiFile } from '../../types/design'

const fixture = createDesignSessionStoreTestFixture(designSessionStore)

const SHOWN: CanopiFile = {
  version: 9,
  name: 'Orchard 2.1',
  description: null,
  plant_species_colors: {},
  plant_species_symbols: {},
  layers: [],
  plants: [],
  zones: [],
  annotations: [],
  measurement_guides: [],
  groups: [],
  consortiums: [],
  timeline: [],
  budget: [],
  budget_currency: 'EUR',
  views: [],
  stories: [],
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  extra: {},
}

/** Every command that changes, writes or carries the Design out. */
const CHANGES_OR_EXPORTS = [
  'file.rename',
  'file.save',
  'file.saveAs',
  'file.revert',
  'file.addData',
  'file.importGeoJson',
  'file.exportCanvasPdf',
  'file.exportGeoJson',
  'file.exportBudgetCsv',
  'view.saveCurrentView',
  'view.manageViews',
] as const

function openShown(kind: 'editing' | 'read-only'): void {
  designSessionStore.replaceCurrentDesignState(SHOWN, null, SHOWN.name, kind === 'read-only'
    ? { kind: 'read-only', origin: 'newer-version', savedByVersion: 10 }
    : EDITING_DESIGN_SESSION)
}

beforeEach(() => openShown('read-only'))
afterEach(() => fixture.reset())

describe('R1 canopi-f47t.52.270: a read-only Design offers Close only', () => {
  it('Desktop: the catalog turns off every change, save and export, and keeps Close', () => {
    const enabled = CHANGES_OR_EXPORTS.filter((id) => !isCatalogCommandDisabled(id as AppCommandId))
    expect(enabled).toEqual([])
    expect(isCatalogCommandDisabled('file.close')).toBe(false)
    expect(isCatalogCommandDisabled('nav.layers')).toBe(false)
  })

  it('Desktop: an editing Design of the same content keeps Rename, Save and Save as', () => {
    openShown('editing')
    expect(isCatalogCommandDisabled('file.rename')).toBe(false)
    expect(isCatalogCommandDisabled('file.save')).toBe(false)
    expect(isCatalogCommandDisabled('file.saveAs')).toBe(false)
  })

  it('Web: the catalog turns off Rename, Download a copy, Revert, the imports and the exports, and keeps Close', () => {
    const run = vi.fn()
    const catalog = createBrowserShellCatalog({
      newDesign: run,
      openCanopi: run,
      downloadCanopi: run,
      revertDesign: run,
      importGeoJson: run,
      exportGeoJson: run,
      exportBudgetCsv: run,
      closeDesign: run,
      navigate: run,
    }, { templatesEnabled: false, canvasReady: () => true })
    const state = { hasDesign: true, revertAvailable: true, activePanel: 'canvas', sidePanel: null } as const
    const enabled = catalog.filter((entry) => !entry.isExecutionDisabled(state)).map((entry) => entry.id)
    for (const id of ['file.rename', 'file.downloadCanopi', 'file.revert', 'file.importGeoJson', 'file.exportGeoJson', 'file.exportBudgetCsv', 'file.exportCanvasPdf', 'view.saveCurrentView']) {
      expect(enabled, id).not.toContain(id)
    }
    expect(enabled).toContain('file.close')
  })
})
