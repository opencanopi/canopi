// The iOS session opens Safari on about:blank, never on the app (canopi-f47t.52.261). With the app as Safari's initial
// URL every run loaded it twice, once at session start and once by the spec, and the iPad's start-screen lookups met a
// debugger busy with the double load (run 41753452998). On the planted-page run of run 42046262923 (iPhone 17 Pro) the
// app's start-up load ran under the spec's about:blank and Safari's web content process crashed ("Webpage Crashed"),
// so the debugger stayed busy 90 s and the planted step failed on the wrong message.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Read as text: the config's WebdriverIO types and globals are the e2e/platform project's, not the app's.
const CONFIG = readFileSync(new URL('../../e2e/platform/phones/ios/wdio.ios.conf.ts', import.meta.url), 'utf8')

describe('the iOS session (canopi-f47t.52.261)', () => {
  it('canopi-f47t.52.261: Safari opens on about:blank, so only the spec loads the page it tests', () => {
    const initial = [...CONFIG.matchAll(/^\s*'appium:safariInitialUrl': (.+),$/gmu)].map((match) => match[1])
    expect(initial).toEqual(["'about:blank'"])
  })
})
