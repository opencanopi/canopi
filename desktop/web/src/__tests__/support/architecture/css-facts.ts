import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import picomatch from 'picomatch'

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
}

export type CssModuleFacts = CssFileFacts

type CssBoundaryKind = 'colon' | 'open-brace' | 'close-brace' | 'semicolon' | 'end'

interface CssBoundary {
  readonly kind: CssBoundaryKind
  readonly index: number
}

const CSS_PROPERTY_PATTERN = /^--?[a-z_][\w-]*$|^[a-z_][\w-]*$/i

export function parseCssDeclarations(path: string, source: string): CssDeclarationFact[] {
  const declarations: CssDeclarationFact[] = []
  const blockStack: string[] = []
  const lineStarts = collectLineStarts(source)
  let index = 0

  while (index < source.length) {
    index = skipTrivia(source, index)
    if (index >= source.length) break

    if (source[index] === ';') {
      index += 1
      continue
    }
    if (source[index] === '}') {
      blockStack.pop()
      index += 1
      continue
    }

    const statementStart = index
    const boundary = findBoundary(source, statementStart, true)

    if (boundary.kind === 'open-brace') {
      blockStack.push(normalizeCssFragment(source.slice(statementStart, boundary.index)))
      index = boundary.index + 1
      continue
    }

    if (boundary.kind === 'colon') {
      const property = normalizeCssFragment(source.slice(statementStart, boundary.index))
      if (CSS_PROPERTY_PATTERN.test(property)) {
        const valueBoundary = findBoundary(source, boundary.index + 1, false)
        if (valueBoundary.kind !== 'open-brace') {
          const value = stripCssComments(source.slice(boundary.index + 1, valueBoundary.index)).trim()
          const location = sourceLocation(lineStarts, statementStart)
          declarations.push({
            path,
            rule: [...blockStack].reverse().find((block) => !block.startsWith('@')) ?? '',
            atRules: blockStack.filter((block) => block.startsWith('@')),
            property: property.startsWith('--') ? property : property.toLowerCase(),
            value,
            line: location.line,
            column: location.column,
          })

          if (valueBoundary.kind === 'close-brace') blockStack.pop()
          index = valueBoundary.kind === 'end' ? source.length : valueBoundary.index + 1
          continue
        }
      }

      const blockStart = findOpeningBrace(source, statementStart)
      if (blockStart >= 0) {
        blockStack.push(normalizeCssFragment(source.slice(statementStart, blockStart)))
        index = blockStart + 1
        continue
      }
    }

    if (boundary.kind === 'close-brace') blockStack.pop()
    index = boundary.kind === 'end' ? source.length : boundary.index + 1
  }

  return declarations
}

export function discoverCssModuleFacts(root: string | URL): CssModuleFacts[] {
  const rootPath = typeof root === 'string' ? resolve(root) : fileURLToPath(root)
  const pathPrefix = basename(rootPath)
  return cssModulePathsUnder(rootPath)
    .map((filePath) => {
      const relativePath = relative(rootPath, filePath).split(sep).join('/')
      const path = `${pathPrefix}/${relativePath}`
      return {
        path,
        declarations: parseCssDeclarations(path, readFileSync(filePath, 'utf8')),
      }
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

function findBoundary(source: string, start: number, includeColon: boolean): CssBoundary {
  let index = start
  let parentheses = 0
  let brackets = 0

  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]

    if (char === '/' && next === '*') {
      index = skipComment(source, index + 2)
      continue
    }
    if (char === '"' || char === "'") {
      index = skipString(source, index + 1, char)
      continue
    }
    if (char === '(') parentheses += 1
    else if (char === ')' && parentheses > 0) parentheses -= 1
    else if (char === '[') brackets += 1
    else if (char === ']' && brackets > 0) brackets -= 1
    else if (parentheses === 0 && brackets === 0) {
      if (includeColon && char === ':') return { kind: 'colon', index }
      if (char === '{') return { kind: 'open-brace', index }
      if (char === '}') return { kind: 'close-brace', index }
      if (char === ';') return { kind: 'semicolon', index }
    }
    index += 1
  }

  return { kind: 'end', index: source.length }
}

function findOpeningBrace(source: string, start: number): number {
  let index = start
  let parentheses = 0
  let brackets = 0

  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]
    if (char === '/' && next === '*') {
      index = skipComment(source, index + 2)
      continue
    }
    if (char === '"' || char === "'") {
      index = skipString(source, index + 1, char)
      continue
    }
    if (char === '(') parentheses += 1
    else if (char === ')' && parentheses > 0) parentheses -= 1
    else if (char === '[') brackets += 1
    else if (char === ']' && brackets > 0) brackets -= 1
    else if (parentheses === 0 && brackets === 0) {
      if (char === '{') return index
      if (char === ';' || char === '}') return -1
    }
    index += 1
  }
  return -1
}

function skipTrivia(source: string, start: number): number {
  let index = start
  while (index < source.length) {
    if (/\s/.test(source[index]!)) {
      index += 1
      continue
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      index = skipComment(source, index + 2)
      continue
    }
    break
  }
  return index
}

function skipComment(source: string, start: number): number {
  const end = source.indexOf('*/', start)
  return end < 0 ? source.length : end + 2
}

function skipString(source: string, start: number, quote: string): number {
  let index = start
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2
      continue
    }
    if (source[index] === quote) return index + 1
    index += 1
  }
  return source.length
}

function stripCssComments(source: string): string {
  let result = ''
  let index = 0
  while (index < source.length) {
    if (source[index] === '/' && source[index + 1] === '*') {
      const end = skipComment(source, index + 2)
      const comment = source.slice(index, end)
      result += comment.replace(/[^\n]/g, ' ')
      index = end
      continue
    }
    if (source[index] === '"' || source[index] === "'") {
      const end = skipString(source, index + 1, source[index]!)
      result += source.slice(index, end)
      index = end
      continue
    }
    result += source[index]
    index += 1
  }
  return result
}

function normalizeCssFragment(source: string): string {
  return stripCssComments(source).trim().replace(/\s+/g, ' ')
}

function collectLineStarts(source: string): number[] {
  const starts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1)
  }
  return starts
}

function sourceLocation(
  lineStarts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let low = 0
  let high = lineStarts.length
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (lineStarts[middle]! <= offset) low = middle
    else high = middle
  }
  return {
    line: low + 1,
    column: offset - lineStarts[low]! + 1,
  }
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
      for (const declaration of file.declarations) {
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
