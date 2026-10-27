// An open Site data item's display in real engines (canopi-f47t.42, plan section 4, stream B, g4; architecture review
// finding 15; Relief, canopi-2add). `state=lidar-raster` draws the Rust engine's display COGs through Desktop's raster
// renderer (maplibre-gl-raster over the cog-tiler worker pool) on the real map, so a restyle is seen in pixels, not in
// a fake layer manager: the ground elevation opens on its relief, and a Colours round trip draws its elevation COG,
// which lies inside the relief, unlike both the relief and the empty map, and then the same relief again; on the
// elevation, Reverse and a Custom range typed in the open item each repaint the raster in Chromium, WebKit and Firefox. The
// renderer's opt-in timeline (`raster-display/diagnostics.ts`) says when its worker has rendered tiles: the map holds a
// steady picture for seconds before the first tile lands, so a settled capture alone can be the empty map. The rest is
// DOM: each kind's ramps, Relief's swatch, Reset only off the default, Custom only for a valid pair with the fr comma,
// and an opacity drag that keeps the item open. No baselines.
import type { Locator, Page } from '@playwright/test'
import { expect, openGallery, recordRasterTiles, renderedRasterTiles as renderedTiles, settledRaster, test } from '../support/gallery'

/** The map's pixels as PNG bytes, the dock panels over it masked (a pressed or focused control is not a repaint). */
async function mapPixels(map: Locator): Promise<Buffer> {
  return map.screenshot({ animations: 'disabled', mask: [map.page().locator('aside')] })
}

/** Waits until the renderer has rendered tiles beyond `after` and the map's picture holds still. */
async function settled(page: Page, map: Locator, after: number): Promise<Buffer> {
  return settledRaster(page, () => mapPixels(map), after)
}

/** A response for one of the Rust engine's display COGs: the relief or the elevation. */
function served(page: Page, fixture: 'rust-display-relief.tif' | 'rust-display-cog.tif') {
  return page.waitForResponse((response) => response.url().includes(fixture) && response.ok())
}

/** The Design on the relief, drawn as the ground elevation opens: on Relief. */
async function openRaster(page: Page): Promise<{ map: Locator }> {
  await recordRasterTiles(page)
  const relief = served(page, 'rust-display-relief.tif')
  await openGallery(page, { surface: 'site-data', state: 'lidar-raster' })
  await relief
  const map = page.getByRole('application', { name: 'Design map' })
  await settled(page, map, 0)
  return { map }
}

/** The map's picture once it holds still, with no new tiles awaited (what a hidden raster leaves). */
async function still(page: Page, map: Locator): Promise<Buffer> {
  return settledRaster(page, () => mapPixels(map), -1)
}

/** The Design with the ground elevation open and drawn in Terrain, on its elevation COG. */
async function openTerrain(page: Page): Promise<{ map: Locator, ground: Locator }> {
  const { map } = await openRaster(page)
  const ground = await openGround(page)
  const before = await renderedTiles(page)
  const cog = served(page, 'rust-display-cog.tif')
  await ground.getByRole('radio', { name: 'Terrain' }).click()
  await cog
  await settled(page, map, before)
  return { map, ground }
}

function siteData(page: Page): Locator {
  return page.locator('aside').filter({ has: page.locator('[data-site-line]') })
}

/** Opens the ground elevation's settings under its row. */
async function openGround(page: Page): Promise<Locator> {
  const ground = siteData(page).locator('[data-site-row="lidar-ground"]')
  await ground.locator('[data-control="name"]').click()
  await expect(ground.locator('[data-control="name"]')).toHaveAttribute('aria-expanded', 'true')
  return ground
}

test.describe('Relief on the real renderer', () => {
  test('an MNT draws its relief, and a Colours round trip draws its elevation and then the same relief again', async ({ page }) => {
    const { map } = await openRaster(page)
    const ground = await openGround(page)
    await expect(ground.getByRole('radio', { name: 'Relief' })).toHaveAttribute('aria-checked', 'true')
    const relief = await settled(page, map, 0)
    let before = await renderedTiles(page)
    const cog = served(page, 'rust-display-cog.tif')
    await ground.getByRole('radio', { name: 'Terrain' }).click()
    await cog
    // Colours shows what Relief hides, and the map draws the elevation where it drew the relief.
    await expect(ground.getByRole('button', { name: 'Reverse' })).toBeVisible()
    await expect(ground.getByRole('radiogroup', { name: 'Range' })).toBeVisible()
    const terrain = await settled(page, map, before)
    expect(terrain.equals(relief), 'Terrain repaints the relief').toBe(false)
    before = await renderedTiles(page)
    await ground.getByRole('radio', { name: 'Relief' }).click()
    await expect(ground.getByRole('button', { name: 'Reverse' })).toHaveCount(0)
    await expect(ground.getByRole('radiogroup', { name: 'Range' })).toHaveCount(0)
    const back = await settled(page, map, before)
    expect(back.equals(relief), 'Relief again paints the first picture').toBe(true)
    // The empty map, the item hidden: Terrain drew the elevation, not nothing.
    await page.getByRole('button', { name: 'Hide IGN ground elevation' }).first().click()
    await expect.poll(async () => (await mapPixels(map)).equals(relief), { timeout: 20_000 }).toBe(false)
    const empty = await still(page, map)
    expect(terrain.equals(empty), 'Terrain draws the elevation on the map').toBe(false)
  })

  test('swatches Relief as a shaded hill, painted unlike Gray\'s ramp', async ({ page }) => {
    await openGallery(page, { surface: 'site-data' })
    const ground = await openGround(page)
    const swatch = (name: string) => ground.getByRole('radio', { name }).locator('[data-swatch]')
    expect(await swatch('Relief').evaluate((element) => getComputedStyle(element).backgroundImage)).toMatch(/^radial-gradient\(/)
    const relief = await swatch('Relief').screenshot({ animations: 'disabled' })
    const gray = await swatch('Gray').screenshot({ animations: 'disabled' })
    expect(relief.equals(gray), 'the Relief swatch paints its own picture').toBe(false)
  })
})

test.describe('an open Site data item\'s display on the real renderer', () => {
  test('Reverse repaints the raster, and turning it off again paints the first picture', async ({ page }) => {
    const { map, ground } = await openTerrain(page)
    const drawn = await settled(page, map, 0)
    const reverse = ground.getByRole('button', { name: 'Reverse' })
    let before = await renderedTiles(page)
    await reverse.click()
    await expect(reverse).toHaveAttribute('aria-pressed', 'true')
    const reversed = await settled(page, map, before)
    expect(reversed.equals(drawn), 'Reverse repaints the raster').toBe(false)
    before = await renderedTiles(page)
    await reverse.click()
    const back = await settled(page, map, before)
    expect(back.equals(drawn), 'Reverse off paints the first picture again').toBe(true)
  })

  test('a Custom range typed in the open item repaints the raster', async ({ page }) => {
    const { map, ground } = await openTerrain(page)
    const drawn = await settled(page, map, 0)
    const before = await renderedTiles(page)
    // The COG's values span 19.75–90.25 m; a band in the middle saturates both ends.
    await ground.getByRole('textbox', { name: 'Minimum' }).fill('45')
    await ground.getByRole('textbox', { name: 'Minimum' }).press('Enter')
    await expect(ground.getByRole('radio', { name: 'Custom' })).toHaveAttribute('aria-checked', 'true')
    const custom = await settled(page, map, before)
    expect(custom.equals(drawn), 'a Custom range repaints the raster').toBe(false)
  })
})

test.describe('Cut outliers on the real display COG', () => {
  test('reads the 2–98 % range from the COG and fills the Range fields with it', async ({ page }) => {
    const { ground } = await openTerrain(page)
    await ground.getByRole('radio', { name: 'Cut outliers' }).click()
    await expect(ground.getByRole('radio', { name: 'Cut outliers' })).toHaveAttribute('aria-checked', 'true')
    // The fields show the item's data range (19.75–90.25 m) until the COG's own 2 % and 98 % points are read from it.
    const minimum = ground.getByRole('textbox', { name: 'Minimum' })
    const maximum = ground.getByRole('textbox', { name: 'Maximum' })
    const range = async () => [Number(await minimum.inputValue()), Number(await maximum.inputValue())]
    await expect.poll(range, { message: 'the 2–98 % range is read from the COG' }).not.toEqual([19.75, 90.25])
    const [low, high] = await range()
    expect(low).toBeLessThan(high!)
  })
})

test.describe('an open Site data item\'s settings', () => {
  test('offer each kind\'s ramps, and Reset only while the display differs from the kind\'s', async ({ page }) => {
    await openGallery(page, { surface: 'site-data' })
    const ground = await openGround(page)
    await expect(ground.getByRole('radiogroup', { name: 'Colors' }).getByRole('radio')).toHaveText(['', '', '', ''])
    const ramps = async (scope: Locator) => scope.getByRole('radiogroup', { name: 'Colors' }).getByRole('radio')
      .evaluateAll((radios) => radios.map((radio) => radio.getAttribute('aria-label')))
    expect(await ramps(ground)).toEqual(['Relief', 'Terrain', 'Earth', 'Gray'])
    await expect(ground.getByRole('button', { name: 'Reset' })).toHaveCount(0)
    await ground.getByRole('radio', { name: 'Gray' }).click()
    await expect(ground.getByRole('radio', { name: 'Gray' })).toHaveAttribute('aria-checked', 'true')
    await ground.getByRole('button', { name: 'Reset' }).click()
    await expect(ground.getByRole('radio', { name: 'Relief' })).toHaveAttribute('aria-checked', 'true')
    await expect(ground.getByRole('radio', { name: 'Relief' })).toBeFocused()
    await expect(ground.getByRole('button', { name: 'Reset' })).toHaveCount(0)

    const slope = siteData(page).locator('[data-site-row="lidar-slope"]')
    await slope.locator('[data-control="name"]').click()
    expect(await ramps(slope)).toEqual(['Yellow–red', 'Magma', 'Gray'])
    // A slope's fixed 0–30° default reads as Custom, with no Reset.
    await expect(slope.getByRole('radio', { name: 'Custom' })).toHaveAttribute('aria-checked', 'true')
    await expect(slope.getByRole('button', { name: 'Reset' })).toHaveCount(0)
  })

  test('commit Custom only for a valid pair, with the French decimal comma', async ({ page }) => {
    await openGallery(page, { surface: 'site-data', locale: 'fr' })
    const ground = await openGround(page)
    await ground.getByRole('radio', { name: 'Terrain' }).click()
    const minimum = ground.getByRole('textbox', { name: 'Minimum' })
    const maximum = ground.getByRole('textbox', { name: 'Maximum' })
    const top = await maximum.inputValue()
    await minimum.fill('140,5')
    await minimum.press('Enter')
    await expect(ground.getByRole('radio', { name: 'Personnalisée' })).toHaveAttribute('aria-checked', 'true')
    await expect(minimum).toHaveValue('140,5')
    // A minimum above the maximum stays a draft while focus moves to the other end,
    // and reverts with it once focus leaves the pair with no valid pair.
    await minimum.fill('9999')
    await minimum.press('Tab')
    await expect(maximum).toBeFocused()
    await expect(minimum).toHaveValue('9999')
    await maximum.press('Tab')
    await expect(maximum).not.toBeFocused()
    await expect(minimum).toHaveValue('140,5')
    await expect(maximum).toHaveValue(top)
    await expect(ground.getByRole('radio', { name: 'Personnalisée' })).toHaveAttribute('aria-checked', 'true')
  })

  test('keep the item open while its opacity is dragged', async ({ page }) => {
    await openGallery(page, { surface: 'site-data' })
    const ground = await openGround(page)
    const slider = ground.getByRole('slider', { name: 'Opacity: IGN ground elevation' })
    const box = await slider.boundingBox()
    await page.mouse.move(box!.x + box!.width - 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect(slider).toHaveValue(/^(1\d|2\d)$/)
    await expect(ground.locator('[data-control="name"]')).toHaveAttribute('aria-expanded', 'true')
  })
})

test.describe('the raster band after a map Retry', () => {
  // Playwright's Firefox logs the Error argument by its name alone, without the message.
  test.use({
    expectedConsoleErrors: async ({ browserName }, use) => use([browserName === 'firefox' ? 'Shared workspace map failed: Error' : 'Shared workspace map failed: Error: MapLibre WebGL context was lost']),
  })

  /** The rebuilt map's layers, bottom first: each LiDAR raster as `lidar`, the scene and the Site data pin as named. */
  async function stack(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const map = (window as { __galleryRasterMap?: { getLayersOrder(): string[], getLayer(id: string): { type: string } } }).__galleryRasterMap
      if (!map) return []
      return map.getLayersOrder().map((id) => map.getLayer(id)?.type === 'raster' ? 'lidar' : id)
    })
  }

  test('a raster that arrives after the rebuild draws below the Design and the pin', async ({ page }) => {
    const { map } = await openRaster(page)
    // A pin, so the Site data layers are on the map too.
    const box = await map.boundingBox()
    await page.mouse.click(box!.x + box!.width * 0.2, box!.y + box!.height * 0.4)
    await expect.poll(() => stack(page)).toContain('site-pin-core')
    const before = await stack(page)
    expect(before.lastIndexOf('lidar'), before.join(' ')).toBeLessThan(before.indexOf('canopi-shared-scene'))

    const tiles = await renderedTiles(page)
    await page.locator('canvas.maplibregl-canvas').evaluate((canvas: HTMLCanvasElement) => {
      const lose = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')
      if (!lose) throw new Error('the map canvas has no WEBGL_lose_context')
      lose.loseContext()
    })
    const stopped = page.getByText('The map stopped drawing. Your Design is safe.')
    await expect(stopped).toBeVisible()
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(stopped).toBeHidden()
    await settled(page, map, tiles)

    const after = await stack(page)
    const scene = after.indexOf('canopi-shared-scene')
    expect(scene, after.join(' ')).toBeGreaterThan(-1)
    expect(after.filter((id) => id === 'lidar').length, after.join(' ')).toBe(before.filter((id) => id === 'lidar').length)
    expect(after.lastIndexOf('lidar'), after.join(' ')).toBeLessThan(scene)
    expect(after.slice(scene).filter((id) => id === 'lidar'), 'nothing above the Design is a raster').toEqual([])
  })
})
