// policy/adapters/axe.mjs: axe-core's accessibility violations as name-keyed sites (ADR 0029 Accessibility; 2.1-M214,
// 2.1-M222, 2.1-M225).
//
// Two inputs, chosen by the paths it is given:
// - Every path an .html file (a planted violation, policy/fixtures/rules/axe/): real axe-core, through
//   @axe-core/playwright in Playwright's Chromium from desktop/web, runs over each page; each node of each violation is
//   a site named `planted: <rule>`, a name no family lists, so a planted page fires as an unlisted site.
// - Otherwise (the family's scope, the surface table e2e/support/a11y.ts): the reports e2e/canvas/a11y.spec.ts wrote in
//   each engine, <reports>/<engine>/manifest.json (the table's surface ids) and <reports>/<engine>/<surface>.json
//   ({surface, engine, complete: true, violations: {<rule>: <nodes>}}), with <reports> desktop/web/test-results/a11y, where
//   the CI a11y-policy job downloads each engine's artifact. Each `<surface>: <rule>` is as many sites, with no path, as the most nodes any engine
//   reported for it. A missing engine, a missing or differing manifest, a surface row with no report, or a report that
//   is not a whole report of its surface and engine is refused as tool-failed, never read as clean.
// Recorded output: policy/fixtures/recorded/axe/.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The engines the browser suite runs (2.1-Q84); every one must have reported. */
export const ENGINES = ['chromium', 'webkit', 'firefox'];
export const REPORTS = 'desktop/web/test-results/a11y';
const SURFACE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const fail = (message) => { throw Object.assign(new Error(`axe: ${message}`), { code: 'tool-failed' }); };

function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    fail(`no ${what} at ${file}; run e2e/canvas/a11y.spec.ts in ${ENGINES.join(', ')} first`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${what} at ${file} is not JSON (a partial report)`);
  }
}

/** One engine's surface ids, from its manifest. */
function manifest(dir, engine) {
  const doc = readJson(path.join(dir, engine, 'manifest.json'), `${engine} manifest`);
  if (doc?.engine !== engine || !Array.isArray(doc.surfaces) || !doc.surfaces.length || !doc.surfaces.every((s) => typeof s === 'string' && SURFACE_ID.test(s))) {
    fail(`the ${engine} manifest names no surface ids for ${engine}`);
  }
  return doc.surfaces;
}

/** One surface's {rule: nodes} in one engine, refused unless it is that surface's whole report. */
function surfaceViolations(dir, engine, surface) {
  const file = path.join(dir, engine, `${surface}.json`);
  const doc = readJson(file, `${engine} report of surface ${surface}`);
  const violations = doc?.violations;
  const whole = doc?.surface === surface && doc.engine === engine && doc.complete === true
    && typeof violations === 'object' && violations !== null && !Array.isArray(violations)
    && Object.entries(violations).every(([rule, nodes]) => /^[a-z0-9-]+$/u.test(rule) && Number.isInteger(nodes) && nodes > 0);
  if (!whole) fail(`${file} is not a whole report of surface ${surface} in ${engine} (a partial report)`);
  return violations;
}

/** Sites from the engines' reports under `dir`: per `<surface>: <rule>`, the most nodes any engine reported. */
export function readReports(dir) {
  const manifests = ENGINES.map((engine) => manifest(dir, engine));
  const surfaces = manifests[0];
  ENGINES.forEach((engine, i) => {
    if (JSON.stringify([...manifests[i]].sort()) !== JSON.stringify([...surfaces].sort())) {
      fail(`the ${engine} manifest names other surfaces than the ${ENGINES[0]} one: the engines ran different tables`);
    }
  });
  const most = new Map();
  for (const engine of ENGINES) {
    for (const surface of surfaces) {
      for (const [rule, nodes] of Object.entries(surfaceViolations(dir, engine, surface))) {
        const name = `${surface}: ${rule}`;
        most.set(name, Math.max(most.get(name) ?? 0, nodes));
      }
    }
  }
  return [...most].flatMap(([name, nodes]) => Array.from({ length: nodes }, () => ({ rule: name.slice(name.indexOf(': ') + 2), name })));
}

/** Sites of real axe-core over the given pages, in Playwright's Chromium from desktop/web. */
async function planted(root, pages) {
  const require = createRequire(new URL('../../desktop/web/package.json', import.meta.url));
  let chromium;
  let AxeBuilder;
  try {
    ({ chromium } = require('@playwright/test'));
    AxeBuilder = (await import(pathToFileURL(require.resolve('@axe-core/playwright')).href)).default;
  } catch (error) {
    fail(`cannot load Playwright or @axe-core/playwright from desktop/web: ${error.message}`);
  }
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    fail(`Playwright's Chromium does not launch (npx playwright install chromium): ${error.message.split('\n')[0]}`);
  }
  try {
    const sites = [];
    for (const page of pages) {
      // AxeBuilder opens its own pages in the tab's context, which browser.newPage() does not allow.
      const context = await browser.newContext();
      const tab = await context.newPage();
      await tab.goto(pathToFileURL(path.join(root, page)).href);
      const results = await new AxeBuilder({ page: tab }).analyze();
      for (const violation of results.violations) {
        for (let n = 0; n < violation.nodes.length; n++) sites.push({ rule: violation.id, name: `planted: ${violation.id}` });
      }
      await context.close();
    }
    return sites;
  } finally {
    await browser.close();
  }
}

export async function collect({ root, paths }) {
  if (paths.length && paths.every((p) => p.endsWith('.html'))) return planted(root, paths);
  return readReports(path.join(root, REPORTS));
}
