import { afterEach, describe, expect, it, vi } from 'vitest'
import { webServersFor } from '../../playwright.config'

const ports = (argv: string[]) => webServersFor(argv).map((server) => new URL(server.url).port)

/** Every place the browser checks name a port, read after the environment is set (modules read it on import). */
async function e2eOrigins() {
  vi.resetModules()
  const config = await import('../../playwright.config')
  const gallery = await import('../../e2e/support/gallery')
  const persistence = await import('../../e2e/support/storage-persistence')
  const galleryVite = (await import('../../ui-gallery/vite.config')).default
  const projectURL = (name: string) => config.default.projects?.find((project) => project.name === name)?.use?.baseURL
  return {
    servers: config.webServersFor(['node', 'playwright', 'test']).map((server) => new URL(server.url).port),
    baseURL: new URL(config.default.use?.baseURL ?? '').port,
    galleryBaseURLs: ['gallery-chromium', 'gallery-webkit'].map((name) => new URL(projectURL(name) ?? '').port),
    galleryOrigin: new URL(gallery.GALLERY_ORIGIN).port,
    appOrigin: new URL(persistence.APP_ORIGIN).port,
    galleryViteServer: String(galleryVite.server?.port),
  }
}

describe('Playwright web servers', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('starts only the servers the chosen projects use', () => {
    // The gallery lane never needs the built Web Edition, and the canvas lane never optimises the gallery.
    expect(ports(['node', 'playwright', 'test', 'e2e/gallery', '--project=gallery-chromium', '--project', 'gallery-webkit']))
      .toEqual(['1422'])
    expect(ports(['node', 'playwright', 'test', 'e2e/canvas', '--project=chromium', '--project=webkit'])).toEqual(['4174'])
    expect(ports(['node', 'playwright', 'test', 'e2e/canvas', '--project=firefox'])).toEqual(['4174'])
    expect(ports(['node', 'playwright', 'test', '--project=chromium', '--project=gallery-webkit'])).toEqual(['4174', '1422'])
    expect(ports(['node', 'playwright', 'test'])).toEqual(['4174', '1422'])
  })

  it('canopi-f47t.52.228.10 (F3b c3): takes both ports from CANOPI_E2E_WEB_PORT and CANOPI_E2E_GALLERY_PORT', async () => {
    // scripts/gate.py gives each worktree its own pair, so two worktrees' browser runs never share a server.
    vi.stubEnv('CANOPI_E2E_WEB_PORT', '5174')
    vi.stubEnv('CANOPI_E2E_GALLERY_PORT', '5422')
    expect(await e2eOrigins()).toEqual({
      servers: ['5174', '5422'],
      baseURL: '5174',
      galleryBaseURLs: ['5422', '5422'],
      galleryOrigin: '5422',
      appOrigin: '5174',
      galleryViteServer: '5422',
    })
  })

  it('canopi-f47t.52.228.10: keeps 4174 and 1422 with the environment unset (npm run dev:ui stays on 1422)', async () => {
    vi.stubEnv('CANOPI_E2E_WEB_PORT', undefined)
    vi.stubEnv('CANOPI_E2E_GALLERY_PORT', undefined)
    expect(await e2eOrigins()).toEqual({
      servers: ['4174', '1422'],
      baseURL: '4174',
      galleryBaseURLs: ['1422', '1422'],
      galleryOrigin: '1422',
      appOrigin: '4174',
      galleryViteServer: '1422',
    })
  })

  it('canopi-f47t.52.228.10: refuses a port that is not a number', async () => {
    vi.stubEnv('CANOPI_E2E_WEB_PORT', 'eighty')
    vi.resetModules()
    await expect(import('../../e2e/support/ports')).rejects.toThrow('CANOPI_E2E_WEB_PORT')
  })
})
