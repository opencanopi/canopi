// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { render, type ComponentChildren } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('#geocoding-transport', () => ({ geocodingTransport: vi.fn(async () => []) }))

import type { CanvasInspectionHandle } from '../canvas/inspection'
import { setCurrentCanvasSession } from '../canvas/session'
import type { CanvasLayerPresentationRow } from '../app/canvas-layer-presentation/presentation'
import { ToolRail } from '../components/canvas/ToolRail'
import { workspaceCanvasCommandProjection } from '../app/workspace-commands/canvas-actions'
import { WorkspaceTitleBar } from '../components/shared/WorkspaceTitleBar'
import { PanelRail } from '../components/shared/PanelRail'
import { ZoomControls } from '../components/canvas/ZoomControls'
import { InspectionLens } from '../components/canvas/InspectionLens'
import { SpeciesFocusChip } from '../components/canvas/SpeciesFocusChip'
import { CanvasOverview, OverviewNotice } from '../components/canvas/CanvasOverview'
import { LayerPanel, type LayerPanelActions } from '../components/canvas/LayerPanel'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { hoveredTooltip } from './support/tooltip'
import {
  createTestCanvasDocumentSurface,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'

/** A button is icon-only when it shows no letters or digits (its tooltip is drawn in the window-level layer). */
function isIconOnly(button: HTMLButtonElement): boolean {
  return !/[\p{L}\p{N}]/u.test(button.textContent ?? '')
}

function expectIconButtonsFollowRules(root: ParentNode, minimum: number): void {
  // Listbox options (colour swatches) are choices, not commands; they are exempt.
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button:not([role="option"])'))
    .filter(isIconOnly)
  expect(buttons.length).toBeGreaterThanOrEqual(minimum)
  for (const button of buttons) {
    const label = button.getAttribute('aria-label')?.trim() ?? ''
    expect(label, button.outerHTML).not.toBe('')
    const tooltip = hoveredTooltip(button)
    expect(tooltip, `missing ButtonTooltip: ${label}`).not.toBeNull()
    const name = tooltip!.firstElementChild?.textContent?.trim() ?? ''
    expect(name, `empty tooltip: ${label}`).not.toBe('')
    expect(label).toContain(name)
    if (button.hasAttribute('aria-keyshortcuts')) {
      expect(tooltip!.children.length, `missing shortcut hint: ${label}`).toBeGreaterThan(1)
    }
  }
}

function row(id: string, overrides: Partial<CanvasLayerPresentationRow>): CanvasLayerPresentationRow {
  return {
    id, label: id, authority: 'scene', group: 'design', open: false, visible: true, opacity: 1, locked: false,
    canLock: true, detail: { type: 'scene' }, ...overrides,
  }
}

describe('canvas icon-only buttons', () => {
  let container: HTMLDivElement
  const mount = async (node: ComponentChildren) => {
    await act(async () => {
      render(node, container)
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const view: CanvasInspectionHandle = {
      state: signal({ point: { x: 0, y: 0 }, scale: 10, zoomPercent: 700, previewAvailable: true,
        frame: { width: 430, height: 390 }, plants: [] }),
      sourceQuad: signal(null),
      inspectAtScreenPoint: vi.fn(), inspectAtWorldPoint: vi.fn(), centerOnCanvas: vi.fn(), panByScreen: vi.fn(), zoomBy: vi.fn(),
      highlightPlant: vi.fn(), focusPlant: vi.fn(), dispose: vi.fn(),
    }
    // In overview, so the overview chip shows; its view follows this placement.
    const queries = createTestCanvasQuerySurface({ placement: { x: 200, y: 150, scale: 0.01 } })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: {
        ...queries,
        getSpeciesFocus: () => ({ canonicalName: 'Malus domestica' }),
      } as typeof queries,
      documents: createTestCanvasDocumentSurface({ attachInspectionTo: vi.fn(() => view) }),
    }))
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    setCurrentCanvasSession(null)
  })

  it('labels every icon-only tool and history button on the rail with a tooltip and shortcut hint', async () => {
    await mount(<ToolRail projection={workspaceCanvasCommandProjection.value} showNames={false} />)
    // Ten tools (Pan is off the main rail), Undo and Redo.
    expectIconButtonsFollowRules(container, 12)
  })

  it('labels the zoom buttons with tooltips and their View shortcuts', async () => {
    await mount(<ZoomControls viewActions={workspaceCanvasCommandProjection.value.viewActions} />)
    expectIconButtonsFollowRules(container, 3)
    for (const button of Array.from(container.querySelectorAll('button')).filter(isIconOnly)) {
      expect(button.getAttribute('aria-keyshortcuts'), button.getAttribute('aria-label') ?? '').toBeTruthy()
    }
  })

  it('labels the lens launcher, title-bar icons and panel rail', async () => {
    const host = { current: document.createElement('div') }
    const command = (label: string, shortcut: string) => ({ label, shortcut, ariaShortcut: shortcut, action: vi.fn() })
    await mount(<>
      <InspectionLens canvasRef={host} />
      <WorkspaceTitleBar menus={[]} help={command('Keyboard shortcuts', 'F1')} settings={command('Settings…', 'Ctrl ,')} />
      <PanelRail label="Panels" groups={[[{ panel: 'layers', label: 'Layers', shortcut: 'Ctrl 1', ariaShortcut: 'Control+1', disabled: false, action: vi.fn() }]]} />
    </>)
    expectIconButtonsFollowRules(container, 4)
  })

  it('labels every control inside the open inspection lens', async () => {
    const host = { current: document.createElement('div') }
    await mount(<InspectionLens canvasRef={host} />)
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
    // Expand, close, recentre, widen and magnify.
    expectIconButtonsFollowRules(container, 5)
  })

  it('labels layer row visibility and lock buttons', async () => {
    const actions: LayerPanelActions = {
      open: vi.fn(), visibility: vi.fn(), locked: vi.fn(), opacity: vi.fn(),
      contourInterval: vi.fn(), basemapStyle: vi.fn(), openSatelliteSettings: vi.fn(), background: vi.fn(), softenBackground: vi.fn(),
    }
    const rows = [
      row('plants', { open: true, count: 3 }),
      row('zones', { locked: true }),
      row('hillshade', { authority: 'map-layers', canLock: false, detail: { type: 'hillshade' } }),
    ]
    await mount(<LayerPanel rows={rows} actions={actions} />)
    expectIconButtonsFollowRules(container, 5)
  })

  it('keeps text canvas controls free of unlabeled icon buttons', async () => {
    await mount(<><SpeciesFocusChip /><OverviewNotice /><CanvasOverview /></>)
    expect(container.querySelectorAll('button').length).toBeGreaterThan(0)
    expectIconButtonsFollowRules(container, 0)
  })
})
