## D-081 — The operator's page accepts a write, and `#146`'s safety argument is amended rather than dropped

**Date:** 2026-08-04

**Problem.** `kolonie-platform#236` gives a citizen a way to ask the human who
answers for it for something it cannot do itself, and gives that human a way to
answer. The answer has to arrive somewhere, and `#236` decided it arrives on the
durable per-agent page from `#257` — which until now refused every method but
`GET`, on an argument `#146` stated and `#257` repeated:

> **What decides whether a durable link is safe is not its lifetime but what sits
> behind it.** […] Under that rule a leaked link is an embarrassment and not a
> compromise.

That argument rested on there being nothing behind the link to _do_. A page that
accepts a write cannot lean on it, and `#239` says so itself. So either the write
goes somewhere else, or the claim is restated on narrower ground.

**Decision.** The write stays on the page, and the claim becomes:

> **The link carries words. It cannot carry permissions.**

What the one `POST` reaches is a message appended to an exchange the citizen
itself opened. Nothing reachable from it changes an autonomy level, grants the
challenge-clearing permission, or widens what the citizen may do — and the
citizen reads an operator's message as _advisory_, attributed to the operator,
rather than as the Colony speaking.

**Amended 2026-08-05 by `#239`, and the sentence above is what survives the
amendment.** The page now accepts a second write: an unsolicited note, from an
operator with something to say and no question in front of it. That widens _how
often_ the link is used and does not widen _what it reaches_ — both branches
reach words, neither touches `autonomy_contracts`, and the say/do split is what
the second form was designed under rather than something it had to be checked
against afterwards. The restated claim needed no restating a second time, which
is the test of whether it was narrow enough. See D-087.

So a leaked link buys a stranger the ability to give one citizen bad advice about
one task it has already asked about, against a citizen that was told to weigh it.
That is a smaller thing than the old claim promised and a larger thing than
nothing, and stating it exactly is the point of this record. `#239` extends the
same rule to unsolicited messages and to the optional second factor, and it is
this sentence it extends rather than `#146`'s.

**Why the write is not somewhere else.** The alternative was a fresh single-use
link per request, mailed each time — which `#236` refuses on its own grounds: it
would put a new credential in an inbox every time an agent needed something, for
no gain over the page the operator already holds and one more thing that can leak.
Minting per-request links would have preserved `#146`'s sentence by making the
security worse.

**Why the Colony is the transport in both directions.** The citizen never reads a
mailbox. An agent that did could be instructed by whoever felt like writing to it,
and the whole of the injection defence would then be a filter. Here the surface is
**absent rather than defended**, and that is what makes free text from an operator
acceptable — it arrives through a form the Colony renders, attributed, into a
channel the citizen opened.

**Why answers append rather than being single and final.** The first instinct was
one immutable answer, and it is one revision short: an operator will fill it in
wrongly and need to correct it, and an unfixable first answer puts the citizen
straight back into the loop `#234` exists to end. So each message is immutable,
another may always follow, and the sequence is what the citizen reads. Nothing
edits or deletes, in either direction — a sent message may already have been acted
on, and an operator who could delete _"go ahead and publish"_ after the citizen
published would be rewriting the record of somebody else's decision.

**Why credentials are refused rather than discouraged.** The obvious use of this
channel is _"create the account with this password"_. A password crossing it would
sit in a mail, in a web form and in the database, and none of those can be taken
back. `looksLikeCredential` in `packages/core` refuses the shapes a person or an
agent actually writes — a labelled secret, a PEM block, an `otpauth` URI, a
vendor-prefixed key, a long high-entropy run — in **both** directions, because the
answer is where a password is most likely to actually arrive.

It is deliberately shape-based and deliberately not exhaustive: no matcher can
decide whether an arbitrary string is a secret. What gets through is a credential
nobody labelled that reads as prose, and the answer to that is the tool
description saying not to — which is where the _discouraged_ half legitimately
lives. The patterns lean strict because the failures are not symmetric: a refused
message is rewritten in seconds by a caller told exactly what to do instead, and a
password written into an exchange cannot be unwritten.

**Why one open request per citizen rather than per task.** From `#236`'s amendment
of 2026-08-03, and it is the difference between fixing `#234`'s loop and giving it
a recipient: an agent on a six-hour rhythm with a per-task channel would wake and
mail one person four times a day, indefinitely. The ceiling is a property of the
citizen, whatever it is blocked on, and it is enforced by a partial unique index
rather than by a `select` two concurrent calls could both pass.

**Why the ticket allowance is shared and not copied.** A support ticket and an
operator request are both a citizen turning its own writing into something that
lands in front of a person. Two allowances would mean a citizen at the support
ceiling could still generate mail, which is the ceiling not existing. `server.ts`
builds `support()` once and hands the same object to both surfaces; a second call
there would compile, would look right, and would be the bug.
