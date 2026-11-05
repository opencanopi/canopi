// The commit gate's judgement of a family's header (commit-gate-judge.ts headerFree; 2.1-Q267) over a planted
// repository, through the real entry: which header change loosens a ratchet and so needs a bead and a Q row.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GateRepo, OPEN_BEAD, Q_ROW } from './commit-gate-repo.ts'

let repo: GateRepo
beforeEach(() => { repo = new GateRepo() })
afterEach(() => repo.cleanup())

const verdict = (head: string, base?: string) => {
  const [status, out] = repo.pr(head, base)
  return { status, out }
}

/** Commits suppressions.json changed by `edit`; the new HEAD. */
const family = (edit: (doc: Record<string, unknown>) => void, message: string) => {
  const doc = repo.json('policy/ratchets/suppressions.json') as Record<string, unknown>
  edit(doc)
  repo.write({ 'policy/ratchets/suppressions.json': `${JSON.stringify(doc, null, 2)}\n` })
  return repo.commit(message)
}

describe('header authority (canopi-f47t.52.240)', () => {
  it('canopi-f47t.52.240: turning a family\'s ceilings on needs a bead and a Q row; turning them off passes', () => {
    // Ceilings keep a fixed site's headroom, so a new site can fill it unseen: a loosening, judged as one.
    const bare = verdict(family((doc) => { doc['ceilings'] = true }, 'chore: ceilings'))
    expect(bare.status, bare.out).toBe(1)
    expect(bare.out).toContain('gate-loosening-authority')
    repo.at(repo.base)
    const on = family((doc) => { doc['ceilings'] = true }, `chore: ceilings (${OPEN_BEAD}, ${Q_ROW})`)
    const wider = family((doc) => { doc['scope'] = [...doc['scope'] as string[], 'desktop/web/more/**'] }, 'chore: a wider scope')
    const kept = verdict(wider, on)
    expect(kept.status, `kept ceilings beside a wider scope: ${kept.out}`).toBe(0)
    const off = verdict(family((doc) => { delete doc['ceilings'] }, 'chore: ratchet again'), wider)
    expect(off.status, off.out).toBe(0)
  })
})
