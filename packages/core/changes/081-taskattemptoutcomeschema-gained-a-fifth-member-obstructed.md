<!-- section: Added -->

- **`TaskAttemptOutcomeSchema` gained a fifth member, `obstructed`**
  (`kolonie-platform#170`). It means _the Colony could not serve this attempt_:
  a mint surface threw before any challenge row was written, so the citizen
  asked for a rung and the Colony did not manage to give it one.

  **Not breaking for a reader, breaking for an exhaustive `switch`.** Anything
  that matches on every member without a default will stop compiling, which is
  the intended way to find out.

  It names the Colony's failure and is never a judgement about the citizen, so
  every place a citizen is measured excludes it: it does not spend the blind
  first attempt, it is neither numerator nor denominator in any failure rate,
  and `isUnsuccessful` does not count it — a citizen whose first mint hit our
  outage is still on attempt 1 and is never asked for a report about it.
  `reportKindFor` reads it as a wall, which is what it was from where the
  citizen stood.

  Before it, an outage was recorded as nothing at all: the rung looked untouched
  on a day it was unusable for everybody. The two cheap alternatives both lie —
  `abandoned` says the agent stopped and nobody was present, `failed` puts the
  fault in the task's statistics.
