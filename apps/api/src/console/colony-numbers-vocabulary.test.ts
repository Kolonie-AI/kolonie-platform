import { describe, expect, it } from 'vitest'
import type { ColonyNumbers } from '@kolonie-ai/db'
import { colonyNumbersSections } from './backend.js'

/**
 * The Colony's numbers stop naming a kind of account the Colony does not have
 * (`#468`).
 *
 * `kolonie-docs#184` settled that there are two kinds of account — a human
 * account and an agent — and that *sponsor* stays a role somebody plays in one
 * transaction while it stops naming an account, a page, a flag, an audience or a
 * table.
 *
 * **Asserted against the rendered sections rather than the source.** The source
 * still carries the retired phrase in the comments that record why it went, and
 * a test that failed on those would be a test nobody could keep.
 *
 * **This was `steward-vocabulary.test.ts` and it asked the same three questions
 * of `numbersPage`.** `#943` deleted that page; the rendering it wrapped is the
 * subject that survived, so the assertions moved to it rather than going with
 * the page.
 */
describe('the Colony’s numbers', () => {
  const numbers: ColonyNumbers = {
    accountsByPath: { web: 4, mcp: 21 },
    agentsByRuntime: { openclaw: 9, claude: 4 },
    modelFamilies: { 'gpt-5': 2 },
    modelsUndeclared: 21,
    citizens: 3,
    skillsGranted: { profile: 21 },
    questsByStatus: { active: 1 },
    smsYesterdayByCountry: { DE: 3 },
    acceptedQuestReports: { market: 1, intraSwarm: 0 },
    escrowHeld: 0,
    ledgerSum: 0,
    mintBalance: 0,
    permissionBlocks: [],
    computedAt: '2026-08-06T12:00:00.000Z' as ColonyNumbers['computedAt'],
  }

  /** The rejection case: the retired phrase, in any casing, on a rendered page. */
  it('names no sponsor account', () => {
    expect(colonyNumbersSections(numbers).toLowerCase()).not.toContain('sponsor account')
  })

  /**
   * **The category it named is real and still has to be nameable.** An identity
   * that arrived through the console and has climbed nothing is neither a
   * citizen nor a candidate, and `console-identity.ts` describes it exactly that
   * way — as an arrival and a standing, not as a kind of account.
   */
  it('still says what the third kind of identity is', () => {
    const sections = colonyNumbersSections(numbers)

    expect(sections).toContain('arrived through the console and has climbed nothing')
    expect(sections).toContain('candidate')
  })

  /** D-039's definition of a citizen is untouched: this issue moved words, not rules. */
  it('leaves the definition of a citizen exactly as it was', () => {
    const sections = colonyNumbersSections(numbers)

    expect(sections).toContain('D-039')
    expect(sections).toContain('a profile plus one skill whose verifier read something the Colony')
  })
})
