// The one TS redactor runs the shared corpus Rust runs (contracts §13 Redaction, 2.1-M434), keeps text with nothing
// to redact, is idempotent and total, and caps its input so a multi-MB stack costs one bounded, linear scan.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import shared from '../../../../canopi-types/fixtures/redaction/shared.json'
import { CREDENTIAL_NAMES } from '../generated/redaction'
import { redact } from './redact'

// failures/redact.ts's input cap.
const MAX_REDACT_INPUT = 64 * 1024

describe('TS redaction', () => {
  it('[1b-c1 canopi-f47t.52.37] redaction corpus: shared cases redact to their expected text', () => {
    const wrong = shared.cases.filter((c) => redact(c.input) !== c.expected).map((c) => `${c.id} (${c.shape}): ${redact(c.input)}`)
    expect(wrong).toEqual([])
  })

  it('[1b-c1 canopi-f47t.52.37] redaction keeps text with nothing to redact and is idempotent', () => {
    expect(() => {
      fc.assert(fc.property(fc.stringMatching(/^[A-Za-z0-9 ,.;!?()-]{0,80}$/), (text) => redact(text) === text))
      fc.assert(fc.property(fc.string(), (text) => redact(redact(text)) === redact(text)))
      fc.assert(fc.property(fc.string({ unit: 'binary' }), (text) => typeof redact(text) === 'string'))
    }).not.toThrow()
  })

  it('canopi-f47t.52.167: a planted path or credential never survives, whatever surrounds it', () => {
    const planted = fc.constantFrom(
      ['/home/ana/Secret Garden/plan.canopi', 'Secret'],
      [String.raw`D:\Plans\Secret Orchard.canopi`, 'Secret'],
      [String.raw`\\nas\shared\Secret.canopi`, 'Secret'],
      ['file:///Users/ana/Secret.canopi', 'Secret'],
      ...CREDENTIAL_NAMES.map((name) => [`${name}=PLANTEDSECRET`, 'PLANTEDSECRET'] as const),
    )
    const prose = fc.stringMatching(/^[A-Za-z ,.!?-]{0,30}$/)
    expect(() => fc.assert(fc.property(prose, planted, prose, (before, [secret, marker], after) =>
      !redact(`${before} ${secret} ${after}`).includes(marker)))).not.toThrow()
  })

  it('multi-MB stack: the input is capped and no secret survives at the cut', () => {
    const frames = 'at frame (app.js:1:1)\n'.repeat(Math.ceil(MAX_REDACT_INPUT / 20))
    const tail = 'x'.repeat(2_000_000)
    for (const secret of ['?key=AIzaSECRETVALUE', ' /home/ana/SECRETDIR/plan.canopi', ' "key": "AIzaSECRETVALUE"', String.raw` \\nas\SECRETSHARE\x`]) {
      // The cut falls inside the secret at every offset: what is left before it is still recognised and redacted.
      for (let offset = 1; offset < secret.length; offset += 1) {
        const redacted = redact(`${frames.slice(0, MAX_REDACT_INPUT - offset)}${secret}${tail}`)
        // Capped: only the tokens that replace a cut secret may grow it.
        expect(redacted.length).toBeLessThan(MAX_REDACT_INPUT + 16)
        expect(redacted).not.toMatch(/AIzaS|SECRETDIR|SECRETSHARE|SECRETVA/)
      }
    }
  })

  it('stays linear on hostile input: many path starts with no end', () => {
    const hostile = ' /a'.repeat(MAX_REDACT_INPUT / 3)
    const started = performance.now()
    redact(hostile)
    redact(`${' /a b'.repeat(MAX_REDACT_INPUT / 5)}`)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('keeps the error reason that follows a path', () => {
    expect(redact('Failed to read /media/alice/USB Drive/Secret Orchard.canopi: No such file or directory'))
      .toBe('Failed to read <path>: No such file or directory')
  })
})
