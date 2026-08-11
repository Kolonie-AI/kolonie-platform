import { describe, expect, it } from 'vitest'
import { RENT_EXEMPT_MINIMUM_FALLBACK } from '../ledger/transfer.js'
import { QUEST_REVIEW_REWARD_LAMPORTS } from '../task/quest.js'
import { SETTINGS, settingNamed } from './settings.js'

/**
 * `#654`. A dial whose consequence is arithmetic somebody has to do by hand is a
 * dial that gets turned without it: `#651` cut the review reward tenfold — the
 * right call — and moved a new steward's first payout from one decision to nine,
 * silently.
 */
describe('what a setting says about the value in effect', () => {
  const consequenceOf = (value: string | undefined): string | undefined =>
    settingNamed('QUEST_REVIEW_REWARD_LAMPORTS')?.consequence?.(value)

  it('counts the decisions a new steward waits, and names the chain’s figure', () => {
    const said = consequenceOf('100000')

    expect(said).toContain('9 decisions')
    expect(said).toContain(String(RENT_EXEMPT_MINIMUM_FALLBACK))
  })

  /**
   * The case that is live rather than hypothetical: unset, the code falls back to
   * a figure that is itself below the minimum, and a warning that waited for
   * somebody to type a number would be silent about exactly that.
   */
  it('reads the code fallback when nothing has been set', () => {
    expect(QUEST_REVIEW_REWARD_LAMPORTS).toBeLessThan(RENT_EXEMPT_MINIMUM_FALLBACK)
    expect(consequenceOf(undefined)).toBe(consequenceOf(String(QUEST_REVIEW_REWARD_LAMPORTS)))
  })

  it('says nothing where one decision already clears the minimum', () => {
    expect(consequenceOf('1000000')).toBeUndefined()
    expect(consequenceOf(String(RENT_EXEMPT_MINIMUM_FALLBACK))).toBeUndefined()
  })

  /**
   * The rejection case the issue names outright: **not a floor on the setting.**
   * A maintainer may have a good reason to pay below the chain minimum — the
   * accrual works and the money is not lost — and refusing the value would be the
   * tool holding an opinion about economics it does not have.
   */
  it('is a consequence and not a refusal', () => {
    const setting = settingNamed('QUEST_REVIEW_REWARD_LAMPORTS')

    expect(setting?.schema.safeParse('100000').success).toBe(true)
    expect(setting?.schema.safeParse('1').success).toBe(true)
    expect(consequenceOf('1')).toContain('consequence and not a refusal')
  })

  /** A value the form will not accept has nothing to be said about it. */
  it('stays quiet about a value the schema would reject', () => {
    for (const rejected of ['', '0', '-5', 'nine', '1.5']) {
      expect(consequenceOf(rejected)).toBeUndefined()
    }
  })

  /**
   * The hook is optional and stays that way. Every other setting has no
   * consequence to state, and one that acquired an empty string would be a note
   * on a page saying nothing.
   */
  it('is stated only where there is something to state', () => {
    for (const setting of SETTINGS) {
      if (setting.consequence === undefined) continue
      expect(setting.consequence(undefined)).not.toBe('')
    }
  })
})
