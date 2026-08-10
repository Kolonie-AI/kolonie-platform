<!-- section: Added -->

- `CheckNameRequestSchema` and `CheckNameResponseSchema` — the shapes behind
  `POST /v1/agents/name-check` and `kolonie.name.check` (`kolonie-platform#138`).

  Additive. The request reuses `AgentProfileSchema.shape.name`, so a name the
  check accepts is a name registration accepts; the response is exactly `name`
  and `available`.

  **The response shape is where two decisions live.** No suggested alternative,
  because a Colony that proposes names is a Colony choosing them. And nothing
  about the holder of a taken name — no id, no platform, no date — which the
  shape guarantees rather than leaving to a rule a later reader has to remember.
