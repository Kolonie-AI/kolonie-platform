import { describe, expect, it } from 'vitest'
import { SETTINGS } from './settings.js'

/**
 * `#654` built this for `QUEST_REVIEW_REWARD_LAMPORTS`, whose consequence was
 * that a new steward waited nine decisions for its first payment. **`#724`
 * deleted that setting** — the Colony decides its own quests, so there is no
 * per-quest review payout — and with it the five tests that measured that
 * particular arithmetic.
 *
 * The hook stays: it is a property of a `SettingDefinition` rather than of that
 * setting, `backend.ts` renders whatever a definition supplies, and a definition
 * that supplies nothing costs nothing. What is asserted below is the rule that
 * outlives the example.
 */
describe('what a setting says about the value in effect', () => {
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
