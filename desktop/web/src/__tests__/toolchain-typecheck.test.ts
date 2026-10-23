// The TypeScript pair (2.1-M184, 2.1-Q205): TypeScript 7 type-checks, and only through `npm run typecheck`;
// `typescript` stays TypeScript 6 for the tools that read its API (dependency-cruiser, Stryker). Both packages
// ship a compiler, so a bare `npx tsc` or `tsc --noEmit` could silently run the other one: none is allowed in
// the package scripts, CI workflows, docs or scripts.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const REPO_ROOT = join(WEB_ROOT, '../..')
const TS7_ALIAS = 'typescript7'
const TYPECHECK = `node ./node_modules/${TS7_ALIAS}/bin/tsc --noEmit`

// A compiler run that does not go through the typecheck script. `tsc` (or `tsc.js`) counts wherever it sits as a
// command, whatever arguments follow: run by a package runner (`npx`, `npm exec`, `pnpm`, `yarn`, `bunx`, `node`,
// options included), named by a path (`node_modules/.bin/tsc` links to TypeScript 6; only the TypeScript 7 alias the
// script runs is allowed), or at the start of a command (a line, a YAML `run:`, a quote, after `&&`, `;`, `|`, `$(`), and ends there.
const TSC = String.raw`tsc(?:\.js)?(?=\s|$|[;&|)"'\x60])`
const RUNNER = String.raw`\b(?:npx|npm\s+exec|pnpm(?:\s+(?:exec|dlx))?|yarn(?:\s+(?:exec|dlx))?|bunx|node)(?:\s+-[^\s=]*(?:[ =][^\s-]\S*)?)*\s+`
const PATH = String.raw`(?<!${TS7_ALIAS}\/bin)\/`
const COMMAND_START = String.raw`(?:^\s*(?:-\s+)?(?:run:\s*)?|(?:[;&|\x60"']|\$\()\s*)`
const BARE_TSC = new RegExp(`(?:${RUNNER}|${PATH}|${COMMAND_START})${TSC}`, 'm')

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

// Git hook scripts have no extension and sit in dot-directories, which filesUnder skips; a removed hook
// directory not yet created has no callers.
function hookFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
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

  // The type checker sees the language the bundle ships (DR7): an older target hides newer lib members, a newer one
  // lets code through that the bundle would have to down-level.
  it('compiles for the same language level as the Vite build', () => {
    const tsconfig = JSON.parse(readFileSync(join(WEB_ROOT, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: { target: string; lib: string[] }
    }
    const viteConfig = readFileSync(join(WEB_ROOT, 'vite.config.ts'), 'utf8')
    const viteBuildTarget = /\bbuild:\s*\{\s*target:\s*['"](\w+)['"]/.exec(viteConfig)?.[1]
    expect(viteBuildTarget).toBeDefined()
    expect(tsconfig.compilerOptions.target.toLowerCase()).toBe(viteBuildTarget)
    expect(tsconfig.compilerOptions.lib.map((lib) => lib.toLowerCase())).toContain(viteBuildTarget)
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

  // The tracked commit hooks live in .githooks (2.1-M14, 2.1-M196). The husky and beads hooks that still run
  // `npx tsc` are F3b's, which deletes them in its chunk 1 rather than rewriting them, so only the place the hooks
  // stay is guarded.
  it('has no bare compiler run in the git hooks', () => {
    expect(hookFiles(join(REPO_ROOT, '.githooks')).flatMap(bareTscLines)).toEqual([])
  })

  it('recognises the bare compiler runs it refuses', () => {
    for (const line of [
      'cd desktop/web && npx tsc --noEmit && npm test',
      'run: npx --prefix desktop/web tsc --noEmit -p desktop/web/tsconfig.json',
      'run: npx tsc -p e2e --noEmit',
      '"check:ui": "tsc --noEmit -p ui-gallery/tsconfig.json"',
      '"build": "tsc && npm run build:desktop:bundle"',
      'run: ./node_modules/.bin/tsc -p e2e --noEmit',
      'node_modules/.bin/tsc --noEmit',
      'node ./node_modules/typescript/bin/tsc --noEmit',
      'npm exec tsc -- --noEmit',
      'npm exec -- tsc --noEmit',
      'pnpm tsc --noEmit',
      'yarn tsc',
      'node_modules/.bin/tsc --pretty false --noEmit',
      'node node_modules/typescript/lib/tsc.js --noEmit',
      'tsc --pretty false -p .',
      '  - run: tsc',
      'echo $(tsc --version)',
    ]) {
      expect(BARE_TSC.test(line), line).toBe(true)
    }
    for (const line of [
      'run: npm run typecheck',
      TYPECHECK,
      'npm run typecheck -- -p ui-gallery/tsconfig.json',
      'the tsc cold time',
      '// tsc fails until it is listed here.',
      'npx tsc-alias',
      'the Frontend row (tsc, coverage as the suite, the policy tests)',
    ]) {
      expect(BARE_TSC.test(line), line).toBe(false)
    }
  })
})
