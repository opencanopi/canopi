import { describe, expect, it, vi } from 'vitest'
import {
  composeShellCommandCatalog,
  projectShellCommandCatalog,
} from '../app/shell-commands'

describe('App Command Graph shell catalog', () => {
  it('includes only the command identities supported by supplied platform capabilities', () => {
    const execute = () => undefined

    const catalog = composeShellCommandCatalog({
      newDesign: { execute },
      openCanopi: { execute },
      downloadCanopi: { execute },
      navigateCanvas: { execute },
      navigateTemplates: { execute },
      navigatePlantDatabase: { execute },
      navigateFavorites: { execute },
      toggleTheme: { execute },
    })

    expect(catalog.map((command) => command.id)).toEqual([
      'file.new',
      'file.openCanopi',
      'file.downloadCanopi',
      'nav.canvas',
      'nav.templates',
      'nav.plantDb',
      'nav.favorites',
      'view.toggleTheme',
    ])
  })

  it('composes the desktop command identities without browser file capabilities', () => {
    const execute = () => undefined

    const catalog = composeShellCommandCatalog({
      newDesign: { execute },
      openDesign: { execute },
      saveDesign: { execute },
      saveDesignAs: { execute },
      exitApp: { execute },
      navigateCanvas: { execute },
      navigatePlantDatabase: { execute },
      navigateFavorites: { execute },
      navigateDesignNotebook: { execute },
      toggleTheme: { execute },
    })

    expect(catalog.map((command) => command.id)).toEqual([
      'file.new',
      'file.open',
      'file.save',
      'file.saveAs',
      'file.exit',
      'nav.canvas',
      'nav.plantDb',
      'nav.favorites',
      'nav.designNotebook',
      'view.toggleTheme',
    ])
  })

  it('projects caller-ready browser menu and panel commands', () => {
    const newDesign = vi.fn()
    const downloadCanopi = vi.fn()
    const navigateFavorites = vi.fn()
    const catalog = composeShellCommandCatalog({
      newDesign: { execute: newDesign },
      openCanopi: { execute: () => undefined },
      downloadCanopi: {
        execute: downloadCanopi,
        isProjectionDisabled: (state) => !state.hasDesign,
      },
      navigateCanvas: { execute: () => undefined },
      navigatePlantDatabase: { execute: () => undefined },
      navigateFavorites: { execute: navigateFavorites },
      toggleTheme: { execute: () => undefined },
    })

    const projection = projectShellCommandCatalog(catalog, {
      hasDesign: false,
      revertAvailable: false,
      activePanel: 'canvas',
      sidePanel: 'favorites',
    }, (key) => `translated:${key}`)

    expect(projection.menus.map((menu) => ({
      id: menu.id,
      commandIds: menu.sections.flat().map((command) => command.id),
    }))).toEqual([
      { id: 'file', commandIds: ['file.new', 'file.openCanopi', 'file.downloadCanopi'] },
      { id: 'view', commandIds: ['view.toggleTheme'] },
    ])
    expect(projection.menus[0]?.sections.map((section) =>
      section.map((command) => command.id)
    )).toEqual([
      ['file.new', 'file.openCanopi'],
      ['file.downloadCanopi'],
    ])
    expect(projection.panelBar.primary.map((command) => command.id)).toEqual(['nav.canvas'])
    expect(projection.panelBar.design.map((command) => command.id)).toEqual([
      'nav.plantDb',
      'nav.favorites',
    ])
    expect(projection.panelBar.planning).toEqual([])
    expect(projection.commands.get('file.downloadCanopi')).toMatchObject({ disabled: true })
    expect(projection.commands.get('nav.favorites')).toMatchObject({
      label: 'translated:panelRail.favorites',
      shortcut: 'translated:shortcutKeys.alt translated:shortcutKeys.shift 5',
      ariaShortcut: 'Alt+Shift+5',
      active: true,
      disabled: false,
    })
    expect(projection.commands.get('nav.canvas')).toMatchObject({ active: false })

    projection.commands.get('file.new')?.action()
    projection.commands.get('file.downloadCanopi')?.action()
    projection.commands.get('nav.favorites')?.action()

    expect(newDesign).toHaveBeenCalledOnce()
    expect(downloadCanopi).not.toHaveBeenCalled()
    expect(navigateFavorites).toHaveBeenCalledOnce()
  })

  it('projects checkable commands with their state and hides shortcuts the edition cannot receive', () => {
    let dark = true
    const catalog = composeShellCommandCatalog({
      newDesign: { execute: () => undefined },
      navigateLayers: { execute: () => undefined },
      toggleTheme: { execute: () => { dark = !dark }, isChecked: () => dark },
    })
    const state = { hasDesign: true, revertAvailable: false, activePanel: 'canvas' as const, sidePanel: null }
    const projection = projectShellCommandCatalog(catalog, state, (key) => key === 'shortcutKeys.ctrl' ? 'Ctrl' : key, {
      unavailableShortcuts: new Set(['Ctrl+N']),
    })

    expect(projection.commands.get('view.toggleTheme')).toMatchObject({ check: 'checkbox', checked: true })
    expect(projection.commands.get('file.new')?.shortcut).toBe('shortcutKeys.alt shortcutKeys.shift N')
    expect(projection.commands.get('nav.layers')?.shortcut).toBe('shortcutKeys.alt shortcutKeys.shift 1')
    expect(projection.commands.get('file.new')?.checked).toBeUndefined()

    const hiddenProjection = projectShellCommandCatalog(catalog, state, (key) => key === 'shortcutKeys.ctrl' ? 'Ctrl' : key, {
      unavailableShortcuts: new Set(['Ctrl+N', 'Alt+Shift+N']),
    })
    expect(hiddenProjection.commands.get('file.new')?.shortcut).toBeUndefined()
  })
})
