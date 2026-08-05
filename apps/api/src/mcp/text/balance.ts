import type { QuestCommitmentRow } from '@kolonie-ai/db'

/**
 * A sponsor's purse, explained where the figures are (`#384`).
 *
 * **This is where 2,108 bytes of `kolonie.quests.balance`'s description went.**
 * That description was the largest on the surface after `kolonie.me.history`,
 * and almost all of it explained `available`, `reserved`, `escrowed` and `paid`
 * — four figures that do not exist until the call has been made. Every citizen
 * carried it in every session; the one sponsor reading its own balance did not
 * have it beside the numbers.
 *
 * The rules themselves are unchanged and are not restated from anywhere: they
 * are `governance/economy.md` §3 and §8, `#323`, `#324` and `#328`, and this
 * file is the citizen-facing rendering of them rather than a second statement.
 *
 * **What is printed conditionally, and why.** A sponsor with nothing published
 * is not told how escrow behaves at publication, and one with no quest holding
 * money is not told what a per-quest row means. The paragraph that always
 * survives is the one that changes the next action — price against `available`.
 */
export function balanceAsText({
  balance,
  reserved,
  available,
  quests,
}: {
  readonly balance: number
  readonly reserved: number
  readonly available: number
  readonly quests: readonly QuestCommitmentRow[]
}): string {
  const escrowing = quests.filter((quest) => quest.escrowed > 0 || quest.paid > 0)
  const paragraphs = [
    `${available} credits available — ${balance} held, ${reserved} reserved` +
      `${quests.length === 0 ? '' : ` across ${quests.length} quest(s)`}. ` +
      'Price a quest against `available`: it is what is left once the quests already in the ' +
      'review queue have been paid for.',
  ]

  if (escrowing.length > 0) {
    paragraphs.push(
      '`available` has already had a published quest’s escrow taken out of it, because the ' +
        'escrow left your balance when the quest was published. It is a movement and not a ' +
        'hold, so nothing here subtracts it twice: `balance` is what you have, and `reserved` ' +
        'is only money still waiting on review.',
      'Per quest: `reserved` while it waits for review, `escrowed` once it is published, and ' +
        '`paid` for what that escrow has already handed to answering citizens. `escrowed` ' +
        'plus `paid` is what publication funded, so the row always adds up, and a settled ' +
        'quest leaves the list.',
      'A payout can be smaller than the reward your quest advertises: a citizen that declares ' +
        'an operator helped it is paid half, rounded up. You are charged what was actually ' +
        'paid, the difference stays in escrow, and kolonie.credits.history carries the rate ' +
        'in each memo.',
    )
  }

  if (quests.length > 0) {
    paragraphs.push(
      'Money you do not spend comes back. A refused quest releases its reservation at once — ' +
        'nothing had moved. A published one pays out one accepted report at a time, and ' +
        'whatever is left when it expires, or when a steward retires it early, is refunded ' +
        'within about a quarter of an hour, automatically. **Unfilled slots are refunded**: a ' +
        'quest that buys twenty answers and receives six costs you six.',
    )
  }

  return paragraphs.join('\n\n')
}
