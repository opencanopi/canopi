// policy/adapters/clippy.mjs: the expect-count adapter (contracts §12; 2.1-M188, 2.1-Q217; ADR 0028 Complexity).
//
// A ratcheted clippy or rustc lint is denied under one `-D warnings` run, and today's sites are item-level
// `#[expect(<lint>, reason = "...")]` attributes, which `unfulfilled_lint_expectations` fails once they are stale. This
// adapter counts those attributes per file, read from the source: attributes only, never doc comments, comments or
// string literals (a test's planted `#[expect]` in a raw string is not a site). Each lint an attribute names is one
// site `{ rule: '<lint as written>', path, line, inner, reason }`, `cfg_attr(<cond>, expect(...))` included.
// A family selects the lints it ratchets; for those, a module- or crate-level `#![expect]` is refused (it would cover
// every item below it) and so is an `#[expect]` without a reason.
//
// `clippy::disallowed_methods` is the one escape list (canopi-f47t.52.240): its sites are production calls, keyed by the
// method, not the lint (2.1-M223: R2, R8, R11 and R22 share the lint, so an exemption for one method must never cover a
// new call to another). clippy is run once per workspace over its production targets (no --all-targets: tests may start
// threads freely) with the lint forced to warn (`--force-warn` reaches through #[expect] and fulfils it, and through any
// allow), and each reported call, at its outermost macro call site (most of today's sites are inside
// tauri::generate_context!'s expansion), is one site owned by the innermost `#[expect(clippy::disallowed_methods)]`
// holding it; a call none owns is refused, whatever allow switched the lint off. An attribute owning no call is refused
// when rustc reports it unfulfilled (`unfulfilled_lint_expectations`, forced to warn so an allow cannot hide it) or when
// this platform does not compile it outside test code. Only what this platform compiles is seen, as for the lint itself;
// a run that fails, or whose output ends before cargo's build-finished line, is `tool-failed`. That run needs the
// package's whole build environment (for canopi-desktop, Tauri's system libraries, and CANOPI_SKIP_BUNDLED_DB=1
// without the bundled catalogue) and a target of its own, so the `disallowed-methods` family is push-lane, run where
// the Rust gate runs, and the commit-lane `suppressions` family leaves the lint to it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const IDENT = /[A-Za-z0-9_]/;

/** Skips a string literal whose opening quote is at `i`; returns the index after its closing quote. */
function skipQuoted(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === '"') return j + 1;
  }
  return src.length;
}

/** At `i`, the end of a raw string literal (`r"…"`, `r#"…"#`, `br…`, `cr…`) starting there, or -1. */
function rawStringEnd(src, i) {
  let j = i;
  if (src[j] === 'b' || src[j] === 'c') j++;
  if (src[j] !== 'r') return -1;
  j++;
  let hashes = 0;
  while (src[j] === '#') { hashes++; j++; }
  if (src[j] !== '"') return -1;
  const close = `"${'#'.repeat(hashes)}`;
  const end = src.indexOf(close, j + 1);
  return end === -1 ? src.length : end + close.length;
}

/**
 * Lexes Rust source into its attributes and comments, skipping string, raw string and char literals.
 * Returns { attributes: [{ inner, line, text }], comments: [{ line, text }] }, `text` an attribute's bracketed body.
 */
export function lexRust(src) {
  const attributes = [];
  const comments = [];
  let line = 1;
  const advance = (from, to) => {
    for (let k = from; k < to; k++) if (src[k] === '\n') line++;
    return to;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const prevIdent = i > 0 && IDENT.test(src[i - 1]);
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      comments.push({ line, text: src.slice(i + 2, stop) });
      i = stop;
    } else if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; } else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; } else j++;
      }
      comments.push({ line, text: src.slice(i + 2, Math.max(i + 2, j - 2)) });
      i = advance(i, j);
    } else if (!prevIdent && (c === 'r' || c === 'b' || c === 'c') && rawStringEnd(src, i) !== -1) {
      i = advance(i, rawStringEnd(src, i));
    } else if (c === '"' || (!prevIdent && (c === 'b' || c === 'c') && src[i + 1] === '"')) {
      i = advance(i, skipQuoted(src, c === '"' ? i : i + 1));
    } else if (c === '\'' || (!prevIdent && c === 'b' && src[i + 1] === '\'')) {
      // A char literal ('a', '\n', '\u{1F600}', b'x'); otherwise a lifetime or label ('a, 'static).
      const q = c === '\'' ? i : i + 1;
      if (src[q + 1] === '\\') {
        const end = src.indexOf('\'', q + 3);
        i = advance(i, end === -1 ? src.length : end + 1);
      } else if (src[q + 2] === '\'') {
        i = advance(i, q + 3);
      } else {
        i = q + 1;
      }
    } else if (c === '#' && /^#!?\s*\[/.test(src.slice(i, i + 8))) {
      const inner = src[i + 1] === '!';
      const start = src.indexOf('[', i);
      let depth = 0;
      let j = start;
      while (j < src.length) {
        if (src[j] === '"') { j = skipQuoted(src, j); continue; }
        const raw = rawStringEnd(src, j);
        if (raw !== -1 && !IDENT.test(src[j - 1])) { j = raw; continue; }
        if (src[j] === '[') depth++;
        else if (src[j] === ']' && --depth === 0) break;
        j++;
      }
      attributes.push({ inner, line, text: src.slice(start + 1, j), start: i, end: j + 1 });
      i = advance(i, j + 1);
    } else {
      if (c === '\n') line++;
      i++;
    }
  }
  return { attributes, comments };
}

/** `text` split at its top-level commas, string literals and nested brackets kept whole. */
function topLevelArgs(text) {
  const args = [];
  let depth = 0;
  let from = 0;
  for (let j = 0; j < text.length; j++) {
    const ch = text[j];
    if (ch === '"') { j = skipQuoted(text, j) - 1; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { args.push(text.slice(from, j).trim()); from = j + 1; }
  }
  args.push(text.slice(from).trim());
  return args.filter(Boolean);
}

/** `name(args)` as [name, argsText], or undefined. */
function call(text) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*$/.exec(text);
  return match ? [match[1], match[2]] : undefined;
}

const LINT = /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$/;

/** The `expect` lint lists an attribute body holds, `cfg_attr` arms included: [{ lints, reason }]. */
export function expectsIn(text) {
  const parsed = call(text);
  if (!parsed) return [];
  const [name, body] = parsed;
  if (name === 'cfg_attr') return topLevelArgs(body).slice(1).flatMap(expectsIn);
  if (name !== 'expect') return [];
  const args = topLevelArgs(body);
  const reasonArg = args.find((a) => /^reason\s*=/.test(a));
  const reason = reasonArg !== undefined && /"[\s\S]*\S[\s\S]*"/.test(reasonArg.replace(/^reason\s*=\s*/, ''));
  return [{ lints: args.filter((a) => LINT.test(a)), reason }];
}

/**
 * Every `#[expect]` and `#![expect]` lint in one Rust file, a site each; `span` is the attribute's [start, end) in
 * `source`, for the disallowed_methods resolution.
 */
export function expectSites(relPath, source) {
  return lexRust(source).attributes.flatMap((attribute) => expectsIn(attribute.text).flatMap(({ lints, reason }) => lints
    .map((lint) => ({ rule: lint, path: relPath, line: attribute.line, inner: attribute.inner, reason, span: [attribute.start, attribute.end] }))));
}

// ---------------------------------------------------------------------------------------------------------------
// disallowed_methods: the production calls each attribute owns

export const DISALLOWED_METHODS = 'clippy::disallowed_methods';
const OPEN = '([{';
const CLOSE = ')]}';

/**
 * The significant characters of `src` from `from`: comments, string, raw string and char literals skipped, a
 * lifetime or label read as a word. Yields { at, c, word } where `word` is the identifier starting at `at`, if any.
 */
function* significant(src, from) {
  let i = from;
  while (i < src.length) {
    const c = src[i];
    const prevIdent = i > 0 && IDENT.test(src[i - 1]);
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const end = src.indexOf('\n', i); i = end === -1 ? src.length : end; continue; }
    if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; } else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; } else j++;
      }
      i = j;
      continue;
    }
    if (!prevIdent && (c === 'r' || c === 'b' || c === 'c') && rawStringEnd(src, i) !== -1) {
      yield { at: i, c: '"' };
      i = rawStringEnd(src, i);
      continue;
    }
    if (c === '"' || (!prevIdent && (c === 'b' || c === 'c') && src[i + 1] === '"')) {
      yield { at: i, c: '"' };
      i = skipQuoted(src, c === '"' ? i : i + 1);
      continue;
    }
    if (c === '\'' || (!prevIdent && c === 'b' && src[i + 1] === '\'')) {
      const q = c === '\'' ? i : i + 1;
      if (src[q + 1] === '\\') { const end = src.indexOf('\'', q + 3); yield { at: i, c: '\'' }; i = end === -1 ? src.length : end + 1; continue; }
      if (src[q + 2] === '\'') { yield { at: i, c: '\'' }; i = q + 3; continue; }
      i = q + 1; // a lifetime or label: its name follows as a word
      continue;
    }
    if (IDENT.test(c) && !prevIdent) {
      let j = i;
      while (j < src.length && IDENT.test(src[j])) j++;
      yield { at: i, c, word: src.slice(i, j) };
      i = j;
      continue;
    }
    yield { at: i, c };
    i++;
  }
}

const ITEM_WORDS = new Set(['fn', 'impl', 'trait', 'mod', 'struct', 'enum', 'union', 'extern', 'macro_rules']);
const SEMI_WORDS = new Set(['let', 'use', 'type', 'static']);
const BLOCK_WORDS = new Set(['if', 'match', 'loop', 'while', 'for', 'unsafe', 'async']);

/**
 * The end (exclusive) of the item, statement or expression an outer attribute ending at `from` applies to, or, for an
 * inner attribute, of the block or file holding it. A `let`, `use`, `type`, `static` or `const` (not `const fn`) ends
 * at its `;`; an item at its `;` or its body's `}`; a block-like expression at its last `}` (an `else`, `.` or `?`
 * continuing it); any other expression at a `;` or `,` at its depth. A bracket closing beyond the start ends any of them.
 */
export function itemEnd(src, from, inner = false) {
  let depth = 0;
  let kind;
  let afterBrace = false;
  for (const tok of significant(src, from)) {
    if (afterBrace) {
      afterBrace = false;
      if (!(tok.word === 'else' || tok.c === '.' || tok.c === '?')) return tok.at;
    }
    if (kind === undefined && !inner) {
      if (tok.c === '#') { // a further outer attribute: skip it whole
        kind = 'attr';
      } else if (tok.word === 'pub') {
        kind = 'pub';
        continue;
      } else if (tok.word === 'const') {
        kind = 'const?';
        continue;
      } else {
        kind = tok.word && ITEM_WORDS.has(tok.word) ? 'item'
          : tok.word && SEMI_WORDS.has(tok.word) ? 'semi'
            : (tok.word && BLOCK_WORDS.has(tok.word)) || tok.c === '{' ? 'block' : 'expr';
      }
    } else if (kind === 'pub') {
      // `pub(crate)` is skipped whole like an attribute; then the item itself is read
      if (tok.c === '(') kind = 'attr';
      else {
        kind = undefined;
        if (tok.word === 'const') { kind = 'const?'; continue; }
        kind = tok.word && ITEM_WORDS.has(tok.word) ? 'item' : tok.word && SEMI_WORDS.has(tok.word) ? 'semi' : 'block';
      }
    } else if (kind === 'const?') {
      kind = tok.word === 'fn' || tok.word === 'unsafe' || tok.word === 'async' || tok.word === 'extern' ? 'item' : tok.c === '{' ? 'block' : 'semi';
    }
    if (OPEN.includes(tok.c)) { depth++; continue; }
    if (CLOSE.includes(tok.c)) {
      depth--;
      if (depth < 0) return tok.at;
      if (kind === 'attr' && depth === 0) { kind = undefined; continue; }
      if (depth === 0 && tok.c === '}' && !inner && (kind === 'item' || kind === 'block')) {
        if (kind === 'item') return tok.at + 1;
        afterBrace = true;
      }
      continue;
    }
    if (depth === 0 && !inner && tok.c === ';' && kind !== 'attr') return tok.at + 1;
    if (depth === 0 && !inner && tok.c === ',' && (kind === 'expr' || kind === 'block')) return tok.at;
  }
  return src.length;
}

/** The nearest Cargo.toml at or above the file's directory under `root` that declares a package, with its workspace. */
function cargoPackage(root, relPath, manifests = new Map()) {
  const read = (dir) => {
    if (!manifests.has(dir)) {
      const file = path.join(root, dir, 'Cargo.toml');
      manifests.set(dir, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);
    }
    return manifests.get(dir);
  };
  const parents = (dir) => {
    const out = [];
    for (let d = dir; ; d = path.posix.dirname(d)) {
      out.push(d === '.' ? '' : d);
      if (d === '.' || d === '' || d === '/') break;
    }
    return out;
  };
  const dir = parents(path.posix.dirname(relPath)).find((d) => /^\s*\[package\]/m.test(read(d) ?? ''));
  if (dir === undefined) return undefined;
  const name = /^\s*\[package\][^[]*?^\s*name\s*=\s*"([^"]+)"/ms.exec(read(dir))?.[1];
  if (!name) return undefined;
  const workspace = parents(dir).find((d) => /^\s*\[workspace\]/m.test(read(d) ?? '')) ?? dir;
  return { name, workspace };
}

const toolFailed = (message) => Object.assign(new Error(message), { code: 'tool-failed' });

/** A span's outermost macro call site: where the user wrote the code a diagnostic comes from. */
function callSite(span) {
  let s = span;
  while (s.expansion?.span) s = s.expansion.span;
  return s;
}

/** rustc's lint for an expectation nothing fulfilled: forced to warn, it marks an attribute whose compiled item calls none. */
const UNFULFILLED = 'unfulfilled_lint_expectations';

/**
 * Refuses, before cargo runs, a target directory two worktrees would share and wait on (the gate's refuseSharedTarget,
 * 2.1-M201): the retired shared-build target anywhere, or none set in a linked worktree.
 */
function refuseSharedTarget(root, env = process.env) {
  const target = env.CARGO_TARGET_DIR ?? '';
  if (target.split(/[\\/]/).includes('shared-build')) {
    throw toolFailed(`CARGO_TARGET_DIR=${target} is the shared-build target every worktree would lock (2.1-M201): set a per-stream CARGO_TARGET_DIR`);
  }
  if (target) return;
  const gitDir = (args) => spawnSync('git', ['rev-parse', ...args], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const own = gitDir(['--absolute-git-dir']);
  if (own && own !== gitDir(['--path-format=absolute', '--git-common-dir'])) {
    throw toolFailed('a linked worktree runs clippy with its own CARGO_TARGET_DIR (2.1-M201): set a per-stream CARGO_TARGET_DIR');
  }
}

/**
 * What clippy reports for the production targets (no --all-targets: tests may start threads freely) of every package
 * in the workspaces holding `files`: `calls`, Map(path -> [{ byte, line, method }]), each disallowed call once, and
 * `unfulfilled`, Map(path -> [byte]), where rustc compiled a lint expectation nothing fulfilled. Output that ends before
 * cargo's build-finished line (truncated, killed) is tool-failed, never zero calls.
 */
function disallowedCalls(root, files, exec) {
  const manifests = new Map();
  const workspaces = new Set(files.map((file) => cargoPackage(root, file, manifests)?.workspace).filter((w) => w !== undefined));
  const calls = new Map();
  const unfulfilled = new Map();
  const seen = new Set();
  if (workspaces.size) refuseSharedTarget(root);
  for (const workspace of [...workspaces].sort()) {
    const args = ['clippy', '--manifest-path', path.posix.join(workspace, 'Cargo.toml'), '--workspace',
      '--message-format=json', '--quiet', '--', '--force-warn', DISALLOWED_METHODS, '--force-warn', UNFULFILLED];
    const { status, stdout, stderr } = exec('cargo', args, { cwd: root });
    if (status !== 0) throw toolFailed(`cargo clippy exited ${status}: ${stderr.trim().split('\n').slice(-3).join(' ')}`);
    let finished = false;
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw toolFailed(`cargo clippy printed a line that is not JSON: ${line.slice(0, 80)}`);
      }
      if (message.reason === 'build-finished') finished = message.success === true;
      if (message.reason !== 'compiler-message') continue;
      const code = message.message?.code?.code;
      if (code !== UNFULFILLED && code !== DISALLOWED_METHODS) continue;
      const primary = message.message.spans?.find((s) => s.is_primary);
      const method = /use of a disallowed method `([^`]+)`/.exec(message.message.message)?.[1];
      if (!primary || (code === DISALLOWED_METHODS && !method)) throw toolFailed(`unreadable ${code} diagnostic: ${message.message.message}`);
      const site = callSite(primary);
      if (path.isAbsolute(site.file_name)) continue; // written outside the workspace
      const file = path.posix.join(workspace, site.file_name);
      const into = code === UNFULFILLED ? unfulfilled : calls;
      const key = `${code}\0${file}\0${site.byte_start}\0${method}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!into.has(file)) into.set(file, []);
      into.get(file).push(code === UNFULFILLED ? site.byte_start : { byte: site.byte_start, line: site.line_start, method });
    }
    if (!finished) throw toolFailed(`cargo clippy's output for ${workspace || '.'} ends before a successful build-finished line: truncated or interrupted`);
  }
  return { calls, unfulfilled };
}

const TEST_ATTRIBUTE = /^\s*(cfg\s*\(\s*test\s*\)|test|[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*::test(\s*\([\s\S]*\))?)\s*$/;

/** The [start, end) extents of `src`'s test code: every item under an outer #[cfg(test)], #[test] or #[<path>::test]. */
function testExtents(src) {
  return lexRust(src).attributes.filter((a) => !a.inner && TEST_ATTRIBUTE.test(a.text)).map((a) => [a.start, itemEnd(src, a.end)]);
}

/**
 * Files that belong to an out-of-line `#[cfg(test)] mod name;` of a file of `files`, as a predicate: `<dir>/name.rs`,
 * `<dir>/name/mod.rs` and every file below `<dir>/name/` (native_command_policy's TestModuleFiles; #[path] unresolved).
 */
function testModuleFiles(root, files, read) {
  const named = new Set();
  const prefixes = [];
  for (const file of files) {
    const src = read(file);
    if (!src.includes('cfg')) continue;
    const base = path.posix.basename(file);
    const dir = ['mod.rs', 'lib.rs', 'main.rs'].includes(base) ? path.posix.dirname(file) : file.replace(/\.rs$/, '');
    for (const a of lexRust(src).attributes) {
      if (a.inner || !/^\s*cfg\s*\(\s*test\s*\)\s*$/.test(a.text)) continue;
      const decl = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/.exec(src.slice(a.end));
      if (!decl) continue;
      const child = path.posix.join(dir === '.' ? '' : dir, decl[1]);
      named.add(`${child}.rs`);
      prefixes.push(`${child}/`);
    }
  }
  return (file) => named.has(file) || prefixes.some((p) => file.startsWith(p));
}

/**
 * The disallowed_methods sites of the production code under `paths` (2.1-M223, canopi-f47t.52.240): each production
 * call to a configured method is one site, keyed by the method, owned by the innermost
 * #[expect(clippy::disallowed_methods)] whose item or statement holds it (rustc fulfils the nearest expectation), so a
 * second call in a reviewed statement and a new reviewed statement each raise a count. A call no attribute owns (the lint
 * switched off by #[allow(clippy::all)], an inner #![allow] or allow(warnings): the force-warn run sees through each) is
 * refused. An attribute owning no call is refused when rustc compiled it unfulfilled, or when it is outside test code
 * and this platform does not compile it; one in test code (an item under #[cfg(test)] or #[test], or an out-of-line
 * test module) is no site. One no cargo package holds is refused. `expects` are expectSites' disallowed_methods sites.
 */
export function disallowedSites({ root, paths, expects, exec }) {
  const sources = new Map();
  const read = (file) => {
    if (!sources.has(file)) sources.set(file, fs.readFileSync(path.join(root, file), 'utf8'));
    return sources.get(file);
  };
  const rust = paths.filter((p) => p.endsWith('.rs'));
  const inTestModule = testModuleFiles(root, rust, read);
  const packaged = rust.filter((p) => cargoPackage(root, p));
  const { calls, unfulfilled } = disallowedCalls(root, packaged, exec);
  const bytes = (src, i) => Buffer.byteLength(src.slice(0, i), 'utf8');
  const owners = new Map();
  const out = [];
  for (const s of expects) {
    if (!packaged.includes(s.path)) {
      out.push({ ...s, refused: `#[expect(${DISALLOWED_METHODS})] is in no cargo package, so clippy cannot name the method it excuses` });
      continue;
    }
    const src = read(s.path);
    if (inTestModule(s.path) || testExtents(src).some(([from, to]) => from <= s.span[0] && s.span[1] <= to)) continue;
    const owner = { site: s, from: bytes(src, s.span[0]), to: bytes(src, itemEnd(src, s.span[1], s.inner)), attribute: [bytes(src, s.span[0]), bytes(src, s.span[1])], owns: 0 };
    if (!owners.has(s.path)) owners.set(s.path, []);
    owners.get(s.path).push(owner);
  }
  const scope = new Set(rust);
  for (const [file, list] of [...calls].sort(([a], [b]) => a.localeCompare(b))) {
    if (!scope.has(file)) continue;
    for (const { byte, line, method } of list.sort((a, b) => a.byte - b.byte || a.method.localeCompare(b.method))) {
      const owner = (owners.get(file) ?? []).filter((o) => o.from <= byte && byte < o.to).sort((a, b) => (a.to - a.from) - (b.to - b.from))[0];
      if (owner) {
        owner.owns++;
        out.push({ ...owner.site, method });
      } else {
        out.push({ rule: DISALLOWED_METHODS, path: file, line, method, refused: `a production call to ${method} that no #[expect(${DISALLOWED_METHODS}, reason = "...")] owns (an allow switches the lint off); give its statement one` });
      }
    }
  }
  for (const list of owners.values()) {
    for (const { site, attribute, owns } of list) {
      if (owns) continue;
      const compiled = (unfulfilled.get(site.path) ?? []).some((byte) => attribute[0] <= byte && byte < attribute[1]);
      out.push({ ...site, refused: compiled
        ? `#[expect(${DISALLOWED_METHODS})] excuses an item that calls none of clippy.toml's disallowed-methods; remove it`
        : `#[expect(${DISALLOWED_METHODS})] is in production code this platform does not compile, so clippy cannot name the method it excuses` });
    }
  }
  return out;
}

/** `<tool>:<lint>(<method>)` for a disallowed_methods site, the key each method's exemption is counted under. */
export const disallowedTarget = (site) => `clippy:disallowed_methods(${site.method})`;

/**
 * The sites of `select`'s lints (every lint without one) under `paths`. Only a family selecting clippy::disallowed_methods
 * (push lane), or a run without `select` over a disallowed_methods attribute, runs clippy, to find each production call
 * and the attribute owning it; every other family reads its sites from source alone, so the commit lane needs no cargo
 * (canopi-f47t.52.228.54).
 */
export function collect({ root, paths, exec, select }) {
  const sites = paths.filter((p) => p.endsWith('.rs')).flatMap((p) => expectSites(p, fs.readFileSync(path.join(root, p), 'utf8')))
    .filter((s) => !select || select.includes(s.rule));
  const expects = sites.filter((s) => s.rule === DISALLOWED_METHODS);
  const wanted = select ? select.includes(DISALLOWED_METHODS) : expects.length > 0;
  const resolved = wanted ? disallowedSites({ root, paths, expects, exec }) : [];
  return [...sites.filter((s) => s.rule !== DISALLOWED_METHODS), ...resolved]
    .map(({ span, method, ...site }) => (method ? { ...site, target: disallowedTarget({ method }) } : site));
}

export function refuse(site) {
  if (site.inner) return `#![expect(${site.rule})] covers a whole module or crate; put an item-level #[expect] on each item it excuses`;
  if (!site.reason) return `#[expect(${site.rule})] gives no reason; write #[expect(${site.rule}, reason = "...")]`;
  return undefined;
}
