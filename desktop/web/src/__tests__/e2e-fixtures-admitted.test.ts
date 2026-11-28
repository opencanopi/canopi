// Every Design the browser checks open (`e2e/fixtures/*.canopi`) is one the current format admits, so a format change that
// would refuse a fixture fails here, in the Frontend gate, before the browser checks run (V11).
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeCanopiDesign } from './support/design-wire'

const FIXTURES = 'e2e/fixtures'
const designs = readdirSync(FIXTURES).filter((name) => name.endsWith('.canopi'))

describe('e2e fixtures', () => {
  it('include Designs', () => expect(designs.length).toBeGreaterThan(0))

  it.each(designs)('%s opens in this build', (name) => {
    const raw = JSON.parse(readFileSync(`${FIXTURES}/${name}`, 'utf8')) as unknown
    expect(() => decodeCanopiDesign(raw)).not.toThrow()
  })
})
