// Window-level tooltip layers (canopi-xpqt; design check fixes20-dc-tooltips). Every button tooltip is drawn in one
// body-level layer at --z-tooltip and the canvas hover card in another at --z-hover-card, placed from their anchor so the
// whole box is inside the window, and on top of every frame: the blurred rails, the tool card, the dock and the WebGL
// map; the hover card stays under every menu, popover and dialog the user opens, and hides while one is open. The probe below
// (stream commit 0) checks the engine assumption the layer rests on; the tests after it check each tooltip.
// "On top" is read with elementFromPoint at points inset from the box's rounded corners and at its centre, with the
// tooltip's pointer-events switched on for the read (it takes no pointer otherwise, so elementFromPoint skips it).
// Chromium, WebKit and Firefox; DOM assertions only, no baselines.
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { boxOf, mapHost, openFixture, type Box } from '../support/layout'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))

// Opening a Design asks the browser to keep Drafts (2.1-Q82, Q191). A fresh Firefox profile leaves persist() pending
// behind its permission prompt, a browser panel over the top of the page (x 300 to 700 at these sizes) that takes the
// pointer: the page sees it leave (mouseout with no relatedTarget) and no tooltip shows (canopi-f47t.52.228.26). Firefox
// answers as a fresh Chromium context and WebKit do, refused, so every engine checks the same title bar.
test.beforeEach(async ({ page, browserName }) => {
  if (browserName !== 'firefox') return
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, 'persist', { configurable: true, value: () => Promise.resolve(false) })
  })
})

test.describe('the body-level layer (probe)', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('a fixed body-level box at --z-tooltip paints above the blurred rails, the tool card, the dock and the WebGL map', async ({ page }) => {
    await openFixture(page, FIXTURE)
    await page.locator('[data-panel-rail] [data-panel="layers"]').click()
    const targets: Array<[string, Box]> = [
      ['the tool rail', await boxOf(page.locator('[data-tool-rail]'))],
      ['the tool card', await boxOf(page.locator('[data-tool-card]').first())],
      ['the zoom group', await boxOf(page.locator('[data-zoom-group]'))],
      ['the panel rail', await boxOf(page.locator('[data-panel-rail]'))],
      ['the dock', await boxOf(page.locator('[data-dock-width]'))],
      ['the map', await boxOf(mapHost(page).locator('canvas').first())],
    ]
    const misses = await page.evaluate((boxes) => {
      const layer = document.createElement('div')
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:var(--z-tooltip)'
      document.body.appendChild(layer)
      const found: string[] = []
      for (const [name, box] of boxes) {
        const probe = document.createElement('div')
        const width = Math.min(48, box.width - 4)
        const height = Math.min(28, box.height - 4)
        const left = box.x + box.width / 2 - width / 2
        const top = box.y + box.height / 2 - height / 2
        probe.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;`
          + 'border-radius:var(--radius-md);background:#f00;pointer-events:auto'
        layer.appendChild(probe)
        for (const [x, y] of [[left + 6, top + 6], [left + width - 6, top + height - 6], [left + width / 2, top + height / 2]]) {
          const hit = document.elementFromPoint(x!, y!)
          if (hit !== probe) found.push(`${name} at (${x}, ${y}): ${hit?.tagName}.${hit?.className}`)
        }
      }
      layer.remove()
      return found
    }, targets)
    expect(misses, 'the probe box is on top everywhere').toEqual([])
  })

  test('a disabled button gets pointerenter and pointerleave from a mouse', async ({ page }) => {
    await openFixture(page, FIXTURE)
    await page.evaluate(() => {
      const button = document.createElement('button')
      button.disabled = true
      button.textContent = 'Disabled probe'
      button.style.cssText = 'position:fixed;left:600px;top:400px;width:120px;height:40px;z-index:9999'
      button.dataset.probe = ''
      const seen: string[] = []
      ;(window as unknown as { probeSeen: string[] }).probeSeen = seen
      button.addEventListener('pointerenter', (event) => seen.push(`enter:${event.pointerType}`))
      button.addEventListener('pointerleave', (event) => seen.push(`leave:${event.pointerType}`))
      document.body.appendChild(button)
    })
    await page.mouse.move(100, 100)
    await page.mouse.move(660, 420, { steps: 4 })
    await page.mouse.move(100, 100, { steps: 4 })
    await expect.poll(() => page.evaluate(() => (window as unknown as { probeSeen: string[] }).probeSeen))
      .toEqual(['enter:mouse', 'leave:mouse'])
  })
})

interface Layout {
  readonly name: string
  readonly width: number
  readonly height: number
  /** A plant of the base fixture at its opening camera, for the hover card (at 1440x900 left of the open dock). */
  readonly plant: { readonly x: number, readonly y: number }
  /** The panel rail floats beside the map (not on phones), and the dock opens over the map's right side. */
  readonly dock: boolean
}

const LAYOUTS: readonly Layout[] = [
  { name: 'desktop', width: 1440, height: 900, plant: { x: 854, y: 524 }, dock: true },
  { name: 'tablet', width: 820, height: 1180, plant: { x: 578, y: 490 }, dock: true },
  { name: 'phone', width: 390, height: 844, plant: { x: 266, y: 322 }, dock: false },
]

/** The buttons to check per layout: a tool strip, map control, right panel and top bar button. */
function buttons(page: Page, layout: Layout): Array<[string, Locator]> {
  return [
    ['the tool strip\'s third tool', page.locator('[data-tool-rail] [data-rail-tool]').nth(2)],
    ['the tool strip\'s first tool', page.locator('[data-tool-rail] [data-rail-item]').first()],
    ['the first map control', page.locator('[data-zoom-group] button').first()],
    ['the last map control (Reset north)', page.locator('[data-zoom-group] button').last()],
    ...(layout.dock ? [['the panel rail\'s Layers', page.locator('[data-panel-rail] [data-panel="layers"]')] as [string, Locator]] : []),
    ['the top bar\'s first icon button', topBarIconButtons(page).first()],
    ['the top bar\'s last icon button', topBarIconButtons(page).last()],
  ]
}

/** Rests the pointer on the plant near `plant` until its hover card shows (the engines' framing may differ by a pixel or two). */
async function showHoverCard(page: Page, plant: { readonly x: number, readonly y: number }): Promise<void> {
  const showing = () => page.evaluate(() => document.querySelector<HTMLElement>('[data-hover-card-layer] [data-hover-tooltip]')?.style.display === 'block')
  await page.mouse.move(plant.x - 30, plant.y - 30)
  for (const radius of [0, 4, 8, 12, 16]) {
    for (const dx of [-radius, 0, radius]) {
      for (const dy of [-radius, 0, radius]) {
        await page.mouse.move(plant.x + dx, plant.y + dy, { steps: 2 })
        if (await showing()) return
      }
    }
  }
}

/**
 * Expects `surface` to draw over the hover card where they meet: the card is moved onto the surface's centre (its
 * pointer-events switched on for the read), and elementFromPoint there still reaches the surface.
 */
async function expectCardUnder(card: Locator, surface: Locator, name: string): Promise<void> {
  const box = await surface.boundingBox()
  if (!box) throw new Error(`${name} has no box`)
  const hit = await card.evaluate((element: HTMLElement, at) => {
    element.style.left = `${at.x - 20}px`
    element.style.top = `${at.y - 10}px`
    element.style.pointerEvents = 'auto'
    const found = document.elementFromPoint(at.x, at.y)
    element.style.pointerEvents = 'none'
    return found === null ? 'nothing' : element.contains(found) ? 'the hover card' : 'other'
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
  expect(hit, `${name} draws over the hover card`).toBe('other')
  expect(await surface.evaluate((element, at) => element.contains(document.elementFromPoint(at.x, at.y)), { x: box.x + box.width / 2, y: box.y + box.height / 2 }), `${name} is on top at its centre`).toBe(true)
}

/** The top bar's shown buttons that carry a tooltip (the menu bar's named menus carry none). */
function topBarIconButtons(page: Page): Locator {
  return page.locator('[data-workspace-title-bar] button:has([data-tooltip-anchor])').filter({ visible: true })
}

function tooltip(page: Page): Locator {
  return page.locator('[data-tooltip-layer] [role="tooltip"]')
}

/**
 * Expects `shown` to be drawn whole inside the window, and on top: elementFromPoint, with its pointer-events switched
 * on for the read, reaches it at points 6 px inside each rounded corner and at its centre.
 */
async function expectWholeOnTop(shown: Locator, name: string): Promise<void> {
  await expect(shown, `${name}: one box shows`).toHaveCount(1)
  await expect(shown, `${name}: it shows`).toBeVisible()
  await expect(shown, `${name}: its fade has ended`).toHaveCSS('opacity', '1')
  const read = await shown.evaluate((element: HTMLElement) => {
    const box = element.getBoundingClientRect()
    const inset = 6
    const points = [
      [box.left + inset, box.top + inset], [box.right - inset, box.top + inset],
      [box.left + inset, box.bottom - inset], [box.right - inset, box.bottom - inset],
      [box.left + box.width / 2, box.top + box.height / 2],
    ] as const
    const before = element.style.pointerEvents
    element.style.pointerEvents = 'auto'
    const misses = points.flatMap(([x, y]) => {
      const hit = document.elementFromPoint(x, y)
      return hit && element.contains(hit) ? [] : [`(${Math.round(x)}, ${Math.round(y)}) hits ${hit?.tagName}.${String(hit?.className)}`]
    })
    element.style.pointerEvents = before
    return {
      box: [box.left, box.top, box.right, box.bottom].map(Math.round),
      inside: box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight,
      misses,
    }
  })
  expect(read.inside, `${name}: the box ${read.box.join(', ')} is inside the window`).toBe(true)
  expect(read.misses, `${name}: nothing covers it`).toEqual([])
}

for (const layout of LAYOUTS) {
  test.describe(`${layout.name} (${layout.width}x${layout.height})`, () => {
    test.use({ viewport: { width: layout.width, height: layout.height } })

    for (const names of [true, false]) {
      test(`hovering and focusing a tool strip, map control, right panel and top bar button shows its whole tooltip on top${names ? ', with tool names' : ', icons only'}`, async ({ page }) => {
        await openFixture(page, FIXTURE, { settings: { tool_names_visible: names } })
        if (layout.dock) await page.locator('[data-panel-rail] [data-panel="layers"]').click()
        for (const [name, button] of buttons(page, layout)) {
          await expect(button, `${name} is laid out`).toBeVisible()
          await page.mouse.move(layout.width / 2, 2)
          await expect(tooltip(page), `${name}: no tooltip before the hover`).toHaveCount(0)
          await button.hover()
          await expectWholeOnTop(tooltip(page), `${name} (hover)`)
          await page.mouse.move(layout.width / 2, 2)
          await expect(tooltip(page), `${name}: the tooltip leaves with the pointer`).toHaveCount(0)

          await page.keyboard.press('Shift')
          await button.focus()
          await expectWholeOnTop(tooltip(page), `${name} (keyboard focus)`)
          await button.evaluate((element: HTMLElement) => element.blur())
          await expect(tooltip(page), `${name}: the tooltip leaves with the focus`).toHaveCount(0)
        }
      })
    }

    test('the canvas hover card shows whole on top', async ({ page }) => {
      await openFixture(page, FIXTURE)
      // At 1440x900 the open dock is beside the plant, where its card opens.
      if (layout.width >= 1440) await page.locator('[data-panel-rail] [data-panel="layers"]').click()
      const card = page.locator('[data-hover-card-layer] [data-hover-tooltip]')
      await showHoverCard(page, layout.plant)
      await expect(card).toHaveText(/\p{L}/u)
      await expectWholeOnTop(card, 'the hover card')
    })

    if (layout.name === 'desktop') {
      test('the canvas hover card never covers a menu, a popover or a dialog opened while it shows', async ({ page }) => {
        await openFixture(page, FIXTURE)
        const card = page.locator('[data-hover-tooltip]')
        await showHoverCard(page, layout.plant)
        await expect(card).toBeVisible()

        // A right-click where the pointer rests opens the plant's menu at the pointer, where the card was.
        await page.mouse.down({ button: 'right' })
        await page.mouse.up({ button: 'right' })
        const menu = page.locator('[role="menu"]')
        await expect(menu).toBeVisible()
        await expectCardUnder(card, menu, 'the menu')

        // Its Plant color entry opens the non-modal popover; the pointer back on the plant keeps the card hidden.
        await menu.getByRole('menuitem', { name: /^Plant color/ }).click()
        const popover = page.locator('[role="dialog"][data-preserve-overlays="true"]')
        await expect(popover).toBeVisible()
        await showHoverCard(page, layout.plant)
        await expect(card).toBeHidden()
        await expectCardUnder(card, popover, 'the Plant color popover')
        await page.keyboard.press('Escape')
        await expect(popover).toHaveCount(0)

        // A dialog a shortcut opens while the pointer rests on the plant (the Desktop command palette, which the Web build
        // has not): a modal at the dialog level is added the way a dialog mounts.
        await showHoverCard(page, layout.plant)
        await expect(card).toBeVisible()
        await page.evaluate(() => {
          const dialog = document.createElement('div')
          dialog.setAttribute('role', 'dialog')
          dialog.setAttribute('aria-modal', 'true')
          dialog.dataset.probeDialog = 'true'
          dialog.style.cssText = 'position:fixed;left:200px;top:200px;width:400px;height:300px;background:#fff;z-index:var(--z-dialog)'
          dialog.textContent = 'Dialog'
          document.body.appendChild(dialog)
        })
        await expectCardUnder(card, page.locator('[data-probe-dialog]'), 'the dialog')
      })

      test('the canvas hover card hides while a menu drawn in a low stacking context is open (the map scale menu)', async ({ page }) => {
        await openFixture(page, FIXTURE)
        const card = page.locator('[data-hover-card-layer] [data-hover-tooltip]')
        await page.locator('[data-zoom-group] button[aria-haspopup="menu"]').click()
        const menu = page.locator('[data-zoom-group] [role="menu"]')
        await expect(menu).toBeVisible()
        await showHoverCard(page, layout.plant)
        // The runtime shows the card for the plant (its inline display); the open menu hides it.
        await expect.poll(() => card.evaluate((element: HTMLElement) => element.style.display)).toBe('block')
        await expect(menu).toBeVisible()
        await expect(card).toBeHidden()
        await expectCardUnder(card, menu, 'the map scale menu')
        await page.keyboard.press('Escape')
        await expect(menu).toHaveCount(0)
        await showHoverCard(page, layout.plant)
        await expect(card, 'the card shows again once the menu closes').toBeVisible()
      })
    }
  })
}
