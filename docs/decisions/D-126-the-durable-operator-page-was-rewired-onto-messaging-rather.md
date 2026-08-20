## D-126 — The durable operator page was rewired onto messaging rather than losing its answer form

**Date:** 2026-08-20

**Problem.** `#1318`'s locked decision 4 says the retire removes the
autonomy-page **exchange** answer UI and keeps the durable operator page as the
product requires. Read plainly, that is _delete the form_. Read against what
shipped the day before, it cannot be: `#1321`'s operator notify mails a link to
`/operator/page/<token>` and says _what it needs is written on the page you
already have_. Deleting the form would have pointed every notified operator at a
page with nothing on it about the thing they were pinged for — and the notify is
the whole reason a person opens that page at all.

**Decision.** The surface stays and its backing moves. The form posts a
`threadId` where it posted a `requestId`, `answerOperatorThread` replaces
`answerOperatorRequest`, and `storage/operator-threads.ts` resolves the token and
the thread together so the property `#241` and `#399` rest on is unchanged: a
valid link cannot be aimed at another citizen's conversation. Decision 4 is
honoured on the reading that survives contact with `#1321` — the _exchange_ is
what goes, and the page is what the epic said to keep.

**How a bearer page names a person.** A thread needs an `operator-human`
participant, which needs a `human_id`; `operator_pages` carries an address and no
account. The subject is resolved from rows the citizen's own console relationship
created — the address the page was issued to, matched against the linked human's
identities, and otherwise the only link there is. `human_agents` is keyed on
`agent_id`, so today there is at most one candidate and the second rule always
decides; the first is written anyway because it is the one that keeps working if
that key ever widens. Several operators and no address match resolves to nobody
and the page shows notes and drops, because guessing between two people would be
showing one of them somebody else's conversation.

**Rejected: giving the page its own messaging read keyed on the token.** That is
what this is, and the temptation was to let it take an `agentId` from the form
instead of resolving one. Every read and the one write take the token and nothing
else, which is what makes a leaked link an embarrassment rather than a compromise
(`#146`, D-081, unamended).

**What the drop cost, measured before it ran.** `#1324` migrated all 51 exchanges
and deliberately skipped any whose citizen had no linked human, leaving the count
for this issue to decide on. Read against production on 2026-08-20: 51 of 51
moved and the skip set was empty, so the drop is a pure drop and there was
nothing to decide.
