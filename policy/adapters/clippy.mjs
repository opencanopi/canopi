// policy/adapters/clippy.mjs: the expect-count adapter (contracts §12; 2.1-M188, 2.1-Q217; ADR 0028 Complexity).
//
// A ratcheted clippy or rustc lint is denied under one `-D warnings` run, and today's sites are item-level
// `#[expect(<lint>, reason = "...")]` attributes, which `unfulfilled_lint_expectations` fails once they are stale. This
// adapter counts those attributes per file, read from the source: attributes only, never doc comments, comments or
// string literals (a test's planted `#[expect]` in a raw string is not a site). Each lint an attribute names is one
// site `{ rule: '<lint as written>', path, line, inner, reason }`, `cfg_attr(<cond>, expect(...))` included.
// A family selects the lints it ratchets; for those, a module- or crate-level `#![expect]` is refused (it would cover
// every item below it) and so is an `#[expect]` without a reason.
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
      attributes.push({ inner, line, text: src.slice(start + 1, j) });
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

/** Every `#[expect]` and `#![expect]` lint in one Rust file, a site each. */
export function expectSites(relPath, source) {
  return lexRust(source).attributes.flatMap((attribute) => expectsIn(attribute.text).flatMap(({ lints, reason }) => lints
    .map((lint) => ({ rule: lint, path: relPath, line: attribute.line, inner: attribute.inner, reason }))));
}

export function collect({ root, paths }) {
  return paths.filter((p) => p.endsWith('.rs')).flatMap((p) => expectSites(p, fs.readFileSync(path.join(root, p), 'utf8')));
}

export function refuse(site) {
  if (site.inner) return `#![expect(${site.rule})] covers a whole module or crate; put an item-level #[expect] on each item it excuses`;
  if (!site.reason) return `#[expect(${site.rule})] gives no reason; write #[expect(${site.rule}, reason = "...")]`;
  return undefined;
}
