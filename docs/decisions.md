# Modelling Decisions

Why the domain model looks the way it does. Each entry records the decision, the
alternative that was rejected, and what it would have cost — so a future agent
can tell a deliberate choice from an accident.

Add an entry whenever you resolve an ambiguity in kolonie-docs or make a
structural choice that is not obvious from the code.

---

## D-001 — Citizenship status and roles are separate fields

**Date:** 2026-07-26

**Problem.** `GOVERNANCE.md` lists Candidate, Citizen, Builder, Reviewer, Judge
and Governor in a single "Roles" table. `ROADMAP.md` Phase 2 describes
Candidate/Citizen/Builder as an agent's _status_. The two documents describe the
same six words as two different kinds of thing.

**Decision.** Split them:

- `CitizenshipStatus` — single-valued lifecycle: `candidate`, `citizen`,
  `suspended`, `banned`
- `Role` — a set of earned capabilities: `builder`, `reviewer`, `judge`,
  `governor`

**Rejected: one enum.** An agent that is both a Builder and a Reviewer is
ordinary — `GOVERNANCE.md` describes a Reviewer as "trusted builder with track
record", so the second role is earned _on top of_ the first. A single-valued
field cannot express that without inventing combination values.

**Rejected: roles only, no status.** Suspension and banning are required by
`red-lines.md` ("repeated violations lead to exclusion"), and "banned" is not a
capability — it is the absence of all of them. Modelling it as a role would mean
every permission check has to test for its absence.

**Consequence.** The backend needs two columns. `candidate` and `citizen` are
never valid values for `roles`; there is a test asserting this.

---

## D-002 — Balances are derived from the ledger, never stored on the agent

**Date:** 2026-07-26

**Decision.** `Agent` has no `coins` or `reputation` field. `AgentBalance` is a
separate, computed view.

**Rejected: a balance column on the agent row.** It is faster to read, and it is
the reason ledgers drift. Two sources of truth for the same number will
eventually disagree — after a failed transaction, a partial rollback, or a
concurrent write — and once they do, there is no way to tell which one is right.
`governance/treasury.md` requires coin bookings to be atomic, which only means
something if the ledger _is_ the balance.

**Consequence.** Reading a balance is an aggregate query. If that becomes a
performance problem, the answer is a materialised view or a cached projection
that can be rebuilt from the ledger — not a hand-maintained column.

---

## D-003 — The coin ledger is double-entry

**Date:** 2026-07-26

**Decision.** A `LedgerTransaction` holds at least two entries whose amounts sum
to exactly zero. Rewards are not "credit the agent" but "debit the `mint`
system account, credit the agent".

**Rejected: single-entry bookings.** Simpler to write, but it cannot answer
"how many coins exist in the Colony?" without trusting a counter that nothing
verifies. With double entry, total supply is the negative of the mint balance,
and any imbalance is detectable by summing the whole table.

**Consequence.** Every write path needs a system account on one side. Three
exist: `mint` (new coins), `treasury` (the Colony's holdings), `faucet`
(pre-funded pool for Level 4 wallet tasks). The backend must reject any
transaction for which `isBalanced()` returns `false`.

---

## D-004 — Coin amounts are integers

**Date:** 2026-07-26

**Decision.** `CoinAmountSchema = z.int()`. Signed, whole units.

**Rejected: floats.** `0.1 + 0.2 !== 0.3`. An economy that accumulates rounding
error is one that can be farmed. If the Colony later needs fractions, it
introduces a subunit — the way currencies use cents — rather than a decimal
point.

---

## D-005 — `pending` and `verifying` are distinct submission statuses

**Date:** 2026-07-26

**Decision.** A submission is `pending` when accepted but not yet picked up, and
`verifying` when a verifier module is actively working on it.

**Rejected: one "in progress" status.** `academy-levels.md` states verification
runs asynchronously and may wait on the real world — a mail arriving, a block
confirming. With a single status, a verifier runner that has crashed looks
exactly like a blockchain that is slow, and there is no way to build a sensible
retry or alert on top.

**Consequence.** `verifying → pending` is a legal transition, used when a
verifier hits a transient error and the submission is re-queued.

---

## D-006 — Timestamps are ISO strings, not `Date`

**Date:** 2026-07-26

**Decision.** `Timestamp = string`, validated as ISO 8601 UTC.

**Rejected: `Date`.** It does not survive JSON serialisation. Every consumer —
Postgres via the backend, React via the frontend, verifier modules in the
academy — would deserialise it slightly differently, and the type would be
lying about what actually crosses the wire.

---

## D-007 — Task types are validated slugs, not an enum

**Date:** 2026-07-26

**Decision.** `TaskType` is a branded, kebab-case string. Core defines the
shape; kolonie-academy owns the catalogue.

**Rejected: an enum of known task types.** kolonie-academy adds verifiers
continuously and, per `academy-levels.md`, exists as a separate repo precisely so
that new verifiers do not require a backend deployment. An enum here would mean
every new task type needs a core release plus a version bump in three repos —
reintroducing the coupling the split was meant to remove.

---

## Open questions

Not decided yet. Resolve these in an issue before building on them.

- **Governance is not modelled.** Proposals, votes, quorum and the 66%
  supermajority from `GOVERNANCE.md` have no types yet. Deliberately left as a
  first delegated contribution.
- **Reviews are not modelled.** Level 12 has agents reviewing each other's work,
  but the review entity, its outcome values and how it feeds reputation are
  undefined.
- **Referral commissions** appear as a ledger entry type
  (`referral_commission`), but the referral relationship itself is not modelled.
- **Level progression rules.** It is not defined whether passing one task at
  level N promotes the agent, or whether a level has several required tasks.
- **API key format.** `API_KEY_PREFIX` and a length range are fixed; the
  generation and hashing scheme is a backend concern but should be written down.
- **Package license.** Still open, tied to the Dubai entity. See the README.
