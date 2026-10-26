import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const scannedExtensions = new Set([".html", ".js", ".mjs"]);
// The release rules (the Pages limits, raw DuckDB wasm) are scripts/web_release_package.py's, run by
// `web_release.py package`; this check keeps the build's shape.
const forbiddenAssetNamePatterns = [
  // Local raster display is Desktop-only; the Web Edition must not ship its decoders.
  { pattern: /whitebox_wasm_bg.*\.wasm/i, reason: "is a Desktop-only raster decoder" },
  { pattern: /cog_tiler_wasm_bg.*\.wasm/i, reason: "is a Desktop-only raster decoder" },
  // vite.config.ts's Rolldown codeSplitting group (vendorChunk) puts every @tauri-apps module in a chunk named "tauri";
  // web-build-configuration.test.ts pins its packages.
  { pattern: /(^|\/)tauri-[^/]*\.js$/i, reason: "is the Tauri API chunk; the Web entry graph reached @tauri-apps" },
];
// Minified chunks keep runtime globals and plugin command names, not module
// paths; the source-path patterns still catch a build with sourcemaps or
// unminified output.
const forbiddenPatterns = [
  "@tauri-apps",
  "__TAURI__",
  "__TAURI_INTERNALS__",
  "plugin:dialog|",
  "app/shell/bootstrap",
  "app/shell/close-guard",
  "ipc/design",
  "ipc/settings",
  "ipc/species",
  "ipc/favorites",
  "ipc/community",
  "ipc/geocoding",
  "ipc/problem-report",
  "plugin-dialog",
  "maplibre-gl-raster",
  "canopi-raster-display",
];

/**
 * Scans a built Web Edition tree and returns one message per violation:
 * a Desktop-only import, runtime marker or asset.
 */
export function scanWebBuild(distRoot) {
  const violations = [];
  for (const filePath of filesUnder(distRoot)) {
    const relativePath = relative(distRoot, filePath).split("\\").join("/");
    for (const { pattern, reason } of forbiddenAssetNamePatterns) {
      if (pattern.test(relativePath)) violations.push(`${relativePath} ${reason}`);
    }

    if (scannedExtensions.has(extensionOf(filePath))) {
      const source = readFileSync(filePath, "utf8");
      for (const pattern of forbiddenPatterns) {
        if (source.includes(pattern)) violations.push(`${relativePath} contains ${pattern}`);
      }
    }
  }
  return violations;
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(child);
    if (entry.isFile()) return [child];
    return [];
  });
}

function extensionOf(filePath) {
  const name = filePath.toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "";
  return name.slice(dot);
}

function isCli() {
  return process.argv[1] !== undefined
    && import.meta.url.startsWith("file:")
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isCli()) {
  const distRoot = resolve(root, process.argv[2] ?? "dist-web");
  if (!existsSync(distRoot)) {
    console.error(`Missing Web Edition build output at ${distRoot}. Run npm run build:web first.`);
    process.exit(1);
  }
  const violations = scanWebBuild(distRoot);
  if (violations.length > 0) {
    console.error("Web Edition build contains desktop-only imports or runtime markers:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
}
