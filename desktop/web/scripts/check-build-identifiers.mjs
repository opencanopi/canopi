import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync } from "vite";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scannedExtensions = [".js", ".mjs"];
const NON_ASCII = /[^\x00-\x7f]/;
/** Where vite.config.ts's chunkPackagesPlugin lists each build's chunks: `<edition>.json`. */
export const CHUNK_FACTS_DIR = resolve(root, "node_modules", ".canopi-build");
const NOTICES_PATH = resolve(root, "..", "..", "THIRD_PARTY_NOTICES.md");
const NOTICES_HEADING = "# Third-party notices";
const BUILDS = {
  dist: { edition: "desktop", build: "npm run build:desktop:bundle" },
  "dist-web": { edition: "web", build: "npm run build:web:bundle" },
};
/**
 * The Desktop build's named vendor chunks and the packages with rendered code each held on Vite 6 (Rollup), the
 * dependencies the group pulled in included; chunk count and bytes are not checked (DR5). vite.config.ts names them from
 * build-facts.generated.json.
 */
export const DESKTOP_VENDOR_CHUNKS = {
  "i18n": ["i18next"],
  "maplibre-gl": ["maplibre-gl"],
  "raster-display": [
    "@chunkd/middleware", "@chunkd/source", "@chunkd/source-http", "@chunkd/source-memory", "@cogeotiff/core",
    "@deck.gl/core", "@deck.gl/geo-layers", "@deck.gl/layers", "@deck.gl/mapbox", "@deck.gl/mesh-layers",
    "@developmentseed/affine", "@developmentseed/geotiff", "@developmentseed/lzw-tiff-decoder",
    "@loaders.gl/core", "@loaders.gl/images", "@loaders.gl/loader-utils", "@loaders.gl/schema", "@loaders.gl/worker-utils",
    "@luma.gl/core", "@luma.gl/engine", "@luma.gl/gpgpu", "@luma.gl/shadertools", "@luma.gl/webgl", "@mapbox/tiny-sdf",
    "@math.gl/core", "@math.gl/culling", "@math.gl/polygon", "@math.gl/types", "@math.gl/web-mercator",
    "@probe.gl/env", "@probe.gl/log", "@probe.gl/stats", "earcut", "fzstd", "lerc", "maplibre-gl-raster", "mjolnir.js",
  ],
  "tauri": ["@tauri-apps/api", "@tauri-apps/plugin-dialog"],
};

/**
 * Scans every emitted script of a build (Desktop `dist/`, Web `dist-web/`; workers are files there too) and returns one
 * message per violation of the rule `scriptViolations` states.
 */
export function scanBuildIdentifiers(distRoot) {
  return filesUnder(distRoot)
    .filter((filePath) => scannedExtensions.some((extension) => filePath.toLowerCase().endsWith(extension)))
    .flatMap((filePath) => scriptViolations(relative(distRoot, filePath).split("\\").join("/"), readFileSync(filePath, "utf8")));
}

/**
 * A built script is ASCII-only and names nothing with a non-ASCII identifier, raw or `\u`-escaped: no object key, class
 * member, property access, binding or label. Engines whose Unicode identifier tables predate recent versions
 * (WebKitGTK's, canopi-f47t.52.228.18) reject such a script whole with a SyntaxError, and a worker's error reaches no
 * console. vite.config.ts builds with `output.charset: "ascii"` and quotes the property names Oxc's minifier unquotes
 * (asciiIdentifierKeysPlugin); this is that rule's gate.
 */
export function scriptViolations(name, source) {
  const violations = [];
  const firstNonAscii = source.search(NON_ASCII);
  if (firstNonAscii >= 0) {
    violations.push(`${name} has the non-ASCII character ${describe(String.fromCodePoint(source.codePointAt(firstNonAscii)))} at offset ${firstNonAscii}`);
  }
  // An escaped identifier needs a backslash: a script with neither is ASCII-named without parsing.
  if (firstNonAscii < 0 && !source.includes("\\u")) return violations;
  const { program, errors } = parseSync(name, source, { sourceType: "module" });
  if (errors.length > 0) return [...violations, `${name} does not parse: ${errors[0].message}`];
  for (const identifier of nonAsciiIdentifiers(program)) {
    violations.push(`${name} has the non-ASCII identifier ${describe(identifier)}`);
  }
  return violations;
}

/** Every distinct non-ASCII Identifier or PrivateIdentifier name (escapes decoded) in an ESTree program. */
export function nonAsciiIdentifiers(program) {
  const names = new Set();
  const stack = [program];
  while (stack.length > 0) {
    const node = stack.pop();
    if ((node.type === "Identifier" || node.type === "PrivateIdentifier") && NON_ASCII.test(node.name)) names.add(node.name);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item === "object") stack.push(item);
      } else if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }
  return [...names].sort();
}

/**
 * One message per way the written build at `distRoot` (`dist` or `dist-web`) breaks a chunk rule, read from the chunk
 * list its build wrote: each Desktop vendor chunk holds the packages above, the root THIRD_PARTY_NOTICES.md ships at
 * the build root unchanged (2.1-Q221), and its text lies in one chunk, never the entry (the About dialog loads it
 * lazily). A missing list, or one naming a chunk the build never wrote (an interrupted or older build), refuses it.
 */
export function builtChunkViolations(distRoot, { factsDir = CHUNK_FACTS_DIR, noticesPath = NOTICES_PATH } = {}) {
  const label = basename(distRoot);
  const { edition, build } = BUILDS[label] ?? {};
  if (!edition) return [`${distRoot} is not a build directory dist or dist-web`];
  const factsPath = join(factsDir, `${edition}.json`);
  if (!existsSync(factsPath)) return [`${factsPath} is missing: run ${build}`];
  const { chunks } = JSON.parse(readFileSync(factsPath, "utf8"));
  const unwritten = chunks.find(({ fileName }) => !existsSync(resolve(distRoot, fileName)));
  if (unwritten) return [`${label}: ${unwritten.fileName} is in the chunk list but not written: run ${build}`];

  const violations = [];
  for (const [name, expected] of Object.entries(edition === "desktop" ? DESKTOP_VENDOR_CHUNKS : {})) {
    const held = [...new Set(chunks.filter((chunk) => chunk.name === name).flatMap((chunk) => chunk.packages))].sort();
    if (held.join() !== expected.join()) {
      violations.push(`${label}: the vendor chunk ${name} holds ${held.join(", ") || "nothing"}; it held ${expected.join(", ")}`);
    }
  }
  const shipped = resolve(distRoot, "THIRD_PARTY_NOTICES.md");
  if (!existsSync(shipped)) violations.push(`${label}: THIRD_PARTY_NOTICES.md is not at the build root`);
  else if (readFileSync(shipped, "utf8") !== readFileSync(noticesPath, "utf8")) {
    violations.push(`${label}: THIRD_PARTY_NOTICES.md differs from the root THIRD_PARTY_NOTICES.md`);
  }
  const holders = chunks.filter(({ fileName }) => readFileSync(resolve(distRoot, fileName), "utf8").includes(NOTICES_HEADING));
  if (holders.length !== 1 || holders[0].isEntry) {
    violations.push(`${label}: the notices ship in ${holders.map(({ fileName }) => fileName).join(", ") || "no chunk"}, not in one lazy chunk`);
  }
  return violations;
}

function describe(text) {
  const points = [...text].filter((char) => NON_ASCII.test(char))
    .map((char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
  return `${JSON.stringify(text)} (${points.join(" ")})`;
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(child);
    if (entry.isFile()) return [child];
    return [];
  });
}

function isCli() {
  return process.argv[1] !== undefined
    && import.meta.url.startsWith("file:")
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isCli()) {
  const distRoot = resolve(root, process.argv[2] ?? "dist");
  if (!existsSync(distRoot)) {
    console.error(`Missing build output at ${distRoot}. Run npm run build or npm run build:web first.`);
    process.exit(1);
  }
  const violations = scanBuildIdentifiers(distRoot);
  if (violations.length > 0) {
    console.error(`${distRoot} has scripts that engines with older Unicode identifier tables may reject:`);
    for (const violation of violations) console.error(`- ${violation}`);
  }
  const chunkViolations = builtChunkViolations(distRoot);
  if (chunkViolations.length > 0) {
    console.error(`${distRoot} breaks its vendor chunks or notices:`);
    for (const violation of chunkViolations) console.error(`- ${violation}`);
  }
  if (violations.length + chunkViolations.length > 0) process.exit(1);
}
