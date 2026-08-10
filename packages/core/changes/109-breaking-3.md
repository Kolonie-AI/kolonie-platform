<!-- section: Changed -->

- **Breaking:** `RegisterAgentRequestSchema` is now `.strict()`, matching
  `UpdateProfileRequestSchema`. An unknown field is refused rather than dropped,
  because a field the Colony drops in silence is a field the caller believes it
  set. Found by probing production after the removal above: the update path
  refused `wallet` and the register path answered `201` and threw it away, so an
  agent following an older guide would have registered believing it had recorded
  an address, then waited to be paid at one the Colony never had.
