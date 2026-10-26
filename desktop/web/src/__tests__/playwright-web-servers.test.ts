import { describe, expect, it, vi } from 'vitest'
import { webServersFor } from '../../playwright.config'

const ports = (argv: string[]) => webServersFor(argv).map((server) => new URL(server.url).port)

describe('Playwright web servers', () => {
  it('starts only the servers the chosen projects use', () => {
    // The gallery lane never needs the built Web Edition, and the canvas lane never optimises the gallery.
    expect(ports(['node', 'playwright', 'test', 'e2e/gallery', '--project=gallery-chromium', '--project', 'gallery-webkit']))
      .toEqual(['1422'])
    expect(ports(['node', 'playwright', 'test', 'e2e/canvas', '--project=chromium', '--project=webkit'])).toEqual(['4174'])
    expect(ports(['node', 'playwright', 'test', 'e2e/canvas', '--project=firefox'])).toEqual(['4174'])
    expect(ports(['node', 'playwright', 'test', '--project=chromium', '--project=gallery-webkit'])).toEqual(['4174', '1422'])
    expect(ports(['node', 'playwright', 'test'])).toEqual(['4174', '1422'])
  })

  // Expected failure until F3b chunk 3 reads the ports from the environment (canopi-f47t.52.228.10).
  it.fails('canopi-f47t.52.228.10 (F3b c3): takes both ports from CANOPI_E2E_WEB_PORT and CANOPI_E2E_GALLERY_PORT', async () => {
    vi.stubEnv('CANOPI_E2E_WEB_PORT', '5174')
    vi.stubEnv('CANOPI_E2E_GALLERY_PORT', '5422')
    try {
      vi.resetModules()
      const config = await import('../../playwright.config')
      expect(config.webServersFor(['node', 'playwright', 'test']).map((server) => new URL(server.url).port))
        .toEqual(['5174', '5422'])
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
