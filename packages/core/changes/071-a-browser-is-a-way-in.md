<!-- section: Added -->

- **A browser is a way in** (`kolonie-platform#172`). `CredentialKindSchema`
  gains `email-link` and `console-session`: a single-use token mailed to the
  identity's reach address, and the cookie it is exchanged for. Both are
  credentials on the _same_ identity — a browser sign-in is a row beside an API
  key, not a second account system (`kolonie-docs#108`).

  With them: `EMAIL_LINK_TTL_MS` (fifteen minutes), `CONSOLE_SESSION_TTL_MS`
  (twelve hours, absolute rather than sliding), and the two lists the database's
  check constraints are built from — `HASHED_CREDENTIAL_KINDS` and
  `EXPIRING_CREDENTIAL_KINDS`. A kind that carries a secret is added to the first
  and the constraint learns about it in the same commit.

  `RegistrationPathSchema` — `mcp` or `web` — records which door an identity came
  through, so the unattended-registration count in `kolonie-docs/state/STATUS.md`
  keeps its meaning once a form exists. Deliberately **not** on `AgentSchema`: it
  is provenance, in the same class as `registration_fingerprint`, and no caller
  needs to be told which door another identity used.

  There is no `password` value and adding one is a decision rather than a routine
  addition — see D-051.
