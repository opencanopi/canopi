/**
 * failures/redact.ts: Owner of frontend text redaction, the one TS redactor (credential-literal-only-in-redactors,
 * contracts §13 Redaction, ADR 0025; AGENTS.md Secrets). Invariant: frontend text reaches the ring, the console or a
 * report only after `redact`; native `RedactedText` is never passed through it again.
 *
 * Credentials: each name of the generated table (`generated/redaction.ts`, shared with canopi-redact) as a query or
 * form parameter (`key=…`) or a JSON key (`"key": "…"`) keeps its name and loses its value. Paths: anything that
 * starts like a path (an absolute Unix path, a drive letter, a UNC or verbatim prefix, `file://`, `~/`, a
 * percent-encoded `/` or `\`) at the start or after any character that does not join words (canopi-redact's
 * `starts_path_after`) becomes the path token; a quoted path runs to its closing quote, and an unquoted one is read
 * as canopi-redact's `unquoted_length` reads it (`unquotedEnd`), with the generated known file extensions, so both
 * redactors end a path at the same character; the shared corpus pins the shapes.
 *
 * Input is capped before scanning and the path scan is linear (one backward pass precomputes what each path start
 * reads), so a multi-MB stack costs one bounded scan; a cut inside a credential or path still leaves its name or
 * start before it, so nothing survives the cut.
 */
import { CREDENTIAL_NAMES, KNOWN_EXTENSIONS, PATH_TOKEN, REDACTED_TOKEN } from '../generated/redaction'

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

// A path may start after anything but a character that joins words (a letter, a digit, a separator or `. _ - + % ~`),
// so a fraction, a date, `km/h`, `+/-` or a URL's later slashes start none (canopi-redact `starts_path_after`).
const JOINS_WORDS = /[\p{Alphabetic}\p{N}/\\._+%~-]/u
// Characters that end an unquoted path (canopi-redact `stops_path`); `<` and `>` keep a path token from growing into
// its neighbours.
const HARD_END = new Set(['\n', '\r', '"', "'", '`', ')', ']', '}', ',', ';', '<', '>'])
const WHITESPACE = /\s/
const EXTENSIONS: ReadonlySet<string> = new Set(KNOWN_EXTENSIONS)

function redactPaths(text: string): string {
  const ahead = scanAhead(text)
  let out = ''
  let copied = 0
  let index = 0
  while (index < text.length) {
    // After a path token the scan reads its `>`, as canopi-redact's does.
    const before = index === 0 ? ' ' : index === copied && copied > 0 ? '>' : text[index - 1]!
    if (JOINS_WORDS.test(before) || !startsPath(text, index)) {
      index += 1
      continue
    }
    const end = before === '"' || before === "'"
      ? quotedEnd(text, index, before)
      : trimTrailingDots(text, index, unquotedEnd(text, index, ahead))
    if (end <= index) {
      index += 1
      continue
    }
    out += text.slice(copied, index) + PATH_TOKEN
    copied = end
    index = end
  }
  return copied === 0 ? text : out + text.slice(copied)
}

interface Ahead {
  /** Per index, where a path's segment from there ends: the next hard end, pair colon, or space before a path. */
  readonly boundary: Int32Array
  /** Per index, the next whitespace or hard end. */
  readonly wordEnd: Int32Array
  /** Per index, the end and start of the last whole word starting there or later in its segment that reads as a path; -1 for none. */
  readonly readEnd: Int32Array
  readonly readStart: Int32Array
  /** Whether the text's last word reads as a path. */
  readonly lastWordReads: boolean
}

function endsWord(char: string): boolean {
  return WHITESPACE.test(char) || HARD_END.has(char)
}

/** Every per-index answer `unquotedEnd` reads, from one backward pass over the text and one over each word. */
function scanAhead(text: string): Ahead {
  const length = text.length
  const boundary = new Int32Array(length + 1).fill(length)
  const wordEnd = new Int32Array(length + 1).fill(length)
  const readEnd = new Int32Array(length + 1).fill(-1)
  const readStart = new Int32Array(length + 1).fill(-1)
  let segmentEnd = -1
  let segmentStart = -1
  for (let index = length - 1; index >= 0; index -= 1) {
    const char = text[index]!
    const after = text[index + 1]
    const pairColon = char === ':' && (after === undefined || WHITESPACE.test(after))
    const spaceBeforePath = WHITESPACE.test(char) && index + 1 < length && startsPath(text, index + 1)
    const ends = HARD_END.has(char) || pairColon || spaceBeforePath
    boundary[index] = ends ? index : boundary[index + 1]!
    wordEnd[index] = endsWord(char) ? index : wordEnd[index + 1]!
    // A segment's words lie between two boundaries; a word cut by a pair colon is no whole word.
    if (ends) segmentEnd = segmentStart = -1
    const startsWord = !endsWord(char) && (index === 0 || endsWord(text[index - 1]!))
    const end = wordEnd[index]!
    if (startsWord && segmentEnd < 0 && end < length && end <= boundary[index]! && readsAsPath(text.slice(index, end))) {
      segmentEnd = end
      segmentStart = index
    }
    readEnd[index] = segmentEnd
    readStart[index] = segmentStart
  }
  let lastSpace = length - 1
  while (lastSpace >= 0 && !WHITESPACE.test(text[lastSpace]!)) lastSpace -= 1
  return { boundary, wordEnd, readEnd, readStart, lastWordReads: readsAsPath(text.slice(lastSpace + 1)) }
}

function startsPath(text: string, index: number): boolean {
  const char = text[index]!
  const next = text[index + 1]
  if (char === '/') return next !== undefined && next !== '/' && !WHITESPACE.test(next) && !HARD_END.has(next)
  if (char === '\\') {
    const third = text[index + 2]
    return next === '\\' && third !== undefined && !WHITESPACE.test(third) && !HARD_END.has(third)
  }
  if (char === '~') return next === '/' || next === '\\'
  if (char === '%') return isEncodedSeparator(text, index)
  if (/[A-Za-z]/.test(char) && next === ':' && (text[index + 2] === '\\' || text[index + 2] === '/')) return true
  return (char === 'f' || char === 'F') && text.slice(index, index + 7).toLowerCase() === 'file://'
}

/** A quoted path runs to its closing quote or the line's end; a backslash before the quote escapes it in JSON, so it stays outside. */
function quotedEnd(text: string, start: number, quote: string): number {
  let end = text.length
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!
    if (char === quote || char === '\n' || char === '\r') {
      end = index
      break
    }
  }
  return text[end] === quote && end > start && text[end - 1] === '\\' ? end - 1 : end
}

/**
 * An unquoted path, read as canopi-redact's `unquoted_length` reads it: its segment runs to a hard end, a `:` before
 * whitespace or the end, or a word that starts another path. A segment ending at that `:` is all path (the words of a
 * name with spaces, then the error reason), unless its last word that reads as a path ends in a known file type
 * (`plan.canopi`), which ends the path there and keeps the reason; any other segment ends after its last word that
 * reads as a path. A last name word with neither a separator nor an extension and no `:` after it reads as the reason
 * and is kept: no rule tells such a word from the reason.
 */
function unquotedEnd(text: string, start: number, ahead: Ahead): number {
  const length = text.length
  const boundary = ahead.boundary[start]!
  const first = ahead.wordEnd[start]!
  const laterEnd = ahead.readEnd[start + 1]!
  const laterStart = ahead.readStart[start + 1]!
  const lastWhole = laterEnd >= 0 ? laterEnd : first
  // A boundary is a hard end, a space before another path or a pair colon; only the colon may end a path before it.
  if (text[boundary] === ':') {
    const fileNameEnded = laterEnd >= 0
      ? endsInFileName(text.slice(laterStart, laterEnd))
      : first < boundary && endsInFileName(text.slice(start, first))
    return fileNameEnded ? lastWhole : boundary
  }
  if (boundary < length) return lastWhole
  // To the text's end: its last word ends the path when it is the first or reads as a path.
  return first === length || ahead.lastWordReads ? length : lastWhole
}

/** A sentence's full stop after a path is not part of it, unless fewer than two characters would be left. */
function trimTrailingDots(text: string, start: number, end: number): number {
  let trimmed = end
  while (trimmed > start && text[trimmed - 1] === '.') trimmed -= 1
  return [...text.slice(start, Math.min(trimmed, start + 4))].length >= 2 ? trimmed : end
}

/** Whether a later word of a path's segment reads as part of a path with spaces: a separator, plain or encoded, or an extension. */
function readsAsPath(word: string): boolean {
  if (word.includes('/') || word.includes('\\')) return true
  const lower = word.toLowerCase()
  if (lower.includes('%2f') || lower.includes('%5c')) return true
  return word.split('.').slice(1).some((part) => /^[\p{Alphabetic}\p{N}]/u.test(part))
}

/** Whether a word's last component is a file name with a known extension (`redaction.json`'s `known_extensions`). */
function endsInFileName(word: string): boolean {
  const name = word.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  // ASCII case only, as canopi-redact compares (`eq_ignore_ascii_case`).
  return dot > 0 && EXTENSIONS.has(name.slice(dot + 1).replace(/[A-Z]/g, (letter) => letter.toLowerCase()))
}

/** A percent-encoded `/` (`%2F`) or `\` (`%5C`), either case, at `index`. */
function isEncodedSeparator(text: string, index: number): boolean {
  const code = text.slice(index, index + 3).toUpperCase()
  return code === '%2F' || code === '%5C'
}

/** The same error when redaction changes nothing, otherwise a redacted copy keeping its name (mapError's propagation). */
export function redactError(error: Error): Error {
  const message = redact(error.message)
  if (message === error.message) return error
  const redacted = new Error(message)
  redacted.name = error.name
  return redacted
}

