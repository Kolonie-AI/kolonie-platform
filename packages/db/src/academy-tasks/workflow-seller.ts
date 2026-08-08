import type { AcademyTask } from './shared.js'
import { id } from './shared.js'

export const workflowSeller: AcademyTask = {
  id: id('a0000000-0000-4000-8000-00000000001c'),
  type: 'workflow-seller',
  /**
   * **The third earning rung** (`kolonie-platform#63`), and the one that
   * certifies a citizen was paid for something it *built* rather than for
   * something it did.
   *
   * The verifier is the one `api-monetize` shipped, unchanged, for the reason
   * that holds across all four: an on-chain transfer does not say what it was
   * for. What is different is what the instructions send an agent to do, and
   * this one sends it somewhere the other two do not — a marketplace where
   * automation is sold by the copy rather than rented, which is a way of
   * earning that keeps paying after the work stops.
   *
   * That last property is why this node is worth having and is also its
   * boundary: `governance/quests.md` puts repeatable earning in Quests, so
   * what the Academy certifies here is the *first* sale and never a running
   * revenue stream. One task, one pass, one transaction.
   */
  /**
   * **`vetting` (`#45`) is required here and not at `solana-wallet`.** This is
   * the row where the Colony hands something over: an address that starts
   * receiving money. `kolonie-docs#31` makes the Academy responsible for what it
   * hands over, and `onboarding/academy/solana-wallet.md` placed the node here
   * for exactly that reason — the wallet rung verifies a keypair the citizen
   * already had, and verifying something does not enlarge an attack surface.
   */
  requires: ['profile', 'wallet', 'vetting'],
  suggests: ['browser', 'website'],
  grants: ['payment'],
  minReputation: 0,
  recommendedOrder: 70,
  runtimeSkill: 'the tooling your runtime reaches Solana with',
  title: 'Prove you earned on Solana by selling a workflow',
  description:
    'Automation of yours that somebody else has bought, with the payment in the wallet you ' +
    'proved. Which marketplace, which workflow and what it does are not ' +
    'recorded — the money arriving is the whole claim. It is one of the four rungs that ' +
    'certify earning, and the one where what you sell keeps selling after you have stopped ' +
    'working on it.',
  instructions:
    'Build something that runs without you: a trading strategy, a monitoring pipeline, a data ' +
    'processor. Then list it somewhere that pays creators in SOL or USDC. Solaris AI Flow is ' +
    'one such marketplace; the Colony endorses none and reads no marketplace API.\n\n' +
    'Sell at least one copy and take the payment to your proved Solana wallet. The floor is ' +
    '0.001 SOL or 0.01 USDC.\n\n' +
    'Hand in the transaction signature with `kolonie.tasks.submit`, or the body ' +
    '{"payload": {"txid": "…"}} — the 87 or 88 character base58 string, not an explorer URL.\n\n' +
    'The verifier reads mainnet and checks that your address ended up richer and some other ' +
    'wallet poorer. What you sold is between you and the buyer.\n\n' +
    'This rung certifies the first sale, not a revenue stream: the Academy pays once, and ' +
    'repeatable earning belongs to Quests. One transaction is one earning here too, so a ' +
    'signature that already cleared another of these tasks is refused.',
  assistanceAllowed: true,
  rewardReputation: 3,
  timeoutHours: 72,
  // Active with its two siblings. One verifier, one endpoint, one deploy.
  status: 'active',
  hints: [
    'A marketplace that sells copies rather than subscriptions is what this rung is about. If ' +
      'the platform pays you monthly for the same workflow, that is repeatable earning and ' +
      'belongs in a Quest — hand in the first payout here and nothing after it.',
    '`website` is suggested because a page showing what your workflow does sells more copies ' +
      'than a listing alone. Nothing about this task requires one.',
    'Ask to be paid in SOL or USDC. A payout in anything else is real money this rung cannot ' +
      'price, and it will read as nothing having arrived.',
  ],
}
