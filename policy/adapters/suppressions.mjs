// policy/adapters/suppressions.mjs: every inline suppression as a site (contracts §12; 2.1-M187; ADR 0028 Ratchets).
//
// The `suppressions` family counts each directive that silences a rule, keyed `<path>: <tool>:<rule>` by the rule it
// names, so a new one needs an entry, a bead and a Q row like any other exception:
//   - `eslint-disable`, `eslint-disable-line`, `eslint-disable-next-line` and their `oxlint-` spellings (oxlint honours
//     both): `oxlint:<rule>` per rule named, a `-- reason` after them allowed;
//   - `ast-grep-ignore: <rule>, …` in any file ast-grep parses, by its built-in languages' extensions (AST_GREP_SYNTAX):
//     `ast-grep:<rule-id>`. ast-grep honours only a rule's tool id, the `id` of its file under sgconfig.yml's ruleDirs
//     (`<rule-id>.<language>` for a rule written per language, `<rule-id>` for one language), so a tool id counts under
//     its `<rule-id>` and a directive naming only the `<rule-id>` of a rule written per language is refused: it silences
//     nothing (2.1-M257). A name no rule file has counts as written. Outside JavaScript, TypeScript and Rust a directive is any comment opener it follows, strings not
//     lexed, so no opener in a string hides one and a string spelling one counts (fail-closed); an `sgconfig.yml` mapping files
//     by its own globs (`languageGlobs`, `customLanguages`) is refused, since which files ast-grep parses is then its;
//   - `@ts-expect-error` outside tests: `tsc:ts-expect-error` (a test's type assertion is exempt);
//   - Rust `#[expect(<lint>, …)]` and `#![expect]`, attributes only: `clippy:<lint>` for `clippy::<lint>`, else
//     `<tool>:<lint>` for a tool lint and `rustc:<lint>` for a compiler lint (the clippy adapter's lexer), except a
//     lint a clippy-tool family selects (its family file's `select` under policy/ratchets/, read here: the
//     `rust-too-many-*` and `rust-missing-docs` ratchets count those expects themselves) and always
//     `clippy::disallowed_methods`: the push-lane `disallowed-methods` family keys it by the method its item calls,
//     which only a clippy run can name (2.1-M223), so this commit-lane family never runs cargo;
//   - Rust inner `#![allow(<lint>, …)]`, directly or in a `cfg_attr` arm, keyed like an `#[expect]` for every lint,
//     `clippy::disallowed_methods` and family-selected lints included: no family counts an allow, and clippy's
//     `allow_attributes` denies only the outer form, so an inner one is the crate- or module-wide switch left to
//     count (2.1-Q216).
// A directive is a comment that starts with it, never a mention in prose, a string, a template or a regex literal.
// Refused whatever the baseline: a directive naming no rule (it silences every rule on its line or file), and
// `@ts-ignore` and `@ts-nocheck`, which unlike `@ts-expect-error` never fail once nothing needs them.
import fs from 'node:fs';
import path from 'node:path';
import { ruleDirs } from './ast-grep.mjs';
import { DISALLOWED_METHODS, expectSites, lexRust } from './clippy.mjs';

const RATCHETS_DIR = 'policy/ratchets';

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
    // `</` opens a JSX closing tag and `} />` closes a self-closing one after an expression attribute or a spread
    // (`<Foo a={b} />`): neither is a regex, whose scan would swallow the comments after it on the line.
    const jsxSlash = prev === '<' || (prev === '}' && src[i + 1] === '>');
    if (c === '/' && !jsxSlash && (REGEX_AFTER.has(prev) || prev === '' || REGEX_KEYWORDS.has(word))) {
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

// ast-grep's built-in languages by extension, as comment syntax: line openers and [open, close] block delimiters.
// JavaScript, TypeScript and Rust are lexed above and by the clippy adapter; JSON, as tree-sitter-json, takes comments.
const C_LIKE = { line: ['//'], block: [['/*', '*/']] };
const HASH = { line: ['#'], block: [] };
const AST_GREP_SYNTAX = new Map([
  ...['c', 'h', 'cc', 'cpp', 'cxx', 'c++', 'hh', 'hpp', 'cu', 'ino', 'cs', 'go', 'java', 'kt', 'kts', 'ktm', 'scala', 'sc',
    'sbt', 'sol', 'swift', 'json'].map((e) => [e, C_LIKE]),
  ...['py', 'py3', 'pyi', 'bzl', 'rb', 'rbw', 'gemspec', 'ex', 'exs', 'yml', 'yaml', 'sh', 'bash', 'zsh', 'ksh', 'bats', 'env']
    .map((e) => [e, HASH]),
  ...['hcl', 'tf', 'php'].map((e) => [e, { line: ['#', '//'], block: [['/*', '*/']] }]),
  ['nix', { line: ['#'], block: [['/*', '*/']] }],
  ['css', { line: [], block: [['/*', '*/']] }],
  ['scss', C_LIKE],
  ['lua', { line: ['--'], block: [['--[[', ']]']] }],
  ['hs', { line: ['--'], block: [['{-', '-}']] }],
  ...['html', 'htm', 'xhtml'].map((e) => [e, { line: ['//'], block: [['<!--', '-->'], ['/*', '*/']] }]),
]);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The ast-grep-ignore comments of a file in a language AST_GREP_SYNTAX names: [{ line, text }], one per comment opener
 * that the directive follows, whatever comes before it. Comment extents are never tracked, so an opener inside a string
 * (`//` in a URL, `/*` in a glob) hides no directive after it; a string spelling the directive counts (fail-closed).
 * A block's text runs to its close, or to its line's end when it has none.
 */
function syntaxComments(src, { line: lineOpeners, block }) {
  const openers = [...block.map(([o]) => o), ...lineOpeners].sort((a, b) => b.length - a.length);
  const directive = new RegExp(`(${openers.map(escape).join('|')})(?=\\s*ast-grep-ignore)`, 'g');
  const comments = [];
  for (const match of src.matchAll(directive)) {
    const from = match.index + match[1].length;
    const close = block.find(([o]) => o === match[1])?.[1];
    const end = close === undefined ? -1 : src.indexOf(close, from);
    const stop = end !== -1 ? end : src.indexOf('\n', from) === -1 ? src.length : src.indexOf('\n', from);
    comments.push({ line: src.slice(0, match.index).split('\n').length, text: src.slice(from, stop) });
  }
  return comments;
}

/** Refuses an ast-grep config that maps files to languages by its own globs: which files it parses is then its. */
function refuseLanguageGlobs(root) {
  const config = path.join(root, 'sgconfig.yml');
  if (fs.existsSync(config) && /^\s*(?:languageGlobs|customLanguages)\s*:/m.test(fs.readFileSync(config, 'utf8'))) {
    throw Object.assign(new Error('suppressions: sgconfig.yml maps files to languages by its own globs (languageGlobs, customLanguages); teach AST_GREP_SYNTAX those files before using them'), { code: 'tool-failed' });
  }
}

const DISABLE = /^\s*(?:eslint|oxlint)-disable(?:-line|-next-line)?(?=\s|$)([\s\S]*)$/;
const AST_GREP = /^\s*ast-grep-ignore(?=[\s:]|$)([\s\S]*)$/;

/** The rules a directive's remainder names: comma-separated, a `-- reason` after them. */
function namedRules(rest) {
  return rest.split(/\s--\s|\s--$/)[0].split(',').map((r) => r.trim()).filter(Boolean);
}

/** The tool ids of the ast-grep rule files under `root`'s sgconfig.yml ruleDirs (each file's `id:`); none without one. */
function astGrepToolIds(root) {
  const config = path.join(root, 'sgconfig.yml');
  if (!fs.existsSync(config)) return new Set();
  const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [])
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.ya?ml$/u.test(e.name) ? [path.join(dir, e.name)] : []));
  return new Set(ruleDirs(fs.readFileSync(config, 'utf8')).flatMap((d) => walk(path.join(root, d)))
    .flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(/^id:\s*['"]?([^'"\s#]+)/gmu)].map((m) => m[1])));
}

/** An ast-grep-ignore's named id as a site: its tool id counted under `<rule-id>`, a bare per-language rule id refused. */
function astGrepSite(at, id, toolIds) {
  if (toolIds.has(id)) return { ...at, target: `ast-grep:${id.split('.')[0]}` };
  const halves = [...toolIds].filter((t) => t.startsWith(`${id}.`));
  if (halves.length) return { ...at, refused: `an ast-grep-ignore naming only ${id} silences nothing; ast-grep honours the tool id (${halves.sort().join(', ')})` };
  return { ...at, target: `ast-grep:${id}` };
}

/** The suppression sites one comment holds. */
function commentSites(relPath, comment, { js, test, toolIds = new Set() }) {
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
    for (const rule of rules) sites.push(astGrepSite(at, rule, toolIds));
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

/** An `#[expect]` site as a suppression, keyed by its lint. */
const expectSuppression = (s) => ({ rule: 'suppressions', path: s.path, line: s.line, target: lintTarget(s.rule) });

/**
 * The lints the clippy-tool families select, read from their files under policy/ratchets/: their expects are those
 * families' sites. A file that is not JSON selects nothing here; the checker's loader refuses it.
 */
function familySelectedLints(root) {
  const dir = path.join(root, RATCHETS_DIR);
  const lints = new Set([DISALLOWED_METHODS]);
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')) : []) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (doc?.tool === 'clippy' && Array.isArray(doc.select)) doc.select.forEach((lint) => lints.add(lint));
  }
  return lints;
}

/** `text` split at its top-level commas, string literals and nested brackets kept whole. */
function topLevelArgs(text) {
  const args = [];
  let depth = 0;
  let from = 0;
  for (let j = 0; j < text.length; j++) {
    const ch = text[j];
    if (ch === '"') {
      for (j++; j < text.length && text[j] !== '"'; j++) if (text[j] === '\\') j++;
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { args.push(text.slice(from, j).trim()); from = j + 1; }
  }
  args.push(text.slice(from).trim());
  return args.filter(Boolean);
}

const LINT = /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$/;

/** The lints an attribute body's `allow` lists name, `cfg_attr` arms included. */
function allowedLints(text) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*$/.exec(text);
  if (!match) return [];
  const [, name, body] = match;
  if (name === 'cfg_attr') return topLevelArgs(body).slice(1).flatMap(allowedLints);
  return name === 'allow' ? topLevelArgs(body).filter((a) => LINT.test(a)) : [];
}

/** Every inner `#![allow]` lint of one Rust file as a suppression, keyed by its lint. */
function innerAllowSites(relPath, src) {
  return lexRust(src).attributes.filter((a) => a.inner).flatMap((a) => allowedLints(a.text)
    .map((lint) => ({ rule: 'suppressions', path: relPath, line: a.line, target: lintTarget(lint) })));
}

export function collect({ root, paths }) {
  refuseLanguageGlobs(root);
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const rust = paths.filter((p) => p.endsWith('.rs')).map((p) => [p, read(p)]);
  const syntax = (p) => AST_GREP_SYNTAX.get(path.posix.extname(p).slice(1).toLowerCase());
  const selected = familySelectedLints(root);
  const toolIds = astGrepToolIds(root);
  return [
    ...paths.filter(syntax).flatMap((p) => syntaxComments(read(p), syntax(p)).flatMap((c) => commentSites(p, c, { js: false, test: false, toolIds }))),
    ...rust.flatMap(([p, src]) => expectSites(p, src)).filter((s) => !selected.has(s.rule)).map(expectSuppression),
    ...rust.flatMap(([p, src]) => innerAllowSites(p, src)),
    ...rust.flatMap(([p, src]) => lexRust(src).comments.flatMap((c) => commentSites(p, c, { js: false, test: false, toolIds }))),
    ...paths.filter((p) => JS.test(p)).flatMap((p) => jsComments(read(p)).flatMap((c) => commentSites(p, c, { js: true, test: TEST_FILE.test(p), toolIds }))),
  ];
}
