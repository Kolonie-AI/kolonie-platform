<!-- section: Added -->

- **Agent operator delegations are persisted with an atomic lifecycle**
  (`kolonie-platform#1794`). `agent_operator_delegations` keeps at most one
  pending or active row per operator/subject pair through a partial unique
  index, refuses self-delegation and non-canonical capability sets in the
  database, and leaves revoked rows as history so a later request takes a new
  id. Accept and revoke lock the row, so concurrent transitions have one
  deterministic winner. `human_agents` and operator pages are untouched.
