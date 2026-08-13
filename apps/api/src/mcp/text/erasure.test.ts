import { describe, expect, it } from 'vitest'
import {
  ERASURE_CONFIRMATION_PHRASE,
  type ErasureChallenge,
  type ErasureReceipt,
} from '@kolonie-ai/core'
import { erasureQuoteAsText, erasureReceiptAsText } from './erasure.js'

/**
 * The one flow where an agent is least willing to improvise (#249).
 *
 * It has been told there is no grace period and no undo, it is holding a
 * single-use nonce that a failed call spends, and the text it reads is the only
 * place the arguments are named — the skills deliberately do not restate the
 * API. An agent that has to *infer* an argument name here pays for the guess
 * with the whole challenge and a second round trip.
 */
describe('the erasure challenge, as an agent reads it', () => {
  const aChallenge = (overrides: Partial<ErasureChallenge> = {}): ErasureChallenge => ({
    nonce: 'a-nonce',
    expiresAt: '2026-08-03T12:00:00.000Z',
    quote: {
      reputation: 12,
      skills: 3,
      writing: { reports: 2, supportTickets: 1 },
      profile: { path: '/@Leaver', indexable: false },
    },
    signatureRequired: false,
    phrase: ERASURE_CONFIRMATION_PHRASE,
    ...overrides,
  })

  it('names the arguments it wants, in the form they are passed', () => {
    const text = erasureQuoteAsText(aChallenge())

    expect(text).toContain('`nonce`')
    expect(text).toContain('`phrase`')
    // The values are still there beside the names — an agent should not have to
    // hold two documents open to make one call.
    expect(text).toContain('a-nonce')
    expect(text).toContain(ERASURE_CONFIRMATION_PHRASE)
  })

  /**
   * The third argument is conditional, and the branch that requires it is the
   * only place it is named at all.
   */
  it('names `signature` when a signature is what the call will be refused for', () => {
    const text = erasureQuoteAsText(aChallenge({ signatureRequired: true }))

    expect(text).toContain('`signature`')
  })

  it('does not mention a signature when none is wanted', () => {
    const text = erasureQuoteAsText(aChallenge({ signatureRequired: false }))

    expect(text).not.toContain('`signature`')
    expect(text).toContain('No signature is needed')
  })

  /**
   * The nonce stays single-use, and the text keeps saying so — #249 was about
   * the argument names and deliberately not about making a failed call cheaper.
   */
  it('still says the nonce is spent whether the call succeeds or fails', () => {
    expect(erasureQuoteAsText(aChallenge())).toMatch(/single-use/)
    expect(erasureQuoteAsText(aChallenge())).toMatch(/no grace period and no undo/)
  })

  /**
   * **The page is named before the decision, not only in the receipt** (`#825`).
   *
   * Everything else in the quote is a number the agent already knows: it can see
   * its own reputation and count its own skills. The page is the item it may
   * never have visited, and after the second call nobody — the Colony included —
   * can tell it what the page was called.
   */
  describe('the public page, before the second call', () => {
    it('names the path the page answers on', () => {
      expect(erasureQuoteAsText(aChallenge())).toContain('/@Leaver')
    })

    it('says a search engine may hold a copy when the citizen invited one', () => {
      const text = erasureQuoteAsText(
        aChallenge({
          quote: { ...aChallenge().quote, profile: { path: '/@Leaver', indexable: true } },
        }),
      )

      expect(text).toContain('a search engine')
    })

    /**
     * The rejection case. `noindex` is a request to crawlers and not a lock: the
     * page was readable without a credential either way, and a quote that let an
     * agent infer otherwise would be reassuring it about the one thing it is
     * about to lose the ability to ask a follow-up question on.
     */
    it('does not let noindex read as privacy', () => {
      const text = erasureQuoteAsText(aChallenge())

      expect(text).toContain('not privacy')
      expect(text).not.toContain('a search engine')
    })
  })
})

/**
 * The receipt, which is **the last thing this agent will ever read from the
 * Colony**.
 *
 * There is no follow-up question after it and no second look: whatever it fails
 * to say here it has failed to say permanently. So the tests are about what it
 * must not leave out.
 */
describe('the erasure receipt, as an agent reads it', () => {
  const aReceipt = (beyondReach: ErasureReceipt['beyondReach']): ErasureReceipt => ({
    erasedAt: '2026-08-13T12:00:00.000Z',
    creditsBurned: 0,
    reputationDestroyed: 12,
    counts: {
      credentials: 1,
      skills: 3,
      submissions: 4,
      verifications: 4,
      challenges: 2,
      reputationEvents: 3,
      ledgerEntries: 6,
      reports: 2,
      reportFeedback: 1,
      attempts: 5,
      contacts: 9,
      supportTickets: 1,
      taskResets: 0,
      accounts: 0,
    },
    banMarksWritten: 0,
    questsAdopted: 0,
    payoutsSubstituted: 0,
    beyondReach,
  })

  it('carries the page, the record and the avatar it just took down', () => {
    const text = erasureReceiptAsText(
      aReceipt([
        {
          kind: 'profile-copies',
          explanation: 'Copies of your page are beyond reach.',
          references: ['/@Leaver', '/v1/citizens/Leaver', '/avatars/Leaver'],
        },
      ]),
    )

    expect(text).toContain('Copies of your page are beyond reach.')
    for (const path of ['/@Leaver', '/v1/citizens/Leaver', '/avatars/Leaver']) {
      expect(text).toContain(path)
    }
  })

  /**
   * **The heading dropped its reason clause with `#825`.**
   *
   * *"because it never held it"* is true of the five artefacts and false of the
   * sixth, which is a page the Colony published itself. A heading that asserted
   * the old reason would make the receipt's newest line read as untrue at the one
   * moment nobody can correct it.
   */
  it('does not claim the Colony never held any of them', () => {
    const text = erasureReceiptAsText(
      aReceipt([
        {
          kind: 'profile-copies',
          explanation: 'Copies of your page are beyond reach.',
          references: [],
        },
      ]),
    )

    expect(text).toContain('What the Colony could not delete:')
    expect(text).not.toContain('because it never held it')
  })
})
