// @vitest-environment jsdom
// Every L4 surface (each WorkspaceSurfaces entry, each useModalLayer host and each root) renders inside an error
// boundary that reports through the failure sink (contracts §2; ADR 0025; 2.1-Q291): a fault in one shows "This panel
// couldn't load" in place while the rest keeps working. A cross-module suite: it drives the real workspace composition
// and every real host of a `BoundedSurface` member, faulting each through the locale lookup its content renders with
// or through its content. The record is keyed by `BoundedSurface`, so a new member does not compile until it is here.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Signal } from '@preact/signals'
import type * as I18nModule from '../i18n'
import type * as StoryPresentationModule from '../app/story-presentation'
import type { PresentedStep } from '../app/story-presentation'
import { aboutCanopiDialogOpen } from '../app/about/state'
import { createPdfWorkflow } from '../app/canvas-pdf/workflow'
import { answerSaveProblem, requestSaveProblemDecision } from '../app/document-session/save-problem'
import { closeDataDialog, closeDataLibrary, openDataLibrary } from '../app/lidar/library-navigation'
import { problemReportDialogOpen } from '../app/problem-report/state'
import { activePanel, sidePanel } from '../app/shell/state'
import { commandPaletteOpen } from '../app/shell/dialogs'
import { appCommandGraphPanelProjection } from '../commands/graph/projections'
import { CanvasPdfDialog } from '../components/canvas-pdf/CanvasPdfDialog'
import { AboutCanopiDialog } from '../components/shared/AboutCanopiDialog'
import { CommandPalette } from '../components/shared/CommandPalette'
import { ProblemReportDialog } from '../components/shared/ProblemReportDialog'
import { SaveProblemDialog } from '../components/shared/SaveProblemDialog'
import { StoryPresenter } from '../components/stories/StoryPresenter'
import { RootBoundary, type BoundedSurface } from '../components/shared/SurfaceBoundary'
import { WorkspaceDialog } from '../components/shared/WorkspaceDialog'
import { WorkspaceComposition, type WorkspaceSurfaces } from '../components/workspace/WorkspaceComposition'
import { DesktopWorkspace } from '../components/workspace/DesktopWorkspace'
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

// The presented story is a plain signal here, so the presenter opens without a design session and a map.
const story = vi.hoisted(() => ({ presented: null as unknown as Signal<PresentedStep | null> }))
vi.mock('../app/story-presentation', async (importOriginal) => {
  const original = await importOriginal<typeof StoryPresentationModule>()
  const { signal } = await import('@preact/signals')
  story.presented = signal<PresentedStep | null>(null)
  return { ...original, presentedStep: story.presented }
})

// The Data dialogs' content faults on render; the boundary under test is its host's, in DesktopWorkspace.
vi.mock('../components/panels/lidar/DataDialogs', () => ({
  DataDialogs: () => {
    throw new Error('data dialogs failed')
  },
}))

const PRESENTED: PresentedStep = {
  story: { id: 'story-1', name: 'Walk', steps: [{ id: 'step-1', view_id: 'view-1', title: 'Gate' }] },
  step: { id: 'step-1', view_id: 'view-1', title: 'Gate' },
  view: null,
  index: 0,
  count: 1,
}

const pdf = createPdfWorkflow({
  capture: () => null,
  prepare: vi.fn(),
  resolveDisplayNames: vi.fn(),
  resolveHabits: vi.fn(),
  delivery: { save: vi.fn(), dispose: vi.fn() },
  labels: vi.fn(),
  namePrintArea: (number) => `Print area ${number}`,
})

function BrokenContent(): never {
  throw new Error('dialog content failed')
}

function sideCommands() {
  const projection = appCommandGraphPanelProjection.value
  return [...projection.design, ...projection.planning]
}

function brokenPrimary(): WorkspaceSurfaces {
  return {
    primary: {
      canvas: () => {
        throw new Error('canvas failed')
      },
    },
    side: Object.fromEntries(sideCommands().map((command) => [command.panel, () => null])),
  }
}

function brokenSides(): WorkspaceSurfaces {
  const Broken = () => {
    throw new Error('side panel failed')
  }
  return {
    primary: { canvas: () => <p data-canvas>Canvas</p> },
    side: Object.fromEntries(sideCommands().map((command) => [command.panel, Broken])),
  }
}

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
  story.presented.value = null
  answerSaveProblem('cancel')
  closeDataDialog()
  closeDataLibrary()
  pdf.close()
  vi.restoreAllMocks()
})

function fallback(surface: BoundedSurface): Element | null {
  return container.querySelector(`[data-surface-fallback="${surface}"]`)
}

describe('error boundaries', () => {
  it('[canopi-f47t.52.36] every L4 surface has an error boundary: each workspace surface faults in place, the canvas keeps working', async () => {
    const sides = sideCommands().map((command) => command.panel)
    await act(async () => render(<WorkspaceComposition panelProjection={appCommandGraphPanelProjection.value} surfaces={brokenSides()} />, container))
    expect(sides.length).toBeGreaterThan(0)
    for (const panel of sides) {
      await act(async () => {
        sidePanel.value = panel as typeof sidePanel.value
      })
      const side = container.querySelector(`[data-workspace-side-panel="${panel}"]`)
      expect(side?.querySelector('[data-surface-fallback="workspace-side"]'), panel).not.toBeNull()
      expect(container.querySelector('[data-canvas]')).not.toBeNull()
    }
    // Each side's fault is recorded, the repeats counted on one entry (canopi-vsey, 2.1-Q294).
    expect(ringEntries().map((entry) => [entry.source, entry.count])).toEqual([['surface.workspace-side', sides.length]])
  })

  /**
   * Every bounded surface faulted through its real host, keyed by `BoundedSurface` so a new member fails to compile
   * until its host is faulted here. `dialog` hosts show the fallback as a dialog; the workspace surfaces in place. A
   * host whose chrome renders strings outside its boundary faults through its content (`locale: false`) instead.
   */
  const hosts: Record<BoundedSurface, { readonly dialog: boolean; readonly locale?: false; open(): void; host(): preact.JSX.Element }> = {
    'workspace-primary': { dialog: false, locale: false, open: () => {}, host: () => <WorkspaceComposition panelProjection={appCommandGraphPanelProjection.value} surfaces={brokenPrimary()} /> },
    'workspace-side': {
      dialog: false,
      locale: false,
      open: () => { sidePanel.value = appCommandGraphPanelProjection.value.design[0]!.panel as typeof sidePanel.value },
      host: () => <WorkspaceComposition panelProjection={appCommandGraphPanelProjection.value} surfaces={brokenSides()} />,
    },
    'data-dialogs': { dialog: true, locale: false, open: () => openDataLibrary(), host: () => <DesktopWorkspace /> },
    'command-palette': { dialog: true, open: () => { commandPaletteOpen.value = true }, host: () => <CommandPalette /> },
    'save-problem': { dialog: true, open: () => { void requestSaveProblemDecision({ kind: 'revert' }) }, host: () => <SaveProblemDialog /> },
    about: { dialog: true, open: () => { aboutCanopiDialogOpen.value = true }, host: () => <AboutCanopiDialog /> },
    'workspace-dialog': { dialog: true, locale: false, open: () => {}, host: () => <WorkspaceDialog title="Data library" onClose={() => {}}><BrokenContent /></WorkspaceDialog> },
    'problem-report': { dialog: true, open: () => { problemReportDialogOpen.value = true }, host: () => <ProblemReportDialog /> },
    'story-presenter': { dialog: true, open: () => { story.presented.value = PRESENTED }, host: () => <StoryPresenter /> },
    'canvas-pdf': { dialog: true, open: () => pdf.show(), host: () => <CanvasPdfDialog workflow={pdf} /> },
  }
  for (const [surface, case_] of Object.entries(hosts) as [BoundedSurface, (typeof hosts)[BoundedSurface]][]) {
    it(`the ${surface} host faults in place${case_.dialog ? ', its fallback a dialog' : ''}`, async () => {
      case_.open()
      fault.on = case_.locale !== false
      await act(async () => render(case_.host(), container))
      for (let turn = 0; turn < 50 && !fallback(surface); turn += 1) {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
      }
      const shown = fallback(surface)
      expect(shown, surface).not.toBeNull()
      if (case_.dialog) expect(shown!.closest('[role="dialog"]'), surface).not.toBeNull()
      expect(ringEntries().map((entry) => entry.source), surface).toContain(`surface.${surface}`)
    })
  }

  it('a root fault is caught by the root boundary', async () => {
    const Broken = () => {
      throw new Error('root failed')
    }
    await act(async () => render(<RootBoundary source="root.web"><Broken /></RootBoundary>, container))
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(ringEntries()).toEqual([expect.objectContaining({ source: 'root.web' })])
  })
})
