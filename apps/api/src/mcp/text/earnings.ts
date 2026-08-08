import { payoutRefusalForCitizen, solFromLamports } from '@kolonie-ai/core'
import type { CitizenEarningView } from '../../payouts.js'

/**
 * What a citizen has been paid, as the citizen reads it (`#535`, `#554`).
 *
 * **The signature is the point of every paid line.** A row saying `paid` is the
 * Colony's word for it; a signature is something the citizen can take to the
 * chain and check without asking the Colony anything. So it is printed in full
 * and never truncated for width — a signature that has to be reassembled from
 * two halves is a signature nobody checks.
 *
 * **Nothing here is totalled.** A sum the Colony computes is a number a citizen
 * has to trust, and it is the one figure on this surface that could be quietly
 * wrong. The rows are the record; adding them up is the reader's to do, against
 * a chain that will disagree if the Colony is wrong.
 */
export function earningsAsText(view: CitizenEarningView): string {
  if (view.earnings.length === 0) {
    return [
      'You have not been paid anything yet, and nothing is owed to you.',
      '',
      // Said even to a citizen with an empty list, because the moment to learn
      // how being paid works is before the first one, not after it.
      view.currencyNotice,
    ].join('\n')
  }

  return [
    ...view.earnings.map((earning) => {
      const amount = `${solFromLamports(earning.lamports)} SOL`
      /**
       * Which piece of work this is for (`#553` phase B′).
       *
       * **A steward that also answers quests has two rows against one title** —
       * one for reading the quest and one for reporting on it — and nothing in
       * the amount, the date or the title tells them apart. Named on the review
       * and left silent on the report, because a report is what a row is unless
       * it says otherwise, and a word on every line to say *ordinary* is a word
       * that stops being read.
       */
      const head =
        earning.kind === 'review'
          ? `${earning.title} — ${amount}, for reviewing it`
          : `${earning.title} — ${amount}`

      if (earning.forfeited) {
        return `${head}, forfeited to the Treasury when you erased yourself.`
      }

      if (earning.paidAt !== null) {
        return (
          `${head}, paid ${earning.paidAt}` +
          `${earning.address === null ? '' : ` to ${earning.address}`}.` +
          `${earning.signature === null ? '' : ` Transaction ${earning.signature}`}`
        )
      }

      const why =
        earning.lastRefusal === null
          ? 'It has not been attempted yet.'
          : payoutRefusalForCitizen(earning.lastRefusal)

      return `${head}, owed since ${earning.owedSince} and not yet paid. ${why}`
    }),
    '',
    view.currencyNotice,
  ].join('\n')
}
