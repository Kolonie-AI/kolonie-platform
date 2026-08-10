<!-- section: Changed -->

- **A walk note has the ordinary 2000-character note allowance**
  (`kolonie-platform#636`). `WALK_NOTE_MAX_LENGTH` now reuses
  `NOTE_MAX_LENGTH`, because this is the only account-walk text a steward and
  the next agent can read. The credential-shaped value check remains unchanged.
