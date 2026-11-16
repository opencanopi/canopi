// Phase 2 commit 0: 2.1-Q359's decimal SI byte sizes for story images, written before 2a-3 builds them (it.fails
// until then): 1,500,000 bytes read 1.5 MB, not the binary 1.4. 2a-3 turns it.fails into it.

import { describe, expect, it } from 'vitest'
import { formatImageBytes } from './images'

describe('2.1-Q359 byte sizes of story images', () => {
  it.fails('Q359 (2a-3): an image of 1,500,000 bytes reads 1.5 MB', () => {
    expect(formatImageBytes(1_500_000, 'en')).toBe('1.5 MB')
  })
})
