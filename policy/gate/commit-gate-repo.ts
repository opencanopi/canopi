// policy/gate/commit-gate-repo.ts: a temporary repository holding this checkout's policy/ (its cases aside), a ledger,
// two beads and an origin/main base commit, for the commit gate's tests. Each case commits there and runs the real
// gate through its entry (`node policy/gate/cli.mjs commit-gate ...`). The engines manifest and the desktop/web install
// are linked in and excluded from every commit, so the gate reads TypeScript and runs `vitest list` as in a checkout.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cleanEnv, ENTRY, git, type GateRun, REPO_ROOT } from './planted-repo.ts'

export const OPEN_BEAD = 'canopi-f47t.52.900'
export const CLOSED_BEAD = 'canopi-f47t.52.901'
// Ids of no ledger, built at runtime so the repository's own missing-id check never reads them.
export const [Q_ROW, M_ROW, BRANCH_Q_ROW, BRANCH_M_ROW] = ['Q900', 'M900', 'Q901', 'M903'].map((id) => `2.1-${id}`) as [string, string, string, string]
export const LEDGER = `# 2.1 decisions

| id | date | decision | user's words | supersedes / superseded by | implemented by |
|---|---|---|---|---|---|
| ${Q_ROW} | 2026-10-26 | A user decision that authorises the planted raise. | | | plan |
| ${M_ROW} | 2026-10-26 | An engineering decision, which authorises an engineering loosening. | | | plan |
`
export const ATTRIBUTION = `Co-Authored-${'By'}: Cl${'aude'} <noreply@example.invalid>`
/** The base test file the deletion guard's cases change. */
export const KEPT = `import { expect, it } from 'vitest'

it('keeps the first behaviour', () => {
  expect(1).toBe(1)
  expect(2).toBe(2)
})

it('keeps the second behaviour', () => {
  expect(3).toBe(3)
})
`

type Json = { [key: string]: unknown }

export class GateRepo {
  readonly root = mkdtempSync(join(tmpdir(), 'canopi-commit-gate-'))
  readonly path = join(this.root, 'repo')
  base: string

  constructor(options: { readonly hooks?: boolean } = {}) {
    mkdirSync(this.path)
    this.git('init', '-q', '-b', 'main')
    this.git('config', 'user.email', 'test@example.invalid')
    this.git('config', 'user.name', 'test')
    cpSync(join(REPO_ROOT, 'policy'), join(this.path, 'policy'), {
      recursive: true, filter: (source) => !source.startsWith(join(REPO_ROOT, 'policy/fixtures')),
    })
    if (options.hooks) cpSync(join(REPO_ROOT, '.githooks'), join(this.path, '.githooks'), { recursive: true })
    mkdirSync(join(this.path, 'desktop/web'), { recursive: true })
    writeFileSync(join(this.path, 'desktop/web/package.json'), readFileSync(join(REPO_ROOT, 'desktop/web/package.json')))
    symlinkSync(join(REPO_ROOT, 'desktop/web/node_modules'), join(this.path, 'desktop/web/node_modules'))
    writeFileSync(join(this.path, '.git/info/exclude'), 'desktop/web/package.json\ndesktop/web/node_modules\n')
    this.write({
      'docs/decisions/2-1.md': LEDGER,
      '.beads/issues.jsonl': [{ id: OPEN_BEAD, status: 'open', assignee: 'test' }, { id: CLOSED_BEAD, status: 'closed', assignee: 'test' }]
        .map((bead) => JSON.stringify(bead)).join('\n') + '\n',
      'desktop/capabilities/main-window.json': `${JSON.stringify({ permissions: ['dialog:allow-open'] })}\n`,
    })
    this.base = this.commit('chore: base')
    this.git('update-ref', 'refs/remotes/origin/main', this.base)
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true })
  }

  git(...args: string[]): string {
    return git(this.path, ...args)
  }

  write(files: Readonly<Record<string, string>>): void {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(this.path, name)), { recursive: true })
      writeFileSync(join(this.path, name), text)
    }
  }

  read(name: string): string {
    return readFileSync(join(this.path, name), 'utf8')
  }

  json(name: string): Json {
    return JSON.parse(this.read(name)) as Json
  }

  /** Commits everything with no hook; the new HEAD. */
  commit(message: string): string {
    this.git('add', '-A')
    this.git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', message)
    return this.git('rev-parse', 'HEAD')
  }

  /** Detaches HEAD at `rev`, the working tree reset to it. */
  at(rev: string): void {
    this.git('checkout', '-q', '-f', '--detach', rev)
    this.git('clean', '-qfd')
  }

  stageSuppression(): void {
    const family = this.json('policy/ratchets/suppressions.json') as { entries: Json }
    family.entries['desktop/web/src/new.ts: oxlint:no-console'] = { count: 1 }
    this.write({ 'policy/ratchets/suppressions.json': `${JSON.stringify(family, null, 2)}\n` })
    this.git('add', 'policy/ratchets/suppressions.json')
  }

  raiseSuppression(message: string): string {
    this.stageSuppression()
    return this.commit(message)
  }

  /** The commit gate run with `args` through the real entry. */
  gate(args: readonly string[], env: Readonly<Record<string, string>> = {}, cwd = this.path): GateRun {
    const run = spawnSync(process.execPath, [ENTRY, 'commit-gate', ...args], {
      cwd, encoding: 'utf8', timeout: 300_000, env: { ...cleanEnv(), ...env },
    })
    return { status: run.status, stdout: run.stdout, stderr: run.stderr }
  }

  /** `pr base head` (and `extra`) as [status, stdout + stderr]. */
  pr(head: string, base = this.base, ...extra: string[]): [number | null, string] {
    const run = this.gate(['pr', base, head, ...extra])
    return [run.status, run.stdout + run.stderr]
  }
}

/** The checkout's own `name`, for a case that starts from the real file. */
export const real = (name: string): string => readFileSync(join(REPO_ROOT, name), 'utf8')
