## D-140 — A truncated reply is a failed call rather than a salvageable one

**Date:** 2026-08-25

`#1694` removed every output ceiling this repository named and replaced them with
one rule: a reply whose `finish_reason` is `length` is a failed call, raised as
`TruncatedCompletion` with the stable code `completion_truncated`.

That is straightforward for four of the five call sites. The fifth had built
something on the opposite premise, and this record exists because reversing it
loses a real property that somebody will want back.

### What was there

`apps/moderation-runner`'s briefing synthesis salvaged a cut-off reply. `#416`
had found that `JSON.parse` throws on the whole string when a reply ends
mid-object, so every claim the model had finished writing was discarded with the
fragment — and at `temperature: 0` the same corpus produces the same truncated
reply on every poll, so the task's briefing was never written again. The failure
latched. `salvageClaims` scanned for balanced objects, parsed each on its own,
dropped anything that would not parse, and published what was left.

Beside it, `CEILING_ESCALATION` retried once at four times the ceiling when the
reply had been interrupted before its first character, on the argument that a
retry which changes nothing is guaranteed to reproduce the same empty answer.

Both were correct about the problem they were built for. The four raised
constants are the evidence: 2000 was too low for a briefing (`#416`), 400 was too
low for a verdict (`#437`), and 4000 was too low for a walk-prose pass ten days
later (`#1192`). Each was argued carefully and each was too small again, because
reasoning tokens are charged against the ceiling and never appear in the reply.

### Why it goes

A salvaged briefing is a successful answer assembled from a call that failed,
published under the Colony's own name, with however much the model got to. That
is the thing `#1694`'s rule forbids, and the forbidding is not incidental to it:
the whole reason the rule is stated on `finish_reason` rather than on a number is
that a truncated reply is _well-formed_. It parses, it has the shape asked for,
and it is a judgement nobody finished writing. Salvage is that failure mode with
a scanner in front of it.

The escalation goes for a different reason: there is nothing left to escalate.
With no ceiling in the request body, a `length` reply was cut off by a limit this
repository did not set and cannot see — a gateway's own, or a preset's. Four
times an unknown number is not a larger number.

### What is lost, and why the trade is worth taking

**The latch argument was the strong one and it is now weaker on its own terms.**
It rested on `temperature: 0` making the retry deterministic: the same corpus,
the same ceiling, the same cut, for ever. The ceiling is the part that is gone.
A retry now runs against whatever limit the gateway applies, which may move
without a deploy of ours — so the failure is no longer _guaranteed_ to reproduce,
which is exactly the premise salvage was built on.

That is an argument that it will latch less often, not that it cannot. If a
briefing does get stuck in a loop of truncated replies, the honest fix is on the
input side, which `#1694` also asks for: bound the corpus that goes into the
prompt. `board-triage` is the worked example — 38 candidates made a 154 KB brief
the gateway answered with a proxy timeout, and six candidates against the same
whole-board index is 54 KB. Chunking the part that grows fixes the cause;
salvaging the output publishes the symptom.

**What to do if this comes back.** Do not restore `salvageClaims`. Either bound
the corpus, or set `LLM_GATEWAY_MAX_TOKENS_MODERATION` while somebody works out
which — the operator ceiling exists for exactly this, and setting it makes the
cut visible in configuration rather than invisible in a scanner.
