import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import en from '../i18n/en.json'
import de from '../i18n/de.json'
import es from '../i18n/es.json'
import fr from '../i18n/fr.json'
import itLocale from '../i18n/it.json'
import ja from '../i18n/ja.json'
import ko from '../i18n/ko.json'
import nl from '../i18n/nl.json'
import pt from '../i18n/pt.json'
import ru from '../i18n/ru.json'
import zh from '../i18n/zh.json'

interface TranslationTree {
  [key: string]: string | TranslationTree
}

const locales: Record<string, TranslationTree> = {
  de,
  es,
  fr,
  it: itLocale,
  ja,
  ko,
  nl,
  pt,
  ru,
  zh,
}

function collectMissingKeys(
  source: TranslationTree,
  candidate: TranslationTree,
  prefix = '',
): string[] {
  const missing: string[] = []

  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key
    const candidateValue = candidate[key]

    if (candidateValue === undefined) {
      missing.push(path)
      continue
    }

    const sourceIsObject = typeof value === 'object' && value !== null
    const candidateIsObject = typeof candidateValue === 'object' && candidateValue !== null

    if (sourceIsObject && candidateIsObject) {
      missing.push(...collectMissingKeys(value as TranslationTree, candidateValue as TranslationTree, path))
      continue
    }

    if (sourceIsObject !== candidateIsObject) {
      missing.push(path)
    }
  }

  return missing
}

// A canvas tool's handle names reach screen readers as aria-labels, so they come from `ctx.translate`, never a literal.
const TOOLS_DIR = new URL('../canvas/runtime/tools/', import.meta.url)
// Matched against the whole file so a literal wrapped onto the next line is caught; either quote names aria-label.
const LITERAL_HANDLE_LABEL = /\blabel:\s*['"`]|setAttribute\(\s*['"`]aria-label['"`]\s*,\s*['"`]/g

// Reports the 1-based line of each literal handle label in a tool's source text.
function literalHandleLabelLines(source: string): number[] {
  return [...source.matchAll(LITERAL_HANDLE_LABEL)].map(
    (match) => source.slice(0, match.index).split('\n').length,
  )
}

function literalToolHandleLabels(): string[] {
  const found: string[] = []
  for (const name of readdirSync(TOOLS_DIR, { recursive: true }) as string[]) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
    for (const line of literalHandleLabelLines(readFileSync(new URL(name, TOOLS_DIR), 'utf8'))) {
      found.push(`${name.replace(/\\/g, '/')}:${line}`)
    }
  }
  return found.sort()
}

describe('i18n completeness', () => {
  it('names canvas tool handles through translate, never a literal aria-label', () => {
    expect(literalToolHandleLabels()).toEqual([])
  })

  it('finds a literal handle label in either quote style and when wrapped onto the next line', () => {
    expect(literalHandleLabelLines("el.setAttribute('aria-label', 'Endpoint')")).toEqual([1])
    expect(literalHandleLabelLines('el.setAttribute("aria-label", "Endpoint")')).toEqual([1])
    expect(literalHandleLabelLines('el.setAttribute(\n  "aria-label",\n  `Endpoint`,\n)')).toEqual([1])
    expect(literalHandleLabelLines("const a = 1\nconst handle = {\n  label:\n    'Zone control point 1',\n}")).toEqual([3])
    expect(literalHandleLabelLines("label: translate('canvas.handles.endpoint')")).toEqual([])
    expect(literalHandleLabelLines("el.setAttribute('aria-label', translate('canvas.handles.endpoint'))")).toEqual([])
  })


  for (const [locale, translations] of Object.entries(locales)) {
    it(`${locale} has exactly the english translation key tree`, () => {
      expect(collectMissingKeys(en as TranslationTree, translations)).toEqual([])
      expect(collectMissingKeys(translations, en as TranslationTree)).toEqual([])
    })
  }

  it('calls stamps tampons everywhere in French, never planches (garden beds)', () => {
    const values = JSON.stringify(fr)
    expect(values).not.toMatch(/planche/i)
    expect(fr.savedObjectStamps.title).toBe('Tampons enregistrés')
    expect(fr.canvas.tools.objectStamp).toBe('Placer un tampon')
    expect(fr.menu['edit.saveAsStamp']).toBe('Enregistrer comme tampon')
  })
})

describe('Russian plural forms', () => {
  it.fails('[1b-c6 canopi-f47t.52.43] APP-06: Russian counts use every plural form', () => {
    const leaves = (tree: TranslationTree, prefix = ''): [string, string][] =>
      Object.entries(tree).flatMap(([key, value]): [string, string][] =>
        typeof value === 'string' ? [[`${prefix}${key}`, value]] : leaves(value, `${prefix}${key}.`))
    const ruTree: TranslationTree = ru
    const russian = new Map(leaves(ruTree))
    const pluralSuffix = /_(zero|one|two|few|many|other)$/
    // A Russian string that interpolates a count: its key family needs one, few, many and other
    // (Intl.PluralRules('ru')), or "5 вида" reads where "5 видов" is right.
    const counted = new Set([...russian].filter(([, text]) => /\{\{\s*count\b/.test(text)).map(([key]) => key.replace(pluralSuffix, '')))
    const forms = new Intl.PluralRules('ru').resolvedOptions().pluralCategories
    const missing = [...counted].flatMap((base) => forms.filter((form) => !russian.has(`${base}_${form}`)).map((form) => `${base}_${form}`))
    expect(missing).toEqual([])
  })
})
