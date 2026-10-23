// policy/adapters/suppressions.mjs: every inline suppression as a site (contracts §12; 2.1-M187; ADR 0028 Ratchets).
//
// The `suppressions` family counts each directive that silences a rule, keyed `<path>: <tool>:<rule>` by the rule it
// names, so a new one needs an entry, a bead and a Q row like any other exception:
//   - `eslint-disable`, `eslint-disable-line`, `eslint-disable-next-line` and their `oxlint-` spellings (oxlint honours
//     both): `oxlint:<rule>` per rule named, a `-- reason` after them allowed;
//   - `ast-grep-ignore: <rule>, …` in any source: `ast-grep:<rule>`;
//   - `@ts-expect-error` outside tests: `tsc:ts-expect-error` (a test's type assertion is exempt);
//   - Rust `#[expect(<lint>, …)]` and `#![expect]`, attributes only: `clippy:<lint>` for `clippy::<lint>`, else
//     `<tool>:<lint>` for a tool lint and `rustc:<lint>` for a compiler lint (the clippy adapter's lexer);
//     `clippy::disallowed_methods` once per configured method its item calls, `clippy:disallowed_methods(<method
//     path>)`, refused when it calls none (the clippy adapter's resolution, which runs clippy; 2.1-M223).
// A directive is a comment that starts with it, never a mention in prose, a string, a template or a regex literal.
// Refused whatever the baseline: a directive naming no rule (it silences every rule on its line or file), and
// `@ts-ignore` and `@ts-nocheck`, which unlike `@ts-expect-error` never fail once nothing needs them.
import fs from 'node:fs';
import path from 'node:path';
import { disallowedTarget, expectSites, lexRust, resolveDisallowedMethods } from './clippy.mjs';

const JS = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /(?:^|\/)(?:__tests__|e2e|e2e-release)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const IDENT = /[A-Za-z0-9_$]/;
// After one of these a `/` starts a regex literal; after anything else (a name, a number, `)`, `]`, `}`) it divides.
// `!`, `+` and `-` are here as prefix operators; their postfix forms are read before this set is consulted.
const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'instanceof', 'yield', 'await']);

/** The comments in JavaScript or TypeScript source, JSX included: [{ line, text, block }]. */
export function jsComments(src) {
  const comments = [];
  let line = 1;
  let prev = '';
  let word = '';
  const braces = [0]; // open braces per template expression level; the first is the file's own code
  const advance = (from, to) => {
    for (let k = from; k < to; k++) if (src[k] === '\n') line++;
    return to;
  };
  /** Scans template text from `i` (after a backtick or a closing `}`); returns where code resumes. */
  const template = (i) => {
    let j = i;
    while (j < src.length) {
      if (src[j] === '\\') j += 2;
      else if (src[j] === '`') return { at: j + 1, open: false };
      else if (src[j] === '$' && src[j + 1] === '{') return { at: j + 2, open: true };
      else j++;
    }
    return { at: src.length, open: false };
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      comments.push({ line, text: src.slice(i + 2, stop), block: false });
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end;
      comments.push({ line, text: src.slice(i + 2, stop), block: true });
      i = advance(i, Math.min(src.length, stop + 2));
      continue;
    }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      i = advance(i, Math.min(src.length, j + 1));
      prev = c;
      word = '';
      continue;
    }
    if (c === '`' || (c === '}' && braces.length > 1 && braces[braces.length - 1] === 0)) {
      if (c === '}') braces.pop();
      const { at, open } = template(i + 1);
      if (open) braces.push(0);
      i = advance(i, at);
      prev = '`';
      word = '';
      continue;
    }
    // A `!` (TypeScript's non-null assertion) or a `++`/`--` right after an expression is postfix: it ends the
    // expression, so a `/` after it divides. After an operator or a keyword it is prefix and a `/` starts a regex.
    const afterExpression = prev === ')' || prev === ']' || prev === '`' || prev === '\'' || prev === '"'
      || (IDENT.test(prev) && !REGEX_KEYWORDS.has(word));
    if (afterExpression && ((c === '!' && src[i + 1] !== '=') || ((c === '+' || c === '-') && src[i + 1] === c))) {
      i += c === '!' ? 1 : 2;
      prev = ')';
      word = '';
      continue;
    }
    if (c === '/' && prev !== '<' && (REGEX_AFTER.has(prev) || prev === '' || REGEX_KEYWORDS.has(word))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      if (src[j] === '/') {
        i = j + 1;
        prev = 'x';
        word = '';
        continue;
      }
    }
    if (c === '{') braces[braces.length - 1]++;
    else if (c === '}') braces[braces.length - 1]--;
    if (c === '\n') line++;
    if (!/\s/.test(c)) {
      word = IDENT.test(c) ? (IDENT.test(prev) ? word + c : c) : '';
      prev = c;
    }
    i++;
  }
  return comments;
}

const DISABLE = /^\s*(?:eslint|oxlint)-disable(?:-line|-next-line)?(?=\s|$)([\s\S]*)$/;
const AST_GREP = /^\s*ast-grep-ignore(?=[\s:]|$)([\s\S]*)$/;

/** The rules a directive's remainder names: comma-separated, a `-- reason` after them. */
function namedRules(rest) {
  return rest.split(/\s--\s|\s--$/)[0].split(',').map((r) => r.trim()).filter(Boolean);
}

/** The suppression sites one comment holds. */
function commentSites(relPath, comment, { js, test }) {
  const at = { rule: 'suppressions', path: relPath, line: comment.line };
  const sites = [];
  const disable = js ? DISABLE.exec(comment.text) : null;
  if (disable) {
    const rules = namedRules(disable[1]);
    if (!rules.length) sites.push({ ...at, refused: 'a disable directive naming no rule silences every rule on its line or file; name the rule' });
    for (const rule of rules) sites.push({ ...at, target: `oxlint:${rule}` });
  }
  const ignore = AST_GREP.exec(comment.text);
  if (ignore) {
    const rules = namedRules(ignore[1].replace(/^\s*:/, ''));
    if (!rules.length) sites.push({ ...at, refused: 'an ast-grep-ignore naming no rule silences every rule; name it (ast-grep-ignore: <rule>)' });
    for (const rule of rules) sites.push({ ...at, target: `ast-grep:${rule}` });
  }
  const ts = js ? /^[\s/*]*@(ts-expect-error|ts-ignore|ts-nocheck)\b/.exec(comment.text) : null;
  if (ts && ts[1] !== 'ts-expect-error') {
    sites.push({ ...at, refused: `@${ts[1]} never fails once nothing needs it; use @ts-expect-error with its reason` });
  } else if (ts && !test) {
    sites.push({ ...at, target: 'tsc:ts-expect-error' });
  }
  return sites;
}

/** `clippy::x` -> `clippy:x`, `rustdoc::x` -> `rustdoc:x`, `dead_code` -> `rustc:dead_code`. */
function lintTarget(lint) {
  const at = lint.indexOf('::');
  return at === -1 ? `rustc:${lint}` : `${lint.slice(0, at)}:${lint.slice(at + 2)}`;
}

/** A resolved `#[expect]` site as a suppression: keyed by its lint, a disallowed_methods one by its method. */
function expectSuppression(s) {
  const at = { rule: 'suppressions', path: s.path, line: s.line };
  if (s.refused) return { ...at, refused: s.refused };
  return { ...at, target: s.method ? disallowedTarget(s) : lintTarget(s.rule) };
}

export function collect({ root, paths, exec }) {
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const rust = paths.filter((p) => p.endsWith('.rs')).map((p) => [p, read(p)]);
  const expects = resolveDisallowedMethods({ root, sites: rust.flatMap(([p, src]) => expectSites(p, src)), exec });
  return [
    ...expects.map(expectSuppression),
    ...rust.flatMap(([p, src]) => lexRust(src).comments.flatMap((c) => commentSites(p, c, { js: false, test: false }))),
    ...paths.filter((p) => JS.test(p)).flatMap((p) => jsComments(read(p)).flatMap((c) => commentSites(p, c, { js: true, test: TEST_FILE.test(p) }))),
  ];
}
