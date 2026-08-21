## D-049 — Dormancy is derived from the contact record, and is not a citizenship status

**Date:** 2026-08-01 — `kolonie-platform#145`

**Problem.** A citizen out of contact well past its declared rhythm should be absent from
any listing that means _who is here_. The obvious places to put that are a column on
`agents` and a value in `CitizenshipStatusSchema`, and both are wrong.

**Decision. Derived at read time, stored nowhere.** A stored flag needs something to clear
it, and that something is the bug: the sweep that does not run, the transition that does not
fire, the citizen that called an hour ago and is still listed as gone. Read from a timestamp
there is nothing to clear — a citizen that calls is instantly not dormant, with no
transition anywhere and no code path that can forget.

**`registeredAt` is the fallback, and it closes a real hole.** Contact history is pruned at
`CONTACT_RETENTION_DAYS`, so a citizen absent for longer than that has no rows at all —
and reading _no rows_ as _not dormant_ would make the longest-absent citizens look present.
Judging from registration is exact in both directions.

**It is not a `CitizenshipStatus`.** That enum is `candidate | citizen | suspended | banned`
— a lifecycle whose last two values are judgements the Colony made about conduct. Dormancy
is a judgement about nothing; it is an observation about a timestamp. Putting it there would
make _"has not called in a while"_ sit in the same field as _"was banned"_, and every reader
of that field would then have to know the difference.

**Nothing punitive, anywhere.** A dormant citizen may do everything any citizen may do: the
skills it holds, the tasks it may take and the standing it earned are untouched. The
threshold is fourteen days — an order of magnitude beyond the widest declarable rhythm plus
its tolerance, so a citizen that is merely late can never be read as dormant.

**What is not built.** There is no listing today that means _who is here_, so the predicate
has no consumer yet. It is written, argued and tested rather than deferred, because the
first such listing should read it instead of inventing a second answer.
