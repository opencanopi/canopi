import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import coverageFamily from '../../../../policy/ratchets/coverage.json'

// Where the policy families' values reach the tools that enforce them (2.1-M217).
describe('policy wiring', () => {
  it('refuses a check.mjs flag it does not read before running any check, so a mistyped flag never starts the full check', () => {
    const checker = new URL('../../../../policy/check.mjs', import.meta.url).pathname
    const run = spawnSync(process.execPath, [checker, '--help'], { encoding: 'utf8', timeout: 20_000 })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('reads no --help')
    expect(run.stdout).not.toContain('policy check:')
    const equals = spawnSync(process.execPath, [checker, '--phase-close=0'], { encoding: 'utf8', timeout: 20_000 })
    expect(equals.status).toBe(1)
    expect(equals.stderr).toContain('reads no --phase-close=0')
    const known = spawnSync(process.execPath, [checker, '--closed-beads', '--lane', 'push'], { encoding: 'utf8', timeout: 20_000 })
    expect(known.stderr).not.toContain('reads no')
    expect(known.stderr, 'a known flag in a mode it cannot join is a mode conflict (canopi-f47t.52.228.54)').toContain('mode-conflict')
  })

  it('runs vitest coverage over the include, exclusions and floors of policy/ratchets/coverage.json (2.1-M217)', async () => {
    vi.resetModules()
    const planted = { include: ['planted/**'], exclude: ['planted/x.ts'], floors: { statements: 1, branches: 2, functions: 3, lines: 4 } }
    vi.doMock('../../../../policy/ratchets/coverage.json', () => ({ default: { floors: { vitest: planted } } }))
    try {
      const { default: config } = await import('../../vite.config')
      const resolved = typeof config === 'function' ? await config({ command: 'serve', mode: 'test' }) : config
      expect(resolved.test?.coverage).toMatchObject({ include: planted.include, exclude: planted.exclude, thresholds: planted.floors })
    } finally {
      vi.doUnmock('../../../../policy/ratchets/coverage.json')
      vi.resetModules()
    }
  }, 60_000)

  it('holds the checked-in vitest coverage to the family as it stands, not to a copy (2.1-M217)', async () => {
    const { default: config } = await import('../../vite.config')
    const resolved = typeof config === 'function' ? await config({ command: 'serve', mode: 'test' }) : config
    const { include, exclude, floors } = coverageFamily.floors.vitest
    expect(resolved.test?.coverage).toMatchObject({ include, exclude, thresholds: floors })
  }, 60_000)

})


// Vite's glob plugin reads import.meta.glob's arguments as literals; a Stryker mutant of them breaks the parse of every
// module importing the file, so each call opts out of mutation on its line (canopi-f47t.52.228).
it('keeps Stryker off every import.meta.glob in application code', () => {
  const src = new URL('..', import.meta.url).pathname
  const files = (readdirSync(src, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && !/(^|\/)__tests__\/|\.test\.tsx?$|\.d\.ts$|^generated\//.test(f))
  const unguarded = files.flatMap((file) => {
    const lines = readFileSync(join(src, file), 'utf8').split('\n')
    return lines.flatMap((line, i) => /import\.meta\.glob\b/.test(line) && !/^\s*\/\/ Stryker disable next-line all\b/.test(lines[i - 1] ?? '') ? [`${file}:${i + 1}`] : [])
  })
  expect(files.length).toBeGreaterThan(100)
  expect(unguarded).toEqual([])
})
