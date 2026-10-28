// Test support never copies a production helper (ADR 0028 Tests go through public surfaces, Checks; contracts §18 C09):
// a function declared at the top of a file under src/__tests__/support/ must not take the name of a function a
// production module exports, unless the support file imports that function. A copy drifts from the real helper, and
// the tests that use it then pass against code the app does not run. This is a policy test: it reads source text by
// design (policy/inventory.json names it by an exists{check} row).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SUPPORT_DIRECTORY = join('__tests__', 'support')
const SCRIPT = /\.tsx?$/
const TEST_FILE = /\.(test|spec)\.tsx?$|\.d\.ts$/

/** Top-level exported functions: `export function f`, `export const f = (...) =>` and `export const f = function`. */
const EXPORTED_FUNCTION = /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/gm
/** Top-level declared functions, exported or not, in the same three forms. */
const DECLARED_FUNCTION = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/gm
const NAMED_IMPORT = /^import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from/gm

function scripts(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((path) => SCRIPT.test(path))
    .map((path) => join(directory, path))
}

function names(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => (match[1] ?? match[2])!)
}

/** The names a file imports by name, as the exporting module spells them (`{ a as b }` imports a). */
function importedNames(source: string): Set<string> {
  return new Set([...source.matchAll(NAMED_IMPORT)].flatMap((match) => match[1]!.split(','))
    .map((specifier) => specifier.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!)
    .filter(Boolean))
}

/** Each support function that copies a production export by name, as `support path: name (production path)`. */
function supportCopies(sourceRoot: string): string[] {
  const support = join(sourceRoot, SUPPORT_DIRECTORY)
  const exporters = new Map<string, string>()
  for (const path of scripts(sourceRoot)) {
    const local = relative(sourceRoot, path)
    if (TEST_FILE.test(local) || local.startsWith(`__tests__${sep}`) || local.includes(`${sep}__tests__${sep}`)) continue
    for (const name of names(readFileSync(path, 'utf8'), EXPORTED_FUNCTION)) {
      if (!exporters.has(name)) exporters.set(name, local.split(sep).join('/'))
    }
  }
  return scripts(support).flatMap((path) => {
    const source = readFileSync(path, 'utf8')
    const imported = importedNames(source)
    const local = relative(sourceRoot, path).split(sep).join('/')
    return names(source, DECLARED_FUNCTION)
      .filter((name) => exporters.has(name) && !imported.has(name))
      .map((name) => `${local}: ${name} (${exporters.get(name)})`)
  }).sort()
}

describe('test support copies no production helper', () => {
  let temporary: string | null = null

  afterEach(() => {
    if (temporary) rmSync(temporary, { recursive: true, force: true })
    temporary = null
  })

  it('declares no function under the name of a production export unless it imports that export', () => {
    expect(supportCopies('src')).toEqual([])
  })

  it('names a support copy of a production export, and passes one that imports the real helper or only shares a local name', () => {
    temporary = mkdtempSync(join(tmpdir(), 'canopi-support-copies-'))
    const write = (path: string, text: string) => {
      mkdirSync(join(temporary!, path, '..'), { recursive: true })
      writeFileSync(join(temporary!, path), text)
    }
    write('app/geometry.ts', 'export function clamp(value: number): number { return value }\nexport const lerp = (a: number, b: number) => a + b\nfunction privateHelper() {}\n')
    write('app/geometry.test.ts', 'export function testOnly() {}\n')
    write('__tests__/support/copy.ts', 'export function clamp(value: number): number { return value }\nconst lerp = (a: number, b: number) => a + b\n')
    write('__tests__/support/wrapper.ts', "import { clamp as realClamp } from '../../app/geometry'\nexport function clamp(value: number): number { return realClamp(value) }\n")
    write('__tests__/support/unrelated.ts', 'function privateHelper() {}\nexport function testOnly() {}\n')

    expect(supportCopies(temporary)).toEqual([
      '__tests__/support/copy.ts: clamp (app/geometry.ts)',
      '__tests__/support/copy.ts: lerp (app/geometry.ts)',
    ])
  })
})
