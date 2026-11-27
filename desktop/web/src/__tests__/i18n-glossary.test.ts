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

/*
 * The UI glossary (docs/guides/ui-glossary.md) is the authority for the words each locale uses
 * for Canopi's core terms, tools and panels. This suite holds the glossary tables so a new key
 * that names a panel or tool in other words fails here instead of shipping two names for one
 * thing. Change the table and the guide together.
 */

interface TranslationTree {
  [key: string]: string | TranslationTree
}

const LOCALES = ['fr', 'es', 'pt', 'it', 'de', 'nl', 'ru', 'zh', 'ja', 'ko'] as const
type Locale = (typeof LOCALES)[number]

const trees: Record<Locale, TranslationTree> = { fr, es, pt, it: itLocale, de, nl, ru, zh, ja, ko }

function flatten(tree: TranslationTree, prefix = ''): Map<string, string> {
  const entries = new Map<string, string>()
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') entries.set(path, value)
    else for (const [child, text] of flatten(value, path)) entries.set(child, text)
  }
  return entries
}

const english = flatten(en)
const flat = Object.fromEntries(LOCALES.map((code) => [code, flatten(trees[code])])) as Record<Locale, Map<string, string>>

type Terms = Record<Locale, string>
const terms = (fr: string, es: string, pt: string, it: string, de: string, nl: string, ru: string, zh: string, ja: string, ko: string): Terms =>
  ({ fr, es, pt, it, de, nl, ru, zh, ja, ko })

/** Tool and panel names, and the core terms that appear on their own as a label. */
const NAMES: Record<string, Terms> = {
  'Select': terms('Sélection', 'Seleccionar', 'Selecionar', 'Seleziona', 'Auswählen', 'Selecteren', 'Выделение', '选择', '選択', '선택'),
  'Pan': terms('Déplacer la vue', 'Desplazar', 'Mover a vista', 'Sposta la vista', 'Verschieben', 'Pannen', 'Панорама', '平移', 'パン', '이동'),
  'Place plants': terms('Placer des plantes', 'Colocar plantas', 'Colocar plantas', 'Colloca piante', 'Pflanzen setzen', 'Planten plaatsen', 'Разместить растения', '放置植物', '植物を配置', '식물 배치'),
  'Plant a row': terms('Planter une rangée', 'Plantar una fila', 'Plantar uma fileira', 'Pianta un filare', 'Eine Reihe pflanzen', 'Een rij planten', 'Посадить ряд', '种一行', '列に植える', '한 줄 심기'),
  'Place a stamp': terms('Placer un tampon', 'Colocar un sello', 'Colocar um carimbo', 'Colloca un timbro', 'Stempel setzen', 'Stempel plaatsen', 'Поставить штамп', '放置图章', 'スタンプを配置', '스탬프 배치'),
  'Zones': terms('Zones', 'Zonas', 'Zonas', 'Zone', 'Zonen', 'Zones', 'Зоны', '区域', 'ゾーン', '구역'),
  'Text note': terms('Note texte', 'Nota de texto', 'Nota de texto', 'Nota di testo', 'Textnotiz', 'Tekstnotitie', 'Текстовая заметка', '文本注释', 'テキストメモ', '텍스트 메모'),
  'Measure': terms('Mesurer', 'Medir', 'Medir', 'Misura', 'Messen', 'Meten', 'Измерить', '测量', '計測', '측정'),
  'Profile': terms('Profil', 'Perfil', 'Perfil', 'Profilo', 'Profil', 'Profiel', 'Профиль', '剖面图', '断面図', '단면도'),
  'Site data': terms('Données du site', 'Datos del lugar', 'Dados do local', 'Dati del sito', 'Standortdaten', 'Terreindata', 'Данные участка', '场地数据', '敷地データ', '부지 데이터'),
  'Layers': terms('Calques', 'Capas', 'Camadas', 'Livelli', 'Ebenen', 'Lagen', 'Слои', '图层', 'レイヤー', '레이어'),
  'Plants in this Design': terms('Plantes de ce Design', 'Plantas de este diseño', 'Plantas deste design', 'Piante di questo progetto', 'Pflanzen in diesem Design', 'Planten in dit ontwerp', 'Растения в этом проекте', '此设计中的植物', 'このデザインの植物', '이 디자인의 식물'),
  'Favorites and stamps': terms('Favoris et tampons', 'Favoritos y sellos', 'Favoritos e carimbos', 'Preferiti e timbri', 'Favoriten und Stempel', 'Favorieten en stempels', 'Избранное и штампы', '收藏与图章', 'お気に入りとスタンプ', '즐겨찾기와 스탬프'),
  'Calendar': terms('Calendrier', 'Calendario', 'Calendário', 'Calendario', 'Kalender', 'Kalender', 'Календарь', '日历', 'カレンダー', '달력'),
  'Budget': terms('Budget', 'Presupuesto', 'Orçamento', 'Budget', 'Budget', 'Budget', 'Бюджет', '预算', '予算', '예산'),
  'Design notebook': terms('Carnet de Designs', 'Cuaderno de diseños', 'Caderno de designs', 'Quaderno dei progetti', 'Design-Notizbuch', 'Ontwerpnotitieboek', 'Блокнот проектов', '设计笔记本', 'デザインノート', '디자인 노트북'),
  'Stories': terms('Récits', 'Relatos', 'Histórias', 'Racconti', 'Geschichten', 'Verhalen', 'Истории', '故事', 'ストーリー', '이야기'),
  'Consortium': terms('Consortium', 'Consorcio', 'Consórcio', 'Consorzio', 'Konsortium', 'Consortium', 'Консорциум', '联合体', 'コンソーシアム', '컨소시엄'),
  'Saved stamps': terms('Tampons enregistrés', 'Sellos guardados', 'Carimbos salvos', 'Timbri salvati', 'Gespeicherte Stempel', 'Opgeslagen stempels', 'Сохранённые штампы', '已保存图章', '保存済みスタンプ', '저장된 스탬프'),
  'Favorites': terms('Favoris', 'Favoritos', 'Favoritos', 'Preferiti', 'Favoriten', 'Favorieten', 'Избранное', '收藏', 'お気に入り', '즐겨찾기'),
  'Plant catalog': terms('Catalogue des plantes', 'Catálogo de plantas', 'Catálogo de plantas', 'Catalogo delle piante', 'Pflanzenkatalog', 'Plantencatalogus', 'Каталог растений', '植物目录', '植物カタログ', '식물 카탈로그'),
  'Data library': terms('Bibliothèque de données', 'Biblioteca de datos', 'Biblioteca de dados', 'Libreria dati', 'Datenbibliothek', 'Databibliotheek', 'Библиотека данных', '数据资料库', 'データライブラリ', '데이터 라이브러리'),
  'Codes': terms('Codes', 'Códigos', 'Códigos', 'Codici', 'Kürzel', 'Codes', 'Коды', '代码', 'コード', '코드'),
}

/** Labels whose English text is a tool name but whose meaning is the verb, not the tool. */
const VERB_LABELS = new Set(['speciesKey.select'])

/**
 * Panel names inside a sentence, as a pattern per locale. Russian inflects the name, so its
 * pattern accepts the case endings.
 */
const NAMES_IN_SENTENCES: Record<string, { english: RegExp; locale: Terms }> = {
  'Plant catalog': {
    english: /plant catalog/i,
    locale: terms(
      'catalogue des plantes', 'catálogo de plantas', 'catálogo de plantas', 'catalogo delle piante', 'pflanzenkatalog',
      'plantencatalogus', 'каталог\\S* растений', '植物目录', '植物カタログ', '식물 카탈로그',
    ),
  },
  'Data library': {
    english: /data library/i,
    locale: terms(
      'bibliothèque de données', 'biblioteca de datos', 'biblioteca de dados', 'libreria dati', 'datenbibliothek',
      'databibliotheek', 'библиотек\\S* данных', '数据资料库', 'データライブラリ', '데이터 라이브러리',
    ),
  },
}

/** The stem of the stratum term; every string that speaks of a stratum uses it. */
const STRATUM_STEMS = terms('strate', 'estrato', 'estrato', 'strat', 'schicht', 'etage', 'ярус', '层次', '階層', '층위')

describe('UI glossary', () => {
  it('names every tool and panel with the glossary words wherever the English label is that name', () => {
    const disagreements: string[] = []
    for (const [key, text] of english) {
      const expected = NAMES[text]
      if (!expected || VERB_LABELS.has(key)) continue
      for (const code of LOCALES) {
        const actual = flat[code].get(key)
        if (actual !== expected[code]) disagreements.push(`${code} ${key}: "${actual}" (glossary: "${expected[code]}")`)
      }
    }
    expect(disagreements).toEqual([])
  })

  it('keeps a panel name as written inside a sentence', () => {
    const disagreements: string[] = []
    for (const [name, { english: pattern, locale }] of Object.entries(NAMES_IN_SENTENCES)) {
      for (const [key, text] of english) {
        if (!pattern.test(text)) continue
        for (const code of LOCALES) {
          const actual = flat[code].get(key) ?? ''
          if (!new RegExp(locale[code], 'iu').test(actual)) disagreements.push(`${code} ${key}: "${actual}" does not name ${name}`)
        }
      }
    }
    expect(disagreements).toEqual([])
  })

  it('says stratum with one word per locale', () => {
    const disagreements: string[] = []
    for (const [key, text] of english) {
      // A string that only carries the stratum as a value ({{stratum}}) need not repeat the word.
      if (!/strat(um|a)/i.test(text) || text.includes('{{stratum}}')) continue
      for (const code of LOCALES) {
        const actual = flat[code].get(key) ?? ''
        if (!actual.toLowerCase().includes(STRATUM_STEMS[code])) disagreements.push(`${code} ${key}: "${actual}"`)
      }
    }
    expect(disagreements).toEqual([])
  })

  it('covers every tool and panel key with a glossary row', () => {
    const uncovered = [...english]
      .filter(([key]) => /^canvas\.tools\.|^panelRail\./.test(key))
      // Zone shapes are sub-tools and the rail's own controls are not panels.
      .filter(([key]) => !/^canvas\.tools\.(rectangle|ellipse|polygon|line)$|^panelRail\.(label|more|canvas)$/.test(key))
      .filter(([, text]) => !(text in NAMES))
      .map(([key, text]) => `${key}: "${text}"`)
    expect(uncovered).toEqual([])
  })
})
