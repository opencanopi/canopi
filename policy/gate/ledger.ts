// policy/gate/ledger.ts: the decision ledgers' ids and rows for the gate (2.1-Q267; design check DR11). A twin of
// scripts/check_docs_policy.py's prose, ledger_table and ledger_rows, held equal to it by ledger.test.ts until the docs
// checker moves to Node (D1): Python's line breaks (str.splitlines), whitespace (str.strip, \s) and Unicode word
// boundaries are spelt out, because JavaScript's differ at the edges.

/** The line breaks str.splitlines() splits on. */
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u
/** The characters str.isspace() holds, which str.strip() and Python's \s remove. */
const SPACE = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`
const STRIP = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, 'gu')
const LSTRIP = new RegExp(`^[${SPACE}]+`, 'u')
const FENCE = new RegExp(`^[${SPACE}]{0,3}(\`{3,}|~{3,})`, 'u')
/** A column every ledger table holds (check_docs_policy.LEDGER_COLUMNS). */
const LEDGER_COLUMNS = ['id', 'date', 'implemented by'] as const

/** A full ledger id in running text (commit_gate.LEDGER_ID): `\b` and `\d` as Python reads them, Unicode-wide. */
const LEDGER_ID = /(?<![\p{L}\p{N}_])\p{Nd}+\.\p{Nd}+-[EMQ]\p{Nd}+[a-z]?(?![\p{L}\p{N}_])/gu
/** A Q row's id: the user's decisions, which alone authorise a loosening. */
export const Q_ROW = /^\d+\.\d+-Q\d+[a-z]?$/

/** Every full ledger id in `text`, in order. */
export function ledgerIds(text: string): string[] {
  return [...text.matchAll(LEDGER_ID)].map((match) => match[0])
}

const splitLines = (text: string): string[] => {
  const lines = text.split(LINE_BREAK)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
const strip = (text: string) => text.replace(STRIP, '')

/** `text` with fenced code blocks blanked (check_docs_policy.prose). */
export function prose(text: string): string {
  const lines: string[] = []
  let fence: string | undefined
  for (const line of splitLines(text)) {
    const marker = FENCE.exec(line)?.[1]
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      lines.push('')
    } else if (marker !== undefined) {
      fence = marker
      lines.push('')
    } else {
      lines.push(line)
    }
  }
  return lines.join('\n')
}

/** Each table row after a header holding every ledger column, as its cells (check_docs_policy.ledger_table). */
function* ledgerTable(text: string): Generator<{ header: string[], cells: string[] }> {
  let header: string[] | undefined
  let skip = false
  for (const line of splitLines(prose(text))) {
    if (!line.replace(LSTRIP, '').startsWith('|')) {
      header = undefined
      skip = false
      continue
    }
    if (skip) continue
    const cells = strip(line).replace(/^\|+|\|+$/g, '').split('|').map(strip)
    if (header === undefined) {
      header = cells.map((cell) => cell.toLowerCase())
      skip = LEDGER_COLUMNS.some((column) => !header?.includes(column))
      continue
    }
    if (!cells.every((cell) => /^[-: ]*$/.test(cell))) yield { header, cells }
  }
}

/** The ledger's rows by id, in order; a duplicate id keeps its first row (check_docs_policy.ledger_rows). */
export function ledgerRows(text: string): Map<string, Record<string, string>> {
  const rows = new Map<string, Record<string, string>>()
  for (const { header, cells } of ledgerTable(text)) {
    if (cells.length !== header.length) continue
    const row: Record<string, string> = {}
    header.forEach((column, index) => { row[column] = cells[index] ?? '' })
    const id = row['id'] ?? ''
    if (!rows.has(id)) rows.set(id, row)
  }
  return rows
}
