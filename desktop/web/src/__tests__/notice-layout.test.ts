import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// A notice carries long text (a file path in a failure message) beside up to two buttons in a 320 px side panel.
const css = readFileSync('src/components/shared/Notice.module.css', 'utf8')
const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{(?<body>[^}]*)\\}`).exec(css)?.groups?.body ?? ''

it('a notice wraps its actions under the text when they do not fit beside it (canopi-6spu)', () => {
  const notice = rule('.notice')
  expect(notice).toMatch(/flex-wrap: wrap;/)
  expect(notice).toMatch(/align-items: flex-start;/)
  expect(rule('.action')).toMatch(/margin-left: auto;/)
})

it('a notice wraps its buttons onto a second line when their labels are wider than the notice (canopi-6spu, French at 320 px)', () => {
  const action = rule('.action')
  expect(action).toMatch(/flex-wrap: wrap;/)
  expect(action).toMatch(/max-width: 100%;/)
})

it('a notice keeps its buttons at the right edge when they wrap onto a second line (canopi-6spu, French at 320 px)', () => {
  // At full width margin-left: auto has no free space to use, so the buttons themselves are pushed right.
  expect(rule('.action')).toMatch(/justify-content: flex-end;/)
})

it('a notice breaks a long word such as a file path and keeps a readable width before wrapping (canopi-6spu)', () => {
  const body = rule('.body')
  expect(body).toMatch(/overflow-wrap: anywhere;/)
  expect(body).toMatch(/flex: 1 1 \d+px;/)
  expect(body).toMatch(/min-width: 0;/)
})

it('a notice keeps its text beside the icon at a large browser font size (canopi-6spu, root 24 px in a 320 px dock)', () => {
  // Text is sized in px tokens; a rem flex-basis follows the browser default size and pushes the text under the icon.
  const basis = /flex: 1 1 (?<px>\d+)px;/.exec(rule('.body'))?.groups?.px
  expect(basis).toBeDefined()
  // 320 px dock content (about 268 px) minus an 18 px icon and the 10 px gap.
  expect(Number(basis)).toBeLessThanOrEqual(268 - 18 - 10)
})
