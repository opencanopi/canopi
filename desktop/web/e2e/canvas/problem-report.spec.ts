// Web's Report a problem (2.1-Q60, Q283; canopi-f47t.52.36): Help › Report a problem opens the dialog, and Create
// report downloads one zip, the browser's sections and a manifest, without the Design unless ticked. The zip stores its
// files uncompressed (platform/problem-report.browser.ts), so their names and text read from its bytes.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
const REPORT_NAME = /^canopi-report-\d{8}-\d{6}\.zip$/

async function openFixtureFromStart(page: Page): Promise<void> {
  await page.goto('')
  const open = page.locator('[data-start-screen] button').filter({ hasText: /\.canopi/ }).first()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open.click()])
  await chooser.setFiles(FIXTURE)
  // The Design's title bar, not the map: Firefox in the pinned image has no WebGL, so its map never draws.
  await expect(page.locator('[data-workspace-title-bar] [data-save-status]')).toBeVisible()
}

async function openReportDialog(page: Page) {
  await page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'Help', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Report a problem…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Report a problem' })
  await expect(dialog).toBeVisible()
  return dialog
}

async function createReport(page: Page, dialog: Awaited<ReturnType<typeof openReportDialog>>): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Create report', exact: true }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(REPORT_NAME)
  return readFileSync(await download.path(), 'latin1')
}

test('Help › Report a problem downloads one zip of the browser\'s sections, without the Design unless ticked', async ({ page }) => {
  await openFixtureFromStart(page)
  const dialog = await openReportDialog(page)
  // Web lists only the sections a browser has, and names where to send the zip (2.1-Q279, Q280).
  await expect(dialog.getByText('Waiting and running background work, by count and time.')).toHaveCount(0)
  await expect(dialog.getByRole('link', { name: 'Open the GitHub issues page' })).toBeVisible()
  await dialog.getByRole('textbox', { name: 'What happened?' }).fill('The map went blank')

  const zip = await createReport(page, dialog)
  expect(zip.startsWith('PK')).toBe(true)
  for (const file of ['description.txt', 'build.json', 'settings.json', 'manifest.json']) expect(zip).toContain(file)
  expect(zip).toContain('The map went blank')
  expect(zip).not.toContain('design.canopi')

  // A download: no folder to show, and nothing names a path (2.1-Q283).
  await expect(dialog.getByText('Report downloaded. Attach the file to your message to support.')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Show again' })).toHaveCount(0)
})
