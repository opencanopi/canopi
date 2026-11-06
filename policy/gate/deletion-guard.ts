// policy/gate/deletion-guard.ts: the test-deletion guard the commit gate runs on a commit, or on a PR's net change with
// every message of the range, a Q row counting only where tied to the file (contracts §12; ADR 0028; 2.1-Q224,
// 2.1-M199, 2.1-M229, 2.1-Q267, 2.1-Q272, 2.1-Q274). It compares
// the tests (test-reader.ts) of the base and head text:
//
// - a title gone at head that no changed file re-adds (a move, in any file, passes with no trailer) needs a route
//   (routeLoss, which the Vitest pass in deletion-guard-vitest.ts shares, canopi-f47t.52.228.51): the message quotes
//   ('…', "…", `…`) the title of a test the commit adds, which replaces that one deleted test (its own file first: pair),
//   no assertion count compared (2.1-Q272); or it cites a merge-base Q row covering the file; or it carries
//   `Retires-test: <title> — <why>` while the commit (in a PR, one of its commits: rangeDeletedCode) deletes code under
//   test (codeUnderTest), or for a test whose only
//   subject is a documentation file, which no user sees (docsOnly, 2.1-M329) (gate-test-deleted);
// - `Rewords-test: <old> -> <new>` passes a reworded title in the same file, or a fold into a <new> kept in that file
//   (2.1-M330), no assertion count compared (2.1-Q272); without it, or in another file, the reword is refused
//   (gate-test-reworded);
// - in a kept test, unless the message cites a merge-base Q row: fewer assertions, a matcher swap from the closed list,
//   or a new skip (gate-test-loosened). A Retires-test line never skips this: when routeLoss routes the retirement of
//   some of a title's same-titled tests in a file, the edited bodies left meet every choice of base bodies left
//   (keptBodies). A new skip carrying `flake-quarantine: <bead>` passes when the commit adds that open bead's entry
//   for the file to the flake-quarantine family (2.1-Q242).
// A Python import counts as repository code when it names a module under scripts/ (design check A11).
import { posix } from 'node:path'
import { splitLines, strip } from './ledger.ts'
import {
  blockBody, type Body, bump, byCodePoint, count, escapeRegExp, type Finding, isTestFile, language, quoted, type Read,
  RUST_TEST_SOURCE, swaps, tests, W, weaker,
} from './test-reader.ts'

const SKIPS = new RegExp(String.raw`(?<![\p{L}\p{N}_$])(?:it|test|describe)\.(?:skip|fixme|todo)(?!${W})|\.skipIf\(|#\[ignore(?!${W})`
  + String.raw`|@unittest\.skip|@pytest\.mark\.skip`, 'gu')
const FLAKE = /flake-quarantine:[ \t]*(canopi-[a-z0-9]+(?:\.[0-9]+)*)?/gu
export const RETIRES = /^Retires-test:\s*(.+?)\s+(?:—|--)\s+\S/gmu
const REWORDS = /^Rewords-test:\s*(.+?)\s+->\s+(.+?)\s*$/gmu
const RUST_TEST_ITEM = new RegExp(String.raw`#\[cfg\(test\)\]|${RUST_TEST_SOURCE}`, 'gu')
// A Playwright spec or a Rust integration test covers its package's src/, which it never imports relatively.
const OUTSIDE = /^((?:.*\/)?)(?:e2e|e2e-release|tests)\//u
const IMPORT = /(?:from|import|require\(|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/gu
// A test of documentation only (docsOnly, 2.1-M329): a docs/ path or .md literal, and no code path, import or fixture.
const DOC_PATH = /['"`](?:[^'"`\s]*\/)?docs\/[^'"`\s]*['"`]|['"`][^'"`\s]+\.md['"`]/u
const CODE_PATH = /['"`][^'"`\s]+\.(?:[cm]?[jt]sx?|py|rs|css|html|json|toml|ya?ml|sh|sql)['"`]/u
const CODE_USE = new RegExp(String.raw`(?<!${W})import(?!${W})|(?<!${W})require\s*\(|(?<!${W})(?:crate|super)::`
  + String.raw`|(?<!${W})self\.(?!assert${W}*\s*\(|subTest\s*\()${W}`, 'u')
const JS_NAMES = /import\s+(?!type\s)([^'"]+?)\s+from\s*['"](?:\.{1,2}\/|[@~]\/)/gu
const PY_NAMES = new RegExp(String.raw`^(?:from\s+([\p{L}\p{N}_.]+)\s+import\s+(\([^)]*\)|[^\n]+)|import\s+([\p{L}\p{N}_.]+)`
  + String.raw`(?:\s+as\s+(${W}+))?)`, 'gmu')
const RUST_USE = /^\s*use\s+(?!std::)/mu

/** The beads named by `flake-quarantine:` markers in `text`; a marker naming no bead is undefined. */
const flakeMarkers = (text: string | undefined) => [...(text ?? '').matchAll(FLAKE)].map((match) => match[1])

/** Repository paths (without extension) a test file's relative imports name. */
function imported(path: string, text: string | undefined): Set<string> {
  const base = posix.dirname(path)
  return new Set([...(text ?? '').matchAll(IMPORT)].map((match) =>
    normpath(posix.join(base === '.' ? '' : base, match[1] ?? '')).replace(/\.[cm]?[jt]sx?$/u, '')))
}

/** posixpath.normpath: no trailing slash, '.' for nothing. */
const normpath = (path: string) => posix.normalize(path || '.').replace(/(.)\/+$/u, '$1')

/** A file's non-test lines: none for a test file, a Rust file's lines outside #[cfg(test)] items and #[test] fns. */
function codeLines(path: string, text: string | undefined): Map<string, number> {
  const lines = new Map<string, number>()
  if (!text || (isTestFile(path) && !path.endsWith('.rs'))) return lines
  let code = text
  if (path.endsWith('.rs')) {
    const kept: string[] = []
    let end = 0
    for (const match of text.matchAll(RUST_TEST_ITEM)) {
      const at = match.index ?? 0
      if (at < end) continue
      const after = at + match[0].length
      const brace = text.indexOf('{', after)
      const semicolon = text.indexOf(';', after)
      const stop = semicolon !== -1 && (brace === -1 || semicolon < brace) ? semicolon + 1
        : brace !== -1 ? brace + blockBody('rs', text, match).length : text.length
      kept.push(text.slice(end, at))
      end = stop
    }
    code = kept.join('') + text.slice(end)
  }
  for (const line of splitLines(code)) if (strip(line)) bump(lines, strip(line))
  return lines
}

/**
 * The Rust module file whose code the tests in `path` cover: `path` itself, or for a test-only module (declared
 * `#[cfg(test)] mod x;`, at any depth) the module declaring it. read: at the test's revision.
 */
export async function rustHome(path: string, read: Read): Promise<string> {
  let current = path
  for (let step = 0; step < path.split('/').length + 1; step += 1) {
    let name = posix.basename(current).slice(0, -3)
    let folder = posix.dirname(current)
    if (name === 'lib' || name === 'main') return path
    if (name === 'mod') {
      name = posix.basename(folder)
      folder = posix.dirname(folder)
    }
    const declares = new RegExp(String.raw`((?:#\[[^\]]*\]\s*)*)(?:pub(?:\([^)]*\))?\s+)?mod\s+${escapeRegExp(name)}\s*;`, 'u')
    let found: readonly [string, boolean] | undefined
    for (const parent of [`${folder}/mod.rs`, `${folder}/lib.rs`, `${folder}/main.rs`, `${folder}.rs`]) {
      const match = parent !== current ? declares.exec((await read(parent)) ?? '') : null
      if (match) {
        found = [parent, (match[1] ?? '').replaceAll(' ', '').includes('#[cfg(test)]')]
        break
      }
    }
    if (!found) return path
    if (found[1]) return found[0]
    current = found[0]
  }
  return path
}

export type Change = readonly [status: string, old: string, new: string]
/** Old path -> whether no code line is left, for each file `changes` (git -M) leaves with fewer code lines. */
export type DeletedCode = ReadonlyMap<string, boolean>

/** A Rust file whose tests sit in its own inline `#[cfg(test)] mod` covers its own code, even as a test-only module
 * (a policy module such as native_command_policy.rs), never a test helper. */
const INLINE_TESTS = /#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+[\p{L}\p{N}_]+\s*\{/u

/** deleted code of a commit: a Rust test-only module (rustHome) holds none unless it has inline tests of its own
 * (INLINE_TESTS); a move deletes nothing. */
export async function deletedCode(changes: readonly Change[], readOld: Read, readNew: Read): Promise<DeletedCode> {
  const found = new Map<string, boolean>()
  for (const [status, old, now] of changes) {
    if (status === 'A' || status === 'C' || (isTestFile(old) && !old.endsWith('.rs'))) continue
    if (old.endsWith('.rs') && (await rustHome(old, readOld)) !== old && !INLINE_TESTS.test((await readOld(old)) ?? '')) continue
    const sum = (lines: Map<string, number>) => [...lines.values()].reduce((a, b) => a + b, 0)
    const before = sum(codeLines(old, await readOld(old)))
    const after = status === 'D' ? 0 : sum(codeLines(now, await readNew(now)))
    if (after < before) found.set(old, after === 0)
  }
  return found
}

/** What rangeDeletedCode reads: git -M changes between two revisions and a file at one. */
export interface ChangeReader {
  changed(from: string, to: string): Change[]
  show(rev: string, path: string): Promise<string | undefined>
}

/**
 * The code a PR's commits deleted, for its Retires-test lines (2.1-Q274, 2.1-M389; canopi-f47t.52.228.54): the union of
 * each commit's own deletedCode, from its first parent (a merge: only the files that differ from every parent), keyed
 * by the path at `mergeBase` (the renames since it followed back). A commit that deleted the code under test routes the
 * retirement in the range as it did alone, whatever later commits add to the module; an edited line deletes nothing,
 * as for one commit. A file any commit emptied counts as emptied.
 */
export async function rangeDeletedCode(git: ChangeReader, mergeBase: string,
  commits: readonly { readonly rev: string, readonly parents: readonly string[] }[]): Promise<DeletedCode> {
  const found = new Map<string, boolean>()
  for (const { rev, parents: [first, ...others] } of commits) {
    if (first === undefined) continue
    const touched = others.map((other) => new Set(git.changed(other, rev).flatMap(([, old, now]) => [old, now])))
    const files = git.changed(first, rev).filter(([, old, now]) => touched.every((paths) => paths.has(old) || paths.has(now)))
    const back = new Map(git.changed(mergeBase, first).filter(([status]) => status === 'R').map(([, old, now]) => [now, old]))
    for (const [path, whole] of await deletedCode(files, (at) => git.show(first, at), (at) => git.show(rev, at))) {
      const base = back.get(path) ?? path
      found.set(base, whole || (found.get(base) ?? false))
    }
  }
  return found
}

const stem = (path: string) => path.replace(/(?:\.(?:test|spec))?\.[cm]?[jt]sx?$|\.py$/u, '')

/**
 * Whether `deleted` holds the code a test in `path` covered: code lines gone from a module it imports or its own
 * module (panel.ts beside panel.test.ts, foo.py beside test_foo.py, a Rust file's own code or, for a test-only module,
 * its declaring module's, and its own too when its tests are inline: INLINE_TESTS), or for a Playwright spec or a Rust integration test (OUTSIDE), a file of its package's src/
 * deleted whole, never its own file or a helper beside it.
 */
export async function codeUnderTest(path: string, text: string | undefined, deleted: DeletedCode, read: Read): Promise<boolean> {
  const names = imported(path, text)
  const dir = posix.dirname(path)
  const own = path.endsWith('.rs') ? await rustHome(path, read)
    : normpath(posix.join(dir === '.' ? '' : dir, posix.basename(stem(path)).replace(/^test_/u, '')))
  const outside = OUTSIDE.exec(path)
  for (const [other, whole] of deleted) {
    if (outside) {
      if (whole && other.startsWith(`${outside[1] ?? ''}src/`)) return true
    } else if (other === own || stem(other) === own || names.has(stem(other)) || names.has(stem(other).replace(/\/index$/u, ''))
      || (other === path && path.endsWith('.rs') && INLINE_TESTS.test(text ?? ''))) {
      return true
    }
  }
  return false
}

/**
 * Whether a test's only subject is a documentation file: each body names a docs/ path or a .md literal and no code
 * path, import, fixture (self.<name> other than an assert) or name the file binds from repository code (a JS relative
 * or alias import, a Python module under scripts/ (A11); any `use` of a Rust file but std's).
 */
export function docsOnly(path: string, text: string | undefined, bodies: readonly Body[], pyModules: ReadonlySet<string>): boolean {
  const kind = language(path)
  if (kind === 'rs' && RUST_USE.test(text ?? '')) return false
  const names = new Set<string>()
  if (kind === 'js') {
    for (const match of (text ?? '').matchAll(JS_NAMES)) {
      for (const name of (match[1] ?? '').match(/[A-Za-z_$][\w$]*/gu) ?? []) if (name !== 'as' && name !== 'type') names.add(name)
    }
  } else if (kind === 'py') {
    for (const [, module, listed, plain, alias] of (text ?? '').matchAll(PY_NAMES)) {
      const first = (module ?? plain ?? '').split('.')[0] ?? ''
      if (first !== 'scripts' && !pyModules.has(first)) continue
      if (module) for (const name of (listed ?? '').match(new RegExp(`${W}+`, 'gu')) ?? []) { if (name !== 'as') names.add(name) }
      else names.add(alias || first)
    }
  }
  const uses = names.size ? new RegExp(`(?<![\\p{L}\\p{N}_.$])(?:${[...names].sort().map(escapeRegExp).join('|')})(?!${W})`, 'u') : undefined
  return bodies.length > 0 && bodies.every((body) => DOC_PATH.test(body.text) && !CODE_PATH.test(body.text)
    && !CODE_USE.test(body.text) && !(uses && uses.test(body.text)))
}

/** The test a lost title had: its file at the revision it is read from, that text and the title's bodies. */
export interface Loss {
  readonly title: string
  readonly path: string
  readonly text: string | undefined
  /** Undefined when the title's bodies cannot be read (a title built at run time): it is then never weaker. */
  readonly bodies: readonly Body[] | undefined
}

/** What one commit offers as a route for one lost title. */
export interface Route {
  /** The message cites a merge-base Q row. */
  readonly authorised: boolean
  /** The titles the message's Retires-test lines name. */
  readonly retired: ReadonlySet<string>
  readonly deletedCode: DeletedCode
  /** Reads the lost test's revision (Rust's declaring modules). */
  readonly read: Read
  /** The module names under scripts/, for docsOnly. */
  readonly pyModules: ReadonlySet<string>
  /** Its Rewords-test new title (one head adds, or for a fold a test kept, M330), in the same file or not. */
  readonly reword?: { readonly title: string, readonly sameFile: boolean }
  /** The quoted replacement's title paired with this one: the quote is the route, no assertion count compared. */
  readonly replacement?: string
}

export type Routed = { readonly kind: 'routed' } | { readonly kind: 'refused', readonly finding: Finding } | { readonly kind: 'none' }

/**
 * The one loss router (canopi-f47t.52.228.51): whether a commit's message routes the loss of one test title, for the
 * static pass and the Vitest pass alike. A merge-base Q row covering the loss's file routes it; Retires-test needs the code under
 * test deleted, or a test of documentation only (M329); Rewords-test needs its new title, added or kept (a fold, M330),
 * in the same file; a quoted replacement routes it. Neither counts assertions: a kept test's loosening is the one
 * assertion check (2.1-Q272). `none`: the message offers no route.
 */
export async function routeLoss(loss: Loss, route: Route): Promise<Routed> {
  if (route.authorised) return { kind: 'routed' }
  if (route.retired.has(loss.title)) {
    if (await codeUnderTest(loss.path, loss.text, route.deletedCode, route.read)
      || (loss.bodies !== undefined && docsOnly(loss.path, loss.text, loss.bodies, route.pyModules))) return { kind: 'routed' }
    return { kind: 'refused', finding: ['gate-test-deleted', `${loss.path}: Retires-test: ${loss.title} deletes no code `
      + 'of its own module or one it imports, and the test reads code'] }
  }
  const { reword, replacement } = route
  if (reword) {
    return reword.sameFile ? { kind: 'routed' } : { kind: 'refused', finding: ['gate-test-reworded',
      `'${loss.title}' -> '${reword.title}' moves it to another file; that is a deletion`] }
  }
  return replacement === undefined ? { kind: 'none' } : { kind: 'routed' }
}

type Pairable = readonly [title: string, path: string]

/** {lost title: replacement title}: each lost (title, path) takes one free (title, path) from its own file before any
 * other; no assertion count is compared (2.1-Q272). */
function pair(lost: readonly Pairable[], free: readonly Pairable[]): Map<string, string> {
  const taken = new Set<string>()
  const out = new Map<string, string>()
  for (const ownFile of [true, false]) {
    for (const [title, path] of lost) {
      const pick = free.find(([t, p]) => !taken.has(t) && !out.has(title) && (p === path) === ownFile)?.[0]
      if (pick !== undefined) {
        out.set(title, pick)
        taken.add(pick)
      }
    }
  }
  return out
}

/** The Rewords-test pairs of `text`, old -> new. With `chain` (a PR's messages, read together) a title renamed again is
 * followed to its last name: A -> B and B -> C give A -> C. */
export function rewordPairs(text: string, chain: boolean): (readonly [string, string])[] {
  const pairs = [...text.matchAll(REWORDS)].map((match) => [strip(match[1] ?? ''), strip(match[2] ?? '')] as const)
  if (!chain) return pairs
  const next = new Map(pairs)
  const renamed = new Set(pairs.map(([, now]) => now))
  return pairs.filter(([old]) => !renamed.has(old)).map(([old, now]) => {
    const seen = new Set([old])
    let end = now
    while (next.has(end) && !seen.has(end)) {
      seen.add(end)
      end = next.get(end) ?? end
    }
    return [old, end] as const
  })
}

/** A changed test file: base path or undefined, head path or undefined, base text, head text. */
export type TestFile = readonly [old: string | undefined, now: string | undefined, oldText: string, newText: string]

export interface JudgeOptions {
  /** Whether a merge-base Q row routes the tests of a file (its base path): one commit's message citing one, or in a
   * PR a commit that touched the file or a PR body line naming it (2.1-Q272). */
  readonly authorised: (path: string) => boolean
  /** Why the route of a file's tests (its base path) cites no merge-base Q row, when it names one the merge base lacks. */
  readonly missingQ?: (path: string) => string | undefined
  /** One commit's message (the hook): a Rewords-test line naming no deleted and added pair is refused. A PR's messages
   * read together (pr mode) follow rename chains and pass over a line whose old title is no net loss. */
  readonly strictRewords: boolean
  /** Base paths of the files the Vitest pass reads at both ends: it alone judges their lost titles (one reading). */
  readonly listed?: ReadonlySet<string>
  readonly deletedCode: DeletedCode
  /** path -> bead for the flake-quarantine entries the commit adds or raises with an owned open bead. */
  readonly quarantined: ReadonlyMap<string, string>
  readonly beadOpen: (bead: string) => Promise<boolean>
  /** Reads the commit's parent. */
  readonly read: Read
  readonly pyModules: ReadonlySet<string>
}

/** The refusal of a lost title no route reaches; `existing`: a title the message quotes that the change does not add;
 * `missing`: the route's Q rows the merge base lacks (Authority.missingQ). */
const noRoute = (path: string, title: string, existing: string | undefined, missing: string | undefined) => `${path}: '${title}' `
  + `is deleted with no route: quote its replacement test's title${existing === undefined ? ''
    : ` (only a test the change adds replaces one: '${existing}' exists already)`}, cite a merge-base Q row${missing ? ` (${missing})` : ''}, `
  + 'or add Retires-test: <title> — <why> and delete its code'

/** Findings for one commit's changed test files. */
export async function judge(files: readonly TestFile[], message: string, options: JudgeOptions): Promise<Finding[]> {
  const { authorised } = options
  const before = new Map<string, number>()
  const after = new Map<string, number>()
  const whereBefore = new Map<string, { path: string, bodies: Body[], text: string }>()
  const whereAfter = new Map<string, { path: string, bodies: Body[] }>()
  // Where each title's count fell, a file the Vitest pass judges alone aside: a loss is judged in the file it fell in,
  // never hidden by, or reported at, the same title in another file.
  const lostAt = new Map<string, { path: string, bodies: Body[], text: string }>()
  const listed = options.listed ?? new Set<string>()
  const parsed: { old?: string, now?: string, oldText: string, newText: string, was: Map<string, Body[]>, is: Map<string, Body[]> }[] = []
  for (const [old, now, oldText, newText] of files) {
    const was = old ? tests(old, oldText) : new Map<string, Body[]>()
    const is = now ? tests(now, newText) : new Map<string, Body[]>()
    parsed.push({ old, now, oldText, newText, was, is })
    for (const [title, bodies] of was) {
      bump(before, title, bodies.length)
      if (old && !whereBefore.has(title)) whereBefore.set(title, { path: old, bodies, text: oldText })
      if (old && !listed.has(old) && !lostAt.has(title) && bodies.length > (is.get(title)?.length ?? 0)) {
        lostAt.set(title, { path: old, bodies, text: oldText })
      }
    }
    for (const [title, bodies] of is) {
      bump(after, title, bodies.length)
      if (now && !whereAfter.has(title)) whereAfter.set(title, { path: now, bodies })
    }
  }
  const deleted = [...before.keys()].filter((t) => (after.get(t) ?? 0) < (before.get(t) ?? 0))
  const added = [...after.keys()].filter((t) => (before.get(t) ?? 0) < (after.get(t) ?? 0))
  const replacements = added.filter((t) => quoted(t, message))
  // A quoted title the change does not add replaces nothing: the refusal names it.
  const existing = [...after.keys()].filter((t) => !added.includes(t) && quoted(t, message))
  const retired = new Set([...message.matchAll(RETIRES)].map((m) => strip(m[1] ?? '')))
  const base = { authorised: false, retired: new Set<string>(), deletedCode: options.deletedCode, read: options.read, pyModules: options.pyModules }
  const findings: Finding[] = []
  const reworded = new Set<string>()
  for (const [oldTitle, newTitle] of rewordPairs(message, !options.strictRewords)) {
    if (deleted.includes(oldTitle) && !lostAt.has(oldTitle)) continue
    const was = lostAt.get(oldTitle) ?? whereBefore.get(oldTitle)
    const fold = !added.includes(newTitle) && whereAfter.has(newTitle) && whereBefore.get(newTitle)?.path === was?.path
    const is = whereAfter.get(newTitle)
    if (!deleted.includes(oldTitle) || (!added.includes(newTitle) && !fold) || !was || !is) {
      if (!options.strictRewords && !deleted.includes(oldTitle)) continue
      findings.push(['gate-test-reworded', `Rewords-test: ${oldTitle} -> ${newTitle} names no deleted and added pair`])
      continue
    }
    const sameFile = is.path === was.path || files.some(([o, n]) => o === was.path && n === is.path)
    const routed = await routeLoss({ title: oldTitle, path: was.path, text: was.text, bodies: was.bodies },
      { ...base, reword: { title: newTitle, sameFile } })
    if (routed.kind === 'refused') findings.push(routed.finding)
    reworded.add(oldTitle).add(newTitle)
  }
  const named = deleted.filter((t) => !reworded.has(t) && !retired.has(t) && lostAt.has(t) && !authorised(lostAt.get(t)?.path ?? ''))
  const paired = pair(named.map((t) => [t, lostAt.get(t)?.path ?? ''] as const),
    replacements.filter((t) => !reworded.has(t)).map((t) => [t, whereAfter.get(t)?.path ?? ''] as const))
  const used = new Set(paired.values())
  for (const title of deleted) {
    if (reworded.has(title)) continue
    const was = lostAt.get(title)
    if (!was || authorised(was.path)) continue
    const pick = paired.get(title)
    const routed = await routeLoss({ title, path: was.path, text: was.text, bodies: was.bodies }, {
      ...base, retired, ...(pick === undefined ? {} : { replacement: pick }),
    })
    if (routed.kind === 'routed') continue
    if (routed.kind === 'refused') {
      findings.push(routed.finding)
      continue
    }
    const rewords = added.filter((t) => !reworded.has(t) && !used.has(t) && whereAfter.get(t)?.path === was.path)
    if (rewords.length) {
      findings.push(['gate-test-reworded', `${was.path}: '${title}' looks reworded to '${rewords[0]}': add `
        + `Rewords-test: ${title} -> ${rewords[0]}`])
    } else {
      findings.push(['gate-test-deleted', noRoute(was.path, title, existing.find((t) => t !== title), options.missingQ?.(was.path))])
    }
  }
  for (const { old, now, oldText, newText, was, is } of parsed) {
    if (!(old && now)) continue
    for (const title of [...was.keys()].filter((t) => is.has(t)).sort(byCodePoint)) {
      if (authorised(old)) continue
      const all = was.get(title) ?? []
      let [befores, after]: [Body[][], Body[]] = [[all], is.get(title) ?? []]
      if (retired.has(title) && after.length < all.length && (await routeLoss({ title, path: old, text: oldText, bodies: all },
        { ...base, retired })).kind === 'routed') [befores, after] = keptBodies(all, after)
      const less = befores.some((before) => weaker(old, before, now, after))
      for (const why of [...(less ? ['fewer expect or assert calls'] : []), ...swaps(befores, after)]) {
        findings.push(['gate-test-loosened', `${now}: '${title}': ${why}`])
      }
    }
    const newSkips = count(SKIPS, newText) - count(SKIPS, oldText)
    if (newSkips <= 0 || authorised(old)) continue
    const markers = new Map<string | undefined, number>()
    for (const bead of flakeMarkers(newText)) markers.set(bead, (markers.get(bead) ?? 0) + 1)
    for (const bead of flakeMarkers(oldText)) markers.set(bead, (markers.get(bead) ?? 0) - 1)
    let good = 0
    for (const [bead, n] of markers) {
      if (n > 0 && bead && options.quarantined.get(now) === bead && await options.beadOpen(bead)) good += n
    }
    if (good < newSkips) {
      findings.push(['gate-test-loosened', `${now}: ${newSkips} new skip(s) without a route: a skip carries `
        + '`flake-quarantine: <open bead>` and the commit adds that bead\'s flake-quarantine entry for this file, or the '
        + 'message cites a merge-base Q row'])
    }
  }
  return findings
}

/** The most pairings keptBodies tries; past it the edited bodies meet every base body, which refuses any loss. */
const PAIRINGS = 256

/**
 * The bodies a title's kept tests are judged on when some of its same-titled tests in a file are retired (a routed
 * Retires-test): a body unchanged at head is dropped from both sides; the edited ones left are compared with every
 * choice of as many base bodies left, and a loosening any choice shows is refused, so neither a retirement nor the
 * tests' order hides one (an edit to the weaker twin beside a retired stronger one is refused: cite a Q row or split
 * the commits).
 */
function keptBodies(was: readonly Body[], is: readonly Body[]): [Body[][], Body[]] {
  const left = [...was]
  const edited: Body[] = []
  for (const body of is) {
    const same = left.findIndex((other) => other.text === body.text)
    if (same === -1) edited.push(body)
    else left.splice(same, 1)
  }
  const choices: Body[][] = []
  const choose = (from: number, picked: Body[]): boolean => {
    if (picked.length === edited.length) return choices.push(picked) <= PAIRINGS
    for (let i = from; i <= left.length - (edited.length - picked.length); i += 1) {
      if (!choose(i + 1, [...picked, left[i] as Body])) return false
    }
    return true
  }
  return [choose(0, []) ? choices : [[...was]], edited]
}

/** Python's sorted() order for strings: by code point, not UTF-16 unit. */
