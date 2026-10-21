import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { admitWebCatalogManifest } from "../src/generated/web-catalog-artifact.mjs";

const DEFAULT_WEB_BASE_PATH = "/app/";
const WEB_BASE_PATH_ENV = "CANOPI_WEB_BASE_PATH";
const CLOUDFLARE_PAGES_MAX_ASSET_BYTES = 25 * 1024 * 1024;
const CLOUDFLARE_PAGES_FREE_MAX_FILES = 20_000;
const MANIFEST_NAME = "canopi-web-edition-manifest.json";
// The Web build's catalog plugin (vite.config.ts) names the catalog directory by the first 16 hex of its
// manifest's SHA-256 (2.1-M176), so a release never overwrites a path an older tab still reads.
const CATALOG_ROOT = "assets/catalog";
const CATALOG_MANIFEST = "manifest.json";
const FORBIDDEN_DUCKDB_WASM_RE = /(?:^|\/)duckdb-.*\.wasm$/i;

const scriptRoot = import.meta.url.startsWith("file:")
  ? dirname(fileURLToPath(import.meta.url))
  : resolve(process.cwd(), "scripts");
const webRoot = resolve(scriptRoot, "..");
const repoRoot = resolve(webRoot, "../..");

export async function packageWebEdition(options = {}) {
  const distRoot = resolve(options.distRoot ?? resolve(webRoot, "dist-web"));
  const artifactRoot = resolve(options.artifactRoot ?? resolve(webRoot, "dist-web-artifacts"));
  const version = options.version ?? readPackageVersion(webRoot);
  const commit = options.commit ?? readGitCommit(repoRoot);
  const maxAssetBytes = options.maxAssetBytes ?? CLOUDFLARE_PAGES_MAX_ASSET_BYTES;
  const maxFileCount = options.maxFileCount ?? CLOUDFLARE_PAGES_FREE_MAX_FILES;
  const basePath = normalizeWebBasePath(options.basePath ?? process.env[WEB_BASE_PATH_ENV]);

  if (!existsSync(distRoot)) {
    throw new Error(`Missing Web Edition build output at ${distRoot}. Run npm run build:web first.`);
  }

  const sourceFiles = filesUnder(distRoot).sort(comparePaths);
  if (sourceFiles.length === 0) {
    throw new Error(`Web Edition build output is empty at ${distRoot}.`);
  }
  if (sourceFiles.length > maxFileCount) {
    throw new Error(
      `Web Edition build contains ${sourceFiles.length} files, above the Cloudflare Pages file limit ${maxFileCount}.`,
    );
  }

  const sizeViolations = sourceFiles
    .map((filePath) => ({
      relativePath: toPortablePath(relative(distRoot, filePath)),
      bytes: statSync(filePath).size,
    }))
    .filter((file) => file.bytes > maxAssetBytes);

  if (sizeViolations.length > 0) {
    throw new Error(
      [
        `Web Edition build exceeds the Cloudflare Pages per-asset limit of ${maxAssetBytes} bytes.`,
        ...sizeViolations.map((file) => `- ${file.relativePath}: ${file.bytes} bytes`),
      ].join("\n"),
    );
  }
  validateNoRawDuckDbWasm(distRoot, sourceFiles);
  validateBuiltBasePath(distRoot, sourceFiles, basePath);
  const catalog = validateCatalogArtifact(distRoot, maxAssetBytes);

  const artifactName = webEditionArtifactName(version, commit, basePath);
  const artifactDir = resolve(artifactRoot, artifactName);
  const archivePath = resolve(artifactRoot, `${artifactName}.tar.gz`);

  rmSync(artifactDir, { recursive: true, force: true });
  rmSync(archivePath, { force: true });
  mkdirSync(artifactDir, { recursive: true });

  for (const sourcePath of sourceFiles) {
    const sourceRelativePath = toPortablePath(relative(distRoot, sourcePath));
    const artifactRelativePath = sourceRelativePath === "web.html" ? "index.html" : sourceRelativePath;
    const targetPath = resolve(artifactDir, artifactRelativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }

  if (!existsSync(resolve(artifactDir, "index.html"))) {
    throw new Error("Web Edition artifact is missing index.html. Expected dist-web/web.html to package as index.html.");
  }

  const manifestFiles = filesUnder(artifactDir)
    .map((filePath) => createManifestEntry(artifactDir, filePath))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    name: "Canopi Web Edition",
    version,
    commit,
    basePath,
    spaFallback: spaFallbackForBasePath(basePath),
    limits: {
      cloudflarePagesMaxAssetBytes: maxAssetBytes,
      cloudflarePagesMaxFiles: maxFileCount,
    },
    catalog,
    files: manifestFiles,
  };
  const artifactFileCount = manifestFiles.length + 1;
  if (artifactFileCount > maxFileCount) {
    throw new Error(
      `Web Edition artifact contains ${artifactFileCount} files, above the Cloudflare Pages file limit ${maxFileCount}.`,
    );
  }
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(manifestJson) > maxAssetBytes) {
    throw new Error(
      `${MANIFEST_NAME} exceeds the Cloudflare Pages per-asset limit of ${maxAssetBytes} bytes.`,
    );
  }

  writeFileSync(resolve(artifactDir, MANIFEST_NAME), manifestJson);
  writeFileSync(archivePath, createTarGz(artifactDir));

  return {
    artifactDir,
    archivePath,
    manifestPath: resolve(artifactDir, MANIFEST_NAME),
  };
}

function normalizeWebBasePath(value) {
  const rawValue = value ?? DEFAULT_WEB_BASE_PATH;
  if (typeof rawValue !== "string") {
    throw new Error(`${WEB_BASE_PATH_ENV} must be a string base path.`);
  }
  const basePath = rawValue.trim();
  if (basePath.length === 0) {
    throw new Error(`${WEB_BASE_PATH_ENV} must not be empty.`);
  }
  if (basePath === "/") return "/";
  if (!basePath.startsWith("/")) {
    throw new Error(`${WEB_BASE_PATH_ENV} must be "/" or an absolute path such as "/app/".`);
  }
  return basePath.endsWith("/") ? basePath : `${basePath}/`;
}

function spaFallbackForBasePath(basePath) {
  if (basePath === "/") {
    return {
      source: "/*",
      destination: "/index.html",
      status: 200,
    };
  }
  const routeBase = basePath.slice(0, -1);
  return {
    source: `${routeBase}/*`,
    destination: `${routeBase}/index.html`,
    status: 200,
  };
}

function webEditionArtifactName(version, commit, basePath) {
  const baseSuffix = basePath === DEFAULT_WEB_BASE_PATH
    ? ""
    : `-${artifactBasePathSlug(basePath)}`;
  return `canopi-web-edition${baseSuffix}-v${sanitizeVersion(version)}-${sanitizeCommit(commit)}`;
}

function artifactBasePathSlug(basePath) {
  if (basePath === "/") return "root";
  const slug = basePath
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^0-9A-Za-z._-]/g, "-");
  return slug.length > 0 ? slug : "root";
}

function validateNoRawDuckDbWasm(distRoot, sourceFiles) {
  const violation = sourceFiles
    .map((filePath) => toPortablePath(relative(distRoot, filePath)))
    .find((relativePath) => FORBIDDEN_DUCKDB_WASM_RE.test(relativePath));
  if (violation) {
    throw new Error(`${violation} must not bundle DuckDB raw WASM; use CDN-selected DuckDB-WASM bundles.`);
  }
}

function validateBuiltBasePath(distRoot, sourceFiles, basePath) {
  const htmlFiles = sourceFiles.filter((filePath) => filePath.endsWith(".html"));
  for (const htmlFile of htmlFiles) {
    const html = readFileSync(htmlFile, "utf8");
    const relativePath = toPortablePath(relative(distRoot, htmlFile));
    for (const assetPath of localAbsoluteHtmlAssetPaths(html)) {
      if (basePath === "/") {
        if (assetPath.startsWith(DEFAULT_WEB_BASE_PATH)) {
          throw new Error(
            `Rebuild with ${WEB_BASE_PATH_ENV}=/ before packaging root-base artifacts; ${relativePath} still references ${assetPath}.`,
          );
        }
      } else if (!assetPath.startsWith(basePath)) {
        throw new Error(
          `Rebuild with ${WEB_BASE_PATH_ENV}=${basePath} before packaging; ${relativePath} references ${assetPath}.`,
        );
      }
    }
  }
}

function localAbsoluteHtmlAssetPaths(html) {
  const paths = [];
  const assetReferencePattern = /\b(?:src|href)=["'](\/[^"']*)["']/gi;
  for (const match of html.matchAll(assetReferencePattern)) {
    const assetPath = match[1];
    if (assetPath && !assetPath.startsWith("//")) paths.push(assetPath);
  }
  return paths;
}

function validateCatalogArtifact(distRoot, maxAssetBytes) {
  const manifests = filesUnder(distRoot)
    .map((filePath) => toPortablePath(relative(distRoot, filePath)))
    .filter((path) => basename(path) === CATALOG_MANIFEST)
    .sort(comparePaths);
  const misplaced = manifests.filter((path) => !new RegExp(`^${CATALOG_ROOT}/[^/]+/${CATALOG_MANIFEST}$`).test(path));
  if (misplaced.length > 0) {
    throw new Error(
      `Web Edition build has a catalog manifest at ${misplaced.join(", ")}, outside ${CATALOG_ROOT}/<id>/. The Web build places the catalog from desktop/web/catalog-input/.`,
    );
  }
  if (manifests.length !== 1) {
    throw new Error(
      manifests.length === 0
        ? `Web Edition build is missing generated Species Catalog manifest at ${CATALOG_ROOT}/<id>/${CATALOG_MANIFEST}. Run npm run generate:web-catalog before npm run build:web.`
        : `Web Edition build holds ${manifests.length} catalogs: ${manifests.join(", ")}.`,
    );
  }
  const catalogManifestPath = manifests[0];
  const catalogRoot = dirname(resolve(distRoot, catalogManifestPath));
  const catalogId = basename(catalogRoot);
  const manifestBytes = readFileSync(resolve(distRoot, catalogManifestPath));
  const contentId = createHash("sha256").update(manifestBytes).digest("hex").slice(0, 16);
  if (catalogId !== contentId) {
    throw new Error(`Web Edition catalog directory ${catalogId} is not the content id ${contentId} of its manifest.`);
  }
  const catalogManifest = admitWebCatalogManifest(JSON.parse(manifestBytes.toString("utf8")));
  const catalogMaxAssetBytes = Math.min(maxAssetBytes, catalogManifest.maxAssetBytes);
  for (const asset of catalogManifest.files) {
    validateCatalogAssetEntry(catalogRoot, asset, catalogMaxAssetBytes);
  }
  const base = `${CATALOG_ROOT}/${catalogId}`;
  return {
    manifestPath: catalogManifestPath,
    assetFormat: catalogManifest.assetFormat,
    supportedFilters: catalogManifest.supportedFilters.map((filter) => filter.key),
    files: catalogManifest.files.map((asset) => `${base}/${asset.path}`),
  };
}

function validateCatalogAssetEntry(catalogRoot, asset, maxAssetBytes) {
  const assetPath = resolveCatalogAssetPath(catalogRoot, asset.path);
  if (!existsSync(assetPath)) {
    throw new Error(`Web Edition Species Catalog asset is missing: ${asset.path}`);
  }
  const bytes = statSync(assetPath).size;
  if (bytes > maxAssetBytes) {
    throw new Error(
      `Web Edition Species Catalog asset ${asset.path} exceeds the Cloudflare Pages per-asset limit of ${maxAssetBytes} bytes.`,
    );
  }
  if (bytes !== asset.bytes) {
    throw new Error(
      `Web Edition Species Catalog byte count mismatch for ${asset.path}: manifest ${asset.bytes}, actual ${bytes}.`,
    );
  }
  const sha256 = sha256File(assetPath);
  if (sha256 !== asset.sha256) {
    throw new Error(
      `Web Edition Species Catalog checksum mismatch for ${asset.path}: manifest ${asset.sha256}, actual ${sha256}.`,
    );
  }
}

function resolveCatalogAssetPath(catalogRoot, assetPath) {
  if (assetPath.startsWith("/") || assetPath.split("/").includes("..")) {
    throw new Error(`Unsafe Web Edition Species Catalog asset path: ${assetPath}`);
  }
  const resolved = resolve(catalogRoot, assetPath);
  const relativePath = relative(catalogRoot, resolved);
  if (relativePath.startsWith("..") || relativePath === "") {
    throw new Error(`Unsafe Web Edition Species Catalog asset path: ${assetPath}`);
  }
  return resolved;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readPackageVersion(root) {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("desktop/web/package.json is missing a version string.");
  }
  return packageJson.version;
}

/** The checked-out commit, by git itself: worktrees, packed refs and detached heads alike. */
export function readGitCommit(root) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, encoding: "utf8" }).trim().slice(0, 12);
  } catch (error) {
    throw new Error(`Could not resolve the git commit of ${root}: ${error instanceof Error ? error.message : error}`);
  }
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(child);
    if (entry.isFile()) return [child];
    if (entry.isSymbolicLink()) {
      throw new Error(`Web Edition build contains a symbolic link and cannot be packaged: ${child}`);
    }
    throw new Error(`Web Edition build contains an unsupported filesystem entry: ${child}`);
  });
}

function createManifestEntry(root, filePath) {
  const content = readFileSync(filePath);
  return {
    path: toPortablePath(relative(root, filePath)),
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function createTarGz(root) {
  const chunks = [];
  const filePaths = filesUnder(root).sort(comparePaths);
  for (const filePath of filePaths) {
    const relativePath = toPortablePath(relative(root, filePath));
    const content = readFileSync(filePath);
    chunks.push(createTarHeader(relativePath, content.byteLength));
    chunks.push(content);
    chunks.push(Buffer.alloc(padLength(content.byteLength)));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function createTarHeader(path, size) {
  const pathBytes = Buffer.from(path);
  if (pathBytes.byteLength > 100) {
    throw new Error(`Cannot package ${path}: tar path exceeds 100 bytes.`);
  }

  const header = Buffer.alloc(512);
  writeString(header, path, 0, 100);
  writeOctal(header, 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, "ustar", 257, 6);
  writeString(header, "00", 263, 2);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeOctal(header, checksum, 148, 8);
  return header;
}

function writeString(buffer, value, offset, length) {
  Buffer.from(value).copy(buffer, offset, 0, length);
}

function writeOctal(buffer, value, offset, length) {
  const text = value.toString(8).padStart(length - 1, "0");
  buffer.write(text.slice(-length + 1), offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function padLength(size) {
  const remainder = size % 512;
  return remainder === 0 ? 0 : 512 - remainder;
}

function sanitizeVersion(version) {
  return version.replace(/[^0-9A-Za-z._-]/g, "-");
}

function sanitizeCommit(commit) {
  return commit.replace(/[^0-9A-Za-z]/g, "").slice(0, 12);
}

function toPortablePath(path) {
  return path.split(sep).join("/");
}

function comparePaths(left, right) {
  return left.localeCompare(right);
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument list near ${name ?? "<end>"}.`);
    }
    values.set(name, value);
  }
  return {
    distRoot: values.get("--dist"),
    artifactRoot: values.get("--out"),
    version: values.get("--version"),
    commit: values.get("--commit"),
    maxAssetBytes: values.has("--max-asset-bytes") ? Number(values.get("--max-asset-bytes")) : undefined,
    maxFileCount: values.has("--max-file-count") ? Number(values.get("--max-file-count")) : undefined,
    basePath: values.get("--base-path"),
  };
}

if (isCli()) {
  packageWebEdition(parseArgs(process.argv.slice(2)))
    .then((result) => {
      console.log(`Packaged Web Edition artifact: ${relative(webRoot, result.archivePath)}`);
      console.log(`Manifest: ${relative(webRoot, result.manifestPath)}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

function isCli() {
  return process.argv[1] !== undefined
    && import.meta.url.startsWith("file:")
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}
