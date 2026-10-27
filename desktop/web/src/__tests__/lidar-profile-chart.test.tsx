// @vitest-environment jsdom

// The Site data profile chart through the real profile (canopi-f47t.42, spec §1.10 "Profile"): a profile line over two
// shown elevation items and a height item, sampled through the app's one sampler over a faked lidar_sample_points,
// drawn in jsdom. Hovering sets the map's hover point, Steepest moves the cursor, Copy values writes the text inside the
// click, and × ends the profile.
import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LidarSamplePointsRequest, LidarSampleSeries } from '../generated/contracts'
import { librarySnapshot, sourceItem } from './support/library-fixtures'

const plotting = vi.hoisted(() => ({ builds: 0 }))
vi.mock('../app/lidar/profile-chart', async (importOriginal) => {
  const actual = await importOriginal<typeof ProfileChartModule>()
  return {
    ...actual,
    buildProfilePlot: (input: Parameters<typeof actual.buildProfilePlot>[0]) => {
      plotting.builds += 1
      return actual.buildProfilePlot(input)
    },
  }
})

const sampling = vi.hoisted(() => ({
  answer: null as null | ((request: LidarSamplePointsRequest) => LidarSampleSeries[]),
  requests: [] as LidarSamplePointsRequest[],
}))

vi.mock('../ipc/lidar', () => ({
  lidarDisplayDescriptor: vi.fn(() => new Promise(() => {})),
  lidarListLibrary: vi.fn(() => new Promise(() => {})),
  lidarSamplePoints: vi.fn(async (request: LidarSamplePointsRequest) => {
    sampling.requests.push(request)
    return sampling.answer!(request)
  }),
}))
vi.mock('../app/document-session/store', async () => {
  const { signal } = await import('@preact/signals')
  return {
    currentDesign: signal<unknown>(null),
    designSessionStore: { sessionIdentity: signal('design-a') },
  }
})

import { ProfileChart } from '../components/panels/lidar/ProfileChart'
import { currentDesign } from '../app/document-session/store'
import { lidarLibrary } from '../app/lidar/library-store'
import { profileCopyText, profileHover, setProfileCursor, siteProfile } from '../app/lidar/profile'
import { endSiteDataTransients, profileLine, setProfileLine } from '../app/lidar/site-transients'
import { siteSampler } from '../app/lidar/sampler'
import { activePanel, selectPanel, sidePanel } from '../app/shell/state'
import { setCurrentCanvasSession } from '../canvas/session'
import { createSessionPlane } from '../canvas/session-plane'
import type { CanvasRuntimeSurfaces } from '../canvas/runtime/runtime'
import { t } from '../i18n'
import type * as ProfileChartModule from '../app/lidar/profile-chart'

const PLANE = createSessionPlane({ lon: 2.35, lat: 48.85 })
const at = (x: number, y: number) => PLANE.toGeo({ x, y })

let container: HTMLDivElement

/** Ground rises 1 m per 10 m east with a 0.6 m step at 4 m (40 % over 2 m); the surface sits 6 m above it; the canopy is 3 m, 9 m at 5 m. */
function analyticSite(request: LidarSamplePointsRequest): LidarSampleSeries[] {
  const xs = request.points.map(([lon, lat]) => PLANE.toPlane({ lon, lat }).x)
  const ground = (x: number) => 100 + x / 10 + (x >= 4 ? 0.6 : 0)
  return request.targets.map((target) => ({
    Values: {
      values: xs.map((x) => target.entity_id === 'mnt' ? ground(x)
        : target.entity_id === 'mns' ? (x > 8 ? null : ground(x) + 6)
        : Math.abs(x - 5) < 0.01 ? 9 : 3),
    },
  }))
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((candidate) =>
    (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').includes(name))
  if (!found) throw new Error(`no button ${name}`)
  return found
}

function legendLines(): string[] {
  return Array.from(container.querySelectorAll('li')).map((line) => line.textContent ?? '')
}

beforeEach(async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  sampling.answer = analyticSite
  sampling.requests = []
  setCurrentCanvasSession({ queries: { sessionPlane: signal(PLANE), view: { mode: signal('site') } } } as unknown as CanvasRuntimeSurfaces)
  activePanel.value = 'canvas'
  selectPanel('site-data')
  lidarLibrary.value = librarySnapshot([
    sourceItem('mnt', 'MNT · IGN', { resolution_m: 0.5 }),
    sourceItem('mns', 'MNS · IGN', { resolution_m: 0.5, item_type: { kind: 'Raster', quantity: 'SurfaceElevation' } }),
    sourceItem('chm', 'MNH · IGN', { resolution_m: 0.5, item_type: { kind: 'Raster', quantity: 'AboveGroundHeight' } }),
  ])
  ;(currentDesign as unknown as { value: unknown }).value = {
    lidar: {
      visible: true,
      entries: [
        { kind: 'Source', id: 'chm', order: 0 },
        { kind: 'Source', id: 'mns', order: 1 },
        { kind: 'Source', id: 'mnt', order: 2 },
      ].map((entry) => ({ name: entry.id, visible: true, opacity: 1, ramp: null, reversed: false, range: null, ...entry })),
    },
  }
  await act(async () => {
    render(<ProfileChart />, container)
  })
})

afterEach(() => {
  render(null, container)
  container.remove()
  endSiteDataTransients()
  setCurrentCanvasSession(null)
  sidePanel.value = null
  lidarLibrary.value = null
  ;(currentDesign as unknown as { value: unknown }).value = null
  vi.restoreAllMocks()
})

async function drawLine(): Promise<void> {
  await act(async () => {
    setProfileLine([at(0, 0), at(10, 0)])
  })
  await settle()
}

describe('ProfileChart', () => {
  it('draws nothing without a profile; with one, the curves front first, their stats and the length', async () => {
    expect(container.querySelector('section')).toBeNull()

    await drawLine()

    expect(sampling.requests).toHaveLength(1)
    expect(sampling.requests[0]!.targets.map((target) => target.entity_id)).toEqual(['mnt', 'mns', 'chm'])
    expect(container.querySelector('h3')?.textContent).toBe('Profile')
    expect(container.textContent).toContain('10 m')
    expect(container.querySelectorAll('section > svg path')).toHaveLength(3)
    expect(legendLines()).toEqual([
      'MNT · IGNRise +1.6 m · Steepest 40% over 2 m',
      'MNS · IGNRise +1.4 m · Steepest 40% over 2 m',
      'MNH · IGNHighest 9.0 m',
    ])
  })

  it('samples through the app\'s one sampler, in its profile lane beside the row values\' lane', async () => {
    const request = vi.spyOn(siteSampler, 'request')

    await drawLine()

    expect(request.mock.calls.map(([lane]) => lane)).toEqual(['profile'])
    expect(legendLines()).toHaveLength(3)
  })

  it('Steepest names the run it was measured over when the samples are further apart than 2 m', async () => {
    lidarLibrary.value = librarySnapshot([
      sourceItem('mnt', 'MNT · IGN', { resolution_m: 5 }),
      sourceItem('mns', 'MNS · IGN', { resolution_m: 5, item_type: { kind: 'Raster', quantity: 'SurfaceElevation' } }),
      sourceItem('chm', 'MNH · IGN', { resolution_m: 5, item_type: { kind: 'Raster', quantity: 'AboveGroundHeight' } }),
    ])
    await act(async () => {
      setProfileLine([at(0, 0), at(30, 0)])
    })
    await settle()

    // Ground every 5 m: 100 at 0 m, 101.1 at 5 m (the 0.6 m step at 4 m), so 22 % over 5 m.
    expect(legendLines()).toEqual([
      'MNT · IGNRise +3.6 m · Steepest 22% over 5 m',
      'MNS · IGNRise +1.1 m · Steepest 22% over 5 m',
      'MNH · IGNHighest 9.0 m',
    ])
  })

  it('hovering the chart moves the cursor and the map\'s ring, says where, and gives each curve\'s value; leaving clears it', async () => {
    await drawLine()
    const svg = container.querySelector('section > svg')!
    const profile = siteProfile.value
    if (profile.status !== 'ready') throw new Error('not ready')

    // jsdom lays nothing out, so the pointer's x is in the chart's own units: 60 (start) to 402 (10 m).
    await act(async () => {
      svg.dispatchEvent(new PointerEvent('pointermove', { clientX: 60 + (342 * 9) / 10, bubbles: true }))
    })

    expect(profileHover.value).toEqual(profile.samples.points[18])
    expect(container.querySelector('[role="status"]')?.textContent).toBe('At 9 m')
    expect(legendLines()).toEqual(['MNT · IGN101.50 m', 'MNS · IGN—', 'MNH · IGN3.00 m'])
    expect(container.querySelector('li [aria-label="No data"]')?.textContent).toBe('—')

    await act(async () => {
      svg.dispatchEvent(new PointerEvent('pointerleave'))
    })
    expect(profileHover.value).toBeNull()
  })

  it('the axis labels stay inside the chart: the last distance ends at the right edge, the value labels fit their gutter', async () => {
    await drawLine()
    const labels = Array.from(container.querySelectorAll('section > svg text'))
    const viewBoxWidth = Number(container.querySelector('section > svg')!.getAttribute('viewBox')!.split(' ')[2])
    const last = labels.at(-1)!
    // 10 m: ticks 0, 5 and 10, the last on the plot's right end, so a centred "10 m" would run past the chart's edge.
    expect(last.textContent).toBe('10 m')
    expect(last.getAttribute('text-anchor')).toBe('end')
    expect(Number(last.getAttribute('x'))).toBeLessThanOrEqual(viewBoxWidth)
    // "1,234.5 m" measures 50.3 units in Source Sans 3 at --text-xs (Chromium): the value labels end at least that far in.
    const valueLabels = labels.filter((label) => label.getAttribute('text-anchor') === 'end' && label !== last)
    expect(valueLabels.length).toBeGreaterThan(0)
    for (const label of valueLabels) expect(Number(label.getAttribute('x'))).toBeGreaterThanOrEqual(52)
  })

  it('scrubbing redraws only what the cursor moves, never the curves', async () => {
    await drawLine()
    const svg = container.querySelector('section > svg')!
    const paths = Array.from(svg.querySelectorAll('path')).map((path) => path.getAttribute('d'))
    const builds = plotting.builds

    for (const step of [1, 3, 5, 7, 9]) {
      await act(async () => {
        svg.dispatchEvent(new PointerEvent('pointermove', { clientX: 60 + (342 * step) / 10, bubbles: true }))
      })
    }

    expect(plotting.builds).toBe(builds)
    expect(Array.from(svg.querySelectorAll('path')).map((path) => path.getAttribute('d'))).toEqual(paths)
    expect(container.querySelector('[role="status"]')?.textContent).toBe('At 9 m')
    expect(legendLines()[0]).toBe('MNT · IGN101.50 m')
  })

  it('Steepest moves the cursor and the ring to the steepest spot', async () => {
    await drawLine()
    await act(async () => {
      button('Steepest').click()
    })
    const profile = siteProfile.value
    if (profile.status !== 'ready') throw new Error('not ready')
    const steepest = profile.curves[0]!.stats
    if (steepest.role !== 'elevation' || !steepest.steepest) throw new Error('no steepest')

    expect(profileHover.value).toEqual(profile.samples.points[steepest.steepest.index])
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/^At \d/)
  })

  it('pressing Steepest keeps it focused and the legend at rest; leaving it clears the cursor', async () => {
    await drawLine()
    const steepest = button('Steepest')
    const atRest = legendLines()
    steepest.focus()
    await act(async () => {
      steepest.click()
    })

    // The cursor is on the steepest spot, yet only hovering the chart swaps the legend for readings.
    expect(profileHover.value).not.toBeNull()
    expect(legendLines()).toEqual(atRest)
    expect(document.activeElement).toBe(steepest)

    await act(async () => {
      steepest.blur()
    })
    expect(profileHover.value).toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toBe('')

    // Pressing the plots from Steepest blurs it after the press: the pressed spot keeps the cursor.
    steepest.focus()
    await act(async () => {
      steepest.click()
      container.querySelector('section > svg')!.dispatchEvent(new PointerEvent('pointerdown', { clientX: 60 + (342 * 9) / 10, bubbles: true }))
      steepest.blur()
    })
    expect(container.querySelector('[role="status"]')?.textContent).toBe('At 9 m')
  })

  it('Copy values writes the tab-separated text inside the click, then says Copied', async () => {
    await drawLine()
    const writes: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async (text: string) => { writes.push(text) }) },
    })

    button('Copy values').click()
    // Written in the handler, before any await: the click's activation still holds.
    const profile = siteProfile.value
    if (profile.status !== 'ready') throw new Error('not ready')
    expect(writes).toEqual([profileCopyText(profile, 'en', t)])
    expect(writes[0]!.split('\n')[0]).toBe('Distance (m)\tLongitude\tLatitude\tMNT · IGN (m)\tMNS · IGN (m)\tMNH · IGN (m)')
    await settle()
    expect(container.textContent).toContain('Copied')
  })

  it('a refused write says the values could not be copied', async () => {
    await drawLine()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error('denied') }) },
    })

    button('Copy values').click()
    await settle()

    expect(container.textContent).toContain('Couldn’t copy the values')
  })

  it('× ends the profile', async () => {
    await drawLine()
    await act(async () => {
      button('Close profile').click()
    })

    expect(profileLine.value).toBeNull()
    expect(container.querySelector('section')).toBeNull()
  })

  it('says what to show with no elevation or height layer shown, and keeps the line', async () => {
    ;(currentDesign as unknown as { value: unknown }).value = { lidar: { visible: false, entries: [] } }
    await drawLine()

    expect(container.textContent).toContain('Show an elevation or height layer to see its profile')
    expect(container.querySelector('section > svg')).toBeNull()
    expect(profileLine.value).not.toBeNull()
  })

  it('a failed read says so with Retry, never No values, and Retry draws the curves', async () => {
    sampling.answer = () => { throw new Error('sampling refused') }
    await drawLine()
    expect(container.textContent).not.toContain('No values along this line')
    expect(container.textContent).not.toContain('sampling refused')
    expect(container.textContent).toContain('Couldn’t read the values along this line')
    expect(container.querySelector('section > svg path')).toBeNull()
    sampling.answer = analyticSite
    await act(async () => { button('Retry').click() })
    await settle()
    expect(container.querySelectorAll('section > svg path')).toHaveLength(3)
  })

  it('a curve whose data could not be read says so in its legend line with one Retry under the legend, which draws it', async () => {
    sampling.answer = (request) => analyticSite(request).map((series, index) =>
      request.targets[index]!.entity_id === 'mns' ? { Unavailable: { reason: 'ReadFailed' } } : series)
    await drawLine()
    expect(container.textContent).not.toContain('No values along this line')
    const lines = legendLines()
    expect(lines.filter((line) => line.includes('Couldn’t read the values along this line'))).toEqual([
      expect.stringContaining('MNS · IGN'),
    ])
    expect(lines.find((line) => line.includes('MNT · IGN'))).toContain('Rise')
    const retries = Array.from(container.querySelectorAll('button')).filter((candidate) => candidate.textContent === 'Retry')
    expect(retries).toHaveLength(1)
    expect(retries[0]!.closest('li')).toBeNull()
    expect(container.querySelector('ul')!.nextElementSibling).toBe(retries[0]!.parentElement)

    sampling.answer = analyticSite
    const asked = sampling.requests.length
    const section = container.querySelector('section')!
    retries[0]!.focus()
    await act(async () => { button('Retry').click() })
    expect(document.activeElement).toBe(section)
    await settle()
    expect(sampling.requests).toHaveLength(asked + 1)
    expect(sampling.requests[asked]).toEqual(sampling.requests[asked - 1])
    expect(container.querySelectorAll('section > svg path')).toHaveLength(3)
    expect(container.textContent).not.toContain('Couldn’t read the values along this line')
    expect(Array.from(container.querySelectorAll('button')).some((candidate) => candidate.textContent === 'Retry')).toBe(false)
  })

  it('a partly failed read that fails again puts focus back on Retry under the legend', async () => {
    sampling.answer = (request) => analyticSite(request).map((series, index) =>
      request.targets[index]!.entity_id === 'mns' ? { Unavailable: { reason: 'ReadFailed' } } : series)
    await drawLine()
    button('Retry').focus()
    await act(async () => { button('Retry').click() })
    await settle()
    expect(document.activeElement).toBe(button('Retry'))
    // A read that works ends the run of failures, which the app's one profile keeps across tests.
    sampling.answer = analyticSite
    await act(async () => { button('Retry').click() })
    await settle()
  })

  it('every curve failing to read is the whole chart\'s read-failed state, never No values', async () => {
    sampling.answer = (request) => request.targets.map(() => ({ Unavailable: { reason: 'ReadFailed' } }))
    await drawLine()
    expect(container.textContent).not.toContain('No values along this line')
    expect(container.textContent).toContain('Couldn’t read the values along this line')
    expect(container.querySelector('section > svg')).toBeNull()
    expect(button('Retry')).toBeTruthy()
    // A read that works ends the run of failures, which the app's one profile keeps across tests.
    sampling.answer = analyticSite
    await act(async () => { button('Retry').click() })
    await settle()
  })

  // The chart reads only its own copy; the reason goes to diagnostics, once per run of failures, so Retry or a
  // redrawn line on a failing library never fills the problem report's ring.
  it('a failed read records its reason in diagnostics once, however often it is retried or redrawn', async () => {
    const { recentFrontendDiagnostics, resetFrontendDiagnosticsForTests } = await import('../app/problem-report/diagnostics')
    resetFrontendDiagnosticsForTests()
    sampling.answer = () => { throw new Error('sampling refused') }
    await drawLine()
    await act(async () => { button('Retry').click() })
    await settle()
    await act(async () => { setProfileLine([at(0, 0), at(12, 0)]) })
    await settle()
    expect(container.textContent).toContain('Couldn’t read the values along this line')
    expect(recentFrontendDiagnostics()).toEqual([
      expect.objectContaining({ source: 'lidar-library', message: 'sampling refused' }),
    ])
    // A read that works ends the run: the next failure is news again.
    sampling.answer = analyticSite
    await act(async () => { button('Retry').click() })
    await settle()
    sampling.answer = () => { throw new Error('sampling refused again') }
    await act(async () => { setProfileLine([at(0, 0), at(14, 0)]) })
    await settle()
    expect(recentFrontendDiagnostics().map((entry) => entry.message)).toEqual(['sampling refused', 'sampling refused again'])
  })

  it('Retry keeps keyboard focus in the profile: on the chart while it reads, on Retry again if the read fails again', async () => {
    sampling.answer = () => { throw new Error('sampling refused') }
    await drawLine()
    const section = container.querySelector('section')!
    button('Retry').focus()
    await act(async () => { button('Retry').click() })
    expect(document.activeElement).toBe(section)
    await settle()
    expect(document.activeElement).toBe(button('Retry'))

    sampling.answer = analyticSite
    await act(async () => { button('Retry').click() })
    await settle()
    expect(container.querySelectorAll('section > svg path')).toHaveLength(3)
    expect(document.activeElement).toBe(section)
  })

  it('Copy values shows the board\'s copy icon and keeps its name', async () => {
    await drawLine()
    const copy = button('Copy values')
    expect(copy.querySelector('svg')).not.toBeNull()
    expect(copy.querySelector('svg')!.getAttribute('width')).toBe('16')
    expect(copy.getAttribute('aria-label') ?? copy.textContent?.trim()).toBe('Copy values')
  })

  it('says so when the line has no values', async () => {
    sampling.answer = (request) => request.targets.map(() => ({ Values: { values: request.points.map(() => null) } }))
    await drawLine()
    expect(container.textContent).toContain('No values along this line')
    setProfileCursor(3)
    expect(profileHover.value).toBeNull()
  })
})
