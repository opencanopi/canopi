// The TypeScript pair (2.1-M184, 2.1-Q205): TypeScript 7 type-checks, and only through `npm run typecheck`;
// `typescript` stays TypeScript 6 for the tools that read its API (dependency-cruiser, Stryker). Both packages
// ship a compiler, so a bare `npx tsc` or `tsc --noEmit` could silently run the other one: none is allowed in
// the package scripts, CI workflows, docs or scripts. scripts/gate.py's frontend `scans` name the files read here, so a
// change to one alone runs this test, locally and in CI (canopi-f47t.52.228.10); a new scanned path joins them.
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

// A compiler run that does not go through the typecheck script. `tsc` counts wherever it sits as a command, whatever
// arguments follow: run by `npx`, `npm exec` or `node` (options included; the repository is npm-only), named by a path
// (`node_modules/.bin/tsc` may link to either compiler; only the TypeScript 7 alias the script runs is allowed), or at
// the start of a command (a line, a YAML `run:`, a quote, after `&&`, `;` or `|`), past a hook's shell keywords and
// prefixes (`if`, `!`, `then`, `else`, `exec`, `xargs -r`, `env`, `VAR=1`), and ends at a space, an operator, a quote
// or a closing parenthesis. A backtick does not start a command: Markdown prose may name `tsc`.
const TSC = String.raw`tsc(?=\s|$|[;&|)"'\x60])`
const RUNNER = String.raw`\b(?:npx|npm\s+exec|node)(?:\s+-[^\s=]*(?:[ =][^\s-]\S*)?)*\s+`
const PATH = String.raw`(?<!${TS7_ALIAS}\/bin)\/`
const COMMAND_START = String.raw`(?:^\s*(?:-\s+)?(?:run:\s*)?|[;&|"']\s*)`
const SHELL_PREFIX = String.raw`(?:(?:(?:if|then|else|exec|xargs|env)(?:\s+-\S+)*|!|\w+=\S*)\s+)*`
const BARE_TSC = new RegExp(`(?:${RUNNER}|${PATH}|${COMMAND_START}${SHELL_PREFIX})${TSC}`, 'm')

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

// Git hook scripts have no extension and sit in dot-directories, which filesUnder skips; a hook
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

  it('has no bare compiler run in README.md or AGENTS.md', () => {
    const files = [join(REPO_ROOT, 'README.md'), join(REPO_ROOT, 'AGENTS.md')]
    expect(files.flatMap(bareTscLines)).toEqual([])
  })

  // The commit hooks are the tracked .githooks wrappers (2.1-M14, 2.1-M196); the commit gate they run lives in scripts/,
  // which the scripts check above covers, and types through `npm run typecheck` (2.1-Q205).
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
      'node_modules/.bin/tsc --pretty false --noEmit',
      'tsc --pretty false -p .',
      '  - run: tsc',
      'if ! tsc --noEmit; then',
      'then tsc --noEmit',
      '  else tsc -p e2e',
      'exec tsc --noEmit',
      'xargs tsc',
      '(cd desktop/web && npx tsc)',
      'git diff --name-only | xargs -r tsc --noEmit',
      'env NODE_OPTIONS=--max-old-space-size=4096 tsc --noEmit',
      'CI=1 tsc --noEmit',
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
      'Run \x60tsc\x60 locally',
      'the time tsc takes',
      'if the tsc run fails',
    ]) {
      expect(BARE_TSC.test(line), line).toBe(false)
    }
  })
})
