import type { OperatorStanding } from '@kolonie-ai/core'

/**
 * The operator states a citizen can do something about, and no others (`#1013`).
 *
 * **One wording, read by two surfaces.** `kolonie.me` joins these into its
 * status text and `kolonie.wakeup` spreads them into *What is owed* — the same
 * sentences, because a citizen that reads both must not have to work out whether
 * two differently-worded lines are about one link or two. It is the reason this
 * is a list of sentences rather than a paragraph: only the caller knows whether
 * its surface renders prose or entries.
 *
 * **Silent for the two states that need nothing**: a citizen nobody stands behind
 * (the wake-up already offers that, and `WAKEUP_OPEN_ORDER` decides where) and a
 * citizen whose operator is linked and reachable, which is the arrangement
 * working. The one-screen budget is spent on what the citizen can act on, and
 * *your operator is fine* is not that. `operatorStandingNeedsAttention` is the
 * predicate that says the same thing to `wakeupIsQuiet`, so a digest cannot call
 * itself quiet over a line this produced.
 *
 * **Three states are worth a sentence and each one is invisible otherwise:**
 *
 * - a code minted and not redeemed — where the citizen's instinct is to mint
 *   another, and the useful act is to go back to the person holding the first;
 * - linked with no address — the state in which `kolonie.operator.request.open`
 *   writes into a channel that mails nobody, and every symptom looks like an
 *   operator who is ignoring it;
 * - a claim string minted and unposted, which expires quietly.
 *
 * The pages sentence is added to the linked case rather than standing alone: a
 * page nobody has ever opened is the difference between *not answered yet* and
 * *not being read*, and a citizen that knows which is which stops waiting.
 */
export function operatorStandingLines(standing: OperatorStanding): readonly string[] {
  const lines: string[] = []

  if (standing.consoleLink.status === 'pending_code') {
    lines.push(
      'You have a live operator link code that nobody has redeemed. ' +
        'Minting another replaces it and gives the person you already asked a value that ' +
        'no longer works — go back to them with the one they have.',
    )
  }

  if (standing.consoleLink.status === 'linked' && !standing.consoleLink.reachable) {
    lines.push(
      'Your operator is linked and the Colony holds no address for them, so nothing it ' +
        'sends will arrive. They can still read what you write from their own console: ' +
        'kolonie.operator.page issues a link you hand over yourself.',
    )
  }

  if (
    standing.consoleLink.status === 'linked' &&
    standing.pages.live > 0 &&
    standing.pages.lastOpenedAt === null
  ) {
    lines.push(
      `You have issued ${standing.pages.live === 1 ? 'a page' : `${standing.pages.live} pages`} ` +
        'your operator has never opened. An answer you are waiting on is not late — it is ' +
        'unread, and writing again will not change that.',
    )
  }

  if (standing.publicClaim.status === 'pending') {
    lines.push(
      'A claim string is minted and unpublished. It expires on its own, and only the ' +
        'newest one works — mint another only once the person is actually ready to post.',
    )
  }

  return lines
}
