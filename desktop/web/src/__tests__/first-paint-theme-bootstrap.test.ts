// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Each edition's entry page (relative to desktop/web, where vitest runs), read as markup, which is data: the bootstrap
// script runs before the module entry.
const HTML_ENTRIES = [
  ['Desktop', 'index.html'],
  ['Web', 'web.html'],
] as const

describe('first-paint theme bootstrap', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(HTML_ENTRIES)(
    'applies valid cached themes before the %s module entry',
    (_edition, entryPage) => {
      const entry = readEntryBootstrap(entryPage)

      expect(entry.bootstrapIndex).toBeGreaterThanOrEqual(0)
      expect(entry.moduleEntryIndex).toBeGreaterThan(entry.bootstrapIndex)
      for (const cachedTheme of ['light', 'dark'] as const) {
        document.documentElement.removeAttribute('data-theme')
        localStorage.setItem('canopi:first-paint-theme', cachedTheme)
        executeBootstrap(entry.code)
        expect(document.documentElement.getAttribute('data-theme')).toBe(cachedTheme)
      }
    },
  )

  it.each(HTML_ENTRIES)(
    'ignores an invalid cached theme in the %s entry',
    (_edition, entryPage) => {
      localStorage.setItem('canopi:first-paint-theme', 'sepia')

      executeBootstrap(readEntryBootstrap(entryPage).code)

      expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    },
  )

  it.each(HTML_ENTRIES)(
    'continues parsing the %s entry when theme cache access is denied',
    (_edition, entryPage) => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('storage denied')
      })

      expect(() => executeBootstrap(readEntryBootstrap(entryPage).code)).not.toThrow()
    },
  )
})

function readEntryBootstrap(entryPage: string): {
  readonly bootstrapIndex: number
  readonly code: string
  readonly moduleEntryIndex: number
} {
  const source = readFileSync(entryPage, 'utf8')
  const entryDocument = new DOMParser().parseFromString(source, 'text/html')
  const scripts = Array.from(entryDocument.scripts)
  const bootstrapIndex = scripts.findIndex((script) => (
    script.textContent?.includes('canopi:first-paint-theme') ?? false
  ))
  return {
    bootstrapIndex,
    code: scripts[bootstrapIndex]?.textContent ?? '',
    moduleEntryIndex: scripts.findIndex((script) => script.type === 'module'),
  }
}

function executeBootstrap(code: string): void {
  Function(code)()
}
