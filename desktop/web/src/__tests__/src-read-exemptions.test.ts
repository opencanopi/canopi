// The tests that may read source text (ADR 0028 Tests go through public surfaces, Checks; 2.1-M20): the
// no-src-read-outside-policies rule files ignore exactly the test paths policy/inventory.json names by an exists{check}
// row, so a policy test gains the right to read source only by an inventory row, and a row whose test goes takes the
// right with it. Both inputs are policy data (JSON and YAML), not source text.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const repository = new URL('../../../../', import.meta.url)
const TEST_PATH = /\.(test|spec)\.tsx?$/

interface InventoryRow { readonly state?: unknown }

/** The test paths the inventory's exists{check} rows name, sorted and without repeats. */
function inventoryTestPaths(inventoryJson: string): string[] {
  const rows = (JSON.parse(inventoryJson) as { rows: InventoryRow[] }).rows
  const checks = rows.flatMap((row) => {
    const state = row.state
    if (typeof state !== 'object' || state === null || !('exists' in state)) return []
    const exists = (state as { exists: { check?: unknown } }).exists
    return typeof exists.check === 'string' && TEST_PATH.test(exists.check) ? [exists.check] : []
  })
  return [...new Set(checks)].sort()
}

/** The paths an ast-grep rule file's top-level `ignores:` list holds, in file order. */
function ruleIgnores(ruleYaml: string): string[] {
  const block = /^ignores:\n((?: {2}- .*\n)*)/m.exec(ruleYaml)
  if (!block) return []
  return block[1]!.split('\n').filter(Boolean).map((line) => line.replace(/^ {2}- /, '').replace(/^"(.*)"$/, '$1'))
}

/** The exemptions both rule files hold, each in the file of its language, compared with the inventory's test paths. */
function exemptionMismatch(inventoryJson: string, typescriptYaml: string, tsxYaml: string): Record<string, string[]> {
  const expected = inventoryTestPaths(inventoryJson)
  const typescript = ruleIgnores(typescriptYaml)
  const tsx = ruleIgnores(tsxYaml)
  const held = new Set([...typescript, ...tsx])
  return {
    missing: expected.filter((path) => !held.has(path)),
    extra: [...held].filter((path) => !expected.includes(path)).sort(),
    wrongLanguage: [...typescript.filter((path) => path.endsWith('.tsx')), ...tsx.filter((path) => !path.endsWith('.tsx'))],
  }
}

function read(path: string): string {
  return readFileSync(new URL(path, repository), 'utf8')
}

describe('no-src-read-outside-policies exemptions', () => {
  it('are exactly the test paths the policy inventory names by an exists{check} row', () => {
    expect(exemptionMismatch(
      read('policy/inventory.json'),
      read('policy/ast-grep/rules/no-src-read-outside-policies.yml'),
      read('policy/ast-grep/rules/no-src-read-outside-policies.tsx.yml'),
    )).toEqual({ missing: [], extra: [], wrongLanguage: [] })
  })

  it('names a row whose test the rules do not exempt, an exemption no row names, and one in the wrong language file', () => {
    const inventory = JSON.stringify({
      rows: [
        { state: { exists: { check: 'tests/a.test.ts' } } },
        { state: { exists: { check: 'tests/b.test.tsx' } } },
        { state: { exists: { check: 'disallowed-methods' } } },
        { state: 'process' },
      ],
    })
    const typescript = 'id: x\nignores:\n  - "tests/b.test.tsx"\n  - "tests/stray.test.ts"\nrule: {}\n'
    expect(exemptionMismatch(inventory, typescript, 'id: x.tsx\nrule: {}\n')).toEqual({
      missing: ['tests/a.test.ts'],
      extra: ['tests/stray.test.ts'],
      wrongLanguage: ['tests/b.test.tsx'],
    })
  })
})
