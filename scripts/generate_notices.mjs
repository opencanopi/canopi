#!/usr/bin/env node
// Generates THIRD_PARTY_NOTICES.md, the one notices file both editions ship (2.1-Q221, 2.1-M216): Desktop as a Tauri
// resource (desktop/tauri.conf.json, desktop/build.rs), Web and Desktop's page as a build file and the About dialog's
// lazy `?raw` chunk. It merges three inputs:
//   - the npm packages each build bundles, app chunks and workers, which rollup-plugin-license reads from Rolldown's
//     module graph and desktop/web/vite.config.ts writes to desktop/web/node_modules/.canopi-notices/<edition>.json,
//     with the licence and notice files of their installed copies (package-lock.json names the copies);
//   - the crates the Desktop binary links on its release targets, with the licence texts in their sources, from
//     cargo-about (about.toml, about.hbs), the version CARGO_ABOUT_VERSION pins, run offline;
//   - the hand rows of scripts/notices-hand-rows.json: copied code, the GeoLibre CLI sidecar, data, fonts, and a
//     licence or licence text for a package or crate whose manifest or files carry none (cargo-about's fallback SPDX
//     template, whose placeholders stand where the copyright line belongs, is refused).
// Each row names its licence texts by id; a text is written once, however many rows share it (whitespace aside), as
// MIT, BSD, ISC and Apache binary copies need the text and its copyright line (2.1-Q221). Rows are keyed by name and
// licence, never by version (2.1-M239): a version bump leaves the file unchanged unless it changes a licence text, a
// new package or a changed licence changes it. Each build refuses to bundle a package the file does not name.
//
// The generator builds both editions itself (npm run build:<edition>:bundle), so one command is the whole lane:
//   cd desktop/web && npm run generate:notices   # write (a temporary name and a rename; byte-identical on a rerun)
//   cd desktop/web && npm run check:notices      # fail when the file differs, never write; CI's notices job runs it
//   ... -- --crates <file>                         # cargo-about's about.hbs output, instead of running cargo-about
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NOTICES_PATH = join(ROOT, 'THIRD_PARTY_NOTICES.md');
export const HAND_ROWS_PATH = join(ROOT, 'scripts', 'notices-hand-rows.json');
/** Where each Vite build writes the npm packages it bundled. */
export const BUNDLED_LIST_DIR = join(ROOT, 'desktop', 'web', 'node_modules', '.canopi-notices');
const EDITIONS = ['desktop', 'web'];
const NPM_HEADING = '## npm packages in the app bundle';
const CRATES_HEADING = '## Rust crates in the Desktop binary';
const TEXTS_HEADING = '## Licence texts';
const ROW = /^\| `([^`]+)` \| (.+) \| ([0-9a-f]{8}(?:, [0-9a-f]{8})*) \|$/gm;
const TEXT = /^### ([0-9a-f]{8})\n\n(`{3,})\n([\s\S]*?)\n\2$/gm;
/** A package's licence and notice files; `LICENSE.spdx` holds only the SPDX expression the row already names. */
const LICENCE_FILE = /^(?:(?:un)?licen[cs]e|copying|notice)(?:$|[-._])/i;

/** The cargo-about CI installs (build.yml's notices job); another version's crate table differs. */
export const CARGO_ABOUT_VERSION = '0.9.3';

/** Why `cargo about --version` output is not the pinned tool, or null when it is. */
export function cargoAboutVersionProblem(versionOutput) {
  const found = versionOutput.trim();
  if (found === `cargo-about ${CARGO_ABOUT_VERSION}`) return null;
  return `The notices need cargo-about ${CARGO_ABOUT_VERSION}, found "${found}": cargo install --locked --version ${CARGO_ABOUT_VERSION} --features cli cargo-about`;
}

const spdx = (license) => license.replace(/\s+/g, ' ').trim();
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byNameThenLicence = (a, b) => compare(a.name, b.name) || compare(a.license, b.license);

/**
 * A copyright line still holding an SPDX template's placeholder, as cargo-about's fallback text keeps it. A GNU
 * licence's "How to Apply These Terms" appendix shows such a line as a sample for the reader's own work, so the
 * text is read only up to that heading.
 */
const PLACEHOLDER_LINE = /^\s*Copyright\b.*<(?:year|owner|copyright holders)>/im;
const templated = (text) => PLACEHOLDER_LINE.test(text.split(/^\s*How to Apply These Terms/im)[0]);

/** A licence text with LF line ends, no trailing spaces and no blank lines around it. */
function normalised(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n').map((line) => line.trimEnd());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  return `${lines.join('\n')}\n`;
}

/** Texts differing only in whitespace (line wrapping, CRLF) are one text, under one id. */
const sameness = (text) => text.replace(/\s+/g, ' ').trim();
const textId = (text) => createHash('sha256').update(sameness(text)).digest('hex').slice(0, 8);

/** One row per name and licence, sorted by code point; a missing licence comes from a clarification. */
function keyed(rows, clarifications, kind, texts) {
  const unique = new Map();
  for (const row of rows) {
    const license = row.license ? spdx(row.license) : clarifications[row.name]?.license;
    if (!license) {
      throw new Error(`The ${kind} ${row.name} declares no licence: read its licence file and add a clarification to scripts/notices-hand-rows.json.`);
    }
    if (!row.texts?.length) {
      throw new Error(`The ${kind} ${row.name} has no licence text: add its upstream licence text as a clarification to scripts/notices-hand-rows.json.`);
    }
    if (row.texts.some(templated)) {
      throw new Error(`The ${kind} ${row.name} has a licence text with an SPDX template placeholder instead of its copyright line: add its upstream licence text as a clarification text to scripts/notices-hand-rows.json.`);
    }
    const key = `${row.name}\0${license}`;
    const entry = unique.get(key) ?? { name: row.name, license, ids: new Set() };
    for (const text of row.texts) entry.ids.add(texts.add(text));
    unique.set(key, entry);
  }
  for (const name of Object.keys(clarifications)) {
    if (!rows.some((row) => row.name === name)) {
      throw new Error(`scripts/notices-hand-rows.json clarifies the ${kind} ${name}, which is not bundled: delete the clarification.`);
    }
  }
  return [...unique.values()].sort(byNameThenLicence);
}

/** The licence texts the rows name, each once: the shortest of its whitespace variants (then the code-point least). */
function textStore() {
  const byId = new Map();
  return {
    add(text) {
      const body = normalised(text);
      const id = textId(body);
      const held = byId.get(id);
      if (held && sameness(held) !== sameness(body)) throw new Error(`Two licence texts share the id ${id}: lengthen textId.`);
      if (!held || body.length < held.length || (body.length === held.length && compare(body, held) < 0)) byId.set(id, body);
      return id;
    },
    lines() {
      return [...byId].sort(([a], [b]) => compare(a, b)).flatMap(([id, body]) => {
        const fence = '`'.repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map(([run]) => run.length + 1)));
        return [`### ${id}`, '', fence, body.slice(0, -1), fence, ''];
      });
    },
  };
}

const table = (header, rows) => [
  `| ${header} | Licence | Licence texts |`, '|---|---|---|',
  ...rows.map((row) => `| \`${row.name}\` | ${row.license} | ${[...row.ids].sort(compare).join(', ')} |`),
];

/** The whole file, from the hand rows and the bundled npm packages and linked crates. */
export function renderNotices({ handRows, npm, crates }) {
  const texts = textStore();
  const lines = [`# ${handRows.title}`, '', ...handRows.intro, ''];
  for (const section of handRows.sections) lines.push(`## ${section.title}`, '', ...section.lines, '');
  lines.push(
    NPM_HEADING, '',
    'Bundled by the Desktop or the Web build, app chunks and workers (rollup-plugin-license over Rolldown\'s module graph). Each row names its licence and notice texts, written once each under Licence texts.', '',
    ...table('Package', keyed(npm, handRows.clarifications.npm, 'npm package', texts)), '',
    CRATES_HEADING, '',
    'Linked into the Desktop binary on its release targets (cargo-about over `desktop/Cargo.toml`\'s normal dependencies), with the licence texts in each crate\'s source.', '',
    ...table('Crate', keyed(crates, handRows.clarifications.crates, 'crate', texts)), '',
    TEXTS_HEADING, '',
    'Each licence and notice text above, with its copyright lines, once however many packages carry it.', '',
    ...texts.lines(),
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

function sectionRows(text, heading, texts) {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return [];
  const end = text.indexOf('\n## ', start + heading.length + 2);
  return [...text.slice(start, end < 0 ? undefined : end).matchAll(ROW)]
    .map(([, name, license, ids]) => ({ name, license, texts: ids.split(', ').map((id) => texts.get(id)).filter(Boolean) }));
}

/** The generated npm and crate rows of a notices file, each with its licence texts. */
export function parseNotices(text) {
  const lf = text.replaceAll('\r\n', '\n');
  const start = lf.indexOf(`\n${TEXTS_HEADING}\n`);
  const texts = new Map(start < 0 ? [] : [...lf.slice(start).matchAll(TEXT)].map(([, id, , body]) => [id, `${body}\n`]));
  return { npm: sectionRows(lf, NPM_HEADING, texts), crates: sectionRows(lf, CRATES_HEADING, texts) };
}

/**
 * Each npm row with the licence and notice files of every installed copy package-lock.json names (all copies, so
 * a nested copy's text is never missed), or its clarification's hand text when the package ships none.
 */
export function npmLicenceTexts({ webDir, rows, clarifications }) {
  const { packages } = JSON.parse(readFileSync(join(webDir, 'package-lock.json'), 'utf8'));
  return rows.map((row) => {
    const copies = Object.keys(packages).filter((path) => (path === `node_modules/${row.name}` || path.endsWith(`/node_modules/${row.name}`)) && !packages[path].dev);
    const files = copies.map((path) => join(webDir, path)).filter((dir) => existsSync(dir)).flatMap((dir) => readdirSync(dir)
      .filter((file) => LICENCE_FILE.test(file) && !file.endsWith('.spdx') && statSync(join(dir, file)).isFile())
      .sort(compare).map((file) => normalised(readFileSync(join(dir, file), 'utf8'))));
    const hand = clarifications[row.name]?.text;
    if (files.length && hand) {
      throw new Error(`The npm package ${row.name} ships its own licence file now: delete its clarification text in scripts/notices-hand-rows.json.`);
    }
    if (!files.length && !hand) {
      throw new Error(`The npm package ${row.name} ships no licence file: add its upstream licence text, with the copyright line, as a clarification text in scripts/notices-hand-rows.json.`);
    }
    return { ...row, texts: files.length ? [...new Set(files)] : [normalised(hand.join('\n'))] };
  });
}

/** The linked crates and their licence texts from about.hbs's output; workspace crates (no source) are Canopi. */
export function cratesFromAbout(output) {
  const { crates, licenses } = JSON.parse(output);
  return crates.filter((crate) => crate.source).map(({ name, license }) => ({
    name, license,
    texts: licenses.filter((text) => text.used_by.some((user) => user.name === name && user.source)).map((text) => normalised(text.text)),
  }));
}

/**
 * Each crate with its clarification's hand text in place of the SPDX templates cargo-about falls back to when it finds
 * no licence file it matches in the crate's source. A clarification names a crate, not a version, so it goes stale (and
 * is refused) only once cargo-about finds a licence file for every linked version of that crate.
 */
export function crateTexts(rows, clarifications) {
  const needsHand = (row) => (row.texts ?? []).some(templated);
  return rows.map((row) => {
    const hand = clarifications[row.name]?.text;
    if (!hand) return row;
    if (!needsHand(row)) {
      if (rows.some((other) => other.name === row.name && needsHand(other))) return row;
      throw new Error(`The crate ${row.name} ships its own licence text now: delete its clarification text in scripts/notices-hand-rows.json.`);
    }
    const found = row.texts.filter((text) => !templated(text));
    return { ...row, texts: [...found, normalised(hand.join('\n'))] };
  });
}

/** Each bundled package the file does not name with its licence, as `name (licence)`. */
export function missingFromNotices(text, bundled) {
  const rows = parseNotices(text).npm;
  const missing = bundled.filter(({ name, license }) => !rows.some((row) => row.name === name && (!license || row.license === spdx(license))));
  return [...new Set(missing.map(({ name, license }) => `${name} (${license ?? 'no licence'})`))].sort(compare);
}

/** Writes `text` through a temporary name and a rename, or with `check` compares only. True when the file holds it. */
export function writeNotices(target, text, { check }) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (check || current === text) return current === text;
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}

/**
 * Runs each edition's build and reads the npm packages it wrote to `dir`. A build refusing a package the file does not
 * name has written its list already, so its exit status is not read; a list it did not write this run never is.
 */
export function bundledPackages({ dir, run }) {
  return EDITIONS.flatMap((edition) => {
    const list = join(dir, `${edition}.json`);
    rmSync(list, { force: true });
    run(edition);
    if (!existsSync(list)) {
      throw new Error(`${list} was not written: the ${edition} build stopped before its bundle (its output is above).`);
    }
    return JSON.parse(readFileSync(list, 'utf8'));
  });
}

function buildEdition(edition) {
  // A constant command line; the shell finds npm.cmd on Windows.
  spawnSync(`npm run build:${edition}:bundle`, { cwd: join(ROOT, 'desktop', 'web'), shell: true, stdio: 'inherit' });
}

function readCrates(file) {
  if (!file) {
    const problem = cargoAboutVersionProblem(execFileSync('cargo', ['about', '--version'], { cwd: ROOT, encoding: 'utf8' }));
    if (problem) throw new Error(problem);
  }
  const output = file ? readFileSync(file, 'utf8') : execFileSync(
    'cargo', ['about', 'generate', '--frozen', '-m', 'desktop/Cargo.toml', '-c', 'about.toml', 'about.hbs'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return cratesFromAbout(output);
}

function main(argv) {
  const check = argv.includes('--check');
  const cratesAt = argv.indexOf('--crates');
  // Crates first: a wrong cargo-about fails before the two edition builds, not after them.
  const handRows = JSON.parse(readFileSync(HAND_ROWS_PATH, 'utf8'));
  const crates = crateTexts(readCrates(cratesAt >= 0 ? argv[cratesAt + 1] : undefined), handRows.clarifications.crates);
  const npm = npmLicenceTexts({
    webDir: join(ROOT, 'desktop', 'web'),
    rows: bundledPackages({ dir: BUNDLED_LIST_DIR, run: buildEdition }),
    clarifications: handRows.clarifications.npm,
  });
  const text = renderNotices({ handRows, npm, crates });
  if (writeNotices(NOTICES_PATH, text, { check })) {
    console.log(`THIRD_PARTY_NOTICES.md ${check ? 'is up to date' : 'written'}.`);
    return 0;
  }
  const current = readFileSync(NOTICES_PATH, 'utf8').split('\n');
  const expected = text.split('\n');
  const line = expected.findIndex((value, index) => value !== current[index]);
  console.error(`THIRD_PARTY_NOTICES.md is out of date (first difference at line ${line + 1}: expected ${JSON.stringify(expected[line] ?? '')}, found ${JSON.stringify(current[line] ?? '')}).`);
  console.error('Run npm run generate:notices in desktop/web and commit the file.');
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
