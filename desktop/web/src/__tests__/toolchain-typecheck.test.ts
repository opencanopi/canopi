// The TypeScript pair (2.1-M184, 2.1-Q205): TypeScript 7 type-checks, and only through `npm run typecheck`;
// `typescript` stays TypeScript 6 for the tools that read its API (dependency-cruiser, Stryker). Both packages
// ship a compiler, so a bare `npx tsc` or `tsc --noEmit` could silently run the other one: none is allowed in
// the package scripts, CI workflows, docs or scripts.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const REPO_ROOT = join(WEB_ROOT, '../..')
const TS7_ALIAS = 'typescript7'
const TYPECHECK = `node ./node_modules/${TS7_ALIAS}/bin/tsc --noEmit`

// A compiler run that does not go through the typecheck script: `npx tsc`, `npx --prefix x tsc`, or a bare
// `tsc` given a flag or project (as a package script or a shell line would run it).
const BARE_TSC = /\bnpx\s+(?:--?[\w-]+(?:[ =]\S+)?\s+)*tsc\b|(?:^|[\s;&|("'`])tsc(?:\s+(?:--noEmit|-p|--project|-b|--build)\b|\s*(?:&&|;|["']|$))/m

interface PackageJson {
  scripts: Record<string, string>
}

function packageJson(): PackageJson {
  return JSON.parse(readFileSync(join(WEB_ROOT, 'package.json'), 'utf8')) as PackageJson
}

function filesUnder(root: string, extensions: readonly string[]): string[] {
  const out: string[] = []
  for (const name of readdirSync(root)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const path = join(root, name)
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, extensions))
    else if (extensions.some((ext) => name.endsWith(ext))) out.push(path)
  }
  return out
}

function bareTscLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => BARE_TSC.test(line))
    .map(({ line, index }) => `${relative(REPO_ROOT, path)}:${index + 1}: ${line.trim()}`)
}

describe('toolchain typecheck (2.1-M184, 2.1-Q205)', () => {
  it('runs TypeScript 7 from its alias through the typecheck script', () => {
    const script = packageJson().scripts.typecheck
    expect(script).toBe(TYPECHECK)

    const result = spawnSync(process.execPath, [join(WEB_ROOT, 'node_modules', TS7_ALIAS, 'bin', 'tsc'), '--version'], {
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^Version 7\./)
  })

  it('keeps the typescript import on TypeScript 6 for the API readers', () => {
    const require = createRequire(join(WEB_ROOT, 'package.json'))
    const ts = require('typescript') as { version: string }
    expect(ts.version).toMatch(/^6\./)
  })

  it('type-checks through the typecheck script in every package script', () => {
    const offenders = Object.entries(packageJson().scripts)
      .filter(([name, command]) => name !== 'typecheck' && /\btsc\b/.test(command))
      .map(([name, command]) => `${name}: ${command}`)
    expect(offenders).toEqual([])
  })

  it('has no bare compiler run in CI workflows or scripts', () => {
    const files = [
      ...filesUnder(join(REPO_ROOT, '.github/workflows'), ['.yml', '.yaml']),
      ...filesUnder(join(REPO_ROOT, 'scripts'), ['.sh', '.py', '.mjs', '.js', '.ts']),
      ...filesUnder(join(WEB_ROOT, 'scripts'), ['.sh', '.py', '.mjs', '.js', '.ts']),
      ...filesUnder(join(REPO_ROOT, 'docs/guides'), ['.md']),
    ]
    expect(files.flatMap(bareTscLines)).toEqual([])
  })

  // README.md and AGENTS.md belong to the main agent in Phase 0; it switches their command lines at the F0d merge.
  it.fails('has no bare compiler run in README.md or AGENTS.md (owner main, canopi-f47t.52.228.4)', () => {
    const files = [join(REPO_ROOT, 'README.md'), join(REPO_ROOT, 'AGENTS.md')]
    expect(files.flatMap(bareTscLines)).toEqual([])
  })

  it('recognises the bare compiler runs it refuses', () => {
    for (const line of [
      'cd desktop/web && npx tsc --noEmit && npm test',
      'run: npx --prefix desktop/web tsc --noEmit -p desktop/web/tsconfig.json',
      'run: npx tsc -p e2e --noEmit',
      '"check:ui": "tsc --noEmit -p ui-gallery/tsconfig.json"',
      '"build": "tsc && npm run build:desktop:bundle"',
    ]) {
      expect(BARE_TSC.test(line), line).toBe(true)
    }
    for (const line of ['run: npm run typecheck', TYPECHECK, 'the tsc cold time', '// tsc fails until it is listed here.']) {
      expect(BARE_TSC.test(line), line).toBe(false)
    }
  })
})
