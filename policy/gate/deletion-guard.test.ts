// The test-deletion guard (policy/gate/deletion-guard.ts through the commit gate; 2.1-Q224, 2.1-M199, 2.1-Q267;
// canopi-f47t.52.228.10, canopi-f47t.52.228.54): the routes for a deleted test (a quoted new test, a merge-base Q row,
// `Retires-test` with the code deleted or a test of documentation only), rewording, loosening, skips and moves, each a
// commit range judged by `commit-gate pr`; then the reading of test titles and bodies, unit by unit.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLOSED_BEAD, GateRepo, KEPT, OPEN_BEAD, Q_ROW } from './commit-gate-repo.ts'
import { judge, type TestFile } from './deletion-guard.ts'
import { type Finding, tests } from './test-reader.ts'

// Spelled in two parts so the flake-quarantine adapter never reads this file's source as a marker.
const MARKER = `flake-${'quarantine:'}`
const FIRST_ONLY = KEPT.split("it('keeps the second")[0] ?? ''

let repo: GateRepo
// A test that plants no repository leaves none to clean up, in any order the seed shuffles (canopi-f47t.52.228.54).
afterEach(() => {
  repo?.cleanup()
  repo = undefined as never
})

/** `text` as desktop/web/src/a.test.ts (and `extra`) committed with `message`, judged against the base. */
const judged = (text: string, message: string, extra: Record<string, string> = {}): [number | null, string] => {
  repo.write({ 'desktop/web/src/a.test.ts': text, ...extra })
  return repo.pr(repo.commit(message))
}
const red = ([status, out]: [number | null, string], rule: string) => {
  expect(status, out).toBe(1)
  expect(out).toContain(rule)
}
const green = ([status, out]: [number | null, string]) => expect(status, out).toBe(0)

describe('a commit range through the gate (2.1-Q224)', () => {
  beforeEach(() => {
    repo = new GateRepo()
    repo.write({ 'desktop/web/src/a.test.ts': KEPT })
    repo.base = repo.commit('test(frontend): two behaviours')
  })

  it('canopi-f47t.52.228.10: a deleted test with no route is refused', () => {
    red(judged(FIRST_ONLY, 'test(frontend): drop one'), 'gate-test-deleted')
  })

  it('canopi-f47t.52.228.10: a reworded title without Rewords-test is refused', () => {
    red(judged(KEPT.replace('keeps the second behaviour', 'keeps behaviour two'), 'test(frontend): reword'), 'gate-test-reworded')
  })

  it('canopi-f47t.52.228.10: a reworded title with Rewords-test passes', () => {
    green(judged(KEPT.replace('keeps the second behaviour', 'keeps behaviour two'),
      'test(frontend): reword\n\nRewords-test: keeps the second behaviour -> keeps behaviour two'))
  })

  it('canopi-f47t.52.254: a title holding an escaped quote is read unescaped, so a trailer names it plainly', () => {
    const escaped = KEPT.replace("'keeps the second behaviour'", "'keeps the second behaviour\\'s order'")
    repo.write({ 'desktop/web/src/a.test.ts': escaped })
    repo.base = repo.commit('test(frontend): an escaped quote')
    green(judged(escaped.replace("behaviour\\'s order", "behaviour\\'s ordering"),
      "test(frontend): reword\n\nRewords-test: keeps the second behaviour's order -> keeps the second behaviour's ordering"))
  })

  it('canopi-f47t.52.228.10: a removed expect in a kept test is refused', () => {
    red(judged(KEPT.replace('  expect(2).toBe(2)\n', ''), 'test(frontend): fewer asserts'), 'gate-test-loosened')
  })

  it('canopi-f47t.52.228.10: a moved test passes', () => {
    const second = `import { expect, it } from 'vitest'\n\nit('keeps the second${KEPT.split("it('keeps the second")[1] ?? ''}`
    green(judged(FIRST_ONLY, 'test(frontend): move', { 'desktop/web/src/b.test.ts': second }))
  })

  it('canopi-f47t.52.228.10: a deleted test whose replacement the message names passes', () => {
    green(judged(KEPT.replace('keeps the second behaviour', 'keeps the third behaviour'),
      "test(frontend): replace\n\nThe new test 'keeps the third behaviour' holds it."))
  })

  it('canopi-f47t.52.228.10: a deleted test citing a merge-base Q row passes', () => {
    green(judged(FIRST_ONLY, `test(frontend): drop one (${Q_ROW})`))
  })

  it('canopi-f47t.52.228.10: Retires-test with the code under test deleted passes', () => {
    repo.write({ 'desktop/web/src/b.ts': 'export const b = 1\nexport const c = 2\n',
      'desktop/web/src/b.test.ts': "import { expect, it } from 'vitest'\nimport { b, c } from './b'\n\n"
        + "it('reads b', () => {\n  expect(b).toBe(1)\n})\n\nit('reads c', () => {\n  expect(c).toBe(2)\n})\n" })
    const base = repo.commit('test(frontend): b and c')
    repo.write({ 'desktop/web/src/b.ts': 'export const b = 1\n',
      'desktop/web/src/b.test.ts': "import { expect, it } from 'vitest'\nimport { b } from './b'\n\nit('reads b', () => {\n  expect(b).toBe(1)\n})\n" })
    green(repo.pr(repo.commit('refactor(frontend): drop c\n\nRetires-test: reads c — nothing reads c'), base))
  })

  it('canopi-f47t.52.228.10: Retires-test without deleting the code under test is refused', () => {
    red(judged(FIRST_ONLY, 'test(frontend): drop one\n\nRetires-test: keeps the second behaviour — no user sees it'), 'gate-test-deleted')
  })

  it('canopi-f47t.52.228.10: a reworded title moved to another file is refused', () => {
    const second = "import { expect, it } from 'vitest'\n\nit('keeps behaviour two', () => {\n  expect(3).toBe(3)\n})\n"
    red(judged(FIRST_ONLY, 'test(frontend): reword\n\nRewords-test: keeps the second behaviour -> keeps behaviour two',
      { 'desktop/web/src/b.test.ts': second }), 'gate-test-reworded')
  })

  it('canopi-f47t.52.240: Rewords-test folds a test into a kept one in its file with no assertion count; another file is refused (2.1-Q272)', () => {
    const message = 'test(frontend): fold\n\nRewords-test: keeps the second behaviour -> keeps the first behaviour'
    green(judged(FIRST_ONLY, message))
    repo.at(repo.base)
    const other = "import { expect, it } from 'vitest'\n\nit('elsewhere', () => {\n  expect(0).toBe(0)\n})\n"
    repo.write({ 'desktop/web/src/b.test.ts': other })
    repo.base = repo.commit('test(frontend): elsewhere')
    red(judged(FIRST_ONLY, message.replace('keeps the first behaviour', 'elsewhere'),
      { 'desktop/web/src/b.test.ts': other.replace('  expect(0)', '  expect(3).toBe(3)\n  expect(0)') }), 'gate-test-reworded')
  })

  it('canopi-f47t.52.240: a reworded title with fewer assertions routes, as a quoted title does (2.1-Q272)', () => {
    const text = KEPT.replace('keeps the first behaviour', 'keeps behaviour one').replace('  expect(2).toBe(2)\n', '')
    green(judged(text, 'test(frontend): reword\n\nRewords-test: keeps the first behaviour -> keeps behaviour one'))
  })

  it('canopi-f47t.52.240: a quoted replacement routes its deleted test whatever its assertions count (2.1-Q272)', () => {
    const text = KEPT.replace("it('keeps the second behaviour', () => {\n  expect(3).toBe(3)\n})",
      "it('keeps the third behaviour', () => {\n  check(3)\n})")
    green(judged(text, "test(frontend): replace\n\nThe new test 'keeps the third behaviour' holds it."))
  })

  it('canopi-f47t.52.228.10: a matcher swap from the closed list is refused', () => {
    red(judged(KEPT.replace('expect(3).toBe(3)', 'expect(3).toBeTruthy()'), 'test(frontend): looser'), 'gate-test-loosened')
  })

  it('canopi-f47t.52.228.10: a new skip without a route is refused', () => {
    red(judged(KEPT.replace("it('keeps the second", "it.skip('keeps the second"), 'test(frontend): skip'), 'gate-test-loosened')
  })

  const quarantine = (entries: Record<string, unknown>) => {
    const family = repo.json('policy/ratchets/flake-quarantine.json')
    family['entries'] = entries
    return { 'policy/ratchets/flake-quarantine.json': `${JSON.stringify(family, null, 2)}\n` }
  }

  it('canopi-f47t.52.228.10: a flake-quarantine skip with its entry and open bead passes', () => {
    const skipped = KEPT.replace("it('keeps the second", `// ${MARKER} ${OPEN_BEAD}\nit.skip('keeps the second`)
    green(judged(skipped, `test(frontend): quarantine a flake (${OPEN_BEAD})`,
      quarantine({ 'desktop/web/src/a.test.ts': { count: 1, bead: OPEN_BEAD } })))
  })

  it('canopi-f47t.52.228.10: a flake-quarantine marker naming no bead or a closed one is refused', () => {
    for (const [marker, bead] of [[`// ${MARKER}`, OPEN_BEAD], [`// ${MARKER} ${CLOSED_BEAD}`, CLOSED_BEAD]] as const) {
      const skipped = KEPT.replace("it('keeps the second", `${marker}\nit.skip('keeps the second`)
      red(judged(skipped, `test(frontend): quarantine (${bead})`, quarantine({ 'desktop/web/src/a.test.ts': { count: 1, bead } })),
        'gate-test-loosened')
      repo.write({ 'desktop/web/src/a.test.ts': KEPT, ...quarantine({}) })
      repo.base = repo.commit('test(frontend): restore')
    }
  })

  it('canopi-f47t.52.228.10: a deleted Rust test and a removed Python assert are refused', () => {
    const rust = '#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {\n        assert_eq!(1 + 1, 2);\n    }\n}\n'
    const python = 'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_adds(self):\n        self.assertEqual(1 + 1, 2)\n'
      + '        self.assertTrue(True)\n'
    repo.write({ 'desktop/src/a.rs': rust, 'scripts/test_a.py': python })
    const base = repo.commit('test: rust and python')
    repo.write({ 'desktop/src/a.rs': '#[cfg(test)]\nmod tests {}\n', 'scripts/test_a.py': python.replace('        self.assertTrue(True)\n', '') })
    const result = repo.pr(repo.commit('test: fewer'), base)
    red(result, 'gate-test-deleted')
    expect(result[1]).toContain('gate-test-loosened')
  })

  const MEMBERS = ["it('lists', () => {\n  const got = list()\n  expect(got).toContain('a')\n  expect(got).not.toContain('b')\n"
    + '  expect(size).toBe(1)\n})\n',
  "import unittest\n\n\nclass T(unittest.TestCase):\n    def test_lists(self):\n        got = listed()\n"
    + "        self.assertIn('a', got)\n        self.assertNotIn('b', got)\n        self.assertTrue(size)\n"] as const
  const TS_MEMBERS = "  expect(got).toContain('a')\n  expect(got).not.toContain('b')\n"
  const PY_MEMBERS = "        self.assertIn('a', got)\n        self.assertNotIn('b', got)\n"
  const stricter = (after: readonly [string, string]) => {
    repo.write({ 'desktop/web/src/b.test.ts': MEMBERS[0], 'scripts/test_b.py': MEMBERS[1] })
    const base = repo.commit('test: membership asserts')
    repo.write({ 'desktop/web/src/b.test.ts': after[0], 'scripts/test_b.py': after[1] })
    return repo.pr(repo.commit('test: one whole-value equality'), base)
  }

  it('canopi-f47t.52.228.10: a whole-value equality replacing membership asserts on it passes', () => {
    green(stricter([MEMBERS[0].replace(TS_MEMBERS, "  expect(got).toStrictEqual(['a'])\n"),
      MEMBERS[1].replace(PY_MEMBERS, "        self.assertEqual(got, ['a'])\n")]))
  })

  it('canopi-f47t.52.228.10: membership asserts dropped without an equality on that value are refused', () => {
    const cases: [string, string][] = [
      [MEMBERS[0].replace("  expect(got).not.toContain('b')\n", ''), MEMBERS[1]],
      [MEMBERS[0].replace(TS_MEMBERS, "  expect(other).toEqual(['a'])\n"), MEMBERS[1].replace(PY_MEMBERS, "        self.assertEqual(other, ['a'])\n")],
      [MEMBERS[0].replace(`${TS_MEMBERS}  expect(size).toBe(1)\n`, "  expect(got).toEqual(['a'])\n"), MEMBERS[1]],
    ]
    for (const after of cases) {
      repo.at(repo.base)
      red(stricter(after), 'gate-test-loosened')
    }
  })

  it('canopi-f47t.52.228.10: naming a new title excuses only the test it replaces', () => {
    // A title in the subject is no route; a quoted replacement routes one deletion and keeps its assertions.
    const text = KEPT.replace('keeps the first behaviour', 'keeps behaviour').replace('  expect(2).toBe(2)\n', '')
      .replace('expect(1).toBe(1)', 'expect(1).toBeTruthy()').replace('expect(3).toBe(3)', 'expect(3).toBeTruthy()')
    let result = judged(text, 'test(frontend): keeps behaviour')
    red(result, 'gate-test-reworded')
    expect(result[1]).toContain("gate-test-loosened: desktop/web/src/a.test.ts: 'keeps the second behaviour'")
    repo.at(repo.base)
    result = judged(text, "test(frontend): replace it\n\nThe new test 'keeps behaviour' holds it.")
    red(result, 'gate-test-loosened')
    expect(result[1]).not.toContain('gate-test-deleted')
    expect(result[1]).toContain("gate-test-loosened: desktop/web/src/a.test.ts: 'keeps the second behaviour'")
  })

  it('canopi-f47t.52.228.10: Retires-test passes an inline Rust test deleted with its function', () => {
    const rust = 'pub fn kept() {}\n\npub fn gone() -> u8 {\n    1\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n'
      + '    #[test]\n    fn gone_works() {\n        assert_eq!(gone(), 1);\n    }\n}\n'
    repo.write({ 'desktop/src/lib.rs': rust })
    const base = repo.commit('test: gone')
    const code = rust.split('\n\n#[cfg(test)]')[0] ?? ''
    for (const [head, status] of [[`${code.replace('\n\npub fn gone() -> u8 {\n    1\n}', '')}\n#[cfg(test)]\nmod tests {}\n`, 0],
      [`${code}\n#[cfg(test)]\nmod tests {}\n`, 1]] as const) {
      repo.at(base)
      repo.write({ 'desktop/src/lib.rs': head })
      const [got, out] = repo.pr(repo.commit('refactor: drop gone\n\nRetires-test: gone_works — nothing calls gone'), base)
      expect(got, out).toBe(status)
    }
  })

  it('canopi-f47t.52.228.10: Retires-test passes an e2e spec deleted with its feature code', () => {
    const spec = "import { expect, test } from '@playwright/test'\n\ntest('opens the panel', async ({ page }) => {\n  expect(page).toBeTruthy()\n})\n"
    repo.write({ 'desktop/web/e2e/canvas/panel.spec.ts': spec, 'desktop/web/src/app/panel.ts': 'export const panel = 1\n' })
    const base = repo.commit('test(frontend): panel')
    for (const [extra, status] of [[{ 'desktop/web/src/app/panel.ts': '' }, 0], [{}, 1]] as const) {
      repo.at(base)
      repo.write({ 'desktop/web/e2e/canvas/panel.spec.ts': '', ...extra })
      const [got, out] = repo.pr(repo.commit('refactor(frontend): drop the panel\n\nRetires-test: opens the panel — the panel is gone'), base)
      expect(got, out).toBe(status)
    }
  })
})

describe('the code under test (contracts §12; 2.1-Q224)', () => {
  // Retires-test needs the code the test covered deleted: its own module's code lines, not a test helper, a rename or
  // a sibling file.
  beforeEach(() => {
    repo = new GateRepo()
  })

  const retire = (base: Record<string, string>, head: Record<string, string>, title: string, renames: [string, string][] = []) => {
    repo.at(repo.base)
    repo.write(base)
    const start = repo.commit('test: base')
    repo.write(head)
    for (const [from, to] of renames) repo.git('mv', from, to)
    return repo.pr(repo.commit(`refactor: retire\n\nRetires-test: ${title} — gone`), start)
  }

  it("canopi-f47t.52.228.10: Retires-test in a Rust test module needs its parent module's code deleted", () => {
    const parent = 'pub fn load() -> u8 {\n    7\n}\n\npub fn kept() {}\n\n#[cfg(test)]\nmod tests;\n'
    const kept = 'use super::*;\n\n#[test]\nfn other() {\n    kept();\n}\n'
    const base = { 'desktop/src/design/mod.rs': parent, 'desktop/src/design/tests.rs':
      `use super::*;\n\nfn fixture() -> u8 {\n    load()\n}\n\n#[test]\nfn loads() {\n    assert_eq!(fixture(), 7);\n}\n\n${kept.slice('use super::*;\n\n'.length)}` }
    red(retire(base, { 'desktop/src/design/tests.rs': kept }, 'loads'), 'gate-test-deleted')
    green(retire(base, { 'desktop/src/design/tests.rs': kept,
      'desktop/src/design/mod.rs': parent.replace('pub fn load() -> u8 {\n    7\n}\n\n', '') }, 'loads'))
  })

  it('canopi-f47t.52.240: Retires-test in a test-only policy module passes when that module deletes its own code', () => {
    // A `#[cfg(test)] mod policy;` whose tests sit in its own inline `#[cfg(test)] mod tests` covers its own code (as
    // native_command_policy.rs does), never a helper of a test file: deleting that code retires its test.
    const root = 'pub fn run() {}\n\n#[cfg(test)]\nmod policy;\n'
    const test = (fn: string) => `    #[test]\n    fn ${fn}_holds() {\n        assert!(${fn}(1));\n    }\n`
    const policy = (fns: string[]) => `${fns.map((fn) => `fn ${fn}(n: u8) -> bool {\n    n == 1\n}\n\n`).join('')}`
      + `#[cfg(test)]\nmod tests {\n    use super::*;\n\n${fns.map(test).join('\n')}}\n`
    const base = { 'desktop/src/lib.rs': root, 'desktop/src/policy.rs': policy(['audit', 'scan']) }
    green(retire(base, { 'desktop/src/policy.rs': policy(['audit']) }, 'scan_holds'))
    red(retire(base, { 'desktop/src/policy.rs': policy(['audit', 'scan']).replace(test('scan'), '') }, 'scan_holds'), 'gate-test-deleted')
  })

  it("canopi-f47t.52.228.10: Retires-test is refused for a sibling file's rename or a moved module", () => {
    const spec = "import { expect, it } from 'vitest'\nimport { panel } from './panel'\n\n"
      + "it('opens the panel', () => {\n  expect(panel).toBe(1)\n})\n\nit('stays', () => {\n  expect(1).toBe(1)\n})\n"
    const kept = `${spec.split("it('opens the panel'")[0] ?? ''}it('stays', () => {\n  expect(1).toBe(1)\n})\n`
    const base = { 'desktop/web/src/app/panel.ts': 'export const panel = 1\nexport const other = 2\n',
      'desktop/web/src/app/format.ts': 'const a = 1\nexport { a }\n', 'desktop/web/src/app/panel.test.ts': spec }
    const cases: [Record<string, string>, [string, string][], number][] = [
      [{ 'desktop/web/src/app/format.ts': 'const b = 1\nexport { b }\n' }, [], 1],
      [{}, [['desktop/web/src/app/panel.ts', 'desktop/web/src/app/panel-view.ts']], 1],
      [{ 'desktop/web/src/app/panel.ts': 'export const other = 2\n' }, [], 0]]
    for (const [extra, renames, want] of cases) {
      const [status, out] = retire(base, { 'desktop/web/src/app/panel.test.ts': kept, ...extra }, 'opens the panel', renames)
      expect(status, out).toBe(want)
    }
  })

  it('canopi-f47t.52.228.10: Retires-test on an e2e spec is refused when only an unrelated src line changes', () => {
    const spec = "import { expect, test } from '@playwright/test'\n\ntest('follows me', async ({ page }) => {\n  expect(page).toBeTruthy()\n})\n"
    const base = { 'desktop/web/e2e/canvas/my-location.spec.ts': spec, 'desktop/web/src/app/x.ts': 'export const a = 1\nexport const b = 2\n' }
    for (const [src, want] of [['export const a = 2\nexport const b = 2\n', 1], ['export const b = 2\n', 1], ['', 0]] as const) {
      const [status, out] = retire(base, { 'desktop/web/e2e/canvas/my-location.spec.ts': '', 'desktop/web/src/app/x.ts': src }, 'follows me')
      expect(status, out).toBe(want)
    }
  })

  it('canopi-f47t.52.228.10: Retires-test in a Rust integration test is refused for a helper deleted beside it', () => {
    // An integration test covers its package's src/: deleting a helper fn from its own file deletes nothing it covered.
    const kept = '#[test]\nfn other() {\n    assert_eq!(1, 1);\n}\n'
    const base = { 'desktop/tests/io.rs': `fn helper() -> u8 {\n    7\n}\n\n#[test]\nfn loads() {\n    assert_eq!(helper(), 7);\n}\n\n${kept}`,
      'desktop/src/io.rs': 'pub fn load() -> u8 {\n    7\n}\n' }
    red(retire(base, { 'desktop/tests/io.rs': kept }, 'loads'), 'gate-test-deleted')
    green(retire(base, { 'desktop/tests/io.rs': kept, 'desktop/src/io.rs': '' }, 'loads'))
  })

  it('canopi-f47t.52.228.10: Retires-test routes a test whose only subject is a documentation file (2.1-M329)', () => {
    // A test reading only guide prose covers no code; one that also names a code path or uses a name imported from
    // repository code still needs that code deleted.
    const head = 'import unittest\n\nclass T(unittest.TestCase):\n    def test_kept(self):\n        self.assertTrue(1)\n'
    const doc = 'guide = (ROOT / "docs/guides/agentic-delivery.md").read_text()\n        self.assertIn("knob", guide)'
    const cases: [string, string, number][] = [[doc, '', 0], ['readme = Path("README.md").read_text()\n        self.assertIn("x", readme)', '', 0],
      [`${doc}\n        self.assertTrue((ROOT / "scripts/gate.py").exists())`, '', 1],
      [`${doc}\n        self.assertEqual(gate.KNOB, 1)`, 'from scripts import gate\n', 1],
      [`${doc}\n        self.assertTrue(self.gate.run())`, '', 1], ['self.assertEqual(1, 1)', '', 1]]
    for (const [body, imports, want] of cases) {
      const base = `${head.replace('import unittest\n', `import unittest\n${imports}`)}\n    def test_reads_the_guide(self):\n        ${body}\n`
      const [status, out] = retire({ 'scripts/test_guide.py': base }, { 'scripts/test_guide.py': head }, 'test_reads_the_guide')
      expect(status, out).toBe(want)
    }
    const spec = "import { readFileSync } from 'node:fs'\nimport { expect, it } from 'vitest'\nimport { panel } from './panel'\n\n"
      + "it('names the guide', () => {\n  expect(readFileSync('docs/guides/x.md', 'utf8')).toContain(panel)\n})\n"
    red(retire({ 'desktop/web/src/guide.test.ts': spec }, { 'desktop/web/src/guide.test.ts': '' }, 'names the guide'), 'gate-test-deleted')
    const prose = "import { readFileSync } from 'node:fs'\nimport { expect, it } from 'vitest'\n\n"
      + "it('names the guide', () => {\n  expect(readFileSync('docs/guides/x.md', 'utf8')).toContain('knob')\n})\n"
    green(retire({ 'desktop/web/src/guide.test.ts': prose }, { 'desktop/web/src/guide.test.ts': '' }, 'names the guide'))
  })
})

const judgeOne = async (message: string, old: string, now: string, files?: TestFile[]): Promise<Finding[]> =>
  judge(files ?? [['a.test.ts', 'a.test.ts', old, now]], message, {
    authorised: () => false, strictRewords: true, deletedCode: new Map(), quarantined: new Map(), beadOpen: async () => true,
    read: async () => undefined, pyModules: new Set(),
  })
const rules = async (message: string, old: string, now: string) => [...new Set((await judgeOne(message, old, now)).map(([rule]) => rule))].sort()

describe('a quoted replacement (2.1-Q224)', () => {
  const OLD = "it('returns three items', () => {\n  expect(a).toBe(1)\n  expect(b).toBe(2)\n})\n"
    + "it('keeps order', () => {\n  expect(c).toBe(3)\n})\nit('stays strict', () => {\n  expect(d).toBe(4)\n})\n"
  const NEW = "it('returns items', () => {\n  expect(a).toBeTruthy()\n})\nit('stays strict', () => {\n  expect(d).toBeTruthy()\n})\n"

  it('canopi-f47t.52.228.10: an added title appearing in the message is not a route for every change', async () => {
    expect(await rules('test: returns items', OLD, NEW)).toEqual(['gate-test-loosened', 'gate-test-reworded'])
    expect(await rules("test: 'returns items' replaces both", OLD, NEW)).toContain('gate-test-loosened')
  })

  it('canopi-f47t.52.240: a quoted replacement routes one deletion', async () => {
    const old = "it('keeps order', () => {\n  expect(c).toBe(3)\n})\n"
    const now = "it('keeps the order of rows', () => {\n  expect(c).toBe(3)\n})\n"
    expect(await rules("test: the new test 'keeps the order of rows' holds it", old, now)).toEqual([])
    expect(await rules('test: the new test keeps the order of rows', old, now)).toEqual(['gate-test-reworded'])
    const two = `${old}it('keeps size', () => {\n  expect(e).toBe(5)\n})\n`
    expect(await rules("test: 'keeps the order of rows' holds it", two, now)).toEqual(['gate-test-deleted'])
  })

  it('canopi-f47t.52.240: quoted replacements pair own file first, then any file, never by assertions', async () => {
    // A deletion with no replacement in its own file never takes the one a later deletion's file holds.
    const one = (title: string, n: number) => `it('${title}', () => {\n${'  expect(1).toBe(1)\n'.repeat(n)}})\n`
    expect(await judgeOne("test: 'b two' and 'c moved' hold them", '', '', [
      ['a.test.ts', 'a.test.ts', one('a one', 1) + one('a keep', 1), one('a keep', 1)],
      ['b.test.ts', 'b.test.ts', one('b one', 3), one('b two', 3)],
      [undefined, 'c.test.ts', '', one('c moved', 1)]])).toEqual([])
    expect(await judgeOne("test: 'c big' and 'c small' hold them", '', '', [
      ['a.test.ts', 'a.test.ts', one('a one', 1) + one('a keep', 1), one('a keep', 1)],
      ['b.test.ts', 'b.test.ts', one('b one', 3) + one('b keep', 1), one('b keep', 1)],
      [undefined, 'c.test.ts', '', one('c big', 1) + one('c small', 1)]])).toEqual([])
  })
})

describe('test titles and bodies (canopi-f47t.52.228.54)', () => {
  const count = (path: string, text: string, title: string) =>
    (tests(path, text).get(title) ?? []).reduce((sum, body) => sum + body.asserts, 0)

  it('canopi-f47t.52.228.10: a test body ends with its own block, not at the next test', () => {
    // A helper's asserts between two tests are no test's: adding a test before the helper loosens nothing.
    const python = 'class A(unittest.TestCase):\n    def test_one(self):\n        self.assertTrue(1)\n\n\n'
      + 'class B(unittest.TestCase):\n    def helper(self):\n        self.assertEqual(1, 1)\n\n    def test_two(self):\n        pass\n'
    expect(count('scripts/test_a.py', python, 'test_one')).toBe(1)
    expect(count('a.rs', '#[test]\nfn one() {\n    let s = "}";\n    assert!(true);\n}\n\nfn helper() { assert_eq!(1, 1); }\n', 'one')).toBe(1)
    expect(count('a.test.ts', "it('one', () => {\n  expect(')').toBe(')') // )\n})\n\nfunction helper() { expect(1).toBe(1) }\n", 'one')).toBe(1)
  })

  it('canopi-f47t.52.254: a title with an escaped quote, a template or a sequence is read cooked', () => {
    const text = "it('it\\'s kept', () => {\n  expect(1).toBe(1)\n})\nit(\"say \\\"hi\\\"\", () => {\n  expect(2).toBe(2)\n})\n"
      + 'it(`plain ${"x"} template`, () => {\n  expect(3).toBe(3)\n})\n'
    expect([...tests('a.test.ts', text).keys()]).toEqual(["it's kept", 'say "hi"', 'plain ${"x"} template'])
  })

  it('canopi-f47t.52.255: browser.waitUntil counts as an assertion, so a pause it replaces loosens nothing', async () => {
    const old = "it('waits', async () => {\n  await pause(500)\n  expect(await ready()).toBe(true)\n})\n"
    const now = "it('waits', async () => {\n  await browser.waitUntil(async () => await ready())\n})\n"
    expect(count('a.test.ts', now, 'waits')).toBe(1)
    expect(await rules('test: wait for it', old, now)).toEqual([])
  })

  it('canopi-f47t.52.255: expect.poll counts as an assertion, so a pause it replaces loosens nothing', async () => {
    const old = "it('polls', async () => {\n  await pause(500)\n  expect(await ready()).toBe(true)\n})\n"
    const now = "it('polls', async () => {\n  await expect.poll(() => ready()).toBe(true)\n})\n"
    expect(count('a.test.ts', now, 'polls')).toBe(1)
    expect(await rules('test: poll for it', old, now)).toEqual([])
  })

  it('canopi-f47t.52.228.54: expect.objectContaining or another expect helper is no assertion of its own', () => {
    const text = "it('matches', () => {\n  expect(got).toEqual(expect.objectContaining({ a: expect.any(Number) }))\n"
      + '  expect.assertions(1)\n  expect.soft(got).toBe(1)\n  assert.equal(got, 1)\n  assert(got)\n})\n'
    expect(count('a.test.ts', text, 'matches')).toBe(4)
  })

  it('canopi-f47t.52.228.54: a regex literal or a block comment holding a bracket or expect( neither ends a body nor counts', () => {
    const text = "it('one', () => {\n  expect(/\\)}/u.test(s)).toBe(true) /* expect(x)} */\n  const r = /expect\\(/u\n"
      + "  // expect(1)\n  const s = 'expect(2)'\n  expect(r).toBeTruthy()\n})\n\nit('two', () => {\n  expect(1).toBe(1)\n})\n"
    expect(count('a.test.ts', text, 'one')).toBe(2)
    expect(count('a.test.ts', text, 'two')).toBe(1)
  })

  it('canopi-f47t.52.228.54: an escaped-quote title is matched by the trailer that names it plainly', async () => {
    const old = "it('it\\'s kept', () => {\n  expect(1).toBe(1)\n})\n"
    const now = "it('it\\'s held', () => {\n  expect(1).toBe(1)\n})\n"
    expect(await rules("test: reword\n\nRewords-test: it's kept -> it's held", old, now)).toEqual([])
  })
})

describe('a title shared by two files (canopi-f47t.52.240)', () => {
  const A = 'desktop/web/src/a.test.ts'
  const B = 'desktop/web/src/b.test.ts'
  const renders = "it('renders', () => {\n  expect(1).toBe(1)\n})\n"
  const other = "it('other', () => {\n  expect(2).toBe(2)\n})\n"
  const x = "it('x', () => {\n  expect(3).toBe(3)\n})\n"
  const files: TestFile[] = [[A, A, renders, renders + other], [B, B, renders + x, x]]
  const judged = (listed?: ReadonlySet<string>) => judge(files, 'refactor(frontend): tidy', {
    authorised: () => false, strictRewords: true, deletedCode: new Map(), quarantined: new Map(), beadOpen: async () => true,
    read: async () => undefined, pyModules: new Set(), ...(listed ? { listed } : {}),
  })

  it('canopi-f47t.52.240: a loss is judged in the file it fell in, never hidden by the same title kept in a Vitest-listed file', async () => {
    expect(await judged(new Set([A]))).toEqual([['gate-test-deleted', `${B}: 'renders' is deleted with no route: quote its `
      + "replacement test's title, cite a merge-base Q row, or add Retires-test: <title> — <why> and delete its code"]])
    expect((await judged()).map(([rule, text]) => [rule, text.split(':')[0]])).toEqual([['gate-test-deleted', B]])
  })
})

describe('a retired twin beside an edited one (2.1-Q274, M388)', () => {
  const path = 'desktop/web/src/c.test.ts'
  const file = (...bodies: string[]) => `import { expect, it } from 'vitest'\nimport { f, g } from './c'\n\n${bodies.join('\n')}`
  const reads = (line: string) => `it('reads', () => {\n${`  ${line}\n`.repeat(2)}})\n`
  const g = reads('expect(g()).toBeTruthy()')
  const strict = "it('reads', () => {\n  expect(f()).toBe(3)\n  expect(f()).toBe(4)\n})\n"
  const loose = reads('expect(f()).toBeTruthy()')
  const judged = (old: string, now: string) => judge([[path, path, old, now]], 'refactor(frontend): drop g\n\nRetires-test: reads — gone', {
    authorised: () => false, strictRewords: true, deletedCode: new Map([['desktop/web/src/c.ts', false]]), quarantined: new Map(),
    beadOpen: async () => false, read: async () => undefined, pyModules: new Set(),
  })

  it('canopi-f47t.52.240: a matcher swap in the kept twin is refused whichever twin comes first, never compared only with the retired one', async () => {
    const refused = [['gate-test-loosened', `${path}: 'reads': .toBe((?!)) to .toBe(?:Truthy|Defined)()`]]
    expect(await judged(file(strict, g), file(loose))).toEqual(refused)
    expect(await judged(file(g, strict), file(loose))).toEqual(refused)
    // The documented cost: retiring one twin with its code passes while the kept twin is unchanged.
    expect(await judged(file(g, strict), file(strict))).toEqual([])
  })

  it('canopi-f47t.52.240: past 256 pairings the edited twins meet every base twin, so the commit is refused, never left unjudged', async () => {
    const twins = (from: number) => Array.from({ length: 10 }, (_, i) => `it('reads', () => {\n  expect(f()).toBe(${from + i})\n})\n`)
    expect(await judged(file(...twins(0), ...twins(10)), file(...twins(100)))).toEqual(
      [['gate-test-loosened', `${path}: 'reads': fewer expect or assert calls`]])
  })
})
