// Web's Report a problem (2.1-Q60, Q283; canopi-f47t.52.36): Help › Report a problem opens the dialog, and Create
// report downloads one zip, the browser's sections and a manifest, without the Design unless ticked. The zip stores its
// files uncompressed (platform/problem-report.browser.ts), so their names and text read from its bytes.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { openFixtureFromStart } from '../support/layout'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
const REPORT_NAME = /^canopi-report-\d{8}-\d{6}\.zip$/

async function openReportFixture(page: Page): Promise<void> {
  await page.goto('')
  await openFixtureFromStart(page, FIXTURE)
}

async function openReportDialog(page: Page) {
  await page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'Help', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Report a problem…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Report a problem' })
  await expect(dialog).toBeVisible()
  return dialog
}

async function createReportBytes(page: Page, dialog: Awaited<ReturnType<typeof openReportDialog>>): Promise<Buffer> {
  const [download] = await Promise.all([
    // A report downloads within seconds; a writer that refuses shows its error and never downloads.
    page.waitForEvent('download', { timeout: 30_000 }),
    dialog.getByRole('button', { name: 'Create report', exact: true }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(REPORT_NAME)
  return readFileSync(await download.path())
}

function readStoredZipEntry(zip: Buffer, targetName: string): string {
  // Local file header: PK\x03\x04 (30 bytes) + filename + extra + uncompressed STORE payload.
  let offset = 0
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18)
    const nameLen = zip.readUInt16LE(offset + 26)
    const extraLen = zip.readUInt16LE(offset + 28)
    const name = zip.subarray(offset + 30, offset + 30 + nameLen).toString('utf8')
    const dataStart = offset + 30 + nameLen + extraLen
    const dataEnd = dataStart + compressedSize
    if (name === targetName) return zip.subarray(dataStart, dataEnd).toString('utf8')
    offset = dataEnd
  }
  throw new Error(`Entry ${targetName} not found in zip`)
}

async function createReport(page: Page, dialog: Awaited<ReturnType<typeof openReportDialog>>): Promise<string> {
  return (await createReportBytes(page, dialog)).toString('latin1')
}

test('Help › Report a problem downloads one zip of the browser\'s sections, without the Design unless ticked', async ({ page }) => {
  await openReportFixture(page)
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
  await expect(dialog.getByText('Report downloaded. The zip is in your browser’s downloads.')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Show again' })).toHaveCount(0)
})

test('canopi-f47t.52.36: Include current Design ticked puts the open Design in the Web report', async ({ page }) => {
  await openReportFixture(page)
  const dialog = await openReportDialog(page)
  await dialog.getByRole('checkbox', { name: /Include current Design/ }).check()

  const zipBytes = await createReportBytes(page, dialog)
  expect(zipBytes.toString('latin1')).toContain('design.canopi')
  // DesignCore emits canonical compact JSON (2.1-Q359): parse the attachment and verify the fixture's species code.
  const attachedDesign = JSON.parse(readStoredZipEntry(zipBytes, 'design.canopi')) as {
    plant_species_codes?: Record<string, string>
  }
  expect(attachedDesign.plant_species_codes?.['Corylus avellana']).toBe('CAV')
  await expect(dialog.getByText('No current Design is available to attach.')).toHaveCount(0)
})
