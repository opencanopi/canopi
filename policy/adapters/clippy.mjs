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
// `clippy::disallowed_methods` is keyed by the method, not the lint (2.1-M223): R2, R8, R11 and R22 share the lint, so
// an exemption for one method must never cover a new call to another. Each such attribute is one site per configured
// method (clippy.toml's disallowed-methods) its item calls, its target `clippy:disallowed_methods(<method path>)`. One
// whose compiled item calls none is refused: rustc reports it unfulfilled (`unfulfilled_lint_expectations`, forced to
// warn so an allow cannot hide it). One that rustc never reports, in an item this platform does not compile (a cfg it
// leaves out), is refused too: no method can be named for it here, and a key without one would excuse any call. The source cannot say which method an item calls: most of today's sites call it
// inside tauri::generate_context!'s expansion, and `.spawn(` on a Builder needs its type. So clippy says, run once over
// the packages holding those attributes with the lint forced to warn (`--force-warn` reaches through #[expect] and
// fulfils it): each diagnostic, at its outermost macro call site, belongs to the innermost attributed item holding it.
// Only what this platform compiles is seen, as for the lint itself; a run that fails is `tool-failed`. That run needs
// the package's whole build environment (for canopi-desktop, Tauri's system libraries, and CANOPI_SKIP_BUNDLED_DB=1
// without the bundled catalogue), so the `disallowed-methods` family that keys these sites is push-lane, run where
// the Rust gate runs, and the commit-lane `suppressions` family leaves the lint to it.
import fs from 'node:fs';
import path from 'node:path';

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
// disallowed_methods: the method each attributed item calls

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
function cargoPackage(root, relPath) {
  const read = (dir) => {
    const file = path.join(root, dir, 'Cargo.toml');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
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

/** The method a disallowed_methods site counts under when no compiled item holds it (a cfg this platform leaves out). */
const UNFULFILLED = 'unfulfilled_lint_expectations';

/**
 * What clippy reports in the packages holding `files` (repository paths): `calls`, Map(path -> [{ byte, method }]),
 * the disallowed calls, each once though the lib and test targets both report it, and `unfulfilled`, Map(path ->
 * [byte]), where rustc compiled a lint expectation nothing fulfilled.
 */
function disallowedCalls(root, files, exec) {
  const byWorkspace = new Map();
  for (const file of files) {
    const pkg = cargoPackage(root, file);
    if (!byWorkspace.has(pkg.workspace)) byWorkspace.set(pkg.workspace, new Set());
    byWorkspace.get(pkg.workspace).add(pkg.name);
  }
  const calls = new Map();
  const unfulfilled = new Map();
  const seen = new Set();
  for (const [workspace, names] of [...byWorkspace].sort(([a], [b]) => a.localeCompare(b))) {
    const args = ['clippy', '--manifest-path', path.posix.join(workspace, 'Cargo.toml'), ...[...names].sort().flatMap((n) => ['-p', n]),
      '--all-targets', '--message-format=json', '--quiet', '--', '--force-warn', DISALLOWED_METHODS, '--force-warn', UNFULFILLED];
    const { status, stdout, stderr } = exec('cargo', args, { cwd: root });
    if (status !== 0) throw toolFailed(`cargo clippy exited ${status}: ${stderr.trim().split('\n').slice(-3).join(' ')}`);
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw toolFailed(`cargo clippy printed a line that is not JSON: ${line.slice(0, 80)}`);
      }
      if (message.reason !== 'compiler-message') continue;
      if (message.message?.code?.code === UNFULFILLED) {
        const primary = message.message.spans?.find((s) => s.is_primary);
        if (!primary) throw toolFailed(`unreadable ${UNFULFILLED} diagnostic: ${message.message.message}`);
        const site = callSite(primary);
        if (path.isAbsolute(site.file_name)) continue;
        const file = path.posix.join(workspace, site.file_name);
        if (!unfulfilled.has(file)) unfulfilled.set(file, []);
        unfulfilled.get(file).push(site.byte_start);
        continue;
      }
      if (message.message?.code?.code !== DISALLOWED_METHODS) continue;
      const method = /use of a disallowed method `([^`]+)`/.exec(message.message.message)?.[1];
      const primary = message.message.spans?.find((s) => s.is_primary);
      if (!method || !primary) throw toolFailed(`unreadable disallowed_methods diagnostic: ${message.message.message}`);
      const site = callSite(primary);
      if (path.isAbsolute(site.file_name)) continue; // a call written outside the workspace
      const file = path.posix.join(workspace, site.file_name);
      const key = `${file}\0${site.byte_start}\0${method}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!calls.has(file)) calls.set(file, []);
      calls.get(file).push({ byte: site.byte_start, method });
    }
  }
  return { calls, unfulfilled };
}

/**
 * Each disallowed_methods site of `sites` replaced by one site per configured method its item calls, `method` set;
 * refused when no cargo package holds it, its compiled item calls none (rustc reports it unfulfilled), or this
 * platform does not compile its item (rustc reports neither); other sites unchanged (2.1-M223).
 */
export function resolveDisallowedMethods({ root, sites, exec }) {
  const pending = sites.filter((s) => s.rule === DISALLOWED_METHODS);
  if (!pending.length) return sites;
  const packaged = new Set(pending.filter((s) => cargoPackage(root, s.path)).map((s) => s.path));
  const { calls, unfulfilled } = packaged.size ? disallowedCalls(root, [...packaged].sort(), exec) : { calls: new Map(), unfulfilled: new Map() };
  const extents = new Map();
  for (const file of new Set(pending.map((s) => s.path))) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    const bytes = (i) => Buffer.byteLength(src.slice(0, i), 'utf8');
    extents.set(file, pending.filter((s) => s.path === file).map((s) => ({
      site: s, from: bytes(s.span[0]), to: bytes(itemEnd(src, s.span[1], s.inner)), attribute: [bytes(s.span[0]), bytes(s.span[1])],
    })));
  }
  const methods = new Map(pending.map((s) => [s, new Set()]));
  for (const [file, list] of calls) {
    for (const { byte, method } of list) {
      // The innermost attributed item holding the call answers for it, as rustc fulfils the nearest expectation.
      const owner = (extents.get(file) ?? []).filter((e) => e.from <= byte && byte < e.to).sort((a, b) => (a.to - a.from) - (b.to - b.from))[0];
      if (owner) methods.get(owner.site).add(method);
    }
  }
  return sites.flatMap((s) => {
    if (s.rule !== DISALLOWED_METHODS) return [s];
    if (!packaged.has(s.path)) return [{ ...s, refused: `#[expect(${DISALLOWED_METHODS})] is in no cargo package, so clippy cannot name the method it excuses` }];
    const found = [...methods.get(s)].sort();
    if (!found.length) {
      const { attribute } = extents.get(s.path).find((e) => e.site === s);
      const compiled = (unfulfilled.get(s.path) ?? []).some((byte) => attribute[0] <= byte && byte < attribute[1]);
      if (!compiled) return [{ ...s, refused: `#[expect(${DISALLOWED_METHODS})] is in an item this platform does not compile, so clippy cannot name the method it excuses` }];
      return [{ ...s, refused: `#[expect(${DISALLOWED_METHODS})] excuses an item that calls none of clippy.toml's disallowed-methods; remove it` }];
    }
    return found.map((method) => ({ ...s, method }));
  });
}

/** `<tool>:<lint>(<method>)` for a disallowed_methods site, the key each method's exemption is counted under. */
export const disallowedTarget = (site) => `clippy:disallowed_methods(${site.method})`;

export function collect({ root, paths, exec }) {
  const sites = paths.filter((p) => p.endsWith('.rs')).flatMap((p) => expectSites(p, fs.readFileSync(path.join(root, p), 'utf8')));
  return resolveDisallowedMethods({ root, sites, exec })
    .map(({ span, method, ...site }) => (method ? { ...site, target: disallowedTarget({ method }) } : site));
}

export function refuse(site) {
  if (site.inner) return `#![expect(${site.rule})] covers a whole module or crate; put an item-level #[expect] on each item it excuses`;
  if (!site.reason) return `#[expect(${site.rule})] gives no reason; write #[expect(${site.rule}, reason = "...")]`;
  return undefined;
}
