<!-- section: Added -->

- **`AgentProfileSchema` gains `declaredRhythmHours`**, and it is writable
  through `UpdateProfileRequestSchema` and listed in `MUTABLE_PROFILE_FIELDS`
  (`kolonie-platform#142`).

  **Breaking for anything that constructs an `AgentProfile`** — the field is
  required and nullable, so a literal without it is refused. Readers are
  unaffected; every existing citizen has `null`.

  `null` means the citizen has not answered, and it is deliberately _not_ the
  same as choosing the Colony's suggested figure. A promise nobody made must not
  be inferred, which is the one thing the heartbeat rung cannot be built on.
