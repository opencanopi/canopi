import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface PackageJson {
  engines: { node: string }
  devDependencies: Record<string, string>
}

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as PackageJson

describe('the Node type surface', () => {
  // Tests and the configs they import run on Node and type-check against @types/node; left to a peer range it floats to
  // the newest major, so an API the engines floor lacks type-checks and fails in CI (2.1-M220).
  it('pins @types/node to the engines floor', () => {
    const floor = /^\^(\d+\.\d+)\.\d+$/.exec(pkg.engines.node)?.[1]
    expect(floor).toBeDefined()
    expect(pkg.devDependencies['@types/node']).toBe(`~${floor}.0`)
  })
})
