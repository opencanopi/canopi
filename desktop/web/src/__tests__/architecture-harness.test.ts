import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { collectCssPolicyViolations, discoverCssModuleFacts, parseCssDeclarations } from './support/architecture/css-facts'

describe('CSS architecture source facts', () => {
  it('parses multiline and commented declarations without treating comments as code', () => {
    const declarations = parseCssDeclarations('src/fixture.module.css', `
      .item {
        /* padding: 99px; */
        padding:
          var(--space-2)
          calc(var(--space-1) + 1px);
        transition:
          opacity var(--transition-fast),
          transform var(--transition-normal);
      }

      @media (prefers-reduced-motion: reduce) {
        .item { transition: none }
      }
    `)

    expect(declarations.map(({ property, value }) => ({ property, value }))).toEqual([
      {
        property: 'padding',
        value: 'var(--space-2)\n          calc(var(--space-1) + 1px)',
      },
      {
        property: 'transition',
        value: 'opacity var(--transition-fast),\n          transform var(--transition-normal)',
      },
      { property: 'transition', value: 'none' },
    ])
    expect(declarations.map(({ line }) => line)).toEqual([4, 7, 13])
  })

  it('requires tokenized declarations while honoring exact reviewed structural exceptions', () => {
    const files = [{
      path: 'src/fixture.module.css',
      declarations: parseCssDeclarations('src/fixture.module.css', `
        .good { padding: var(--space-2); transition: none; }
        .structural { border-radius: 0 1px 1px 0; }
        .bad { font-size: 13px; gap: 6px; transition: opacity 150ms ease; }
      `),
    }]

    expect(collectCssPolicyViolations(files, [
      {
        name: 'Font sizes use tokens',
        properties: ['font-size'],
        rawValue: /\d+(?:\.\d+)?px/,
        requiredValue: /var\(--/,
        exceptions: [],
      },
      {
        name: 'Spacing uses tokens',
        properties: ['padding*', 'margin*', 'gap', 'row-gap', 'column-gap'],
        rawValue: /\d+(?:\.\d+)?px/,
        requiredValue: /var\(--/,
        exceptions: [],
      },
      {
        name: 'Radii use tokens',
        properties: ['border-radius'],
        rawValue: /\d+(?:\.\d+)?px/,
        requiredValue: /var\(--/,
        exceptions: [{
          file: 'src/fixture.module.css',
          rule: '.structural',
          atRules: [],
          property: 'border-radius',
          value: '0 1px 1px 0',
          reason: 'One-pixel structural edge cap.',
        }],
      },
      {
        name: 'Transitions use tokens',
        properties: ['transition', 'transition-*'],
        rawValue: /\d+(?:\.\d+)?(?:ms|s)/,
        requiredValue: /var\(--/,
        exceptions: [],
      },
    ])).toEqual([
      '[Font sizes use tokens] src/fixture.module.css:4 font-size: 13px',
      '[Spacing uses tokens] src/fixture.module.css:4 gap: 6px',
      '[Transitions use tokens] src/fixture.module.css:4 transition: opacity 150ms ease',
    ])
  })

  it('fails closed for duplicate, unexplained, and unused CSS exceptions', () => {
    const files = [{
      path: 'src/fixture.module.css',
      declarations: parseCssDeclarations(
        'src/fixture.module.css',
        '.item { gap: 6px; }',
      ),
    }]
    const matchingException = {
      file: 'src/fixture.module.css',
      rule: '.item',
      atRules: [],
      property: 'gap',
      value: '6px',
      reason: '',
    }

    expect(collectCssPolicyViolations(files, [{
      name: 'Spacing uses tokens',
      properties: ['gap'],
      rawValue: /px/,
      requiredValue: /var\(--space-/,
      exceptions: [
        matchingException,
        { ...matchingException, reason: 'Duplicate exception.' },
        {
          ...matchingException,
          value: '7px',
          reason: 'No declaration should need this exception.',
        },
      ],
    }])).toEqual([
      '[Spacing uses tokens] CSS exception reason is empty: src/fixture.module.css|<root>|.item|gap|6px',
      '[Spacing uses tokens] duplicate CSS exception: src/fixture.module.css|<root>|.item|gap|6px',
      '[Spacing uses tokens] unused CSS exception: src/fixture.module.css|<root>|.item|gap|7px (No declaration should need this exception.)',
    ])
  })

  it('consumes CSS exceptions once and keeps at-rule contexts distinct', () => {
    const files = [{
      path: 'src/fixture.module.css',
      declarations: parseCssDeclarations('src/fixture.module.css', `
        .item { gap: 6px; }
        .item { gap: 6px; }
        @media (min-width: 1px) {
          .item { gap: 6px; }
        }
      `),
    }]

    expect(collectCssPolicyViolations(files, [{
      name: 'Spacing uses tokens',
      properties: ['gap'],
      rawValue: /px/,
      requiredValue: /var\(--space-/,
      exceptions: [{
        file: 'src/fixture.module.css',
        rule: '.item',
        atRules: [],
        property: 'gap',
        value: '6px',
        reason: 'One reviewed root declaration.',
      }],
    }])).toEqual([
      '[Spacing uses tokens] src/fixture.module.css:3 gap: 6px',
      '[Spacing uses tokens] src/fixture.module.css:5 gap: 6px',
    ])
    expect(files[0]?.declarations[2]?.atRules).toEqual(['@media (min-width: 1px)'])
  })
})


describe('CSS Module discovery', () => {
  it('orders mixed-case sibling paths by code units and retains every declaration', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'canopi-css-order-'))
    const root = join(temporary, 'src')
    try {
      for (const name of ['zebra', 'ZebraTools', 'alpha']) {
        mkdirSync(join(root, name), { recursive: true })
        writeFileSync(join(root, name, 'Style.module.css'), '.item { color: var(--ink); }')
      }
      writeFileSync(join(root, 'ignored.css'), '.ignored { color: red; }')
      const files = discoverCssModuleFacts(root)
      expect(files.map(file => file.path)).toEqual([
        'src/ZebraTools/Style.module.css', 'src/alpha/Style.module.css', 'src/zebra/Style.module.css',
      ])
      expect(files.map(file => file.declarations.map(({ path, rule, property, value }) => ({ path, rule, property, value })))).toEqual([
        [{ path: 'src/ZebraTools/Style.module.css', rule: '.item', property: 'color', value: 'var(--ink)' }],
        [{ path: 'src/alpha/Style.module.css', rule: '.item', property: 'color', value: 'var(--ink)' }],
        [{ path: 'src/zebra/Style.module.css', rule: '.item', property: 'color', value: 'var(--ink)' }],
      ])
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })
})
