// policy/gate/table-faults.ts: the gate table's validator (2.1-M198; design check AR11). tableFaults lists every
// fault of a table as a gate, each naming TABLE_FILE; validTable refuses a malformed table before any plan is made. It
// sits beside table.ts so the table stays data under the file-size limit.

import { CI_SETUP, TABLE, TABLE_FILE, type Area, type Table } from './table.ts'

/** The table cannot be read as a gate: the CLI refuses naming TABLE_FILE and makes no plan. */
export class TableError extends Error {}

const PLACEHOLDER = /\{([a-z0-9-]+)\}/g
const SHELL_SYNTAX = /[*?[\]'"$`\\|;&<>(){}~]/g
const anchored = (pattern: string) => (pattern.startsWith('^') || pattern.startsWith('(^|/)') || pattern.endsWith('$'))
  && !pattern.includes('**')

type Fault = (what: string) => void

/** Every fault of `table` as a gate table, each naming TABLE_FILE; none for a sound table. */
export function tableFaults(table: Table): string[] {
  const faults: string[] = []
  const fault: Fault = (what) => faults.push(`${TABLE_FILE}: ${what}`)
  checkFaults(table, fault)
  const names = new Set<string>()
  for (const area of table.areas) {
    if (names.has(area.name)) fault(`area ${area.name} is listed twice`)
    names.add(area.name)
    areaFaults(table, area, fault)
  }
  for (const [rule, pattern] of Object.entries({ ...table.paths, ...table.families })) regex(fault, `rule ${rule}`, pattern)
  if (!/^\d+\.\d+\.\d+$/.test(table.actionlint?.version ?? '')) fault('actionlint version is not x.y.z')
  if (!/^[0-9a-f]{64}$/.test(table.actionlint?.sha256 ?? '')) fault('actionlint sha256 is not 64 hex digits')
  for (const [job, steps] of Object.entries(table.ci ?? {})) {
    for (const [step, row] of Object.entries(steps)) {
      if (row !== CI_SETUP && table.checks[row]?.ciOnly !== true) fault(`ci row ${job}/${step} is ${row}, neither ${CI_SETUP} nor a ci_only check`)
    }
  }
  return faults
}

function regex(fault: Fault, where: string, pattern: string) {
  try {
    new RegExp(pattern)
  } catch (error) {
    fault(`${where} ${JSON.stringify(pattern)} is no regex (${(error as Error).message})`)
  }
}

function anchoredRegex(fault: Fault, where: string, pattern: string) {
  regex(fault, where, pattern)
  if (!anchored(pattern)) fault(`${where} ${JSON.stringify(pattern)} is not anchored`)
}

function checkFaults(table: Table, fault: Fault) {
  for (const [id, check] of Object.entries(table.checks)) {
    if (!/^[a-z0-9-]+$/.test(id)) fault(`check id ${JSON.stringify(id)} is not lower-case words joined by '-'`)
    if (typeof check?.command !== 'string' || check.command.trim() === '') fault(`check ${id} has no command`)
    // The gate splits a command on whitespace (run.ts splitEnv) and an agent pastes its row into zsh: shell syntax
    // would run differently in each (an unquoted glob fails in zsh), so a runnable command holds none.
    const syntax = check?.ciOnly ? [] : [...new Set(check?.command?.match(SHELL_SYNTAX) ?? [])]
    if (syntax.length) {
      fault(`check ${id} command holds shell syntax the gate never reads (${syntax.map((c) => JSON.stringify(c)).join(', ')}); a pasted row would differ`)
    }
    for (const ran of check?.runs ?? []) if (!(ran in table.checks)) fault(`check ${id} runs ${ran}, which is no check`)
    if (check?.on && !check.ciOnly) fault(`check ${id} names the triggers of a workflow of its own, but is no CI-only lane`)
  }
}

function areaFaults(table: Table, area: Area, fault: Fault) {
  if (!area.full?.length) fault(`area ${area.name} has no full checks`)
  for (const lane of ['full', 'affected', 'commit', 'coveredBy'] as const) {
    for (const id of area[lane] ?? []) if (!(id in table.checks)) fault(`area ${area.name} ${lane} names ${id}, which is no check`)
  }
  if (!area.patterns?.length) fault(`area ${area.name} has no patterns`)
  for (const pattern of area.patterns ?? []) anchoredRegex(fault, `area ${area.name} pattern`, pattern)
  for (const pattern of area.scans ?? []) anchoredRegex(fault, `area ${area.name} scan`, pattern)
  // affectedWhen adds a check of the area's row to its affected lane where an anchored pattern matches (C9a review).
  for (const [id, inputs] of Object.entries(area.affectedWhen ?? {})) {
    if (!area.full?.includes(id)) fault(`area ${area.name} affectedWhen names ${id}, which is not one of its full checks`)
    for (const pattern of inputs) anchoredRegex(fault, `area ${area.name} affectedWhen ${id} pattern`, pattern)
  }
  rowFaults(table, area, fault)
}

function rowFaults(table: Table, area: Area, fault: Fault) {
  const named = [...(area.row ?? '').matchAll(PLACEHOLDER)].map((match) => match[1] ?? '')
  for (const id of named) {
    if (!area.full?.includes(id)) fault(`area ${area.name} row names {${id}}, which is not one of its full checks`)
  }
  for (const id of area.full ?? []) {
    const times = named.filter((name) => name === id).length
    const prose = table.checks[id]?.prose === true
    if (!prose && times !== 1) fault(`area ${area.name} row names {${id}} ${times} times; a full check is named once`)
    if (prose && times !== 0) fault(`area ${area.name} row names {${id}}, which its row holds as prose`)
  }
}

/** The table, or a TableError listing its faults. */
export function validTable(table: Table = TABLE): Table {
  const faults = tableFaults(table)
  if (faults.length) throw new TableError(faults.join('\n'))
  return table
}
