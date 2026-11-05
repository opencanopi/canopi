// The Rust row's coverage run (ADR 0028 Coverage; A20): the real CLI's `cov` mode in a planted repository builds the
// cargo-llvm-cov command from policy/ratchets/coverage.json, its one home, the cargo shim recording what it runs.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { git, PlantedRepo } from './planted-repo.ts'

const FAMILY = 'policy/ratchets/coverage.json'
const floors = (cargo: unknown) => `${JSON.stringify({ family: 'coverage', floors: { vitest: { floors: { lines: 1 } }, ...cargo as object } }, null, 2)}\n`

let repo: PlantedRepo
beforeEach(() => { repo = new PlantedRepo({ packages: false }) })
afterEach(() => repo.cleanup())

describe('cov: cargo-llvm-cov with the floors of policy/ratchets/coverage.json (canopi-f47t.52.240)', () => {
  it('canopi-f47t.52.240: cov runs cargo llvm-cov over the workspace with the family\'s exclusion and every floor', () => {
    repo.write({ [FAMILY]: floors({ 'cargo-llvm-cov': { exclude: ['(^|/)a\\.rs$'], floors: { lines: 50.5, functions: 40, regions: 45 } } }) })
    const run = repo.gate(['cov'])
    expect(run.status, run.stderr).toBe(0)
    expect(repo.calls()).toEqual(['cargo llvm-cov --workspace --locked --summary-only --ignore-filename-regex (^|/)a\\.rs$ '
      + '--fail-under-lines 50.5 --fail-under-functions 40 --fail-under-regions 45 offline=unset'])
  })

  it('canopi-f47t.52.240: cov refuses a family holding no cargo-llvm-cov floor, running no cargo', () => {
    repo.write({ [FAMILY]: floors({}) })
    const run = repo.gate(['cov'])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`${FAMILY} holds no cargo-llvm-cov floor`)
    expect(repo.calls()).toEqual([])
  })

  it('canopi-f47t.52.240: cancelled: an interrupted cov exits 130 and leaves the floors unchanged', async () => {
    const text = floors({ 'cargo-llvm-cov': { exclude: [], floors: { lines: 50 } } })
    repo.write({ [FAMILY]: text })
    const child = spawn(process.execPath, ['policy/gate/cli.mjs', 'cov'], {
      cwd: repo.repo, env: repo.env({ SHIM_SLOW_CARGO: '1' }), stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve))
    const deadline = Date.now() + 20_000
    while (!repo.calls().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    const before = git(repo.repo, 'status', '--porcelain', '--ignored')
    child.kill('SIGINT')
    expect(await exited).toBe(130)
    expect(readFileSync(join(repo.repo, FAMILY), 'utf8')).toBe(text)
    expect(git(repo.repo, 'status', '--porcelain', '--ignored')).toBe(before)
  })
})
