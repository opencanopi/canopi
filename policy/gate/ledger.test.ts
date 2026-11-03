// The ledger reader against its Python twin, check_docs_policy.ledger_rows, which the docs checker keeps until D1
// (design check DR11): the same rows, by id, over every real ledger and the planted edges where Python's str methods
// and JavaScript's differ (line breaks, whitespace, fences).
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ledgerIds, ledgerRows, Q_ROW } from './ledger.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Python's rows for each text, as [id, sorted cells] pairs in its dict order. */
function pythonRows(texts: readonly string[]): unknown[] {
  const script = [
    'import json, sys',
    'sys.path.insert(0, "scripts")',
    'from check_docs_policy import ledger_rows',
    'texts = json.load(sys.stdin)',
    'print(json.dumps([[[k, sorted(v.items())] for k, v in ledger_rows(t).items()] for t in texts]))',
  ].join('\n')
  const run = spawnSync('python3', ['-c', script], { cwd: ROOT, input: JSON.stringify(texts), encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`python3 ledger_rows failed: ${run.stderr}`)
  return JSON.parse(run.stdout) as unknown[]
}

const nodeRows = (text: string) =>
  [...ledgerRows(text)].map(([id, row]) => [id, Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))])

const HEADER = '| id | date | decision | implemented by |\n|---|---|---|---|\n'
const PLANTED = [
  `${HEADER}| 2.1-Q1 | d | one | x |\n| 2.1-Q1 | d | duplicate keeps the first | x |\n| 2.1-Q2 | d | short |\n`,
  `${HEADER}| 2.1-Q3 | d | a\u2028b | x |\r\n| 2.1-Q4 | d | \u0085padded\u001c | x |\n`,
  `${HEADER}| 2.1-Q5 | d | form\ffeed | x |\n\n| id | decision |\n|---|---|\n| 2.1-Q6 | no date column |\n`,
  `\`\`\`\n${HEADER}| 2.1-Q7 | fenced | x | y |\n\`\`\`\n${HEADER}|| 2.1-Q8 || d | e | f ||\n`,
  `  ${HEADER}  | 2.1-Q9 | \ufeffbom | x | y |\n| :-: | --- | : | - |\n`,
]

describe('ledger rows (2.1-Q267, design check DR11)', () => {
  it('reads every ledger and the planted edges into the rows check_docs_policy.ledger_rows reads', () => {
    const ledgers = readdirSync(`${ROOT}docs/decisions`).filter((name) => name.endsWith('.md'))
      .map((name) => readFileSync(`${ROOT}docs/decisions/${name}`, 'utf8'))
    expect(ledgers.length).toBeGreaterThan(0)
    const texts = [...ledgers, ...PLANTED]
    expect(texts.map(nodeRows)).toEqual(pythonRows(texts))
    // A duplicate id keeps its first row; a row short of the header's cells is no row.
    expect([...ledgerRows(PLANTED[0] ?? '')].map(([id, row]) => [id, row['decision']])).toEqual([['2.1-Q1', 'one']])
  })

  it('finds full ledger ids in a message and tells the Q rows', () => {
    expect(ledgerIds('fix: x (2.1-Q267, 2.1-M346a; not 2.1-Q12x3 or a2.1-Q4 or Q5)')).toEqual(['2.1-Q267', '2.1-M346a'])
    expect(['2.1-Q267', '2.1-M346', '2.1-Q35r'].filter((id) => Q_ROW.test(id))).toEqual(['2.1-Q267', '2.1-Q35r'])
  })
})
