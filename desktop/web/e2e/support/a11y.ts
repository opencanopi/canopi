// The accessibility surface table (ADR 0029 Accessibility, 2.1-M214): one row per Web Edition surface, each with the
// steps that open it, the user paths its checks cover, the region axe and the ARIA snapshot read, and its keyboard-only
// flow. e2e/canvas/a11y.spec.ts drives every row in Chromium, WebKit and Firefox: axe writes one report per surface to
// test-results/a11y/<engine>/<surface>.json beside the engine's manifest of the table's ids (manifest.json), which the
// axe family (policy/ratchets/axe.json, policy/adapters/axe.mjs) reads and holds per surface and rule, the most nodes of
// the three engines; the ARIA snapshot is matched against e2e/canvas/a11y.spec.ts-snapshots/<surface>-<engine>.aria.yml
// (per engine: WebKit's user agent gives the Command shortcuts); the keyboard flow presses keys only, never the mouse. A new surface is a new row here; the adapter fails closed on a row
// with no report in any engine.
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'
import { expect } from './offline'
import { openFixture } from './layout'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
/** This build's release, which the edition manifest a focus reads names (canvas/release-notice.spec.ts). */
const OWN_VERSION = (JSON.parse(readFileSync(fileURLToPath(new URL('../../../tauri.conf.json', import.meta.url)), 'utf8')) as { version: string }).version

/** Where each engine's reports go; the CI a11y job uploads it and the a11y-policy job reads it (CANOPI_A11Y_REPORTS). */
export const A11Y_REPORTS = fileURLToPath(new URL('../../test-results/a11y/', import.meta.url))

/** The engines whose reports the axe family needs, every one (policy/adapters/axe.mjs ENGINES). */
export type A11yEngine = 'chromium' | 'webkit' | 'firefox'

export interface A11ySurface {
  readonly id: string
  /** The user paths this surface's checks cover (ADR 0029: "keyboard-only flows for every user path"). */
  readonly paths: readonly string[]
  /** Opens the surface on a fresh page; the mouse may help here, never in `keyboard`. */
  readonly open: (page: Page) => Promise<void>
  /** The region axe and the ARIA snapshot read. */
  readonly root: (page: Page) => Locator
  /** The surface's keyboard-only flow, from the opened surface. */
  readonly keyboard: (page: Page) => Promise<void>
  /**
   * A known bug the keyboard flow finds in some engines: their test is marked to fail, its title naming the owning phase
   * and the bug's own open bead (never a stream task, e2e/canvas/a11y.spec.ts checks), so a fix shows as an unexpected
   * pass and the marker goes.
   */
  readonly keyboardBug?: { readonly owner: string, readonly bead: string, readonly engines: readonly A11yEngine[] }
}

const startScreen = (page: Page) => page.locator('[data-start-screen]')
const menubar = (page: Page) => page.getByRole('menubar', { name: 'Menus' })
const panels = (page: Page) => page.getByRole('navigation', { name: 'Web Edition panels' })
const tool = (page: Page, name: string) => page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name, exact: true })

/**
 * Answers the edition manifest with this build's release: a Tab past the page's last control leaves the page and a
 * Tab back focuses the window, which reads the manifest (web/browser-release-watch.ts); the built preview has none.
 */
export async function routeOwnRelease(page: Page): Promise<void> {
  await page.route('**/app/canopi-web-edition-manifest.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-cache' },
    body: JSON.stringify({ name: 'Canopi Web Edition', version: OWN_VERSION, commit: 'e2e', files: [] }),
  }))
}

async function openStartScreen(page: Page): Promise<void> {
  await routeOwnRelease(page)
  await page.goto('')
  await expect(startScreen(page)).toBeVisible()
}

async function openWorkspace(page: Page): Promise<void> {
  await routeOwnRelease(page)
  await openFixture(page, FIXTURE)
  // The start screen's Open button sits where the tool rail draws: the pointer moves to the top bar's empty middle, so no
  // tooltip shows in the accessibility tree.
  await page.mouse.move(850, 34)
}

async function openMenuItem(page: Page, menu: string, item: string): Promise<void> {
  await menubar(page).getByRole('menuitem', { name: menu, exact: true }).click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

/**
 * Presses `key` (Tab or Shift+Tab) until `target` has the focus, at most `limit` times; fails when it never does. A flow
 * picks the direction that reaches its target inside the page: past the page's last control the focus leaves for the
 * browser's own controls, and Firefox keeps it there.
 */
export async function tabTo(page: Page, target: Locator, key: 'Tab' | 'Shift+Tab' = 'Tab', limit = 80): Promise<void> {
  for (let presses = 0; presses < limit; presses++) {
    if (await target.evaluate((element) => element === document.activeElement && document.hasFocus())) return
    await page.keyboard.press(key)
  }
  await expect(target, `${key} reaches it within ${limit} presses`).toBeFocused()
}

/**
 * A modal dialog's keyboard contract: Tab and Shift+Tab keep the focus inside it, Escape closes it, and the focus goes
 * back to `returnsTo` when it names the control that opened it.
 */
async function expectModalKeyboard(page: Page, dialog: Locator, returnsTo?: Locator): Promise<void> {
  await expect(dialog).toBeVisible()
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let presses = 0; presses < 25; presses++) {
      await page.keyboard.press(key)
      // document.hasFocus: a focus that left for the browser's own controls leaves Firefox's activeElement in place.
      const inside = await dialog.evaluate((element) => element.contains(document.activeElement) && document.hasFocus())
      expect(inside, `${key} ${presses + 1} keeps the focus in the dialog`).toBe(true)
    }
  }
  await page.keyboard.press('Escape')
  await expect(dialog, 'Escape closes the dialog').toBeHidden()
  if (returnsTo) await expect(returnsTo, 'the focus goes back to what opened the dialog').toBeFocused()
}

export const A11Y_SURFACES: readonly A11ySurface[] = [
  {
    id: 'start-screen',
    paths: ['start a Design', 'open a .canopi file', 'reach Settings and the keyboard shortcuts before a Design'],
    open: openStartScreen,
    root: (page) => page.locator('body'),
    async keyboard(page) {
      const settings = startScreen(page).getByRole('button', { name: 'Settings…' })
      await tabTo(page, settings)
      await page.keyboard.press('Enter')
      await expectModalKeyboard(page, page.getByRole('dialog', { name: 'Settings' }), settings)
    },
  },
  {
    id: 'workspace',
    paths: ['choose a tool', 'leave a tool', 'reach the menus'],
    open: openWorkspace,
    root: (page) => page.locator('body'),
    async keyboard(page) {
      await page.keyboard.press('r')
      await expect(tool(page, 'Rectangle zone'), 'R arms Rectangle zone').toHaveAttribute('aria-pressed', 'true')
      await page.keyboard.press('Escape')
      await expect(tool(page, 'Select'), 'Escape returns to Select').toHaveAttribute('aria-pressed', 'true')
      const file = menubar(page).getByRole('menuitem', { name: 'File', exact: true })
      await tabTo(page, file)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('menu', { name: 'File' }), 'Enter opens the menu').toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu', { name: 'File' }), 'Escape closes the menu').toBeHidden()
    },
  },
  {
    id: 'plant-catalog',
    paths: ['open the plant catalog', 'search the plant catalog', 'close a panel'],
    async open(page) {
      await openWorkspace(page)
      await panels(page).getByRole('button', { name: 'Plant catalog' }).click()
      await expect(page.getByRole('region', { name: 'Plant catalog' })).toBeVisible()
    },
    root: (page) => page.getByRole('region', { name: 'Plant catalog' }),
    // In WebKit, Shift+Tab from the panel rail's Plant catalog button leaves the focus on it.
    keyboardBug: { owner: '2a', bead: 'canopi-f47t.52.234', engines: ['webkit'] },
    async keyboard(page) {
      const region = page.getByRole('region', { name: 'Plant catalog' })
      // Typing would load the Web catalog, which this offline suite never serves; reaching the field is the keyboard path.
      // The panel comes before the panel rail, whose button has the focus, in the page's order.
      await tabTo(page, region.getByRole('searchbox', { name: 'Search the plant catalog' }), 'Shift+Tab')
      const close = region.getByRole('button', { name: 'Close panel' })
      await tabTo(page, close, 'Shift+Tab')
      await page.keyboard.press('Enter')
      await expect(region, 'Close panel closes it').toBeHidden()
    },
  },
  {
    id: 'settings',
    paths: ['change a setting'],
    async open(page) {
      await openStartScreen(page)
      await startScreen(page).getByRole('button', { name: 'Settings…' }).click()
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    },
    root: (page) => page.getByRole('dialog', { name: 'Settings' }),
    async keyboard(page) {
      await expectModalKeyboard(page, page.getByRole('dialog', { name: 'Settings' }), startScreen(page).getByRole('button', { name: 'Settings…' }))
    },
  },
  {
    id: 'about',
    paths: ['read the version and the licence'],
    async open(page) {
      await openWorkspace(page)
      await openMenuItem(page, 'Help', 'About Canopi')
      await expect(page.getByRole('dialog', { name: 'About Canopi' })).toBeVisible()
    },
    root: (page) => page.getByRole('dialog', { name: 'About Canopi' }),
    // In Chromium and WebKit, Tab from Close, its one control, leaves the modal dialog for the page's body.
    keyboardBug: { owner: '2a', bead: 'canopi-f47t.52.98', engines: ['chromium', 'webkit'] },
    async keyboard(page) {
      await expectModalKeyboard(page, page.getByRole('dialog', { name: 'About Canopi' }), menubar(page).getByRole('menuitem', { name: 'Help', exact: true }))
    },
  },
  {
    id: 'export',
    paths: ['export a planting plan, GeoJSON or the budget'],
    async open(page) {
      await openWorkspace(page)
      await openMenuItem(page, 'File', 'Export')
      await expect(page.getByRole('menu', { name: 'Export' })).toBeVisible()
    },
    root: (page) => page.getByRole('menu', { name: 'File' }),
    async keyboard(page) {
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu', { name: 'File' })).toBeHidden()
      const file = menubar(page).getByRole('menuitem', { name: 'File', exact: true })
      await tabTo(page, file)
      await page.keyboard.press('Enter')
      const exportItem = page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'Export', exact: true })
      for (let presses = 0; presses < 15 && !(await exportItem.evaluate((element) => element === document.activeElement)); presses++) {
        await page.keyboard.press('ArrowDown')
      }
      await expect(exportItem, 'the arrow keys reach Export').toBeFocused()
      await page.keyboard.press('ArrowRight')
      await expect(page.getByRole('menu', { name: 'Export' }).getByRole('menuitem', { name: 'Planting plan (PDF)…' }), 'ArrowRight opens Export on its first item').toBeFocused()
    },
  },
  {
    id: 'keyboard-shortcuts',
    paths: ['read the keyboard shortcuts'],
    async open(page) {
      await openStartScreen(page)
      await page.getByRole('banner').getByRole('button', { name: 'Keyboard shortcuts' }).click()
      await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
    },
    root: (page) => page.getByRole('dialog', { name: 'Keyboard shortcuts' }),
    async keyboard(page) {
      const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await page.keyboard.press('F1')
      await expectModalKeyboard(page, dialog)
    },
  },
]

/** One surface's axe report: each violated rule with the nodes it names, as policy/adapters/axe.mjs reads it. */
export interface A11yReport {
  readonly surface: string
  readonly engine: A11yEngine
  readonly complete: true
  readonly violations: Readonly<Record<string, number>>
}

/** Writes the engine's manifest: the table's ids, so the adapter refuses a run that left a row without its report. */
export async function writeManifest(engine: A11yEngine): Promise<void> {
  const dir = path.join(A11Y_REPORTS, engine)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify({ engine, surfaces: A11Y_SURFACES.map((s) => s.id) }, null, 2)}\n`)
}

/** Marks the surface's root for axe's include while it runs, so axe reads exactly that element. */
const ROOT_MARK = 'data-a11y-root'

/** Runs axe over the surface's root and writes its report. */
export async function writeAxeReport(page: Page, surface: A11ySurface, engine: A11yEngine): Promise<A11yReport> {
  const root = surface.root(page)
  await root.evaluate((element, mark) => element.setAttribute(mark, ''), ROOT_MARK)
  const results = await new AxeBuilder({ page }).include(`[${ROOT_MARK}]`).analyze()
  await root.evaluate((element, mark) => element.removeAttribute(mark), ROOT_MARK)
  const violations: Record<string, number> = {}
  for (const violation of results.violations) violations[violation.id] = violation.nodes.length
  const report: A11yReport = { surface: surface.id, engine, complete: true, violations }
  const dir = path.join(A11Y_REPORTS, engine)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${surface.id}.json`), `${JSON.stringify(report, null, 2)}\n`)
  return report
}
