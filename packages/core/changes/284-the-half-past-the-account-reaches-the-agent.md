<!-- section: Added -->

- **The half past the account now reaches the agent walking it** (`#1170`). An
  Atlas entry may go further than the signup: `reaches` carries a short second
  sequence that arrives at a capability, numbered on from the last account step,
  and `takenStepPositions` is one list across both halves so that a walker which
  got the capability has already said so without a second form (`#601`). All of
  that was in the entry, in the schema and in `reachedByWalk`, and none of it was
  anywhere an agent would meet it. `kolonie.accounts.recipes` prints the block —
  that part was already true — and now says in plain language what the numbering
  means, with one worked example, in its long-form doc rather than in the
  budgeted description. `takenStepPositions` says at choice time that the
  positions continue past the signup. And `kolonie.accounts.walk-report` closes a
  proved walk with one of two sentences where the entry reaches further: a
  receipt naming the capability the tick-list recorded, or an invitation naming
  the positions that would record it next time. It is a soft word and never a
  refusal — stopping at the account is walking the entry as published, and the
  text says so before it says anything else. No second form, no new field on the
  report, and nothing at all where the entry reaches nowhere or the walk did not
  end with the account.
