// An open Design shows in the frame its first scene is drawn (app/canvas-map-surface/design-reveal.ts), so its chrome never
// sits over an empty map; until then the chrome is laid out but transparent. One opened from the start screen keeps the start
// screen up meanwhile; one already open when the canvas mounts (a reload restoring a Draft) never shows it. The unit tests
// drive the signal through a stub renderer; these scenarios sample every animation frame of the real page while a Design
// opens, cold, after Close Design, over another open Design and on a reload, and check that an open from the start screen
// shows no frame with neither the start screen nor the drawn scene, and that a switch or a reload never shows the start
// screen. A real browser also checks what jsdom cannot: a field that focuses itself while hidden keeps its focus. The map is
// aria-busy until its renderer has drawn the latest scene (support/canvas.ts), so the first scene is drawn in the first frame
// the map is not busy after one where it was. A later scene change makes it busy again over a drawn scene, and the web font
// that a note's text waits for is one: when it lands while the first scene renders, the render that drew presents the
// Design while the redraw keeps the map busy, so no frame shows the drawn scene idle (Firefox, canopi-f47t.52.228.27). The
// scenarios that check the chrome against the drawn scene hold the web fonts until they have read their frames, so the font's
// redraw never lands in them; the redraw itself is annotation-layout.ts's.
// No baselines: nothing here is compared with a recorded screenshot.
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { designMap, expectCanvasDrawn } from '../support/canvas'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))

interface FrameSample {
  readonly startScreen: boolean
  readonly chromeShown: boolean
  /** The map is present and has drawn the latest scene change (no aria-busy). */
  readonly mapIdle: boolean
  /** The map is present and has a scene change not drawn yet (aria-busy). */
  readonly mapBusy: boolean
}

/** Records, in every animation frame from now on, whether the start screen and the tool rail show and whether the map is busy. */
function sampleEveryFrame(): void {
  const page = window as unknown as { __revealSamples?: FrameSample[] }
  const sampling = page.__revealSamples !== undefined
  page.__revealSamples = []
  if (sampling) return
  const sample = () => {
    const rail = document.querySelector('[data-tool-rail]')
    const map = document.querySelector('[role="application"]')
    page.__revealSamples!.push({
      startScreen: document.querySelector('[data-start-screen]') !== null,
      chromeShown: rail !== null && rail.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
      mapIdle: map !== null && map.getAttribute('aria-busy') !== 'true',
      mapBusy: map !== null && map.getAttribute('aria-busy') === 'true',
    })
    requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
}

/**
 * Holds every web font the page requests from now on until the test ends, so a font that lands while a Design opens never
 * redraws its scene there (see the header); returns how many requests it holds. Text draws in the fallback font, and the
 * page's load event waits for the fonts, so a navigation meanwhile waits only for the document. A document that requested
 * fonts before the hold must not be left meanwhile: Firefox reports its cancelled font requests as console errors.
 */
async function holdWebFonts(page: Page): Promise<() => number> {
  let held = 0
  await page.route(/\.(?:woff2|ttf|otf)(?:\?|$)/, () => {
    held += 1
    return new Promise<void>(() => {})
  })
  return () => held
}

async function startSampling(page: Page): Promise<void> {
  await page.evaluate(sampleEveryFrame)
}

/** The frames sampled since startSampling, once a frame has sampled the shown Design. */
async function samples(page: Page): Promise<FrameSample[]> {
  const read = () => page.evaluate(() => (window as unknown as { __revealSamples: FrameSample[] }).__revealSamples.slice())
  await expect.poll(async () => (await read()).some((frame) => frame.chromeShown), 'a frame sampled the shown Design').toBe(true)
  return read()
}

async function openFixture(page: Page, choose = () => page.getByRole('button', { name: /Open a \.canopi file…/ }).first().click()): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), choose()])
  await chooser.setFiles(FIXTURE)
  await expect(designMap(page)).toBeVisible()
  await expect(page.getByRole('toolbar', { name: 'Tools' })).toBeVisible()
  await expectCanvasDrawn(page)
}

/**
 * The first frame that shows the opened Design's first scene drawn: the first one with the map idle after a frame with it
 * busy, since opening a Design is a scene change. Throws when no sampled frame saw the map busy, rather than counting an
 * idle map from before the open as drawn.
 */
function firstDrawnFrame(frames: readonly FrameSample[]): number {
  const busy = frames.findIndex((frame) => frame.mapBusy)
  if (busy < 0) throw new Error(`no sampled frame saw the map busy with the opened Design: ${JSON.stringify(frames.slice(0, 5))}`)
  const drawn = frames.findIndex((frame, index) => index > busy && frame.mapIdle)
  if (drawn < 0) throw new Error('no sampled frame shows the opened Design drawn')
  return drawn
}

/** The first frame that shows the chrome before the first scene is drawn, or -1. */
function chromeOverEmptyMap(frames: readonly FrameSample[]): number {
  const drawn = firstDrawnFrame(frames)
  return frames.findIndex((frame, index) => index < drawn && frame.chromeShown)
}

function around(frames: readonly FrameSample[], index: number): string {
  return JSON.stringify(frames.slice(Math.max(0, index - 2), index + 3))
}

function expectNoBlankFrame(frames: readonly FrameSample[]): void {
  const drawn = firstDrawnFrame(frames)
  const blank = frames.findIndex((frame, index) => index < drawn && !frame.startScreen)
  expect(blank, `frame ${blank} shows the map before its scene is drawn (frame ${drawn}): ${around(frames, blank)}`).toBe(-1)
  const early = chromeOverEmptyMap(frames)
  expect(early, `frame ${early} shows the chrome before the scene is drawn (frame ${drawn}): ${around(frames, early)}`).toBe(-1)
}

test('opening a Design shows its chrome with its drawn scene, cold and after Close Design', async ({ page }) => {
  const heldFonts = await holdWebFonts(page)
  await page.goto('', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-start-screen]')).toBeVisible()

  await startSampling(page)
  await openFixture(page)
  expectNoBlankFrame(await samples(page))

  await page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: 'Close Design' }).click()
  await expect(page.locator('[data-start-screen]')).toBeVisible()

  await startSampling(page)
  await openFixture(page)
  expectNoBlankFrame(await samples(page))
  expect(heldFonts(), 'the fonts were held').toBeGreaterThan(0)
})

test('opening another Design over an open one never brings the start screen back', async ({ page }) => {
  await page.goto('')
  await openFixture(page)

  await startSampling(page)
  await page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'File' }).click()
  await openFixture(page, () => page.getByRole('menuitem', { name: /^Open a \.canopi file…/ }).click())

  const frames = await samples(page)
  const startScreen = frames.findIndex((frame) => frame.startScreen)
  expect(startScreen, `frame ${startScreen} shows the start screen during the switch`).toBe(-1)
})

test('a reload that restores the latest Draft never shows the start screen, nor the chrome over an empty map', async ({ page }) => {
  await page.goto('')
  await openFixture(page)

  // Leaving the page writes the Draft; the reload reopens it before the canvas mounts, so the start screen's buttons would
  // replace a Design the user never left.
  const heldFonts = await holdWebFonts(page)
  await page.addInitScript(sampleEveryFrame)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('toolbar', { name: 'Tools' })).toBeVisible()
  await expectCanvasDrawn(page)

  const frames = await samples(page)
  const startScreen = frames.findIndex((frame) => frame.startScreen)
  expect(startScreen, `frame ${startScreen} shows the start screen after the reload`).toBe(-1)
  const early = chromeOverEmptyMap(frames)
  expect(early, `frame ${early} shows the chrome before the scene is drawn: ${around(frames, early)}`).toBe(-1)
  expect(heldFonts(), 'the reloaded page\'s fonts were held').toBeGreaterThan(0)
})

test('a New Design\'s place field has keyboard focus once the Design shows', async ({ page }) => {
  await page.goto('')
  await page.locator('[data-start-screen]').getByRole('button', { name: 'New Design' }).first().focus()
  await page.keyboard.press('Enter')

  // Its autofocus runs while the opening Design is still hidden behind the start screen; it must survive the reveal.
  await expect(page.locator('[data-start-screen]')).toHaveCount(0)
  await expect(page.locator('[data-site-locate]').getByRole('combobox', { name: 'Place or coordinates' })).toBeFocused()
})

test('the transparent chrome of a hidden Design takes no pointer input, even where a part asks for it', async ({ page }) => {
  await page.goto('')
  await openFixture(page)

  // The hidden window lasts until the first scene is drawn, too short to sample reliably, so the canvas area is given the
  // attribute the reveal sets: what is under test is the cascade. The probe sets pointer-events: auto inline and stands for
  // chrome whose stylesheet does (the place card row, the map notice's Retry).
  const takesPointer = await page.evaluate(() => {
    const area = document.querySelector('[data-testid="web-canvas-workspace-surface"]')!.parentElement!
    const probe = document.createElement('div')
    probe.innerHTML = '<div><button type="button" style="pointer-events: auto" data-probe>probe</button></div>'
    area.append(probe)
    area.setAttribute('data-design-hidden', '')
    const found = [...area.querySelectorAll<HTMLElement>('*')]
      .filter((element) => element.closest('[data-start-screen]') === null && getComputedStyle(element).pointerEvents !== 'none')
      .map((element) => element.outerHTML.slice(0, 120))
    area.removeAttribute('data-design-hidden')
    probe.remove()
    return found
  })
  expect(takesPointer).toEqual([])
})

test('the title bar shows what the start screen shows until the hidden Design shows', async ({ page }) => {
  await page.goto('')
  await openFixture(page)

  // As above, the canvas area is given the attribute the reveal sets: the Design's name, save status and place field sit
  // outside the canvas area, yet must not show over the start screen nor take its clicks while the Design loads.
  const visibleWhileHidden = await page.evaluate(() => {
    const area = document.querySelector('[data-testid="web-canvas-workspace-surface"]')!.parentElement!
    const titleBar = document.querySelector('[data-workspace-title-bar]')!
    const parts = {
      name: titleBar.querySelector<HTMLElement>('[aria-label^="Rename Design"]')!,
      saveStatus: titleBar.querySelector<HTMLElement>('[data-save-status]')!,
      placeField: titleBar.querySelector<HTMLElement>('[role="combobox"]')!,
      menus: titleBar.querySelector<HTMLElement>('[role="menubar"]')!,
    }
    const shown = (element: HTMLElement) => element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      && getComputedStyle(element).pointerEvents !== 'none'
    area.setAttribute('data-design-hidden', '')
    const hidden = Object.fromEntries(Object.entries(parts).map(([name, element]) => [name, shown(element)]))
    area.removeAttribute('data-design-hidden')
    const revealed = Object.fromEntries(Object.entries(parts).map(([name, element]) => [name, shown(element)]))
    return { hidden, revealed }
  })
  expect(visibleWhileHidden).toEqual({
    hidden: { name: false, saveStatus: false, placeField: false, menus: true },
    revealed: { name: true, saveStatus: true, placeField: true, menus: true },
  })
})

// canopi-23p2: in a New Design's overview the Start card, its found-place chip and the top-centre chip slot share one row
// (SiteOnboarding), so the overview notice never covers the card, and every chip stays on screen and clear of the panels.
// On a phone (360x740) the overview notice is the context bar's, in the panel sheet, and the canvas has no top chip slot.
for (const size of [{ width: 360, height: 740 }, { width: 768, height: 800 }, { width: 1400, height: 900 }]) {
  const phone = size.width < 640
  test(`a New Design's top chips sit beside the Start card, on screen and clear of the panels, at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size)
    await page.goto('')
    await page.locator('[data-start-screen]').getByRole('button', { name: 'New Design' }).first().click()
    await page.locator('[data-site-locate]').getByRole('button', { name: 'Skip, I’ll find it on the map' }).click()
    await expect(page.locator('[data-start-design]')).toBeVisible()
    await expect(page.locator('[data-overview-notice]')).toBeVisible()

    const rects = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector)
        if (!element) return null
        const { left, top, right, bottom } = element.getBoundingClientRect()
        return { left, top, right, bottom }
      }
      const found = document.querySelector('[data-found-site]')
      const slot = document.querySelector('[data-top-chip-slot]')
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        notice: box('[data-overview-notice]'),
        found: box('[data-found-site]'),
        card: box('[data-start-design]'),
        rail: box('nav[aria-label="Web Edition panels"]'),
        foundInRow: found?.parentElement?.hasAttribute('data-start-row') ?? false,
        slotInRow: slot?.parentElement?.hasAttribute('data-start-row') ?? false,
        noticeInBar: document.querySelector('[data-overview-notice]')?.closest('[data-phone-context-bar]') != null,
        foundInSlot: slot?.contains(found ?? null) ?? false,
      }
    })
    expect(rects.foundInRow, 'the found-place chip is a child of the Start row').toBe(true)
    expect(rects.slotInRow, phone ? 'a phone has no top-centre slot' : 'the top-centre slot is a child of the Start row').toBe(!phone)
    expect(rects.noticeInBar, phone ? 'the overview notice is the context bar\'s' : 'no context bar').toBe(phone)
    expect(rects.foundInSlot, 'the found-place chip is beside the slot, not in it').toBe(false)
    const { viewport, notice, found, card, rail } = rects
    for (const [name, chip] of [['overview notice', notice], ['found-place chip', found]] as const) {
      expect(chip, name).not.toBeNull()
      expect(chip!.left, `${name} left edge on screen`).toBeGreaterThanOrEqual(0)
      expect(chip!.top, `${name} top edge on screen`).toBeGreaterThanOrEqual(0)
      expect(chip!.right, `${name} right edge on screen`).toBeLessThanOrEqual(viewport.width)
      expect(chip!.bottom, `${name} bottom edge on screen`).toBeLessThanOrEqual(viewport.height)
      if (rail && rail.right > rail.left) expect(chip!.right, `${name} left of the panel rail`).toBeLessThanOrEqual(rail.left)
    }
    const overlaps = notice!.left < card!.right && card!.left < notice!.right && notice!.top < card!.bottom && card!.top < notice!.bottom
    expect(overlaps, 'the overview notice does not cover the Start card').toBe(false)
  })
}
