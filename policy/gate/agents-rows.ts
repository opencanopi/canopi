// policy/gate/agents-rows.ts: AGENTS.md's Quality gates rows, rendered from the table (2.1-M198, 2.1-M226; design check
// AR11). Each area's Run cell is its template with every `{id}` replaced by how the row writes that check, so the row
// cannot name a check the gate does not run; `agents-rows --check` compares the rendered rows, in order, with the table
// AGENTS.md shows, and scripts/check_docs.py runs it until the docs checker moves to Node (D1).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TABLE, TABLE_FILE, type Table } from './table.ts'

export const HEADING = '## Quality gates'

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

/** The rows of AGENTS.md's Quality gates table, or undefined when it has none. */
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

/** Each way AGENTS.md's rows at `root` differ from the rendered ones; none when they are equal. */
export function agentsRowFaults(root: string, table: Table = TABLE): string[] {
  const file = join(root, 'AGENTS.md')
  const ours = agentsRows(existsSync(file) ? readFileSync(file, 'utf8') : '')
  if (ours === undefined) return [`AGENTS.md has no ${HEADING} table for ${TABLE_FILE}'s rows (2.1-M198)`]
  const theirs = renderRows(table)
  const faults: string[] = []
  for (let index = 0; index < Math.max(ours.length, theirs.length); index += 1) {
    const agents = ours[index]
    const rendered = theirs[index]
    if (agents?.change !== rendered?.change || agents?.run !== rendered?.run) {
      faults.push(`AGENTS.md: ${HEADING} row ${index + 1} differs from ${TABLE_FILE} (2.1-M198): AGENTS.md has `
        + `${shown(agents)}, the table renders ${shown(rendered)}`)
    }
  }
  return faults
}

/** The rendered rows as AGENTS.md writes them. */
export const rowsText = (table: Table = TABLE) =>
  ['| Change | Run |', '|---|---|', ...renderRows(table).map(shown)].join('\n')
