// @vitest-environment jsdom
//
// 2.1-Q344: Desktop chooses its layout with Web's classifier. A Desktop window under 640 px wide, or short and wide,
// uses the phone layout (640 to 759 px wide keeps the desktop layout), renders the phone sheet with its tabs instead
// of the desktop panel rail, and keeps Desktop's window controls and drag region in the phone top bar.
// It renders the whole Desktop App root (shell, title bar, workspace, classifier), so it sits with the cross-module suites.

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const windowMocks = vi.hoisted(() => ({
  startDragging: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
  minimize: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => windowMocks }))

// The map needs WebGL, which jsdom lacks; the layout classifier does not look at it.
vi.mock('../components/panels/CanvasPanel', () => ({ CanvasPanel: () => null }))

import { App, type DesktopUpdatePorts } from '../app'
import { phoneLayout } from '../app/shell/phone-layout'
import { t } from '../i18n'

/** A host with no update to offer and the launch check off: every port answers at once with nothing. */
const nothing = () => Promise.resolve()
const NO_UPDATES: DesktopUpdatePorts = {
  updater: {
    checkForUpdate: () => Promise.resolve(null), downloadUpdate: () => new Promise(() => {}), installUpdate: nothing,
    cancelUpdate: nothing, restartAfterUpdate: nothing, getLaunchCheck: () => Promise.resolve(false),
  },
  setLaunchCheck: nothing, takeLaunchNotice: () => Promise.resolve(false), mintOperationId: () => 'op',
}

const container = document.createElement('div')

function resizeWindow(width: number, height: number): void {
  Object.assign(window, { innerWidth: width, innerHeight: height })
  window.dispatchEvent(new Event('resize'))
}

async function renderDesktopApp(width: number, height: number): Promise<void> {
  resizeWindow(width, height)
  document.body.appendChild(container)
  await act(async () => {
    render(<App updates={NO_UPDATES} dismissStoreNoticeOnHost={async () => {}} />, container)
  })
}

afterEach(() => {
  render(null, container)
  container.remove()
  phoneLayout.value = null
  resizeWindow(1024, 768)
  windowMocks.startDragging.mockClear()
})

describe('2.1-Q344 the Desktop layout classifier', () => {
  it('Q344 (2a-3): a Desktop window under 640 px wide uses the phone layout, a short wide one the landscape phone layout, 640 px and wider none', async () => {
    await renderDesktopApp(600, 800)
    expect(phoneLayout.value).toBe('portrait')
    expect(container.querySelector('[data-layout="portrait"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-sheet-tab]').length).toBeGreaterThan(0)
    expect(container.querySelector(`nav[aria-label="${t('panelRail.label')}"]`)).toBeNull()

    const sizes: readonly [number, number, 'portrait' | 'landscape' | null][] = [
      [639, 800, 'portrait'],
      [640, 800, null],
      [700, 800, null], // the uncorrected 760 px test would call this a phone
      [759, 800, null],
      [900, 420, 'landscape'],
      [960, 420, null],
      [1200, 800, null],
    ]
    for (const [width, height, layout] of sizes) {
      await act(async () => { resizeWindow(width, height) })
      expect(phoneLayout.value, `${width} x ${height}`).toBe(layout)
      const root = container.firstElementChild
      if (layout) {
        expect(root?.getAttribute('data-layout'), `${width} x ${height} data-layout`).toBe(layout)
        expect(container.querySelectorAll('[data-sheet-tab]').length, `${width} x ${height} phone sheet tabs`).toBeGreaterThan(0)
        expect(container.querySelector(`nav[aria-label="${t('panelRail.label')}"]`), `${width} x ${height} rail absent`).toBeNull()
      } else {
        expect(root?.getAttribute('data-layout'), `${width} x ${height} data-layout`).toBeNull()
        expect(container.querySelectorAll('[data-sheet-tab]').length, `${width} x ${height} phone sheet absent`).toBe(0)
        expect(container.querySelector(`nav[aria-label="${t('panelRail.label')}"]`), `${width} x ${height} rail present`).not.toBeNull()
      }
    }
  })

  it('Q344 (2a-3): the phone top bar keeps the window controls and drags the window', async () => {
    await renderDesktopApp(600, 800)
    expect(phoneLayout.value).toBe('portrait')

    for (const control of ['window.minimize', 'window.maximize', 'window.close'] as const) {
      expect(container.querySelector(`button[aria-label="${t(control)}"]`), control).not.toBeNull()
    }
    const topBar = container.querySelector<HTMLElement>('[data-workspace-title-bar]')
    expect(topBar, 'the phone top bar').not.toBeNull()
    topBar!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1, detail: 1 }))
    expect(windowMocks.startDragging, 'a press on the top bar drags the window').toHaveBeenCalledOnce()
  })
})
