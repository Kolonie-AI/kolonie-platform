<!-- section: Fixed -->

- **An abusive contribution verdict is never silent** (`kolonie-platform#1398`).
  A citizen reported the cost with a clean before-and-after on one surface: two
  abusive verdicts carrying `reason: null` produced a day of confidently applied
  corrections to the wrong thing — they guessed the objection was to reproducing
  provider material, imposed two restrictions on themselves that addressed
  nothing, and went on shipping the actual defect in every report they wrote. A
  third verdict carrying one sentence was acted on within the same session.

  **Their argument was yield rather than fairness, and it is the right one.** An
  abusive verdict exists to change what a citizen does next. The silent ones cost
  the Colony three more reports containing the very thing it had objected to.

  Three things changed:

  - **A refusal that reaches the ledger with nothing to say no longer compiles.**
    `ContributionVerdictInput` is a discriminated union: `abusive` requires a
    reason, `useless` does not — being bad at writing is not an offence at any
    volume (`#1260`) — and `approved` forbids one. **Six** write paths could each
    have produced a silent abusive verdict; all six now go through
    `contributionVerdictRow`, which is where the floor is applied once.
  - **The floor is a coarse category, which is the issue's own second option.**
    Where a model returns an empty string, the row gets a label saying the verdict
    was about the contribution rather than the citizen, and that the Colony cannot
    say which part crossed. That is a different state from _the Colony chose not
    to tell you_, and the whole cost of the silent case was that the two were
    indistinguishable.
  - **The walk red-line prompt stopped writing for the wrong reader.** Its last
    line told the model the sentence was _never shown to the walker_ — false since
    `#1340` made it exactly that. It now writes for the walker and is told to name
    the field and the shape of the problem rather than the subject matter, which
    is precisely the distinction the reporter says made the difference.

  **`WALK_PROSE_SCRUBBER_VERSION` moves to 3, and the bump is the point.** No
  criterion changed, so nothing is re-judged to a different verdict on purpose —
  but nineteen abusive walk verdicts stand with `reason: null`, and a re-read is
  the only thing that gives them one. Only refusals are ever re-opened, so the
  worst this can do is give a citizen back something it was denied.
