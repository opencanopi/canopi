// The map container after a real map is destroyed (canvas v2 2.0 cleanup, A15). MapLibre adds its canvas
// and control containers to the Design map element, and the map host removes what a creation added
// when the map goes (maplibre/surface.ts); a leftover would stack a second map under the new one. The
// jsdom tests cover a failed constructor only; these run the real MapLibre teardown in the browser:
// a Design switch, and a lost WebGL context followed by the user's Retry.
// The last scenario checks the container's bottom band in real layout (canopi-23p2): the map notice is bottom chrome
// on the visible-map-area seam, so the map credits fold into MapLibre's (i) button rather than sit under it.
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { designMap, expectCanvasDrawn } from '../support/canvas'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
/** Marks the map canvas of the map about to be destroyed, so a check can see it is gone. */
const OLD_MAP = 'data-e2e-old-map'

async function openFixture(page: Page, open: () => Promise<void>): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open()])
  await chooser.setFiles(FIXTURE)
  await expect(designMap(page)).toBeVisible()
  // The opening camera frames the Design.
  await expect(page.getByRole('group', { name: 'Zoom' }).getByRole('button', { name: /^Map scale/ })).toHaveText('1:240')
  await expectCanvasDrawn(page)
}

async function openBaseFixture(page: Page): Promise<void> {
  await page.goto('')
  await openFixture(page, () => page.getByRole('button', { name: /Open a \.canopi file…/ }).first().click())
}

/**
 * The Design map's children, as sorted tag and class names, and the MapLibre parts in the whole page.
 * Read in one pass in the page.
 */
async function readMapContainer(page: Page) {
  return designMap(page).evaluate((container) => ({
    children: Array.from(container.children, (child) => `${child.tagName}.${child.className}`).sort(),
    maps: document.querySelectorAll('.maplibregl-map').length,
    canvasContainers: document.querySelectorAll('.maplibregl-canvas-container').length,
    controlContainers: document.querySelectorAll('.maplibregl-control-container').length,
    canvases: document.querySelectorAll('canvas.maplibregl-canvas').length,
  }))
}

async function markCurrentMap(page: Page): Promise<void> {
  await page.locator('canvas.maplibregl-canvas').evaluate((canvas, name) => canvas.setAttribute(name, ''), OLD_MAP)
}

async function expectOneMapAsOpened(page: Page, opened: Awaited<ReturnType<typeof readMapContainer>>): Promise<void> {
  await expect(page.locator(`[${OLD_MAP}]`), 'the old map was destroyed, not kept').toHaveCount(0)
  await expect(designMap(page)).toBeVisible()
  await expect(page.locator('canvas.maplibregl-canvas'), 'the new map is built').toHaveCount(1)
  await expectCanvasDrawn(page)
  const container = await readMapContainer(page)
  expect(container, 'exactly one map canvas container, and no children left from the old map').toEqual({
    ...opened,
    maps: 1,
    canvasContainers: 1,
    controlContainers: 1,
    canvases: 1,
  })
}

test('a Design switch leaves exactly one map in the map container', async ({ page }) => {
  await openBaseFixture(page)
  const opened = await readMapContainer(page)
  expect(opened.canvasContainers, 'the opened Design has one map').toBe(1)

  await markCurrentMap(page)
  await page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'File' }).click()
  await openFixture(page, () => page.getByRole('menuitem', { name: /^Open a \.canopi file…/ }).click())
  await expectOneMapAsOpened(page, opened)
})

/** Offline the Basemap style never installs; a spec that answers it in the page gives it these inline credits. */
const BASEMAP_CREDITS = '<a href="https://openfreemap.org">OpenFreeMap</a> <a href="https://www.openmaptiles.org/">© OpenMapTiles</a>'
  + ' Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'

test.describe('a map that stops drawing', () => {
  // upstream: W19
  // Playwright's Firefox logs the Error argument by its name alone, without the message, so there the whole line is
  // expected rather than a prefix that would let any map failure through.
  test.use({
    expectedConsoleErrors: async ({ browserName }, use) => use(browserName === 'firefox' ? [] : ['Shared workspace map failed: Error: MapLibre WebGL context was lost']),
    expectedConsoleLines: async ({ browserName }, use) => use(browserName === 'firefox' ? ['Shared workspace map failed: Error'] : []),
  })

  test('Retry rebuilds exactly one map in the map container', async ({ page }) => {
    await openBaseFixture(page)
    const opened = await readMapContainer(page)
    expect(opened.canvasContainers, 'the opened Design has one map').toBe(1)

    await markCurrentMap(page)
    await page.locator('canvas.maplibregl-canvas').evaluate((canvas: HTMLCanvasElement) => {
      const lose = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')
      if (!lose) throw new Error('the map canvas has no WEBGL_lose_context')
      lose.loseContext()
    })
    const stopped = page.getByText('The map stopped drawing. Your Design is safe.')
    await expect(stopped).toBeVisible()
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(stopped).toBeHidden()
    await expectOneMapAsOpened(page, opened)
  })

  // canopi-f47t.52.228.31. MapLibre destroys the style when the context goes (map.style is null), so taking down an
  // installed Basemap afterwards must not edit it: the failure path ends with the notice and no second error, which the
  // offline fixture would report as an unexpected console error.
  test('a lost context with the Basemap installed shows the notice and no failure-handling error (canopi-f47t.52.228.31)', async ({ page }) => {
    await page.route('https://tiles.openfreemap.org/styles/**', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: 8,
        sources: { openmaptiles: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution: BASEMAP_CREDITS } },
        layers: [{ id: 'water', type: 'fill', source: 'openmaptiles', paint: { 'fill-color': '#a0c8f0' } }],
      }),
    }))
    await openBaseFixture(page)
    // The Basemap's credits show once its style is installed on the map.
    await expect(designMap(page).locator('.maplibregl-ctrl-attrib')).toContainText('OpenStreetMap')

    await page.locator('canvas.maplibregl-canvas').evaluate((canvas: HTMLCanvasElement) => {
      const lose = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')
      if (!lose) throw new Error('the map canvas has no WEBGL_lose_context')
      lose.loseContext()
    })
    await expect(page.getByText('The map stopped drawing. Your Design is safe.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  })
})

// canopi-23p2. Here the Basemap style is answered in the page with inline credits and a sprite the offline rule aborts,
// so the Basemap installs with its credits and shows "Basemap couldn't load" with Retry, as a Basemap whose resources
// failed does.
test.describe('the map notice and the map credits', () => {
  test.use({ expectedConsoleErrors: ['MapLibre workspace basemap resource failed to load:'] })

  for (const size of [{ width: 760, height: 800 }, { width: 1400, height: 900 }, { width: 1920, height: 900 }]) {
    test(`the map notice never covers the map credits at ${size.width}x${size.height}`, async ({ page }) => {
      await page.route('https://tiles.openfreemap.org/styles/**', (route) => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: 8,
          sprite: 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm',
          sources: { openmaptiles: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution: BASEMAP_CREDITS } },
          layers: [{ id: 'water', type: 'fill', source: 'openmaptiles', paint: { 'fill-color': '#a0c8f0' } }],
        }),
      }))
      // Opened at the default size, whose opening scale openFixture checks, then resized as a window is.
      await openBaseFixture(page)
      await page.setViewportSize(size)
      const notice = page.locator('[data-map-notice]')
      await expect(notice).toContainText('Basemap couldn’t load')
      await expect(notice.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
      const credits = designMap(page).locator('.maplibregl-ctrl-attrib')
      await expect(credits).toContainText('OpenStreetMap')
      await expect(credits).toBeVisible()

      // The credits fold once the resized layout reaches the visible-map-area seam.
      const overlap = async () => {
        const [a, b] = [await notice.boundingBox(), await credits.boundingBox()]
        if (!a || !b) return 'a box is missing'
        return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
      }
      await expect.poll(overlap, 'the map notice does not cover the credits or their (i) button').toBe(false)
      // A wide window leaves the credits their one line beside the notice.
      if (size.width >= 1920) await expect(credits).not.toHaveClass(/maplibregl-compact/)
    })
  }
})
