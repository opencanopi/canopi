import { isAllowedRichTextLink } from '../contracts/views-admission'
import type { RichTextBlock, RichTextSpan } from '../../types/design'

// Portable rich text (`RichTextBlock`) for story steps: paragraphs and bullet
// lists of spans that are bold, italic or links. Nothing here keeps HTML: an
// editor's DOM or pasted HTML is read into blocks, which keep only text, the
// three marks and links with an allowed scheme; everything else (scripts,
// styles, images, attributes, unknown elements) is dropped or read as text.

type Marks = { bold: boolean; italic: boolean; link: string | null }

const PLAIN: Marks = { bold: false, italic: false, link: null }

const BLOCK_ELEMENTS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION',
  'TABLE', 'TR', 'DL', 'DT', 'DD', 'ADDRESS', 'HR',
])
const LIST_ELEMENTS = new Set(['UL', 'OL'])
/** Elements whose content is never text for a reader. */
const SKIPPED_ELEMENTS = new Set([
  'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH',
  'CANVAS', 'VIDEO', 'AUDIO', 'IMG', 'PICTURE', 'SOURCE', 'HEAD', 'TITLE', 'META', 'LINK',
  'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA',
])

export { isAllowedRichTextLink }

/**
 * What a typed link becomes: an allowed link as is, an e-mail address as
 * `mailto:`, a bare web address as `https:`; null for anything else.
 */
export function normalizeRichTextLink(input: string): string | null {
  const link = input.trim()
  if (link.length === 0 || /\s/.test(link)) return null
  if (isAllowedRichTextLink(link)) return link
  if (/^[^@/:]+@[^@/:]+\.[^@/:]+$/.test(link)) return `mailto:${link}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(link)) return null
  if (/^[^/.][^/]*\.[a-z]{2,}(?:[/?#].*)?$/i.test(link)) return `https://${link}`
  return null
}

/**
 * Reads a DOM tree into blocks. An editor's own DOM keeps its runs of spaces
 * (`preserveSpaces`); HTML from elsewhere reads source whitespace as one space.
 */
export function richTextFromDom(root: Node, { preserveSpaces = false }: { readonly preserveSpaces?: boolean } = {}): RichTextBlock[] {
  const reader = new BlockReader(preserveSpaces)
  reader.readChildren(root, PLAIN)
  return reader.finish()
}

/** Reads pasted HTML into blocks, in an inert document that runs and loads nothing. */
export function richTextFromHtml(html: string): RichTextBlock[] {
  const document = new DOMParser().parseFromString(html, 'text/html')
  return richTextFromDom(document.body)
}

/** Plain text as paragraphs, one per line; lines starting with "- ", "* " or "• " become bullets. */
export function richTextFromPlainText(text: string): RichTextBlock[] {
  const blocks: RichTextBlock[] = []
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const bullet = /^\s*(?:[-*•])\s+(.*)$/.exec(line)
    const content = bullet ? bullet[1]! : line
    if (content.trim().length === 0) continue
    const spans = [{ text: content, bold: false, italic: false, link: null }]
    const last = blocks.at(-1)
    if (bullet && last?.kind === 'bullets') last.items.push({ spans })
    else if (bullet) blocks.push({ kind: 'bullets', items: [{ spans }] })
    else blocks.push({ kind: 'paragraph', spans })
  }
  return blocks
}

/** The text of the blocks without marks, one line per paragraph or item. */
export function richTextPlainText(blocks: readonly RichTextBlock[]): string {
  return blocks.flatMap((block) => block.kind === 'paragraph'
    ? [spansText(block.spans)]
    : block.items.map((item) => spansText(item.spans))).join('\n')
}

/** The first line of text, for a one-line summary. */
export function richTextFirstLine(blocks: readonly RichTextBlock[]): string {
  return richTextPlainText(blocks).split('\n').find((line) => line.trim().length > 0)?.trim() ?? ''
}

/** Whether two block lists hold the same text and marks. */
export function sameRichText(a: readonly RichTextBlock[], b: readonly RichTextBlock[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Replaces the content of an editor element with the blocks, built from DOM
 * nodes (never HTML strings): `<p>` paragraphs and `<ul><li>` bullets, with
 * `<strong>`, `<em>` and `<a href>` marks.
 */
export function renderRichTextInto(root: HTMLElement, blocks: readonly RichTextBlock[]): void {
  const document = root.ownerDocument
  root.replaceChildren(...blocks.map((block) => {
    if (block.kind === 'paragraph') {
      const paragraph = document.createElement('p')
      appendSpans(paragraph, block.spans)
      return paragraph
    }
    const list = document.createElement('ul')
    for (const item of block.items) {
      const entry = document.createElement('li')
      appendSpans(entry, item.spans)
      list.append(entry)
    }
    return list
  }))
  if (root.childNodes.length === 0) root.append(document.createElement('p'))
}

function appendSpans(parent: ParentNode, spans: readonly RichTextSpan[]): void {
  const document = (parent as Node).ownerDocument ?? (parent as Document)
  for (const span of spans) {
    let node: Node = document.createTextNode(span.text)
    if (span.italic) node = wrap(document, 'em', node)
    if (span.bold) node = wrap(document, 'strong', node)
    if (span.link && isAllowedRichTextLink(span.link)) {
      const anchor = document.createElement('a')
      anchor.href = span.link
      anchor.append(node)
      node = anchor
    }
    parent.append(node)
  }
  if (spans.length === 0 && parent instanceof Element) parent.append(document.createElement('br'))
}

function wrap(document: Document, tag: string, child: Node): Node {
  const element = document.createElement(tag)
  element.append(child)
  return element
}

function spansText(spans: readonly RichTextSpan[]): string {
  return spans.map((span) => span.text).join('')
}

class BlockReader {
  private readonly blocks: RichTextBlock[] = []
  private line: RichTextSpan[] = []
  /** The bullet list a list item is being read into, if any. */
  private list: { kind: 'bullets'; items: { spans: RichTextSpan[] }[] } | null = null

  constructor(private readonly preserveSpaces: boolean) {}

  readChildren(node: Node, marks: Marks): void {
    for (const child of Array.from(node.childNodes)) this.read(child, marks)
  }

  finish(): RichTextBlock[] {
    this.breakLine()
    this.closeList()
    return this.blocks
  }

  private read(node: Node, marks: Marks): void {
    if (node.nodeType === Node.TEXT_NODE) {
      this.text(node.textContent ?? '', marks)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    const tag = element.tagName.toUpperCase()
    if (SKIPPED_ELEMENTS.has(tag)) return
    if (tag === 'BR') {
      this.breakLine()
      return
    }
    if (LIST_ELEMENTS.has(tag)) {
      this.breakLine()
      const outer = this.list
      if (!outer) this.list = { kind: 'bullets', items: [] }
      this.readChildren(element, marks)
      this.breakLine()
      if (!outer) this.closeList()
      return
    }
    if (tag === 'LI') {
      this.breakLine()
      if (!this.list) this.list = { kind: 'bullets', items: [] }
      this.readChildren(element, marks)
      this.breakLine()
      return
    }
    const inner = marksOf(element, marks)
    if (BLOCK_ELEMENTS.has(tag)) {
      this.breakLine()
      // A block inside a list item reads as more lines of that list.
      if (this.list && !element.closest('li')) this.closeList()
      this.readChildren(element, inner)
      this.breakLine()
      return
    }
    this.readChildren(element, inner)
  }

  private text(value: string, marks: Marks): void {
    // Source whitespace (newlines and runs of spaces in HTML) reads as one
    // space; a no-break space is a space.
    const text = (this.preserveSpaces ? value.replace(/[\t\n\r\f]/g, ' ') : value.replace(/[\t\n\r\f ]+/g, ' '))
      .replace(/\u00A0/g, ' ')
    if (text.length === 0) return
    const last = this.line.at(-1)
    if (last && last.bold === marks.bold && last.italic === marks.italic && last.link === marks.link) {
      last.text += text
      return
    }
    this.line.push({ text, bold: marks.bold, italic: marks.italic, link: marks.link })
  }

  private breakLine(): void {
    const spans = trimLine(this.line)
    this.line = []
    if (spans.length === 0) return
    if (this.list) this.list.items.push({ spans })
    else this.blocks.push({ kind: 'paragraph', spans })
  }

  private closeList(): void {
    if (this.list && this.list.items.length > 0) this.blocks.push(this.list)
    this.list = null
  }
}

/** Drops the line's leading and trailing blanks and any span left empty. */
function trimLine(spans: RichTextSpan[]): RichTextSpan[] {
  if (spans.length === 0) return spans
  const first = spans[0]!
  first.text = first.text.replace(/^ +/, '')
  const last = spans.at(-1)!
  last.text = last.text.replace(/ +$/, '')
  return spans.filter((span) => span.text.length > 0)
}

function marksOf(element: Element, inherited: Marks): Marks {
  const tag = element.tagName.toUpperCase()
  const style = element.getAttribute('style') ?? ''
  const weight = /font-weight\s*:\s*(\w+)/i.exec(style)?.[1]?.toLowerCase()
  const fontStyle = /font-style\s*:\s*(\w+)/i.exec(style)?.[1]?.toLowerCase()
  let bold = inherited.bold || tag === 'B' || tag === 'STRONG' || /^h[1-6]$/i.test(tag)
    || weight === 'bold' || weight === 'bolder' || Number(weight) >= 600
  let italic = inherited.italic || tag === 'I' || tag === 'EM' || fontStyle === 'italic'
  // Google Docs wraps its paste in `<b style="font-weight:normal">`.
  if (weight === 'normal' || weight === '400') bold = tag === 'STRONG' ? bold : false
  if (fontStyle === 'normal') italic = false
  let link = inherited.link
  if (tag === 'A') {
    const href = element.getAttribute('href')?.trim() ?? ''
    link = href.length > 0 && isAllowedRichTextLink(href) ? href : null
  }
  return { bold, italic, link }
}
