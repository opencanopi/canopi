import { defineConfig, normalizePath, parseSync, rolldownVersion, transformWithOxc, version as viteVersion, type Plugin } from "vite";
import { configDefaults } from "vitest/config";
import preact from "@preact/preset-vite";
import license from "rollup-plugin-license";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { resolveWebEditionDevHtmlUrl } from "./src/web/dev-entry";
import { admitWebCatalogManifest } from "./src/generated/web-catalog-artifact.mjs";

const tauriConfigPath = fileURLToPath(new URL('../tauri.conf.json', import.meta.url));
// The generated Web plant catalog (`npm run generate:web-catalog`, git-ignored); a test may point elsewhere.
const WEB_CATALOG_INPUT_ENV = "CANOPI_WEB_CATALOG_INPUT";
// Web files are named `<name>-<16-character hash>.<ext>`, so scripts/web_release.py can tell a hashed name from a
// word such as `NotoSans-SemiBold.ttf`, which Vite's default 8 characters would admit (2.1-M176).
const WEB_HASHED_NAMES = {
  entryFileNames: "assets/[name]-[hash:16].js",
  chunkFileNames: "assets/[name]-[hash:16].js",
  assetFileNames: "assets/[name]-[hash:16][extname]",
} as const;
// Every emitted script, workers included, is ASCII, as esbuild's were before Vite 8: Rolldown escapes non-ASCII text, and
// asciiIdentifierKeysPlugin quotes the property names Oxc's minifier unquoted (canopi-f47t.52.228.18).
const ASCII_OUTPUT = { charset: "ascii" } as const;
const DEFAULT_WEB_CATALOG_INPUT = fileURLToPath(new URL('./catalog-input/', import.meta.url));
// The PDF fonts' one script (plain JavaScript, run by node too): imported by URL, typed here.
const { pdfFontsPlugin } = (await import(new URL("./scripts/prepare-pdf-fonts.mjs", import.meta.url).href)) as { pdfFontsPlugin(): Plugin };
// The notices generator's paths and its build check (scripts/generate_notices.mjs, run by node), typed here.
const notices = (await import(new URL("../../scripts/generate_notices.mjs", import.meta.url).href)) as {
  NOTICES_PATH: string;
  BUNDLED_LIST_DIR: string;
  missingFromNotices(text: string, bundled: readonly BundledPackage[]): string[];
};

export default defineConfig(({ mode }) => {
  const isWebEdition = mode === 'web';
  const platformAdapter = fileURLToPath(new URL(
    isWebEdition ? './src/platform/browser.ts' : './src/platform/desktop.ts',
    import.meta.url,
  ));
  const speciesCatalogLiveAdapter = fileURLToPath(new URL(
    isWebEdition
      ? './src/app/plant-browser/live.browser.ts'
      : './src/app/plant-browser/live.desktop.ts',
    import.meta.url,
  ));
  // Only the Web build reads the generated catalog: a stale one never breaks Desktop, dev or tests (review F1).
  const webCatalog = isWebEdition ? readWebCatalog(process.env[WEB_CATALOG_INPUT_ENV] ?? DEFAULT_WEB_CATALOG_INPUT) : null;
  const thirdPartyNotices = thirdPartyNoticesPlugins(isWebEdition ? "web" : "desktop");
  return {
    cacheDir: isWebEdition ? "node_modules/.vite-web" : "node_modules/.vite-desktop",
    plugins: [
      preact(),
      pdfFontsPlugin(),
      webEditionDevEntryPlugin(isWebEdition),
      webCatalogPlugin(webCatalog),
      mapLibreSourceClassFieldsPlugin(),
      initialStylesheetOrderPlugin(),
      asciiIdentifierKeysPlugin(),
      ...thirdPartyNotices.app,
    ],
    // Both editions are served at the root: web.projectcanopi.com and the Tauri asset protocol (2.1-Q85, 2.1-M66).
    base: "/",
    // Nothing tracked lives in public/; a checkout's leftover public/canopi-catalog/ or public/pdf-fonts/ (before 2.0.3)
    // must never reach a build (2.1-M176).
    publicDir: false,
    // The catalog directory, relative to the base: read by src/web/duckdb-wasm-catalog.ts.
    define: { __CANOPI_WEB_CATALOG_PATH__: JSON.stringify(webCatalog?.path ?? "assets/catalog/none/") },
    resolve: {
      alias: {
        '#platform': platformAdapter,
        '#canvas-pdf-platform': fileURLToPath(new URL(isWebEdition ? './src/app/canvas-pdf/platform.browser.ts' : './src/app/canvas-pdf/platform.desktop.ts', import.meta.url)),
        '#budget-export-platform': fileURLToPath(new URL(isWebEdition ? './src/app/budget/platform.browser.ts' : './src/app/budget/platform.desktop.ts', import.meta.url)),
        '#geocoding-transport': fileURLToPath(new URL(isWebEdition ? './src/app/geocoding/transport.browser.ts' : './src/app/geocoding/transport.desktop.ts', import.meta.url)),
        '#species-catalog-live': speciesCatalogLiveAdapter,
      },
    },
    optimizeDeps: {
      // The WASM decoder packages resolve their .wasm files relative to their
      // own module URL; pre-bundling would move them away from those files.
      exclude: ['cog-tiler-wasm', 'whitebox-wasm'],
      // Lazily imported by the PDF export; discovering them at runtime makes Vite
      // re-optimize and reload the page mid-session.
      include: ['pdfkit', 'fontkit'],
      rolldownOptions: { transform: { target: 'es2022' } },
    },
    worker: {
      // The raster decode lane imports geotiff codecs dynamically.
      format: 'es' as const,
      // Worker bundles run only these plugins, not the app's.
      plugins: () => [asciiIdentifierKeysPlugin(), thirdPartyNotices.worker()],
      rolldownOptions: { output: { ...ASCII_OUTPUT, ...(isWebEdition ? WEB_HASHED_NAMES : {}) } },
    },
    server: {
      port: isWebEdition ? 1421 : 1420,
      strictPort: true,
      fs: {
        allow: [
          fileURLToPath(new URL('.', import.meta.url)),
          tauriConfigPath,
          `${tauriConfigPath}?raw`,
          // The About dialog's notices view imports the root file `?raw`.
          notices.NOTICES_PATH,
        ],
      },
    },
    build: {
      target: 'es2022',
      outDir: isWebEdition ? "dist-web" : "dist",
      emptyOutDir: true,
      rolldownOptions: {
        input: isWebEdition ? "web.html" : "index.html",
        output: {
          ...ASCII_OUTPUT,
          ...(isWebEdition ? WEB_HASHED_NAMES : {}),
          // global.css alone, so initialStylesheetOrderPlugin can link it before every CSS Module (css-cascade-order.test.ts);
          // then the four named vendor chunks, whose packages web-build-configuration.test.ts pins.
          codeSplitting: { groups: [{ name: GLOBAL_STYLES_CHUNK, test: GLOBAL_STYLESHEET }, { name: vendorChunk }] },
        },
      },
    },
    test: {
      // Plain Node by default: jsdom's setup cost more than the tests it served (576 s of worker time per run,
      // 2026-10-16). A test file that needs the DOM starts with `// @vitest-environment jsdom`; without it,
      // `document` and `window` are undefined and the file fails, so no test passes without the page it needs.
      environment: "node",
      // Preact 11 after-paint work runs inside the test that scheduled it (support/preact-after-paint.ts).
      setupFiles: ["./src/__tests__/support/preact-after-paint.ts"],
      // The pinned PDF fonts, verified (and fetched when missing) once per run: bare `npx vitest run` needs no npm hook.
      globalSetup: ["./scripts/prepare-pdf-fonts.mjs"],
      // Test-only: MapLibre's TypeScript sources, for tests that run MapLibre's own code (view/camera-contract.test.ts,
      // maplibre/camera-driver.test.ts, maplibre/workspace-map.test.ts, __tests__/openfreemap-basemap.test.ts). Builds
      // never resolve it.
      alias: { 'maplibre-gl-source': fileURLToPath(new URL('./node_modules/maplibre-gl/src', import.meta.url)) },
      // Playwright specs (e2e/, e2e-release/) run under Playwright's own runner; its `test()` throws in vitest.
      exclude: [...configDefaults.exclude, "e2e/**", "e2e-release/**"],
      // An unhandled error or rejection fails the run even when every test passes.
      dangerouslyIgnoreUnhandledErrors: false,
      coverage: {
        provider: "v8",
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/**/*.test.{ts,tsx}", "src/__tests__/**", "src/generated/**"],
        reporter: ["text-summary", "json-summary"],
        // Ratchet: the floor is the measured baseline; raise it, never lower it.
        thresholds: { statements: 92.0, branches: 85.4, functions: 92.9, lines: 94.8 },
      },
    },
  };
});

interface BundledPackage {
  readonly name: string;
  readonly license: string | null;
}

/**
 * The notices file in both editions (2.1-Q221, 2.1-M239): rollup-plugin-license reads the packages of every app chunk
 * and, through `worker`, of every worker bundle from Rolldown's module graph. After the bundle, the list goes to
 * node_modules/.canopi-notices/<edition>.json for scripts/generate_notices.mjs, the build fails when the root
 * THIRD_PARTY_NOTICES.md does not name a bundled package with its licence, and the file ships in the build's root.
 */
function thirdPartyNoticesPlugins(edition: "desktop" | "web"): { app: Plugin[]; worker: () => Plugin } {
  const bundled = new Map<string, BundledPackage>();
  const collect = (): Plugin => ({
    ...(license({
      thirdParty: (dependencies) => {
        for (const { name, license } of dependencies) {
          if (name) bundled.set(`${name}\0${license ?? ""}`, { name, license: license ?? null });
        }
      },
    }) as Plugin),
    apply: "build",
  });
  const ship: Plugin = {
    name: "canopi-third-party-notices",
    apply: "build",
    generateBundle: {
      order: "post",
      handler() {
        const list = [...bundled.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        mkdirSync(notices.BUNDLED_LIST_DIR, { recursive: true });
        writeFileSync(join(notices.BUNDLED_LIST_DIR, `${edition}.json`), `${JSON.stringify(list, null, 1)}\n`);
        const text = readFileSync(notices.NOTICES_PATH, "utf8");
        const missing = notices.missingFromNotices(text, list);
        if (missing.length > 0) {
          this.error(`THIRD_PARTY_NOTICES.md does not name ${missing.join(", ")}, bundled by this ${edition} build: run node scripts/generate_notices.mjs at the repository root and commit the file.`);
        }
        this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.md", source: text });
      },
    },
  };
  return { app: [collect(), ship], worker: collect };
}

// Forward slashes, as Vite's module ids are on every platform (fileURLToPath gives backslashes on Windows).
const MAPLIBRE_SOURCE_DIR = normalizePath(fileURLToPath(new URL('./node_modules/maplibre-gl/src/', import.meta.url)));

/**
 * Test-only, for the `maplibre-gl-source` alias: MapLibre's sources are written for TypeScript's legacy class fields
 * (`useDefineForClassFields: false`, which esbuild assumed for a file with no tsconfig). Oxc, Vite 8's transform, finds
 * no tsconfig in the package and keeps a subclass's bare field declarations, which reset what the base constructor set
 * (`_transitioningPaint` undefined in FillStyleLayer). Removing the initializer-less fields restores MapLibre's own
 * semantics for those files only; app code keeps the tsconfig's define semantics.
 */
function mapLibreSourceClassFieldsPlugin(): Plugin {
  return {
    name: "canopi-maplibre-source-class-fields",
    enforce: "pre",
    apply: (_config, { mode }) => mode === "test",
    async transform(code, id) {
      const file = normalizePath(id.replace(/\?.*$/, ""));
      if (!file.startsWith(MAPLIBRE_SOURCE_DIR) || !file.endsWith(".ts")) return null;
      const result = await transformWithOxc(code, file, { typescript: { removeClassFieldsWithoutInitializer: true } });
      return { code: result.code, map: result.map };
    },
  };
}

/**
 * Quotes every non-ASCII property name in a built chunk: object and class keys become string keys, `a.\u088F` becomes
 * `a["\u088F"]`. Oxc's minifier turns a quoted key such as "\u088f" (geotiff-geokeys-to-proj4's table) into a bare
 * identifier, `output.charset: "ascii"` only escapes it, and engines whose Unicode identifier tables are older reject
 * the whole script: WebKitGTK (Desktop on Linux) refused the raster display worker and no GeoTIFF drew
 * (canopi-f47t.52.228.18). No Oxc option keeps such keys quoted, and minification follows renderChunk, so the rewrite
 * runs on the minified chunk in generateBundle. Rolldown hashes a chunk's name before that hook, so the hash folds in this
 * config's source and the Vite and Rolldown versions: changing the rewrite renames every chunk, and a Web name never changes bytes under a long cache.
 * scripts/check-build-identifiers.mjs gates every build, so a non-ASCII binding or label this cannot quote fails there.
 */
function asciiIdentifierKeysPlugin(): Plugin {
  return {
    name: "canopi-ascii-identifier-keys",
    apply: "build",
    augmentChunkHash: () => ASCII_KEYS_REWRITE_ID,
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        for (const file of Object.values(bundle)) {
          if (file.type !== "chunk") continue;
          const code = quoteNonAsciiPropertyNames(file.fileName, file.code);
          if (code === file.code) continue;
          // The rewrite shifts columns: a source map would need composing first (builds emit none).
          if (file.map) this.error(`${file.fileName} has a source map that quoting its non-ASCII property names would break.`);
          file.code = code;
        }
      },
    },
  };
}

const NON_ASCII = /[^\x00-\x7f]/;
// The salt is this whole config file and the Vite and Rolldown versions (their parser and minifier shape the rewrite's
// input): any change that could change the rewrite's output renames every chunk.
const ASCII_KEYS_REWRITE_ID = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(`${viteVersion} ${rolldownVersion}`)
  .digest("hex")
  .slice(0, 16);
type EstreeNode = { type: string; start: number; end: number; [key: string]: unknown };

function quoteNonAsciiPropertyNames(fileName: string, code: string): string {
  if (!NON_ASCII.test(code) && !code.includes("\\u")) return code;
  const { program, errors } = parseSync(fileName, code, { sourceType: "module" });
  if (errors.length > 0) throw new Error(`${fileName} does not parse after minification: ${errors[0]!.message}`);
  const edits: { start: number; end: number; text: string }[] = [];
  const nonAscii = (node: unknown): node is EstreeNode =>
    (node as EstreeNode | null)?.type === "Identifier" && NON_ASCII.test((node as unknown as { name: string }).name);
  // The identifier's own text, raw or escaped, means the same name inside a string literal.
  const quoted = (node: EstreeNode) => `"${code.slice(node.start, node.end)}"`;
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const node = stack.pop() as EstreeNode;
    const key = node.key;
    if (node.computed === false && nonAscii(key) && (
      (node.type === "Property" && node.shorthand === false)
      || node.type === "MethodDefinition" || node.type === "PropertyDefinition" || node.type === "AccessorProperty"
    )) {
      edits.push({ start: key.start, end: key.end, text: quoted(key) });
    }
    const property = node.property;
    if (node.type === "MemberExpression" && node.computed === false && nonAscii(property)) {
      // Minified output has nothing between the dot (or `?.`) and the name.
      const dot = property.start - (node.optional ? 2 : 1);
      if (code.slice(dot, property.start) !== (node.optional ? "?." : ".")) {
        throw new Error(`${fileName}: no dot before the property name at offset ${property.start}.`);
      }
      edits.push({ start: dot, end: property.end, text: `${node.optional ? "?." : ""}[${quoted(property)}]` });
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item === "object") stack.push(item);
      } else if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let result = code;
  for (const edit of edits) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

const GLOBAL_STYLES_CHUNK = "global-styles";
const GLOBAL_STYLESHEET = /[\\/]src[\\/]styles[\\/]global\.css$/;
/** The page's first stylesheets, by chunk name, in cascade order; every other initial stylesheet follows them. */
const INITIAL_STYLESHEET_CHUNKS = ["maplibre-gl", GLOBAL_STYLES_CHUNK] as const;

/**
 * Builds link the page's stylesheets as 2.0.3 did: MapLibre's, then global.css, then every CSS Module's, so a module wins
 * each specificity tie with global.css and global.css each tie with MapLibre. Vite links the CSS of the chunks the
 * entry imports, in Rolldown's import order, before the entry's own; Rolldown splits the entry's shared dependencies
 * into chunks (whose modules' CSS would then precede global.css) and orders the imports itself, so the order is set
 * here, after Vite writes the page, whatever the chunks are. Cascade layers would instead change every tie that
 * specificity decides today. Lazy chunks' stylesheets load later at runtime, as before.
 */
function initialStylesheetOrderPlugin(): Plugin {
  return {
    name: "canopi-initial-stylesheet-order",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, { bundle }) {
        if (!bundle) return html;
        const firstFiles = INITIAL_STYLESHEET_CHUNKS.map((chunk) => {
          const asset = Object.values(bundle).find((file) => file.type === "asset" && file.names.includes(`${chunk}.css`));
          if (!asset) throw new Error(`No ${chunk}.css stylesheet in the build: the page's cascade order cannot be kept.`);
          return asset.fileName;
        });
        const links = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)];
        const rank = (href: string) => {
          const index = firstFiles.findIndex((file) => href.endsWith(`/${file}`));
          return index < 0 ? firstFiles.length : index;
        };
        for (const file of firstFiles) {
          if (!links.some((link) => link[1]!.endsWith(`/${file}`))) throw new Error(`The page does not link ${file}.`);
        }
        // Stable: the module stylesheets keep Vite's order after the first ones.
        const ordered = [...links].sort((a, b) => rank(a[1]!) - rank(b[1]!));
        let next = 0;
        return html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, () => ordered[next++]![0]);
      },
    },
  };
}

/**
 * The named chunk of a node_modules module, first match wins (F1a generates these from policy/layers.json). One group
 * whose name is this function: a module's dependencies join its chunk unless they name their own, as on Rollup.
 */
function vendorChunk(id: string): string | null {
  if (!id.includes("node_modules")) return null;
  if (id.includes("maplibre-gl-raster") || id.includes("@deck.gl") || id.includes("@luma.gl") || id.includes("@developmentseed") || id.includes("@math.gl") || id.includes("@loaders.gl")) return "raster-display";
  if (id.includes("maplibre-gl")) return "maplibre-gl";
  if (id.includes("@tauri-apps")) return "tauri";
  if (id.includes("i18next")) return "i18n";
  return null;
}

function webEditionDevEntryPlugin(enabled: boolean): Plugin {
  return {
    name: "canopi-web-edition-dev-entry",
    apply: "serve",
    configureServer(server) {
      if (!enabled) return;

      server.middlewares.use((request, _response, next) => {
        const webEntryUrl = resolveWebEditionDevHtmlUrl(request.url);
        if (webEntryUrl) request.url = webEntryUrl;
        next();
      });
    },
  };
}

interface WebCatalog {
  /** `assets/catalog/<first 16 hex of the manifest's SHA-256>/` (2.1-M176). */
  readonly path: string;
  readonly root: string;
  readonly files: readonly string[];
}

function readWebCatalog(root: string): WebCatalog | null {
  const manifest = join(root, "manifest.json");
  if (!existsSync(manifest)) return null;
  const bytes = readFileSync(manifest);
  const id = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  // Only what the admitted manifest lists: leftovers of an earlier generation never reach a build (review S10).
  let listed: string[];
  try {
    listed = admitWebCatalogManifest(JSON.parse(new TextDecoder().decode(bytes))).files.map((asset) => asset.path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${manifest} does not fit this build's catalog contract; run npm run generate:web-catalog.\n${reason}`);
  }
  const files = ["manifest.json", ...listed].sort();
  return { path: `assets/catalog/${id}/`, root, files };
}

const CATALOG_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json; charset=utf-8",
  ".parquet": "application/vnd.apache.parquet",
};

/**
 * Places the generated catalog in a Web build under its content-named directory and serves the same layout,
 * byte ranges included, in development. A release never rewrites a path an open tab of an older release reads.
 */
function webCatalogPlugin(catalog: WebCatalog | null): Plugin {
  let command: "build" | "serve" = "serve";
  let base = "/";
  return {
    name: "canopi-web-catalog",
    configResolved(config) {
      command = config.command;
      base = config.base;
    },
    buildStart() {
      if (!catalog || command !== "build") return;
      for (const file of catalog.files) {
        this.emitFile({ type: "asset", fileName: `${catalog.path}${file}`, source: readFileSync(join(catalog.root, file)) });
      }
    },
    configureServer(server) {
      if (!catalog) return;
      server.middlewares.use((request, response, next) => {
        const prefix = `${base}${catalog.path}`;
        const pathname = (request.url ?? "").split("?")[0] ?? "";
        const file = pathname.startsWith(prefix) ? decodeURIComponent(pathname.slice(prefix.length)) : "";
        if (!catalog.files.includes(file)) return next();
        const target = resolve(catalog.root, file);
        const size = statSync(target).size;
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
        response.setHeader("Content-Type", CATALOG_CONTENT_TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream");
        response.setHeader("Accept-Ranges", "bytes");
        const bytes = readFileSync(target);
        if (!range || (range[1] === "" && range[2] === "")) {
          response.setHeader("Content-Length", String(size));
          response.end(bytes);
          return;
        }
        const start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
        const end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
        if (start > end || start >= size) {
          response.statusCode = 416;
          response.setHeader("Content-Range", `bytes */${size}`);
          response.end();
          return;
        }
        response.statusCode = 206;
        response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        response.setHeader("Content-Length", String(end - start + 1));
        response.end(bytes.subarray(start, end + 1));
      });
    },
  };
}
