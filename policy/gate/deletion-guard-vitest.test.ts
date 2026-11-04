// The deletion guard's Vitest pass (`commit-gate pr --vitest`; 2.1-M199, 2.1-Q224, 2.1-Q267; canopi-f47t.52.228.10,
// canopi-f47t.52.228.51): `vitest list --staticParse=false`, base against head, sees the `.each` rows the per-commit
// reading takes as one title, and routes each lost title through the same loss router as the per-commit pass.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GateRepo, KEPT, Q_ROW } from './commit-gate-repo.ts'

const ROWS = "import { expect, it } from 'vitest'\n\nit.each([1, 2, 3])('keeps row %i', (n) => {\n  expect(n).toBeGreaterThan(0)\n})\n"
const ROWS_FILE = 'desktop/web/src/rows.test.ts'
const KEPT_FILE = 'desktop/web/src/kept.test.ts'
const ANYTHING = "\nit('anything', () => {\n  expect(4).toBe(4)\n})\n"

let repo: GateRepo
beforeEach(() => {
  repo = new GateRepo()
  repo.write({ [ROWS_FILE]: ROWS, [KEPT_FILE]: KEPT })
  repo.base = repo.commit('test(frontend): three rows')
})
afterEach(() => repo.cleanup())

/** Commits `files` with `message` (after a sibling commit `before`), judged with the Vitest pass. */
const gate = (files: Record<string, string>, message: string, before?: string): [number | null, string] => {
  if (before) {
    repo.write({ 'notes.txt': 'x\n' })
    repo.commit(before)
  }
  repo.write(files)
  return repo.pr(repo.commit(message), repo.base, '--vitest')
}
const rows = (list: string) => ROWS.replace('[1, 2, 3]', list)

describe('the Vitest pass (2.1-Q224)', () => {
  it('canopi-f47t.52.228.10: a deleted each row is refused by the vitest list pass', () => {
    const [status, out] = gate({ [ROWS_FILE]: rows('[1, 2]') }, 'test(frontend): two rows')
    expect(status, out).toBe(1)
    expect(out).toContain("vitest list: gate-test-deleted: 'keeps row 3'")
  })

  it('canopi-f47t.52.228.10: a test split into a new file passes the vitest list pass', () => {
    const [status, out] = gate({ [ROWS_FILE]: rows('[1, 2]'), 'desktop/web/src/row-three.test.ts': rows('[3]') },
      'test(frontend): row three in its own file')
    expect(status, out).toBe(0)
  })

  it('canopi-f47t.52.228.10: a renamed test file dropping an each row is refused', () => {
    rmSync(join(repo.path, ROWS_FILE))
    const [status, out] = gate({ 'desktop/web/src/kept-rows.test.ts': rows('[1, 2]') }, 'test(frontend): rename the rows test')
    expect(status, out).toBe(1)
    expect(out).toContain("'keeps row 3'")
  })

  it('canopi-f47t.52.228.10: only the deleting commit routes a vitest list loss', () => {
    // A Q row in a sibling commit, or the title unquoted in a sentence, routes nothing; the commit's own Q row does.
    let [status, out] = gate({ [ROWS_FILE]: rows('[1, 2]') }, 'test(frontend): keeps row 3 goes', `feat(policy): guarded files (${Q_ROW})`)
    expect(status, out).toBe(1)
    expect(out).toContain("'keeps row 3'")
    repo.at(repo.base);
    [status, out] = gate({ [ROWS_FILE]: rows('[1, 2]') }, `test(frontend): row three is no behaviour (${Q_ROW})`)
    expect(status, out).toBe(0)
  })

  it('canopi-f47t.52.228.10: a quoted title routes one each row and only from the commit that adds it', () => {
    let [status, out] = gate({ [ROWS_FILE]: rows('[1]') + ANYTHING }, "test(frontend): 'anything' replaces rows")
    expect(status, out).toBe(1)
    expect(out.split('vitest list: gate-test-deleted').length - 1, out).toBe(1)
    repo.at(repo.base);
    [status, out] = gate({ [ROWS_FILE]: rows('[1, 2]') + ANYTHING }, "test(frontend): 'anything' replaces row 3")
    expect(status, out).toBe(0)
    repo.at(repo.base)
    repo.write({ [ROWS_FILE]: rows('[1, 2]') })
    repo.commit("test(frontend): 'anything' replaces row 3")
    repo.write({ [ROWS_FILE]: rows('[1, 2]') + ANYTHING });
    [status, out] = repo.pr(repo.commit('test(frontend): add a test'), repo.base, '--vitest')
    expect(status, out).toBe(1)
    expect(out).toContain("vitest list: gate-test-deleted: 'keeps row 3'")
  })

  it('canopi-f47t.52.228.10: Rewords-test in the vitest pass needs its new title added in the same file', () => {
    const message = 'test(frontend): reword row 3\n\nRewords-test: keeps row 3 -> holds row 3\n'
    let [status, out] = gate({ [ROWS_FILE]: rows('[1, 2]') }, message)
    expect(status, out).toBe(1)
    expect(out).toContain("vitest list: gate-test-deleted: 'keeps row 3'")
    repo.at(repo.base);
    [status, out] = gate({ [ROWS_FILE]: rows('[1, 2]'),
      'desktop/web/src/held.test.ts': "import { expect, it } from 'vitest'\n\nit('holds row 3', () => {\n  expect(3).toBe(3)\n})\n" }, message)
    expect(status, out).toBe(1)
    expect(out).toContain("vitest list: gate-test-deleted: 'keeps row 3'")
  })

  it('canopi-f47t.52.228.10: a head test file reading a tree outside desktop/web is listed there, its titles never lost', () => {
    // file-format-round-trip.test.ts reads canopi-types/ at collection: the head lists from the whole tree, as the base.
    repo.write({ 'canopi-types/x.json': '{"n": 3}\n' })
    repo.base = repo.commit('chore: a shared contract')
    const read = "import { readFileSync } from 'node:fs'\nconst n = JSON.parse(readFileSync(new URL('../../../canopi-types/x.json', import.meta.url), 'utf8')).n\n"
    const [status, out] = gate({ [ROWS_FILE]: read + rows('[1, 2, n]') }, 'test(frontend): row three from the contract')
    expect(status, out).toBe(0)
    expect(out).not.toContain('gate-test-deleted')
  })

  it('canopi-f47t.52.228.10: a head test file vitest cannot list is named in a note, its titles never counted lost', () => {
    const [status, out] = gate({ [ROWS_FILE]: `throw new Error('no collection')\n${ROWS}` }, 'test(frontend): break collection')
    expect(out).not.toContain('vitest list: gate-test-deleted')
    expect(out).toContain('vitest list could not read these at head; the per-commit reading stands for them: src/rows.test.ts')
    expect(status, out).toBe(0)
  })

  it('canopi-f47t.52.228.54: a title a merged branch lost is judged like any other: no commit is before the gate', () => {
    // Retires-test: 'test_canopi_f47t_52_228_10_a_title_lost_before_the_gate_is_listed_and_one_lost_after_it_refused'
    // listed a title lost before the gate; every commit is judged now (design check A3), so this replaces it.
    repo.git('checkout', '-q', '-b', 'side')
    repo.write({ [ROWS_FILE]: rows('[1, 2]') })
    repo.commit('test(frontend): row 3 goes on a side branch')
    repo.git('checkout', '-q', '--detach', repo.base)
    repo.write({ 'notes.txt': 'x\n' })
    repo.commit('docs: notes')
    repo.git('-c', 'core.hooksPath=/dev/null', 'merge', '-q', '--no-ff', '-m', "Merge branch 'side'", 'side')
    const [status, out] = repo.pr(repo.git('rev-parse', 'HEAD'), repo.base, '--vitest')
    expect(status, out).toBe(1)
    expect(out).toContain("vitest list: gate-test-deleted: 'keeps row 3'")
    expect(out.split('\n').filter((line) => line.startsWith('before the gate'))).toEqual([])
  })
})

describe('one loss router for both passes (canopi-f47t.52.228.51)', () => {
  it('canopi-f47t.52.228.51: a frontend test of documentation only retires in both passes (2.1-M329)', () => {
    const prose = "import { readFileSync } from 'node:fs'\nimport { expect, it } from 'vitest'\n\n"
      + "it('names the guide', () => {\n  expect(readFileSync('docs/guides/x.md', 'utf8')).toContain('knob')\n})\n"
    repo.write({ 'desktop/web/src/guide.test.ts': `${prose}\nit('stays', () => {\n  expect(1).toBe(1)\n})\n` })
    repo.base = repo.commit('test(frontend): a guide test')
    const [status, out] = gate({ 'desktop/web/src/guide.test.ts': prose.split("it('names")[0] + "it('stays', () => {\n  expect(1).toBe(1)\n})\n" },
      'test(frontend): retire\n\nRetires-test: names the guide — the guide test checked prose no user sees')
    expect(status, out).toBe(0)
  })

  it('canopi-f47t.52.228.51: Rewords-test folds a test into a kept one in both passes only when it grows enough (2.1-M330)', () => {
    const message = 'test(frontend): fold\n\nRewords-test: keeps the second behaviour -> keeps the first behaviour'
    const alone = KEPT.split("it('keeps the second")[0] ?? ''
    let [status, out] = gate({ [KEPT_FILE]: alone.replace('  expect(2).toBe(2)\n', '  expect(2).toBe(2)\n  expect(3).toBe(3)\n') }, message)
    expect(status, out).toBe(0)
    repo.at(repo.base);
    [status, out] = gate({ [KEPT_FILE]: alone }, message)
    expect(status, out).toBe(1)
    expect(out).toContain('vitest list: gate-test-reworded')
    expect(out).toMatch(/^[0-9a-f]{9} test\(frontend\): fold: gate-test-reworded/mu)
  })

  it('canopi-f47t.52.228.51: a quoted replacement with fewer assertions is refused in both passes', () => {
    const weaker = KEPT.replace("it('keeps the second behaviour', () => {\n  expect(3).toBe(3)\n})", "it('keeps the third behaviour', () => {\n  check(3)\n})")
    const [status, out] = gate({ [KEPT_FILE]: weaker }, "test(frontend): replace\n\nThe new test 'keeps the third behaviour' holds it.")
    expect(status, out).toBe(1)
    expect(out).toContain("vitest list: gate-test-deleted: desktop/web/src/kept.test.ts: 'keeps the second behaviour' is replaced by")
    expect(out).toMatch(/^[0-9a-f]{9} test\(frontend\): replace: gate-test-deleted: .*which has fewer assertions/mu)
  })
})
