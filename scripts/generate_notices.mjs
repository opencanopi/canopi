#!/usr/bin/env node
// Generates THIRD_PARTY_NOTICES.md, the one notices file both editions ship (2.1-Q221, 2.1-M216): Desktop as a Tauri
// resource (desktop/tauri.conf.json, desktop/build.rs), Web and Desktop's page as a build file and the About dialog's
// lazy `?raw` chunk. It merges three inputs:
//   - the npm packages each build bundles, app chunks and workers, which rollup-plugin-license reads from Rolldown's
//     module graph and desktop/web/vite.config.ts writes to desktop/web/node_modules/.canopi-notices/<edition>.json;
//   - the crates the Desktop binary links on its release targets, from cargo-about (about.toml, about.hbs; pinned:
//     `cargo install --locked --version 0.9.3 --features cli cargo-about`), run offline;
//   - the hand rows of scripts/notices-hand-rows.json: copied code, the GeoLibre CLI sidecar, data, fonts, and a
//     licence for a package whose manifest declares none.
// Rows are keyed by name and licence, never by version (2.1-M239): a version bump leaves the file unchanged, a new
// package or a changed licence changes it. Each build refuses to bundle a package the file does not name.
//
//   cd desktop/web && npm run build:desktop:bundle && npm run build:web:bundle && cd ../..
//   node scripts/generate_notices.mjs           # write (a temporary name and a rename; byte-identical on a rerun)
//   node scripts/generate_notices.mjs --check   # CI: fail when the file differs, never write
//   ... --crates <file>                          # cargo-about's about.hbs output, instead of running cargo-about
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const ROW = /^\| `([^`]+)` \| (.+) \|$/gm;

const spdx = (license) => license.replace(/\s+/g, ' ').trim();
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byNameThenLicence = (a, b) => compare(a.name, b.name) || compare(a.license, b.license);

/** One row per name and licence, sorted by code point; a missing licence comes from a clarification. */
function keyed(rows, clarifications, kind) {
  const unique = new Map();
  for (const row of rows) {
    const license = row.license ? spdx(row.license) : clarifications[row.name]?.license;
    if (!license) {
      throw new Error(`The ${kind} ${row.name} declares no licence: read its licence file and add a clarification to scripts/notices-hand-rows.json.`);
    }
    unique.set(`${row.name}\0${license}`, { name: row.name, license });
  }
  for (const name of Object.keys(clarifications)) {
    if (!rows.some((row) => row.name === name)) {
      throw new Error(`scripts/notices-hand-rows.json clarifies the ${kind} ${name}, which is not bundled: delete the clarification.`);
    }
  }
  return [...unique.values()].sort(byNameThenLicence);
}

const table = (header, rows) => [`| ${header} | Licence |`, '|---|---|', ...rows.map((row) => `| \`${row.name}\` | ${row.license} |`)];

/** The whole file, from the hand rows and the bundled npm packages and linked crates. */
export function renderNotices({ handRows, npm, crates }) {
  const lines = [`# ${handRows.title}`, '', ...handRows.intro, ''];
  for (const section of handRows.sections) lines.push(`## ${section.title}`, '', ...section.lines, '');
  lines.push(
    NPM_HEADING, '',
    'Bundled by the Desktop or the Web build, app chunks and workers (rollup-plugin-license over Rolldown\'s module graph).', '',
    ...table('Package', keyed(npm, handRows.clarifications.npm, 'npm package')), '',
    CRATES_HEADING, '',
    'Linked into the Desktop binary on its release targets (cargo-about over `desktop/Cargo.toml`\'s normal dependencies).', '',
    ...table('Crate', keyed(crates, handRows.clarifications.crates, 'crate')),
  );
  return `${lines.join('\n')}\n`;
}

function sectionRows(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return [];
  const end = text.indexOf('\n## ', start + heading.length + 2);
  return [...text.slice(start, end < 0 ? undefined : end).matchAll(ROW)].map(([, name, license]) => ({ name, license }));
}

/** The generated npm and crate rows of a notices file. */
export function parseNotices(text) {
  return { npm: sectionRows(text, NPM_HEADING), crates: sectionRows(text, CRATES_HEADING) };
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

function readBundled() {
  const lockfile = statSync(join(ROOT, 'desktop', 'web', 'package-lock.json')).mtimeMs;
  return EDITIONS.flatMap((edition) => {
    const list = join(BUNDLED_LIST_DIR, `${edition}.json`);
    if (!existsSync(list) || statSync(list).mtimeMs < lockfile) {
      throw new Error(`${list} is missing or older than package-lock.json: run npm run build:desktop:bundle and npm run build:web:bundle in desktop/web first.`);
    }
    return JSON.parse(readFileSync(list, 'utf8'));
  });
}

function readCrates(file) {
  const output = file ? readFileSync(file, 'utf8') : execFileSync(
    'cargo', ['about', 'generate', '--frozen', '-m', 'desktop/Cargo.toml', '-c', 'about.toml', 'about.hbs'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  // Workspace crates (no source) are Canopi itself.
  return JSON.parse(output).filter((crate) => crate.source !== '');
}

function main(argv) {
  const check = argv.includes('--check');
  const cratesAt = argv.indexOf('--crates');
  const text = renderNotices({
    handRows: JSON.parse(readFileSync(HAND_ROWS_PATH, 'utf8')),
    npm: readBundled(),
    crates: readCrates(cratesAt >= 0 ? argv[cratesAt + 1] : undefined),
  });
  if (writeNotices(NOTICES_PATH, text, { check })) {
    console.log(`THIRD_PARTY_NOTICES.md ${check ? 'is up to date' : 'written'}.`);
    return 0;
  }
  const current = readFileSync(NOTICES_PATH, 'utf8').split('\n');
  const expected = text.split('\n');
  const line = expected.findIndex((value, index) => value !== current[index]);
  console.error(`THIRD_PARTY_NOTICES.md is out of date (first difference at line ${line + 1}: expected ${JSON.stringify(expected[line] ?? '')}, found ${JSON.stringify(current[line] ?? '')}).`);
  console.error('Build both editions, then run node scripts/generate_notices.mjs and commit the file.');
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
