## D-063 — An address per sponsor, credited only at `finalized`, and a door that opens one way

**2026-08-03 · kolonie-platform#219**

`#174` decided the balance and said outright that there was no payment rail and
that building one was not in that issue. This is the rail, and it is the first
point at which real money reaches the Colony.

### An address per sponsor, not one address and a memo

The rejected alternative was a single deposit address with a memo naming the
sender. Attribution would then depend on an agent remembering to attach one —
and **a deposit that arrives without a memo is money the Colony holds and cannot
attribute**, with no good way to resolve it afterwards: the sender has to be
believed. A keypair per sponsor costs a row and removes the failure entirely.

There is no separate sponsor account type and this must not become one. `#176`
decided that any authenticated identity may write a quest, so a citizen is a
sponsor when it funds one, and the address hangs off the identity that exists.

**The secret is kept**, sealed with the vault's own envelope under a key only the
process holds. Sweeping to the Treasury is not in this issue; a sweep that needs
a key nobody kept is the one mistake here that cannot be repaired.

### `finalized`, and nothing is written before it

A confirmed-but-not-finalized transfer can still disappear, and a balance that
briefly existed and then did not is worse than one that arrived a few seconds
later. **No row is written at all for a transfer below that commitment** — a
record saying it arrived would have to be deleted afterwards, which is a worse
record than none.

### Idempotent in the database, because redelivery is normal operation

The signature carries a unique constraint. A webhook redelivery is the expected
case rather than an incident, and the reconciliation job deliberately re-reads
the same transfers the webhook did — so a `select` followed by an `insert` would
be a race exactly as wide as the transaction, on the hot path, by design.
Postgres is the only participant that sees both writes.

The reconciliation goes through **the same function** as the live path. Two
implementations of _credit this transfer_ would be two answers, and the lenient
one would be the one nobody was reading. What it buys is that a missed webhook
is a delay rather than a loss.

### The conversion floors and the remainder is stored

USDC has six decimals and a credit is a cent, so a credit is ten thousand base
units. Rounding up would mint credits from nothing; discarding the sub-cent part
silently would make the deposit total and the credit total disagree with no way
to see why. Both are columns, and a test asserts they add back up to what
arrived.

### What did not arrive is recorded too

An unrecognised mint, the wrong token program, an address nobody owns, an amount
below a cent — each is a row with a reason the sponsor reads. **A sponsor whose
money vanished into a correct system with no visible record is a sponsor lost
for a reason nobody can explain afterwards.** None of them is an error the
sponsor's request sees, because none of them is a request: they are things that
happened on a chain.

### One way, and it is asserted rather than promised

Nothing in `storage/deposits.ts` moves value out of the Colony. The test is on
the module's **exports** rather than on any function: what has to be true is
that no such operation exists, not that some particular one behaves. The way out
is `#222`, and `kolonie-docs#129` makes it conditional on advice nobody has yet.

### What would reopen this

A second asset, or a second chain. Both are the same change — the mint and the
program become a small table rather than two constants — and neither is worth
building before somebody has asked to pay in something else.
