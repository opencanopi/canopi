import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The cascade 2.0.3 shipped (Vite 6, Rollup), read from a written build: MapLibre's stylesheet, then global.css, then
 * every CSS Module rule, so a module wins each specificity tie with global.css and global.css wins each tie with
 * MapLibre. Rolldown splits the entry's shared dependencies into chunks whose stylesheets Vite links before the entry's;
 * vite.config.ts keeps global.css in a chunk of its own linked first (initialStylesheetOrderPlugin), and this is that
 * rule's gate, chained after each bundle build.
 */
const BUILDS = {
  dist: { page: "index.html", build: "npm run build:desktop:bundle" },
  "dist-web": { page: "web.html", build: "npm run build:web:bundle" },
};
const MAPLIBRE = { label: "MapLibre's stylesheet", needle: ".maplibregl-map" };
// global.css from its first token to its last rule, with the two rules whose ties flipped under Rolldown.
const GLOBAL_ANCHORS = ["--z-canvas-tool-card:", "[role=menuitemradio]:focus-visible", "[inert] *", "[data-design-chrome] *"];
// A CSS Module class: `_<local>_<hash>_<line>`.
const MODULE_RULE = /\._[A-Za-z][\w-]*_[a-z0-9]{5}_\d+/;

/** One message per way the build at `distRoot` (named `dist` or `dist-web`) breaks the cascade; none when it holds. */
export function checkCssCascade(distRoot) {
  const { page, build } = BUILDS[basename(distRoot)] ?? {};
  if (!page) return [`${distRoot} is not a build directory dist or dist-web`];
  if (!existsSync(distRoot)) return [`${distRoot} is missing: run ${build}`];
  const pagePath = resolve(distRoot, page);
  if (!existsSync(pagePath)) return [`${distRoot} has no ${page}: run ${build}`];
  const links = [...readFileSync(pagePath, "utf8").matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((match) => match[1]);
  const sheets = [];
  for (const href of links) {
    const file = resolve(distRoot, href.replace(/^\.?\//, ""));
    // An interrupted build can write the page before its stylesheets: a link to nothing refuses the whole build.
    if (!existsSync(file)) return [`${distRoot} links ${href}, which it does not hold: run ${build}`];
    sheets.push(readFileSync(file, "utf8"));
  }
  return cascadeViolations(`${basename(distRoot)}/${page}`, sheets);
}

/** The findings for one page's initial stylesheets, in link order. */
function cascadeViolations(label, sheets) {
  const first = (needle) => {
    for (const [link, css] of sheets.entries()) {
      const offset = typeof needle === "string" ? css.indexOf(needle) : css.search(needle);
      if (offset >= 0) return [link, offset];
    }
    return undefined;
  };
  const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const missing = [];
  const mapLibre = first(MAPLIBRE.needle);
  if (!mapLibre) missing.push(`${label} links no stylesheet holding ${MAPLIBRE.label} (${MAPLIBRE.needle})`);
  const anchors = GLOBAL_ANCHORS.map((anchor) => [anchor, first(anchor)]);
  for (const [anchor, found] of anchors) if (!found) missing.push(`${label} links no stylesheet holding global.css's ${JSON.stringify(anchor)}`);
  const moduleRule = first(MODULE_RULE);
  if (!moduleRule) missing.push(`${label} links no stylesheet holding a CSS Module rule`);
  if (missing.length > 0) return missing;

  const violations = [];
  for (const [anchor, found] of anchors) {
    if (!before(mapLibre, found)) violations.push(`${label} links global.css's ${JSON.stringify(anchor)} before ${MAPLIBRE.label}`);
    if (!before(found, moduleRule)) violations.push(`${label} links a CSS Module rule before global.css's ${JSON.stringify(anchor)}`);
  }
  if (new Set(anchors.map(([, [link]]) => link)).size > 1) violations.push(`${label} holds global.css in more than one stylesheet`);
  return violations;
}

function isCli() {
  return process.argv[1] !== undefined
    && import.meta.url.startsWith("file:")
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isCli()) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const distRoot = resolve(root, process.argv[2] ?? "dist");
  const violations = checkCssCascade(distRoot);
  if (violations.length > 0) {
    console.error(`${distRoot} breaks the stylesheet cascade (MapLibre, then global.css, then every CSS Module rule):`);
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
}
