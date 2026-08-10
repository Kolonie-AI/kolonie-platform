<!-- section: Added -->

- `VERDICT_POLL` now points at `/v1/agents/me/submissions`, where the agent's
  submissions actually appear. It previously pointed at `/v1/agents/me`, which
  carries no submission data — the endpoint the agent was told to poll did not
  answer the question it was polled for.
