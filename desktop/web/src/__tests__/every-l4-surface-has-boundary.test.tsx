// @vitest-environment jsdom
// Every L4 surface (each WorkspaceSurfaces entry, each useModalLayer host and each root) renders inside an error
// boundary that reports through the failure sink (contracts §2; ADR 0025; 2.1-Q291): a fault in one shows "This panel
// couldn't load" in place while the rest keeps working. A cross-module suite: it drives the real workspace composition
// and the real dialog hosts, faulting each through the locale lookup its content renders with.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as I18nModule from '../i18n'
import { aboutCanopiDialogOpen } from '../app/about/state'
import { problemReportDialogOpen } from '../app/problem-report/state'
import { activePanel, sidePanel } from '../app/shell/state'
import { commandPaletteOpen } from '../app/shell/dialogs'
import { appCommandGraphPanelProjection } from '../commands/graph/projections'
import { AboutCanopiDialog } from '../components/shared/AboutCanopiDialog'
import { CommandPalette } from '../components/shared/CommandPalette'
import { ProblemReportDialog } from '../components/shared/ProblemReportDialog'
import { RootBoundary, type BoundedSurface } from '../components/shared/SurfaceBoundary'
import { WorkspaceDialog } from '../components/shared/WorkspaceDialog'
import { WorkspaceComposition, type WorkspaceSurfaces } from '../components/workspace/WorkspaceComposition'
import { resetFrontendDiagnosticsForTests, ringEntries } from '../failures/ring'

// While set, every locale lookup but the boundary's own throws: a dialog's content faults on its first string.
const fault = vi.hoisted(() => ({ on: false }))
vi.mock('../i18n', async (importOriginal) => {
  const original = await importOriginal<typeof I18nModule>()
  const t = ((key: string, ...rest: unknown[]) => {
    if (fault.on && !key.startsWith('boundary.')) throw new Error(`fault in ${key}`)
    return (original.t as (key: string, ...args: unknown[]) => string)(key, ...rest)
  }) as typeof original.t
  return { ...original, t }
})

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.innerHTML = ''
  document.body.appendChild(container)
  resetFrontendDiagnosticsForTests()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  activePanel.value = 'canvas'
  sidePanel.value = null
})

afterEach(() => {
  fault.on = false
  render(null, container)
  container.remove()
  commandPaletteOpen.value = false
  aboutCanopiDialogOpen.value = false
  problemReportDialogOpen.value = false
  vi.restoreAllMocks()
})

function fallback(surface: BoundedSurface): Element | null {
  return container.querySelector(`[data-surface-fallback="${surface}"]`)
}

describe('error boundaries', () => {
  it('[canopi-f47t.52.36] every L4 surface has an error boundary: each workspace surface faults in place, the canvas keeps working', async () => {
    const projection = appCommandGraphPanelProjection.value
    const sides = [...projection.design, ...projection.planning].map((command) => command.panel)
    const Broken = () => {
      throw new Error('side panel failed')
    }
    const surfaces: WorkspaceSurfaces = {
      primary: { canvas: () => <p data-canvas>Canvas</p> },
      side: Object.fromEntries(sides.map((panel) => [panel, Broken])),
    }
    await act(async () => render(<WorkspaceComposition panelProjection={projection} surfaces={surfaces} />, container))
    expect(sides.length).toBeGreaterThan(0)
    for (const panel of sides) {
      await act(async () => {
        sidePanel.value = panel as typeof sidePanel.value
      })
      const side = container.querySelector(`[data-workspace-side-panel="${panel}"]`)
      expect(side?.querySelector('[data-surface-fallback="workspace-side"]'), panel).not.toBeNull()
      expect(container.querySelector('[data-canvas]')).not.toBeNull()
    }
    expect(ringEntries().map((entry) => entry.source)).toEqual(sides.map(() => 'surface.workspace-side'))
  })

  it('the primary surface faults in place', async () => {
    const projection = appCommandGraphPanelProjection.value
    const surfaces: WorkspaceSurfaces = {
      primary: {
        canvas: () => {
          throw new Error('canvas failed')
        },
      },
      side: Object.fromEntries([...projection.design, ...projection.planning].map((command) => [command.panel, () => null])),
    }
    await act(async () => render(<WorkspaceComposition panelProjection={projection} surfaces={surfaces} />, container))
    expect(fallback('workspace-primary')).not.toBeNull()
  })

  const dialogs: readonly { surface: BoundedSurface; open(): void; host: () => preact.JSX.Element }[] = [
    { surface: 'command-palette', open: () => { commandPaletteOpen.value = true }, host: () => <CommandPalette /> },
    { surface: 'about', open: () => { aboutCanopiDialogOpen.value = true }, host: () => <AboutCanopiDialog /> },
    { surface: 'problem-report', open: () => { problemReportDialogOpen.value = true }, host: () => <ProblemReportDialog /> },
  ]
  for (const dialog of dialogs) {
    it(`the ${dialog.surface} dialog host shows its fallback as a dialog`, async () => {
      dialog.open()
      fault.on = true
      await act(async () => render(dialog.host(), container))
      const shown = fallback(dialog.surface)
      expect(shown).not.toBeNull()
      expect(shown!.closest('[role="dialog"]')).not.toBeNull()
    })
  }

  it('the workspace dialog shows its content fallback inside its own frame', async () => {
    const Broken = () => {
      throw new Error('dialog content failed')
    }
    await act(async () => render(<WorkspaceDialog title="Data library" onClose={() => {}}><Broken /></WorkspaceDialog>, container))
    expect(fallback('workspace-dialog')?.closest('[role="dialog"]')).not.toBeNull()
  })

  it('a root fault is caught by the root boundary', async () => {
    const Broken = () => {
      throw new Error('root failed')
    }
    await act(async () => render(<RootBoundary source="root.web"><Broken /></RootBoundary>, container))
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(ringEntries()).toEqual([expect.objectContaining({ source: 'root.web' })])
  })
})
