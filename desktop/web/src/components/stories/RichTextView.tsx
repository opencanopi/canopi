import { isAllowedRichTextLink } from '../../app/stories'
import type { RichTextBlock, RichTextSpan } from '../../types/design'

/**
 * Renders story rich text for reading: paragraphs, bullet lists, bold, italic
 * and links (opened in a new window, only with an allowed scheme). The blocks
 * are data, never HTML, so nothing here can inject markup.
 */
export function RichTextView({ blocks, className }: { readonly blocks: readonly RichTextBlock[]; readonly className?: string }) {
  if (blocks.length === 0) return null
  return (
    <div className={className}>
      {blocks.map((block, index) => block.kind === 'paragraph'
        ? <p key={index}><Spans spans={block.spans} /></p>
        : (
          <ul key={index}>
            {block.items.map((item, itemIndex) => <li key={itemIndex}><Spans spans={item.spans} /></li>)}
          </ul>
        ))}
    </div>
  )
}

function Spans({ spans }: { readonly spans: readonly RichTextSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        let content: preact.ComponentChildren = span.text
        if (span.italic) content = <em>{content}</em>
        if (span.bold) content = <strong>{content}</strong>
        if (span.link && isAllowedRichTextLink(span.link)) {
          content = <a href={span.link} target="_blank" rel="noopener noreferrer">{content}</a>
        }
        return <span key={index}>{content}</span>
      })}
    </>
  )
}
