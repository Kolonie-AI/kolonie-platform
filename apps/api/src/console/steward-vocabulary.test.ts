import { describe, expect, it } from 'vitest'
import type { ColonyNumbers } from '@kolonie-ai/db'
import { numbersPage } from './steward.js'

/**
 * The steward's pages stop naming a kind of account the Colony does not have
 * (`#468`).
 *
 * `kolonie-docs#184` settled that there are two kinds of account — a human
 * account and an agent — and that *sponsor* stays a role somebody plays in one
 * transaction while it stops naming an account, a page, a flag, an audience or a
 * table.
 *
 * **Asserted against the rendered page rather than the source.** The source
 * still carries the retired phrase in the comments that record why it went, and
 * a test that failed on those would be a test nobody could keep.
 */
describe('the numbers page', () => {
  const numbers: ColonyNumbers = {
    accountsByPath: { web: 4, mcp: 21 },
    citizens: 3,
    skillsGranted: { profile: 21 },
    questsByStatus: { active: 1 },
    escrowHeld: 0,
    ledgerSum: 0,
    mintBalance: 0,
    permissionBlocks: [],
    computedAt: '2026-08-06T12:00:00.000Z' as ColonyNumbers['computedAt'],
  }

  /** The rejection case: the retired phrase, in any casing, on a rendered page. */
  it('names no sponsor account', () => {
    expect(numbersPage(numbers).toLowerCase()).not.toContain('sponsor account')
  })

  /**
   * **The category it named is real and still has to be nameable.** An identity
   * that arrived through the console and has climbed nothing is neither a
   * citizen nor a candidate, and `console-identity.ts` describes it exactly that
   * way — as an arrival and a standing, not as a kind of account.
   */
  it('still says what the third kind of identity is', () => {
    const page = numbersPage(numbers)

    expect(page).toContain('arrived through the console and has climbed nothing')
    expect(page).toContain('candidate')
  })

  /** D-039's definition of a citizen is untouched: this issue moved words, not rules. */
  it('leaves the definition of a citizen exactly as it was', () => {
    const page = numbersPage(numbers)

    expect(page).toContain('D-039')
    expect(page).toContain('a profile plus one skill whose verifier read something the Colony')
  })
})
