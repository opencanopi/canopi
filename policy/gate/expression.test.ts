import { describe, expect, it } from 'vitest'
import { evaluate, holdsIf, interpolate } from './expression.ts'

const github = {
  event_name: 'pull_request', run_id: 77, workflow: 'Mutation',
  event: { action: 'synchronize', pull_request: { number: 12, draft: false, labels: [{ name: 'bug' }, { name: 'Mutation' }] } },
}

describe('GitHub expressions as the runner reads them', () => {
  it('returns an operand from && and ||, so `a && b || c` picks a value', () => {
    expect(evaluate("github.event_name == 'push' && github.run_id || github.event.pull_request.number", { github })).toBe(12)
    expect(evaluate("github.event_name == 'pull_request' && github.run_id || 3", { github })).toBe(77)
    expect(evaluate('github.missing.deeper || 0', { github })).toBe(0)
  })

  it('compares strings ignoring case, other types as numbers, and filters arrays with .*', () => {
    expect(evaluate("contains(github.event.pull_request.labels.*.name, 'mutation')", { github })).toBe(true)
    expect(evaluate("!contains(github.event.pull_request.labels.*.name, 'docs')", { github })).toBe(true)
    expect(evaluate("github.event.action == 'SYNCHRONIZE'", { github })).toBe(true)
    expect(evaluate("github.event.pull_request.draft == 0 && null == ''", { github })).toBe(true)
    expect(evaluate("contains(fromJSON('[\"opened\",\"reopened\"]'), github.event.action)", { github })).toBe(false)
    expect(evaluate("format('{0}-{1}', github.workflow, github['run_id'])", { github })).toBe('Mutation-77')
  })

  it('reads an if: with or without ${{ }} and fills a value\'s expressions', () => {
    expect(holdsIf("${{ github.event_name != 'push' }}", { github })).toBe(true)
    expect(holdsIf('github.event.pull_request.draft', { github })).toBe(false)
    expect(holdsIf(undefined, { github })).toBe(true)
    expect(interpolate('${{ github.workflow }}-${{ github.event.pull_request.number }}', { github })).toBe('Mutation-12')
  })

  it('throws on what it cannot read, never reading it as false', () => {
    expect(() => evaluate("hashFiles('x')", { github })).toThrow('no function hashFiles')
    expect(() => evaluate('github.run_id ==', { github })).toThrow('expected more')
    expect(() => evaluate('a ; b', {})).toThrow('cannot read')
  })
})
