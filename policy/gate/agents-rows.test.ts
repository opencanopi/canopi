// AGENTS.md's Quality gates rows are rendered from the gate table (2.1-M198, 2.1-Q267; design check AR11, AR21):
// `agents-rows --check` fails a row that drifts from its area's template, which scripts/check_docs.py runs.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentsRowFaults, rowsText } from './agents-rows.ts'
import { PlantedRepo, REPO_ROOT } from './planted-repo.ts'

const agents = (rows: string) => `# Agents\n\n## Quality gates\n\n${rows}\n\nDocs-only changes skip code gates.\n`

describe('AGENTS.md rows (canopi-f47t.52.228.11)', () => {
  let repo: PlantedRepo
  beforeEach(() => { repo = new PlantedRepo() })
  afterEach(() => repo.cleanup())

  it("the repository's AGENTS.md shows the rows the table renders", () => {
    expect(agentsRowFaults(REPO_ROOT)).toEqual([])
    expect(readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8')).toContain(rowsText())
  })

  it('canopi-f47t.52.228.11: a drifted row fails naming the table and both texts; equal rows pass', () => {
    repo.write({ 'AGENTS.md': agents(rowsText()) })
    let run = repo.gate(['agents-rows', '--check'])
    expect([run.status, run.stdout]).toEqual([0, ''])
    repo.write({ 'AGENTS.md': agents(rowsText().replace('`cargo fmt --all -- --check`; ', '')) })
    run = repo.gate(['agents-rows', '--check'])
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('AGENTS.md: ## Quality gates row 1 differs from policy/gate/table.ts (2.1-M198): AGENTS.md has | Rust | `CANOPI')
    expect(run.stdout).toContain('the table renders | Rust | `cargo fmt --all -- --check`; ')
    repo.write({ 'AGENTS.md': agents(rowsText().split('\n').slice(0, -1).join('\n')) })
    expect(repo.gate(['agents-rows', '--check']).stdout).toContain('row 8 differs')
  })

  it('canopi-f47t.52.228.11: AGENTS.md with no Quality gates table fails', () => {
    repo.write({ 'AGENTS.md': '# Agents\n' })
    const run = repo.gate(['agents-rows', '--check'])
    expect(run.status).toBe(1)
    expect(run.stdout).toBe("AGENTS.md has no ## Quality gates table for policy/gate/table.ts's rows (2.1-M198)\n")
  })

  it('renders the rows without the check flag', () => {
    const run = repo.gate(['agents-rows'])
    expect([run.status, run.stdout]).toEqual([0, `${rowsText()}\n`])
  })
})

describe('the one gate table decision (2.1-M198)', () => {
  it('canopi-f47t.52.228.54: its inventory row names the gate entry the docs check runs, so moving the entry fails the docs check', () => {
    const { rows } = JSON.parse(readFileSync(join(REPO_ROOT, 'policy/inventory.json'), 'utf8')) as
      { rows: { quote?: string, state?: { exists?: { check?: string } } }[] }
    expect(rows.filter((row) => row.quote === '| 2.1-M198 |').map((row) => row.state?.exists?.check)).toEqual(['policy/gate/cli.mjs'])
  })
})
