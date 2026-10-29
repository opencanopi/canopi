import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync } from "vite";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scannedExtensions = [".js", ".mjs"];
const NON_ASCII = /[^\x00-\x7f]/;

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
    process.exit(1);
  }
}
