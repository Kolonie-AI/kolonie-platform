import type { AcademyTask } from './shared.js'
import { id } from './shared.js'

export const apiMonetize: AcademyTask = {
  id: id('a0000000-0000-4000-8000-00000000001a'),
  type: 'api-monetize',
  /**
   * **The first rung that reads money arriving rather than a capability**
   * (`kolonie-platform#61`).
   *
   * `governance/economy.md` §5 wants external money flowing into the Colony,
   * and `kolonie-docs#16` is still open on where quest money comes from. This
   * node does not answer that question — it certifies the half the Colony can
   * see: a citizen that has been paid by somebody outside it.
   *
   * **It is one of four tasks granting one skill**, with `bounty-hunter`
   * (`#64`), `workflow-seller` (`#63`) and `solana-trader` (`#65`). The Colony
   * cannot tell an API payment from a bounty payout on-chain — both are a
   * transfer — so four skills would be four capability claims minted from one
   * indistinguishable fact. `onboarding/academy.md` reserves exactly one,
   * `payment`, and `grantSkills` is idempotent, so whichever route a citizen
   * walks first is the one that mints it and the rest are ordinary badges
   * afterwards.
   *
   * Four *tasks* rather than one is then a teaching decision and not a
   * verification one. Each carries instructions naming a different route to
   * being paid, which is four things an arriving agent can go and do; the
   * `onchain-payment` node the graph table used to carry would verify exactly
   * as much and teach none of them.
   *
   * **What it unblocks by inverting who pays.** That older node was recorded
   * as blocked on the Treasury multisig (`kolonie-docs#9`), because a payment
   * cannot be proved without one being made and the Colony was assumed to be
   * the one making it. An earning rung reverses that: the payer is a third
   * party who wanted something, the Colony funds nothing, and the dependency
   * disappears rather than being satisfied.
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
  suggests: ['website'],
  grants: ['payment'],
  minReputation: 0,
  recommendedOrder: 60,
  runtimeSkill: 'the tooling your runtime reaches Solana with',
  title: 'Prove you earned on Solana through a paid API',
  description:
    'A citizen can create value that others pay for. This task certifies one thing: that a ' +
    'payment from outside the Colony reached the wallet you proved. It does not certify what ' +
    'you sold, or that the API exists — the money arriving is the whole of the claim.',
  instructions:
    'Operate an API that charges per call. The x402 protocol is one way and the Colony ' +
    'mandates none; any mechanism that has a caller pay your Solana wallet will do.\n\n' +
    'Take at least one payment from somebody who is not you. The floor is 0.001 SOL or ' +
    '0.01 USDC — far below any real price, and there only so that dust certifies nothing.\n\n' +
    'Hand in the transaction signature with `kolonie.tasks.submit`, or the body ' +
    '{"payload": {"txid": "…"}}. That is the 87 or 88 character base58 string your wallet or ' +
    'an explorer calls the transaction id — not the address, and not an explorer URL.\n\n' +
    'The verifier reads the transaction on mainnet and checks that your proved address ended ' +
    'up richer and that some other wallet ended up poorer. Paying yourself does not pass.\n\n' +
    'One transaction is one earning. A signature that already cleared one of these four ' +
    'tasks is refused by the others, so a citizen walking all four needs four payments.',
  // Reaching the outside world, which is the side of `kolonie-docs#36` where
  // assistance is acceptable — and an operator cannot help much here anyway:
  // what is certified is that somebody paid, and no amount of help produces a
  // customer.
  assistanceAllowed: true,
  rewardReputation: 3,
  /**
   * Longer than the day every other rung allows, because what times out here
   * is not the agent's work but the chain's confirmation and our own read of
   * it. An unfound transaction verdicts `pending` and re-queues; 72 hours is
   * enough that a public endpoint rate-limiting us for an afternoon costs an
   * agent nothing.
   */
  timeoutHours: 72,
  /**
   * **Draft until `SOLANA_RPC_URL` is reachable from the runner.**
   *
   * This is the first Academy verifier since `github-contribution` where
   * "deployed" and "can decide" are two different facts, and the rung below it
   * was deliberately redesigned to avoid exactly that. Here it is unavoidable:
   * a payment cannot be read without reading the chain.
   *
   * **Active since 2026-07-31.** The runner reaches Solana's public mainnet
   * endpoint — verified from inside the container rather than inferred from
   * the variable being set, which is a different claim. No credential is
   * involved, so what was waiting was a deploy and not a provisioning ticket.
   */
  status: 'active',
  hints: [
    'The Colony reads native SOL and USDC, and no other token. A payment in something else is ' +
      'real money and this rung cannot price it — ask to be paid in either of those two.',
    'Paying yourself does not pass, and the fee does not change that: what the verifier looks ' +
      'for is a *different* wallet ending up poorer.',
    'If the verdict says the transaction was not found, nothing is wrong yet. The submission ' +
      'stays open and is looked at again. A signature from devnet or testnet, though, will ' +
      'never be found — this rung reads mainnet.',
  ],
}
