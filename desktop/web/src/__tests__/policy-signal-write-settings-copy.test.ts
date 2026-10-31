// signal-write-only-in-owner.typescript.yml holds its matcher twice: ast-grep scopes a rule by path only per document,
// so the `.settings` document that lets app/settings/ write its own signals (ADR 0024:39) copies the whole matcher and
// adds one clause. This test ties the copies (canopi-f47t.52.228 open item 17): the `.settings` matcher is the first
// document's with exactly that clause added, so a fix to one copy that misses the other fails here. Tests run from
// desktop/web.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const RULE = resolve(process.cwd(), '../../policy/ast-grep/rules/signal-write-only-in-owner.typescript.yml')

/** The settings document's own clause: its comment and its `not:` line, dropped to compare the copies. */
const SETTINGS_CLAUSE = [
  "      # ADR 0024:39: a binding imported from inside app/settings/ is the folder's own signal.",
  "      not: { has: { field: source, regex: '^.(\\./|(\\.\\./)+(app/)?settings/)' } }",
]

/** A document's matcher: its text from `utils:` to the end. */
function matcher(document: string): string {
  const at = document.indexOf('\nutils:\n')
  expect(at, 'a document without utils:').toBeGreaterThan(-1)
  return document.slice(at + 1).trimEnd()
}

describe('signal-write-only-in-owner .settings document', () => {
  it('copies the first document\'s matcher with only its own clause added (canopi-f47t.52.228 open item 17)', () => {
    const documents = readFileSync(RULE, 'utf8').split(/^---$/m)
    expect(documents).toHaveLength(2)
    const [main, settings] = documents.map(matcher)
    const lines = (settings ?? '').split('\n')
    for (const clause of SETTINGS_CLAUSE) expect(lines, `the .settings document lost: ${clause}`).toContain(clause)
    expect(lines.filter((line) => !SETTINGS_CLAUSE.includes(line)).join('\n')).toBe(main)
  })
})
