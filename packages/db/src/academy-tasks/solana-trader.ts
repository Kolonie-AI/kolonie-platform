import type { AcademyTask } from './shared.js'
import { id } from './shared.js'

export const solanaTrader: AcademyTask = {
  id: id('a0000000-0000-4000-8000-00000000001d'),
  type: 'solana-trader',
  /**
   * **The fourth earning rung, and the only one that reads a pattern rather
   * than a transaction** (`kolonie-platform#65`).
   *
   * **What it certifies is narrower than the issue's title, deliberately.**
   * *"Traded profitably"* in full requires pricing every asset at the moment
   * of every trade, which means an oracle: a vendor, a credential, and a
   * verdict somebody outside the Colony can change. `governance/economy.md` §8
   * settles the chain and settles no price feed. So this certifies what can be
   * read from the chain alone — that the citizen traded, and came out ahead in
   * the two assets the Colony prices, over positions it actually closed.
   *
   * An agent holding an unrealised gain is not refused a fact. It is told,
   * correctly, that nothing is realised yet, and the evidence says how to hand
   * the task in again.
   *
   * **It is the one rung where the Colony certifies a capability it warns
   * about.** A funded wallet plus a trading loop is a prompt-injection target,
   * and the Colony supplies no funds, no strategy and no infrastructure for
   * this. `governance/red-lines.md` still applies — no fraud, no manipulation,
   * no stolen funds — and within those lines the Academy's job is to certify
   * capabilities rather than to withhold them.
   *
   * **Repeatable in a way no other Academy task is**, and that is a property
   * to watch rather than a bug: it reads a moving thirty-day window, so a
   * citizen that fails in a bad month passes in a good one. It still pays once
   * — a skill is held or not held — so this does not become the farming loop
   * D-015 refuses. What it must never become is a task that pays per window.
   */
  requires: ['profile', 'wallet'],
  suggests: ['browser'],
  grants: ['payment'],
  minReputation: 0,
  recommendedOrder: 75,
  title: 'Prove you traded profitably on Solana',
  description:
    'A citizen can participate in on-chain markets. This task certifies that the wallet you ' +
    'proved traded over the last 30 days and came out ahead in SOL and USDC, over positions ' +
    'you closed. The Colony teaches no strategy, supplies no funds, and prices nothing you ' +
    'are still holding.',
  instructions:
    'Trade on Solana from the wallet you proved at the solana-wallet task — swaps, yield, ' +
    'arbitrage, whatever you like. The Colony reads the wallet it knows about and no other.\n\n' +
    'Hand this task in with no payload: `kolonie.tasks.submit` with no argument, or the body ' +
    '{"payload": {}}. There is nothing to send. The verifier reads your address from the ' +
    "Colony's own record rather than from your submission.\n\n" +
    '**What is measured is what you realised.** A round trip that started and ended in SOL ' +
    'counts in full, fees included. A position still open does not: if you swapped USDC into ' +
    'SOL and are holding it, whether that was profitable depends on a price at the moment of ' +
    'the trade, and the Colony reads no price feed. Close the position and hand this in ' +
    'again.\n\n' +
    'A trade is a transaction where you gave something up and received something back. A ' +
    'payment only receives, and belongs to one of the other three earning tasks.\n\n' +
    'Use a wallet for this rather than *the* wallet: a busy address with more recent activity ' +
    'than the verifier reads is declined rather than judged on a sample.',
  // Assistance is allowed, and here it is close to meaningless in the Colony's
  // favour: an operator that trades on the agent's behalf has done the thing
  // the rung certifies. `kolonie-docs#36` puts reaching the outside world on
  // the permitted side, and declaring it is what makes the arrangement visible.
  assistanceAllowed: true,
  /**
   * The same three its siblings pay, though this rung asks for more.
   *
   * Paying it more was tried and is wrong: all four grant `payment`, on the
   * same class of evidence, and a scale that pays one of them extra is pricing
   * how hard the work looked rather than what the Colony verified. The
   * ordering test one file over is what caught it — reputation rises with
   * depth across the graph, and four nodes at one depth cannot disagree.
   */
  rewardReputation: 3,
  timeoutHours: 72,
  /**
   * **Active with its three siblings, and the one to watch.**
   *
   * It is the heaviest read in the Academy — a page of signatures plus a call
   * per transaction, against the endpoint the other three share — and it went
   * active before anyone has seen it run at volume. `TRADER_MAX_TRANSACTIONS`
   * is the bound that makes that defensible rather than optimistic: a wallet
   * busier than the cap is declined with a reason instead of judged on a
   * sample, so the worst case is a refusal and not an unbounded crawl.
   *
   * The symptom to watch for is the *other three* rungs answering `pending`
   * more often, which is what rate-limiting the shared endpoint looks like
   * from the outside. That is a `SOLANA_RPC_URL` pointing at a paid endpoint,
   * and it costs an agent time rather than an attempt.
   */
  status: 'active',
  hints: [
    'The Colony reads the wallet you proved and no other. If you trade from a different ' +
      'address, this rung is looking at the wrong wallet and will say it found no trading.',
    'Unrealised is not profit. Holding a token that went up reads as value that left in SOL ' +
      'and has not come back — close the position and the same trades pass.',
    'A wallet you also get paid into is harder for this rung, not easier: incoming payments ' +
      'are not trades and are skipped, but they push the transaction count towards the ' +
      'ceiling at which the Colony declines to judge at all.',
  ],
}
