## D-086 — The deposit webhook is a trigger, not a source: what it says is re-read from the chain before anything is credited

**Date:** 2026-08-04

**Problem.** `#219` built the receiving side of the deposit path whole and gave
it a body shape designed from what the credit needs — `signature`, `address`,
`mint`, `tokenProgram`, `baseUnits`, `commitment` — validated by
`ObservedTransferSchema` at the route. **No observer emits that shape.** An
enhanced Helius webhook, the only sender there is, delivers an array of
transactions carrying `tokenTransfers[]`; a raw webhook delivers `transaction`,
`meta`, `slot` and `blockTime`. Neither carries a token program, neither carries
a commitment at all, and `tokenAmount` is a decimal token amount where the
ledger counts base units. So a Helius webhook created against these addresses
answered `422` to every delivery, forever, and nothing said so — the shape was
never checked against a sender because the sender did not exist yet (`#321`).

**Decision.** The route accepts a Helius delivery and reads exactly two facts
from it: **which signature, and which wallet received something.** Every fact the
credit rests on is then re-read from the chain through `DepositWatcher`, which
gains `transfersIn(signature, address)` alongside the reconciliation's
`transfersAt(address)`, and judged by the same `depositRejection`.

`ObservedTransferSchema` stays the internal shape and stays the only thing
`record` accepts. `TransferClaim` — a signature and an address, and deliberately
nothing else — is a separate type rather than a partially-filled
`ObservedTransfer`, so no code path can mistake a claim for an observation.

**Rejected: trust the delivery and invent the two missing fields.** It is the
smaller diff. It also means a webhook body decides what USDC is: `tokenProgram`
would have to be defaulted to the SPL Token program, which credits a Token-2022
transfer as though the program had been checked, and `commitment` would have to
be assumed `finalized`, which is exactly the assumption `DEPOSIT_COMMITMENT`
exists to refuse. Both are the failures the receiving side was careful about,
reintroduced at the edge.

**Rejected: treat a delivery as evidence only and let the hourly reconciliation
credit it.** Honest, and one line of code. It also makes the webhook worth
nothing: promptness is the entire reason this endpoint exists, and
kolonie-infra#72 already covers the slow path.

**Consequence, and it is the property worth keeping.** A forged delivery cannot
credit anything. Whoever holds the webhook secret can name any signature and any
address, and the worst outcome is one RPC read that finds nothing — the ledger
moves only on what the chain says. Unwatched addresses are dropped before the
read, so a delivery cannot write rows for addresses the Colony never generated.

**Consequence.** A claim that cannot be verified — no `RPC_URL` configured, an
endpoint that is down, a signature the cluster has not finalized in the seconds
since the transaction landed — is counted as `unverified` and answered `200`.
It is not lost: kolonie-infra#72's hourly pass credits it within the hour, which
is the arrangement `#219` already described as _a missed delivery is a delay_.
The webhook's answer is five counts (`claims`, `ignored`, `credited`,
`rejected`, `unverified`) rather than one outcome, because one delivery can now
name several transfers.

**Consequence.** `wrong-mint` is reachable for the first time. Under the old
shape `depositRejection` refused everything as `not-final` before it looked at
the mint, because no hand-shaped body carried a commitment either.
