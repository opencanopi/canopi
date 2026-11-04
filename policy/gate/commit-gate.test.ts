// The commit gate over planted repositories (2.1-M195 to 2.1-M199, 2.1-M228, 2.1-Q267; canopi-f47t.52.228.10,
// canopi-f47t.52.228.54): authority from files only, pr and tree modes, merges on --cc, rebases, the gate's own files,
// the demotion rules and the failure states (busy, unreadable, cancelled, unmounted, retried).
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ATTRIBUTION, BRANCH_Q_ROW, CLOSED_BEAD, GateRepo, LEDGER, M_ROW, OPEN_BEAD, Q_ROW, real,
} from './commit-gate-repo.ts'
import { cleanEnv, git, REPO_ROOT } from './planted-repo.ts'

let repo: GateRepo
beforeEach(() => {
  repo = new GateRepo()
})
afterEach(() => repo.cleanup())

const refused = (head: string, rule: string, base?: string) => {
  const [status, out] = repo.pr(head, base)
  expect(status, out).toBe(1)
  expect(out).toContain(rule)
}
const passes = (head: string, base?: string) => {
  const [status, out] = repo.pr(head, base)
  expect(status, out).toBe(0)
}

describe('authority (2.1-M197)', () => {
  it('canopi-f47t.52.228.10: an exception without ids is refused', () => {
    refused(repo.raiseSuppression('feat: add an exception'), 'gate-loosening-authority')
  })

  it('canopi-f47t.52.228.10: an exception citing only an M row is refused', () => {
    refused(repo.raiseSuppression(`feat: add (${OPEN_BEAD}, ${M_ROW})`), 'gate-loosening-authority')
  })

  it('canopi-f47t.52.228.10: an exception citing a closed bead is refused', () => {
    refused(repo.raiseSuppression(`feat: add (${CLOSED_BEAD}, ${Q_ROW})`), 'gate-loosening-authority')
  })

  it('canopi-f47t.52.228.10: an exception citing a branch-added Q row is refused', () => {
    repo.write({ 'docs/decisions/2-1.md': `${LEDGER}| ${BRANCH_Q_ROW} | 2026-10-26 | Added on the branch. | | | plan |\n` })
    repo.commit('docs: a branch row')
    refused(repo.raiseSuppression(`feat: add (${OPEN_BEAD}, ${BRANCH_Q_ROW})`), 'gate-loosening-authority')
  })

  it('canopi-f47t.52.228.10: an open bead and a merge-base Q row pass', () => {
    passes(repo.raiseSuppression(`feat: add (${OPEN_BEAD}, ${Q_ROW})`))
  })

  const commitBead = (id: string, status: string, commit = true) => {
    const beads = repo.git('show', `${repo.base}:.beads/issues.jsonl`)
    repo.write({ '.beads/issues.jsonl': `${beads}\n${JSON.stringify({ id, status, assignee: 't' })}\n` })
    return commit ? repo.commit(`chore(beads): ${id} ${status}`) : undefined
  }
  const commitMsg = (message: string) => {
    writeFileSync(join(repo.root, 'MSG'), `${message}\n`)
    return repo.gate(['commit-msg', join(repo.root, 'MSG')], { GITHUB_ACTIONS: '' })
  }
  /** The gate never reads GITHUB_ACTIONS for beads: local and CI agree. */
  const prVerdicts = (head: string) => ['', 'true'].map((ci) => [ci, repo.gate(['pr', repo.base, head], { GITHUB_ACTIONS: ci })] as const)

  it('canopi-f47t.52.228.10: a bead closed by a later commit still authorises the earlier one', () => {
    repo.raiseSuppression(`feat: add (${OPEN_BEAD}, ${Q_ROW})`)
    repo.write({ '.beads/issues.jsonl': repo.read('.beads/issues.jsonl').replace('"open"', '"closed"') })
    const head = repo.commit(`chore(beads): close ${OPEN_BEAD} with its receipt`)
    for (const [ci, run] of prVerdicts(head)) expect(run.status, `${ci}: ${run.stdout}${run.stderr}`).toBe(0)
  })

  it('canopi-f47t.52.228.10: local and CI refuse a bead only the unstaged working tree holds', () => {
    // A bead filed in the working tree but never committed open is no authority CI can see, so the local commit-msg
    // refuses it too instead of accepting what CI later refuses.
    const late = 'canopi-f47t.52.903'
    repo.stageSuppression()
    commitBead(late, 'open', false)
    const message = `feat: add (${late}, ${Q_ROW})`
    const local = commitMsg(message)
    expect(local.status, local.stdout).toBe(1)
    expect(local.stdout).toContain(`${late} (absent)`)
    expect(local.stdout + local.stderr).toContain('.beads/issues.jsonl')
    repo.git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', message)
    for (const [ci, run] of prVerdicts(commitBead(late, 'closed') ?? '')) {
      expect(run.status, `${ci}: ${run.stdout}`).toBe(1)
      expect(run.stdout).toContain(`${late} (closed)`)
    }
  })

  it('canopi-f47t.52.228.10: a bead open in any commit of the PR range authorises it locally and in CI', () => {
    const late = 'canopi-f47t.52.902'
    repo.raiseSuppression(`feat: add (${late}, ${Q_ROW})`)
    commitBead(late, 'open')
    const head = commitBead(late, 'closed') ?? ''
    repo.at(repo.base)
    for (const [ci, run] of prVerdicts(head)) expect(run.status, `${ci}: ${run.stdout}${run.stderr}`).toBe(0)
  })

  it('canopi-f47t.52.228.10: commit-msg reads the branch commits and the integration tip', () => {
    const [late, tipOnly] = ['canopi-f47t.52.904', 'canopi-f47t.52.905']
    commitBead(late, 'open')
    const branch = commitBead(late, 'closed') ?? ''
    const tip = commitBead(tipOnly, 'open') ?? ''
    repo.git('checkout', '-q', '-B', 'topic', branch)
    repo.git('config', 'branch.topic.canopiIntegration', tip)
    repo.stageSuppression()
    for (const bead of [late, tipOnly]) {
      const run = commitMsg(`feat: add (${bead}, ${Q_ROW})`)
      expect(run.status, `${bead}: ${run.stdout}${run.stderr}`).toBe(0)
    }
  })

  it('canopi-f47t.52.228.10: commit-msg judges a verbose commit on its message, never the diff below the scissors', () => {
    // `git commit -v` hands the hook the staged diff below a scissors line and strips it only after: a bead, a Q row or
    // the tool's name in the diff is no part of the message, which CI's pr mode reads from %B.
    repo.stageSuppression()
    const diff = (comment: string) => `feat: add an exception\n\n${comment} Please enter the commit message.\n`
      + `${comment} ------------------------ >8 ------------------------\n${comment} Do not modify or remove the line above.\n`
      + `diff --git a/x b/x\n+Claude (${OPEN_BEAD}, ${Q_ROW})\n`
    for (const comment of ['#', ';']) {
      repo.git('config', 'core.commentChar', comment)
      writeFileSync(join(repo.root, 'MSG'), diff(comment))
      const run = repo.gate(['commit-msg', join(repo.root, 'MSG')], { GITHUB_ACTIONS: '' })
      expect(run.status, `${comment}: ${run.stdout}${run.stderr}`).toBe(1)
      expect(run.stdout, comment).toContain('gate-loosening-authority')
      expect(run.stdout, comment).not.toContain('gate-no-attribution')
    }
  })

  it('canopi-f47t.52.228.10: a guarded file change without a Q row is refused', () => {
    repo.write({ 'desktop/capabilities/main-window.json': `${JSON.stringify({ permissions: [] })}\n` })
    refused(repo.commit(`fix: drop the dialog grant (${OPEN_BEAD})`), 'gate-guarded-file')
  })

  it('canopi-f47t.52.228.10: F5 drops the dialog grants with Q240 and its open bead', () => {
    repo.write({ 'docs/decisions/2-1.md': real('docs/decisions/2-1.md'),
      'desktop/capabilities/main-window.json': real('desktop/capabilities/main-window.json') })
    repo.base = repo.commit("docs: main's ledger and capability")
    const grants = JSON.parse(real('desktop/capabilities/main-window.json')) as { permissions: unknown[] }
    grants.permissions = grants.permissions.filter((grant) => grant !== 'dialog:allow-open' && grant !== 'dialog:allow-save')
    repo.write({ 'desktop/capabilities/main-window.json': `${JSON.stringify(grants, null, 2)}\n` })
    passes(repo.commit(`feat(desktop): host dialogs only (${OPEN_BEAD}, 2.1-Q240)`))
  })

  it('canopi-f47t.52.228.10: a coverage floor change names both numbers', () => {
    const coverage = repo.json('policy/ratchets/coverage.json') as { floors: { vitest: { floors: { lines: number } } } }
    const was = coverage.floors.vitest.floors.lines
    coverage.floors.vitest.floors.lines = was + 0.1
    const raised = { 'policy/ratchets/coverage.json': `${JSON.stringify(coverage, null, 2)}\n` }
    repo.write(raised)
    refused(repo.commit(`test: raise the floor (${OPEN_BEAD}, ${Q_ROW})`), 'gate-guarded-file')
    repo.at(repo.base)
    repo.write(raised)
    refused(repo.commit(`test: raise the lines floor from ${was} to ${was + 0.1} (${OPEN_BEAD}, ${M_ROW})`), 'a Q row on the merge base')
    repo.at(repo.base)
    repo.write(raised)
    passes(repo.commit(`test: raise the lines floor from ${was} to ${was + 0.1} (${OPEN_BEAD}, ${Q_ROW})`))
  })

  it('canopi-f47t.52.228.54: a coverage floor change naming one number twice names only one', () => {
    // The guard counts the values a message names, not its distinct values: "from 94.8 to 94.8" names no new floor.
    const coverage = repo.json('policy/ratchets/coverage.json') as { floors: { vitest: { floors: { lines: number } } } }
    const was = coverage.floors.vitest.floors.lines
    coverage.floors.vitest.floors.lines = was + 0.1
    repo.write({ 'policy/ratchets/coverage.json': `${JSON.stringify(coverage, null, 2)}\n` })
    refused(repo.commit(`test: the lines floor from ${was} to ${was} (${OPEN_BEAD}, ${Q_ROW})`), 'gate-guarded-file')
  })

  it('canopi-f47t.52.228.10: a guarded-files entry joins free with its file and renames need a Q row', () => {
    const family = repo.json('policy/ratchets/guarded-files.json') as { entries: Record<string, unknown> }
    family.entries['canopi-types/edition-capabilities.json'] = { count: 1 }
    repo.write({ 'policy/ratchets/guarded-files.json': `${JSON.stringify(family, null, 2)}\n`, 'canopi-types/edition-capabilities.json': '{}\n' })
    const head = repo.commit('feat: the capability table joins guarded-files')
    passes(head)
    family.entries['canopi-types/capabilities.json'] = family.entries['canopi-types/edition-capabilities.json']
    delete family.entries['canopi-types/edition-capabilities.json']
    repo.git('mv', 'canopi-types/edition-capabilities.json', 'canopi-types/capabilities.json')
    repo.write({ 'policy/ratchets/guarded-files.json': `${JSON.stringify(family, null, 2)}\n` })
    refused(repo.commit(`chore: rename (${OPEN_BEAD})`), 'gate-guarded-file', head)
  })

  it('canopi-f47t.52.228.54: a ledger cell or test title newly citing a bead no export holds is refused; cited history is never re-read', () => {
    // Spelt at runtime so this file's own titles cite none of them.
    const [cell, title, prose, body] = ['zz9.2', 'zz8', 'pr0', 'bd0'].map((hash) => ['canopi', hash].join('-'))
    repo.write({
      'docs/decisions/2-1.md': `${LEDGER}| 2.1-M901 | 2026-11-04 | Paid down by ${OPEN_BEAD}. | | | |\n`,
      'e2e/kept.spec.ts': `test('keeps the dock (${OPEN_BEAD})', async () => {})\n`,
    })
    const history = repo.commit(`docs: history citing ${OPEN_BEAD}`)
    // bd prune drops the open bead from the export: the untouched row and title still cite it.
    repo.write({ '.beads/issues.jsonl': `${JSON.stringify({ id: CLOSED_BEAD, status: 'closed' })}\n` })
    const pruned = repo.commit('chore(beads): prune')
    passes(pruned, history)
    repo.write({
      'docs/decisions/2-1.md': `${repo.read('docs/decisions/2-1.md')}| 2.1-M902 | 2026-11-04 | Paid down by ${cell}. | | | |\n\nProse names ${prose}.\n`,
      'e2e/new.spec.ts': `test('draws the dock (${title})', async () => { const note = '${body}' })\n`,
    })
    const [status, out] = repo.pr(repo.commit('docs: new citations'), pruned)
    expect(status, out).toBe(1)
    expect(out).toContain('gate-absent-bead')
    expect(out).toContain(`docs/decisions/2-1.md: ${cell}`)
    expect(out).toContain(`e2e/new.spec.ts: ${title}`)
    for (const named of [prose, body, OPEN_BEAD]) expect(out).not.toContain(named)
  })

  // Spelt at runtime so this file's own titles cite no bead the export lacks.
  const unexported = ['canopi', 'f47t.52.902'].join('-')

  it('canopi-f47t.52.228.54: a malformed tracker export line is refused by its line, never read as an absent bead', () => {
    repo.write({ '.beads/issues.jsonl': `${repo.read('.beads/issues.jsonl')}{"id": "${unexported}", <<<<<<< HEAD\n` })
    repo.write({ 'e2e/new.spec.ts': `test('draws the dock (${unexported})', async () => {})\n` })
    const [status, out] = repo.pr(repo.commit('test: cite a bead whose export line is broken'))
    expect(status, out).toBe(1)
    expect(out).toContain('unreadable: .beads/issues.jsonl:3')
    expect(out).not.toContain('gate-absent-bead')
  })

  it('canopi-f47t.52.228.54: with no committed tracker export the absent-bead check is skipped', () => {
    repo.git('rm', '-q', '.beads/issues.jsonl')
    repo.write({ 'e2e/new.spec.ts': `test('draws the dock (${unexported})', async () => {})\n` })
    passes(repo.commit('test: a planted repository with no tracker'))
  })

  it('canopi-f47t.52.228.10: an attribution trailer is refused', () => {
    repo.write({ 'notes.txt': 'x\n' })
    refused(repo.commit(`docs: notes\n\n${ATTRIBUTION}`), 'gate-no-attribution')
  })

  it('canopi-f47t.52.228.10: retried: the gate calls no gh, bd or npm and gives identical output on a rerun', () => {
    const head = repo.raiseSuppression('feat: add an exception')
    const shims = join(repo.root, 'bin')
    const log = join(repo.root, 'calls.log')
    mkdirSync(shims)
    for (const tool of ['gh', 'bd', 'npm']) {
      writeFileSync(join(shims, tool), `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 1\n`)
      chmodSync(join(shims, tool), 0o755)
    }
    const env = { PATH: `${shims}:${process.env['PATH'] ?? ''}` }
    const first = repo.gate(['pr', repo.base, head], env)
    const second = repo.gate(['pr', repo.base, head], env)
    expect(first.status).toBe(1)
    expect([second.stdout, second.stderr]).toEqual([first.stdout, first.stderr])
    expect(() => readFileSync(log, 'utf8')).toThrow()
  })
})

describe('pr and tree modes (2.1-M228; design check A3)', () => {
  it('canopi-f47t.52.228.10: tree mode fails on a first-parent commit naming no PR', () => {
    repo.write({ 'notes.txt': 'x\n' })
    const squash = repo.commit('docs: notes (#74)')
    expect(repo.gate(['tree', repo.base, squash]).status).toBe(0)
    repo.write({ 'notes.txt': 'y\n' })
    const direct = repo.commit('docs: a direct push')
    const run = repo.gate(['tree', squash, direct])
    expect(run.status, run.stdout).toBe(1)
    expect(run.stdout).toContain('gate-squash-subject')
  })

  it('canopi-f47t.52.228.10: tree mode passes a Merge pull request commit and skips its branch', () => {
    repo.git('checkout', '-q', '-b', 'topic')
    repo.raiseSuppression('feat: an unauthorised raise on the PR branch')
    repo.git('checkout', '-q', 'main')
    repo.git('-c', 'core.hooksPath=/dev/null', 'merge', '-q', '--no-ff', '-m', 'Merge pull request #75 from opencanopi/topic', 'topic')
    const run = repo.gate(['tree', repo.base, repo.git('rev-parse', 'HEAD')])
    expect(run.status, run.stdout).toBe(0)
  })

  /** main and topic each add an authorised entry; the merge resolves suppressions.json, optionally adding one. */
  const merge = (extra?: string) => {
    repo.git('checkout', '-q', '-b', 'topic')
    repo.raiseSuppression(`feat: topic's entry (${OPEN_BEAD}, ${Q_ROW})`)
    const topic = repo.json('policy/ratchets/suppressions.json') as { entries: Record<string, unknown> }
    repo.git('checkout', '-q', 'main')
    const family = repo.json('policy/ratchets/suppressions.json') as { entries: Record<string, unknown> }
    family.entries['desktop/web/src/other.ts: oxlint:no-console'] = { count: 1 }
    repo.write({ 'policy/ratchets/suppressions.json': `${JSON.stringify(family, null, 2)}\n` })
    repo.commit(`feat: main's entry (${OPEN_BEAD}, ${Q_ROW})`)
    spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'merge', '-q', '--no-commit', 'topic'], { cwd: repo.path, env: cleanEnv() })
    Object.assign(family.entries, topic.entries)
    if (extra) family.entries[extra] = { count: 1 }
    repo.write({ 'policy/ratchets/suppressions.json': `${JSON.stringify(family, null, 2)}\n` })
    return repo.commit("Merge branch 'topic'")
  }

  it('canopi-f47t.52.228.10: a merge of an authorised branch passes', () => {
    passes(merge())
  })

  it('canopi-f47t.52.228.10: an unauthorised change in a conflict resolution is refused', () => {
    const [status, out] = repo.pr(merge('desktop/web/src/sneaked.ts: oxlint:no-console'))
    expect(status, out).toBe(1)
    expect(out).toContain('gate-loosening-authority')
    expect(out).toContain('sneaked.ts')
  })

  it('canopi-f47t.52.228.10: rebased commits are rechecked', () => {
    const head = repo.raiseSuppression('feat: add an exception')
    expect(repo.pr(head)[0]).toBe(1)
    repo.git('checkout', '-q', '-b', 'newbase', repo.base)
    repo.write({ 'notes.txt': 'x\n' })
    const newbase = repo.commit('docs: notes')
    repo.git('-c', 'core.hooksPath=/dev/null', 'rebase', '-q', '--onto', newbase, repo.base, 'main')
    const rebased = repo.git('rev-parse', 'HEAD')
    expect(rebased).not.toBe(head)
    refused(rebased, 'gate-loosening-authority', newbase)
  })

  it("canopi-f47t.52.228.10: a commit changing the gate's table, its modules or hooks is listed", () => {
    const gatePaths = ['policy/gate/table.ts', 'policy/gate/cli.mjs', 'policy/gate/commit-gate.ts', 'policy/tsconfig.json',
      '.githooks/pre-commit', 'policy/core/diff.mjs', 'policy/core/new-module.mjs', 'policy/git.mjs', 'policy/adapters/commit-gate.mjs',
      'policy/layers.json']
    let head = ''
    for (const path of [...gatePaths, 'policy/gate/table.test.ts', 'policy/git.test.mjs', 'notes.txt']) {
      const at = join(repo.path, path)
      mkdirSync(join(at, '..'), { recursive: true })
      let was = ''
      try {
        was = readFileSync(at, 'utf8')
      } catch { /* a new file */ }
      writeFileSync(at, was + (/\.(mjs|ts)$/u.test(path) ? '// changed\n' : path.endsWith('.json') ? '\n' : '# changed\n'))
      head = repo.commit(`chore: change ${path}`)
    }
    const [status, out] = repo.pr(head)
    expect(status, out).toBe(0)
    const listed = out.split('\n').filter((line) => line.startsWith("changes the gate's own files: "))
    expect(listed.map((line) => line.split('chore: change ')[1])).toEqual(gatePaths)
  })

  it('canopi-f47t.52.228.54: a PR deleting the gate its base holds still judges every commit', () => {
    // Retires-test: 'test_canopi_f47t_52_228_commits_before_the_gate_count_only_when_the_merge_base_has_none' had no
    // replacement: every commit is judged (design check A3), so no commit is before the gate.
    repo.write({ 'scripts/test_x.py': 'class X:\n    def test_kept_behaviour(self):\n        assert 1\n' })
    const base = repo.commit('chore: a test')
    repo.git('rm', '-q', '-r', 'policy/gate')
    repo.commit('chore: drop the gate')
    rmSync(join(repo.path, 'scripts/test_x.py'))
    repo.raiseSuppression('chore: raise an entry')
    repo.git('checkout', base, '--', 'policy/gate')
    const head = repo.commit('chore: restore the gate')
    const [status, out] = repo.pr(head, base)
    expect(status, out).toBe(1)
    expect(out).toContain('gate-loosening-authority')
    expect(out).toContain('gate-test-deleted')
    expect(out.split('\n').filter((line) => line.startsWith('before the gate'))).toEqual([])
    expect(out).toContain('commit gate: 3 commit(s): RED')
  })

  it('canopi-f47t.52.228.10: an inventory demotion or a dropped rule row needs a Q row', () => {
    const rules = repo.json('policy/rules.json') as { rules: { id: string }[] }
    const inventory = { rules: [{ id: 'x-rule', doc: 'AGENTS.md', quote: 'x', state: { exists: { check: 'x' } } as unknown }] }
    repo.write({ 'policy/inventory.json': `${JSON.stringify(inventory)}\n` })
    const base = repo.commit('chore: inventory')
    const demoted = { rules: [{ ...inventory.rules[0], state: 'advice' }] }
    const dropped = { ...rules, rules: rules.rules.filter((row) => row.id !== 'suppressions') }
    for (const [files, rule] of [[{ 'policy/inventory.json': `${JSON.stringify(demoted)}\n` }, 'x-rule'],
      [{ 'policy/rules.json': `${JSON.stringify(dropped, null, 2)}\n` }, 'suppressions']] as const) {
      repo.at(base)
      repo.write(files)
      const [status, out] = repo.pr(repo.commit(`chore: demote (${OPEN_BEAD})`), base)
      expect(status, out).toBe(1)
      expect(out).toContain('gate-inventory-demotion')
      expect(out).toContain(rule)
      repo.at(base)
      repo.write(files)
      passes(repo.commit(`chore: demote (${OPEN_BEAD}, ${Q_ROW})`), base)
    }
  })

  it('canopi-f47t.52.228.54: an inventory row deleted outright needs a Q row', () => {
    const inventory = { rules: [{ id: 'x-rule', doc: 'AGENTS.md', quote: 'x', state: { exists: { check: 'x' } } }] }
    repo.write({ 'policy/inventory.json': `${JSON.stringify(inventory)}\n` })
    const base = repo.commit('chore: inventory')
    repo.write({ 'policy/inventory.json': `${JSON.stringify({ rules: [] })}\n` })
    const [status, out] = repo.pr(repo.commit(`chore: drop the row (${OPEN_BEAD})`), base)
    expect(status, out).toBe(1)
    expect(out).toContain('gate-inventory-demotion: policy/inventory.json: x-rule is deleted')
    repo.at(base)
    repo.write({ 'policy/inventory.json': `${JSON.stringify({ rules: [] })}\n` })
    passes(repo.commit(`chore: drop the row (${OPEN_BEAD}, ${Q_ROW})`), base)
  })
})

describe('failure states (2.1-Q267)', () => {
  it('canopi-f47t.52.228.10: cancelled: SIGINT exits non-zero and leaves status and index unchanged', async () => {
    for (let n = 0; n < 4; n += 1) {
      repo.raiseSuppression(`feat: raise ${n}`)
      const family = repo.json('policy/ratchets/suppressions.json') as { entries: Record<string, unknown> }
      family.entries = Object.fromEntries(Object.entries(family.entries).map(([key, value]) => [key.includes('new.ts') ? `${key}${n}` : key, value]))
      repo.write({ 'policy/ratchets/suppressions.json': `${JSON.stringify(family, null, 2)}\n` })
      repo.commit(`feat: rename ${n}`)
    }
    const head = repo.git('rev-parse', 'HEAD')
    const index = join(repo.path, '.git/index')
    const snapshot = () => [repo.git('status', '--porcelain'), createHash('sha256').update(readFileSync(index)).digest('hex')]
    const before = snapshot()
    const child = spawn(process.execPath, ['policy/gate/cli.mjs', 'commit-gate', 'pr', repo.base, head], { cwd: repo.path, env: cleanEnv() })
    let stderr = ''
    const code = await new Promise<number | null>((done) => {
      // SIGINT once the gate says it is judging, so the signal lands mid-run however loaded the machine is.
      child.stderr.on('data', (chunk: Buffer) => {
        const started = !stderr.includes('judging')
        stderr += chunk.toString()
        if (started && stderr.includes('judging')) child.kill('SIGINT')
      })
      child.on('close', (status) => done(status))
    })
    expect(code, stderr).not.toBe(0)
    expect(stderr).toContain('interrupted')
    expect(snapshot()).toEqual(before)
  })

  it('canopi-f47t.52.228.10: a planted case the temporary directory cannot hold fails naming the path', () => {
    const cases = join(repo.root, 'case')
    mkdirSync(cases)
    writeFileSync(join(cases, 'case.json'), JSON.stringify({ base: {}, head: { 'a.txt': 'x' }, message: 'docs: x' }))
    const run = repo.gate(['planted', cases], { TMPDIR: join(repo.root, 'full') })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(join(repo.root, 'full'))
  })

  it('canopi-f47t.52.228.54: busy: commit-msg refuses while another git command holds the index lock, naming it', () => {
    const lock = join(repo.path, '.git/index.lock')
    writeFileSync(lock, '')
    writeFileSync(join(repo.root, 'MSG'), 'docs: x\n')
    const run = repo.gate(['commit-msg', join(repo.root, 'MSG')])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(lock)
  })

  it('canopi-f47t.52.228.54: unreadable: a shallow clone missing the range is refused asking for the whole range', () => {
    repo.write({ 'notes.txt': 'x\n' })
    repo.commit('docs: one')
    repo.write({ 'notes.txt': 'y\n' })
    const head = repo.commit('docs: two')
    const shallow = join(repo.root, 'shallow')
    git(repo.root, 'clone', '-q', '--depth', '1', `file://${repo.path}`, shallow)
    cpSync(join(repo.path, 'desktop/web/package.json'), join(shallow, 'desktop/web/package.json'))
    const run = repo.gate(['pr', repo.base, head], {}, shallow)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('shallow')
    expect(run.stderr).toContain('fetch-depth: 0')
  })

  it('canopi-f47t.52.228.54: unreadable: a blob of the range that is not fetched is refused asking for the whole range, never read as absent', () => {
    // A test file read as absent would lose every title; a family file read as absent would hide its change.
    repo.write({ 'scripts/test_x.py': 'class X:\n    def test_kept(self):\n        assert 1\n' })
    const base = repo.commit('test: one')
    repo.write({ 'scripts/test_x.py': 'class X:\n    def test_kept(self):\n        assert 1\n\n    def test_more(self):\n        assert 2\n' })
    const head = repo.commit('test: two')
    const blob = repo.git('rev-parse', `${head}:scripts/test_x.py`)
    rmSync(join(repo.path, '.git/objects', blob.slice(0, 2), blob.slice(2)))
    const run = repo.gate(['pr', base, head])
    expect(run.status, run.stdout).toBe(1)
    expect(run.stderr).toContain('scripts/test_x.py')
    expect(run.stderr).toContain('fetch-depth: 0')
  })

  it('canopi-f47t.52.228.54: unreadable: a shallow clone cut inside the range is refused asking for the whole range', () => {
    repo.write({ 'notes.txt': 'x\n' })
    repo.commit('docs: one')
    repo.write({ 'notes.txt': 'y\n' })
    const head = repo.commit('docs: two')
    repo.git('branch', 'gate-base', repo.base)
    const shallow = join(repo.root, 'shallow')
    git(repo.root, 'clone', '-q', '--depth', '1', `file://${repo.path}`, shallow)
    git(shallow, 'fetch', '-q', '--depth', '1', 'origin', 'gate-base')
    cpSync(join(repo.path, 'desktop/web/package.json'), join(shallow, 'desktop/web/package.json'))
    const run = repo.gate(['pr', repo.base, head], {}, shallow)
    expect(run.status, run.stdout).toBe(1)
    expect(run.stderr).toContain(`shallow at ${head.slice(0, 9)}`)
    expect(run.stderr).toContain('fetch-depth: 0')
  })

  it('canopi-f47t.52.228.54: unmounted: a test change with no desktop/web install is refused naming npm ci', () => {
    rmSync(join(repo.path, 'desktop/web/node_modules'))
    repo.write({ 'desktop/web/src/a.test.ts': "it('one', () => {\n  expect(1).toBe(1)\n})\n" })
    const test = repo.commit('test(frontend): one')
    const run = repo.gate(['pr', repo.base, test])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('run npm ci in desktop/web')
    repo.write({ 'notes.txt': 'x\n' })
    const docs = repo.gate(['pr', test, repo.commit('docs: notes')])
    expect(docs.status, `a change with no test needs no install: ${docs.stderr}`).toBe(0)
  })
})

describe('the planted cases and the workflow (2.1-Q222)', () => {
  it('canopi-f47t.52.228.10: the workflow runs pr and tree mode as the Commit gate check', () => {
    const text = real('.github/workflows/commit-gate.yml')
    expect(text).toContain('name: Commit gate')
    expect(text).toContain('types: [opened, synchronize, reopened, edited]')
    expect(text).toContain('fetch-depth: 0')
    expect(text).toContain('node-version: 24')
    expect(text).toMatch(/node policy\/gate\/cli\.mjs commit-gate pr "\$BASE" "\$HEAD" --body-file/u)
    expect(text).toMatch(/node policy\/gate\/cli\.mjs commit-gate tree "\$BEFORE" "\$AFTER"/u)
    const code = text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
    expect(code).not.toMatch(/\bgh\b|python|unittest/u)
  })

  it('canopi-f47t.52.228: CI runs the closed-bead check on every PR and main push', () => {
    const step = real('.github/workflows/commit-gate.yml').split('      - name: No policy entry cites a closed bead\n')[1]?.split('\n      - ')[0] ?? ''
    expect(step).not.toContain('if:')
    expect(step).toContain('run: node policy/check.mjs --closed-beads')
  })

  it('canopi-f47t.52.228.10: the planted runner copies every module the gate imports', () => {
    // A module the gate imports but the planted repository lacks fails the import, and every case would read silent.
    const run = spawnSync(process.execPath, ['policy/gate/cli.mjs', 'commit-gate', 'planted',
      join(REPO_ROOT, 'policy/fixtures/rules/gate-no-attribution/case.json')], { cwd: REPO_ROOT, encoding: 'utf8', env: cleanEnv() })
    expect(run.status, run.stderr).toBe(0)
    expect((JSON.parse(run.stdout) as { rules: string[] }).rules).toEqual(['gate-no-attribution'])
  })

  it('canopi-f47t.52.228.54: the adapter reads its root-relative cases from any working directory', () => {
    // npm's scripts run check.mjs from desktop/web, where a case path relative to the root names no file.
    const script = "const { collect } = await import(process.argv[1]); const sites = await collect({ root: process.argv[2], "
      + "paths: ['policy/fixtures/rules/gate-no-attribution/case.json'] }); console.log(JSON.stringify(sites.map((site) => site.rule)))"
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, join(REPO_ROOT, 'policy/adapters/commit-gate.mjs'), REPO_ROOT],
      { cwd: join(REPO_ROOT, 'desktop/web'), encoding: 'utf8', env: cleanEnv() })
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual(['gate-no-attribution'])
  })
})
