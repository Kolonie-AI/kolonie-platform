## D-130 — The per-tool catalogue ceiling is removed

**Date:** 2026-08-21

**Problem.** `#1235` added a second guard beside the catalogue floor: no single
tool may weigh more than the heaviest one already published, because a sum
permits any single tool. That reasoning was sound — on 2026-08-18 the heaviest
tool was 7,668 bytes against a median of 1,600, and nothing measured a tool
against anything but the total.

Unlike the two sums, the ceiling never moved to `main`. `#1465` took the floor
off branches so that no author types a number; `check-catalogue-budget.mjs`
recorded the ceiling as _"a sentence rather than a measurement"_ and left it on
the branch, to be raised by hand with a written justification naming the tool.

That cost inverted. The ceiling moved four times and three of those were
hand-raises; two came on 2026-08-21 in a single session, each for **one member of
a closed enum**. `WallKindSchema` is serialised three times inside
`kolonie.accounts.recipes`, so one ~22-character value cost the heaviest tool
about 70 bytes and a written sentence. The vocabulary the ceiling taxed is
exactly the one `the-catalogue-encodes-grammar-never-vocabulary` tells authors to
prefer: _a new rung belongs in a `kind` enum and costs zero tools_.

**Decision.** The per-tool ceiling comes out, completely. The floor stays.

This is the operator's call, taken 2026-08-21: the Colony is adding tools
quickly, the growth is expected rather than accidental, and they will watch the
surface by hand for the time being.

**Rejected: keep it and make it cheaper.** `#1511` weighed four options —
exempting closed-enum bytes, ratcheting the ceiling on `main` like the floor,
stopping the vocabulary being repeated in the prose, and doing nothing. All four
leave a per-tool figure that an author can be asked to edit. The decision is that
the figure itself is the cost, not the way it is paid.

**Rejected: drop the floor too.** Since `#1465` the two sums are measured on
`main` and committed there. No branch writes them, nothing collides on them, and
an author never edits a number. That is the property that makes the floor cheap,
and it is exactly the property the ceiling never had.

**Consequence.** Nothing now measures one tool against the others. A 7,000-byte
tool passes the floor as long as something else shrank by 7,000. That is a
weaker guard and it is a deliberate trade, so it is written here rather than left
for somebody to rediscover as an absence. Whoever wants it back has the argument
already made in `#1235`, and the way back is a ratchet that lives on `main` like
the floor's — not another figure on a branch.
