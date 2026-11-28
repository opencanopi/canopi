// The note's text entry (canvas/runtime/chrome/text-entry-host.ts) sizes itself to what the browser measures: as wide as
// its text, or its placeholder while empty, and as tall as its lines. jsdom has no layout, so this runs in the browser,
// in both engines: two typed lines stay inside the box with the start of the text in view, for a new note and for a
// note edited in place while it is turned 30° on screen, and an empty field shows its whole placeholder in Russian and
// Japanese. The committed note is drawn at the width the browser measures (canvas/runtime/annotation-layout.ts): its
// selection outline ends at its last letter, also once a late font file arrives and the outline and the glyphs follow
// the web font. No baselines: nothing here is compared with a recorded screenshot.
import { fileURLToPath } from 'node:url'
import type { Page, Route } from '@playwright/test'
import { expectCanvasDrawn } from '../support/canvas'
import { chooseFixtureFromStart } from '../support/layout'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
/** Empty map, away from every object and chrome of the fixture's opening camera. */
const NEUTRAL = { x: 800, y: 450 }

/** The map host, the one `application` on the page, by role alone: its name follows the page's language. */
function designMap(page: Page) {
  return page.getByRole('application')
}

/** Opens the fixture; a page whose font file is held back waits for its DOM only, since the load event waits for fonts. */
async function openBaseFixture(page: Page, selectTool: string, waitUntil: 'load' | 'domcontentloaded' = 'load'): Promise<void> {
  await page.goto('', { waitUntil })
  await chooseFixtureFromStart(page, FIXTURE)
  await expect(designMap(page)).toBeVisible()
  await expect(tool(page, selectTool)).toHaveAttribute('aria-pressed', 'true')
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
  // The canvas has drawn the opened Design (e2e/support/canvas.ts).
  await expect(designMap(page)).not.toHaveAttribute('aria-busy')
}

/** A rail tool by its name in the page's language. */
function tool(page: Page, name: string) {
  return page.getByRole('toolbar').first().getByRole('button', { name, exact: true })
}

function entry(page: Page) {
  return page.locator('textarea[data-canvas-text-entry]')
}

/** Opens a new note's entry at the neutral point with the Text tool. */
async function openNewNote(page: Page, textTool: string): Promise<void> {
  await tool(page, textTool).click()
  await page.mouse.click(NEUTRAL.x, NEUTRAL.y)
  await expect(entry(page)).toBeFocused()
}

/** What the field shows of its content: its scroll extent against its box, and where it is scrolled to. */
async function fit(page: Page) {
  return entry(page).evaluate((field: HTMLTextAreaElement) => ({
    scrollWidth: field.scrollWidth,
    clientWidth: field.clientWidth,
    scrollHeight: field.scrollHeight,
    clientHeight: field.clientHeight,
    scrollLeft: field.scrollLeft,
    scrollTop: field.scrollTop,
    lineHeightPx: parseFloat(getComputedStyle(field).lineHeight),
    transform: field.style.transform,
  }))
}

async function expectTwoLinesInView(page: Page): Promise<void> {
  const box = await fit(page)
  expect(box.scrollWidth, 'the box is as wide as its longest line').toBeLessThanOrEqual(box.clientWidth)
  expect(box.scrollHeight, 'the box is as tall as its lines').toBeLessThanOrEqual(box.clientHeight)
  expect(box.clientHeight, 'the box holds both lines').toBeGreaterThanOrEqual(2 * box.lineHeightPx)
  expect([box.scrollLeft, box.scrollTop], 'the start of the text stays in view').toEqual([0, 0])
}

/** Types two lines, the second the longer, as Shift+Enter breaks a line. */
async function typeTwoLines(page: Page): Promise<void> {
  await page.keyboard.type('Gate to the')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('lower orchard and the pond')
}

test('a new note\'s two typed lines stay inside the entry, its start in view', async ({ page }) => {
  await openBaseFixture(page, 'Select')
  await openNewNote(page, 'Text note')
  await typeTwoLines(page)
  await expectTwoLinesInView(page)
})

test('a note edited in place while turned 30° on screen keeps its two lines inside the entry, its start in view', async ({ page }) => {
  await openBaseFixture(page, 'Select')
  // A new note stores the bearing: written at 30°, it is turned 30° once north is up again.
  await designMap(page).focus()
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await openNewNote(page, 'Text note')
  await page.keyboard.type('Gate')
  await page.keyboard.press('Enter')
  await expect(entry(page)).toHaveCount(0)
  await tool(page, 'Select').click()
  await designMap(page).focus()
  await page.keyboard.press('Shift+ArrowUp')

  // Enter under Select edits the one selected note: the new one.
  await page.keyboard.press('Enter')
  await expect(entry(page)).toBeFocused()
  expect((await fit(page)).transform).toBe('rotate(30deg)')
  await page.keyboard.press('End')
  await page.keyboard.type(' to the')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('lower orchard and the pond')
  await expectTwoLinesInView(page)
})

/** Commits a one-line note at the neutral point and arms Select, which leaves the new note selected. */
async function commitNote(page: Page, text: string): Promise<void> {
  await openNewNote(page, 'Text note')
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await expect(entry(page)).toHaveCount(0)
  await tool(page, 'Select').click()
  await expectCanvasDrawn(page)
}

/** The strip of screen the note at the neutral point sits in: its one line, below the rotate handle, short of the plant at (1122, 461). */
const NOTE_STRIP = { x: NEUTRAL.x - 40, y: NEUTRAL.y - 6, width: 320, height: 30 }

/**
 * Expects the selected note's outline (the selection's ochre, #9C5A16) to end within 6 CSS px past its last glyph (the
 * map text's dark ink, #27231D) in the note strip, read from a screenshot's pixels: the outline and the text are drawn
 * in the map's canvas. Only a glyph's core is that dark and grey; the grid's lines, the glyphs' antialiased edges and
 * plants are not.
 */
async function expectOutlineEndsAtLastGlyph(page: Page) {
  const png = await page.screenshot({ clip: NOTE_STRIP })
  const edges = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const { data: pixels, width, height } = context.getImageData(0, 0, canvas.width, canvas.height)
    let outlineRight = -Infinity, lastGlyph = -Infinity
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4
        const [r, g, b] = [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!]
        if (Math.abs(r - 0x9c) < 32 && Math.abs(g - 0x5a) < 32 && Math.abs(b - 0x16) < 32) {
          outlineRight = Math.max(outlineRight, x)
        } else if (Math.max(r, g, b) < 0x50 && Math.max(r, g, b) - Math.min(r, g, b) < 0x18) {
          lastGlyph = Math.max(lastGlyph, x)
        }
      }
    }
    return { outlineRight, lastGlyph }
  }, png.toString('base64'))
  expect(Number.isFinite(edges.outlineRight) && Number.isFinite(edges.lastGlyph), 'the strip shows the outline and the text').toBe(true)
  const pastLastGlyph = edges.outlineRight - edges.lastGlyph
  expect(pastLastGlyph, 'the outline ends at the last glyph drawn').toBeGreaterThanOrEqual(0)
  expect(pastLastGlyph).toBeLessThanOrEqual(6)
}

/** Holds back the interface font's face for one character subset until the returned release is called. */
async function holdFace(page: Page, subset: string): Promise<() => void> {
  let release = (): void => {}
  const arrived = new Promise<void>((resolve) => { release = resolve })
  await page.route(`**/source-sans-3-${subset}-400-normal*.woff2`, async (route: Route) => {
    await arrived
    await route.continue()
  })
  return release
}

/** The middle of the selected note's frame, as screen x, read from the rotate handle above it. */
async function frameMiddle(page: Page): Promise<number> {
  return Number(await page.locator('[data-canvas-handle="rotate"]').getAttribute('data-canvas-handle-screen-x'))
}

const HAZELNUT = 'Hazelnut hedge, prune in February'
/** 'Reservoir': one word, since a space is in the Latin face's range. */
const RESERVOIR = 'Водохранилище'

test('a committed note\'s selection outline ends within 6 px of its last glyph', async ({ page }) => {
  await openBaseFixture(page, 'Select')
  await commitNote(page, HAZELNUT)
  await expectOutlineEndsAtLastGlyph(page)
})

test('a note drawn before its web font arrives is measured and drawn again once the font has loaded', async ({ page }) => {
  // WebKit reports a face still loading under font-display: swap as failed (FontFace.status 'error', so fonts.check()
  // is true) until it arrives; the note is measured again all the same.
  // The interface font's Latin face is held back until the note has been drawn in a fallback font. A screenshot waits
  // for fonts, so until then the frame is read from the rotate handle, which sits above the middle of the note's frame.
  const release = await holdFace(page, 'latin')
  await openBaseFixture(page, 'Select', 'domcontentloaded')
  await commitNote(page, HAZELNUT)
  const fallbackMiddle = await frameMiddle(page)

  // Whether the frame widens or narrows depends on the fallback the host has (Noto Sans and DejaVu Sans are wider).
  release()
  await expect.poll(() => frameMiddle(page), 'the frame follows the loaded font').not.toBe(fallbackMiddle)
  // Pixi keeps a text's raster while its text and style stay the same: the glyphs are drawn again in the loaded font.
  await expectOutlineEndsAtLastGlyph(page)
})

test('a Cyrillic note measured while a Latin note waits for the same font is measured again once its face arrives', async ({ page }) => {
  // The interface font's faces cover character ranges (src/styles/fonts.css). Its Latin face is held back, so the
  // opened Design's Latin notes wait for the font, while a Cyrillic note is committed and measured in a fallback; then
  // the Cyrillic face arrives, the Latin one still held back.
  const releaseLatin = await holdFace(page, 'latin')
  const releaseCyrillic = await holdFace(page, 'cyrillic')
  await openBaseFixture(page, 'Select', 'domcontentloaded')
  await commitNote(page, RESERVOIR)
  const fallbackMiddle = await frameMiddle(page)

  releaseCyrillic()
  await expect.poll(() => frameMiddle(page), 'the frame follows the Cyrillic face').not.toBe(fallbackMiddle)
  releaseLatin()
  await expectOutlineEndsAtLastGlyph(page)
})

for (const { locale, selectTool, textTool, placeholder } of [
  { locale: 'ru', selectTool: 'Выделение', textTool: 'Текстовая заметка', placeholder: 'Введите заметку' },
  { locale: 'ja', selectTool: '選択', textTool: 'テキストメモ', placeholder: 'メモを入力' },
]) {
  test(`an empty note entry shows its whole placeholder in ${locale}`, async ({ page }) => {
    await page.addInitScript((chosen) => {
      // The Web Edition's settings record (web/browser-app-data.ts), with the language chosen.
      localStorage.setItem('canopi:web-app-data:v3:settings', JSON.stringify({ version: 3, settings: { locale: chosen } }))
    }, locale)
    await openBaseFixture(page, selectTool)
    await openNewNote(page, textTool)
    await expect(entry(page)).toHaveAttribute('placeholder', placeholder)
    // The placeholder's width in the field's own font and padding, measured beside it.
    const { needed, shown } = await entry(page).evaluate((field: HTMLTextAreaElement) => {
      const style = getComputedStyle(field)
      const mirror = document.createElement('span')
      mirror.textContent = field.placeholder
      Object.assign(mirror.style, {
        position: 'absolute', visibility: 'hidden', whiteSpace: 'pre',
        font: style.font, letterSpacing: style.letterSpacing,
        paddingLeft: style.paddingLeft, paddingRight: style.paddingRight,
      })
      document.body.append(mirror)
      const width = mirror.getBoundingClientRect().width
      mirror.remove()
      return { needed: width, shown: field.clientWidth }
    })
    expect(needed, 'the whole placeholder fits the field').toBeLessThanOrEqual(shown + 0.5)
  })
}
