import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLATFORM_FEE_PERCENT,
  questPayNotice,
  questPayoutSplit,
  type Task,
} from '@kolonie-ai/core'
import { aTask } from '../../__fixtures__/catalogue.js'
import { escape } from '../../console/html.js'
import { questAsCitizenReads } from '../../console/sponsor.js'
import { describeReward, taskAsText } from './tasks.js'

/**
 * What a quest tells an answering citizen it pays (`#472`).
 *
 * `#462` gave the Colony a share of every accepted report and `#463` decided the
 * prominent figure is the net one. `#463` scoped itself to the console, and this
 * surface kept quoting the gross — *"the number was simply the one nobody
 * thought to convert"*, which is the failure `#463` names in its own words.
 */
describe('what a quest says it pays over MCP', () => {
  const aQuest = (overrides: Partial<Task> = {}): Task =>
    aTask({
      kind: 'quest',
      status: 'active',
      reward: { credits: 1000, reputation: 2 },
      platformFeePercent: DEFAULT_PLATFORM_FEE_PERCENT,
      ...overrides,
    })

  describe('the reward clause', () => {
    /** The defect, stated as the assertion that would have caught it. */
    it('names what reaches the citizen, not what the sponsor funded', () => {
      expect(describeReward(aQuest())).toBe('pays you 750 credits and 2 reputation')
      expect(describeReward(aQuest())).not.toContain('1000')
    })

    it('agrees with the payout computation rather than doing its own arithmetic', () => {
      for (const credits of [1, 7, 99, 1000, 12345]) {
        for (const feePercent of [0, 10, 25]) {
          const { toCitizen } = questPayoutSplit(credits, feePercent)

          expect(
            describeReward(
              aQuest({ reward: { credits, reputation: 0 }, platformFeePercent: feePercent }),
            ),
          ).toBe(`pays you ${toCitizen} credits`)
        }
      }
    })

    /**
     * **An Academy rung is untouched.** It has no fee and never will, so a
     * branch on `kind` rather than a rate every caller has to pass in order to
     * be told nothing.
     */
    it('leaves an Academy rung reading exactly as it did', () => {
      const rung = aTask({ kind: 'academy', reward: { credits: 0, reputation: 3 } })

      expect(describeReward(rung)).toBe('pays 3 reputation')
      expect(describeReward(rung)).not.toContain('you')
      expect(describeReward(rung)).not.toContain('Colony')
    })

    it('still says a task pays nothing when it pays nothing', () => {
      expect(describeReward(aTask({ reward: { credits: 0, reputation: 0 } }))).toBe('pays nothing')
    })
  })

  describe('the rate a quest quotes', () => {
    /** A recorded rate always wins, which is why `#462` records it. */
    it('quotes the rate it was published under, not the configured one', () => {
      expect(describeReward(aQuest({ platformFeePercent: 10 }))).toBe(
        'pays you 900 credits and 2 reputation',
      )
    })

    /**
     * **The rejection case that a naive `?? configured` would fail.** A quest
     * that is already published and carries no rate was published before the fee
     * existed, so it pays no fee — quoting a citizen 750 on a quest that will
     * pay it 1000 is the same lie inverted.
     */
    it.each(['active', 'retired'] as const)(
      'charges nothing on a %s quest published before the fee existed',
      (status) => {
        expect(describeReward(aQuest({ status, platformFeePercent: null }))).toBe(
          'pays you 1000 credits and 2 reputation',
        )
      },
    )

    /** A draft has its publication ahead of it, so it shows the rate that would apply. */
    it.each(['draft', 'pending_review', 'rejected'] as const)(
      'shows the configured rate on a %s quest, which has none recorded yet',
      (status) => {
        expect(describeReward(aQuest({ status, platformFeePercent: null }))).toBe(
          'pays you 750 credits and 2 reputation',
        )
      },
    )
  })

  describe('the gross and the named fee', () => {
    it('states both on the single-quest view, which has a line for them', () => {
      const text = taskAsText(aQuest(), 0, false, 1, false)

      expect(text).toContain('pays you 750 credits')
      expect(text).toContain('The sponsor funds 1000')
      expect(text).toContain('platform fee, 25%')
      expect(text).toContain('250')
    })

    /**
     * At the pilot's one cent the fee rounds away, and the text says so rather
     * than naming a fee of zero — which reads as a charge to somebody skimming.
     */
    it('says the Colony takes nothing where the fee rounds away', () => {
      const text = taskAsText(aQuest({ reward: { credits: 1, reputation: 1 } }), 0, false, 1, false)

      expect(text).toContain('pays you 1 credits')
      expect(text).toContain('the Colony takes nothing')
      expect(text).not.toContain('platform fee')
    })

    it('says nothing about a fee on an Academy rung', () => {
      const text = taskAsText(
        aTask({ kind: 'academy', reward: { credits: 0, reputation: 3 } }),
        0,
        false,
        1,
        false,
      )

      expect(text).not.toContain('platform fee')
      expect(text).not.toContain('the Colony takes nothing')
    })
  })

  /**
   * **The property `apps/api/src/quests.ts` claims, asserted rather than
   * described.**
   *
   * That file imports the citizen's renderer instead of reimplementing it, on
   * the stated rule that *"the preview a sponsor is shown has to be **that** text
   * or it is not a preview… a second composition of the quest is a second answer
   * to what it says, and the one that drifts is the one nobody is reading."*
   *
   * Since `#463` the browser preview renders `questPayNotice` and the MCP
   * preview renders `taskAsText`, so the rule was still written in the file and
   * had stopped being true: one draft reported two different rewards. The two
   * cannot be the same string — one is HTML and one is text — so what is asserted
   * is the thing that actually matters, that they report the same money.
   */
  describe('the browser preview and the MCP preview of one quest', () => {
    // Every case that pays something. A quest paying nothing has no money to
    // disagree about, and the MCP view says nothing about a fee on one.
    it.each([
      [1000, 25],
      [1000, 10],
      [7, 25],
      [1, 25],
    ])('report the same reward for %i credits at %i%%', (credits, feePercent) => {
      const quest = aQuest({ reward: { credits, reputation: 2 }, platformFeePercent: feePercent })
      const { toCitizen } = questPayoutSplit(credits, feePercent)

      const browser = questAsCitizenReads({
        title: quest.title,
        description: quest.description,
        instructions: quest.instructions,
        questions: [],
        requires: quest.requires,
        minReputation: quest.minReputation,
        reward: quest.reward,
        feePercent,
      })
      const mcp = taskAsText(quest, 0, false, 1, false)

      // The net, in both.
      expect(browser).toContain(`Pays you ${toCitizen} credit(s)`)
      expect(mcp).toContain(`pays you ${toCitizen} credits`)

      // And the gross-and-fee sentence, which is one function and therefore one
      // wording: a rate change on either surface alone fails here. Compared
      // through `escape`, because the browser half is HTML and *the Colony's
      // share* carries an apostrophe — the difference is the encoding and not
      // the claim.
      const shared = questPayNotice({ credits, reputation: 2, feePercent })
        .split('. ')
        .slice(1)
        .join('. ')
      expect(browser).toContain(escape(shared))
      expect(mcp).toContain(shared)
    })
  })
})
