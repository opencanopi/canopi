// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  normalizeRichTextLink,
  renderRichTextInto,
  richTextFirstLine,
  richTextFromDom,
  richTextFromHtml,
  richTextFromPlainText,
  richTextPlainText,
} from '../app/stories/rich-text'
import type { RichTextBlock } from '../types/design'

const span = (text: string, marks: { bold?: boolean; italic?: boolean; link?: string | null } = {}) => ({
  text, bold: marks.bold ?? false, italic: marks.italic ?? false, link: marks.link ?? null,
})

describe('rich text from pasted HTML', () => {
  it('keeps paragraphs, bullets, bold, italic and allowed links, and nothing else', () => {
    const blocks = richTextFromHtml(`
      <h2>Berry <i>hedges</i></h2>
      <p style="color: red" onclick="alert(1)">Two <b>hedges</b> of <strong><em>goji</em></strong>,
        see <a href="https://example.org/goji" target="_blank">the notes</a>.</p>
      <ul><li>Year one</li><li><span style="font-weight: 700">Year two</span></li></ul>
      <ol><li>Numbered</li></ol>
      <script>alert(1)</script><style>p { color: red }</style>
      <img src="x" onerror="alert(1)"><iframe src="https://evil.example"></iframe>
      <p><a href="javascript:alert(1)">bad link</a> and <a href="mailto:a@example.org">mail</a></p>
    `)
    expect(blocks).toEqual<RichTextBlock[]>([
      { kind: 'paragraph', spans: [span('Berry ', { bold: true }), span('hedges', { bold: true, italic: true })] },
      { kind: 'paragraph', spans: [
        span('Two '), span('hedges', { bold: true }), span(' of '), span('goji', { bold: true, italic: true }),
        span(', see '), span('the notes', { link: 'https://example.org/goji' }), span('.'),
      ] },
      { kind: 'bullets', items: [{ spans: [span('Year one')] }, { spans: [span('Year two', { bold: true })] }] },
      { kind: 'bullets', items: [{ spans: [span('Numbered')] }] },
      { kind: 'paragraph', spans: [span('bad link and '), span('mail', { link: 'mailto:a@example.org' })] },
    ])
    expect(JSON.stringify(blocks)).not.toMatch(/script|alert|style|onclick|iframe|evil|javascript/)
  })

  it('reads line breaks as new paragraphs and ignores the normal weight Google Docs wraps around a paste', () => {
    expect(richTextFromHtml('<b style="font-weight:normal"><span>One</span><br><span style="font-style:italic">Two</span></b>'))
      .toEqual([
        { kind: 'paragraph', spans: [span('One')] },
        { kind: 'paragraph', spans: [span('Two', { italic: true })] },
      ])
  })

  it('reads plain text as paragraphs and dash lines as bullets', () => {
    expect(richTextFromPlainText('The site\r\n\n- water\n• shade\nEnd')).toEqual([
      { kind: 'paragraph', spans: [span('The site')] },
      { kind: 'bullets', items: [{ spans: [span('water')] }, { spans: [span('shade')] }] },
      { kind: 'paragraph', spans: [span('End')] },
    ])
  })
})

describe('rich text in an editor', () => {
  it('renders blocks as DOM nodes and reads them back unchanged', () => {
    const blocks: RichTextBlock[] = [
      { kind: 'paragraph', spans: [span('Two '), span('hedges', { bold: true }), span(' shelter', { italic: true, link: 'https://example.org' })] },
      { kind: 'bullets', items: [{ spans: [span('Year one')] }] },
    ]
    const root = document.createElement('div')
    renderRichTextInto(root, blocks)
    expect(root.querySelector('strong')?.textContent).toBe('hedges')
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.org')
    expect(root.querySelectorAll('ul > li')).toHaveLength(1)
    expect(richTextFromDom(root)).toEqual(blocks)
  })

  it('renders text that looks like HTML as text', () => {
    const root = document.createElement('div')
    renderRichTextInto(root, [{ kind: 'paragraph', spans: [span('<img src=x onerror=alert(1)>')] }])
    expect(root.querySelector('img')).toBeNull()
    expect(root.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('never renders a link with another scheme', () => {
    const root = document.createElement('div')
    renderRichTextInto(root, [{ kind: 'paragraph', spans: [span('x', { link: 'javascript:alert(1)' })] }])
    expect(root.querySelector('a')).toBeNull()
  })

  it('keeps an empty editor editable with one empty paragraph', () => {
    const root = document.createElement('div')
    renderRichTextInto(root, [])
    expect(root.innerHTML).toBe('<p></p>')
    expect(richTextFromDom(root)).toEqual([])
  })

  it('reads what browsers write while typing: divs, line breaks and styled spans', () => {
    const root = document.createElement('div')
    root.innerHTML = 'First<div>Second <span style="font-weight: bold;">bold</span></div><div><br></div><div>Third</div>'
    expect(richTextFromDom(root)).toEqual([
      { kind: 'paragraph', spans: [span('First')] },
      { kind: 'paragraph', spans: [span('Second '), span('bold', { bold: true })] },
      { kind: 'paragraph', spans: [span('Third')] },
    ])
  })
})

describe('rich text summaries and links', () => {
  it('gives the plain text and the first line', () => {
    const blocks: RichTextBlock[] = [
      { kind: 'bullets', items: [{ spans: [span('  ')] }, { spans: [span('Water '), span('first', { bold: true })] }] },
      { kind: 'paragraph', spans: [span('Then shade')] },
    ]
    expect(richTextPlainText(blocks)).toBe('  \nWater first\nThen shade')
    expect(richTextFirstLine(blocks)).toBe('Water first')
    expect(richTextFirstLine([])).toBe('')
  })

  it('normalizes typed links to an allowed scheme or refuses them', () => {
    expect(normalizeRichTextLink(' https://example.org/a ')).toBe('https://example.org/a')
    expect(normalizeRichTextLink('HTTP://example.org')).toBe('HTTP://example.org')
    expect(normalizeRichTextLink('example.org/goji?x=1')).toBe('https://example.org/goji?x=1')
    expect(normalizeRichTextLink('www.example.org')).toBe('https://www.example.org')
    expect(normalizeRichTextLink('jp@example.org')).toBe('mailto:jp@example.org')
    expect(normalizeRichTextLink('mailto:jp@example.org')).toBe('mailto:jp@example.org')
    for (const refused of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'hello', '', 'a b.org', '/relative']) {
      expect(normalizeRichTextLink(refused)).toBeNull()
    }
  })
})
