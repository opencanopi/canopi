import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  collectCssPolicyViolations,
  discoverCssModuleFacts,
  parseCssDeclarations,
  type CssDeclarationFact,
  type CssDeclarationPolicy,
} from './support/architecture/css-facts'

let cssModuleFactsCache: ReturnType<typeof discoverCssModuleFacts> | null = null

/** Every CSS Module's declarations, parsed once per run for all the policies below. */
function cssModuleFacts(): ReturnType<typeof discoverCssModuleFacts> {
  cssModuleFactsCache ??= discoverCssModuleFacts('src')
  return cssModuleFactsCache
}

const CSS_WIDE_VALUES = new Set(['inherit', 'initial', 'revert', 'revert-layer', 'unset'])
const CSS_NUMBER_SOURCE = String.raw`[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?`
const CSS_LENGTH_UNITS = [
  'px', 'cm', 'mm', 'q', 'in', 'pc', 'pt',
  'em', 'rem', 'ex', 'rex', 'cap', 'rcap', 'ch', 'rch', 'ic', 'ric', 'lh', 'rlh',
  'vw', 'vh', 'vi', 'vb', 'vmin', 'vmax',
  'svw', 'svh', 'svi', 'svb', 'svmin', 'svmax',
  'lvw', 'lvh', 'lvi', 'lvb', 'lvmin', 'lvmax',
  'dvw', 'dvh', 'dvi', 'dvb', 'dvmin', 'dvmax',
  'cqw', 'cqh', 'cqi', 'cqb', 'cqmin', 'cqmax',
].join('|')
const RAW_CSS_LENGTH_OR_PERCENTAGE = new RegExp(
  String.raw`(?:^|[^\w.-])${CSS_NUMBER_SOURCE}(?:${CSS_LENGTH_UNITS}|%)(?![\w-])`,
  'i',
)
const RAW_CSS_TIME = new RegExp(
  String.raw`(?:^|[^\w.-])${CSS_NUMBER_SOURCE}(?:ms|s)(?![\w-])`,
  'i',
)
const RAW_CSS_COLOUR =
  /(?:^|[^\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|#[0-9a-f]{3,8}\b|(?:^|[^\w-])(?:white|black)(?![\w-])/i
const ALLOWED_FONT_WEIGHTS = new Set(['400', '600'])
const GLOBAL_DESIGN_TOKEN_NAMES = collectGlobalDesignTokenNames(
  readFileSync('src/styles/global.css', 'utf8'),
)

const STRUCTURAL_SPACING_EXCEPTIONS = [
  {
    file: 'src/components/panels/FavoritesPanel.module.css',
    rule: '.savedStampGripDots',
    atRules: [],
    property: 'gap',
    value: 'var(--saved-stamp-grip-dot-size)',
    reason: 'The structural grid gap must equal the locally defined grip-dot diameter.',
  },
  {
    file: 'src/components/plant-db/RangeSlider.module.css',
    rule: '.input::-webkit-slider-thumb',
    atRules: [],
    property: 'margin-top',
    value: 'calc(var(--slider-thumb-size) / -2)',
    reason: 'WebKit range thumbs are centered against the intentionally zero-height structural track.',
  },
  {
    file: 'src/components/plant-db/ThresholdSlider.module.css',
    rule: '.tick',
    atRules: [],
    property: 'margin-left',
    value: 'calc(-1px / 2)',
    reason: 'Centers a one-pixel tick on its exact percentage coordinate.',
  },
  {
    file: 'src/components/plant-db/ThresholdSlider.module.css',
    rule: '.input::-webkit-slider-thumb',
    atRules: [],
    property: 'margin-top',
    value: 'calc(var(--slider-thumb-size) / -2)',
    reason: 'WebKit range thumbs are centered against the intentionally zero-height structural track.',
  },
  {
    file: 'src/components/shared/CommandPalette.module.css',
    rule: '.overlay',
    atRules: [],
    property: 'padding-top',
    value: '20vh',
    reason: 'Positions the palette relative to viewport height rather than the visual spacing scale.',
  },
] as const

const STRUCTURAL_FONT_EXCEPTIONS = [
] as const

const REVIEWED_TRANSITION_EXCEPTIONS = [
] as const

const CSS_MODULE_POLICIES: readonly CssDeclarationPolicy[] = [
  {
    name: 'Design-scale tokens are declared globally',
    properties: ['--space-*', '--text-*', '--font-*', '--radius-*', '--transition-*'],
    rawValue: /[\s\S]*/,
    requiredValue: /$^/,
    accepts: () => false,
    exceptions: [],
  },
  {
    name: 'CSS font sizes use typography tokens',
    properties: ['font-size', 'font'],
    rawValue: /[\s\S]+/,
    requiredValue: /$^/,
    accepts: acceptsFontDeclaration,
    exceptions: STRUCTURAL_FONT_EXCEPTIONS,
  },
  {
    name: 'CSS spacing uses spacing tokens',
    properties: ['padding*', 'margin*', 'gap', 'row-gap', 'column-gap'],
    rawValue: /[\s\S]+/,
    requiredValue: /$^/,
    accepts: ({ value }) => splitTopLevelComponents(value).every(acceptsSpacingComponent),
    exceptions: STRUCTURAL_SPACING_EXCEPTIONS,
  },
  {
    name: 'CSS radii use radius tokens',
    properties: ['border-radius', 'border-*-radius'],
    rawValue: /[\s\S]+/,
    requiredValue: /$^/,
    accepts: ({ value }) => splitTopLevelComponents(value, true).every(acceptsRadiusComponent),
    exceptions: [],
  },
  {
    name: 'CSS transitions use transition tokens',
    properties: ['transition', 'transition-*', '--transition-*'],
    rawValue: /[\s\S]+/,
    requiredValue: /$^/,
    accepts: acceptsTransitionDeclaration,
    exceptions: REVIEWED_TRANSITION_EXCEPTIONS,
  },
  {
    // A raw colour does not follow the theme, so it breaks dark mode (system.md: tokens only). Any property is
    // checked, since shorthands (border, box-shadow, filter: drop-shadow) carry colours too.
    name: 'CSS Modules draw colour from tokens',
    properties: ['*'],
    rawValue: RAW_CSS_COLOUR,
    requiredValue: /$^/,
    accepts: () => false,
    exceptions: [],
  },
  {
    // system.md allows two weights, 400 and 600; a third weight reads as a new level of emphasis.
    name: 'CSS font weights are 400 or 600',
    properties: ['font-weight', 'font'],
    rawValue: /[\s\S]+/,
    requiredValue: /$^/,
    accepts: acceptsFontWeightDeclaration,
    exceptions: [],
  },
]

describe('CSS module policy facts', () => {
  it('parses lexical edge cases without treating comments or selector colons as declarations', () => {
    const declarations = parseCssDeclarations('src/fixture.module.css', `
      /* .ignored { gap: 99px; } */
      .item:hover {
        padding:
          var(--space-2)
          calc(var(--space-1) + 1px);
        background-image: url("data:image/svg+xml;utf8,<svg>{}</svg>");
      }

      @media (prefers-reduced-motion: reduce) {
        .item { transition: none }
      }
    `)

    expect(declarations.map(({ rule, property, value, line }) => ({
      rule,
      property,
      value,
      line,
    }))).toEqual([
      {
        rule: '.item:hover',
        property: 'padding',
        value: 'var(--space-2)\n          calc(var(--space-1) + 1px)',
        line: 4,
      },
      {
        rule: '.item:hover',
        property: 'background-image',
        value: 'url("data:image/svg+xml;utf8,<svg>{}</svg>")',
        line: 7,
      },
      {
        rule: '.item',
        property: 'transition',
        value: 'none',
        line: 11,
      },
    ])
  })

  it('discovers every CSS Module recursively in stable path order', () => {
    const files = cssModuleFacts()
    const paths = files.map(({ path }) => path)

    expect(paths).toEqual([...paths].sort())
    expect(paths).toContain('src/App.module.css')
    expect(paths).toContain('src/components/plant-detail/PlantDetail.module.css')
    expect(paths).toContain('src/web/WebSpeciesCatalogPanel.module.css')
    expect(paths.length).toBeGreaterThan(21)
    expect(files.every(({ path, declarations }) =>
      declarations.every((declaration) => declaration.path === path),
    )).toBe(true)
  })

  it('does not treat token-plus-magic-length arithmetic as tokenization', () => {
    expect(acceptsSpacingComponent('calc(var(--space-1) - 1px)')).toBe(false)
    expect(acceptsRadiusComponent('calc(var(--radius-sm) - 2px)')).toBe(false)
    expect(acceptsFontDeclaration({
      path: 'src/fixture.module.css',
      rule: '.item',
      atRules: [],
      property: 'font-size',
      value: 'calc(var(--text-xs) - 1px)',
      line: 1,
      column: 1,
    })).toBe(false)
    expect(acceptsTransitionDeclaration({
      path: 'src/fixture.module.css',
      rule: '.item',
      atRules: [],
      property: '--transition-local',
      value: '200ms ease',
      line: 1,
      column: 1,
    })).toBe(false)

    const scopedOverride = [{
      path: 'src/fixture.module.css',
      declarations: parseCssDeclarations(
        'src/fixture.module.css',
        `.item {
          --space-1: 99px;
          --radius-sm: ;
          --transition-fast: /* intentionally empty */;
          padding: var(--space-1);
        }`,
      ),
    }]
    expect(collectCssPolicyViolations(scopedOverride, [CSS_MODULE_POLICIES[0]!])).toEqual([
      '[Design-scale tokens are declared globally] src/fixture.module.css:2 --space-1: 99px',
      '[Design-scale tokens are declared globally] src/fixture.module.css:3 --radius-sm: ',
      '[Design-scale tokens are declared globally] src/fixture.module.css:4 --transition-fast: ',
    ])
    expect(acceptsTransitionDeclaration({
      path: 'src/fixture.module.css',
      rule: '.item',
      atRules: [],
      property: 'transition',
      value: 'opacity ease',
      line: 1,
      column: 1,
    })).toBe(false)
    expect(acceptsSpacingComponent('calc(var(--space-1) + 1%)')).toBe(false)
    expect(acceptsSpacingComponent('calc(var(--space-1) + 1dvh)')).toBe(false)
    expect(acceptsSpacingComponent('calc(var(--space-1) + 1e2px)')).toBe(false)
    expect(acceptsSpacingComponent('var(--space-local)')).toBe(false)
    expect(acceptsSpacingComponent('calc(var(--space-1) * 999)')).toBe(false)
    expect(acceptsSpacingComponent('calc((999) * var(--space-1))')).toBe(false)
    expect(acceptsSpacingComponent('calc(var(--space-1) * calc(999))')).toBe(false)
    expect(acceptsSpacingComponent('calc(var(--space-1) * calc(-1 + -1))')).toBe(false)
    expect(acceptsSpacingComponent('calc(var(--space-1) * pi)')).toBe(false)
    expect(acceptsSpacingComponent('calc(var(--space-1) * -1)')).toBe(true)
    expect(acceptsFontDeclaration({
      path: 'src/fixture.module.css',
      rule: '.item',
      atRules: [],
      property: 'font-size',
      value: 'calc(var(--text-xs) * 999)',
      line: 1,
      column: 1,
    })).toBe(false)
    expect(acceptsFontDeclaration({
      path: 'src/fixture.module.css',
      rule: '.item',
      atRules: [],
      property: 'font',
      value: '600 var(--text-sm)/var(--line-height) var(--font-sans)',
      line: 1,
      column: 1,
    })).toBe(true)
    expect(acceptsRadiusComponent('calc(var(--radius-sm) * 999)')).toBe(false)
    expect(acceptsTransitionDeclaration({
      path: 'src/fixture.module.css',
      rule: '.item',
      atRules: [],
      property: 'transition-delay',
      value: 'calc(var(--transition-fast) + -150ms)',
      line: 1,
      column: 1,
    })).toBe(false)
    expect(acceptsTransitionDeclaration({
      path: 'src/fixture.module.css',
      rule: '.item',
      atRules: [],
      property: 'transition-duration',
      value: 'calc(var(--transition-fast) * 999)',
      line: 1,
      column: 1,
    })).toBe(false)
    expect(acceptsTransitionDeclaration({
      path: 'src/fixture.module.css',
      rule: '.item',
      atRules: [],
      property: 'transition-behavior',
      value: 'allow-discrete',
      line: 1,
      column: 1,
    })).toBe(true)
    expect(collectGlobalDesignTokenNames(`
      :root { --space-root: 1px; --Space-Case: 2px; }
      [data-theme='dark'] { --space-dark-only: 3px; }
      @media (min-width: 1px) { :root { --space-media-only: 4px; } }
    `)).toEqual(new Set(['--space-root', '--Space-Case']))
    expect(parseCssDeclarations(
      'src/fixture.module.css',
      '.item { --Space-Case: 2px; }',
    )[0]?.property).toBe('--Space-Case')
    expect(acceptsTransitionDeclaration({
      path: 'src/fixture.module.css',
      rule: '.item',
      atRules: [],
      property: 'transition-duration',
      value: 'calc(var(--transition-fast) + 150MS)',
      line: 1,
      column: 1,
    })).toBe(false)
  })

  it('rejects a raw colour in any property and a font weight other than 400 or 600', () => {
    const planted = [{
      path: 'src/fixture.module.css',
      declarations: parseCssDeclarations(
        'src/fixture.module.css',
        `.item {
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
          border: 1px solid #fff;
          color: white;
          background: var(--color-surface);
          white-space: nowrap;
          font-weight: 700;
          font-weight: 600 !important;
          font: 500 var(--text-sm) var(--font-sans);
          font: inherit;
        }`,
      ),
    }]
    expect(collectCssPolicyViolations(planted, CSS_MODULE_POLICIES.slice(-2))).toEqual([
      '[CSS Modules draw colour from tokens] src/fixture.module.css:2 box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2)',
      '[CSS Modules draw colour from tokens] src/fixture.module.css:3 border: 1px solid #fff',
      '[CSS Modules draw colour from tokens] src/fixture.module.css:4 color: white',
      '[CSS font weights are 400 or 600] src/fixture.module.css:7 font-weight: 700',
      '[CSS font weights are 400 or 600] src/fixture.module.css:9 font: 500 var(--text-sm) var(--font-sans)',
    ])
  })

  it('reads only colour tokens global.css defines, so no var(--color-*) silently draws nothing', () => {
    const undefinedReads = cssModuleFacts().flatMap((file) => {
      const local = new Set(file.declarations.map((declaration) => declaration.property))
      return file.declarations.flatMap((declaration) =>
        [...declaration.value.matchAll(/var\(\s*(--color-[\w-]+)/g)]
          .map((match) => match[1]!)
          .filter((token) => !GLOBAL_DESIGN_TOKEN_NAMES.has(token) && !local.has(token))
          .map((token) => `${file.path}:${declaration.line} ${declaration.property} reads ${token}`))
    })
    expect(undefinedReads).toEqual([])
  })

  it('canopi-eon8.14.3: sizes a box centred at its left edge (left plus translateX(-50%)) to max-content, so it wraps at its max-width, not half the room', () => {
    // Shrink-to-fit width is the containing block less `left`; the transform moves the box after layout, so without
    // an explicit width a box centred this way wraps at the room right of its centre (the lock toast did).
    const rules = new Map<string, CssDeclarationFact[]>()
    for (const file of cssModuleFacts()) {
      for (const declaration of file.declarations) {
        const key = `${file.path} ${declaration.atRules.join(' ')} ${declaration.rule}`
        rules.set(key, [...(rules.get(key) ?? []), declaration])
      }
    }
    const halfWidth = [...rules].filter(([, declarations]) => {
      const value = (property: string) => declarations.find((declaration) => declaration.property === property)?.value
      return /translateX?\(\s*-50%/.test(value('transform') ?? '') && value('left') !== undefined
        && value('max-width') !== undefined && value('width') === undefined
    }).map(([key]) => key)
    expect(halfWidth).toEqual([])
  })

  it('keeps every CSS Module on the shared design-token policies', () => {
    const files = cssModuleFacts()

    expect(collectCssPolicyViolations(files, CSS_MODULE_POLICIES)).toEqual([])
  })
})

function acceptsFontDeclaration({ property, value }: CssDeclarationFact): boolean {
  const normalized = value.trim()
  if (CSS_WIDE_VALUES.has(normalized)) return true
  return usesOnlyTokenFamily(
    normalized,
    '--text-',
    property === 'font' ? ['--font-', '--line-height'] : [],
  )
}

function acceptsFontWeightDeclaration({ property, value }: CssDeclarationFact): boolean {
  const normalized = value.replace(/\s*!important\s*$/i, '').trim()
  if (CSS_WIDE_VALUES.has(normalized)) return true
  if (property === 'font-weight') return ALLOWED_FONT_WEIGHTS.has(normalized)
  // The font shorthand may carry a weight among its components: a bare number or a weight keyword.
  return splitTopLevelComponents(normalized, true).every((component) =>
    !/^(?:\d+|bold|bolder|lighter)$/i.test(component) || ALLOWED_FONT_WEIGHTS.has(component))
}

function acceptsSpacingComponent(component: string): boolean {
  const normalized = component.trim()
  return normalized === '0'
    || normalized === 'auto'
    || normalized === 'normal'
    || CSS_WIDE_VALUES.has(normalized)
    || usesOnlyTokenFamily(normalized, '--space-')
}

function acceptsRadiusComponent(component: string): boolean {
  const normalized = component.trim()
  return normalized === '0'
    || /^\d+(?:\.\d+)?%$/.test(normalized)
    || CSS_WIDE_VALUES.has(normalized)
    || usesOnlyTokenFamily(normalized, '--radius-')
}

function acceptsTransitionDeclaration({ property, value }: CssDeclarationFact): boolean {
  const normalized = value.trim()
  if (CSS_WIDE_VALUES.has(normalized) || normalized === 'none') return true
  if (
    property === 'transition-property'
    || property === 'transition-timing-function'
    || property === 'transition-behavior'
  ) return true
  if (containsRawCssTime(normalized)) return false
  if (containsForbiddenUnitlessScaleArithmetic(normalized)) return false
  const variables = cssVariableNames(normalized)
  return variables.length > 0 && variables.every((name) =>
    name.startsWith('--transition-') && GLOBAL_DESIGN_TOKEN_NAMES.has(name),
  )
}

function usesOnlyTokenFamily(
  value: string,
  requiredPrefix: string,
  additionalPrefixes: readonly string[] = [],
): boolean {
  const variables = cssVariableNames(value)
  return !containsRawCssLength(value)
    && !containsForbiddenUnitlessScaleArithmetic(value)
    && variables.some((name) => name.startsWith(requiredPrefix))
    && variables.every((name) =>
      GLOBAL_DESIGN_TOKEN_NAMES.has(name)
      && (name.startsWith(requiredPrefix)
        || additionalPrefixes.some((prefix) => name.startsWith(prefix))),
    )
}

function containsRawCssLength(value: string): boolean {
  RAW_CSS_LENGTH_OR_PERCENTAGE.lastIndex = 0
  return RAW_CSS_LENGTH_OR_PERCENTAGE.test(value)
}

function containsRawCssTime(value: string): boolean {
  RAW_CSS_TIME.lastIndex = 0
  return RAW_CSS_TIME.test(value)
}

function containsForbiddenUnitlessScaleArithmetic(value: string): boolean {
  for (const expression of cssMathFunctionBodies(value)) {
    const operators = expression.match(/[*/]/g) ?? []
    if (operators.length === 0) continue
    if (operators.length !== 1 || operators[0] !== '*') return true

    const unitlessNumber = new RegExp(
      String.raw`(?:^|[^\w.-])(${CSS_NUMBER_SOURCE})(?![\w.%])`,
      'gi',
    )
    const numbers = [...expression.matchAll(unitlessNumber)].map((match) => Number(match[1]))
    if (numbers.length !== 1 || numbers[0] !== -1) return true
    if (!/\*\s*-1(?![\d.])|(?:^|[^\w.])-1\s*\*/.test(expression)) return true
  }
  return false
}

function cssMathFunctionBodies(value: string): string[] {
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

function collectGlobalDesignTokenNames(source: string): Set<string> {
  return new Set(
    parseCssDeclarations('src/styles/global.css', source)
      .filter(({ property, rule, atRules }) =>
        property.startsWith('--') && rule === ':root' && atRules.length === 0,
      )
      .map(({ property }) => property),
  )
}

function cssVariableNames(value: string): string[] {
  return Array.from(value.matchAll(/var\(\s*(--[\w-]+)/g), (match) => match[1]!)
}

function splitTopLevelComponents(value: string, splitSlash = false): string[] {
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
 * A stylesheet whose selector list is followed by another selector list instead
 * of a declaration block is malformed, and the failure is silent: the stylesheet
 * still parses, so every declaration in that rule simply stops applying.
 *
 * This happened for real. A bulk deletion of dead selectors removed a whole
 * `:focus-visible` rule, leaving its selector list dangling immediately before
 * the next rule. Nothing failed — the build was clean, the lint was clean, and
 * every CSS policy above passed — but focus outlines silently stopped rendering
 * on nine interactive controls, and that was reported as delivered. Selector
 * structure is therefore checked here rather than assumed.
 */
function dangleselectorLists(css: string): string[] {
  const findings: string[] = []
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  // Split into statements at top level only, so braces inside nested rules and
  // any prelude are handled correctly.
  const statements: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') {
      if (depth === 0) {
        statements.push(text.slice(start, index))
        start = index
      }
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) start = index + 1
    }
  }
  for (const statement of statements) {
    const prelude = statement.trim()
    if (!prelude) continue
    if (prelude.startsWith('@')) continue
    // A selector list is written as consecutive lines. A **blank line** inside a
    // prelude means two rules were merged: the declaration block that belonged to
    // the first selector list was deleted, so its selectors were absorbed by the
    // next rule. That is exactly how a bulk selector deletion silently disabled
    // the focus-outline rule here, and it leaves no other trace — the stylesheet
    // parses, the build is clean, and every declaration still typechecks.
    if (/\n\s*\n/.test(statement.replace(/^\s+/, ''))) {
      findings.push(prelude.replace(/\s+/g, ' ').slice(0, 120))
      continue
    }
    if (prelude.endsWith(',') || prelude.split(',').some((part) => part.trim() === '')) {
      findings.push(prelude.replace(/\s+/g, ' ').slice(0, 120))
    }
  }
  return findings
}

describe('CSS module structural integrity', () => {
  it('keeps every selector list attached to a declaration block', () => {
    const violations = cssModuleFacts()
      .flatMap(({ path }) => {
        const filePath = path.replace(/^src\//, 'src/')
        const css = readFileSync(resolve(filePath), 'utf8')
        return dangleselectorLists(css).map((prelude) => `${path}: ${prelude}`)
      })
    expect(violations).toEqual([])
  })
})

/** The Layers and Site data row files: one layer row look, shared (U49 Q7; architecture review finding 5). */
const LAYER_ROW_FILES = [
  { component: 'src/components/canvas/LayerPanel.tsx', module: 'src/components/canvas/LayerPanel.module.css' },
  { component: 'src/components/panels/lidar/SiteData.tsx', module: 'src/components/panels/lidar/site-data.module.css' },
] as const

/** An inset bar drawn with box-shadow: the open-row marker the shared module owns. */
const OPEN_BAR = /box-shadow:\s*inset\s/

describe('one layer row look in Layers and Site data', () => {
  it('both row files compose shared/layer-row.module.css and draw no open bar of their own', () => {
    const violations = LAYER_ROW_FILES.flatMap(({ component, module }) => [
      ...(/from '(?:\.\.\/)+(?:components\/)?shared\/layer-row\.module\.css'/.test(readFileSync(resolve(component), 'utf8'))
        ? []
        : [`${component} does not import shared/layer-row.module.css`]),
      ...(OPEN_BAR.test(readFileSync(resolve(module), 'utf8')) ? [`${module} draws its own open bar`] : []),
    ])

    expect(violations).toEqual([])
  })

  it('the shared module draws the open bar', () => {
    expect(OPEN_BAR.test(readFileSync(resolve('src/components/shared/layer-row.module.css'), 'utf8'))).toBe(true)
  })
})
