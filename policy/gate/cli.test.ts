// The gate's entry (2.1-Q267; design check A9, AR24): a Node below the engines major refuses in one line before any
// other module loads, and the command line takes only its modes.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { engineRefusal } from './engines.ts'
import { PlantedRepo } from './planted-repo.ts'

let repo: PlantedRepo
beforeEach(() => { repo = new PlantedRepo() })
afterEach(() => repo.cleanup())

const engines = (node: string | undefined) => {
  const file = join(repo.repo, 'desktop/web/package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as { engines?: { node?: string } }
  writeFileSync(file, JSON.stringify({ ...manifest, engines: node === undefined ? undefined : { node } }))
}

describe('the engines Node (design check A9)', () => {
  it('wrong Node: a Node below the engines major refuses in one line, in every mode', () => {
    engines('>=99')
    for (const args of [['areas', '--base', repo.base], ['full', '--print'], ['agents-rows', '--check'], ['nonsense']]) {
      const run = repo.gate(args)
      expect([run.status, run.stdout], args.join(' ')).toEqual([1, ''])
      expect(run.stderr).toBe(`gate: Node 99 is required (engines); found ${process.version}\n`)
    }
  })

  it('wrong Node: an unreadable or rangeless engines file refuses naming it', () => {
    engines(undefined)
    expect(repo.gate(['full', '--print']).stderr).toBe('gate: desktop/web/package.json names no engines.node major\n')
    rmSync(join(repo.repo, 'desktop/web/package.json'))
    expect(repo.gate(['full', '--print']).stderr)
      .toBe('gate: desktop/web/package.json cannot be read for the engines Node (ENOENT)\n')
  })

  it('reads the major from the range and lets an equal or newer Node run', () => {
    const root = repo.repo
    engines('>=24.11')
    expect(engineRefusal('v24.0.0', root)).toBeUndefined()
    expect(engineRefusal('v25.1.0', root)).toBeUndefined()
    expect(engineRefusal('v22.22.0', root)).toBe('Node 24 is required (engines); found v22.22.0')
  })
})

describe('the command line', () => {
  it('refuses an unknown mode or flag with the usage and exit 2', () => {
    for (const args of [[], ['nonsense'], ['affected'], ['affected', '--staged', '--base', 'x'], ['full', '--areas', 'x'],
      ['areas'], ['actionlint', 'x'], ['agents-rows', '--fix']]) {
      const run = repo.gate(args)
      expect(run.status, args.join(' ')).toBe(2)
      expect(run.stderr).toContain('usage: node policy/gate/cli.ts affected (--base <rev> | --staged) [--print]')
    }
  })

  it('prints each check with a stable id', () => {
    const ids = repo.printed(['full', '--area', 'docs']).checks.map((check) => check.id)
    expect(ids).toEqual(['docs', 'docs-drift', 'docs-tests'])
  })
})
