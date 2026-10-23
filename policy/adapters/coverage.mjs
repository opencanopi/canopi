// policy/adapters/coverage.mjs: the coverage floors the configs enforce (contracts §12; 2.1-M217, 2.1-M222; ADR 0028).
//
// The `coverage` floor family holds, per tool, the floor of each metric and the include and exclusion patterns it is
// measured over. Until F3c makes the configs read policy/ratchets/coverage.json, the configs are the floors' second
// home, so this adapter measures what they enforce and the family refuses a floor lowered below it or a pattern
// added or dropped there:
//   - `vite.config.*` (vitest): `test.coverage.thresholds` {statements, branches, functions, lines}, with its include
//     and exclude, read by loading the config through desktop/web's Vite in test mode, as vitest does;
//   - `config.toml` (cargo-llvm-cov): the `cov` alias's `--fail-under-<metric>` values, its `--ignore-filename-regex`
//     the exclusion.
// Each path it is given is one config; observed is { <tool>: { values, include?, exclude? } }.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WEB = 'desktop/web';
const VITEST_METRICS = ['statements', 'branches', 'functions', 'lines'];

const fail = (message) => { throw Object.assign(new Error(`coverage: ${message}`), { code: 'tool-failed' }); };

/** The vitest floors a Vite config enforces, loaded with desktop/web's Vite as `vitest` loads it. */
async function vitest(root, file) {
  const require = createRequire(path.join(root, WEB, 'package.json'));
  let vite;
  try {
    vite = await import(pathToFileURL(require.resolve('vite')).href);
  } catch (error) {
    fail(`desktop/web's vite cannot be loaded (${error.message}); run npm ci in desktop/web`);
  }
  const absolute = path.join(root, file);
  const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'test' }, absolute, path.dirname(absolute), 'silent');
  const coverage = loaded?.config?.test?.coverage;
  if (!coverage?.thresholds) fail(`${file} sets no test.coverage.thresholds`);
  const values = Object.fromEntries(VITEST_METRICS.filter((m) => m in coverage.thresholds).map((m) => [m, coverage.thresholds[m]]));
  return { values, include: coverage.include ?? [], exclude: coverage.exclude ?? [] };
}

/** A TOML basic string's value: `\\` and `\"` unescaped. */
const tomlString = (text) => text.replace(/\\(["\\])/g, '$1');

/** The cargo-llvm-cov floors the `cov` alias of a cargo config enforces. */
function cargoLlvmCov(root, file) {
  const match = /^\s*cov\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/m.exec(fs.readFileSync(path.join(root, file), 'utf8'));
  if (!match) fail(`${file} has no cov alias`);
  const args = tomlString(match[1]).split(/\s+/);
  const values = {};
  const exclude = [];
  args.forEach((arg, i) => {
    const under = /^--fail-under-([a-z]+)$/.exec(arg);
    if (under) values[under[1]] = Number(args[i + 1]);
    if (arg === '--ignore-filename-regex') exclude.push(args[i + 1]);
  });
  if (!Object.keys(values).length) fail(`${file}'s cov alias sets no --fail-under floor`);
  return { values, exclude };
}

export async function measure({ root, paths }) {
  const observed = {};
  for (const file of paths) {
    const base = path.posix.basename(file);
    const [tool, read] = /^vite\.config\.[cm]?[jt]s$/.test(base) ? ['vitest', vitest]
      : base === 'config.toml' ? ['cargo-llvm-cov', cargoLlvmCov]
        : fail(`${file} is not a coverage config (vite.config.* or .cargo/config.toml)`);
    if (observed[tool]) fail(`two ${tool} configs: ${file} and another`);
    observed[tool] = await read(root, file);
  }
  return observed;
}
