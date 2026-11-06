// @ts-check
// policy/gate/gate-cov.mjs: the policy-gate Vitest project's coverage run and floor (design check AR20, F9;
// canopi-f47t.52.240; ADR 0028 Coverage). Most gate cases run the real CLI in a child process (planted-repo.ts), which
// Vitest's own coverage never sees, so the run sets NODE_V8_COVERAGE for the whole project: Vitest measures what runs
// in its workers, and each child Node writes V8's raw block coverage of the gate's sources it ran, whose offsets are the
// files' own, since Node's type stripping keeps every position. The children's hits are laid over Vitest's map: a
// statement or branch arm counts when a child ran its start offset (the innermost V8 range holding it has a non-zero
// count), a function when a child called the innermost V8 function holding its start. A planted copy of a gate file
// counts for the repository's file of the same path under policy/gate when its length is the same (a stripped .ts
// script ends in Node's sourceURL comment), so a case that planted a changed copy adds nothing. The merged totals are held to policy/ratchets/coverage.json's `policy-gate` floors, the
// one home of its floors and patterns: the coverage family measures what gateCovPlan reads (policy/adapters/
// coverage.mjs). An interrupted run exits 130 and changes nothing. Plain JavaScript, so that adapter loads it on any Node.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, matchesGlob, relative, sep } from 'node:path'

export const COVERAGE_FAMILY = 'policy/ratchets/coverage.json'
export const TOOL = 'policy-gate'
const METRICS = /** @type {const} */ (['statements', 'branches', 'functions', 'lines'])
const GATE = 'policy/gate/'

/**
 * @typedef {{ line?: number, column?: number | null }} Position
 * @typedef {{ start: Position, end: Position }} Span
 * @typedef {{ path: string, statementMap: Record<string, Span>, fnMap: Record<string, { loc: Span }>,
 *   branchMap: Record<string, { locations: Span[] }>, s: Record<string, number>, f: Record<string, number>,
 *   b: Record<string, number[]> }} FileCoverage
 * @typedef {{ startOffset: number, endOffset: number, count: number }} Range
 * @typedef {{ url: string, functions: { ranges: Range[] }[] }} Script
 * @typedef {{ intervals: [number, number][], functions: Map<string, { start: number, end: number, called: boolean }> }} ChildHits
 */

/**
 * The run's floors and patterns from the family at `root`: `include` and `exclude` are repository-relative globs.
 * Throws when the family holds no policy-gate floor.
 * @param {string} root
 * @returns {{ floors: Record<string, number>, include: string[], exclude: string[] }}
 */
export function gateCovPlan(root) {
  const doc = JSON.parse(readFileSync(join(root, COVERAGE_FAMILY), 'utf8'))
  const held = doc?.floors?.[TOOL]
  if (!Object.keys(held?.floors ?? {}).length) throw new Error(`${COVERAGE_FAMILY} holds no ${TOOL} floor`)
  return { floors: held.floors, include: held.include ?? [], exclude: held.exclude ?? [] }
}

/**
 * Vitest's arguments, from desktop/web, for the project's run writing its coverage map to `reports`: the family's
 * patterns, which Vitest matches at any depth (it reads none above its root), and no threshold, since the floors judge
 * the merged totals of the files inMeasure keeps.
 * @param {{ include: string[], exclude: string[] }} plan
 * @param {string} reports
 */
export function vitestArgs(plan, reports) {
  const deep = (/** @type {string} */ glob) => `**/${glob}`
  return ['run', '--project', TOOL, '--maxWorkers=4', '--coverage', '--coverage.allowExternal', '--coverage.reporter=json',
    `--coverage.reportsDirectory=${reports}`, ...plan.include.map((g) => `--coverage.include=${deep(g)}`),
    ...plan.exclude.map((g) => `--coverage.exclude=${deep(g)}`),
    ...METRICS.map((m) => `--coverage.thresholds.${m}=0`)]
}

/**
 * The entries of `map` the family measures: repository files its include matches and its exclude does not.
 * @param {string} root
 * @param {Record<string, FileCoverage>} map
 * @param {{ include: string[], exclude: string[] }} plan
 */
export function inMeasure(root, map, plan) {
  const keep = (/** @type {string} */ path) => !path.startsWith('../') && plan.include.some((g) => matchesGlob(path, g))
    && !plan.exclude.some((g) => matchesGlob(path, g))
  return Object.fromEntries(Object.entries(map).filter(([, file]) => keep(relative(root, file.path).split(sep).join('/'))))
}

/**
 * The disjoint offset intervals one script's V8 ranges ran: each point counts with the innermost range holding it.
 * @param {Range[]} ranges
 * @returns {[number, number][]}
 */
export function ranIntervals(ranges) {
  const sorted = [...ranges].sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset)
  /** @type {[number, number][]} */
  const out = []
  /** @type {Range[]} */
  const stack = []
  let at = 0
  const emit = (/** @type {number} */ to, /** @type {Range | undefined} */ range) => {
    if (range && range.count > 0 && to > at) out.push([at, to])
    at = Math.max(at, to)
  }
  for (const range of sorted) {
    while (stack.length && /** @type {Range} */ (stack.at(-1)).endOffset <= range.startOffset) {
      emit(/** @type {Range} */ (stack.at(-1)).endOffset, stack.pop())
    }
    emit(range.startOffset, stack.at(-1))
    at = range.startOffset
    stack.push(range)
  }
  while (stack.length) emit(/** @type {Range} */ (stack.at(-1)).endOffset, stack.pop())
  return out
}

/** @param {[number, number][]} intervals */
function union(intervals) {
  /** @type {[number, number][]} */
  const out = []
  for (const [from, to] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1)
    if (last && from <= last[1]) last[1] = Math.max(last[1], to)
    else out.push([from, to])
  }
  return out
}

/** @param {[number, number][]} intervals @param {number} offset */
function ran(intervals, offset) {
  let low = 0
  let high = intervals.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const [from, to] = /** @type {[number, number]} */ (intervals[mid])
    if (offset < from) high = mid - 1
    else if (offset >= to) low = mid + 1
    else return true
  }
  return false
}

/**
 * The repository path (`policy/gate/...`) a V8 script URL names, the repository's or a planted copy's, else undefined.
 * @param {string} url
 */
export function gatePath(url) {
  if (!url.startsWith('file://')) return undefined
  const at = url.lastIndexOf(`/${GATE}`)
  return at < 0 ? undefined : decodeURIComponent(url.slice(at + 1))
}

/**
 * The children's hits per gate file from NODE_V8_COVERAGE's process files: a Vitest process (which runs transformed
 * code) is skipped, and so is a script whose length is not the repository file's.
 * @param {string} root
 * @param {Iterable<{ result: Script[] }>} processes
 * @returns {Map<string, ChildHits>}
 */
export function childHits(root, processes) {
  /** @type {Map<string, ChildHits>} */
  const hits = new Map()
  /** @type {Map<string, number | undefined>} */
  const lengths = new Map()
  const lengthOf = (/** @type {string} */ path) => {
    if (!lengths.has(path)) {
      try {
        lengths.set(path, readFileSync(join(root, path), 'utf8').length)
      } catch {
        lengths.set(path, undefined)
      }
    }
    return lengths.get(path)
  }
  for (const { result } of processes) {
    if (result.some((script) => script.url.includes('/node_modules/vitest/'))) continue
    for (const script of result) {
      const path = gatePath(script.url)
      if (path === undefined) continue
      const ranges = script.functions.flatMap((fn) => fn.ranges)
      const length = Math.max(0, ...ranges.map((range) => range.endOffset))
      const own = lengthOf(path)
      if (own === undefined || (length !== own && length !== own + `\n\n//# sourceURL=${script.url}`.length)) continue
      /** @type {ChildHits} */
      const entry = hits.get(path) ?? { intervals: [], functions: new Map() }
      entry.intervals.push(...ranIntervals(ranges))
      for (const { ranges: [whole] } of script.functions) {
        if (!whole) continue
        const key = `${whole.startOffset}:${whole.endOffset}`
        const known = entry.functions.get(key)
        entry.functions.set(key, { start: whole.startOffset, end: whole.endOffset, called: (known?.called ?? false) || whole.count > 0 })
      }
      hits.set(path, entry)
    }
  }
  for (const entry of hits.values()) entry.intervals = union(entry.intervals)
  return hits
}

/**
 * `map` (Vitest's coverage-final.json) with the children's hits laid over it, in place.
 * @param {string} root
 * @param {Record<string, FileCoverage>} map
 * @param {Map<string, ChildHits>} hits
 */
export function overlay(root, map, hits) {
  for (const file of Object.values(map)) {
    const child = hits.get(relative(root, file.path).split(sep).join('/'))
    if (!child) continue
    const text = readFileSync(file.path, 'utf8')
    const starts = [0]
    for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) starts.push(index + 1)
    const offset = (/** @type {Position} */ at) => at.line === undefined ? undefined
      : (starts[at.line - 1] ?? text.length) + (at.column ?? 0)
    const hit = (/** @type {Span} */ span) => {
      const at = offset(span.start)
      return at !== undefined && ran(child.intervals, at)
    }
    for (const [id, span] of Object.entries(file.statementMap)) if (!file.s[id] && hit(span)) file.s[id] = 1
    for (const [id, fn] of Object.entries(file.fnMap)) {
      const at = offset(fn.loc.start)
      if (file.f[id] || at === undefined) continue
      let innermost
      for (const span of child.functions.values()) {
        if (span.start <= at && at < span.end && (!innermost || span.end - span.start < innermost.end - innermost.start)) innermost = span
      }
      if (innermost?.called) file.f[id] = 1
    }
    for (const [id, branch] of Object.entries(file.branchMap)) {
      const counts = file.b[id] ?? []
      branch.locations.forEach((span, arm) => { if (!counts[arm] && hit(span)) counts[arm] = 1 })
    }
  }
  return map
}

/**
 * Each metric's percentage over `map`, as istanbul counts them: a line is its statements' start line, covered when one
 * of them ran. Two decimals; 100 for a metric with nothing to count.
 * @param {Record<string, FileCoverage>} map
 * @returns {Record<string, number>}
 */
export function summary(map) {
  const totals = Object.fromEntries(METRICS.map((m) => [m, { covered: 0, total: 0 }]))
  const add = (/** @type {string} */ metric, /** @type {boolean} */ covered) => {
    const t = /** @type {{ covered: number, total: number }} */ (totals[metric])
    t.total += 1
    if (covered) t.covered += 1
  }
  for (const file of Object.values(map)) {
    /** @type {Map<number, boolean>} */
    const lines = new Map()
    for (const [id, span] of Object.entries(file.statementMap)) {
      const covered = (file.s[id] ?? 0) > 0
      add('statements', covered)
      if (span.start.line !== undefined) lines.set(span.start.line, (lines.get(span.start.line) ?? false) || covered)
    }
    for (const covered of lines.values()) add('lines', covered)
    for (const id of Object.keys(file.fnMap)) add('functions', (file.f[id] ?? 0) > 0)
    for (const counts of Object.values(file.b)) for (const count of counts) add('branches', count > 0)
  }
  return Object.fromEntries(Object.entries(totals).map(([m, t]) =>
    [m, t.total ? Math.floor((t.covered / t.total) * 10_000) / 100 : 100]))
}

/**
 * The floors `values` falls below, as messages.
 * @param {Record<string, number>} values
 * @param {Record<string, number>} floors
 */
export function belowFloors(values, floors) {
  return Object.entries(floors).filter(([m, floor]) => (values[m] ?? 0) < floor)
    .map(([m, floor]) => `${TOOL} ${m} ${values[m]} is below its floor ${floor} (${COVERAGE_FAMILY})`)
}

/**
 * Runs the project's coverage at `root` and judges the merged totals: 0 at or above every floor, 1 below one or when
 * the family cannot be read, Vitest's code when it fails, 130 after SIGINT.
 * @param {string} root
 * @returns {Promise<number>}
 */
export async function runGateCov(root) {
  let plan
  try {
    plan = gateCovPlan(root)
  } catch (error) {
    process.stderr.write(`gate: ${/** @type {Error} */ (error).message}; refusing\n`)
    return 1
  }
  const scratch = mkdtempSync(join(tmpdir(), 'canopi-gate-cov-'))
  const raw = join(scratch, 'v8')
  const reports = join(scratch, 'reports')
  try {
    const web = join(root, 'desktop/web')
    const child = spawn(process.execPath, [join(web, 'node_modules/vitest/vitest.mjs'), ...vitestArgs(plan, reports)], {
      cwd: web, stdio: 'inherit', detached: true, env: { ...process.env, NODE_V8_COVERAGE: raw },
    })
    let interrupted = false
    const onInterrupt = () => {
      interrupted = true
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGINT')
      } catch {
        // the group has ended
      }
    }
    process.on('SIGINT', onInterrupt)
    let code
    try {
      code = await new Promise((resolve) => {
        child.once('error', (error) => {
          process.stderr.write(`gate: vitest could not start: ${error.message}\n`)
          resolve(127)
        })
        child.once('close', (status) => resolve(status ?? 1))
      })
    } finally {
      process.removeListener('SIGINT', onInterrupt)
    }
    if (interrupted) return 130
    if (code !== 0) return /** @type {number} */ (code)
    const map = inMeasure(root, JSON.parse(readFileSync(join(reports, 'coverage-final.json'), 'utf8')), plan)
    if (!Object.keys(map).length) {
      process.stderr.write(`gate: ${TOOL} coverage measured none of the family's files (${COVERAGE_FAMILY}); `
        + 'nothing to judge, so the floors are refused\n')
      return 1
    }
    const inProcess = summary(map)
    const processes = (existsSync(raw) ? readdirSync(raw) : []).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(raw, name), 'utf8')))
    const merged = summary(overlay(root, map, childHits(root, processes)))
    const line = (/** @type {Record<string, number>} */ v) => METRICS.map((m) => `${m} ${v[m]}`).join(', ')
    process.stdout.write(`gate: ${TOOL} coverage over ${Object.keys(map).length} files: ${line(merged)} `
      + `(in Vitest's workers alone: ${line(inProcess)})\n`)
    const below = belowFloors(merged, plan.floors)
    for (const message of below) process.stderr.write(`gate: ${message}\n`)
    return below.length ? 1 : 0
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
