// The name a browser check expects a download to carry. Playwright 1.64.1's WebKit reports each space in a download's
// name as an underscore (`Download.suggestedFilename()`; 1.63.0 kept them, and Chromium and Firefox still do), while
// the app names the file the same in every engine. So WebKit is compared with its spaces mapped to underscores; the
// Design name inside the file is checked as written, by the caller.
import { expect, type Download } from '@playwright/test'

export function expectDownloadName(download: Download, name: string): void {
  const engine = download.page().context().browser()?.browserType().name()
  expect(download.suggestedFilename(), `the download's name in ${engine ?? 'this engine'}`)
    .toBe(engine === 'webkit' ? name.replaceAll(' ', '_') : name)
}
