// policy/gate/agents-rows.ts: Quality gates table rendered from policy/gate/table.ts to docs/quality-gates.md
// (2.1-M198, 2.1-M226, 2.1-Q342; design check AR11). Each area's Run cell is its template with every `{id}` replaced
// by how the row writes that check, so the row cannot name a check the gate does not run; `agents-rows --check`
// compares the rendered rows with docs/quality-gates.md and verifies AGENTS.md links to it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { TABLE, TABLE_FILE, type Table } from './table.ts'

export const GATES_DOC = 'docs/quality-gates.md'
export const HEADING = '# Quality gates'

export interface Row {
  readonly change: string
  readonly run: string
}

/** The (Change, Run) rows the table renders, in table order. */
export function renderRows(table: Table = TABLE): Row[] {
  return table.areas.map((area) => ({
    change: area.label,
    run: area.row.replace(/\{([a-z0-9-]+)\}/g, (_, id: string) => {
      const check = table.checks[id]
      return check?.shown ?? check?.command ?? `{${id}}`
    }),
  }))
}

/** The rows of the Quality gates table, or undefined when the document has none. */
export function agentsRows(text: string): Row[] | undefined {
  const at = text.indexOf(HEADING)
  if (at < 0) return undefined
  const table = text.slice(at + HEADING.length).split('\n\n')[1] ?? ''
  return table.split('\n').slice(2).map((line) => {
    const cells = line.trim().replace(/^\| /, '').replace(/ \|$/, '')
    const split = cells.indexOf(' | ')
    return split < 0 ? { change: cells, run: '' } : { change: cells.slice(0, split), run: cells.slice(split + 3) }
  })
}

const shown = (row: Row | undefined) => (row ? `| ${row.change} | ${row.run} |` : 'no row')

/** Each way docs/quality-gates.md differs from the rendered document, or AGENTS.md lacks its link; none when equal. */
export function agentsRowFaults(root: string, table: Table = TABLE): string[] {
  const file = join(root, GATES_DOC)
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const ours = agentsRows(raw)
  const faults: string[] = []
  if (ours === undefined) {
    faults.push(`${GATES_DOC} has no ${HEADING} table for ${TABLE_FILE}'s rows (2.1-M198, 2.1-Q342)`)
  } else {
    const theirs = renderRows(table)
    for (let index = 0; index < Math.max(ours.length, theirs.length); index += 1) {
      const docRow = ours[index]
      const rendered = theirs[index]
      if (docRow?.change !== rendered?.change || docRow?.run !== rendered?.run) {
        faults.push(`${GATES_DOC}: ${HEADING} row ${index + 1} differs from ${TABLE_FILE} (2.1-M198, 2.1-Q342): `
          + `${GATES_DOC} has ${shown(docRow)}, the table renders ${shown(rendered)}`)
      }
    }
    if (!faults.length && raw !== renderDoc(table)) {
      faults.push(`${GATES_DOC} header or footer differs from \`node policy/gate/cli.mjs agents-rows --write\` (2.1-Q342)`)
    }
  }
  const agentsFile = join(root, 'AGENTS.md')
  if (existsSync(agentsFile) && !readFileSync(agentsFile, 'utf8').includes(`(${GATES_DOC})`)) {
    faults.push(`AGENTS.md does not link to ${GATES_DOC} (2.1-Q342)`)
  }
  return faults
}

/** The rendered rows as markdown table text. */
export const rowsText = (table: Table = TABLE) =>
  ['| Change | Run |', '|---|---|', ...renderRows(table).map(shown)].join('\n')

/** The complete generated docs/quality-gates.md document (2.1-Q342). */
export const renderDoc = (table: Table = TABLE) => [
  `<!-- Generated from ${TABLE_FILE} by \`node policy/gate/cli.mjs agents-rows --write\` (2.1-Q342). Do not edit by hand. -->`,
  '',
  HEADING,
  '',
  rowsText(table),
  '',
  'Docs-only changes skip code gates; say so in the handoff.',
  '',
].join('\n')

/** Writes the generated docs/quality-gates.md document under `root`. */
export function writeGatesDoc(root: string, table: Table = TABLE): void {
  const file = join(root, GATES_DOC)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, renderDoc(table))
}
