## D-115 — A quest's funding is checked before it is moderated, and only then

**Date:** 2026-08-12 (`kolonie-platform#751`)

**Problem.** A quest was moderated, priced and invoiced before anything asked
whether its sponsor could pay for it. Four of the five steps a sponsor goes
through were right: the commitment is shown before submitting, moderation
decides in seconds, approval writes an invoice, and `awaiting_payment` gates
going live until the transfer settles. The missing one is the first — `submitQuest`
checked the expiry, the slots, the tier ceiling, the price floor and the
zero-reward gate, and asked nothing about money.

So the Colony spent a model verdict on hypothetical funding, and the sponsor
learned its wallet was short only once the quest had reached `awaiting_payment`.

`governance/quests.md` names this as the one thing D-106 gave up: _"A quest that
cannot be paid for is still moderated […] under D-106 there is no balance to
check against."_

**Why the reason for the gap expired.** `#553` closed the question with an
argument that was true when it was written:

> a sponsor pays an invoice from its own wallet **after** a steward publishes,
> and the Colony has no key to that wallet and does not watch it. So _can you
> afford this_ is not a question the Colony can answer

It is not true now. Payment attribution matches an arrival against exactly the
address the sponsor proved at the `solana-wallet` rung, so the Colony knows the
address; and the payout chain already reads balances off the chain. Knowing the
address and being able to read its balance is the whole of what the question
needs. **The premise expired when payment attribution shipped**, and nothing
about custody changed with it.

**Decision.** **At `kolonie.quests.submit` and `kolonie.quests.slots`, a quest
whose invoice is more than zero is refused unless the address its sponsor proved
holds the invoice plus one transaction fee.** The refusal names the shortfall.

Nothing else about the sequence changes: the invoice is still written at
publication, payment is still a transfer the sponsor sends, and
`awaiting_payment` still gates going live.

**A refusal and not a warning.** The point is that moderation is not spent on a
quest nobody can pay for, and a warning spends it anyway.

**The invoice plus one fee, not the invoice.** A balance exactly equal to the
invoice cannot pay the fee to send it — the failure `unfundedWalletRefusal`
already exists for one step later. `SOL_TRANSFER_FEE_LAMPORTS` is now in core so
that this rule and `FEE_RESERVE_LAMPORTS` are two uses of one number rather than
two literals.

**No wallet is a refusal that names the rung.** A quest that pays is invoiced to
an address, and there is no address.

**Nothing is reserved, held, escrowed or debited.** This reads one public
balance. D-106's _the Colony holds no key to anybody else's money_ is untouched,
and this decision must never be read as a step towards escrow.

**An outage lets the sponsor through.**
`state/decisions/the-colony-judges-its-own-quests.md`: _an outage must never
publish anything, and must never turn away a sponsor who did nothing wrong._ An
endpoint that is unreachable, times out or answers strangely has told the Colony
nothing about this wallet, and nothing is not zero — refusing every sponsor
because an endpoint is down is a worse failure than moderating one unfunded
quest. A deployment with no `RPC_URL` is the same case: absent means _this
deployment cannot ask_, exactly as an absent wallet address means it shows no
invoice.

**Rejected: re-check at publication, or between publication and payment.** The
check exists to save the moderation pass. A second read costs a second RPC call
per quest and is stale by the time anybody pays; `awaiting_payment` and the
invoice expiry already handle a sponsor that does not pay.

**Rejected: show the balance while the sponsor is drafting.** It would put an RPC
call on every draft read and write, and a figure shown while drafting is stale by
submission. The sponsor is told at the one moment the answer is load-bearing.

**Consequence.** `questFundingRejection` is a pure function in
`packages/core/src/task/invoice.ts` and holds the whole rule; `QuestDesk` gains
an optional `sponsorFunding`, and `databaseQuests` takes the chain as an appended
parameter. The check is the **last** of the submission checks, so every refusal a
quest can be given from its own text is given first and the endpoint is not
called for a quest that was never going to be submitted. Implemented in
`kolonie-platform#751`. The documentation half — `governance/quests.md` still
states there is no balance to check against — is `kolonie-docs#304`.

**Reversed by** evidence that the balance read refuses sponsors who could in fact
have paid, most likely through an endpoint that fails in a way this reads as a
number rather than as a throw — in which case the answer is that the read has to
be corroborated before it may refuse, not that the question is unanswerable.
