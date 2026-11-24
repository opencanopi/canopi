// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { editionPorts, hasEditionPorts, installEditionPorts } from '../../platform/edition-ports'
import { bootWebEdition } from './boot'
import { createWebAppCatalog, createWebShellShortcutSource } from './WebApp'

describe('bootWebEdition (canopi-f47t.52.71)', () => {
  it('installs Web edition ports and cleanly disposes all bindings', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dispose = bootWebEdition()
    expect(hasEditionPorts()).toBe(true)
    const ports = editionPorts()
    expect(ports.capabilities).toBeDefined()
    expect(ports.manifest?.panels.length).toBeGreaterThan(0)
    expect(ports.problemReport).toBeDefined()
    for (const reader of Object.values(ports.problemReport.sections)) {
      if (typeof reader === 'function') expect(reader()).toBeDefined()
    }
    expect(ports.problemReport.currentDesign()).toBeNull()
    const catalog = createWebAppCatalog()
    const shortcuts = createWebShellShortcutSource(catalog)
    expect(shortcuts.readState().hasDesign).toBe(false)
    const restore = installEditionPorts(ports)
    expect(editionPorts()).toBe(ports)
    restore()
    dispose()
    // Second dispose is a safe no-op.
    dispose()
    expect(hasEditionPorts()).toBe(false)
    expect(() => editionPorts()).toThrow(/not installed/)
    vi.restoreAllMocks()
  })
})
