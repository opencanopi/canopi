import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import picomatch from 'picomatch'
import postcss, { type AnyNode, type AtRule, type Rule } from 'postcss'

export interface CssDeclarationFact {
  readonly path: string
  readonly rule: string
  readonly atRules: readonly string[]
  readonly property: string
  readonly value: string
  readonly line: number
  readonly column: number
}

export interface CssFileFacts {
  readonly path: string
  readonly declarations: readonly CssDeclarationFact[]
  /**
   * Each block at-rule's prelude as a fact whose property is its at-keyword (`@media`) and value its condition, so a
   * policy on every property (`*`) reads a breakpoint too (`@media (max-width: 48rem)`).
   */
  readonly preludes?: readonly CssDeclarationFact[]
}

export type CssModuleFacts = CssFileFacts

const normalizeWhitespace = (text: string): string => text.trim().replace(/\s+/g, ' ')

function ancestorContext(node: AnyNode): { rule: string; atRules: string[] } {
  let rule = ''
  const atRules: string[] = []
  let parent = node.parent
  while (parent && parent.type !== 'root') {
    if (parent.type === 'rule' && !rule) {
      rule = normalizeWhitespace((parent as Rule).selector)
    } else if (parent.type === 'atrule') {
      const at = parent as AtRule
      const params = normalizeWhitespace(at.params)
      atRules.unshift(params ? `@${at.name} ${params}` : `@${at.name}`)
    }
    parent = parent.parent
  }
  return { rule, atRules }
}

export function parseCssDeclarations(path: string, source: string): CssDeclarationFact[] {
  return [...parseCssFile(path, source).declarations]
}

/** A stylesheet's declarations and its block at-rules' preludes (CssFileFacts), parsed with postcss (canopi-edlj). */
export function parseCssFile(path: string, source: string): CssFileFacts {
  const root = postcss.parse(source, { from: path })
  const declarations: CssDeclarationFact[] = []
  const preludes: CssDeclarationFact[] = []

  root.walkAtRules((atRule) => {
    if (!atRule.nodes) return
    const { rule, atRules } = ancestorContext(atRule)
    preludes.push({
      path,
      rule,
      atRules,
      property: `@${atRule.name.toLowerCase()}`,
      value: normalizeWhitespace(atRule.params),
      line: atRule.source?.start?.line ?? 1,
      column: atRule.source?.start?.column ?? 1,
    })
  })

  root.walkDecls((decl) => {
    const { rule, atRules } = ancestorContext(decl)
    declarations.push({
      path,
      rule,
      atRules,
      property: decl.prop.startsWith('--') ? decl.prop : decl.prop.toLowerCase(),
      value: (decl.important ? `${decl.value} !important` : decl.value).trim(),
      line: decl.source?.start?.line ?? 1,
      column: decl.source?.start?.column ?? 1,
    })
  })

  return { path, declarations, preludes }
}

export function discoverCssModuleFacts(root: string | URL): CssModuleFacts[] {
  const rootPath = typeof root === 'string' ? resolve(root) : fileURLToPath(root)
  const pathPrefix = basename(rootPath)
  return cssModulePathsUnder(rootPath)
    .map((filePath) => {
      const relativePath = relative(rootPath, filePath).split(sep).join('/')
      const path = `${pathPrefix}/${relativePath}`
      return parseCssFile(path, readFileSync(filePath, 'utf8'))
    })
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

function cssModulePathsUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return cssModulePathsUnder(path)
    return entry.isFile() && entry.name.endsWith('.module.css') ? [path] : []
  })
}

// CSS declaration policies (moved from policy-harness.ts with the FAP conversion, F1a): a policy names property globs
// (picomatch, the repository's one glob engine), the raw values it rejects and the reviewed exceptions.
interface CssPolicyException {
  readonly file: string
  readonly rule: string
  readonly atRules: readonly string[]
  readonly property: string
  readonly value: string
  readonly reason: string
}

export interface CssDeclarationPolicy {
  readonly name: string
  readonly properties: readonly string[]
  readonly rawValue: RegExp
  readonly requiredValue: RegExp
  readonly accepts?: (declaration: CssDeclarationFact) => boolean
  readonly exceptions: readonly CssPolicyException[]
}

export function collectCssPolicyViolations(
  files: readonly CssFileFacts[],
  policies: readonly CssDeclarationPolicy[],
): string[] {
  const violations: string[] = []

  for (const policy of policies) {
    const exceptionKeys = new Set<string>()
    const usedExceptionKeys = new Set<string>()
    for (const exception of policy.exceptions) {
      const key = cssExceptionKey(exception)
      if (!exception.reason.trim()) {
        violations.push(`[${policy.name}] CSS exception reason is empty: ${key}`)
      }
      if (exceptionKeys.has(key)) {
        violations.push(`[${policy.name}] duplicate CSS exception: ${key}`)
      }
      exceptionKeys.add(key)
    }

    for (const file of files) {
      for (const declaration of [...file.declarations, ...(file.preludes ?? [])]) {
        if (!picomatch.isMatch(declaration.property, policy.properties, { dot: true, posix: true })) continue
        policy.rawValue.lastIndex = 0
        if (!policy.rawValue.test(declaration.value)) continue
        if (policy.accepts) {
          if (policy.accepts(declaration)) continue
        } else {
          policy.requiredValue.lastIndex = 0
          if (policy.requiredValue.test(declaration.value)) continue
        }

        const declarationKey = cssDeclarationExceptionKey(declaration)
        const exception = policy.exceptions.find((candidate) =>
          cssExceptionMatches(candidate, declaration),
        )
        if (exception && !usedExceptionKeys.has(declarationKey)) {
          usedExceptionKeys.add(declarationKey)
          continue
        }
        violations.push(
          `[${policy.name}] ${declaration.path}:${declaration.line} ${declaration.property}: ${declaration.value}`,
        )
      }
    }

    for (const exception of policy.exceptions) {
      const key = cssExceptionKey(exception)
      if (!usedExceptionKeys.has(key)) {
        violations.push(`[${policy.name}] unused CSS exception: ${key} (${exception.reason})`)
      }
    }
  }

  return violations
}

function cssExceptionMatches(
  exception: CssPolicyException,
  declaration: CssDeclarationFact,
): boolean {
  return exception.file === declaration.path
    && exception.property === declaration.property
    && exception.value === declaration.value
    && exception.rule === declaration.rule
    && arraysEqual(exception.atRules, declaration.atRules)
}

function cssExceptionKey(exception: CssPolicyException): string {
  return [
    exception.file,
    cssAtRuleContext(exception.atRules),
    exception.rule,
    exception.property,
    exception.value,
  ].join('|')
}

function cssDeclarationExceptionKey(declaration: CssDeclarationFact): string {
  return [
    declaration.path,
    cssAtRuleContext(declaration.atRules),
    declaration.rule,
    declaration.property,
    declaration.value,
  ].join('|')
}

function cssAtRuleContext(atRules: readonly string[]): string {
  return atRules.length > 0 ? atRules.join(' > ') : '<root>'
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function cssMathFunctionBodies(value: string): string[] {
  const starts = value.matchAll(
    /\b(?:abs|acos|asin|atan|atan2|calc|clamp|cos|exp|hypot|log|max|min|mod|pow|rem|round|sign|sin|sqrt|tan)\(/gi,
  )
  const bodies: string[] = []
  for (const match of starts) {
    const open = (match.index ?? 0) + match[0].length - 1
    const close = matchingParenthesis(value, open)
    if (close >= 0) bodies.push(value.slice(open + 1, close))
  }
  return bodies
}

function matchingParenthesis(value: string, open: number): number {
  let depth = 0
  let quote: string | null = null
  for (let index = open; index < value.length; index += 1) {
    const char = value[index]!
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')' && --depth === 0) return index
  }
  return -1
}

export function splitTopLevelComponents(value: string, splitSlash = false): string[] {
  const components: string[] = []
  let start = 0
  let depth = 0
  let quote: string | null = null
  let index = 0

  const push = (end: number) => {
    const component = value.slice(start, end).trim()
    if (component) components.push(component)
  }

  while (index < value.length) {
    const char = value[index]!
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '(') {
      depth += 1
    } else if (char === ')' && depth > 0) {
      depth -= 1
    } else if (depth === 0 && (/\s/.test(char) || (splitSlash && char === '/'))) {
      push(index)
      start = index + 1
    }
    index += 1
  }
  push(value.length)
  return components
}

/**
 * The stylesheets that are not CSS Modules (styles/global.css, styles/fonts.css), parsed as the modules are, for the
 * policies that hold every stylesheet.
 */
export function globalStylesheetFacts(directory = 'src'): CssFileFacts[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name).split('\\').join('/')
    if (entry.isDirectory()) return globalStylesheetFacts(path)
    return entry.name.endsWith('.css') && !entry.name.endsWith('.module.css')
      ? [parseCssFile(path, readFileSync(path, 'utf8'))]
      : []
  }).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/**
 * Text is sized in px tokens, while a rem length follows the browser's default font size: at a large browser font a rem
 * flex-basis or max-width outgrows its px-sized row and pushes text under its icon or button (canopi-6spu). It holds
 * every stylesheet, not only the CSS Modules.
 */
export const REM_FREE_POLICY: CssDeclarationPolicy = {
  name: 'Stylesheets size no length in rem',
  properties: ['*'],
  rawValue: /(?:^|[^\w.-])(?:\d*\.\d+|\d+)rem(?![\w-])/i,
  requiredValue: /$^/,
  accepts: () => false,
  exceptions: [],
}
