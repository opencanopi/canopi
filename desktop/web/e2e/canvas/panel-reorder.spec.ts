// The dock's drag reorder in real engines (canopi-f47t.42, plan section 4, stream B's probe). Site data reorders its rows
// through the same owner as Stories, Favorites and the Design notebook (`components/shared/usePointerReorder.ts`): a
// grip's pointerdown captures the pointer, document listeners follow it, the list reflows live and one write lands on
// the drop. jsdom cannot show pointer capture, `touch-action: none` or a scrolled list's rects in a real engine, so this
// drags a Web Stories step inside the dock's scrolled list: in Chromium with the mouse and with a finger through CDP
// Input.dispatchTouchEvent, and in WebKit with the mouse (WebKit has no touch driver that moves). DOM assertions only.
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { designMap, expectCanvasDrawn } from '../support/canvas'
import { chooseFixtureFromStart } from '../support/layout'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
/** Short enough that six steps overflow the Stories body, so the drag runs in a scrolled list. */
const VIEWPORT = { width: 1400, height: 620 }
/** The steps after the fixture's one: six in all. */
const ADDED_STEPS = 5

interface Point { readonly x: number, readonly y: number }

async function openStories(page: Page): Promise<Locator> {
  await page.setViewportSize(VIEWPORT)
  await page.goto('')
  await chooseFixtureFromStart(page, FIXTURE)
  await expect(designMap(page)).toBeVisible()
  await expectCanvasDrawn(page)
  await page.getByRole('navigation', { name: 'Web Edition panels' }).getByRole('button', { name: 'Stories' }).click()
  const steps = page.getByRole('list', { name: 'Steps of Tour' })
  for (let added = 0; added < ADDED_STEPS; added += 1) {
    await page.getByRole('button', { name: 'Add the current view as a step' }).click()
    await expect(steps.locator('[data-story-step]')).toHaveCount(2 + added)
  }
  // Close the step editor the last add opened, then scroll the body so the first step is partly above its top.
  const selected = steps.locator('[aria-current="step"]')
  if (await selected.count()) await selected.click()
  const scrolled = await steps.evaluate((list) => {
    let body: HTMLElement | null = list.parentElement
    while (body && getComputedStyle(body).overflowY !== 'auto') body = body.parentElement
    if (!body) return -1
    body.scrollTop = 40
    return body.scrollTop
  })
  expect(scrolled, 'the Stories body scrolls').toBeGreaterThan(0)
  return steps
}

async function stepIds(steps: Locator): Promise<string[]> {
  return steps.locator('[data-story-step]').evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.storyStep!))
}

async function centreOf(target: Locator): Promise<Point> {
  const box = await target.boundingBox()
  if (!box) throw new Error('no box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** The grip of a step and the place above the second step's middle that a drop lands before it. */
async function dragPlaces(steps: Locator): Promise<{ from: Point, to: Point }> {
  const rows = steps.locator('[data-story-step]')
  const from = await centreOf(rows.last().getByRole('button', { name: /^Reorder step / }))
  const second = await rows.nth(1).boundingBox()
  if (!second) throw new Error('no second step')
  return { from, to: { x: from.x, y: second.y + second.height * 0.25 } }
}

/** The last step dragged above the second: the order the drop must write. */
function expectedAfterDrag(before: readonly string[]): string[] {
  const last = before.at(-1)!
  return [before[0]!, last, ...before.slice(1, -1)]
}

async function mouseDrag(page: Page, steps: Locator): Promise<void> {
  const { from, to } = await dragPlaces(steps)
  const before = await stepIds(steps)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, (from.y + to.y) / 2, { steps: 6 })
  await page.mouse.move(to.x, to.y, { steps: 6 })
  // The list reflows while the pointer is still down.
  await expect.poll(() => stepIds(steps), { message: 'the list reflows live' }).toEqual(expectedAfterDrag(before))
  await page.mouse.up()
  await expect.poll(() => stepIds(steps)).toEqual(expectedAfterDrag(before))
}

test.describe('mouse', () => {
  test('dragging a step\'s grip up a scrolled dock list reflows it live and writes the order on the drop', async ({ page }) => {
    const steps = await openStories(page)
    await mouseDrag(page, steps)
    // The drop wrote the Story: the grips are numbered from the stored order, not the preview.
    await expect(steps.locator('[data-story-step]').nth(1).getByRole('button', { name: 'Reorder step 2' })).toBeVisible()
  })
})

test.describe('Chromium touch', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'touch moves through CDP are Chromium-only')
  test.use({ hasTouch: true })

  test('a finger on a step\'s grip drags it up a scrolled dock list, and the list does not scroll', async ({ page }) => {
    const steps = await openStories(page)
    const scrollTop = () => steps.evaluate((list) => {
      let body: HTMLElement | null = list.parentElement
      while (body && getComputedStyle(body).overflowY !== 'auto') body = body.parentElement
      return body?.scrollTop ?? -1
    })
    const scrolledBefore = await scrollTop()
    const { from, to } = await dragPlaces(steps)
    const before = await stepIds(steps)
    const cdp = await page.context().newCDPSession(page)
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', at?: Point) => cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: at ? [{ id: 1, x: at.x, y: at.y, radiusX: 4, radiusY: 4, force: 1 }] : [],
    })
    await touch('touchStart', from)
    for (let step = 1; step <= 12; step += 1) {
      await touch('touchMove', { x: from.x, y: from.y + (to.y - from.y) * (step / 12) })
    }
    await expect.poll(() => stepIds(steps), { message: 'the list reflows live under the finger' }).toEqual(expectedAfterDrag(before))
    await touch('touchEnd')
    await expect.poll(() => stepIds(steps)).toEqual(expectedAfterDrag(before))
    expect(await scrollTop(), 'touch-action: none keeps the list from scrolling under the drag').toBe(scrolledBefore)
  })
})
