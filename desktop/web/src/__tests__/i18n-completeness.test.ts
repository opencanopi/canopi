import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { t } from '../i18n'

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

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/
const INTERPOLATES_COUNT = /\{\{\s*count\b/

/**
 * Strings that interpolate a count but agree with no counted word in any locale: "N of M", "label: N", "(N)", "+N".
 * A string here never needs plural forms; a new counted string is a plural family (`key_one`, `key_few`, `key_many`,
 * `key_other` in every locale) or joins this list with that shape.
 */
const COUNT_NEUTRAL = new Set([
  'canvas.budget.missingPrice',
  'canvas.calendar.currentSelection',
  'canvas.calendar.moreActions',
  'canvas.lidar.import.files',
  'canvas.lidar.library.deleteBlocked',
  'canvas.lidar.library.sourceFiles',
  'notice.count',
  'pdf.pageCount',
  'plantDetail.showAllNames',
  'plantFinder.selectedOnMapCount',
  'presentation.announce',
  'presentation.stepOf',
  'presentation.storyStep',
])

const english: TranslationTree = en

function leaves(tree: TranslationTree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]): [string, string][] =>
    typeof value === 'string' ? [[`${prefix}${key}`, value]] : leaves(value, `${prefix}${key}.`))
}

/** Each plural form a locale lacks: a counted string's family needs every category `Intl.PluralRules` names for it. */
function missingPluralForms(code: string, tree: TranslationTree): string[] {
  const entries = new Map(leaves(tree))
  const englishBases = leaves(english).map(([key]) => key).filter((key) => key.endsWith('_other')).map((key) => key.slice(0, -'_other'.length))
  const counted = new Set([
    ...[...entries].filter(([key, text]) => INTERPOLATES_COUNT.test(text) && !COUNT_NEUTRAL.has(key)).map(([key]) => key.replace(PLURAL_SUFFIX, '')),
    ...englishBases.filter((base) => [...entries.keys()].some((key) => key !== `${base}_other` && key.replace(PLURAL_SUFFIX, '') === base)),
  ])
  const forms = new Intl.PluralRules(code).resolvedOptions().pluralCategories
  return [...counted].flatMap((base) => forms.filter((form) => !entries.has(`${base}_${form}`)).map((form) => `${code}: ${base}_${form}`))
}

describe('plural forms', () => {
  it('canopi-f47t.52.43: APP-06: Russian counts use every plural form', () => {
    // The Saved stamps row summary as FavoritesPanel asks for it: one plural key per noun, the form picked from the count.
    const summary = (count: number) => [
      t('savedObjectStamps.summaryPlant', { count, lng: 'ru' }),
      t('savedObjectStamps.summaryZone', { count, lng: 'ru' }),
      t('savedObjectStamps.summaryAnnotation', { count, lng: 'ru' }),
    ].join(' · ')

    expect([1, 3, 5, 21, 22, 11].map(summary)).toEqual([
      '1 растение · 1 зона · 1 аннотация',
      '3 растения · 3 зоны · 3 аннотации',
      '5 растений · 5 зон · 5 аннотаций',
      '21 растение · 21 зона · 21 аннотация',
      '22 растения · 22 зоны · 22 аннотации',
      '11 растений · 11 зон · 11 аннотаций',
    ])
  })

  it('gives every counted string each plural form its locale names, in all 11 locales', () => {
    const all: Record<string, TranslationTree> = { en: english, ...locales }

    expect(Object.entries(all).flatMap(([code, tree]) => missingPluralForms(code, tree))).toEqual([])
  })

  it('finds a counted string with no plural forms, and a family missing a form its locale names', () => {
    expect(missingPluralForms('ru', { stamps: { summary: '{{count}} растений' } })).toEqual([
      'ru: stamps.summary_one', 'ru: stamps.summary_few', 'ru: stamps.summary_many', 'ru: stamps.summary_other',
    ])
    expect(missingPluralForms('ru', { stamps: { summary_one: '{{count}} растение', summary_other: '{{count}} растения' } }))
      .toEqual(['ru: stamps.summary_few', 'ru: stamps.summary_many'])
    expect(missingPluralForms('ja', { stamps: { summary_other: '{{count}} 件' } })).toEqual([])
    expect(missingPluralForms('ru', { notice: { count: '{{index}} из {{count}}' } })).toEqual([])
  })

  it('lists as count-neutral only strings English holds with a count', () => {
    const texts = new Map(leaves(english))

    expect([...COUNT_NEUTRAL].filter((key) => !INTERPOLATES_COUNT.test(texts.get(key) ?? ''))).toEqual([])
  })
})
