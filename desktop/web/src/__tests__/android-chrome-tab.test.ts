// The Android smoke's device and tab (canopi-f47t.52.228.47). Scratch CI run 40893658953 failed at smoke.ts:72 with
// `browserContext.newPage: Cannot read properties of undefined (reading '_page')`: Playwright's newPage on Chrome for
// Android sends Target.createTarget and reads the new tab from the targets it has attached, and Chrome answered before
// its attach event for that tab arrived. The smoke now drives the tab launchBrowser opened (its `am start` about:blank
// tab, waited for when it attaches late) and never creates one; an emulator slow to show up has a named bound.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { DEVICE_WAIT_MS, launchedTab, waitForDevice, type LaunchedContext } from '../../e2e/phones/android/chrome-tab'

const WORKFLOW = new URL('../../../../.github/workflows/phone-smoke.yml', import.meta.url)

/** A clock the sleeps advance, and a device list that is empty until `readyAt` ms. */
function emulator(readyAt: number) {
  let now = 0
  const asked: number[] = []
  return {
    list: () => { asked.push(now); return Promise.resolve(now >= readyAt ? ['emulator-5554'] : []) },
    clock: () => now,
    sleep: (ms: number) => { now += ms; return Promise.resolve() },
    asked,
  }
}

/** A tab that records whether it was brought to the front. */
function tab(url: string) {
  const state = { url, front: false }
  return { state, url: () => state.url, bringToFront: () => { state.front = true; return Promise.resolve() } }
}
type Tab = ReturnType<typeof tab>

/** A browser context holding `open` tabs, whose next tab attaches after `late` (or never). */
function context(open: Tab[], late?: Tab): LaunchedContext<Tab> & { waited: number[] } {
  const waited: number[] = []
  return {
    waited,
    pages: () => open,
    waitForEvent: (_event, { timeout }) => {
      waited.push(timeout)
      return late ? Promise.resolve(late) : Promise.reject(new Error(`Timeout ${timeout}ms exceeded while waiting for event "page"`))
    },
  }
}

describe('the Android smoke\'s device and tab (canopi-f47t.52.228.47)', () => {
  it('busy: an emulator slow to show up is waited for within the named DEVICE_WAIT_MS bound', async () => {
    const slow = emulator(44_000)
    await expect(waitForDevice(slow.list, DEVICE_WAIT_MS, slow.clock, slow.sleep)).resolves.toBe('emulator-5554')
    expect(slow.asked.at(-1)).toBe(44_000)
    const absent = emulator(Infinity)
    await expect(waitForDevice(absent.list, DEVICE_WAIT_MS, absent.clock, absent.sleep)).rejects
      .toThrow(`no Android device answered within DEVICE_WAIT_MS (${DEVICE_WAIT_MS / 1000} s): the emulator did not boot, and the smoke fails rather than skip`)
    expect(absent.clock()).toBeLessThanOrEqual(DEVICE_WAIT_MS + 5_000)
  })

  it('busy: the emulator\'s boot has its own named bound, inside the Android job\'s deadline', () => {
    const { jobs } = parse(readFileSync(WORKFLOW, 'utf8')) as {
      jobs: { android: { 'timeout-minutes': number, steps: { uses?: string, with?: Record<string, unknown> }[] } }
    }
    const runner = jobs.android.steps.find((step) => step.uses?.startsWith('reactivecircus/android-emulator-runner@'))
    const boot = Number(runner?.with?.['emulator-boot-timeout'])
    expect(boot).toBeGreaterThan(0)
    expect(boot).toBeLessThan(jobs.android['timeout-minutes'] * 60 / 2)
  })

  it('canopi-f47t.52.228.47: the smoke drives the about:blank tab Chrome opened at launch, brought to the front, never a created one', async () => {
    const restored = tab('http://localhost:4174/web.html')
    const launched = tab('about:blank')
    const ctx = context([restored, launched])
    await expect(launchedTab(ctx, 30_000)).resolves.toBe(launched)
    expect(launched.state.front).toBe(true)
    expect(ctx.waited).toEqual([])
  })

  it('canopi-f47t.52.228.47: a launch tab that attaches after Chrome connected is waited for, within the bound', async () => {
    const late = tab('about:blank')
    const ctx = context([], late)
    await expect(launchedTab(ctx, 30_000)).resolves.toBe(late)
    expect(ctx.waited).toEqual([30_000])
    expect(late.state.front).toBe(true)
    const never = context([])
    await expect(launchedTab(never, 30_000)).rejects.toThrow('Chrome showed no tab 30 s after launch')
  })
})
