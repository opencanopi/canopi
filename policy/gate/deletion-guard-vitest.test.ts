// The deletion guard's Vitest pass (`commit-gate pr --vitest`; 2.1-M199, 2.1-Q224, 2.1-Q267, 2.1-Q272;
// canopi-f47t.52.228.10, canopi-f47t.52.228.51): `vitest list --staticParse=false`, base against head, sees the `.each`
// rows the static reading takes as one title; a file it lists is read by it alone, and each lost title is routed by the
// same loss router as the static reading, from any commit message of the range.
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
// A test that plants no repository leaves none to clean up, in any order the seed shuffles (canopi-f47t.52.228.54).
afterEach(() => {
  repo?.cleanup()
  repo = undefined as never
})

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

  it('canopi-f47t.52.240: a Q row routes a vitest list loss only from a commit that touched its file or a PR body line naming it', () => {
    let [status, out] = gate({ [ROWS_FILE]: rows('[1, 2]') }, 'test(frontend): keeps row 3 goes', `docs: an unrelated settlement (${Q_ROW})`)
    expect(status, out).toBe(1)
    expect(out).toContain("'keeps row 3'")
    const head = repo.git('rev-parse', 'HEAD')
    const body = (text: string) => repo.gate(['pr', repo.base, head, '--vitest', '--body-env', 'PR_BODY'], { PR_BODY: text })
    let run = body(`Settles the plan (${Q_ROW}).\n`)
    expect(run.status, run.stdout).toBe(1)
    run = body(`The third row of rows.test.ts goes (${Q_ROW}).\n`)
    expect(run.status, run.stdout).toBe(0)
    repo.at(repo.base);
    [status, out] = gate({ [ROWS_FILE]: rows('[1, 2]') }, `test(frontend): keeps row 3 goes (${Q_ROW})`)
    expect(status, out).toBe(0)
  })

  it('canopi-f47t.52.240: a quoted title routes one each row, quoted in any commit of the range', () => {
    let [status, out] = gate({ [ROWS_FILE]: rows('[1]') + ANYTHING }, "test(frontend): 'anything' replaces rows")
    expect(status, out).toBe(1)
    expect(out.split('vitest list: gate-test-deleted').length - 1, out).toBe(1)
    repo.at(repo.base)
    repo.write({ [ROWS_FILE]: rows('[1, 2]') })
    repo.commit("test(frontend): 'anything' replaces row 3")
    repo.write({ [ROWS_FILE]: rows('[1, 2]') + ANYTHING });
    [status, out] = repo.pr(repo.commit('test(frontend): add a test'), repo.base, '--vitest')
    expect(status, out).toBe(0)
  })

  it('canopi-f47t.52.240: a title two changed files share is judged lost only in the file its count fell in', () => {
    const renders = "import { expect, it } from 'vitest'\n\nit('renders', () => {\n  expect(1).toBe(1)\n})\n"
    const A = 'desktop/web/src/panel-a.test.ts'
    const B = 'desktop/web/src/panel-b.test.ts'
    repo.write({ [A]: renders, [B]: renders })
    repo.base = repo.commit('test(frontend): two panels')
    const [status, out] = gate({ [A]: renders.replace("'renders'", "'draws the panel'"), [B]: renders + ANYTHING },
      "test(frontend): 'draws the panel' replaces it")
    expect(out).not.toContain('gate-test-')
    expect(status, out).toBe(0)
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
    expect(out).toContain('vitest list could not read these at head; the static reading stands for them: src/rows.test.ts')
    expect(status, out).toBe(0)
  })

  it('canopi-f47t.52.36: a quoted replacement routes the loss in its own file first, never one an earlier file lost', () => {
    // Phase 1's range: a test lost with no route in an earlier file took a later file's quoted replacement, and the
    // loss that quote named was refused instead of the unrouted one.
    const one = (title: string) => `import { expect, it } from 'vitest'\n\nit('${title}', () => {\n  expect(1).toBe(1)\n})\n`
    repo.write({ 'desktop/web/src/a.test.ts': one('old a') + ANYTHING.replace('anything', 'keeps a'), 'desktop/web/src/b.test.ts': one('old b') })
    repo.base = repo.commit('test(frontend): two files')
    const [status, out] = gate({ 'desktop/web/src/a.test.ts': "import { expect, it } from 'vitest'\n" + ANYTHING.replace('anything', 'keeps a'), 'desktop/web/src/b.test.ts': one('new b') },
      "test(frontend): 'new b' replaces 'old b'")
    expect(status, out).toBe(1)
    expect(out, out).toContain("'old a'")
    expect(out, out).not.toContain("'old b'")
  })

  it('canopi-f47t.52.36: a test moved under another describe keeps its own quoted title, never one an unrouted loss takes', () => {
    const block = (group: string, title: string) =>
      `import { describe, expect, it } from 'vitest'\n\ndescribe('${group}', () => {\n  it('${title}', () => {\n    expect(1).toBe(1)\n  })\n})\n`
    repo.write({ 'desktop/web/src/w.test.ts': block('Lost', 'early') + ANYTHING, 'desktop/web/src/x.test.ts': block('a', 'moved') + ANYTHING.replace('anything', 'keeps x') })
    repo.base = repo.commit('test(frontend): three files')
    const [status, out] = gate({
      'desktop/web/src/w.test.ts': "import { expect, it } from 'vitest'\n" + ANYTHING,
      'desktop/web/src/x.test.ts': "import { expect, it } from 'vitest'\n" + ANYTHING.replace('anything', 'keeps x'),
      'desktop/web/src/y.test.ts': block('z', 'moved'),
    }, "test(frontend): 'moved' moves to y")
    expect(status, out).toBe(1)
    expect(out, out).toContain("'Lost > early'")
    expect(out, out).not.toContain('moved')
  })

  it('canopi-f47t.52.240: a src test replaced by a quoted title under scripts/ passes the vitest list pass', () => {
    // The web Vitest project runs desktop/web's every test file, scripts/ and vite.config.test.ts beside src/: a
    // replacement there is listed as added, so the deleting commit's quote routes the loss (CI run 42117580716).
    const three = "import { expect, it } from 'vitest'\n\nit('holds row three', () => {\n  expect(3).toBe(3)\n})\n"
    const [status, out] = gate({ [ROWS_FILE]: rows('[1, 2]'), 'desktop/web/scripts/row-three.test.ts': three },
      "test(frontend): row three is checked by its script\n\nIts replacement 'holds row three' holds it.")
    expect(out).not.toContain('gate-test-deleted')
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

  it('canopi-f47t.52.240: Rewords-test folds a test into a kept one in its file with no assertion count, its file read once (2.1-Q272)', () => {
    const message = 'test(frontend): fold\n\nRewords-test: keeps the second behaviour -> keeps the first behaviour'
    const alone = KEPT.split("it('keeps the second")[0] ?? ''
    let [status, out] = gate({ [KEPT_FILE]: alone }, message)
    expect(out).not.toContain('gate-test-')
    expect(status, out).toBe(0)
    repo.at(repo.base);
    [status, out] = gate({ [KEPT_FILE]: alone }, 'test(frontend): fold\n\nRewords-test: keeps the second behaviour -> keeps row %i')
    expect(status, out).toBe(1)
    expect(out).toContain('vitest list: gate-test-')
    expect(out).not.toMatch(/^range [0-9a-f]{9}\.\.[0-9a-f]{9}: gate-test-/mu)
  })

  it('canopi-f47t.52.240: a quoted replacement with fewer assertions routes its deleted test in both passes (2.1-Q272)', () => {
    const weaker = KEPT.replace("it('keeps the second behaviour', () => {\n  expect(3).toBe(3)\n})", "it('keeps the third behaviour', () => {\n  check(3)\n})")
    const [status, out] = gate({ [KEPT_FILE]: weaker }, "test(frontend): replace\n\nThe new test 'keeps the third behaviour' holds it.")
    expect(out).not.toContain('gate-test-deleted')
    expect(out).not.toContain('fewer assertions')
    expect(status, out).toBe(0)
  })

  it('canopi-f47t.52.240: an .each template reworded is read once, its rows routed by the Rewords-test naming the templates', () => {
    const message = 'test(frontend): a better name\n\nRewords-test: keeps row %i -> holds row %i'
    let [status, out] = gate({ [ROWS_FILE]: ROWS.replace('keeps row %i', 'holds row %i') }, message)
    expect(out).not.toContain('gate-test-')
    expect(status, out).toBe(0)
    repo.at(repo.base);
    [status, out] = gate({ [ROWS_FILE]: ROWS.replace('keeps row %i', 'holds row %i') }, 'test(frontend): a better name')
    expect(status, out).toBe(1)
    expect(out).toContain("vitest list: gate-test-reworded: 'keeps row 1' looks reworded")
    expect(out).not.toMatch(/^range [0-9a-f]{9}\.\.[0-9a-f]{9}: gate-test-/mu)
  })
})
