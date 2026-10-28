// The Windows real-app harness reads WebView2's DevTools port from its DevToolsActivePort file while WebView2 may
// still be writing it (F5 probe 5): only a file with both lines written gives a port.
import { describe, expect, it } from 'vitest'
import { devToolsPortIn } from '../../e2e/platform/support/devtools-port'

describe('devToolsPortIn', () => {
  it('reads the port once the port and browser path lines are written', () => {
    expect(devToolsPortIn('9222\n/devtools/browser/abc\n')).toBe(9222)
    expect(devToolsPortIn('9222\r\n/devtools/browser/abc')).toBe(9222)
  })

  it('gives no port while the file is empty or holds only the first line', () => {
    expect(devToolsPortIn('')).toBeUndefined()
    expect(devToolsPortIn('9222')).toBeUndefined()
    expect(devToolsPortIn('9222\n')).toBeUndefined()
    expect(devToolsPortIn('9222\n   ')).toBeUndefined()
  })

  it('gives no port when the first line is not a positive integer', () => {
    expect(devToolsPortIn('0\n/devtools/browser/abc')).toBeUndefined()
    expect(devToolsPortIn('-1\n/devtools/browser/abc')).toBeUndefined()
    expect(devToolsPortIn('92.5\n/devtools/browser/abc')).toBeUndefined()
    expect(devToolsPortIn('port\n/devtools/browser/abc')).toBeUndefined()
  })
})
