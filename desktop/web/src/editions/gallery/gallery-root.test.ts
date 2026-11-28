// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { h, render } from 'preact'
import { useRef } from 'preact/hooks'
import {
  GALLERY_LOCATION_STATES,
  GALLERY_SURFACES,
  parseGalleryLocationState,
  parseGallerySurface,
  selectGalleryPanel,
  type GallerySurface,
} from './surface-routing'
import { createGallerySpeciesCatalogWorkbench } from './species-catalog'
import { installSpeciesCatalogWorkbench, speciesCatalogWorkbench } from '../../app/plant-browser'
import { notebookWorkbench } from './notebook-fixture'
import { designFixture } from './fixtures'
import { createGalleryEditionPorts } from './ports'
import { installCanvasHostRuntime, useCanvasHost } from '../../app/canvas-map-surface/use-canvas-host'
import type { CanvasHostRuntimeBinding } from '../../app/canvas-map-surface/use-canvas-host'

describe('gallery root helpers (canopi-f47t.52.233)', () => {
  it('parses gallery surfaces and location states and selects panels', () => {
    expect(parseGallerySurface(null)).toBe('color')
    expect(parseGallerySurface('unknown')).toBe('color')
    for (const surface of Object.keys(GALLERY_SURFACES) as GallerySurface[]) {
      expect(parseGallerySurface(surface)).toBe(surface)
      selectGalleryPanel(surface)
    }

    expect(parseGalleryLocationState(null)).toBe('following')
    expect(parseGalleryLocationState('invalid')).toBe('following')
    for (const loc of GALLERY_LOCATION_STATES) {
      expect(parseGalleryLocationState(loc)).toBe(loc)
    }
  })

  it('binds gallery species catalog workbench over the gallery command transport', async () => {
    const wb = createGallerySpeciesCatalogWorkbench()
    const unmount = wb.mount('catalog')
    await wb.loadFilterOptions()
    await wb.loadDynamicOptions(['habits'])
    await wb.reloadSidebarLists()
    wb.setSearchText('apple')
    wb.retrySearch()
    await wb.loadFavorites()
    expect(wb.favorites.value.items.length).toBeGreaterThan(0)
    const names = await wb.resolveCommonNames(['Malus domestica'], 'en')
    expect(names['Malus domestica']).toBe('Apple')
    const habits = await wb.resolveHabits(['Malus domestica'])
    expect(habits['Malus domestica']).toBe('Tree')
    await wb.toggleFavorite('Malus domestica')
    await wb.toggleFavorite('Malus domestica')
    const uninstall = installSpeciesCatalogWorkbench(wb)
    expect('favorites' in speciesCatalogWorkbench).toBe(true)
    expect(Object.keys(speciesCatalogWorkbench).length).toBeGreaterThan(0)
    expect(Object.getOwnPropertyDescriptor(speciesCatalogWorkbench, 'favorites')).toBeDefined()
    uninstall()
    expect(Object.keys(speciesCatalogWorkbench)).toEqual([])
    expect(Object.getOwnPropertyDescriptor(speciesCatalogWorkbench, 'favorites')).toBeUndefined()
    unmount()
    wb.dispose()
  })

  it('exercises the in-memory gallery notebook workbench operations', async () => {
    await notebookWorkbench.load()
    await notebookWorkbench.createSection('Test section')
    const createdId = notebookWorkbench.view.value.sections.find((s) => s.name === 'Test section')?.id
    expect(createdId).toBeDefined()
    if (createdId) {
      await notebookWorkbench.renameSection(createdId, 'Renamed section')
      await notebookWorkbench.reorderSections([createdId, 'site', 'studies'])
      await notebookWorkbench.moveEntryToSection('/gallery/orchard.canopi', createdId)
      const paths = notebookWorkbench.view.value.entries.map((e) => e.path)
      await notebookWorkbench.reorderEntries([...paths].reverse())
      await notebookWorkbench.relocateEntry('/gallery/orchard.canopi', 'site', paths)
      await notebookWorkbench.deleteSection(createdId)
    }
    await notebookWorkbench.openEntry('/gallery/design-1.canopi')
    await notebookWorkbench.addCurrentDesignToNotebook('site')
    const fixture = designFixture()
    expect(fixture.plants.length).toBeGreaterThan(0)
    await notebookWorkbench.removeEntry('/gallery/design-4.canopi')
    await notebookWorkbench.load()
  })

  it('restricts installCommandTransport and installAssetUrlResolver to gallery and tests (contracts §13)', () => {
    const srcRoot = resolve(import.meta.dirname, '../..')
    const offenders: string[] = []
    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        const rel = relative(srcRoot, full).replaceAll('\\', '/')
        if (
          rel === 'types/command-transport.ts'
          || rel.startsWith('editions/gallery/')
          || rel.startsWith('__tests__/')
          || /\.test\.tsx?$/.test(rel)
        ) continue
        const text = readFileSync(full, 'utf8')
        if (/\binstallCommandTransport\b/.test(text)) {
          offenders.push(`${rel}: installCommandTransport`)
        }
        if (rel !== 'ipc/transport.ts' && /\binstallAssetUrlResolver\b/.test(text)) {
          offenders.push(`${rel}: installAssetUrlResolver`)
        }
      }
    }
    walk(srcRoot)
    expect(offenders).toEqual([])
  })

  it('provides gallery edition ports and desktop runtime override hook', async () => {
    const desktopPorts = createGalleryEditionPorts('desktop')
    const webPorts = createGalleryEditionPorts('web')
    expect(desktopPorts.capabilities.has('file-home')).toBe(true)
    expect(webPorts.capabilities.has('file-home')).toBe(false)
    expect(desktopPorts.settings.load()).toBeDefined()
    await desktopPorts.settings.save({} as never)
    expect(desktopPorts.problemReport.currentDesign()).toBeNull()
    expect((await desktopPorts.problemReport.write({} as never)).file_name).toBe('gallery-report.zip')
    expect(await desktopPorts.geocoding('Paris', {} as never)).toEqual([])
    expect(await desktopPorts.fileDelivery.deliverFile('pdf', 'test', { bytes: new Uint8Array() }, new AbortController().signal)).toBe('downloaded')
    desktopPorts.fileDelivery.dispose?.()
    expect(await desktopPorts.fileDelivery.deliverFile('budget-csv', 'budget', { text: '{}' })).toBe('downloaded')

    const sentinel = {} as CanvasHostRuntimeBinding
    const uninstall = installCanvasHostRuntime(() => sentinel)
    expect(typeof uninstall).toBe('function')
    uninstall()

    const host = document.createElement('div')
    document.body.appendChild(host)
    let caught: unknown = null
    function UninstalledProbe() {
      const ref = useRef<HTMLDivElement>(null)
      useCanvasHost(ref)
      return h('div', { ref })
    }
    try {
      render(h(UninstalledProbe, null), host)
    } catch (error) {
      caught = error
    } finally {
      render(null, host)
      host.remove()
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('Canvas host runtime is not installed')
  })
})
