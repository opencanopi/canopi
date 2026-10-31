// The perf lane's timings (ADR 0029 Performance budgets; 2.1-Q203, 2.1-M240): cold start to an interactive start
// screen, opening the large fixture Design, and a fixed scripted pan and zoom of it, in Chromium, five runs each.
// Each run is its own test, so each gets a fresh browser context (an empty HTTP cache) under the offline network
// rule; the project runs them in order on one worker (playwright.config.ts `perf`). A run records long tasks
// (over 50 ms by definition) and frames over 50 ms inside its timed window; raw frame times and the WebGL renderer
// (hardware or software) are information only. The last test turns the runs into medians and spreads in
// <outputDir>/timings/ (timings.json, summary.md) for the workflow's step summary and artifact; a scenario with fewer
// than five runs, or a run with no frame sample, fails. Nothing here is a budget yet: the timings block only once the
// 5-run CI spread fits its tolerance (2.1-Q203).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { createSessionPlane } from '../../src/canvas/session-plane'
import { designMap, expectCanvasDrawn } from '../support/canvas'
import { expect, test } from '../support/offline'

interface LargeFixtureGenerator {
  readonly LARGE_FIXTURE_SITE: { readonly lon: number, readonly lat: number }
  readonly LARGE_FIXTURE_DEFAULT_SEED: number
  writeLargeFixture(path: string, options: {
    readonly seed: number
    readonly toGeo: (point: { readonly x: number, readonly y: number }) => { readonly lon: number, readonly lat: number }
  }): void
}

const RUNS = 5
const SLOW_FRAME_MS = 50
const SCENARIOS = ['cold-start', 'open-large-fixture', 'pan-and-zoom'] as const
type Scenario = typeof SCENARIOS[number]

/** One run's measures inside its timed window, page clock (ms). */
interface Sample {
  readonly durationMs: number
  readonly longTasks: number
  readonly longTaskMs: number
  readonly slowFrames: number
  /** Raw frame times: the intervals between animation frames, information only. */
  readonly frameTimesMs: readonly number[]
  readonly renderer: string
}

const MEASURES = ['durationMs', 'longTasks', 'longTaskMs', 'slowFrames'] as const

const timingsDir = (info: TestInfo) => join(info.project.outputDir, 'timings')
const fixturePath = (info: TestInfo) => join(info.project.outputDir, 'large-fixture.canopi')

/** Installed before any page script: a long-task observer and an animation-frame clock. */
function installProbe(): void {
  const probe = {
    supported: PerformanceObserver.supportedEntryTypes.includes('longtask'),
    longTasks: [] as Array<{ start: number, duration: number }>,
    frames: [] as number[],
  }
  ;(window as unknown as { __canopiPerf: typeof probe }).__canopiPerf = probe
  if (probe.supported) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push({ start: entry.startTime, duration: entry.duration })
    }).observe({ type: 'longtask', buffered: true })
  }
  const tick = (time: number) => {
    probe.frames.push(time)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

const now = (page: Page) => page.evaluate(() => performance.now())

/** The measures between `start` and `end` (page clock). */
async function sampleOf(page: Page, start: number, end: number): Promise<Sample> {
  return page.evaluate(({ start, end, slow }) => {
    const probe = (window as unknown as {
      __canopiPerf: { supported: boolean, longTasks: Array<{ start: number, duration: number }>, frames: number[] }
    }).__canopiPerf
    if (!probe.supported) throw new Error('this browser reports no long tasks')
    const tasks = probe.longTasks.filter((task) => task.start < end && task.start + task.duration > start)
    const frames = probe.frames.filter((time) => time >= start && time <= end)
    const frameTimesMs = frames.slice(1).map((time, index) => time - frames[index]!)
    const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    const renderer = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : gl ? String(gl.getParameter(gl.RENDERER)) : 'no WebGL'
    return {
      durationMs: end - start,
      longTasks: tasks.length,
      longTaskMs: tasks.reduce((sum, task) => sum + task.duration, 0),
      slowFrames: frameTimesMs.filter((time) => time > slow).length,
      frameTimesMs,
      renderer,
    }
  }, { start, end, slow: SLOW_FRAME_MS })
}

async function startScreen(page: Page): Promise<void> {
  await page.goto('')
  await expect(page.getByRole('button', { name: /Open a \.canopi file…/ }).first()).toBeEnabled()
}

async function openFixture(page: Page, path: string): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /Open a \.canopi file…/ }).first().click(),
  ])
  await chooser.setFiles(path)
  await expect(designMap(page)).toBeVisible()
  await expectCanvasDrawn(page)
}

/** The fixed script: four middle-button drags round a square, then three wheel steps in and three out. */
async function panAndZoom(page: Page): Promise<void> {
  const box = await designMap(page).boundingBox()
  if (!box) throw new Error('the Design map has no box')
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  for (const [dx, dy] of [[200, 0], [0, 150], [-200, 0], [0, -150]] as const) {
    await page.mouse.move(centre.x, centre.y)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(centre.x + dx, centre.y + dy, { steps: 20 })
    await page.mouse.up({ button: 'middle' })
  }
  for (const delta of [-300, -300, -300, 300, 300, 300]) {
    await page.mouse.wheel(0, delta)
    await expectCanvasDrawn(page)
  }
}

async function run(page: Page, info: TestInfo, scenario: Scenario): Promise<Sample> {
  await page.addInitScript(installProbe)
  await startScreen(page)
  if (scenario === 'cold-start') return sampleOf(page, 0, await now(page)) // from the navigation's start
  if (scenario === 'pan-and-zoom') await openFixture(page, fixturePath(info))
  const start = await now(page)
  await (scenario === 'open-large-fixture' ? openFixture(page, fixturePath(info)) : panAndZoom(page))
  return sampleOf(page, start, await now(page))
}

test.beforeAll(async ({}, info) => {
  // Generated, never committed (2.1-M240); src/__tests__/perf-lane.test.ts admits the same output through the decoder.
  const generator = (await import(new URL('../../scripts/generate-large-fixture.mjs', import.meta.url).href)) as LargeFixtureGenerator
  const plane = createSessionPlane(generator.LARGE_FIXTURE_SITE)
  mkdirSync(info.project.outputDir, { recursive: true })
  generator.writeLargeFixture(fixturePath(info), { seed: generator.LARGE_FIXTURE_DEFAULT_SEED, toGeo: (point) => plane.toGeo(point) })
})

for (const scenario of SCENARIOS) {
  for (let index = 1; index <= RUNS; index += 1) {
    test(`${scenario} run ${index}`, async ({ page }, info) => {
      const sample = await run(page, info, scenario)
      expect(sample.frameTimesMs.length, 'the run sampled animation frames').toBeGreaterThan(0)
      mkdirSync(join(timingsDir(info), 'runs'), { recursive: true })
      writeFileSync(join(timingsDir(info), 'runs', `${scenario}-${index}.json`), `${JSON.stringify(sample)}\n`)
    })
  }
}

interface Summary {
  readonly median: number
  /** (max - min) / median; 0 when every run measured 0, null when the median alone is 0. */
  readonly spread: number | null
  readonly runs: readonly number[]
}

function summarise(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  const range = sorted[sorted.length - 1]! - sorted[0]!
  return { median, spread: range === 0 ? 0 : median === 0 ? null : range / median, runs: values }
}

test('medians and spreads of five runs per scenario', async ({}, info) => {
  const dir = join(timingsDir(info), 'runs')
  const files = (() => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  })()
  const timings: Record<string, Record<string, Summary>> = {}
  const renderers = new Set<string>()
  for (const scenario of SCENARIOS) {
    const samples = files
      .filter((file) => file.startsWith(`${scenario}-`))
      .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as Sample)
    expect(samples.length, `${scenario}: every run left a sample`).toBe(RUNS)
    for (const sample of samples) renderers.add(sample.renderer)
    timings[scenario] = Object.fromEntries(MEASURES.map((measure) => [measure, summarise(samples.map((s) => s[measure]))]))
  }
  const renderer = [...renderers].join('; ')
  const software = /swiftshader|llvmpipe|softpipe|software/i.test(renderer)
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
  const rows = SCENARIOS.flatMap((scenario) => MEASURES.map((measure) => {
    const { median, spread, runs } = timings[scenario]![measure]!
    return `| ${scenario} | ${measure} | ${fmt(median)} | ${spread === null ? 'n/a' : spread.toFixed(2)} | ${runs.map(fmt).join(', ')} |`
  }))
  const summary = [
    '## Perf lane (information, not gated)',
    '',
    `WebGL renderer: ${renderer} (${software ? 'software' : 'hardware'})`,
    '',
    '| Scenario | Measure | Median | Spread | Runs |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
  writeFileSync(join(timingsDir(info), 'timings.json'), `${JSON.stringify({ renderer, software, timings }, null, 1)}\n`)
  writeFileSync(join(timingsDir(info), 'summary.md'), summary)
})
