// The docs area's check (`python3 scripts/check_docs.py`, AGENTS.md's Docs row) rerun over an unchanged tree: the same
// findings, budget warnings and exit code, so a rerun after a red reads the change, never the check (canopi-f47t.52.228.54).
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './planted-repo.ts'

const docsCheck = () => {
  const run = spawnSync('python3', ['scripts/check_docs.py'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

describe('the docs check (canopi-f47t.52.228.54)', () => {
  it('retried: a rerun over an unchanged tree gives the same findings, warnings and exit code', () => {
    const first = docsCheck()
    expect(first.stdout).toContain('Documentation checks:')
    expect(docsCheck()).toEqual(first)
  })
})
