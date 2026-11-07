/**
 * failures/redact.ts: Owner of frontend text redaction, the one TS redactor (credential-literal-only-in-redactors,
 * contracts §13 Redaction, ADR 0025; AGENTS.md Secrets). Invariant: frontend text reaches the ring, the console or a
 * report only after `redact`; native `RedactedText` is never passed through it again.
 *
 * Credentials: each name of the generated table (`generated/redaction.ts`, shared with canopi-redact) as a query or
 * form parameter (`key=…`) or a JSON key (`"key": "…"`) keeps its name and loses its value. Paths: anything that
 * starts like a path (an absolute Unix path, a drive letter, a UNC or verbatim prefix, `file://`, `~/`, a
 * percent-encoded `/`) after a boundary becomes the path token; a quoted path runs to its closing quote, an unquoted
 * one to the `: ` that ends a `path: reason` pair, else across spaces while the next word still holds a separator.
 *
 * Input is capped before scanning and the path scan is one linear pass, so a multi-MB stack costs one bounded scan; a
 * cut inside a credential or path still leaves its name or start before it, so nothing survives the cut.
 */
import { CREDENTIAL_NAMES, PATH_TOKEN, REDACTED_TOKEN } from '../generated/redaction'

/** The longest input scanned; the rest is dropped before redaction. */
const MAX_REDACT_INPUT = 64 * 1024

const NAMES = CREDENTIAL_NAMES.map((name) => name.replace(/[-_]/g, (separator) => `\\${separator}`)).join('|')
// A parameter value runs to a separator; `<` and `>` end it so a redacted token is never redacted again.
const CREDENTIAL_PARAMETER = new RegExp(`(^|[?&;\\s])(${NAMES})=[^\\s&#"')\\]},;<>]+`, 'gi')
// A JSON value runs to its closing quote, or to the end of a cut input.
const CREDENTIAL_JSON = new RegExp(`("(?:${NAMES})"\\s*:\\s*")(?:[^"\\\\\\n]|\\\\.)*("?)`, 'gi')

/** Redacts every credential value and path in frontend text (contracts §13). Total: never throws on a string. */
export function redact(text: string): string {
  const capped = text.length > MAX_REDACT_INPUT ? text.slice(0, MAX_REDACT_INPUT) : text
  const withoutCredentials = capped
    .replace(CREDENTIAL_PARAMETER, `$1$2=${REDACTED_TOKEN}`)
    .replace(CREDENTIAL_JSON, `$1${REDACTED_TOKEN}$2`)
  return redactPaths(withoutCredentials)
}

const BOUNDARY = new Set([' ', '\t', '\n', '\r', '"', "'", '(', '[', '{', '='])
// Characters that end an unquoted path; `<` and `>` keep a path token from growing into its neighbours.
const HARD_END = new Set(['\n', '\r', '"', "'", ')', ']', '}', ',', ';', '<', '>'])

function redactPaths(text: string): string {
  const { nextHardEnd, nextColonSpace } = scanAhead(text)
  let out = ''
  let copied = 0
  let index = 0
  while (index < text.length) {
    const before = index === 0 ? ' ' : text[index - 1]!
    if (!BOUNDARY.has(before) || !startsPath(text, index)) {
      index += 1
      continue
    }
    const end = before === '"' || before === "'"
      ? quotedEnd(text, index, before)
      : unquotedEnd(text, index, nextHardEnd, nextColonSpace)
    out += text.slice(copied, index) + PATH_TOKEN
    copied = end
    index = end
  }
  return copied === 0 ? text : out + text.slice(copied)
}

/** Per index, the next hard end and the next `: ` (colon then whitespace or end), from one backward pass. */
function scanAhead(text: string): { nextHardEnd: Int32Array; nextColonSpace: Int32Array } {
  const nextHardEnd = new Int32Array(text.length + 1)
  const nextColonSpace = new Int32Array(text.length + 1)
  nextHardEnd[text.length] = text.length
  nextColonSpace[text.length] = text.length
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index]!
    nextHardEnd[index] = HARD_END.has(char) ? index : nextHardEnd[index + 1]!
    const after = text[index + 1]
    const endsPair = char === ':' && (after === undefined || after === ' ' || after === '\t' || after === '\n' || after === '\r')
    nextColonSpace[index] = endsPair ? index : nextColonSpace[index + 1]!
  }
  return { nextHardEnd, nextColonSpace }
}

function startsPath(text: string, index: number): boolean {
  const char = text[index]!
  const next = text[index + 1]
  if (char === '/') return next !== undefined && !/\s/.test(next)
  if (char === '\\') return next === '\\' && text[index + 2] !== undefined && !/\s/.test(text[index + 2]!)
  if (char === '~') return next === '/' || next === '\\'
  if (char === '%') return next === '2' && (text[index + 2] === 'F' || text[index + 2] === 'f')
  if (/[A-Za-z]/.test(char) && next === ':' && (text[index + 2] === '\\' || text[index + 2] === '/')) return true
  return (char === 'f' || char === 'F') && text.slice(index, index + 7).toLowerCase() === 'file://'
}

function quotedEnd(text: string, start: number, quote: string): number {
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!
    if (char === quote || char === '\n' || char === '\r') return index
  }
  return text.length
}

function unquotedEnd(text: string, start: number, nextHardEnd: Int32Array, nextColonSpace: Int32Array): number {
  const hard = nextHardEnd[start]!
  const colon = nextColonSpace[start]!
  // `<path>: <reason>`: everything before the pair's colon is the path, spaces included.
  if (colon < hard) return colon
  let end = wordEnd(text, start, hard)
  // Across a space while the next word still holds a path separator (`/home/ana/My Designs/plan.canopi`).
  while (end < hard && text[end] === ' ') {
    const next = wordEnd(text, end + 1, hard)
    if (!holdsSeparator(text, end + 1, next)) break
    end = next
  }
  return end
}

function wordEnd(text: string, start: number, limit: number): number {
  let index = start
  while (index < limit && !/\s/.test(text[index]!)) index += 1
  return index
}

function holdsSeparator(text: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    const char = text[index]!
    if (char === '/' || char === '\\') return true
    if (char === '%' && text[index + 1] === '2' && (text[index + 2] === 'F' || text[index + 2] === 'f')) return true
  }
  return false
}

/** The same error when redaction changes nothing, otherwise a redacted copy keeping its name (mapError's propagation). */
export function redactError(error: Error): Error {
  const message = redact(error.message)
  if (message === error.message) return error
  const redacted = new Error(message)
  redacted.name = error.name
  return redacted
}

