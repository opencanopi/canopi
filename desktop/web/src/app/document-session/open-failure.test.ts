import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../../i18n'
import { ringEntries, resetFrontendDiagnosticsForTests } from '../../failures/ring'
import { reportFailure, resetFailureNoticesForTests } from '../../failures/report'
import { designLoadFailureOf } from '../contracts/canopi-design-errors'
import { locale } from '../settings/state'
import { presentDesignOpenFailure, registerDesignOpenFailurePresenter } from './open-failure'

const FIELD_PATH = '$.plants[0].canonical_name'
const refused = {
  kind: 'invalid_document',
  message: 'expected a string',
  field_path: FIELD_PATH,
} as const

describe('a refused Design', () => {
  const presenter = vi.fn()

  beforeEach(() => {
    locale.value = 'en'
    presenter.mockReset()
    resetFrontendDiagnosticsForTests()
    resetFailureNoticesForTests()
    registerDesignOpenFailurePresenter(presenter)
  })

  afterEach(() => {
    registerDesignOpenFailurePresenter(null)
  })

  it('canopi-f47t.52.36: a refused Design: field path in the report, not on screen', () => {
    expect(designLoadFailureOf(refused)).toEqual(refused)

    presentDesignOpenFailure(refused)

    expect(presenter).toHaveBeenCalledTimes(1)
    const notice = presenter.mock.calls[0]![0]
    const shown = [JSON.stringify(notice), t(notice.title), t(notice.message)].join('\n')
    expect(shown).not.toContain(FIELD_PATH)
    expect(t(notice.message)).toBe(t('start.cantReadDamaged'))

    const entries = ringEntries()
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry).toMatchObject({ origin: 'frontend', source: 'design.load', code: { kind: 'invalid' }, surfaced: true })
    expect(entry.origin === 'frontend' ? entry.text : '').toContain(FIELD_PATH)
  })

  it('without a presenter is still recorded, as not told', () => {
    registerDesignOpenFailurePresenter(null)
    presentDesignOpenFailure(refused)
    expect(ringEntries()).toMatchObject([{ source: 'design.load', surfaced: false }])
  })

  it('keeps one entry for a failure already in the ring, now marked told', () => {
    const settled = new Error('boom')
    reportFailure(settled, { shown: 'none', source: 'ipc.load_design' })
    presentDesignOpenFailure(settled)
    expect(ringEntries()).toMatchObject([{ source: 'ipc.load_design', surfaced: true }])
  })

  it('canopi-f47t.52.36: a refused open the command graph reports again keeps its one typed entry', () => {
    const rejected = { ...refused }
    presentDesignOpenFailure(rejected)
    // The open command rethrows the same object; the command graph's catch reports it untold.
    reportFailure(rejected, { shown: 'none', source: 'command:Open design' })
    const entries = ringEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ source: 'design.load', code: { kind: 'invalid' }, surfaced: true })
    expect(entries[0]!.origin === 'frontend' ? entries[0]!.text : '').toContain(FIELD_PATH)
  })

  it('records each load failure kind under its catalogue code', () => {
    presentDesignOpenFailure({ kind: 'missing', message: 'nothing at the path' })
    presentDesignOpenFailure({ kind: 'newer_version', message: 'version 11', field_path: '$.version' })
    expect(ringEntries().map((entry) => entry.code)).toEqual([{ kind: 'io', io: 'not_found' }, { kind: 'invalid' }])
  })
})
