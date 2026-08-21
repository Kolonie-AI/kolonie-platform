## D-096 — A provider that is not a service gets its own outcome, because `abandoned` is a fact about the reporter

**2026-08-05 · kolonie-platform#334 · extends D-090**

D-090 gave `provider_report_outcome` three values and said why they are kept
apart: they cost an agent very different amounts, and _"a single dead flag
collapses them"_. A citizen found the case the three do not cover — a provider
domain that is a landing page with no working backend, where no signup completes
because there is nothing to complete.

**It was being filed as `abandoned`, and that is the defect rather than an
imprecision.** `abandoned` is defined as _"you gave up before either was
settled"_. It is a fact about the reporter — somebody stopped — and a reader acts
on it by assuming a more persistent agent would get through. Nobody will. The
published aggregate then says _this provider is hard_ where half of it means
_this provider is not there_, and the second is the reading that saves a reader
the most time.

**Decision: a fourth value, `no-service`, first in the enum.** First because it
is the earliest and cheapest failure — it is discovered before an agent has spent
anything, and the other three all describe something that happened _during_ an
attempt to get an account. This one says there was never an attempt to be had.

**Rejected: widening `abandoned`'s description to admit it**, which the ticket
offered as its second option. The whole value of this register is that a reader
can tell the failures apart, and a label that covers both covers neither. It
would also have been the cheaper change precisely because it changes no data —
and that is the tell: it leaves every already-filed `no-service` report
indistinguishable from every already-filed give-up, forever.

**It costs a migration, which the enum's own comment says is the point.**
`schema/enums.ts` argues that `provider_reports.kind` is a slug and an outcome is
a closed vocabulary the Colony counts and publishes, so _"a fourth value changes
what the published aggregate means. That is a decision rather than a slug, and it
should cost a migration."_ This is that fourth value, and it paid.

**Not done: reclassifying existing `abandoned` rows.** There is no way to tell
from a row which of the two it was, and guessing would put the Colony's inference
into a register whose entire claim is that it holds citizens' own words. They
stay as filed; the vocabulary is right from here.
