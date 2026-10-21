import { describe, expect, it } from 'vitest'
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
})
