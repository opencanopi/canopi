import { normalizeSpeciesSearch } from '../../platform/page-rules'

/**
 * The plant finder's matcher: pure, synchronous and shared by every plant list.
 *
 * A query matches a record when every query word matches one of its names: a whole
 * word, a word start or (for words of three letters or more) any part of a name. Codes
 * match whole or from their start. Case, accents and ß/ss follow the species search
 * normalization authority. Only when nothing matches exactly does the matcher accept
 * small typos (one edit for words of 4–6 letters, two from 7), and it then reports
 * the words it searched instead so the list can say "Showing results for …".
 */

type PlantFinderNameKind = 'common' | 'scientific' | 'synonym' | 'code'

export interface PlantFinderName {
  readonly text: string
  readonly kind: PlantFinderNameKind
}

export interface PlantFinderRecord<K> {
  readonly key: K
  readonly names: readonly PlantFinderName[]
}

/** A matched part of a name, in UTF-16 offsets of the original text. */
export interface PlantFinderRange {
  readonly start: number
  readonly end: number
}

interface PlantFinderMark {
  readonly text: string
  readonly ranges: readonly PlantFinderRange[]
}

export interface PlantFinderHit<K> {
  readonly key: K
  readonly score: number
  readonly typo: boolean
  readonly marks: readonly PlantFinderMark[]
}

export interface PlantFinderResult<K> {
  /** False when the query has no searchable text: callers show their whole list. */
  readonly active: boolean
  /** Hits, best first; ties keep the records' order. */
  readonly hits: readonly PlantFinderHit<K>[]
  readonly byKey: ReadonlyMap<K, PlantFinderHit<K>>
  /** What was searched instead when only typo-tolerant matches were found. */
  readonly correction: string | null
}

interface FoldedWord {
  readonly start: number
  readonly end: number
  readonly value: string
}

interface FoldedText {
  readonly text: string
  readonly folded: string
  /** Original start offset of each folded code unit. */
  readonly starts: readonly number[]
  /** Original end offset of each folded code unit. */
  readonly ends: readonly number[]
  readonly words: readonly FoldedWord[]
}

interface TokenMatch {
  readonly score: number
  readonly nameIndex: number
  readonly start: number
  readonly end: number
  /** The corrected word when this match needed a typo allowance. */
  readonly correction: string | null
}

const KIND_BONUS: Readonly<Record<PlantFinderNameKind, number>> = {
  code: 6,
  common: 4,
  scientific: 2,
  synonym: 0,
}

const EXACT_WORD = 90
const WORD_START = 75
const INSIDE_WORD = 45
const CODE_EXACT = 100
const CODE_START = 70
const TYPO_BASE = 35
const TYPO_STEP = 10
const TYPO_PARTIAL_WORD = 5
const WHOLE_NAME_BONUS = 20
const NAME_START_BONUS = 10
const FIRST_WORD_BONUS = 5

const FOLDED_CHAR_CACHE = new Map<string, string>()
const FOLDED_TEXT_CACHE = new Map<string, FoldedText>()
const FOLDED_TEXT_CACHE_LIMIT = 8192
const MARK = /\p{M}/u
const NON_LATIN = /[^\u0000-ɏ]/u

export function findPlants<K>(
  records: readonly PlantFinderRecord<K>[],
  query: string,
): PlantFinderResult<K> {
  const tokens = foldText(query).words.map((word) => word.value)
  if (tokens.length === 0) return inactiveResult()
  const phrase = tokens.join(' ')
  const folded = records.map((record) => record.names.map((name) => foldText(name.text)))

  const exact = collectHits(records, folded, tokens, phrase, false)
  if (exact.length > 0) return activeResult(exact.map((entry) => entry.hit), null)
  const typo = collectHits(records, folded, tokens, phrase, true)
  return activeResult(typo.map((entry) => entry.hit), typo[0]?.correction ?? null)
}

/** The ranges a hit marks inside one displayed text, or none. */
export function plantFinderRangesIn<K>(
  hit: PlantFinderHit<K> | undefined,
  text: string | null | undefined,
): readonly PlantFinderRange[] {
  if (!hit || !text) return []
  return hit.marks.find((mark) => mark.text === text)?.ranges ?? []
}

function inactiveResult<K>(): PlantFinderResult<K> {
  return { active: false, hits: [], byKey: new Map(), correction: null }
}

function activeResult<K>(hits: readonly PlantFinderHit<K>[], correction: string | null): PlantFinderResult<K> {
  return { active: true, hits, byKey: new Map(hits.map((hit) => [hit.key, hit])), correction }
}

function collectHits<K>(
  records: readonly PlantFinderRecord<K>[],
  folded: readonly (readonly FoldedText[])[],
  tokens: readonly string[],
  phrase: string,
  allowTypos: boolean,
): { readonly hit: PlantFinderHit<K>; readonly correction: string; readonly index: number }[] {
  const hits: { hit: PlantFinderHit<K>; correction: string; index: number }[] = []
  records.forEach((record, index) => {
    const names = folded[index]!
    const matches: TokenMatch[] = []
    for (const token of tokens) {
      const match = bestTokenMatch(token, record.names, names, allowTypos)
      if (!match) return
      matches.push(match)
    }
    if (allowTypos && matches.every((match) => match.correction === null)) return
    let score = matches.reduce((sum, match) => sum + match.score, 0) / matches.length
    score += phraseBonus(record.names, names, phrase)
    hits.push({
      hit: {
        key: record.key,
        score,
        typo: allowTypos,
        marks: marksFor(record.names, names, matches),
      },
      correction: matches.map((match, tokenIndex) => match.correction ?? tokens[tokenIndex]!).join(' '),
      index,
    })
  })
  hits.sort((left, right) => right.hit.score - left.hit.score || left.index - right.index)
  return hits
}

function bestTokenMatch(
  token: string,
  names: readonly PlantFinderName[],
  folded: readonly FoldedText[],
  allowTypos: boolean,
): TokenMatch | null {
  let best: TokenMatch | null = null
  names.forEach((name, nameIndex) => {
    const text = folded[nameIndex]!
    const match = name.kind === 'code'
      ? matchCode(token, text, nameIndex)
      : matchName(token, text, nameIndex) ?? (allowTypos ? matchTypo(token, text, nameIndex) : null)
    if (!match) return
    const scored = { ...match, score: match.score + KIND_BONUS[name.kind] }
    if (!best || scored.score > best.score) best = scored
  })
  return best
}

function matchCode(token: string, code: FoldedText, nameIndex: number): TokenMatch | null {
  const value = code.folded.replace(/ /g, '')
  if (value === token) return { score: CODE_EXACT, nameIndex, start: 0, end: code.folded.length, correction: null }
  if (value.startsWith(token)) return { score: CODE_START, nameIndex, start: 0, end: token.length, correction: null }
  return null
}

function matchName(token: string, name: FoldedText, nameIndex: number): TokenMatch | null {
  let best: TokenMatch | null = null
  for (const [wordIndex, word] of name.words.entries()) {
    const firstWord = wordIndex === 0 ? FIRST_WORD_BONUS : 0
    if (word.value === token) {
      return { score: EXACT_WORD + firstWord, nameIndex, start: word.start, end: word.end, correction: null }
    }
    if (!best && word.value.startsWith(token)) {
      best = { score: WORD_START + firstWord, nameIndex, start: word.start, end: word.start + token.length, correction: null }
    }
  }
  if (best) return best
  if (token.length < 3 && !NON_LATIN.test(token)) return null
  const index = name.folded.indexOf(token)
  return index < 0 ? null : { score: INSIDE_WORD, nameIndex, start: index, end: index + token.length, correction: null }
}

function matchTypo(token: string, name: FoldedText, nameIndex: number): TokenMatch | null {
  const allowed = token.length >= 7 ? 2 : token.length >= 4 ? 1 : 0
  if (allowed === 0) return null
  let best: { distance: number; word: FoldedWord; length: number } | null = null
  for (const word of name.words) {
    // Compare with the whole word and with its starts around the query's length,
    // so "pomier" finds "Pommiers" as well as "Pommier".
    const lengths = new Set([word.value.length, token.length - 1, token.length, token.length + 1])
    for (const length of lengths) {
      if (length < 1 || length > word.value.length) continue
      const distance = boundedEditDistance(token, word.value.slice(0, length), allowed)
      if (distance > allowed) continue
      if (!best || distance < best.distance || (distance === best.distance && length > best.length)) {
        best = { distance, word, length }
      }
    }
  }
  if (!best || best.distance === 0) return null
  const start = best.word.start
  const end = start + best.length
  const original = name.text.slice(name.starts[start], name.ends[end - 1])
  return {
    score: TYPO_BASE - TYPO_STEP * best.distance - (best.length < best.word.value.length ? TYPO_PARTIAL_WORD : 0),
    nameIndex,
    start,
    end,
    correction: original.toLocaleLowerCase(),
  }
}

function phraseBonus(
  names: readonly PlantFinderName[],
  folded: readonly FoldedText[],
  phrase: string,
): number {
  let bonus = 0
  folded.forEach((name, index) => {
    if (names[index]!.kind === 'code') return
    const value = name.words.map((word) => word.value).join(' ')
    if (value === phrase) bonus = Math.max(bonus, WHOLE_NAME_BONUS)
    else if (value.startsWith(phrase)) bonus = Math.max(bonus, NAME_START_BONUS)
  })
  return bonus
}

function marksFor(
  names: readonly PlantFinderName[],
  folded: readonly FoldedText[],
  matches: readonly TokenMatch[],
): PlantFinderMark[] {
  const byName = new Map<number, PlantFinderRange[]>()
  for (const match of matches) {
    const name = folded[match.nameIndex]!
    const ranges = byName.get(match.nameIndex) ?? []
    ranges.push({ start: name.starts[match.start]!, end: name.ends[match.end - 1]! })
    byName.set(match.nameIndex, ranges)
  }
  return [...byName.entries()].map(([nameIndex, ranges]) => ({
    text: names[nameIndex]!.text,
    ranges: mergeRanges(ranges),
  }))
}

function mergeRanges(ranges: PlantFinderRange[]): PlantFinderRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start)
  const merged: PlantFinderRange[] = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (last && range.start <= last.end) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) }
    else merged.push(range)
  }
  return merged
}

function foldText(text: string): FoldedText {
  const cached = FOLDED_TEXT_CACHE.get(text)
  if (cached) return cached
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  for (let index = 0; index < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(index)!)
    const next = index + character.length
    const value = foldCharacter(character)
    for (let unit = 0; unit < value.length; unit += 1) {
      folded += value[unit]
      starts.push(index)
      ends.push(next)
    }
    index = next
  }
  const words: FoldedWord[] = []
  for (const match of folded.matchAll(/[^ ]+/g)) {
    words.push({ start: match.index, end: match.index + match[0].length, value: match[0] })
  }
  const result = { text, folded, starts, ends, words }
  if (FOLDED_TEXT_CACHE.size >= FOLDED_TEXT_CACHE_LIMIT) FOLDED_TEXT_CACHE.clear()
  FOLDED_TEXT_CACHE.set(text, result)
  return result
}

function foldCharacter(character: string): string {
  const cached = FOLDED_CHAR_CACHE.get(character)
  if (cached !== undefined) return cached
  let value: string
  if (MARK.test(character)) value = ''
  else {
    const normalized = normalizeSpeciesSearch(character).text
    value = normalized === '' ? ' ' : normalized
  }
  FOLDED_CHAR_CACHE.set(character, value)
  return value
}

/** Optimal string alignment distance (adjacent swaps count once), capped at `limit + 1`. */
function boundedEditDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1
  let before = new Array<number>(right.length + 1).fill(0)
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  let current = new Array<number>(right.length + 1).fill(0)
  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row
    let rowMinimum = row
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      let value = Math.min(previous[column]! + 1, current[column - 1]! + 1, previous[column - 1]! + cost)
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        value = Math.min(value, before[column - 2]! + 1)
      }
      current[column] = value
      rowMinimum = Math.min(rowMinimum, value)
    }
    if (rowMinimum > limit) return limit + 1
    ;[before, previous, current] = [previous, current, before]
  }
  return previous[right.length]!
}
