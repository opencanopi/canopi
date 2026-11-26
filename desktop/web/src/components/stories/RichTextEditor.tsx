import type { ComponentChildren } from 'preact'
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import {
  normalizeRichTextLink,
  renderRichTextInto,
  richTextFromDom,
  richTextFromHtml,
  richTextFromPlainText,
  sameRichText,
} from '../../app/stories'
import { ariaKeyShortcuts, formatShortcut } from '../../app/shell-commands/shortcut-text'
import { t } from '../../i18n'
import type { RichTextBlock, RichTextSpan } from '../../types/design'
import { ButtonTooltip } from '../shared/ButtonTooltip'
import { ControlIcon, type ControlIconName } from '../shared/ControlIcon'
import styles from './RichTextEditor.module.css'

// A small editor over `RichTextBlock`: paragraphs, bullets, bold, italic and
// links, on a `contenteditable` element. The DOM is read back into blocks on
// every input, so nothing but the block model is ever stored. Paste and drop
// (at the drop point) are read into blocks first (never inserted as HTML), and the editor is
// rebuilt from the blocks it was given only when they differ from what it
// last reported, so typing never loses the caret.

const CARET = ''

export function RichTextEditor({ value, onChange, label, placeholder, trailingTools }: {
  readonly value: readonly RichTextBlock[]
  onChange(blocks: RichTextBlock[]): void
  readonly label: string
  readonly placeholder?: string
  /** More toolbar buttons after the text tools (Add image). */
  readonly trailingTools?: ComponentChildren
}) {
  const root = useRef<HTMLDivElement>(null)
  const reported = useRef<readonly RichTextBlock[] | null>(null)
  const savedRange = useRef<Range | null>(null)
  /** Text being dragged from inside the editor, removed when it is dropped here. */
  const dragged = useRef<Range | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [empty, setEmpty] = useState(value.length === 0)

  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    if (reported.current && sameRichText(reported.current, value)) return
    renderRichTextInto(element, value)
    reported.current = value
    setEmpty(value.length === 0)
  }, [value])

  function report(): void {
    const element = root.current
    if (!element) return
    const blocks = richTextFromDom(element, { preserveSpaces: true })
    setEmpty(blocks.length === 0)
    if (reported.current && sameRichText(reported.current, blocks)) return
    reported.current = blocks
    onChange(blocks)
  }

  /**
   * Inserts blocks at `range`. A paste replaces the selection; a drop lands at
   * the drop point and removes only the text it moved from inside the editor.
   */
  function insert(blocks: RichTextBlock[], range: Range, moved: Range | null = null): void {
    const element = root.current
    if (!element || blocks.length === 0) return
    range.insertNode(element.ownerDocument.createTextNode(CARET))
    moved?.deleteContents()
    const merged = insertAtCaret(richTextFromDom(element, { preserveSpaces: true }), blocks)
    renderRichTextInto(element, merged)
    placeCaret(element)
    report()
  }

  function onPaste(event: ClipboardEvent): void {
    const data = event.clipboardData
    const element = root.current
    if (!data || !element) return
    event.preventDefault()
    const html = data.getData('text/html')
    const range = selectionRangeIn(element) ?? endRange(element)
    range.deleteContents()
    insert(html ? richTextFromHtml(html) : richTextFromPlainText(data.getData('text/plain')), range)
  }

  function onDragStart(): void {
    const element = root.current
    const range = element ? selectionRangeIn(element) : null
    dragged.current = range && !range.collapsed ? range : null
  }

  function onDrop(event: DragEvent): void {
    const data = event.dataTransfer
    const element = root.current
    if (!data || !element) return
    event.preventDefault()
    const moved = dragged.current
    dragged.current = null
    const html = data.getData('text/html')
    const blocks = html ? richTextFromHtml(html) : richTextFromPlainText(data.getData('text/plain'))
    const point = dropRangeIn(element, event) ?? endRange(element)
    // Text dropped back onto itself stays where it is.
    if (moved && moved.comparePoint(point.startContainer, point.startOffset) === 0) return
    insert(blocks, point, moved)
  }

  function format(command: 'bold' | 'italic' | 'insertUnorderedList'): void {
    root.current?.focus()
    // Browsers toggle the mark or list on the selection; the input that
    // follows is read back into blocks like typing.
    if (typeof document.execCommand === 'function') document.execCommand(command, false)
    report()
  }

  function openLink(): void {
    const element = root.current
    savedRange.current = element ? selectionRangeIn(element) : null
    setLinkOpen(true)
  }

  function applyLink(link: string | null): void {
    const element = root.current
    setLinkOpen(false)
    if (!element) return
    const range = savedRange.current ?? endRange(element)
    savedRange.current = null
    if (link === null) {
      unwrapLinks(element, range)
    } else {
      const anchor = element.ownerDocument.createElement('a')
      anchor.href = link
      if (range.collapsed) anchor.textContent = link.replace(/^mailto:/i, '')
      else anchor.append(range.extractContents())
      // Links never nest: an anchor inside the new one keeps only its text.
      for (const inner of Array.from(anchor.querySelectorAll('a'))) inner.replaceWith(...Array.from(inner.childNodes))
      range.insertNode(anchor)
    }
    report()
    element.focus()
  }

  const labelId = useId()

  return (
    <div className={styles.editor}>
      <span className={styles.label} id={labelId}>{label}</span>
      <div className={styles.toolbar} role="toolbar" aria-label={t('stories.formatting')}>
        <ToolButton icon="bold" label={t('stories.bold')} shortcut={formatShortcut('Ctrl+B', t)} keyShortcuts={ariaKeyShortcuts('Ctrl+B')} onRun={() => format('bold')} />
        <ToolButton icon="italic" label={t('stories.italic')} shortcut={formatShortcut('Ctrl+I', t)} keyShortcuts={ariaKeyShortcuts('Ctrl+I')} onRun={() => format('italic')} />
        <ToolButton icon="list" label={t('stories.bullets')} onRun={() => format('insertUnorderedList')} />
        <ToolButton icon="link" label={t('stories.link')} pressed={linkOpen} onRun={openLink} />
        {trailingTools}
      </div>
      {linkOpen && <LinkForm onApply={applyLink} onCancel={() => { setLinkOpen(false); root.current?.focus() }} />}
      <div
        ref={root}
        className={styles.surface}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-labelledby={labelId}
        data-placeholder={placeholder}
        data-empty={empty ? 'true' : undefined}
        data-rich-text-editor
        spellcheck
        onInput={report}
        onFocusOut={report}
        onPaste={onPaste}
        onDragStart={onDragStart}
        onDragEnd={() => { dragged.current = null }}
        onDrop={onDrop}
      />
    </div>
  )
}

function ToolButton({ icon, label, onRun, pressed, shortcut, keyShortcuts }: {
  readonly icon: ControlIconName
  readonly label: string
  onRun(): void
  readonly pressed?: boolean
  readonly shortcut?: string
  readonly keyShortcuts?: string
}) {
  return (
    <button
      type="button"
      className={styles.tool}
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={keyShortcuts}
      // Keep the text selection: the command acts on it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRun}
    >
      <ControlIcon name={icon} size={16} />
      <ButtonTooltip label={label} shortcut={shortcut} side="bottom" />
    </button>
  )
}

function LinkForm({ onApply, onCancel }: { onApply(link: string | null): void; onCancel(): void }) {
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const hintId = useId()
  useLayoutEffect(() => { field.current?.focus() }, [])
  return (
    <form
      className={styles.linkForm}
      onSubmit={(event) => {
        event.preventDefault()
        const link = normalizeRichTextLink(draft)
        if (!link) {
          setInvalid(true)
          field.current?.focus()
          return
        }
        onApply(link)
      }}
    >
      <input
        ref={field}
        className={styles.linkField}
        type="text"
        inputMode="url"
        aria-label={t('stories.linkField')}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? hintId : undefined}
        placeholder="https://"
        value={draft}
        onInput={(event) => { setDraft(event.currentTarget.value); setInvalid(false) }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }}
      />
      <button type="submit" className={styles.linkButton}>{t('stories.linkApply')}</button>
      <button type="button" className={styles.linkButton} onClick={() => onApply(null)}>{t('stories.linkRemove')}</button>
      {invalid && <span className={styles.linkHint} id={hintId} role="alert">{t('stories.linkInvalid')}</span>}
    </form>
  )
}

function selectionRangeIn(element: HTMLElement): Range | null {
  const selection = element.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  return element.contains(range.commonAncestorContainer) ? range.cloneRange() : null
}

/** The collapsed caret position under the drop point, when it lies in the editor. */
function dropRangeIn(element: HTMLElement, event: DragEvent): Range | null {
  const document = element.ownerDocument as Document & {
    caretRangeFromPoint?(x: number, y: number): Range | null
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null
  }
  let range: Range | null = null
  if (typeof document.caretPositionFromPoint === 'function') {
    const position = document.caretPositionFromPoint(event.clientX, event.clientY)
    if (position) {
      range = document.createRange()
      range.setStart(position.offsetNode, position.offset)
    }
  } else if (typeof document.caretRangeFromPoint === 'function') {
    range = document.caretRangeFromPoint(event.clientX, event.clientY)
  }
  if (!range || !element.contains(range.startContainer)) return null
  range.collapse(true)
  return range
}

function endRange(element: HTMLElement): Range {
  const range = element.ownerDocument.createRange()
  const last = element.lastElementChild
  range.selectNodeContents(last && last.tagName !== 'UL' ? last : element)
  range.collapse(false)
  return range
}

/** Removes every link the range touches, keeping its text. */
function unwrapLinks(element: HTMLElement, range: Range): void {
  for (const anchor of Array.from(element.querySelectorAll('a'))) {
    if (range.intersectsNode(anchor)) anchor.replaceWith(...Array.from(anchor.childNodes))
  }
}

/** Puts the caret where the marker is and removes the marker. */
function placeCaret(element: HTMLElement): void {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const at = text.data.indexOf(CARET)
    if (at === -1) continue
    text.deleteData(at, 1)
    const selection = element.ownerDocument.getSelection()
    if (!selection) return
    const range = element.ownerDocument.createRange()
    range.setStart(text, at)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    return
  }
}

/**
 * Inserts pasted blocks where the caret marker is. One pasted paragraph joins
 * the line it lands in; more blocks split that line around them. Inside a
 * bullet list, pasted lines become items. The marker ends up after the paste.
 */
export function insertAtCaret(blocks: readonly RichTextBlock[], pasted: readonly RichTextBlock[]): RichTextBlock[] {
  const result: RichTextBlock[] = []
  let inserted = false
  for (const block of blocks) {
    if (inserted || !blockHasCaret(block)) {
      result.push(block)
      continue
    }
    inserted = true
    if (block.kind === 'bullets') {
      const items: { spans: RichTextSpan[] }[] = []
      for (const item of block.items) {
        const split = splitAtCaret(item.spans)
        if (!split) {
          items.push(item)
          continue
        }
        const lines = pastedLines(pasted)
        if (lines.length === 1) {
          items.push({ spans: [...split.before, ...lines[0]!, caretSpan(), ...split.after] })
          continue
        }
        items.push({ spans: [...split.before, ...lines[0]!] })
        for (const line of lines.slice(1, -1)) items.push({ spans: line })
        items.push({ spans: [...lines.at(-1)!, caretSpan(), ...split.after] })
      }
      result.push({ kind: 'bullets', items })
      continue
    }
    const split = splitAtCaret(block.spans)!
    if (pasted.length === 1 && pasted[0]!.kind === 'paragraph') {
      result.push({ kind: 'paragraph', spans: [...split.before, ...pasted[0]!.spans, caretSpan(), ...split.after] })
      continue
    }
    if (split.before.length > 0) result.push({ kind: 'paragraph', spans: split.before })
    result.push(...pasted.slice(0, -1))
    const last = pasted.at(-1)!
    if (last.kind === 'paragraph') {
      result.push({ kind: 'paragraph', spans: [...last.spans, caretSpan()] })
    } else {
      const items = [...last.items]
      items[items.length - 1] = { spans: [...items.at(-1)!.spans, caretSpan()] }
      result.push({ kind: 'bullets', items })
    }
    if (split.after.length > 0) result.push({ kind: 'paragraph', spans: split.after })
  }
  if (!inserted) result.push(...pasted)
  return result
}

function caretSpan(): RichTextSpan {
  return { text: CARET, bold: false, italic: false, link: null }
}

function blockHasCaret(block: RichTextBlock): boolean {
  return block.kind === 'paragraph'
    ? block.spans.some((span) => span.text.includes(CARET))
    : block.items.some((item) => item.spans.some((span) => span.text.includes(CARET)))
}

function splitAtCaret(spans: readonly RichTextSpan[]): { before: RichTextSpan[]; after: RichTextSpan[] } | null {
  const index = spans.findIndex((span) => span.text.includes(CARET))
  if (index === -1) return null
  const span = spans[index]!
  const at = span.text.indexOf(CARET)
  const head = { ...span, text: span.text.slice(0, at) }
  const tail = { ...span, text: span.text.slice(at + CARET.length) }
  return {
    before: [...spans.slice(0, index), ...(head.text ? [head] : [])],
    after: [...(tail.text ? [tail] : []), ...spans.slice(index + 1)],
  }
}

function pastedLines(pasted: readonly RichTextBlock[]): RichTextSpan[][] {
  return pasted.flatMap((block) => block.kind === 'paragraph' ? [block.spans] : block.items.map((item) => item.spans))
}
