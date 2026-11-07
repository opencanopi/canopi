// @vitest-environment jsdom
// The surface and root error boundaries (APP-03, 2.1-Q291; contracts §2): a broken panel or dialog shows "This panel
// couldn't load" in place with Try again and Report a problem while the rest keeps working; every catch is one ring
// entry through the failure sink. Moved here from __tests__/error-boundary.test.tsx (design check DR17).
import { render, type ComponentChildren } from 'preact'
import { Suspense } from 'preact/compat'
import { useEffect, useRef, useState } from 'preact/hooks'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useModalInertRegion, useModalLayer } from './useModalLayer'
import { WorkspaceDialog } from './WorkspaceDialog'
import { t } from '../../i18n'
import { RootBoundary, SurfaceBoundary } from './SurfaceBoundary'
import { retryableLazy } from '../../failures/lazy'
import { resetFrontendDiagnosticsForTests, ringEntries } from '../../failures/ring'

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.innerHTML = ''
  document.body.appendChild(container)
  resetFrontendDiagnosticsForTests()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  render(null, container)
  container.remove()
  vi.restoreAllMocks()
  resetFrontendDiagnosticsForTests()
})

async function mount(tree: ComponentChildren): Promise<void> {
  await act(async () => render(tree, container))
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label)
  if (!found) throw new Error(`no button "${label}"`)
  return found
}

async function click(label: string): Promise<void> {
  await act(async () => button(label).click())
  await settle()
}

let failing = true
function Flaky({ label = 'Panel content' }: { label?: string }) {
  if (failing) throw new Error('panel render failed')
  return <p>{label}</p>
}

describe('SurfaceBoundary', () => {
  beforeEach(() => {
    failing = true
  })

  it('renders its surface when nothing throws', async () => {
    failing = false
    await mount(<SurfaceBoundary surface="workspace-side"><Flaky /></SurfaceBoundary>)
    expect(container.textContent).toBe('Panel content')
  })

  it('a surface that throws shows "This panel couldn’t load" in place, with Try again and Report a problem, while the rest keeps working', async () => {
    const report = vi.fn()
    await mount(
      <RootBoundary source="root.desktop" onReport={report}>
        <p>Canvas still here</p>
        <SurfaceBoundary surface="workspace-side"><Flaky /></SurfaceBoundary>
      </RootBoundary>,
    )
    expect(container.textContent).toContain('Canvas still here')
    expect(container.textContent).toContain(t('boundary.panelFailed'))
    expect(t('boundary.panelFailed')).toBe('This panel couldn’t load')
    await click(t('boundary.reportProblem'))
    expect(report).toHaveBeenCalledTimes(1)
    const entries = ringEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ origin: 'frontend', source: 'surface.workspace-side', surfaced: true })
    expect(entries[0]!.origin === 'frontend' && entries[0]!.text).toContain('panel render failed')
  })

  it('offers no Report a problem where the edition has no problem report', async () => {
    await mount(<SurfaceBoundary surface="workspace-side"><Flaky /></SurfaceBoundary>)
    expect(container.textContent).toContain(t('boundary.tryAgain'))
    expect(container.textContent).not.toContain(t('boundary.reportProblem'))
  })

  it('Try again renders the surface once its fault has passed', async () => {
    await mount(<SurfaceBoundary surface="workspace-side"><Flaky /></SurfaceBoundary>)
    failing = false
    await click(t('boundary.tryAgain'))
    expect(container.textContent).toBe('Panel content')
  })

  it('Retry throws again: the fallback stays and the ring holds one more entry', async () => {
    await mount(<SurfaceBoundary surface="workspace-side"><Flaky /></SurfaceBoundary>)
    expect(ringEntries()).toHaveLength(1)
    await click(t('boundary.tryAgain'))
    expect(container.textContent).toContain(t('boundary.panelFailed'))
    expect(ringEntries()).toHaveLength(2)
  })

  it('a lazy chunk that fails loads through a fresh loader on Try again', async () => {
    let calls = 0
    const loader = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new TypeError('Failed to fetch dynamically imported module')
      return { default: () => <p>Chunk loaded</p> }
    })
    const Lazy = retryableLazy(loader)
    await mount(
      <SurfaceBoundary surface="workspace-side">
        <Suspense fallback={null}><Lazy /></Suspense>
      </SurfaceBoundary>,
    )
    await settle()
    expect(container.textContent).toContain(t('boundary.panelFailed'))
    await click(t('boundary.tryAgain'))
    expect(container.textContent).toBe('Chunk loaded')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('a chunk the real module loader cannot fetch (gone after a Web deploy) offers Reload beside Try again (canopi-f47t.52.36)', async () => {
    const gone = './chunk-removed-by-a-deploy.js'
    const Lazy = retryableLazy(() => import(/* @vite-ignore */ gone))
    await mount(
      <SurfaceBoundary surface="workspace-side">
        <Suspense fallback={null}><Lazy /></Suspense>
      </SurfaceBoundary>,
    )
    for (let turn = 0; turn < 20 && !container.textContent?.includes(t('boundary.panelFailed')); turn += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    }
    expect(container.textContent).toContain(t('boundary.panelFailed'))
    expect(button(t('boundary.reload'))).toBeDefined()
    await click(t('boundary.tryAgain'))
    for (let turn = 0; turn < 20 && !container.textContent?.includes(t('boundary.panelFailed')); turn += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    }
    expect(button(t('boundary.reload'))).toBeDefined()
  })

  it('[canopi-f47t.52.36] a chunk failure\'s Reload is the edition\'s reload, which saves first (Web reopens this tab\'s own Draft), never a raw page reload', async () => {
    const reload = vi.fn()
    const gone = './chunk-removed-by-a-deploy.js'
    const Lazy = retryableLazy(() => import(/* @vite-ignore */ gone))
    await mount(
      <RootBoundary source="root.web" onReload={reload}>
        <SurfaceBoundary surface="workspace-side">
          <Suspense fallback={null}><Lazy /></Suspense>
        </SurfaceBoundary>
      </RootBoundary>,
    )
    for (let turn = 0; turn < 20 && !container.textContent?.includes(t('boundary.panelFailed')); turn += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    }
    await click(t('boundary.reload'))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a render fault that is no chunk load offers no Reload, which would lose the session for nothing', async () => {
    await mount(<SurfaceBoundary surface="workspace-side"><Flaky /></SurfaceBoundary>)
    expect(container.textContent).toContain(t('boundary.tryAgain'))
    expect(container.textContent).not.toContain(t('boundary.reload'))
  })

  it('a canvas that throws runs its cleanups once, and Try again starts one new session', async () => {
    const sessions: string[] = []
    let throwOnUpdate = false
    function Canvas({ tick }: { tick: number }) {
      useEffect(() => {
        sessions.push('start')
        return () => sessions.push('dispose')
      }, [])
      if (throwOnUpdate && tick > 0) throw new Error('renderer lost')
      return <p>Canvas</p>
    }
    let bump: () => void = () => {}
    function Host() {
      const [tick, setTick] = useState(0)
      bump = () => setTick((value) => value + 1)
      return <SurfaceBoundary surface="workspace-primary"><Canvas tick={tick} /></SurfaceBoundary>
    }
    await mount(<Host />)
    throwOnUpdate = true
    await act(async () => bump())
    await settle()
    expect(container.textContent).toContain(t('boundary.panelFailed'))
    expect(sessions).toEqual(['start', 'dispose'])
    throwOnUpdate = false
    await click(t('boundary.tryAgain'))
    expect(container.textContent).toBe('Canvas')
    expect(sessions).toEqual(['start', 'dispose', 'start'])
  })

  it('a surface unmounted in its fallback drops its state: mounted again, it renders afresh', async () => {
    let show: (value: boolean) => void = () => {}
    function Host() {
      const [shown, setShown] = useState(true)
      show = setShown
      return shown ? <SurfaceBoundary surface="workspace-side"><Flaky /></SurfaceBoundary> : null
    }
    await mount(<Host />)
    expect(container.textContent).toContain(t('boundary.panelFailed'))
    await act(async () => show(false))
    failing = false
    await act(async () => show(true))
    expect(container.textContent).toBe('Panel content')
  })

  it('a modal whose content throws keeps its dialog: the fallback is inside it, Esc closes it and no inert region stays', async () => {
    function Chrome() {
      const ref = useRef<HTMLDivElement>(null)
      useModalInertRegion(ref)
      return <div ref={ref} data-chrome>Chrome</div>
    }
    let close: () => void = () => {}
    function Host() {
      const [open, setOpen] = useState(true)
      close = () => setOpen(false)
      return (
        <>
          <Chrome />
          {open && (
            <WorkspaceDialog title="Dialog" onClose={() => close()}>
              <Flaky />
            </WorkspaceDialog>
          )}
        </>
      )
    }
    await mount(<Host />)
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain(t('boundary.panelFailed'))
    const chrome = container.querySelector<HTMLElement>('[data-chrome]')!
    expect(chrome.hasAttribute('inert')).toBe(true)
    expect(dialog.contains(document.activeElement)).toBe(true)
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(chrome.hasAttribute('inert')).toBe(false)
  })
})

describe('a dialog host whose own render throws', () => {
  function Chrome() {
    const ref = useRef<HTMLDivElement>(null)
    useModalInertRegion(ref)
    return <div ref={ref} data-chrome>Chrome</div>
  }
  function BrokenHost(): never {
    useModalLayer()
    throw new Error('dialog host failed')
  }

  it('shows the fallback as a modal dialog: focus on Try again, Esc closes it and the chrome is live again', async () => {
    const onClose = vi.fn()
    let close: () => void = () => {}
    function Host() {
      const [open, setOpen] = useState(true)
      close = () => setOpen(false)
      return (
        <>
          <Chrome />
          {open && <SurfaceBoundary surface="about" onClose={() => { onClose(); close() }}><BrokenHost /></SurfaceBoundary>}
        </>
      )
    }
    await mount(<Host />)
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain(t('boundary.panelFailed'))
    expect(document.activeElement?.textContent).toBe(t('boundary.tryAgain'))
    const chrome = container.querySelector<HTMLElement>('[data-chrome]')!
    expect(chrome.hasAttribute('inert')).toBe(true)
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(chrome.hasAttribute('inert')).toBe(false)
  })
})

describe('RootBoundary', () => {
  function Broken(): never {
    throw new Error('Test error')
  }

  it('renders the app when nothing throws', async () => {
    await mount(<RootBoundary source="root.desktop"><p>Hello</p></RootBoundary>)
    expect(container.textContent).toBe('Hello')
  })

  it('a root fault shows Reload and Report a problem, never the raw stack, and is one ring entry', async () => {
    const report = vi.fn()
    await mount(<RootBoundary source="root.desktop" onReport={report}><Broken /></RootBoundary>)
    const alert = container.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain(t('boundary.rootTitle'))
    expect(t('boundary.rootTitle')).toBe('Something went wrong')
    expect(container.querySelector('details, pre')).toBeNull()
    expect(container.textContent).not.toContain('Test error')
    await click(t('boundary.reportProblem'))
    expect(report).toHaveBeenCalledTimes(1)
    expect(button(t('boundary.reload'))).toBeDefined()
    expect(ringEntries()).toEqual([expect.objectContaining({ source: 'root.desktop', surfaced: true })])
  })

  it('[canopi-f47t.52.36] the root fallback\'s Reload is the edition\'s reload, with the dialogs it may ask through drawn in the fallback', async () => {
    const reload = vi.fn()
    await mount(
      <RootBoundary source="root.web" onReload={reload} dialogs={<p data-fallback-dialogs="">save question</p>}>
        <Broken />
      </RootBoundary>,
    )
    expect(container.querySelector('[data-fallback-dialogs]')).not.toBeNull()
    await click(t('boundary.reload'))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('the problem report’s own fallback offers no Report a problem, which could only reopen the broken dialog (canopi-f47t.52.36)', async () => {
    const report = vi.fn()
    failing = true
    await mount(
      <RootBoundary source="root.desktop" onReport={report}>
        <SurfaceBoundary surface="problem-report" onClose={() => {}}><Flaky /></SurfaceBoundary>
      </RootBoundary>,
    )
    expect(container.textContent).toContain(t('boundary.panelFailed'))
    expect(container.textContent).toContain(t('boundary.tryAgain'))
    expect(container.textContent).not.toContain(t('boundary.reportProblem'))
  })

  it('surfaces below a root offer its problem report', async () => {
    const report = vi.fn()
    failing = true
    await mount(
      <RootBoundary source="root.desktop" onReport={report}>
        <SurfaceBoundary surface="workspace-side"><Flaky /></SurfaceBoundary>
      </RootBoundary>,
    )
    await click(t('boundary.reportProblem'))
    expect(report).toHaveBeenCalledTimes(1)
  })
})
