import { describe, expect, it } from 'vitest'

import { resolveWebEditionDevHtmlUrl } from '../web/dev-entry'

describe('Web Edition development entry', () => {
  it('redirects root and index requests to web.html while preserving the query (2.1-Q85)', () => {
    expect(resolveWebEditionDevHtmlUrl('/')).toBe('/web.html')
    expect(resolveWebEditionDevHtmlUrl('/index.html?from=test')).toBe('/web.html?from=test')
    expect(resolveWebEditionDevHtmlUrl('/web.html')).toBeNull()
    expect(resolveWebEditionDevHtmlUrl('/app/')).toBeNull()
  })
})
