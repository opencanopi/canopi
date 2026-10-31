// The perf lane (ADR 0029 Performance budgets, 2.1-M240, .github/workflows/performance.yml). Its large fixture is
// generated at run time by scripts/generate-large-fixture.mjs and never committed, so this test is where a .canopi
// format change fails it; its Playwright project runs only when named, never in the full browser suite.
import { describe, expect, it } from 'vitest'
import { projectsFor } from '../../playwright.config'
import { decodeCanopiDesign } from '../app/contracts/design-ingestion'
import { createSessionPlane } from '../canvas/session-plane'

interface LargeFixtureGenerator {
  readonly LARGE_FIXTURE_SITE: { readonly lon: number, readonly lat: number }
  readonly LARGE_FIXTURE_SIDE_METRES: number
  largeFixture(options: {
    readonly seed: number
    readonly toGeo: (point: { readonly x: number, readonly y: number }) => { readonly lon: number, readonly lat: number }
  }): Record<string, unknown>
}

const generator = (await import(new URL('../../scripts/generate-large-fixture.mjs', import.meta.url).href)) as LargeFixtureGenerator
const plane = createSessionPlane(generator.LARGE_FIXTURE_SITE)
const fixture = (seed: number) => generator.largeFixture({ seed, toGeo: (point) => plane.toGeo(point) })

describe('large fixture generator', () => {
  it('writes a Design the real decoder admits in the current format, with every object on the site', () => {
    const design = decodeCanopiDesign(JSON.parse(JSON.stringify(fixture(1))))

    expect(design.plants.length).toBeGreaterThanOrEqual(2000)
    expect(design.zones.length).toBeGreaterThan(0)
    expect(design.annotations.length).toBeGreaterThan(0)
    const half = generator.LARGE_FIXTURE_SIDE_METRES / 2
    const points = [
      ...design.plants.map((plant) => plant.position),
      ...design.zones.flatMap((zone) => zone.points),
      ...design.annotations.map((annotation) => annotation.position),
    ]
    for (const point of points) {
      const { x, y } = plane.toPlane(point)
      expect(Math.abs(x)).toBeLessThanOrEqual(half)
      expect(Math.abs(y)).toBeLessThanOrEqual(half)
    }
  })

  it('is the same Design for the same seed and a different one for another seed', () => {
    expect(JSON.stringify(fixture(7))).toBe(JSON.stringify(fixture(7)))
    expect(JSON.stringify(fixture(8))).not.toBe(JSON.stringify(fixture(7)))
  })
})

describe('perf Playwright project', () => {
  const names = (argv: string[]) => projectsFor(argv).map((project) => project.name)

  it('runs only when named, in Chromium alone, and no other project runs its specs', () => {
    expect(names(['node', 'playwright', 'test'])).not.toContain('perf')
    expect(names(['node', 'playwright', 'test', '--project=chromium', '--project=webkit'])).not.toContain('perf')
    expect(names(['node', 'playwright', 'test', 'e2e/perf', '--project', 'perf'])).toContain('perf')
    // A worker loads the config with its own argv; the runner's flag still names the project.
    expect(projectsFor(['node', 'worker'], { CANOPI_PERF_PROJECT: '1' }).map((project) => project.name)).toContain('perf')

    const projects = projectsFor(['node', 'playwright', 'test', '--project=perf'])
    const perf = projects.find((project) => project.name === 'perf')
    expect(perf?.use?.browserName).toBe('chromium')
    for (const project of projects.filter((p) => p.name !== 'perf')) {
      const ignored = [project.testIgnore ?? []].flat().map(String)
      const matched = [project.testMatch ?? []].flat().map(String)
      expect(ignored.includes('perf/**') || (matched.length > 0 && matched.every((glob) => !glob.startsWith('perf/'))),
        `${project.name} skips e2e/perf`).toBe(true)
    }
  })
})
