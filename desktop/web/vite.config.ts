import { defineConfig, type Plugin } from "vite";
import { configDefaults } from "vitest/config";
import preact from "@preact/preset-vite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { resolveWebEditionDevHtmlUrl } from "./src/web/dev-entry";
import { admitWebCatalogManifest } from "./src/generated/web-catalog-artifact.mjs";

const DEFAULT_WEB_EDITION_BASE_PATH = "/app/";
const WEB_EDITION_BASE_PATH_ENV = "CANOPI_WEB_BASE_PATH";
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
const DEFAULT_WEB_CATALOG_INPUT = fileURLToPath(new URL('./catalog-input/', import.meta.url));

export default defineConfig(({ mode }) => {
  const isWebEdition = mode === 'web';
  const webEditionBasePath = isWebEdition
    ? resolveWebEditionBasePath(process.env[WEB_EDITION_BASE_PATH_ENV])
    : undefined;
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
  return {
    cacheDir: isWebEdition ? "node_modules/.vite-web" : "node_modules/.vite-desktop",
    plugins: [
      preact(),
      webEditionDevEntryPlugin(isWebEdition),
      webCatalogPlugin(webCatalog),
    ],
    base: webEditionBasePath,
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
      esbuildOptions: { target: 'es2022' },
    },
    worker: {
      // The raster decode lane imports geotiff codecs dynamically.
      format: 'es' as const,
      ...(isWebEdition ? { rollupOptions: { output: WEB_HASHED_NAMES } } : {}),
    },
    server: {
      port: isWebEdition ? 1421 : 1420,
      strictPort: true,
      fs: {
        allow: [
          fileURLToPath(new URL('.', import.meta.url)),
          tauriConfigPath,
          `${tauriConfigPath}?raw`,
        ],
      },
    },
    build: {
      target: 'es2022',
      outDir: isWebEdition ? "dist-web" : "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: isWebEdition ? "web.html" : "index.html",
        output: {
          ...(isWebEdition ? WEB_HASHED_NAMES : {}),
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (id.includes("maplibre-gl-raster") || id.includes("@deck.gl") || id.includes("@luma.gl") || id.includes("@developmentseed") || id.includes("@math.gl") || id.includes("@loaders.gl")) return "raster-display";
            if (id.includes("maplibre-gl")) return "maplibre-gl";
            if (id.includes("@tauri-apps")) return "tauri";
            if (id.includes("i18next")) return "i18n";
            return undefined;
          },
        },
      },
    },
    test: {
      // Plain Node by default: jsdom's setup cost more than the tests it served (576 s of worker time per run,
      // 2026-10-16). A test file that needs the DOM starts with `// @vitest-environment jsdom`; without it,
      // `document` and `window` are undefined and the file fails, so no test passes without the page it needs.
      environment: "node",
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

function resolveWebEditionBasePath(value: string | undefined): string {
  const basePath = (value ?? DEFAULT_WEB_EDITION_BASE_PATH).trim();
  if (basePath.length === 0) {
    throw new Error(`${WEB_EDITION_BASE_PATH_ENV} must not be empty.`);
  }
  if (basePath === "/") return "/";
  if (!basePath.startsWith("/")) {
    throw new Error(`${WEB_EDITION_BASE_PATH_ENV} must be "/" or an absolute path such as "/app/".`);
  }
  return basePath.endsWith("/") ? basePath : `${basePath}/`;
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
