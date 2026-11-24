// Quality gates rows are rendered from policy/gate/table.ts to docs/quality-gates.md (2.1-M198, 2.1-Q267, 2.1-Q342;
// design check AR11, AR21): `agents-rows --check` fails a row that drifts or an AGENTS.md that drops the link.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentsRowFaults, GATES_DOC, renderDoc, rowsText } from './agents-rows.ts'
import { TABLE } from './table.ts'
import { PlantedRepo, REPO_ROOT } from './planted-repo.ts'

const agentsDoc = (link = true) => `# Agents\n\n## Quality gates\n\n${link ? `See [Quality gates](${GATES_DOC}).` : 'No link.'}\n`
const gatesDoc = (rows: string) => `# Quality gates\n\n${rows}\n\nDocs-only changes skip code gates.\n`

describe('AGENTS.md rows (canopi-f47t.52.228.11)', () => {
  let repo: PlantedRepo
  beforeEach(() => { repo = new PlantedRepo() })
  // A test that plants no repository leaves none to clean up, in any order the seed shuffles (canopi-f47t.52.228.54).
  afterEach(() => {
    repo?.cleanup()
    repo = undefined as never
  })

  it("the repository's AGENTS.md shows the rows the table renders", () => {
    expect(agentsRowFaults(REPO_ROOT)).toEqual([])
    expect(readFileSync(join(REPO_ROOT, GATES_DOC), 'utf8')).toBe(renderDoc())
    expect(readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8')).toContain(`(${GATES_DOC})`)
  })

  it('canopi-f47t.52.228.11: a drifted row fails naming the table and both texts; equal rows pass', () => {
    repo.write({ 'AGENTS.md': agentsDoc(), [GATES_DOC]: gatesDoc(rowsText()) })
    let run = repo.gate(['agents-rows', '--check'])
    expect([run.status, run.stdout]).toEqual([0, ''])
    repo.write({ [GATES_DOC]: gatesDoc(rowsText().replace('`cargo fetch --locked`; ', '')) })
    run = repo.gate(['agents-rows', '--check'])
    expect(run.status).toBe(1)
    expect(run.stdout).toContain(`${GATES_DOC}: # Quality gates row 1 differs from policy/gate/table.ts (2.1-M198, 2.1-Q342): ${GATES_DOC} has | Rust | \`cargo fmt`)
    expect(run.stdout).toContain('the table renders | Rust | `cargo fetch --locked`; ')
    repo.write({ [GATES_DOC]: gatesDoc(rowsText().split('\n').slice(0, -1).join('\n')) })
    expect(repo.gate(['agents-rows', '--check']).stdout).toContain(`row ${TABLE.areas.length} differs`)
  })

  it('canopi-f47t.52.228.11: AGENTS.md with no Quality gates table fails', () => {
    repo.write({ 'AGENTS.md': agentsDoc(false) })
    const run = repo.gate(['agents-rows', '--check'])
    expect(run.status).toBe(1)
    expect(run.stdout).toContain(`${GATES_DOC} has no # Quality gates table for policy/gate/table.ts's rows (2.1-M198, 2.1-Q342)`)
    expect(run.stdout).toContain(`AGENTS.md does not link to ${GATES_DOC} (2.1-Q342)`)
  })

  it('renders the rows without the check flag', () => {
    const run = repo.gate(['agents-rows'])
    expect([run.status, run.stdout]).toEqual([0, `${rowsText()}\n`])
  })

  it('canopi-hc6w (2.1-Q342): --write generates docs/quality-gates.md from policy/gate/table.ts', () => {
    repo.write({ 'AGENTS.md': agentsDoc() })
    const write = repo.gate(['agents-rows', '--write'])
    expect([write.status, write.stdout]).toEqual([0, ''])
    expect(readFileSync(join(repo.repo, GATES_DOC), 'utf8')).toBe(renderDoc())
    expect(repo.gate(['agents-rows', '--check']).status).toBe(0)
  })
})

describe('the one gate table decision (2.1-M198)', () => {
  it('canopi-f47t.52.228.54: its inventory row names the gate entry the docs check runs, so moving the entry fails the docs check', () => {
    const { rows } = JSON.parse(readFileSync(join(REPO_ROOT, 'policy/inventory.json'), 'utf8')) as
      { rows: { quote?: string, state?: { exists?: { check?: string } } }[] }
    expect(rows.filter((row) => row.quote === '| 2.1-M198 |').map((row) => row.state?.exists?.check)).toEqual(['policy/gate/cli.mjs'])
  })
})
