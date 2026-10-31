// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../components/shared/TitleBar', () => ({ TitleBar: () => <div data-testid="title-bar" /> }))
vi.mock('../components/shared/DegradedBanner', () => ({ DegradedBanner: () => null }))
vi.mock('../components/shared/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('../components/shared/ProblemReportDialog', () => ({ ProblemReportDialog: () => null }))
vi.mock('../components/panels/CanvasPanel', () => ({ CanvasPanel: () => <div data-testid="canvas-panel" /> }))
vi.mock('../components/panels/DesktopPanelRail', () => ({ DesktopPanelRail: () => <div data-testid="panel-rail" /> }))
vi.mock('../components/panels/PlantDbPanel', () => ({ PlantDbPanel: () => <div data-testid="plant-db-panel" /> }))
vi.mock('../components/panels/DesignNotebookPanel', () => ({ DesignNotebookPanel: () => <div data-testid="design-notebook-panel" /> }))
vi.mock('../app/shell/controller', () => ({ commitSidePanelWidth: vi.fn() }))

import { App, type DesktopUpdatePorts } from '../app'
import { commitSidePanelWidth } from '../app/shell/controller'
import { activePanel, sidePanel, sidePanelWidth } from '../app/shell/state'
import { locale } from '../app/settings/state'

/** A host with no update to offer and the launch check off. */
const NO_UPDATES: DesktopUpdatePorts = {
  updater: {
    checkForUpdate: () => Promise.resolve(null),
    downloadUpdate: () => new Promise(() => {}),
    installUpdate: () => Promise.resolve(),
    cancelUpdate: () => Promise.resolve(),
    restartAfterUpdate: () => Promise.resolve(),
    getLaunchCheck: () => Promise.resolve(false),
  },
  setLaunchCheck: () => Promise.resolve(),
  takeLaunchNotice: () => Promise.resolve(false),
  mintOperationId: () => 'op',
}

function resizeHandle(container: HTMLDivElement): HTMLDivElement {
  const handle = container.querySelector('[role="separator"][aria-orientation="vertical"]')
  expect(handle).toBeInstanceOf(HTMLDivElement)
  return handle as HTMLDivElement
}

function preparePointerCapture(handle: HTMLElement): {
  setPointerCapture: ReturnType<typeof vi.fn>
  releasePointerCapture: ReturnType<typeof vi.fn>
} {
  const setPointerCapture = vi.fn()
  const releasePointerCapture = vi.fn()
  Object.assign(handle, { setPointerCapture, releasePointerCapture })
  return { setPointerCapture, releasePointerCapture }
}

function sidePanelElement(container: HTMLDivElement): HTMLDivElement {
  const panel = container.querySelector('[style*="--side-panel-width"]')
  expect(panel).toBeInstanceOf(HTMLDivElement)
  return panel as HTMLDivElement
}

describe('App sidebar width', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    activePanel.value = 'canvas'
    sidePanel.value = 'plant-db'
    sidePanelWidth.value = null
    vi.mocked(commitSidePanelWidth).mockClear()
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  })

  it('opens the dock at 380 px, or 440 px for Budget and Consortium, until a width is saved', async () => {
    await act(async () => {
      render(<App updates={NO_UPDATES} />, container)
    })

    expect(sidePanelElement(container).getAttribute('style')).toContain('--side-panel-width: 380px')
    expect(sidePanelElement(container).dataset.dockWidth).toBe('default')

    await act(async () => { sidePanel.value = 'budget' })
    expect(sidePanelElement(container).getAttribute('style')).toContain('--side-panel-width: 440px')
    expect(sidePanelElement(container).dataset.dockWidth).toBe('wide')
  })

  it('mounts the Design Notebook as a right-side panel', async () => {
    sidePanel.value = 'design-notebook'

    await act(async () => {
      render(<App updates={NO_UPDATES} />, container)
    })

    // The notebook panel mounts after its lazy workbench resolves.
    await vi.waitFor(() => expect(container.querySelector('[data-testid="design-notebook-panel"]')).not.toBeNull())
    expect(container.querySelector('[data-testid="canvas-panel"]')).not.toBeNull()
  })

  it('renders a saved width and commits resize drags through the settings controller', async () => {
    sidePanelWidth.value = 480

    await act(async () => {
      render(<App updates={NO_UPDATES} />, container)
    })

    const panel = sidePanelElement(container)
    panel.getBoundingClientRect = () => ({
      width: 480,
      height: 800,
      top: 0,
      right: 480,
      bottom: 800,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    await act(async () => {
      const handle = resizeHandle(container)
      preparePointerCapture(handle)
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientX: 700,
      }))
      document.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 1,
        clientX: 640,
      }))
      document.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 1,
        clientX: 640,
      }))
    })

    expect(commitSidePanelWidth).toHaveBeenCalledWith(540)
    // The preview's inline width goes once the setting holds the width, so
    // later keyboard steps and Calendar's Expand still resize the dock.
    expect(panel.style.width).toBe('')
    await act(async () => { sidePanelWidth.value = 540 })
    expect(panel.getAttribute('style')).toContain('--side-panel-width: 540px')
  })

  it('resizes the shared dock from its focused keyboard separator', async () => {
    sidePanelWidth.value = 480

    await act(async () => {
      render(<App updates={NO_UPDATES} />, container)
    })

    const handle = resizeHandle(container)
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowLeft',
    })
    await act(async () => {
      handle.focus()
      handle.dispatchEvent(event)
    })

    expect(document.activeElement).toBe(handle)
    expect(event.defaultPrevented).toBe(true)
    expect(commitSidePanelWidth).toHaveBeenCalledWith(500)
  })

  it('does not persist the responsive default from a resize-handle click without movement', async () => {
    await act(async () => {
      render(<App updates={NO_UPDATES} />, container)
    })

    await act(async () => {
      const handle = resizeHandle(container)
      preparePointerCapture(handle)
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 2,
        clientX: 700,
      }))
      document.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 2,
        clientX: 700,
      }))
    })

    expect(commitSidePanelWidth).not.toHaveBeenCalled()
  })

  it('does not persist or fix the responsive default when pointer movement stays clamped', async () => {
    await act(async () => {
      render(<App updates={NO_UPDATES} />, container)
    })

    const panel = sidePanelElement(container)
    panel.getBoundingClientRect = () => ({
      width: 320,
      height: 800,
      top: 0,
      right: 320,
      bottom: 800,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    await act(async () => {
      const handle = resizeHandle(container)
      preparePointerCapture(handle)
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 5,
        clientX: 700,
      }))
      document.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 5,
        clientX: 760,
      }))
      document.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 5,
        clientX: 760,
      }))
    })

    expect(panel.style.width).toBe('')
    expect(commitSidePanelWidth).not.toHaveBeenCalled()
  })

  it('releases an active resize and restores body styles when App unmounts', async () => {
    await act(async () => {
      render(<App updates={NO_UPDATES} />, container)
    })

    document.body.style.cursor = 'wait'
    document.body.style.userSelect = 'text'
    const handle = resizeHandle(container)
    const { releasePointerCapture } = preparePointerCapture(handle)

    await act(async () => {
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 3,
        clientX: 700,
      }))
      document.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 3,
        clientX: 650,
      }))
      render(null, container)
    })

    expect(commitSidePanelWidth).not.toHaveBeenCalled()
    expect(releasePointerCapture).toHaveBeenCalledWith(3)
    expect(document.body.style.cursor).toBe('wait')
    expect(document.body.style.userSelect).toBe('text')
  })

  it('releases an active resize when the conditional Sidebar surface unmounts', async () => {
    await act(async () => {
      render(<App updates={NO_UPDATES} />, container)
    })

    document.body.style.cursor = 'help'
    document.body.style.userSelect = 'auto'
    const handle = resizeHandle(container)
    const { releasePointerCapture } = preparePointerCapture(handle)

    await act(async () => {
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 4,
        clientX: 700,
      }))
      document.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 4,
        clientX: 650,
      }))
      sidePanel.value = null
    })

    expect(container.querySelector('[role="separator"][aria-orientation="vertical"]')).toBeNull()
    expect(commitSidePanelWidth).not.toHaveBeenCalled()
    expect(releasePointerCapture).toHaveBeenCalledWith(4)
    expect(document.body.style.cursor).toBe('help')
    expect(document.body.style.userSelect).toBe('auto')
  })
})
