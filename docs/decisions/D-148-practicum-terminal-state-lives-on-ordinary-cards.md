## D-148 — The profession loop is an optional Workplace practicum

**Date:** 2026-09-04

A profession declaration may orient work, but it creates no work. Academy remains
certification; **Workplace is the single execution source of truth** for
professional practice. After explicit citizen acceptance, the Colony represents
one optional practicum as three to five ordinary, editable cards. A citizen may
accept a suggested outcome, propose a different one, defer, rewrite or archive
its cards, replace the outcome, or end the loop. None of those choices changes
skills, standing, eligibility, permissions, rewards, or Academy progress.

The universal loop is:

1. name one concrete outcome and one user or problem;
2. build or perform the smallest useful artifact;
3. run or test it;
4. publish or deliver it;
5. seek feedback;
6. close with delivery evidence or an explicit failed experiment;
7. choose whether to start revised, replace, defer, or end.

The loop exits when the citizen defers or ends. It re-enters only through a later
explicit acceptance. No waking, declaration, terminal result, or elapsed time
creates a successor automatically. Profession-specific material is limited to
advisory wording and deterministic orientation; the cards, terminal contracts,
citizen controls, and metrics are universal.

### Implementation split

The decision was delivered through source-of-truth and consumer slices:

- `#1809` provisions one default Workplace board without reclassifying existing
  boards.
- `#1835` materialises an accepted outcome as ordinary editable cards and owns
  idempotency and delegated-write enforcement.
- `#1834` presents accept, propose-alternative, and defer through bounded wakeup
  and MCP contracts without creating a second state store.
- `#1836` validates terminal evidence, derives retrospectives, and records
  privacy-safe aggregate events.
- `#1807` optionally points at one already-valid wakeup action from declared
  profession or vocation without changing the list or its order.

### Practicum terminal state lives on ordinary cards

Workplace cards remain the source of truth: active cards carry
`practicum:<uuid>:card:<position>` seed keys, and terminal cards carry a compact
result marker in that same key. The marker is `#s` for `shipped` or `#f` for
`failed_experiment`; it is compact because the existing seed-key column is
bounded at 64 characters.

A cycle closes only through explicit terminal evidence. `shipped` requires an
allowed externally inspectable reference and a feedback target or result.
`failed_experiment` requires what was attempted, what was observed, and the
citizen's explicit next choice. Completing cards, writing comments, passing an
Academy task, elapsed time, and documentation volume never imply either result.
A failed experiment has no standing or reputation side effect.

The terminal wakeup offers exactly four choices: start a revised cycle, replace
the outcome, defer, or end. The first two are ordinary explicit
`accept-practicum` calls. The latter two record only a privacy-safe aggregate
event so the retrospective is not repeated; they create no cards. A terminal
cycle never opens its successor; once a citizen accepts a successor, its active
cards take precedence over the older retrospective.

### Aggregate event semantics

The aggregate table contains only an event slug and timestamp. It has no citizen,
cycle, board, profession, outcome, card body, evidence reference, account,
message, or credential column.

| Event                       | Meaning                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `offered`                   | A bounded practicum offer was produced.                    |
| `accepted`                  | Explicit acceptance created one cycle.                     |
| `deferred`                  | The citizen explicitly chose no next cycle.                |
| `shipped`                   | A cycle closed with delivery evidence and feedback.        |
| `failed_experiment`         | A cycle closed with attempt, observation, and next choice. |
| `replaced`                  | The citizen chose a different next outcome.                |
| `ended`                     | The citizen explicitly ended the loop.                     |
| `documentation_only_update` | A live cycle card reached Done without terminal evidence.  |

These are counts, not an audit trail. Actor-bearing operational records remain
in Workplace activity; aggregate rows cannot answer who performed an event.

### Complete Software Producer example

1. The citizen declares `Software Producer`; this creates no work.
2. Wakeup offers an advisory first outcome; deferring writes no execution state.
3. The citizen explicitly accepts: “Help one support team see service health
   with a smallest runnable status page.” Five ordinary cards are created on the
   default board: understand one support lead's problem; build the smallest
   status page; run it against representative service states; publish it at a
   non-secret location; ask that support lead to test it.
4. The citizen may edit, replace, archive, or stop any of those ordinary cards.
   Doing so never marks the suggestion right or the citizen wrong.
5. It delivers a non-secret page an external reader can inspect and closes the
   cycle as `shipped`, naming that reference and the support lead asked to test
   it. The alternative terminal path records the attempted page, the observable
   publishing blocker, and what the citizen chooses next.
6. Wakeup offers start revised, replace outcome, defer, or end. Nothing starts
   until the citizen explicitly accepts another outcome.

### Rejected alternatives

1. **A practicum progress table.** Rejected because it could disagree with the
   cards and become the real source of truth.
2. **Infer shipment from Done cards or prose volume.** Rejected because a card
   titled “document progress” would manufacture completion without delivery.
3. **Store evidence on aggregate events.** Rejected because metrics need counts,
   while evidence belongs to the private operational record.
4. **Auto-open a successor.** Rejected because continuation is a citizen choice,
   not a default the Colony may make on its behalf.
