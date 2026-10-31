// Engine contract for the Draft persistence request (2.1-Q82, Step 2.0.3 persist, commit 0's probe, kept). It drives no
// app: a blank page on the preview origin (localhost is a secure context) asks each engine directly, so a Playwright or
// browser bump that changes an answer, or breaks a forcing method of support/storage-persistence.ts, fails here first.
// Measured 2026-10-22 in mcr.microsoft.com/playwright:v1.64.1-noble:
// - all three: secure context, navigator.storage.persist and persisted present, persisted() false at first; persist()
//   in a click leaves the same click's file chooser working (Open asks for persistence, then for a file).
// - Chromium: persist() false with or without a click; permissions.query('persistent-storage') answers 'prompt';
//   granted through CDP reads 'granted' and persisted() true; a CDP denial reads 'denied'.
// - Firefox: persist() stays pending with or without a click (its prompt, unanswered); permissions.query answers;
//   the prompt test prefs grant and refuse.
// - WebKit: persist() false with or without a click; permissions.query throws a TypeError; granted is a stub only.
// Chromium, WebKit and Firefox (the `firefox` project, 2.1-Q196).
import type { Page } from '@playwright/test'
import { expect, test } from '../support/offline'
import {
  APP_ORIGIN,
  denyInChromium,
  pageWithDefaultAnswer,
  pageWithPersistence,
  racePersist,
  type PersistenceAnswer,
} from '../support/storage-persistence'

const PROBE_URL = `${APP_ORIGIN}/storage-persistence-probe.html`
const PROBE_PAGE = '<!doctype html><html><body><button id="ask">Ask</button><input id="file" type="file"></body></html>'

async function openProbe(page: Page): Promise<void> {
  await page.route(PROBE_URL, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PROBE_PAGE }))
  await page.goto(PROBE_URL)
}

async function readShape(page: Page) {
  return await page.evaluate(async () => {
    let query: string
    try {
      query = (await navigator.permissions.query({ name: 'persistent-storage' as PermissionName })).state
    } catch (error) {
      query = `threw ${(error as Error).name}`
    }
    return {
      secure: isSecureContext,
      persist: typeof navigator.storage?.persist,
      persisted: await navigator.storage.persisted(),
      query,
    }
  })
}

/** persist() called inside a real click's task, raced against 3 s. */
async function persistInClick(page: Page): Promise<string> {
  await page.evaluate(() => {
    document.getElementById('ask')!.addEventListener('click', () => {
      ;(window as unknown as { __asked: Promise<string> }).__asked = Promise.race([
        navigator.storage.persist().then((value) => `settled:${value}`, (error: Error) => `rejected:${error.name}`),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 3000)),
      ])
    }, { once: true })
  })
  await page.click('#ask')
  return await page.evaluate(() => (window as unknown as { __asked: Promise<string> }).__asked)
}

const DEFAULT_ANSWER: Record<string, string> = { chromium: 'settled:false', webkit: 'settled:false', firefox: 'pending' }
const QUERY: Record<string, string> = { chromium: 'prompt', webkit: 'threw TypeError', firefox: 'prompt' }

test('probe: each engine offers persist() in a secure context and has persisted nothing at first', async ({ page, browserName }, testInfo) => {
  const probe = await pageWithDefaultAnswer({ page, browserName, testInfo })
  try {
    await openProbe(probe.page)
    expect(await readShape(probe.page)).toEqual({ secure: true, persist: 'function', persisted: false, query: QUERY[browserName] })
  } finally {
    await probe.close()
  }
})

test('probe: unforced, Chromium and WebKit refuse and Firefox leaves the prompt pending, with or without a click', async ({ page, browserName }, testInfo) => {
  const probe = await pageWithDefaultAnswer({ page, browserName, testInfo })
  try {
    await openProbe(probe.page)
    expect(await racePersist(probe.page), 'without user activation').toBe(DEFAULT_ANSWER[browserName])
    expect(await persistInClick(probe.page), 'in a click').toBe(DEFAULT_ANSWER[browserName])
    expect((await readShape(probe.page)).persisted).toBe(false)
  } finally {
    await probe.close()
  }
})

for (const answer of ['granted', 'refused'] as const satisfies readonly PersistenceAnswer[]) {
  test(`probe: forced ${answer}, persist() in a click answers ${answer === 'granted'} and persisted() agrees`, async ({ page, browserName }, testInfo) => {
    const probe = await pageWithPersistence({ page, browserName, testInfo }, answer)
    try {
      await openProbe(probe.page)
      await probe.armAnswer()
      expect(await persistInClick(probe.page)).toBe(`settled:${answer === 'granted'}`)
      expect((await readShape(probe.page)).persisted).toBe(answer === 'granted')
      expect(await probe.page.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls), 'the spy counted the call').toBe(1)
      expect(probe.errors).toEqual([])
    } finally {
      await probe.close()
    }
  })
}

test('probe: Chromium reads a denied permission as denied, and persist() refuses', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Only Chromium can set the permission to denied (CDP)')
  await openProbe(page)
  await denyInChromium(page)
  expect(await readShape(page)).toMatchObject({ persisted: false, query: 'denied' })
  expect(await racePersist(page)).toBe('settled:false')
})

test('probe: persist() in a click leaves that click able to open a file chooser', async ({ page, browserName }, testInfo) => {
  const probe = await pageWithDefaultAnswer({ page, browserName, testInfo })
  try {
    await openProbe(probe.page)
    await probe.page.evaluate(() => {
      document.getElementById('ask')!.addEventListener('click', () => {
        void navigator.storage.persist()
        setTimeout(() => document.getElementById('file')!.click(), 0)
      }, { once: true })
    })
    const [chooser] = await Promise.all([probe.page.waitForEvent('filechooser'), probe.page.click('#ask')])
    expect(chooser.isMultiple()).toBe(false)
  } finally {
    await probe.close()
  }
})
