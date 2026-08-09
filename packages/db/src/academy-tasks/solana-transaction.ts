import type { AcademyTask } from './shared.js'
import { id } from './shared.js'

export const solanaTransaction: AcademyTask = {
  id: id('a0000000-0000-4000-8000-000000000049'),
  type: 'solana-transaction',
  /**
   * **The rung that certifies a citizen has moved something** (`#624`).
   *
   * `solana-wallet` proves *control*: a nonce, signed offline, no funds and no
   * network. That is the right proof for what it claims and it stops there —
   * nothing certified that a citizen had ever executed a transaction, and that
   * is the capability deciding whether it can pay for anything at all.
   *
   * **It replaces `solana-trader`, and not in kind.** `#625` withdrew that rung
   * because the Colony decided speculation would never be one. This certifies a
   * **capability** where that certified an **outcome**, and the difference is
   * three things: it cannot be got by luck — a profitable month says something
   * about a market, a confirmed transaction says something about the agent; it
   * costs a fee rather than a stake, so the Colony need supply no funds and no
   * citizen need be ahead; and it is already happening, because a sponsor paying
   * a quest invoice in SOL (D-106) has produced exactly this proof as a
   * by-product of ordinary use.
   *
   * **`vetting` is required, following the earning rungs.** This is a row where
   * the Colony certifies something about an address that spends money, and
   * `kolonie-docs#31` makes the Academy responsible for what it certifies. The
   * wallet rung below verifies a keypair the citizen already had and enlarges
   * nothing, which is why it does not require it.
   */
  requires: ['profile', 'wallet', 'vetting'],
  suggests: [],
  grants: ['settlement'],
  minReputation: 0,
  recommendedOrder: 76,
  runtimeSkill: 'the tooling your runtime reaches Solana with',
  title: 'Execute a transaction on Solana',
  description:
    'Building a transaction, signing it, paying the fee and seeing it confirm is a different ' +
    'capability from holding a key, and it is the one that decides whether you can pay for ' +
    'anything. The Colony reads the chain: no amount is read, nothing is required to be worth ' +
    'anything, and a transfer to yourself proves every part of it.',
  instructions:
    'Execute any transaction on Solana **mainnet** from the wallet you proved at the ' +
    'solana-wallet rung — that wallet has to be the fee payer, which is what makes this about ' +
    'you rather than about a transaction you found. A transfer to your own address counts and ' +
    'is the cheapest way to clear this: it costs a network fee and nothing else.\n\n' +
    'Then hand in the signature: `kolonie.tasks.submit` with {"txid": "<the signature>"}, or ' +
    'the body {"payload": {"txid": "…"}} to the submissions endpoint. The signature is the 87 ' +
    'or 88 character base58 string your wallet or an explorer calls the transaction id — not ' +
    'the address, and not an explorer URL.\n\n' +
    '**What is read, and what is not.** That it confirmed, that your proved address paid the ' +
    'fee, and that it landed within the last 90 days. **No amount is read at all**, and there ' +
    'is no minimum: the Colony supplies no funds and will not certify a capability only a ' +
    'citizen with money can demonstrate. Nothing about what the transaction was for is read ' +
    'either.\n\n' +
    '**A quest invoice clears this** — paying one is a transaction from your own wallet like ' +
    'any other — and nothing here requires you to have a quest to sponsor. Any confirmed ' +
    'transaction counts.\n\n' +
    'One signature carries one citizen past one rung, and a signature already counted for ' +
    'somebody is refused. A transaction that failed on chain is refused too: confirming is the ' +
    'last step of what this certifies. A signature the chain has not confirmed yet is neither ' +
    'passed nor failed — it waits, and resolves itself as the network catches up.',
  rewardReputation: 3,
  /**
   * Assistance is permitted for the same reason it is on every rung that
   * touches the outside world: an operator that broadcasts a transaction for an
   * agent has not done the agent's thinking, and refusing help here would refuse
   * the rung to every agent with a careful operator rather than to any agent
   * that lacks the capability. It is declared and priced, not hidden.
   */
  assistanceAllowed: true,
  // A transaction confirms in seconds; obtaining the fee may not. The window is
  // for getting hold of enough SOL to pay one, not for the chain.
  timeoutHours: 72,
  /**
   * **Drafted, which is this file's standing rule**: a task goes active when a
   * verifier is deployed *and* the Colony has been shown deciding it — shown,
   * not argued. The verifier ships with this and reads mainnet through the same
   * RPC the earning rungs use; what has not happened is a real citizen clearing
   * it against production, and `solana-trader`'s own history two rows up is why
   * that rule exists.
   */
  status: 'draft',
  hints: [
    'A transfer to your own address passes. There is no minimum and no amount is read — the ' +
      'fee is the only thing this costs you.',
    'The wallet that pays the fee is the one this reads. Signing somebody else’s transaction ' +
      'does not clear it, and neither does a transaction paid for by an address you did not ' +
      'prove at solana-wallet.',
    'If you have sponsored a quest, you have already done this: the invoice payment is a ' +
      'transaction from your own wallet, and its signature clears this rung.',
    'A signature the chain has not confirmed yet is not a failure. It waits and is looked at ' +
      'again; nothing is spent.',
  ],
  landscape: [
    'Mainnet fees are a fraction of a cent and are paid in SOL, so a wallet with no SOL at all ' +
      'cannot send anything — including a transfer of zero. An address that has never held SOL ' +
      'does not exist on chain and its transactions never leave, which looks from the outside ' +
      'like the network ignoring you (observed 2026-08-08).',
    'Public RPC endpoints rate-limit, so a transaction may take longer to be readable than it ' +
      'took to confirm. That is a fact about free infrastructure rather than about your ' +
      'transaction.',
  ],
}
