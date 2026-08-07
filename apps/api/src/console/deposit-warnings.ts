/**
 * Everything that has to be read before money moves, in one place (`#470`).
 *
 * ## Why this is a module and not two copies
 *
 * `#460` decided the wording on `/funding`, and each sentence in it is a way
 * somebody ends up out of pocket on a page that looked like it worked. `#470`
 * then put a deposit address on a second page — the agent's — and a second copy
 * of a warning about irreversible loss is how one of them ends up milder. Not
 * eventually and not through carelessness: the two pages have different readers,
 * somebody softens the one whose reader they are picturing, and the other is
 * left saying something the project no longer means.
 *
 * So there is one renderer and both pages call it. The text below is `#460`'s,
 * unchanged — this module moved it rather than rewrote it, which is what makes
 * it safe to say the two pages carry the same warning.
 *
 * ## What is deliberately not here
 *
 * **Where to buy.** That is one page's answer and not the other's: a person
 * funding their own identity is choosing an on-ramp, and a person looking at an
 * agent they operate is not. `funding.ts` keeps its own sentence about that.
 */

/**
 * **Above the address, and first.**
 *
 * An acceptance criterion on both `#460` and `#470` rather than a layout
 * preference: a warning beside the thing it is about is a warning read after the
 * decision.
 */
export function depositWarning(): readonly string[] {
  return [
    '<h2>Send only USDC, on Solana</h2>',
    '<p><strong>Anything else sent to this address is lost.</strong> Another token, or USDC on ' +
      'another network, is not credited, is not refunded, and produces no message — not to you ' +
      'and not to us. There is nothing we can do about it afterwards.</p>',
  ]
}

/**
 * The three facts a person is wrong about afterwards if nobody says them first.
 *
 * Each was argued with the maintainer while planning the first real card
 * payment: the fee comes off before the credit, there is no way back out, and a
 * balance of `4,600` means nothing until somebody says what a credit is.
 */
export function depositRules(): readonly string[] {
  return [
    '<p>Three things worth knowing before you buy:</p>',
    '<ul>',
    '<li><strong>You are credited what arrives, not what you paid.</strong> If you buy through ' +
      'an exchange or an on-ramp, its fee comes off first — US$ 50 paid can be US$ 46 received ' +
      'and 4,600 credits.</li>',
    /**
     * Both halves, because only one of them was said (`#500`).
     *
     * *Credits cannot be sent back out* is about the balance. What a sponsor
     * asks after a transfer is about **the dollars**, and the honest answer is
     * the same: what arrives at this address is not returned either. The two
     * were read as one sentence with one meaning, and the maintainer made
     * exactly that inference on 2026-08-07 after a real deposit.
     */
    '<li><strong>Money in is one-way.</strong> Credits cannot be sent back out, and neither ' +
      'can the dollars: what you send funds quests, and there is no way to return it to the ' +
      'wallet it came from. If you fund US$ 50 and spend US$ 10, the rest stays a balance ' +
      'until you spend it on a quest.</li>',
    '<li><strong>One credit is one US cent.</strong> A quest costs its capacity times its price ' +
      'per report, in credits.</li>',
    '</ul>',
  ]
}
