// The FAP conversion check (plan Phase 0 F1a, A6, DR17; the exit's "old and new violation sets diff empty for every
// converted rule"). policy/fixtures/fap/conversion.json holds every planted call of the retired
// frontend-architecture-policies suite and its sibling suites with the violations the old harness returned for it;
// this test runs the real ast-grep and dependency-cruiser, through their adapters and the generated configs, over the
// same files planted in a scratch copy of the repository's policy layout, and holds what they report to the old sets.
// A site a ratchet family lists (a real file's baseline entry) is excused as the checker excuses it. Each difference
// is listed with its reason; an unlisted difference, or a listed one that is gone, fails.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const RECORD = 'policy/fixtures/fap/conversion.json'
const TOOLS = ['ast-grep', 'dependency-cruiser'] as const

interface Site { readonly rule: string; readonly path?: string; readonly name?: string; readonly target?: string }
interface Case {
  readonly id: string
  readonly files: readonly { readonly path: string; readonly source: string }[]
  readonly old: Readonly<Record<string, Readonly<Record<string, number>>>>
}
interface Difference { readonly case: string; readonly rule: string; readonly path: string; readonly old: number; readonly new: number; readonly reason: string }
interface Family { readonly tool: string; readonly keys?: string; readonly entries?: Readonly<Record<string, { readonly count: number }>> }

const record = JSON.parse(fs.readFileSync(path.join(REPO, RECORD), 'utf8')) as { cases: Case[]; differences: Difference[] }
const caseDir = (index: number) => `policy/fixtures/rules/fap-${String(index).padStart(3, '0')}/`

let scratch = ''
let sites: Site[] = []

/**
 * A scratch repository: the rule homes and generated configs copied or linked, desktop/web/src holding only empty
 * modules at the tsconfig path targets (so an aliased specifier resolves as it does in the real tree), and each case
 * planted at policy/fixtures/rules/fap-NNN/src/, the mirror every rule's scope and the generated configs admit.
 */
function plantScratch(): string[] {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fap-conversion-'))
  const web = path.join(scratch, 'desktop/web')
  fs.mkdirSync(path.join(scratch, 'policy/fixtures/rules'), { recursive: true })
  fs.mkdirSync(path.join(web, 'src'), { recursive: true })
  fs.writeFileSync(path.join(web, 'src/empty.ts'), 'export {}\n')
  for (const rel of ['sgconfig.yml', 'policy/ast-grep', 'policy/layers.json', 'policy/rules.json', 'policy/primitives.json']) {
    fs.symlinkSync(path.join(REPO, rel), path.join(scratch, rel))
  }
  for (const name of fs.readdirSync(path.join(REPO, 'desktop/web'))) {
    if (name === 'node_modules') fs.symlinkSync(path.join(REPO, 'desktop/web', name), path.join(web, name))
    else if (/^(package\.json|tsconfig.*\.json|\.dependency-cruiser.*\.cjs)$/u.test(name)) {
      const text = fs.readFileSync(path.join(REPO, 'desktop/web', name), 'utf8')
      fs.writeFileSync(path.join(web, name), text)
      for (const [, target = ''] of text.matchAll(/"\.\/(src\/[^"]+)"/gu)) {
        fs.mkdirSync(path.dirname(path.join(web, target)), { recursive: true })
        fs.writeFileSync(path.join(web, target), 'export {}\n')
      }
    }
  }
  const planted: string[] = []
  record.cases.forEach((kase, index) => {
    for (const file of kase.files) {
      const rel = `${caseDir(index)}${file.path}`
      fs.mkdirSync(path.dirname(path.join(scratch, rel)), { recursive: true })
      fs.writeFileSync(path.join(scratch, rel), file.source)
      if (/\.tsx?$/u.test(file.path)) planted.push(rel)
    }
  })
  return planted
}

/** The family that counts `rule`, if any: its listed sites are a real file's baseline, excused as check.mjs excuses them. */
function familyOf(rule: string): Family | undefined {
  const file = path.join(REPO, 'policy/ratchets', `${rule}.json`)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Family : undefined
}

/** The sites each rule of `rules` reports in case `index` beyond its family's entries, counted per planted file. */
function newSites(index: number, rules: readonly string[]): Record<string, number> {
  const prefix = caseDir(index)
  const counted: Record<string, number> = {}
  for (const rule of rules) {
    const family = familyOf(rule)
    const groups = new Map<string, { rel: string; n: number }>()
    for (const site of sites) {
      if (site.rule !== rule || !site.path?.startsWith(prefix)) continue
      const rel = site.path.slice(prefix.length)
      const real = `desktop/web/${rel}`
      const key = !family?.entries ? rel
        : family.keys === 'name' ? site.name ?? rel
          : family.keys === 'path' ? real
            : `${real}: ${site.target ?? `${family.tool}:${site.rule}`}`
      const group = groups.get(key) ?? { rel, n: 0 }
      group.n += 1
      groups.set(key, group)
    }
    for (const [key, { rel, n }] of groups) {
      const over = n - (family?.entries?.[key]?.count ?? 0)
      if (over > 0) counted[rel] = (counted[rel] ?? 0) + over
    }
  }
  return counted
}

beforeAll(async () => {
  const paths = plantScratch()
  const { exec } = await import(pathToFileURL(path.join(REPO, 'policy/check.mjs')).href) as { exec: unknown }
  for (const tool of TOOLS) {
    const adapter = await import(pathToFileURL(path.join(REPO, `policy/adapters/${tool}.mjs`)).href) as {
      collect(args: { root: string; paths: string[]; exec: unknown; tools: string }): Site[] | Promise<Site[]>
    }
    sites.push(...await adapter.collect({ root: scratch, paths, exec, tools: REPO }))
  }
}, 120_000)

afterAll(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
  sites = []
})

describe('FAP conversion', () => {
  it('reports what the old harness reported on its planted cases, apart from the listed differences', () => {
    const observed: Omit<Difference, 'reason'>[] = []
    record.cases.forEach((kase, index) => {
      for (const [rules, old] of Object.entries(kase.old)) {
        const found = newSites(index, rules.split(','))
        for (const file of [...new Set([...Object.keys(old), ...Object.keys(found)])].sort()) {
          if ((old[file] ?? 0) !== (found[file] ?? 0)) observed.push({ case: kase.id, rule: rules, path: file, old: old[file] ?? 0, new: found[file] ?? 0 })
        }
      }
    })
    expect(observed).toEqual(record.differences.map(({ reason: _reason, ...difference }) => difference))
  })

  it('gives every listed difference its reason', () => {
    expect(record.differences.filter(({ reason }) => reason.trim().length < 20)).toEqual([])
  })
})
