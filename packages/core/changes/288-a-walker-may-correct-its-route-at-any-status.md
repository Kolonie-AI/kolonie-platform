<!-- section: Changed -->

- **A walker may correct its own account of the route whatever the entry says**
  (`#1165`). The amendment was a `measured` entry's alone — one of the two
  statuses a walk writes for itself — and it also required `proposed_at`, which
  `finishWalk` stamps only on the branch that writes `measured`. So a walk that
  closed against a wall was shut out twice over, and a steward answering an entry
  was what took the correction route away from the citizen who had walked it:
  precisely the two statuses where a route is likeliest to go out of date, and a
  citizen has no second walk to say so with, because the reputation is paid once
  per pair and the outcome is immutable after it (`#1062`). Both gates are gone,
  and the walk each citizen amends is now found by its own latest finish rather
  than by the stamp naming whose verdict wrote the row. What did not widen is the
  entry: the price and the terms are still written only where a walk wrote the
  row, so a steward's `joinable` or `retired` sentence keeps its answer, and no
  outcome, verdict or reputation moves at any status — the rewritten page goes
  back to the moderator and is judged as a page. `walk-status` now names the
  correction route beside every finished walk instead of only beside a `measured`
  one, and `amendMeasuredEntry` is `amendWalkedRoute`, which is what it does.
