// Which policy families a change selects (2.1-Q267; families.ts): the real CLI's plan in a planted repository whose
// policy/ratchets/ holds four of the repository's families, with the real glob engine linked in.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PlantedRepo } from './planted-repo.ts'

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
    const scoped = (self: boolean, ...families: string[]) => `cd desktop/web && npm run test:policies:family -- ${self ? '--self-test ' : ''}`
      + families.map((id) => `--family ${id}`).join(' ')
    const affected = repo.checks(['desktop/web/src/ipc/x.ts'])
    expect(affected).toContain(scoped(false, 'file-size', 'invoke-only-in-ipc'))
    expect(affected.join(' ; '), 'a source change leaves the planted violations alone').not.toContain('--self-test')
    expect(affected).not.toContain('cd desktop/web && npm run test:policies:check')
    expect(affected, 'the rest of the policy tooling still runs').toEqual(expect.arrayContaining(COMMIT_POLICIES_BUT_CHECK))
    repo.reset()
    const policy = repo.checks(['policy/rules.json'])
    expect(policy).toContain('cd desktop/web && npm run test:policies:check')
    expect(policy.join(' ; ')).not.toContain('--self-test --family')
    repo.reset()
    expect(repo.checks(['README.md', 'scripts/x.sh']), 'a path no family scopes adds none').toContain(scoped(false, 'file-size'))
  })

  it('canopi-f47t.52.240: the commit lane runs the planted violations of each family a change to its file, planted directory or adapter touches', () => {
    repo.linkGlobEngine()
    const selfTest = (...families: string[]) => `cd desktop/web && npm run test:policies:family -- --self-test ${families.map((id) => `--family ${id}`).join(' ')}`
    expect(repo.checks(['policy/ratchets/file-size.json', 'policy/fixtures/rules/python-lines/x.py'], true)).toContain(selfTest('file-size', 'python-lines'))
    repo.reset()
    expect(repo.checks(['policy/adapters/ast-grep.mjs'], true)).toContain(selfTest('invoke-only-in-ipc'))
    repo.reset()
    expect(repo.checks(['policy/README.md'], true).join(' ; ')).not.toContain('--self-test')
  })
})
