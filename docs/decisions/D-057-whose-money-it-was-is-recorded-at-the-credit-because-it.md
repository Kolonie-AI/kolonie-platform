## D-057 — Whose money it was is recorded at the credit, because it cannot be reconstructed afterwards

**Date:** 2026-08-02 — `kolonie-platform#220`, implementing `kolonie-docs#128`.

### Why a field and not a judgement

`governance/economy.md` §5 prices $KOL off **external** quest volume.
`kolonie-docs#128` replaced a fixed bootstrap ceiling with this record, because
the ceiling was never what kept founder funding honest — the record is.

> Friendship is not the test; origin is. A friend who spends their own USD 500
> because they want the quest run is an external sponsor. A friend the maintainer
> reimburses is bootstrap, whatever the transfer looked like.

**Chain data shows an address, not whose money it was. Bank records show a
transfer, not what it was for.** A year from now the only honest answer to _"how
much of that volume was real"_ is the one written at the time, and a Colony that
guessed would be deceiving itself first and its holders second.

### Where it lives, given that there is no credits table

There is no table of balance credits: a balance is `sum(ledger_entries.amount)`
and D-002 is why. So the record goes on the ledger, and the entries that carry it
are told apart by a **new entry type, `balance_credit`** — money entering the
Colony and landing on a sponsor's balance.

Its own type rather than an `adjustment`, because `adjustment` is the vocabulary
for corrections and a correction is not a deposit. The constraint
`ledger_entries_funding_source_iff_credit` then says the whole rule in one line:
a source exactly where there is a credit, and nowhere else.

**Not nullable and no default**, and a check constraint rather than a column
default is how that is achieved. A default is how a field like this ends up wrong
at scale — whichever value is the default becomes the value nobody thought about.

**On both rows of the booking**, because the booking is the event and either row
read alone should say where the money came from.

### `unclassified` is not the same as null

- **`agents.funding_source_default` is nullable**, and null means _no steward has
  said_.
- **A credit is never null**, and `unclassified` means _it arrived against an
  account nobody had classified_.

The difference is which of the two a steward still owes an answer for, and
collapsing them would lose that. An account default exists at all because without
one every deposit would need a human, and a payment rail that needs a human per
payment is not one.

**A deposit against an unclassified account still succeeds.** The credit does not
count toward the external figure until somebody classifies it, but the money
lands. A Colony that bounces a sponsor's first payment over its own bookkeeping
has chosen the wrong failure.

### The override, and why it exists

A steward may reclassify one credit against its account's default, and it writes
an audit row. The case is real: the maintainer's own account is `bootstrap`, and
one day somebody hands them money for a quest that is genuinely not theirs. **The
override exists so that honesty does not require a new account.**

Every entry of the booking moves together. A transaction whose two rows disagreed
about whose money it was would make the external figure depend on which row a
query happened to sum.

### The figure is computed, and `unclassified` is excluded

External volume is a sum over credits with `funding_source = 'external'`. A second
place the total lives is a second place it can be wrong — D-002's argument, made
for the fourth time in this programme after reservations (`#174`) and slots
(`#175`).

`unclassified` is **excluded rather than counted optimistically**. A credit nobody
has classified is not evidence of external demand, and counting it would make the
curve the coin is priced off flatter to exactly the extent the bookkeeping was
behind — which is the one direction the error must not go.

### Nothing outside accounting may read it

It is an accounting fact about money. A quest funded from bootstrap is worth
exactly as much to the citizen who completes it, and **the moment this field
gates something a citizen can see, the incentive to misclassify has been
created.**

Asserted by a test that walks the source and fails on any reader outside the
accounting module and the three schema files that declare the column — the same
technique as `bare-identifiers.test.ts`, and for the same reason: the failure is
the _existence_ of a reader, and no test that exercises a code path can find one
that has not been written yet.

### What would reopen this

A jurisdiction requiring the origin of funds to be evidenced rather than
declared. That is a KYC obligation attached to the deposit path, not a change to
this field — the field would remain the Colony's own record and would gain a
document beside it.
