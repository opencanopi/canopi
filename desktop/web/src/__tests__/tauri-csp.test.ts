import { describe, expect, it } from 'vitest'
import originsTableText from '../../../../policy/origins.json?raw'
import tauriConfigText from '../../../tauri.conf.json?raw'

interface OriginsTable {
  readonly desktopCsp: {
    readonly ipc: readonly string[]
    readonly asset: readonly string[]
    readonly directives: Readonly<Record<string, readonly string[]>>
  }
}

function readTauriCsp(): Record<string, string> {
  const config = JSON.parse(tauriConfigText)
  return config.app.security.csp
}

function readOriginsTable(): OriginsTable {
  return JSON.parse(originsTableText) as OriginsTable
}

function directiveTokens(directive: string | undefined): string[] {
  return (directive ?? '').trim().split(/\s+/).filter(Boolean)
}

describe('Tauri CSP', () => {
  it('allows shared blob workers through the WebKit worker-src fallback', () => {
    const csp = readTauriCsp()

    expect(csp['worker-src']).toContain('blob:')
    expect(csp['child-src']).toContain('blob:')
  })

  it('matches the Desktop ipc and asset origins table in policy/origins.json (2.1-M84)', () => {
    const csp = readTauriCsp()
    const origins = readOriginsTable()

    const imgTokens = directiveTokens(csp['img-src'])
    const connectTokens = directiveTokens(csp['connect-src'])

    for (const origin of origins.desktopCsp.asset) {
      expect(imgTokens).toContain(origin)
      expect(connectTokens).toContain(origin)
    }
    for (const origin of origins.desktopCsp.ipc) {
      expect(connectTokens).toContain(origin)
    }
    for (const [directive, expectedTokens] of Object.entries(origins.desktopCsp.directives)) {
      expect(directiveTokens(csp[directive])).toEqual(expectedTokens)
    }
  })
})

describe('Tauri window', () => {
  // Windows' WebView2 drops HTML5 drags inside the page while native file drops are on, so dragging a plant from the
  // catalog or Favorites onto the map would fail there (canopi-f47t.6.2; user, 2026-10-13). Nothing reads native drops.
  it('turns native file drops off so HTML5 drags reach the map on Windows', () => {
    const config = JSON.parse(tauriConfigText)

    expect(config.app.windows.map((window: { dragDropEnabled?: boolean }) => window.dragDropEnabled)).toEqual([false])
  })
})
