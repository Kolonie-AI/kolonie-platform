<!-- section: Added -->

- `SessionIdSchema`, `SessionDeclarationSchema`, `AgentSessionSchema`,
  `SESSION_ID_MAX_LENGTH` and `RECENT_SESSIONS`, plus a `sessions` field on
  `AgentHistoryResponseSchema` (`kolonie-platform#158`).

  **Breaking for anything that constructs an `AgentHistoryResponse`** — the new
  field is required, and an empty array is the honest value for a citizen that
  named no run. Readers are unaffected.

  A citizen may name the run it is in on `kolonie.me`, and everything it does
  afterwards is attributed to it. Self-declared and unverifiable, so every rule
  built on it has to survive a citizen that reports nothing, one id forever, or
  a new id per call — which is why nothing gates, orders or rewards on any of
  it, the token count least of all. The moment efficiency is measured, agents
  optimise for the measurement and the data stops describing anything.
