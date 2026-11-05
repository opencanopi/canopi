// Which policy families a change selects (2.1-Q267; families.ts): the real CLI's plan in a planted repository whose
// policy/ratchets/ holds four of the repository's families, with the real glob engine linked in.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { reachedFamilies } from './families.ts'
import { PlantedRepo, REPO_ROOT } from './planted-repo.ts'

/** The policy tooling's commit-lane checks but the whole check, in the table's order (POLICY_COMMIT). */
const COMMIT_POLICIES_BUT_CHECK = ['node', 'generate', 'generate:self-test', 'ast-grep']
  .map((script) => `cd desktop/web && npm run test:policies:${script}`)

let repo: PlantedRepo
beforeEach(() => { repo = new PlantedRepo() })
afterEach(() => repo.cleanup())

describe('family selection (canopi-f47t.52.240)', () => {
  it('canopi-f47t.52.240: the affected lane runs the commit-lane families a changed path reaches, a policy change the whole check', () => {
    // 2.1-Q267: the whole commit-lane check took 227 s; push and CI keep it, the affected lane runs what the change reaches.
    repo.linkGlobEngine()
    const scoped = (...families: string[]) => `cd desktop/web && npm run test:policies:family -- ${families.map((id) => `--family ${id}`).join(' ')}`
    const affected = repo.checks(['desktop/web/src/ipc/x.ts'])
    expect(affected).toContain(scoped('file-size', 'invoke-only-in-ipc'))
    expect(affected.join(' ; '), 'a source change leaves the planted violations alone').not.toContain('--self-test')
    expect(affected).not.toContain('cd desktop/web && npm run test:policies:check')
    expect(affected, 'the rest of the policy tooling still runs').toEqual(expect.arrayContaining(COMMIT_POLICIES_BUT_CHECK))
    repo.reset()
    const policy = repo.checks(['policy/rules.json'])
    expect(policy).toContain('cd desktop/web && npm run test:policies:check')
    expect(policy.join(' ; ')).not.toContain('--self-test --family')
    repo.reset()
    expect(repo.checks(['README.md', 'scripts/x.sh']), 'a path no family scopes adds none').toContain(scoped('file-size'))
  })

  it('canopi-f47t.52.240: the commit lane leaves the planted violations to the push lane (design check A12)', () => {
    // A12: the commit lane is typecheck, the cheap families, the closed-bead check and changed Vitest files; one adapter
    // edit would otherwise run the planted cases of every family on its tool (107 for ast-grep).
    repo.linkGlobEngine()
    for (const path of ['policy/ratchets/file-size.json', 'policy/fixtures/rules/python-lines/x.py', 'policy/adapters/ast-grep.mjs']) {
      expect(repo.checks([path], true).join(' ; '), path).not.toContain('--self-test')
      repo.reset()
    }
  })

  it('canopi-f47t.52.240: a change to a policy tool\'s config runs the whole policy check at the affected lane', () => {
    // A family's scope names the code it observes; its tool's config changes what every one of its families finds.
    repo.linkGlobEngine()
    for (const path of ['desktop/web/knip.json', 'desktop/web/.oxlintrc.json', 'desktop/web/.dependency-cruiser.cjs',
      'desktop/web/tsconfig.json', 'sgconfig.yml']) {
      expect(repo.checks([path]), path).toContain('cd desktop/web && npm run test:policies:check')
      repo.reset()
    }
  })

  it('canopi-f47t.52.240: every knip entry is in the knip family\'s scope, so a change to it runs knip', () => {
    const entries = (JSON.parse(readFileSync(join(REPO_ROOT, 'desktop/web/knip.json'), 'utf8')) as { entry: string[] }).entry
    const samples = entries.map((glob) => `desktop/web/${glob.replace(/!$/, '').replace(/\*\*$/, 'x.tsx')}`)
    for (const sample of samples) expect(reachedFamilies(REPO_ROOT, [sample], ['knip']).ids, sample).toEqual(['knip'])
  })
})
