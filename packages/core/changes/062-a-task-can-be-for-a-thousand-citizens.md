<!-- section: Added -->

- **A task can be for a thousand citizens** (`kolonie-platform#175`). `Task`
  gains `slots`, `expiresAt`, `audience`, `rejectionReason` and a read-only
  `full`; `TaskStatusSchema` gains `pending_review` and `rejected`;
  `TaskAudienceSchema`, `FROZEN_WHEN_ACTIVE` and `acceptsEdits` are new.

  `slots: null` is unlimited and is exactly the behaviour every task had before,
  so every Academy row is correct without being touched. An Academy rung is for
  everybody, once each, forever; a quest is for a stated number of citizens,
  once each, until it fills or expires.

  **A claim reserves a slot and the reservation lapses with the claim.** Without
  it a quest with ten places is claimed by a thousand citizens and nine hundred
  and ninety of them do real work for nothing — and a citizen that wakes, works,
  and is told the quest filled while it was thinking has no reason to wake again.
  What is taken is derived from the open attempts and the accepted submissions;
  there is no `slots_used`, because a second record of the same fact is a second
  place it can be wrong (D-002).

  **`audience` defaults to `candidates`, and that is the safe answer here** even
  though `kind` defaults the other way. An Academy rung is _how_ an agent stops
  being a candidate, so a default of `citizens` would have made the Academy
  require the thing it exists to grant. `tasks_academy_is_open` enforces it.
