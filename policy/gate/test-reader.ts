// policy/gate/test-reader.ts: how the deletion guard (deletion-guard.ts) reads a file's tests (2.1-Q224, 2.1-Q267):
// TS/TSX tests and Playwright specs through the TypeScript compiler's syntax tree (`it`/`test` titles as the runner
// reads them, escaped quotes included, canopi-f47t.52.254), Rust `#[test]` functions and Python `test_` methods by
// Unicode-aware regex; each test's body, its assertions and what its whole-value and membership asserts judge.
//
// An assertion is a call of the closed callee set (design check AR7): `expect`, `expect.soft`, `expect.poll`, `assert`
// and `assert.<x>`, and `<x>.waitUntil` (browser.waitUntil, canopi-f47t.52.255), never another `expect.<x>` such as
// expect.objectContaining. "No fewer assertions" (weaker) credits a whole-value equality new on an expression (Python
// assertEqual, assertListEqual, assertDictEqual; TS toEqual, toStrictEqual) with the membership asserts on that same
// expression it replaces (assertIn, assertNotIn; toContain, toContainEqual, with or without .not).
import { createRequire } from 'node:module'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as TS from 'typescript'
import { LSTRIP, strip } from './ledger.ts'

/** A file's text at the revision a check reads, or undefined when it has none there. */
export type Read = (path: string) => Promise<string | undefined>
export type Finding = readonly [rule: string, text: string]
type Counts = ReadonlyMap<string, number>

/** One test's body: its text, its assertions and the expressions its whole-value and membership asserts judge. */
export interface Body {
  readonly text: string
  readonly asserts: number
  readonly whole: Counts
  readonly member: Counts
}

/** A refusal that no commit's content causes: the gate cannot read what it judges (a missing install). */
export class GuardRefusal extends Error {}

export const W = String.raw`[\p{L}\p{N}_]`
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:e2e|e2e-release|__tests__)\/.*\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|\.rs$/u
export const JS = /\.[cm]?[jt]sx?$/u
export const RUST_TEST_SOURCE = String.raw`#\[(?:[\p{L}\p{N}_:]+::)?test\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+(${W}+)`
const RUST_TEST = new RegExp(RUST_TEST_SOURCE, 'gu')
const PY_TEST = new RegExp(String.raw`^\s*def\s+(test_${W}+)\s*\(`, 'gmu')
const ASSERTS = {
  rs: new RegExp(String.raw`(?<!${W})(?:debug_)?(?:prop_)?assert(?:_eq|_ne|_matches)?!\s*[(\[{]`, 'gu'),
  py: new RegExp(String.raw`(?<!${W})self\.assert${W}+\s*\(|^\s*assert(?!${W})`, 'gmu'),
}
/** The closed matcher-swap list (2.1-M199): its text as the gate names it, then (strict, looser) counted per test. */
const SWAPS: readonly (readonly [string, RegExp, RegExp])[] = [
  ['.toStrictEqual( to .toEqual(', /\.toStrictEqual\(/gu, /\.toEqual\(/gu],
  ['.toEqual( to .toMatchObject(', /\.toEqual\(/gu, /\.toMatchObject\(/gu],
  ['.toBe((?!)) to .toBe(?:Truthy|Defined)()', /\.toBe\((?!\))/gu, /\.toBe(?:Truthy|Defined)\(\)/gu],
  ['.toHaveBeenCalledWith( to .toHaveBeenCalled()', /\.toHaveBeenCalledWith\(/gu, /\.toHaveBeenCalled\(\)/gu],
  ['.toThrow((?!)) to .toThrow()', /\.toThrow\((?!\))/gu, /\.toThrow\(\)/gu],
  ['bassert_eq! to bassert!', new RegExp(`(?<!${W})assert_eq!`, 'gu'), new RegExp(`(?<!${W})assert!`, 'gu')],
  ['.assertEqual( to .assertTrue(', /\.assertEqual\(/gu, /\.assertTrue\(/gu],
]
export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')
export const count = (pattern: RegExp, text: string) => [...text.matchAll(pattern)].length
export const bump = (counts: Map<string, number>, key: string, by = 1) => counts.set(key, (counts.get(key) ?? 0) + by)
/** Python's len(s) - len(s.lstrip()). */
const indentOf = (text: string) => text.length - text.replace(LSTRIP, '').length

/** Whether `message` names `title` in quotes: a title that merely occurs in a sentence names nothing. */
export function quoted(title: string, message: string): boolean {
  return new RegExp(`['"\`\u2018\u201c]${escapeRegExp(title)}['"\`\u2019\u201d]`, 'u').test(message)
}

export const isTestFile = (path: string | undefined): boolean => Boolean(path && TEST_FILE.test(path))
type Language = 'js' | 'rs' | 'py'
export const language = (path: string): Language => (JS.test(path) ? 'js' : path.endsWith('.rs') ? 'rs' : 'py')

/** The repository this module runs in: desktop/web there holds the TypeScript compiler it reads tests with. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
let typescript: typeof TS | undefined
/** The TypeScript compiler from desktop/web's install; missing, a refusal naming npm ci. */
export function loadTypescript(): typeof TS {
  if (typescript) return typescript
  try {
    typescript = createRequire(posix.join(ROOT, 'desktop/web/package.json'))('typescript') as typeof TS
  } catch {
    throw new GuardRefusal('desktop/web/node_modules/typescript cannot be loaded to read the commit\'s TS tests: '
      + 'run npm ci in desktop/web')
  }
  return typescript
}

const TITLE_MODIFIERS = new Set(['only', 'skip', 'fixme', 'todo', 'fails', 'concurrent', 'sequential'])
const TITLE_CALLS = new Set(['each', 'skipIf', 'runIf'])

/** Whether `callee` is `it` or `test` with the runner's modifiers (`it.skip`, `test.each(rows)`, `it.skipIf(c)`). */
function isTestCallee(ts: typeof TS, callee: TS.Expression): boolean {
  if (ts.isIdentifier(callee)) return callee.text === 'it' || callee.text === 'test'
  if (ts.isPropertyAccessExpression(callee)) return TITLE_MODIFIERS.has(callee.name.text) && isTestCallee(ts, callee.expression)
  if (ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression)) {
    return TITLE_CALLS.has(callee.expression.name.text) && isTestCallee(ts, callee.expression.expression)
  }
  return false
}

/** Whether a call's callee is in the closed assertion set (AR7). */
function isAssertion(ts: typeof TS, callee: TS.Expression): boolean {
  if (ts.isIdentifier(callee)) return callee.text === 'expect' || callee.text === 'assert'
  if (!ts.isPropertyAccessExpression(callee)) return false
  const name = callee.name.text
  if (name === 'waitUntil') return true
  if (!ts.isIdentifier(callee.expression)) return false
  return callee.expression.text === 'assert' || (callee.expression.text === 'expect' && (name === 'soft' || name === 'poll'))
}

/** `expect(x).toEqual(` (whole) or `expect(x)[.not].toContain[Equal](` (member) for a plain expect call, else none. */
function judgedBy(ts: typeof TS, call: TS.CallExpression): 'whole' | 'member' | undefined {
  const first = call.parent
  if (!ts.isPropertyAccessExpression(first) || first.expression !== call) return undefined
  let access: TS.PropertyAccessExpression = first
  const negated = first.name.text === 'not'
  if (negated) {
    const next = first.parent
    if (!ts.isPropertyAccessExpression(next) || next.expression !== first) return undefined
    access = next
  }
  if (!ts.isCallExpression(access.parent) || access.parent.expression !== access) return undefined
  const name = access.name.text
  if (!negated && (name === 'toEqual' || name === 'toStrictEqual')) return 'whole'
  return name === 'toContain' || name === 'toContainEqual' ? 'member' : undefined
}

/** The TS/TSX tests of `text`: each `it`/`test` call's title (cooked) and the rest of its arguments as the body. */
function jsTests(path: string, text: string): Map<string, Body[]> {
  const ts = loadTypescript()
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
  const found = new Map<string, Body[]>()
  const visit = (node: TS.Node) => {
    if (ts.isCallExpression(node) && isTestCallee(ts, node.expression)) {
      const [first] = node.arguments
      const title = first === undefined ? undefined
        : ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) ? first.text
          : ts.isTemplateExpression(first) ? first.getText(source).slice(1, -1) : undefined
      if (first !== undefined && title !== undefined) {
        let asserts = 0
        const whole = new Map<string, number>()
        const member = new Map<string, number>()
        const inBody = (inner: TS.Node) => {
          if (ts.isCallExpression(inner)) {
            if (isAssertion(ts, inner.expression)) asserts += 1
            const [subject] = inner.arguments
            if (ts.isIdentifier(inner.expression) && inner.expression.text === 'expect' && subject !== undefined) {
              const by = judgedBy(ts, inner)
              if (by) bump(by === 'whole' ? whole : member, subject.getText(source).replace(/\s+/gu, ''))
            }
          }
          ts.forEachChild(inner, inBody)
        }
        for (const argument of node.arguments.slice(1)) inBody(argument)
        const list = found.get(title) ?? []
        list.push({ text: text.slice(first.end, node.end), asserts, whole, member })
        found.set(title, list)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** A Rust function's braces or a Python method's indented block, from `match` (Python's character scanner). */
export function blockBody(kind: 'rs' | 'py', text: string, match: RegExpMatchArray): string {
  const end = (match.index ?? 0) + match[0].length
  if (kind === 'py') {
    const indent = indentOf(match[0])
    const lines = text.slice(end).split('\n')
    let stop = lines.length
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i] ?? ''
      if (strip(line) && indentOf(line) <= indent) {
        stop = i
        break
      }
    }
    return lines.slice(0, stop).join('\n')
  }
  const start = text.indexOf('{', end)
  if (start === -1) return ''
  let depth = 0
  let quote: string | undefined
  for (let i = start; i < text.length;) {
    const c = text[i] ?? ''
    if (quote) {
      i += c === '\\' ? 2 : 1
      if (c === quote) quote = undefined
      continue
    }
    if (text.startsWith('//', i)) {
      const newline = text.indexOf('\n', i)
      i = newline === -1 ? text.length : newline
      continue
    }
    if (c === '"' || c === '`') quote = c
    else if ('([{'.includes(c)) depth += 1
    else if (')]}'.includes(c)) {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
    i += 1
  }
  return text.slice(start)
}

/** The top-level arguments of the call whose '(' ends at `start`, whitespace-free (Python's call_args). */
function callArgs(text: string, start: number): string[] {
  const args: string[] = []
  let depth = 0
  let quote: string | undefined
  let begin = start
  for (let i = start; i < text.length;) {
    const c = text[i] ?? ''
    if (quote) {
      i += c === '\\' ? 2 : 1
      if (c === quote) quote = undefined
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if ('([{'.includes(c)) depth += 1
    else if (')]}'.includes(c) && depth) depth -= 1
    else if (c === ')' || (c === ',' && !depth)) {
      args.push(text.slice(begin, i).replace(/\s+/gu, ''))
      begin = i + 1
      if (c === ')') return args.filter((arg) => arg)
    }
    i += 1
  }
  return []
}

const PY_WHOLE = /(?<![\p{L}\p{N}_])self\.assert(?:Equal|ListEqual|DictEqual)\s*\(/gu
const PY_MEMBER = /(?<![\p{L}\p{N}_])self\.assert(?:In|NotIn)\s*\(/gu

function regexBody(kind: 'rs' | 'py', text: string): Body {
  const whole = new Map<string, number>()
  const member = new Map<string, number>()
  if (kind === 'py') {
    for (const [counts, pattern, take] of [[whole, PY_WHOLE, 2], [member, PY_MEMBER, 1]] as const) {
      for (const match of text.matchAll(pattern)) {
        const args = callArgs(text, (match.index ?? 0) + match[0].length)
        for (const arg of take === 2 ? args.slice(0, 2) : args.slice(1, 2)) bump(counts, arg)
      }
    }
  }
  return { text, asserts: count(ASSERTS[kind], text), whole, member }
}

/** {title: [body, ...]} for each test in `text` (a title more than once keeps each body). */
export function tests(path: string, text: string | undefined): Map<string, Body[]> {
  if (!text) return new Map()
  const kind = language(path)
  if (kind === 'js') return jsTests(path, text)
  const found = new Map<string, Body[]>()
  for (const match of text.matchAll(kind === 'rs' ? RUST_TEST : PY_TEST)) {
    const title = match[1] ?? ''
    const list = found.get(title) ?? []
    list.push(regexBody(kind, blockBody(kind, text, match)))
    found.set(title, list)
  }
  return found
}

const asserts = (bodies: readonly Body[]) => bodies.reduce((sum, body) => sum + body.asserts, 0)

function judged(bodies: readonly Body[]): readonly [Counts, Counts] {
  const whole = new Map<string, number>()
  const member = new Map<string, number>()
  for (const body of bodies) {
    for (const [key, n] of body.whole) bump(whole, key, n)
    for (const [key, n] of body.member) bump(member, key, n)
  }
  return [whole, member]
}

/**
 * Whether the new bodies assert less than the old: fewer assertions once each whole-value equality new on an
 * expression is credited with the membership asserts on that expression it replaces.
 */
export function weaker(oldPath: string, oldBodies: readonly Body[], newPath: string, newBodies: readonly Body[]): boolean {
  let credit = 0
  const kind = language(oldPath)
  if (kind !== 'rs' && kind === language(newPath)) {
    const [oldWhole, oldMember] = judged(oldBodies)
    const [newWhole, newMember] = judged(newBodies)
    for (const [expression, n] of newWhole) {
      const added = n - (oldWhole.get(expression) ?? 0)
      if (added > 0) credit += Math.max(0, (oldMember.get(expression) ?? 0) - (newMember.get(expression) ?? 0) - added)
    }
  }
  return asserts(newBodies) + credit < asserts(oldBodies)
}

/** The closed-list matcher swaps `after` shows against any of the candidate `befores`, in the list's order. */
export function swaps(befores: readonly (readonly Body[])[], after: readonly Body[]): string[] {
  const wases = befores.map((before) => before.map((body) => body.text).join(''))
  const now = after.map((body) => body.text).join('')
  return SWAPS.filter(([, strict, loose]) => wases.some((was) => count(strict, now) < count(strict, was)
    && count(loose, now) > count(loose, was))).map(([name]) => name)
}


export const byCodePoint = (a: string, b: string) => {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0)
    if (d) return d
  }
  return x.length - y.length
}

const PLACEHOLDER = /(%[sdifjoOc#]|\$\{[^}]*\}|\$[A-Za-z_][\w.]*)/u

/** The values `title` gives the placeholders (`%i`, `${n}`, `$name`) of `pattern`, an `.each` template naming its rows:
 * none when it is `pattern` itself, undefined when it is no row of it. */
function filled(pattern: string, title: string): string[] | undefined {
  if (pattern === title) return []
  const parts = pattern.split(PLACEHOLDER)
  if (parts.length === 1) return undefined
  const match = new RegExp(`^${parts.map((part, i) => (i % 2 ? '(.*)' : escapeRegExp(part))).join('')}$`, 'su').exec(title)
  return match ? match.slice(1) : undefined
}

/** Whether `title` is `pattern` or a row of it. */
const fills = (pattern: string, title: string): boolean => filled(pattern, title) !== undefined

/** The row of template `to` that `title`, a row of template `from`, becomes (`Rewords-test: <from> -> <to>`). */
export function refill(from: string, to: string, title: string): string | undefined {
  const values = filled(from, title)
  if (!values) return undefined
  let next = 0
  return to.split(PLACEHOLDER).map((part, i) => (i % 2 ? values[next++] ?? part : part)).join('')
}

/** The bodies of the test `title` names in `text`: its own title, else a title pattern it fills. */
export function bodiesFor(path: string, text: string | undefined, title: string): Body[] | undefined {
  const found = tests(path, text)
  const exact = found.get(title)
  if (exact) return exact
  for (const [pattern, bodies] of found) if (fills(pattern, title)) return bodies
  return undefined
}
