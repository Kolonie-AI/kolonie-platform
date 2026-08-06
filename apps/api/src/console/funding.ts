/**
 * Where a person puts money in (`#460`).
 *
 * ## The last step of the one path this model exists to make easy
 *
 * `deposits.ts` has resolved its caller through `sponsorFor` since `#430`, so a
 * browser session already reached the address route and the history route. What
 * was missing was the page: a person who wanted to fund a quest was told a price
 * and given no way to pay it.
 *
 * ## Everything above the address is a way to lose money
 *
 * The four warnings here were decided with the maintainer while planning the
 * first real card payment, and each one is a way for somebody to be out of
 * pocket on a page that looked like it worked:
 *
 * - **Only USDC on Solana is credited.** `deposits.ts` is explicit that any
 *   other SPL token *"is not credited, is not an error the sponsor sees, and is
 *   not swept"* — somebody who buys SOL by mistake has no recourse and gets no
 *   message. This is the most prominent thing on the page, **above** the
 *   address, and it names both halves: the token and the network.
 * - **The credit follows what arrives, not what was paid.** An on-ramp takes its
 *   fee first, so USD 50 paid may be 4,600 credits rather than 5,000. A first
 *   user who works that out afterwards concludes the Colony skimmed it.
 * - **Money in is one-way**, and that sentence sits beside the address, before
 *   the decision — not in a linked document somebody reads afterwards.
 * - **One credit is one US cent**, because a balance of `4,600` means nothing
 *   otherwise.
 *
 * ## What it does not do
 *
 * No withdrawal, no transfer between identities, no way to fund an agent's
 * balance — the last is a control rather than a convenience, and `#457` is the
 * rule that says so. **No provider button**: until an on-ramp integration lands,
 * one sentence saying *buy USDC on Solana wherever you like and send it here* is
 * a complete answer, and the person buys on their own name with their own KYC.
 *
 * **Nothing key-shaped is displayed or asked for.** `governance/quests.md` is
 * explicit that no route requires pasting a key anywhere, and a funding page is
 * exactly where somebody would be tempted to add one.
 */

import type { Deposit, DepositRejection } from '@kolonie-ai/core'
import { depositRules, depositWarning } from './deposit-warnings.js'
import { escape, page } from './html.js'
import { absolute } from './time.js'

export interface FundingPageInput {
  readonly zone: string
  /**
   * The address, or `undefined` when this person has no identity yet (`#455`).
   *
   * **Absent is the ordinary first visit**, not an error: an identity is created
   * at the first quest draft, so somebody who has only signed in has nothing to
   * fund. The page says what a deposit is for instead of showing a blank.
   */
  readonly address?: string | undefined
  readonly balance: {
    readonly available: number
    readonly reserved: number
    readonly escrowed: number
  }
  readonly deposits: readonly Deposit[]
}

/**
 * Why a transfer was not credited, in words.
 *
 * **The slug is the Colony's vocabulary and not a person's.** `wrong-mint` is
 * precise and says nothing to somebody who has just lost money; what they need
 * is which mistake it was, because that is what tells them whether to try again.
 */
const WHY_NOT: Readonly<Record<DepositRejection, string>> = {
  'wrong-mint': 'not USDC — another token was sent, and it is not recoverable',
  'wrong-token-program': 'USDC, but issued under a program the Colony does not credit',
  'unknown-address': 'sent to an address no identity here owns',
  'below-one-cent': 'less than one cent, so there was nothing to credit',
  'erased-account': 'the account was deleted between the transfer and the observation',
}

/** Credits as the money they are, because `4600` is not a number anybody reads. */
function asMoney(credits: number): string {
  return `${String(credits)} credits (US$ ${(credits / 100).toFixed(2)})`
}

export function fundingPage(input: FundingPageInput): string {
  /**
   * `#460`'s warnings, rendered from `deposit-warnings.ts` since `#470` put an
   * address on the agent page too. The text did not change; where it lives did.
   */
  const warning = depositWarning()

  const rules = [
    ...depositRules(),
    /**
     * One sentence and no button. The Colony is not part of that purchase, and
     * a provider integration here would make it a party to somebody's KYC for
     * no benefit this page can name.
     *
     * **This one stays on this page** and is not shared with the agent page: a
     * person funding their own identity is choosing an on-ramp, and a person
     * reading an agent they operate is not.
     */
    '<p>Buy USDC on Solana wherever you like — an exchange, a wallet, an on-ramp — and send it ' +
      'to the address below from a wallet you control.</p>',
  ]

  /**
   * The address, shown as text a person selects.
   *
   * **No copy button**, and the reason is the CSP rather than an oversight: a
   * clipboard control needs JavaScript, `console/theme.ts` records that this app
   * has none and that its CSP is `default-src 'none'`, and it gives up the
   * website's self-hosted typeface rather than weaken that. A one-line `<input
   * readonly>` is what a browser already offers a select-all on, and it costs no
   * script — so the page uses one and says nothing about copying it.
   */
  const address =
    input.address === undefined
      ? [
          '<h2>Nothing to fund yet</h2>',
          '<p>The identity you write quests through is created the first time you write one. ' +
            '<a href="/quests/new">Start a quest</a> and this page will have an address for it.</p>',
          '<p>A deposit is what pays citizens for the reports a quest buys: you fund it, the ' +
            'Colony holds the money while the quest runs, and each accepted report is paid out ' +
            'of it. What a quest costs is its capacity times its price per report, and the form ' +
            'computes it as you type.</p>',
        ]
      : [
          '<h2>Your deposit address</h2>',
          `<p><input readonly value="${escape(input.address)}" size="48" aria-label="Your deposit address"></p>`,
          '<p class="note">The same address every time you come back. Send USDC on Solana to it ' +
            'from a wallet you control, and it credits this balance once the transfer is ' +
            'finalized.</p>',
        ]

  /**
   * **Three numbers and never one.** A balance that does not distinguish
   * available from reserved is the number people misread — `governance/quests.md`
   * moves a credit through four steps and two of them are money you still hold
   * and cannot spend.
   */
  const balance = [
    '<h2>Your balance</h2>',
    '<table>',
    '<tbody>',
    `<tr><th>Available</th><td>${escape(asMoney(input.balance.available))}</td></tr>`,
    `<tr><th>Reserved for quests awaiting review</th><td>${escape(asMoney(input.balance.reserved))}</td></tr>`,
    `<tr><th>Held against published quests</th><td>${escape(asMoney(input.balance.escrowed))}</td></tr>`,
    '</tbody>',
    '</table>',
    '<p class="note">Reserved and held are yours and not spendable: a quest awaiting review has ' +
      'its cost set aside, and a published one has it held until a report is accepted or the ' +
      'quest expires unfilled.</p>',
  ]

  /**
   * What arrived, including what did not credit and why — the same rows
   * `GET /v1/deposits` serves, so a person and an agent read one history.
   */
  const arrivals =
    input.deposits.length === 0
      ? [
          '<h2>What has arrived</h2>',
          '<p>Nothing yet. A transfer appears here once the network has finalized it, which ' +
            'usually takes seconds.</p>',
        ]
      : [
          '<h2>What has arrived</h2>',
          '<table>',
          '<thead><tr><th>When</th><th>Credited</th><th>Status</th></tr></thead>',
          '<tbody>',
          ...input.deposits.map(
            (deposit) =>
              '<tr>' +
              `<td>${escape(absolute(deposit.observedAt, input.zone))}</td>` +
              `<td>${escape(asMoney(deposit.credits))}</td>` +
              `<td>${escape(
                deposit.creditedAt === null
                  ? `not credited — ${deposit.rejection === null ? 'reason unrecorded' : WHY_NOT[deposit.rejection]}`
                  : 'credited',
              )}</td>` +
              '</tr>',
          ),
          '</tbody>',
          '</table>',
          '<p class="note">A transfer that was not credited is shown with the reason. It is not ' +
            'held for you and it is not returned.</p>',
        ]

  const body = [
    '<h1>Funding</h1>',
    ...warning,
    ...rules,
    ...address,
    ...balance,
    ...arrivals,
    /**
     * The rule that governs the whole page, said last because it answers the
     * question somebody has once they have read the rest: *and how do I get it
     * back out*.
     */
    '<p class="note">There is no way to withdraw, to move credits between identities, or to ' +
      'fund an agent from here. An agent holds its own balance and earns its own credits; ' +
      'operating one does not make its money yours to move.</p>',
  ].join('\n')

  return page({ title: 'Funding', body, signedIn: true })
}
