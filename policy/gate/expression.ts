// policy/gate/expression.ts: GitHub Actions expressions as the runner evaluates them, for the lane tests that hold a
// workflow's `if:` and concurrency group to the events it is meant to run on (canopi-f47t.52.240). The subset the
// workflows use: literals, context paths with `.*` filters and `[index]`, `!`, `==`, `!=`, `&&`, `||`, parentheses and
// the functions contains, startsWith, endsWith, format, fromJSON and toJSON. An expression outside it throws, naming
// it, rather than reading as false. Semantics follow GitHub's documentation: `&&` and `||` return an operand; `==`
// compares strings ignoring case and other types after coercion to numbers; null, false, 0, NaN and '' are falsy.

type Value = null | boolean | number | string | readonly Value[] | { readonly [key: string]: Value }
/** The elements a `.*` filter yields; a later property applies to each. */
class Spread {
  readonly items: readonly Value[]
  constructor(items: readonly Value[]) {
    this.items = items
  }
}
type Result = Value | Spread

const TOKEN = /\s*(?:('(?:[^']|'')*')|(\d+(?:\.\d+)?)|(==|!=|<=|>=|&&|\|\||[!<>().,[\]*])|([A-Za-z_][\w-]*))/y

const plain = (value: Result): Value => (value instanceof Spread ? value.items : value)
const truthy = (value: Result) => {
  const v = plain(value)
  return !(v === null || v === false || v === 0 || v === '' || (typeof v === 'number' && Number.isNaN(v)))
}
const toNumber = (v: Value): number => {
  if (v === null) return 0
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  if (typeof v === 'string') return v.trim() === '' ? 0 : Number(v)
  return Number.NaN
}
function equal(a: Value, b: Value): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase()
  if (typeof a === typeof b && (typeof a !== 'object' || a === null || b === null)) return a === b
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) return a === b
  return toNumber(a) === toNumber(b)
}
const text = (v: Value): string => (v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

const FUNCTIONS: Readonly<Record<string, (...args: Value[]) => Value>> = {
  contains: (search, item) => (Array.isArray(search) ? search.some((element) => equal(element, item ?? null))
    : text(search ?? null).toLowerCase().includes(text(item ?? null).toLowerCase())),
  startsWith: (s, p) => text(s ?? null).toLowerCase().startsWith(text(p ?? null).toLowerCase()),
  endsWith: (s, p) => text(s ?? null).toLowerCase().endsWith(text(p ?? null).toLowerCase()),
  format: (pattern, ...args) => text(pattern ?? null).replace(/\{(\d+)\}/g, (_, i: string) => text(args[Number(i)] ?? null)),
  fromJSON: (s) => JSON.parse(text(s ?? null)) as Value,
  toJSON: (v) => JSON.stringify(v ?? null, null, 2),
}

/** `source`, one expression without its `${{ }}`, evaluated against `context` (github, inputs, env, ...). */
export function evaluate(source: string, context: Readonly<Record<string, unknown>>): Value {
  const tokens: string[] = []
  TOKEN.lastIndex = 0
  while (TOKEN.lastIndex < source.length) {
    const at = TOKEN.lastIndex
    const match = TOKEN.exec(source)
    if (!match) {
      if (source.slice(at).trim() === '') break
      throw new Error(`expression ${JSON.stringify(source)}: cannot read ${JSON.stringify(source.slice(at))}`)
    }
    tokens.push(match[0].trim())
  }
  let i = 0
  const peek = () => tokens[i]
  const take = (expected?: string) => {
    const token = tokens[i++]
    if (token === undefined || (expected !== undefined && token !== expected)) {
      throw new Error(`expression ${JSON.stringify(source)}: expected ${expected ?? 'more'} at ${JSON.stringify(token ?? 'the end')}`)
    }
    return token
  }
  const member = (value: Result, key: Value): Result => {
    if (value instanceof Spread) return new Spread(value.items.map((item) => plain(member(item, key))).filter((v) => v !== null))
    if (value === null || typeof value !== 'object') return null
    const found = (value as Record<string, Value>)[String(key)]
    return found === undefined ? null : found
  }
  const primary = (): Result => {
    const token = take()
    if (token === '(') {
      const value = or()
      take(')')
      return value
    }
    if (token.startsWith("'")) return token.slice(1, -1).replace(/''/g, "'")
    if (/^\d/.test(token)) return Number(token)
    if (token === 'true' || token === 'false') return token === 'true'
    if (token === 'null') return null
    if (!/^[A-Za-z_]/.test(token)) throw new Error(`expression ${JSON.stringify(source)}: unexpected ${JSON.stringify(token)}`)
    if (peek() === '(') {
      const fn = FUNCTIONS[token]
      if (!fn) throw new Error(`expression ${JSON.stringify(source)}: no function ${token}`)
      take('(')
      const args: Value[] = []
      while (peek() !== ')') {
        args.push(plain(or()))
        if (peek() === ',') take(',')
      }
      take(')')
      return fn(...args)
    }
    let value: Result = (context[token] ?? null) as Value
    for (;;) {
      if (peek() === '.') {
        take('.')
        const key = take()
        value = key === '*' ? new Spread(Array.isArray(plain(value)) ? plain(value) as Value[]
          : Object.values((plain(value) ?? {}) as Record<string, Value>)) : member(value, key)
      } else if (peek() === '[') {
        take('[')
        const key = plain(or())
        take(']')
        value = member(value, key)
      } else return value
    }
  }
  const unary = (): Result => {
    if (peek() === '!') {
      take('!')
      return !truthy(unary())
    }
    return primary()
  }
  const comparison = (): Result => {
    const left = unary()
    if (peek() !== '==' && peek() !== '!=') return left
    const same = take() === '=='
    return equal(plain(left), plain(unary())) === same
  }
  const and = (): Result => {
    let value = comparison()
    while (peek() === '&&') {
      take('&&')
      const right = comparison()
      value = truthy(value) ? right : value
    }
    return value
  }
  const or = (): Result => {
    let value = and()
    while (peek() === '||') {
      take('||')
      const right = and()
      value = truthy(value) ? value : right
    }
    return value
  }
  const value = or()
  if (i !== tokens.length) throw new Error(`expression ${JSON.stringify(source)}: unexpected ${JSON.stringify(tokens[i])}`)
  return plain(value)
}

/** A workflow value as the runner reads it: each `${{ }}` replaced by its expression's text. */
export const interpolate = (value: string, context: Readonly<Record<string, unknown>>) =>
  value.replace(/\$\{\{(.*?)\}\}/gs, (_, source: string) => text(evaluate(source, context)))

/** An `if:` as the runner reads it: an expression with or without its `${{ }}`, true when truthy. */
export const holdsIf = (condition: string | undefined, context: Readonly<Record<string, unknown>>) => {
  if (condition === undefined) return true
  const bare = /^\s*\$\{\{(.*)\}\}\s*$/s.exec(condition)?.[1] ?? condition
  return truthy(evaluate(bare, context))
}
