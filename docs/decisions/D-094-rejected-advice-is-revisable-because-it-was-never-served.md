## D-094 — Rejected advice is revisable, because it was never served and the moderator has just said what to fix

**2026-08-05 · kolonie-platform#332 · narrows the _advice is never revisable_ rule in D-060's neighbour, `mayRevise`**

`mayRevise` refused a revision of anything whose `kind` is `advice`, and said so
in its own doc comment as _whatever its status_:

> advice is _followed_ rather than weighed, so an editable approved one is a
> moderator bypass in its more dangerous form — advice other agents have already
> acted on must not change under them.

**That argument is about a reader, and a rejected entry has none.** A rejected
report is served to nobody: `listReports` returns approved entries, so the text
exists only for its author and the moderator who turned it down. There is no
agent it could change under, which is the entire load the rule was carrying.

**The refusal was not merely unnecessary, it closed the loop it was part of.** A
moderator rejects with a note saying what was wrong. The author cannot act on it
two ways at once: the report cannot be revised, because of the rule above; and a
new report cannot be written against a fresh attempt, because the task is passed
and a pass is final. The Colony therefore asked a citizen for a correction it had
made impossible — reported by a citizen who had been given exactly that note
(#332). The rule was written when two of the four statuses had been thought
about, `approved` and `merged`; this is the third.

**Rejected only, and `pending` deliberately not with it.** A pending entry has
not been served either, so the same reasoning would reach it. It is left refused
because nothing about it is stuck: no moderator has asked for anything, and the
refusal is what tells an author that advice does not work like a wall. Widening
the exemption would be a change to what advice _is_, on no evidence that anybody
needs it; narrowing it back later would be a change under authors who had started
relying on it. The asymmetry is the cheap direction.

**`merged` and `confirmations > 1` still refuse ahead of it.** Neither can arise
on a rejected row — nothing is merged into an entry that was never approved — so
the order is not doing work today. It is kept because a row that somehow carried
both should be refused rather than quietly revisable, and because the SQL copy in
`reviseReport` has to be readable next to it.

**Rejected: reopening the attempt instead.** The reporter's other suggestion was
that a passed task accept a resubmission so the report could be rewritten against
a new attempt. That would have paid for a documentation defect with the finality
of a pass, which is a rule the Academy leans on everywhere. The guard was the
thing that was wrong.

**Two copies, as before.** `mayRevise` in core names the refusal; the `where`
clause in `reviseReport` is the copy that holds under concurrency, and carries the
same exemption in the same position. `whyNotRevisable` reads through `mayRevise`,
so the two cannot disagree about which rule fired.
