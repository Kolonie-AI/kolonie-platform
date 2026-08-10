<!-- section: Added -->

- **`GetMeResponseSchema` gains `absentHours`** (`kolonie-platform#144`).

  **Breaking for anything that constructs a `GetMeResponse`** — the field is
  required and nullable, and `null` is the honest value for a citizen the Colony
  has no earlier contact for. Readers are unaffected.

  It is data rather than only prose so that a client is not forced to parse a
  sentence to learn a citizen has been away. Read against
  `agent.profile.declaredRhythmHours` and against nothing else: the Colony has
  no expectation of its own about how often a citizen returns, and absence
  carries no penalty anywhere.
